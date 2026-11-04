import { afterEach, describe, expect, it } from "vitest";
import type { JoinRoomResult, PublicPlayer, RoomStateView } from "../src/types/socket.types.js";
import { ROOM_CODE_PATTERN } from "../src/utils/ids.js";
import {
  createRoom,
  emitAck,
  eventually,
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

describe("room creation and joining", () => {
  it("creates a room with the creator as host", async () => {
    ctx = await startTestServer();
    const alice = await ctx.connectClient();
    const result = await createRoom(alice, "alice");

    expect(result.state.code).toMatch(ROOM_CODE_PATTERN);
    expect(result.state.hostId).toBe(result.playerId);
    expect(result.state.players).toHaveLength(1);
    expect(result.state.players[0]).toMatchObject({ username: "alice", isHost: true, isConnected: true });
    expect(result.sessionToken.length).toBeGreaterThan(40);
    expect(result.reconnected).toBe(false);
  });

  it("joins by invite code (case-insensitive) and notifies existing players", async () => {
    ctx = await startTestServer();
    const alice = await ctx.connectClient();
    const bob = await ctx.connectClient();
    const { state } = await createRoom(alice);

    const joinedEvent = waitFor<{ player: PublicPlayer }>(alice, "player:joined");
    const bobResult = await joinRoom(bob, state.code.toLowerCase(), "bob");
    const { player } = await joinedEvent;

    expect(player).toMatchObject({ id: bobResult.playerId, username: "bob", isHost: false });
    expect(bobResult.state.players.map((p) => p.username)).toEqual(["alice", "bob"]);
  });

  it("never exposes other players' session tokens", async () => {
    ctx = await startTestServer();
    const alice = await ctx.connectClient();
    const bob = await ctx.connectClient();
    const aliceResult = await createRoom(alice);
    const statePromise = waitFor<RoomStateView>(bob, "room:state");
    await joinRoom(bob, aliceResult.state.code, "bob");
    expect(JSON.stringify(await statePromise)).not.toContain(aliceResult.sessionToken);
  });

  it("rejects unknown rooms, invalid payloads and duplicate usernames", async () => {
    ctx = await startTestServer();
    const alice = await ctx.connectClient();
    const bob = await ctx.connectClient();
    const { state } = await createRoom(alice);

    expect(await emitAck(bob, "room:join", { roomCode: "ZZZZZZZZ", username: "bob" })).toMatchObject({
      ok: false,
      error: { code: "ROOM_NOT_FOUND" },
    });
    expect(await emitAck(bob, "room:join", { roomCode: state.code })).toMatchObject({
      ok: false,
      error: { code: "INVALID_PAYLOAD" },
    });
    expect(await emitAck(bob, "room:join", "garbage")).toMatchObject({ ok: false, error: { code: "INVALID_PAYLOAD" } });
    expect(await emitAck(bob, "room:join", { roomCode: state.code, username: "ALICE" })).toMatchObject({
      ok: false,
      error: { code: "USERNAME_TAKEN" },
    });
  });

  it("enforces room capacity", async () => {
    ctx = await startTestServer({ maxPlayersPerRoom: 2 });
    const [a, b, c] = await Promise.all([ctx.connectClient(), ctx.connectClient(), ctx.connectClient()]);
    const { state } = await createRoom(a!);
    await joinRoom(b!, state.code, "bob");
    expect(await emitAck(c!, "room:join", { roomCode: state.code, username: "carol" })).toMatchObject({
      ok: false,
      error: { code: "ROOM_FULL" },
    });
  });

  it("prevents one socket from being in two rooms", async () => {
    ctx = await startTestServer();
    const alice = await ctx.connectClient();
    await createRoom(alice);
    expect(await emitAck(alice, "room:create", { username: "alice" })).toMatchObject({
      ok: false,
      error: { code: "ALREADY_IN_ROOM" },
    });
  });

  it("rejects room actions from sockets that aren't in a room", async () => {
    ctx = await startTestServer();
    const stranger = await ctx.connectClient();
    expect(await emitAck(stranger, "room:leave")).toMatchObject({ ok: false, error: { code: "NOT_IN_ROOM" } });
  });
});

describe("leaving and host reassignment", () => {
  it("reassigns host when the host leaves", async () => {
    ctx = await startTestServer();
    const alice = await ctx.connectClient();
    const bob = await ctx.connectClient();
    const aliceResult = await createRoom(alice);
    const bobResult = await joinRoom(bob, aliceResult.state.code, "bob");

    const leftEvent = waitFor<{ playerId: string; reason: string; newHostId: string }>(bob, "player:left");
    expect(await emitAck(alice, "room:leave")).toMatchObject({ ok: true });

    expect(await leftEvent).toEqual({ playerId: aliceResult.playerId, reason: "left", newHostId: bobResult.playerId });
    expect(ctx.server.store.get(aliceResult.state.code)?.hostId).toBe(bobResult.playerId);
  });

  it("deletes the room when the last player leaves", async () => {
    ctx = await startTestServer();
    const alice = await ctx.connectClient();
    const { state } = await createRoom(alice);
    await emitAck(alice, "room:leave");
    expect(ctx.server.store.get(state.code)).toBeUndefined();
  });
});

describe("disconnect and reconnect", () => {
  async function roomWithTwo(overrides = {}) {
    ctx = await startTestServer(overrides);
    const alice = await ctx.connectClient();
    const bob = await ctx.connectClient();
    const aliceResult = await createRoom(alice);
    const bobResult = await joinRoom(bob, aliceResult.state.code, "bob");
    return { alice, bob, aliceResult, bobResult };
  }

  it("keeps the seat during the grace period and restores it on reconnect", async () => {
    const { alice, bob, aliceResult, bobResult } = await roomWithTwo({ reconnectGraceMs: 5_000 });

    const disconnected = waitFor<{ playerId: string }>(alice, "player:disconnected");
    bob.disconnect();
    expect((await disconnected).playerId).toBe(bobResult.playerId);

    const reconnectedEvent = waitFor<{ playerId: string }>(alice, "player:reconnected");
    const bob2 = await ctx.connectClient();
    const resumed = await joinRoom(bob2, aliceResult.state.code, "ignored-name", bobResult.sessionToken);

    expect(resumed.reconnected).toBe(true);
    expect(resumed.playerId).toBe(bobResult.playerId);
    expect(resumed.state.players.find((p) => p.id === bobResult.playerId)).toMatchObject({
      username: "bob",
      isConnected: true,
    });
    expect((await reconnectedEvent).playerId).toBe(bobResult.playerId);
  });

  it("sends canvas and chat history to a reconnecting player", async () => {
    const { bob, aliceResult, bobResult } = await roomWithTwo({ reconnectGraceMs: 5_000 });
    bob.disconnect();
    await eventually(() => ctx.server.store.get(aliceResult.state.code)!.players.get(bobResult.playerId)!.socketId === null);

    const bob2 = await ctx.connectClient();
    const sync = waitFor<{ strokes: unknown[] }>(bob2, "draw:sync");
    const history = waitFor<{ messages: unknown[] }>(bob2, "chat:history");
    await joinRoom(bob2, aliceResult.state.code, "bob", bobResult.sessionToken);
    expect(await sync).toEqual({ strokes: [] });
    expect(await history).toEqual({ messages: [] });
  });

  it("removes a player whose grace period expires", async () => {
    const { alice, bob, bobResult } = await roomWithTwo({ reconnectGraceMs: 100 });
    const left = waitFor<{ playerId: string; reason: string }>(alice, "player:left");
    bob.disconnect();
    expect(await left).toMatchObject({ playerId: bobResult.playerId, reason: "timeout" });
  });

  it("reassigns host when a disconnected host times out", async () => {
    const { alice, bob, bobResult } = await roomWithTwo({ reconnectGraceMs: 100 });
    const left = waitFor<{ newHostId: string }>(bob, "player:left");
    alice.disconnect();
    expect((await left).newHostId).toBe(bobResult.playerId);
  });

  it("an old session token cannot be reused after the player is removed", async () => {
    const { bob, aliceResult, bobResult } = await roomWithTwo({ reconnectGraceMs: 50 });
    bob.disconnect();
    await eventually(() => !ctx.server.store.get(aliceResult.state.code)!.players.has(bobResult.playerId));

    const bob2 = await ctx.connectClient();
    const fresh = await joinRoom(bob2, aliceResult.state.code, "bob", bobResult.sessionToken);
    expect(fresh.reconnected).toBe(false);
    expect(fresh.playerId).not.toBe(bobResult.playerId);
  });
});

describe("duplicate sessions", () => {
  it("a second connection with the same session replaces the first", async () => {
    ctx = await startTestServer();
    const alice = await ctx.connectClient();
    const bob = await ctx.connectClient();
    const aliceResult = await createRoom(alice);
    const bobResult = await joinRoom(bob, aliceResult.state.code, "bob");

    const replaced = waitFor(bob, "session:replaced");
    const kicked = waitFor<string>(bob, "disconnect");
    // Alice must NOT see bob as disconnected: the seat moved to a new socket.
    const noDisconnect = expectNoEvent(alice, "player:disconnected", 300);

    const bobTab2 = await ctx.connectClient();
    const resumed: JoinRoomResult = await joinRoom(bobTab2, aliceResult.state.code, "bob", bobResult.sessionToken);

    await replaced;
    await kicked;
    await noDisconnect;
    expect(resumed.playerId).toBe(bobResult.playerId);
    const room = ctx.server.store.get(aliceResult.state.code)!;
    expect(room.players.size).toBe(2);
    expect(room.players.get(bobResult.playerId)!.socketId).toBe(bobTab2.id);
  });
});

describe("abandoned room cleanup", () => {
  it("deletes a room after everyone has been disconnected for the TTL", async () => {
    ctx = await startTestServer({ reconnectGraceMs: 10_000, emptyRoomTtlMs: 100 });
    const alice = await ctx.connectClient();
    const { state } = await createRoom(alice);
    alice.disconnect();
    await eventually(() => ctx.server.store.get(state.code) === undefined);
    expect(ctx.server.store.size).toBe(0);
  });

  it("does not delete a room if someone reconnects in time", async () => {
    ctx = await startTestServer({ reconnectGraceMs: 10_000, emptyRoomTtlMs: 300 });
    const alice = await ctx.connectClient();
    const result = await createRoom(alice);
    alice.disconnect();
    await eventually(() => ctx.server.store.get(result.state.code)!.players.get(result.playerId)!.socketId === null);

    const alice2 = await ctx.connectClient();
    await joinRoom(alice2, result.state.code, "alice", result.sessionToken);
    await new Promise((r) => setTimeout(r, 450));
    expect(ctx.server.store.get(result.state.code)).toBeDefined();
  });
});
