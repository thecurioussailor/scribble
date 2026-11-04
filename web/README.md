# Scribble Web

Next.js 16 frontend for the Scribble drawing game. Talks to the game server in `../server` over Socket.IO.

## Run locally

```bash
# terminal 1: game server
cd server && npm install && npm run dev        # http://localhost:4000

# terminal 2: this app
cd web && npm install && npm run dev           # http://localhost:3000
```

Open http://localhost:3000, enter a name, press **Play**, then open the invite link in a second
browser (or a private window) to join as another player.

`NEXT_PUBLIC_SERVER_URL` in `.env.local` points at the game server (default `http://localhost:4000`).
The server's `CORS_ORIGINS` must include this app's URL.

## Structure

```
src/
├── app/
│   ├── layout.tsx            fonts, crayon SVG filter, page shell
│   ├── globals.css           palette tokens + .crayon hand-drawn styles
│   ├── page.tsx              landing page (static)
│   └── room/[code]/page.tsx  room route → client-only RoomClient
├── components/
│   ├── Wordmark.tsx          "scribble" + self-drawing squiggle
│   ├── PlayForm.tsx          name, Play (create room), invite-code join
│   ├── RoomClientLoader.tsx  loads RoomClient with ssr:false
│   └── RoomClient.tsx        connect/resume/name prompt + lobby
└── lib/
    ├── protocol.ts           copy of the server's event contract (keep in sync)
    ├── socket.ts             one shared socket + create/join/resume/leave/start
    ├── session.ts            sessionStorage (session token) / localStorage (name)
    └── browser.ts            useBrowserValue: hydration-safe browser reads
```

## Notes

- The session token lives in **sessionStorage**, so each tab is its own player and a refresh rejoins the same seat.
- The walking-friends illustration in `public/illustrations/` was supplied as design reference.
  Confirm you have the rights to use it (or credit the artist) before launching publicly.
