# Socket.IO Event Contract

The TypeScript source of truth is [`src/types/socket.types.ts`](../src/types/socket.types.ts).
Payload shapes are inferred from the Zod schemas in [`src/validation/schemas.ts`](../src/validation/schemas.ts).
The frontend can copy or import both files to get compile-time checking of every event.

- [Conventions](#conventions)
- [Error codes](#error-codes)
- [Client → Server](#client--server)
- [Server → Client](#server--client)
- [Typical flows](#typical-flows)

## Conventions

**Acknowledgements.** Commands that need a result take a callback as the last argument. It's
always called with one of:

```jsonc
{ "ok": true,  "data": /* event-specific, often undefined */ }
{ "ok": false, "error": { "code": "ROOM_FULL", "message": "This room is full." } }
```

`message` is safe to show to users. Use `code` for logic.

With socket.io-client ≥ 4.6 the easiest pattern is:

```ts
const res = await socket.timeout(5000).emitWithAck("room:join", { roomCode, username });
if (!res.ok) showError(res.error.message);
```

**Identity.** The server identifies you by the socket you joined with, never by IDs in
payloads. There's no field to put a player ID in, and the server would ignore it anyway.

**Coordinates** are normalized: `x` and `y` are fractions (0–1) of the canvas width and height.

**Limits** (enforced server-side):

| What | Limit |
|---|---|
| Username | 1–20 chars: letters, digits, space, `_ . -` |
| Chat message | 1–200 chars |
| Guess | 1–60 chars |
| Points per `draw:move` | 64 |
| Points per stroke | 5,000 |
| Canvas history | 50,000 points total |
| Brush size | integer 1–50 |
| Color | `#RRGGBB` |
| Socket message | 16 KB |

**Rate limits** (token bucket per player; burst, then sustained rate):

| Category | Burst | Sustained | Events |
|---|---|---|---|
| room | 5 | 1 per 2s | `room:create`, `room:join` (per socket) |
| game | 3 | 1 per 2s | `game:start` |
| draw | 120 | 60/s | all `draw:*` |
| chat | 5 | 1/s | `chat:send` |
| guess | 6 | 2/s | `guess:submit` |
| voice | 5 | 1 per 10s | `POST /api/voice/token` |

## Error codes

| Code | Meaning |
|---|---|
| `INVALID_PAYLOAD` | Payload failed validation. The message names the field |
| `RATE_LIMITED` | Too many events. Slow down |
| `ROOM_NOT_FOUND` | No room with that code (or it was cleaned up) |
| `ROOM_FULL` | Room is at max players |
| `USERNAME_TAKEN` | Name already used in that room (case-insensitive) |
| `ALREADY_IN_ROOM` | This socket is already in a room. `room:leave` first |
| `NOT_IN_ROOM` | Action needs room membership |
| `NOT_HOST` | Host-only action |
| `NOT_DRAWER` | Drawer-only action |
| `INVALID_STATE` | Not allowed right now (e.g. guessing between turns, word in chat) |
| `NOT_ENOUGH_PLAYERS` | Need 2+ connected players to start |
| `GAME_IN_PROGRESS` | Can't start: a game is running |
| `ALREADY_GUESSED` | You already guessed this turn's word |
| `SESSION_INVALID` | (HTTP) Missing/unknown session token |
| `VOICE_NOT_CONFIGURED` | (HTTP) LiveKit env vars not set |
| `INTERNAL_ERROR` | Server bug; details are logged server-side only |

---

## Client → Server

### `room:create` (ack)

```jsonc
// payload (settings optional; each field optional)
{ "username": "alice", "settings": { "rounds": 3, "turnDurationSeconds": 80, "maxPlayers": 8 } }

// ack data: JoinRoomResult
{
  "playerId": "q3Zr8x0mT2pA",
  "sessionToken": "Xy9…43 chars…",   // SECRET: store it (sessionStorage) for reconnects
  "reconnected": false,
  "state": { /* RoomStateView, see room:state */ }
}
```

`maxPlayers` can lower but not raise the server's `MAX_PLAYERS_PER_ROOM`.

### `room:join` (ack)

```jsonc
// New player
{ "roomCode": "ABCD2345", "username": "bob" }
// Reconnect: same seat, same score (username is ignored)
{ "roomCode": "ABCD2345", "username": "bob", "sessionToken": "Xy9…" }

// ack data: JoinRoomResult (reconnected: true when the seat was resumed)
```

Room codes are case-insensitive. After a successful join the server also sends
`draw:sync` and `chat:history` to the joining socket.

A token for a *different* room, or for a player who was already removed, is ignored, and you
join as a new player.

### `room:quick-join` (ack)

"Play with anyone": no room code, the server picks the room.

```jsonc
// payload
{ "username": "ashu" }
// ack data: JoinRoomResult (state.visibility === "public")
```

Matchmaking puts you in the **busiest public room with a free seat** (at least one person online),
or opens a new public room. If your name is taken there, you get a number added (`ashu` → `ashu2`).
Public rooms have no host controls: the game **starts by itself** once 2 players are online, and
the **next game starts by itself** `nextGameInMs` after `game:finished`. Private rooms (from
`room:create`) are never matched. After joining, the server sends `draw:sync` and `chat:history`.

### `room:leave` (ack optional)

No payload. Permanently leaves the room, reassigning host if needed.

### `game:start` (ack, host only)

```jsonc
{}                 // use room's configured rounds
{ "rounds": 2 }    // override (1–10)
```

Allowed in `waiting` or `finished`, in **private** rooms only (public games start themselves). Needs 2+ connected players.

### `draw:start` / `draw:move` / `draw:end` (ack optional, drawer only)

```jsonc
// draw:start
{ "strokeId": "s-1699999999-1", "color": "#1e90ff", "size": 6, "point": { "x": 0.42, "y": 0.31 } }
// draw:move: batch points, flush every ~30 ms
{ "strokeId": "s-1699999999-1", "points": [{ "x": 0.43, "y": 0.32 }, { "x": 0.45, "y": 0.33 }] }
// draw:end
{ "strokeId": "s-1699999999-1" }
```

`strokeId` is client-generated (`[A-Za-z0-9_-]`, max 40), unique within the turn. Only the
latest unfinished stroke accepts points. Drawing events are **not echoed** to the drawer.

Without an ack, rejected drawing events are dropped silently, by design (see README).

### `draw:undo` / `draw:clear` (ack optional, drawer only)

No payload. Undo removes the most recent stroke.

### `chat:send` (ack)

```jsonc
{ "content": "nice drawing!" }
// ack data: the ChatMessage as broadcast
```

During a live turn, messages containing the secret word are rejected (`INVALID_STATE`).

### `guess:submit` (ack, non-drawers during `playing`)

```jsonc
{ "text": "ice cream" }
// ack data
{ "correct": true,  "close": false, "pointsAwarded": 412 }
{ "correct": false, "close": true,  "pointsAwarded": 0 }   // one letter off: only YOU see "close"
```

Comparison ignores case, accents, punctuation and extra spaces (`"  ICE-cream! "` matches `ice cream`).

---

## Server → Client

### `room:state`

Sent after every meaningful change. **Personalized**: `turn.word` is only present for the drawer.

```jsonc
{
  "code": "ABCD2345",
  "hostId": "q3Zr8x0mT2pA",
  "selfId": "Lm0pQ7sZk1Yb",          // who this view is for
  "visibility": "private",           // "public" = matchmade, no lobby or Start button
  "phase": "playing",                // waiting | starting | playing | between_turns | finished
  "round": 1,
  "totalRounds": 3,
  "settings": { "maxPlayers": 8, "turnDurationSeconds": 80 },
  "players": [
    { "id": "q3Zr8x0mT2pA", "username": "alice", "score": 400, "isHost": true,
      "isConnected": true, "isDrawing": true, "hasGuessed": false },
    { "id": "Lm0pQ7sZk1Yb", "username": "bob", "score": 412, "isHost": false,
      "isConnected": true, "isDrawing": false, "hasGuessed": true }
  ],
  "turn": {
    "drawerId": "q3Zr8x0mT2pA",
    "wordLength": 9,
    "hint": "___ _____",             // letters hidden, spaces/hyphens shown
    "endsAt": 1730740000000,         // absolute ms timestamp, so render your countdown from this
    "remainingMs": 41200
    // "word": "ice cream"           ← ONLY in the drawer's copy
  }
}
```

### Player events

```jsonc
"player:joined"        { "player": PublicPlayer }
"player:left"          { "playerId": "…", "reason": "left" | "timeout", "newHostId": "…" | null }
"player:disconnected"  { "playerId": "…" }    // seat kept for RECONNECT_GRACE_SECONDS
"player:reconnected"   { "playerId": "…" }
```

### Game events

```jsonc
"game:started"      { "totalRounds": 3, "startsAt": 1730740003000 }

"game:turn-started" { "round": 1, "totalRounds": 3, "turn": PublicTurn }   // personalized like room:state

"game:timer"        { "remainingMs": 41000, "endsAt": 1730740000000 }      // every second

"game:turn-ended"   {
  "word": "ice cream",               // revealed to everyone now
  "reason": "time_up",               // time_up | all_guessed | drawer_left | not_enough_players
  "drawerId": "q3Zr8x0mT2pA",
  "scores": [ { "playerId": "…", "username": "bob", "pointsGained": 412, "totalScore": 412 } ],
  "nextTurnAt": 1730740005000        // null if this was the final turn
}

"game:finished"     { "leaderboard": [ { "playerId": "…", "username": "bob", "score": 1630, "rank": 1 } ],
                      "nextGameInMs": 12000 }   // public rooms restart on their own; null for private rooms
```

Ties share a rank (1, 2, 2, 4).

### Drawing events (to everyone except the drawer)

```jsonc
"draw:start"  { "strokeId", "color", "size", "point" }
"draw:move"   { "strokeId", "points": [ … ] }
"draw:end"    { "strokeId" }
"draw:undo"   { "strokeId" }          // remove this stroke
"draw:clear"  (no payload)            // also sent to everyone at each turn start
"draw:sync"   { "strokes": [ { "id", "color", "size", "points": [ … ], "complete": true } ] }
```

`draw:sync` is sent to a socket right after it joins or reconnects: redraw the canvas from it.

### Chat & guess events

```jsonc
"chat:message"  { "id", "type": "chat" | "system", "senderId": "…" | null, "username": "…" | null,
                  "content": "…", "timestamp": 1730740000000 }
"chat:history"  { "messages": [ ChatMessage, … ] }   // last 50, sent on join

"guess:result"  { "playerId", "username", "correct": true,  "pointsAwarded": 412 }   // no text!
"guess:result"  { "playerId", "username", "correct": false, "text": "ice crem" }
```

### Session events

```jsonc
"session:replaced"   // your session was opened elsewhere; this socket is disconnected next
"server:error"       { "code", "message" }   // reserved for unsolicited errors
```

---

## HTTP endpoints

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/health` | none | `{ "status": "ok", "uptimeSeconds": 12, "rooms": 3 }` |
| GET | `/api/voice/status` | none | `{ "enabled": true }` |
| POST | `/api/voice/token` | `Authorization: Bearer <sessionToken>` | see below |

```http
POST /api/voice/token
Authorization: Bearer Xy9…
Content-Type: application/json

{ "roomCode": "ABCD2345" }
```

```jsonc
// 200
{ "token": "eyJhbGciOi…", "url": "wss://your-project.livekit.cloud",
  "roomName": "scribble-ABCD2345", "identity": "q3Zr8x0mT2pA", "expiresAt": 1730740600000 }
// 401 SESSION_INVALID · 403 NOT_IN_ROOM · 400 INVALID_PAYLOAD · 429 RATE_LIMITED · 503 VOICE_NOT_CONFIGURED
{ "error": { "code": "VOICE_NOT_CONFIGURED", "message": "Voice chat is not configured on this server. Missing: LIVEKIT_URL." } }
```

---

## Typical flows

**Create & play**

```
host:  room:create ─ack→ { sessionToken, state }        store sessionToken
guest: room:join   ─ack→ { sessionToken, state }  + draw:sync + chat:history
all:   ◄ player:joined, room:state
host:  game:start  ─ack→ ok
all:   ◄ game:started → (3s) → draw:clear, game:turn-started, room:state, game:timer…
drawer: draw:start/move/end ──► others ◄ draw:start/move/end
guess: guess:submit ─ack→ { correct }   all ◄ guess:result, chat:message(system), room:state
all:   ◄ game:turn-ended → (5s) → next turn … → game:finished
```

**Reconnect**

```
socket drops        → others ◄ player:disconnected      (seat held for grace period)
socket.io reconnects → client: room:join { roomCode, sessionToken }
                     → ack { reconnected: true } + draw:sync + chat:history
                     → others ◄ player:reconnected
```
