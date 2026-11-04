import { afterEach, describe, expect, it } from "vitest";
import type { Stroke } from "../src/types/game.types.js";
import { forceTurn } from "./fakes.js";
import {
  createRoom,
  emitAck,
  expectNoEvent,
  joinRoom,
  startTestServer,
  waitFor,
  type TestContext,
} from "./helpers.js";

let ctx: TestContext;
afterEach(async () => {
  await ctx?.cleanup();
});

/** Room with alice (drawer) and bob (guesser), with a turn forced live. */
async function setup() {
  ctx = await startTestServer();
  const alice = await ctx.connectClient();
  const bob = await ctx.connectClient();
  const aliceResult = await createRoom(alice);
  const bobResult = await joinRoom(bob, aliceResult.state.code, "bob");
  const room = ctx.server.store.get(aliceResult.state.code)!;
  forceTurn(room, aliceResult.playerId);
  return { alice, bob, room, code: aliceResult.state.code, bobResult };
}

const start = { strokeId: "s1", color: "#ff0000", size: 6, point: { x: 0.1, y: 0.2 } };

describe("drawing synchronization", () => {
  it("relays the drawer's strokes to other players (not back to the drawer)", async () => {
    const { alice, bob } = await setup();

    const started = waitFor(bob, "draw:start");
    const echo = expectNoEvent(alice, "draw:start");
    expect(await emitAck(alice, "draw:start", start)).toEqual({ ok: true, data: undefined });
    expect(await started).toEqual(start);
    await echo;

    const moved = waitFor(bob, "draw:move");
    await emitAck(alice, "draw:move", { strokeId: "s1", points: [{ x: 0.2, y: 0.3 }, { x: 0.25, y: 0.35 }] });
    expect(await moved).toEqual({ strokeId: "s1", points: [{ x: 0.2, y: 0.3 }, { x: 0.25, y: 0.35 }] });

    const ended = waitFor(bob, "draw:end");
    await emitAck(alice, "draw:end", { strokeId: "s1" });
    expect(await ended).toEqual({ strokeId: "s1" });
  });

  it("blocks non-drawers from drawing, clearing or undoing", async () => {
    const { alice, bob } = await setup();
    const noLeak = expectNoEvent(alice, "draw:start", 200);
    expect(await emitAck(bob, "draw:start", start)).toMatchObject({ ok: false, error: { code: "NOT_DRAWER" } });
    expect(await emitAck(bob, "draw:clear")).toMatchObject({ ok: false, error: { code: "NOT_DRAWER" } });
    expect(await emitAck(bob, "draw:undo")).toMatchObject({ ok: false, error: { code: "NOT_DRAWER" } });
    await noLeak;
  });

  it("blocks drawing from sockets that aren't in a room", async () => {
    ctx = await startTestServer();
    const stranger = await ctx.connectClient();
    expect(await emitAck(stranger, "draw:start", start)).toMatchObject({ ok: false, error: { code: "NOT_IN_ROOM" } });
  });

  it("rejects invalid drawing payloads", async () => {
    const { alice } = await setup();
    const bad = [
      { ...start, point: { x: 2, y: 0 } },
      { ...start, point: { x: -0.1, y: 0 } },
      { ...start, color: "javascript:alert(1)" },
      { ...start, size: 0 },
      { ...start, size: 1000 },
      { ...start, strokeId: "" },
      "not-an-object",
    ];
    for (const payload of bad) {
      expect(await emitAck(alice, "draw:start", payload)).toMatchObject({ ok: false, error: { code: "INVALID_PAYLOAD" } });
    }
    const tooMany = Array.from({ length: 65 }, () => ({ x: 0.5, y: 0.5 }));
    expect(await emitAck(alice, "draw:move", { strokeId: "s1", points: tooMany })).toMatchObject({
      ok: false,
      error: { code: "INVALID_PAYLOAD" },
    });
  });

  it("broadcasts clear and undo", async () => {
    const { alice, bob, room } = await setup();
    await emitAck(alice, "draw:start", start);
    await emitAck(alice, "draw:start", { ...start, strokeId: "s2" });

    const undone = waitFor(bob, "draw:undo");
    await emitAck(alice, "draw:undo");
    expect(await undone).toEqual({ strokeId: "s2" });
    expect(room.strokes.map((s) => s.id)).toEqual(["s1"]);

    const cleared = waitFor(bob, "draw:clear");
    await emitAck(alice, "draw:clear");
    await cleared;
    expect(room.strokes).toEqual([]);
  });

  it("a late joiner receives the current canvas via draw:sync", async () => {
    const { alice, code } = await setup();
    await emitAck(alice, "draw:start", start);
    await emitAck(alice, "draw:move", { strokeId: "s1", points: [{ x: 0.5, y: 0.5 }] });
    await emitAck(alice, "draw:end", { strokeId: "s1" });

    const carol = await ctx.connectClient();
    const sync = waitFor<{ strokes: Stroke[] }>(carol, "draw:sync");
    await joinRoom(carol, code, "carol");
    const { strokes } = await sync;
    expect(strokes).toEqual([
      { id: "s1", color: "#ff0000", size: 6, points: [{ x: 0.1, y: 0.2 }, { x: 0.5, y: 0.5 }], complete: true },
    ]);
  });

  it("rate-limits drawing floods", async () => {
    const { alice } = await setup();
    await emitAck(alice, "draw:start", start);
    const results = await Promise.all(
      Array.from({ length: 300 }, () => emitAck(alice, "draw:move", { strokeId: "s1", points: [{ x: 0.5, y: 0.5 }] })),
    );
    const limited = results.filter((r) => !r.ok && r.error.code === "RATE_LIMITED").length;
    expect(limited).toBeGreaterThan(100);
  });
});
