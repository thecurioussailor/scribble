// End-to-end smoke test against the COMPILED server (dist/), as Render would run it.
import { io } from "socket.io-client";
// Usage: npm run build && npm start  (in another terminal)  then: npm run smoke [url]
const URL = process.argv[2] ?? "http://127.0.0.1:4000";
const connect = () => new Promise((res) => { const s = io(URL, { transports: ["websocket"] }); s.on("connect", () => res(s)); });
const ack = (s, ev, p) => s.timeout(3000).emitWithAck(ev, p);
const once = (s, ev) => new Promise((r) => s.once(ev, r));

const health = await fetch(`${URL}/health`).then((r) => r.json());
console.log("health:", health);
const alice = await connect(), bob = await connect();
const created = await ack(alice, "room:create", { username: "alice", settings: { rounds: 1 } });
console.log("created room:", created.data.state.code);
const joined = await ack(bob, "room:join", { roomCode: created.data.state.code.toLowerCase(), username: "bob" });
console.log("bob joined:", joined.ok);

const aliceTurn = once(alice, "game:turn-started"), bobTurn = once(bob, "game:turn-started");
console.log("start:", (await ack(alice, "game:start", {})).ok);
const [a, b] = await Promise.all([aliceTurn, bobTurn]);
console.log("drawer sees word:", Boolean(a.turn.word), "| guesser sees hint:", b.turn.hint, "word hidden:", b.turn.word === undefined);

const moved = once(bob, "draw:move");
await ack(alice, "draw:start", { strokeId: "s1", color: "#000000", size: 4, point: { x: 0.1, y: 0.1 } });
await ack(alice, "draw:move", { strokeId: "s1", points: [{ x: 0.2, y: 0.2 }] });
console.log("bob received stroke:", JSON.stringify(await moved));

const ended = once(bob, "game:turn-ended");
console.log("wrong guess:", JSON.stringify((await ack(bob, "guess:submit", { text: "definitely-wrong" })).data));
console.log("right guess:", JSON.stringify((await ack(bob, "guess:submit", { text: a.turn.word.toUpperCase() })).data));
const e = await ended;
console.log("turn ended:", e.reason, "| word:", e.word, "| scores:", e.scores.map((s) => `${s.username}+${s.pointsGained}`).join(" "));
const voice = await fetch(`${URL}/api/voice/token`, { method: "POST", headers: { authorization: `Bearer ${created.data.sessionToken}`, "content-type": "application/json" }, body: JSON.stringify({ roomCode: created.data.state.code }) });
console.log("voice without LiveKit:", voice.status, (await voice.json()).error.code);
alice.close(); bob.close();
process.exit(0);
