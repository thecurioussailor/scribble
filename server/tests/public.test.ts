import { afterEach, describe, expect, it } from "vitest";
import type { JoinRoomResult, PublicTurn } from "../src/types/socket.types.js";
import { emitAck, startTestServer, unwrap, waitFor, type TestContext } from "./helpers.js";

let ctx: TestContext;
afterEach(async () => {
  await ctx?.cleanup();
});

describe("Play with anyone (over real sockets)", () => {
  it("two strangers are matched into one public room and the game starts by itself", async () => {
    ctx = await startTestServer({ startCountdownMs: 50 });
    const alice = await ctx.connectClient();
    const bob = await ctx.connectClient();

    const a = unwrap(await emitAck<JoinRoomResult>(alice, "room:quick-join", { username: "alice" }));
    expect(a.state.visibility).toBe("public");
    expect(a.state.phase).toBe("waiting");

    const turnForAlice = waitFor<{ turn: PublicTurn }>(alice, "game:turn-started");
    const b = unwrap(await emitAck<JoinRoomResult>(bob, "room:quick-join", { username: "bob" }));
    expect(b.state.code).toBe(a.state.code);
    expect((await turnForAlice).turn.drawerId).toBe(a.playerId); // first to arrive draws first
  });

  it("a stranger arriving mid-game lands in the live game with the current canvas", async () => {
    ctx = await startTestServer({ startCountdownMs: 50 });
    const [alice, bob, carol] = await Promise.all([ctx.connectClient(), ctx.connectClient(), ctx.connectClient()]);
    unwrap(await emitAck(alice, "room:quick-join", { username: "alice" }));
    const started = waitFor(alice, "game:turn-started");
    unwrap(await emitAck(bob, "room:quick-join", { username: "bob" }));
    await started;
    unwrap(await emitAck(alice, "draw:start", { strokeId: "s1", color: "#000000", size: 4, point: { x: 0.5, y: 0.5 } }));

    const sync = waitFor<{ strokes: unknown[] }>(carol, "draw:sync");
    const c = unwrap(await emitAck<JoinRoomResult>(carol, "room:quick-join", { username: "carol" }));
    expect(c.state.phase).toBe("playing");
    expect(c.state.turn?.word).toBeUndefined(); // guessers never get the word
    expect((await sync).strokes).toHaveLength(1);
  });

  it("validates the name like every other join", async () => {
    ctx = await startTestServer();
    const client = await ctx.connectClient();
    expect(await emitAck(client, "room:quick-join", { username: "" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_PAYLOAD" },
    });
  });
});
