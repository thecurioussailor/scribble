# Scribble Server

Real-time backend for a multiplayer drawing-and-guessing game (like Skribbl.io) with text chat
and optional LiveKit voice chat.

**Stack:** Node.js 22 · TypeScript · Express 5 · Socket.IO 4 · Zod 4 · LiveKit Server SDK · Vitest.
All state is in memory, so there's no database.

- [1. Local setup](#1-local-setup)
- [2. Environment variables](#2-environment-variables)
- [3. Architecture](#3-architecture)
- [4. Room and game lifecycle](#4-room-and-game-lifecycle)
- [5. Socket.IO events](#5-socketio-events)
- [6. Drawing synchronization](#6-drawing-synchronization)
- [7. Reconnection](#7-reconnection)
- [8. LiveKit voice](#8-livekit-voice)
- [9. Tests](#9-tests)
- [10. Deploying to Render](#10-deploying-to-render)
- [11. Known MVP limitations](#11-known-mvp-limitations)

---

## 1. Local setup

```bash
cd server
npm install
cp .env.example .env          # optional: defaults work for local dev
npm run dev                   # http://localhost:4000, restarts on file changes
```

Check it's running: `curl localhost:4000/health` should return `{"status":"ok",...}`.

| Script | What it does |
|---|---|
| `npm run dev` | Run from TypeScript source with auto-reload (tsx) |
| `npm run typecheck` | Type-check everything, including tests |
| `npm test` | Run the full test suite once |
| `npm run test:watch` | Re-run tests on change |
| `npm run build` | Compile `src/` → `dist/` |
| `npm start` | Run the compiled build (production) |
| `npm run smoke [url]` | Play a scripted 2-player turn against a running server (default `http://127.0.0.1:4000`); also handy against your Render URL |

**Connecting the Next.js frontend** (minimal sketch):

```ts
import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "./socket.types"; // copied from server

export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(
  process.env.NEXT_PUBLIC_SERVER_URL!, // e.g. http://localhost:4000
  { transports: ["websocket"], autoConnect: false },
);

// Rejoin automatically after every reconnect (see §7).
socket.on("connect", async () => {
  const saved = sessionStorage.getItem("scribble-session");
  if (!saved) return;
  const { roomCode, sessionToken } = JSON.parse(saved);
  const res = await socket.emitWithAck("room:join", { roomCode, username: "_", sessionToken });
  if (!res.ok) sessionStorage.removeItem("scribble-session"); // room is gone
});

export async function joinRoom(roomCode: string, username: string) {
  const res = await socket.emitWithAck("room:join", { roomCode, username });
  if (res.ok) {
    sessionStorage.setItem("scribble-session",
      JSON.stringify({ roomCode: res.data.state.code, sessionToken: res.data.sessionToken }));
  }
  return res;
}
```

Use `sessionStorage` (one session per tab), not `localStorage`. With `localStorage`, every
tab would share one session and keep kicking the others.

## 2. Environment variables

All are optional. Invalid values make the server **refuse to start**, with a list of the problems.

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | `development` / `production` / `test` |
| `PORT` | `4000` | Render sets this automatically |
| `HOST` | `0.0.0.0` | Bind address (must be `0.0.0.0` on Render) |
| `CORS_ORIGINS` | `http://localhost:3000` | Comma-separated frontend origins, no trailing slash |
| `MAX_PLAYERS_PER_ROOM` | `8` | 2–20 |
| `DEFAULT_ROUNDS` | `3` | 1–10, used when the host doesn't choose |
| `TURN_DURATION_SECONDS` | `80` | 10–300 |
| `RECONNECT_GRACE_SECONDS` | `30` | How long a disconnected player keeps their seat |
| `EMPTY_ROOM_TTL_SECONDS` | `60` | Delete rooms with nobody connected after this long |
| `LIVEKIT_URL` | (none) | e.g. `wss://your-project.livekit.cloud` |
| `LIVEKIT_API_KEY` | (none) | From LiveKit Cloud → Settings → Keys |
| `LIVEKIT_API_SECRET` | (none) | **Secret.** Never put it in the frontend |
| `LIVEKIT_TOKEN_TTL_SECONDS` | `600` | Voice token lifetime |

Voice is enabled only when all three `LIVEKIT_*` credentials are set. Everything else works without them.

## 3. Architecture

```
src/
├── index.ts               entry: load config, listen, graceful shutdown
├── server.ts              composition root: builds & wires every dependency
├── app.ts                 Express: CORS, /health, /api/voice, error handler
├── config/
│   ├── env.ts             env vars → typed AppConfig (Zod-validated)
│   └── limits.ts          protocol limits (message length, points per stroke…)
├── socket/                TRANSPORT LAYER: Socket.IO-specific
│   ├── index.ts           creates io, registers handlers per connection
│   ├── *.handler.ts       room / drawing / chat / game event handlers
│   ├── handler-utils.ts   respond() acks, parsePayload(), requirePlayer(), rate limit
│   ├── broadcaster.ts     the ONLY way services send events to clients
│   └── context.ts         dependencies passed to handlers
├── services/              DOMAIN LAYER: game rules, no Socket.IO imports
│   ├── room.service.ts    join/leave/reconnect/host/cleanup
│   ├── game.service.ts    state machine, turns, timers
│   ├── drawing.service.ts strokes, authorization, history
│   ├── chat.service.ts    chat + word-leak filter
│   ├── guess.service.ts   guess checking + scoring
│   ├── voice.service.ts   LiveKit tokens
│   ├── views.ts           internal model → public view (the anti-leak boundary)
│   └── errors.ts          GameError (expected, user-safe failures)
├── store/                 DATA LAYER
│   ├── room.store.ts      Map<code, Room> + session index
│   └── room.factory.ts    constructors for Room/Player/GameState
├── routes/voice.routes.ts HTTP voice endpoints
├── types/                 internal models + the socket event contract
├── validation/schemas.ts  Zod schemas for ALL untrusted input
└── utils/                 pure helpers: scoring, text, words, ids, rate limiter, logger
```

**Request flow.** Every socket event goes through the same pipeline:

```
event ─► handler: requirePlayer() → rate limit → Zod parse ─► service: rules + state change ─► broadcaster
                     └──────────── any GameError → { ok:false, error } ack ────────────┘
```

**Key design decisions**

1. **Server-authoritative.** Clients send *intentions* (draw this, guess that, start). Scores,
   timers, words and turns exist only on the server. There's no event a client can use to set them.
2. **Stable session identity.** Each player has a public `id` and a secret `sessionToken`.
   `socket.id` is just the *current connection*. This makes reconnects, duplicate-tab handling
   and HTTP auth (voice) straightforward.
3. **Internal models vs. views.** `Room`/`Player` hold secrets (tokens, the word). Clients only
   receive objects built field-by-field in `views.ts`, so new internal fields can't leak by accident.
4. **Services never import Socket.IO.** They talk through the `Broadcaster` interface, so the
   game engine is tested with a fake broadcaster and fake timers.
5. **Dependency inversion for cycles.** The room service fires `GameHooks` (player joined/left);
   the game engine implements them. `server.ts` wires it all, with no circular imports.
6. **Pure scoring.** `utils/scoring.ts` has no clock, I/O or state.

**Concurrency model.** Node runs JS on one thread, and every state transition here is
synchronous (no `await` between check and update). So "has this player already guessed?"
followed by "record the guess" is atomic, with no locks needed. Timer safety rules:

- One phase timer per room. Each transition clears the old one before setting a new one.
- Timer callbacks capture the `turnSeq` and phase they were created for, and exit early if the game has moved on.
- Every transition checks the current phase first, so duplicate calls do nothing.
- All timers live in `room.timers`, and deleting a room clears them.

## 4. Room and game lifecycle

**Room lifecycle**

```
room:create → room exists, creator is host
   ├─ players join (max N, unique usernames) / leave
   ├─ host leaves or times out → longest-standing connected player becomes host
   ├─ everyone disconnected for EMPTY_ROOM_TTL → room deleted
   └─ last player leaves → room deleted immediately
```

**Game state machine**

```
                 game:start (host, ≥2 connected)
waiting/finished ────────────────────────────► starting ──3s──► playing ◄─────────┐
       ▲                                                          │               │
       │                        time up / all guessed / drawer left               │ 5s
       │                                                          ▼               │
       └──── no drawers left in final round ◄──────────────── between_turns ──────┘
             (or <2 players remain → finished immediately)
```

- **Rounds:** each round, every player draws once, in join order. Players offline when their
  turn comes are skipped. Players who join mid-round are added to the end of the queue.
- **Turn:** a random unused word from the server word bank. The drawer receives it, and
  guessers get only `hint` (`"___ _____"`) and `wordLength`.
- **Turn ends** when time runs out, all *connected* guessers have guessed, or the drawer leaves.
- **Scoring:**
  - Guesser: `100 + 400 × (time left / turn length) + first-guess bonus (50, 40, 30…)`, range 100–550.
  - Drawer: `400 × (players who guessed / players who could guess)`.
- **Finished:** `game:finished` with a ranked leaderboard. The host can start again (scores reset).

## 5. Socket.IO events

Full contract with example payloads: **[docs/EVENTS.md](docs/EVENTS.md)**.
Typed source of truth: `src/types/socket.types.ts`.

| Client → Server | Ack | Server → Client |
|---|---|---|
| `room:create`, `room:join`, `room:leave` | yes | `room:state`, `player:joined/left/disconnected/reconnected` |
| `game:start` | yes | `game:started`, `game:turn-started`, `game:timer`, `game:turn-ended`, `game:finished` |
| `draw:start/move/end/undo/clear` | optional | same names + `draw:sync` |
| `chat:send` | yes | `chat:message`, `chat:history` |
| `guess:submit` | yes | `guess:result` |
| | | `session:replaced`, `server:error` |

Acks are always `{ ok: true, data } | { ok: false, error: { code, message } }`.

## 6. Drawing synchronization

- Drawings are sent as **vector events**, never images: `draw:start` (color, size, first point),
  then `draw:move` batches of up to 64 points, then `draw:end`.
- **Coordinates are normalized (0–1)**, so the same stroke renders correctly on every screen size.
- The frontend should **batch points and flush every ~30 ms** instead of emitting per `mousemove`.
- Only the **current drawer** may draw, and only during `playing`. Events go to everyone
  **except** the drawer, who renders locally (optimistic rendering).
- The server keeps the current turn's strokes. A player who joins or reconnects gets
  **`draw:sync`** with the full stroke list and redraws from it.
- **History is bounded** (5k points per stroke, 50k per canvas). When full, new points are
  *rejected* rather than old strokes dropped, so every player always sees the same canvas.
  The drawer can undo or clear to continue.
- **Rate limit:** 120-event burst, 60 events/s sustained. Rejected drawing events are dropped
  silently unless the client passed an ack, to avoid amplifying spam.
- The canvas is cleared for everyone at the start of every turn.

## 7. Reconnection

1. `room:create`/`room:join` returns a secret **`sessionToken`**. The client stores it.
2. When the socket drops, the server marks the player **disconnected** but keeps their seat, score
   and turn for `RECONNECT_GRACE_SECONDS` (default 30s). Others receive `player:disconnected`.
3. When Socket.IO reconnects (a new socket), the client sends
   `room:join { roomCode, username, sessionToken }`. If the token matches a player in that room,
   the seat is restored (`reconnected: true`), and the client receives `room:state`, `draw:sync`
   and `chat:history`. Others receive `player:reconnected`.
4. If the grace period expires, the player is removed (`player:left`, reason `timeout`) and the
   token stops working.

**Edge cases**

- **Same session in two tabs:** the newest connection wins. The old socket gets
  `session:replaced` and is disconnected, and other players see no disconnect.
- **Stale sockets:** every action checks `player.socketId === socket.id`, so a replaced socket
  can't act or mark the player offline.
- **Drawer disconnects mid-turn:** the turn keeps running. If they return in time, they get the
  word and canvas back. If not, the turn ends with `drawer_left`.
- **Guesser disconnects:** they don't block the "everyone guessed" early finish.

## 8. LiveKit voice

```
browser ──POST /api/voice/token (Bearer sessionToken)──► this server ──signs JWT──► browser
browser ══════════════ audio (WebRTC) ══════════════► LiveKit Cloud   (never via this server)
```

1. Create a project at [cloud.livekit.io](https://cloud.livekit.io) and copy the URL, API key and secret
   into `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
2. The frontend calls `GET /api/voice/status` and shows voice controls if `enabled`.
3. It calls `POST /api/voice/token` with `Authorization: Bearer <sessionToken>` and `{ roomCode }`.
4. The server checks that the session exists **and belongs to that room**, then returns a JWT
   that's valid for 10 minutes.
5. The frontend connects with `livekit-client`:
   `await room.connect(url, token); await room.localParticipant.setMicrophoneEnabled(true);`

**Token permissions (least privilege):** join only `scribble-<ROOM CODE>`, publish **microphone only**,
subscribe to audio, no data channel, no admin/record/create/list rights. Identity = public player ID.

**Mute/deafen** are client-side: mute with `setMicrophoneEnabled(false)`, deafen by detaching or
muting remote audio tracks. No server permissions needed.

**Leaving:** because a token only gates *joining*, the server also calls LiveKit's
`removeParticipant` when a player leaves or times out (best-effort).

## 9. Tests

```bash
npm test             # all tests (~2s)
npm run test:watch
npm run typecheck
```

| File | Covers |
|---|---|
| `room.test.ts` | create/join, capacity, duplicate usernames, duplicate sessions, disconnect/reconnect, grace expiry, host reassignment, room cleanup, invalid payloads |
| `drawing.test.ts` | relay to others, unauthorized drawing, invalid payloads, undo/clear, late-joiner `draw:sync`, rate limiting |
| `drawing.service.test.ts` | stroke rules, per-stroke and total history bounds |
| `chat.test.ts` | chat fields, length, rate limit, history bound, correct/incorrect/duplicate guesses, close hints, word never leaked |
| `game.service.test.ts` | **fake timers**: state machine, timer expiry, early end, stale-timer protection, rounds, completion, drawer/player departures, reconnecting drawer, late joiners |
| `game.test.ts` | full game over real sockets; clients can't set scores |
| `voice.test.ts` | token grants verified with LiveKit's `TokenVerifier`, 401/403/400/429/503, revocation after leaving |
| `scoring.test.ts`, `schemas.test.ts`, `store.test.ts`, `rate-limiter.test.ts`, `health.test.ts` | pure units |

Integration tests start a real server on a random port (`listen(0)`) with real `socket.io-client`
connections. Game-engine tests use `vi.useFakeTimers()` with a `FakeBroadcaster`, so an 80-second
turn runs instantly. **No LiveKit account is needed:** tokens are signed with fake credentials
and verified locally.

## 10. Deploying to Render

A blueprint is included at the repo root (`../render.yaml`).

**Option A: Blueprint (recommended)**

1. Push the repo (containing `server/` and `render.yaml`) to GitHub.
2. Render dashboard → **New → Blueprint** → select the repo.
3. Fill in `CORS_ORIGINS` (your frontend URL, e.g. `https://scribble.vercel.app`) and, optionally,
   the three `LIVEKIT_*` variables.

**Option B: Manual Web Service**

| Setting | Value |
|---|---|
| Root directory | `server` |
| Runtime | Node |
| Build command | `npm ci --include=dev && npm run build` |
| Start command | `npm start` |
| Health check path | `/health` |
| Env vars | `NODE_ENV=production`, `NODE_VERSION=22`, `CORS_ORIGINS=…`, `LIVEKIT_*` |

`--include=dev` matters. With `NODE_ENV=production`, a plain `npm ci` skips devDependencies,
which include TypeScript, so the build would fail.

The server already listens on `0.0.0.0:$PORT`, handles `SIGTERM` gracefully, and needs no disk.
Point the frontend's `NEXT_PUBLIC_SERVER_URL` at the Render URL (`https://…onrender.com`).
Socket.IO upgrades to WebSocket automatically.

### In-memory state on Render: what to expect

- **Restarts and deploys wipe all rooms.** Every deploy, crash or manual restart starts with
  zero rooms. Clients will get `ROOM_NOT_FOUND` when rejoining and should return to the lobby.
- **Free instances sleep** after ~15 minutes without inbound traffic. The first request after
  that takes ~30–60s (cold start), and any rooms are gone. Use a paid instance for real players.
- **Exactly one instance.** Rooms live in one process's memory. With 2+ instances, players
  in the same room could land on different processes and never see each other. **Do not enable
  autoscaling or set more than one instance** until state is shared (see §11).

## 11. Known MVP limitations

| Limitation | Path forward |
|---|---|
| All state is lost on restart/deploy | Persist rooms to Redis (or accept it for casual games) |
| Single instance only, no horizontal scaling | Redis-backed store + `@socket.io/redis-adapter` + sticky sessions; move timers to a single owner per room |
| Session token is a bearer secret in `sessionStorage`, with no user accounts | Add auth (e.g. NextAuth) if you need persistent identities |
| Word-in-chat filter is best-effort (spelled-out or synonym hints get through) | Accept it (it's a party game), or hide guessed players' chat from non-guessers like Skribbl |
| Drawer can't choose from 3 words; no progressive letter hints | Add a `choosing` phase and a hint-reveal timer to `GameService` |
| Fixed English word bank in code | Load custom word lists per room |
| Rate limits are per player/socket, not per IP | Add IP-based limits at a proxy/CDN if abused |
| Wrong guesses aren't stored in `chat:history` | Store them too if the UI shows them after reconnect |
| No moderation (kick/ban) | Add a host-only `room:kick` event |
| Voice removal on leave is best-effort | Add LiveKit webhooks to reconcile participants |
