import { afterEach, describe, expect, it } from "vitest";
import { LIMITS } from "../src/config/limits.js";
import type { ChatMessage } from "../src/types/game.types.js";
import type { RoomStateView } from "../src/types/socket.types.js";
import { forceTurn } from "./fakes.js";
import {
  createRoom,
  emitAck,
  joinRoom,
  startTestServer,
  unwrap,
  waitFor,
  type TestContext,
} from "./helpers.js";

let ctx: TestContext;
afterEach(async () => {
  await ctx?.cleanup();
});

async function setupRoom(names = ["alice", "bob", "carol"]) {
  ctx = await startTestServer();
  const clients = await Promise.all(names.map(() => ctx.connectClient()));
  const host = await createRoom(clients[0]!, names[0]);
  const results = [host];
  for (let i = 1; i < names.length; i++) results.push(await joinRoom(clients[i]!, host.state.code, names[i]!));
  const room = ctx.server.store.get(host.state.code)!;
  return { clients, results, room, code: host.state.code };
}

describe("chat", () => {
  it("broadcasts messages with sender, username, timestamp and content", async () => {
    const { clients, results } = await setupRoom(["alice", "bob"]);
    const [alice, bob] = clients as [NonNullable<(typeof clients)[0]>, NonNullable<(typeof clients)[0]>];
    const received = waitFor<ChatMessage>(bob, "chat:message");
    const sent = unwrap(await emitAck<ChatMessage>(alice, "chat:send", { content: "  hello there  " }));
    const message = await received;

    expect(message).toEqual(sent);
    expect(message).toMatchObject({ type: "chat", senderId: results[0]!.playerId, username: "alice", content: "hello there" });
    expect(typeof message.timestamp).toBe("number");
  });

  it("validates length and rejects non-members", async () => {
    const { clients } = await setupRoom(["alice"]);
    expect(await emitAck(clients[0]!, "chat:send", { content: "x".repeat(LIMITS.chatMessageMaxLength + 1) })).toMatchObject({
      ok: false,
      error: { code: "INVALID_PAYLOAD" },
    });
    const stranger = await ctx.connectClient();
    expect(await emitAck(stranger, "chat:send", { content: "hi" })).toMatchObject({ ok: false, error: { code: "NOT_IN_ROOM" } });
  });

  it("rate-limits spam", async () => {
    const { clients } = await setupRoom(["alice"]);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => emitAck(clients[0]!, "chat:send", { content: `spam ${i}` })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => !r.ok && r.error.code === "RATE_LIMITED")).toHaveLength(5);
  });

  it("keeps a bounded history", async () => {
    const { room, results } = await setupRoom(["alice"]);
    const player = room.players.get(results[0]!.playerId)!;
    for (let i = 0; i < LIMITS.chatHistorySize + 10; i++) ctx.server.chatService.sendMessage(room, player, `m${i}`);
    expect(room.chat).toHaveLength(LIMITS.chatHistorySize);
    expect(room.chat[0]!.content).toBe("m10");
  });
});

describe("guessing", () => {
  it("scores a correct guess once, and announces it without revealing the word", async () => {
    const { clients, results, room } = await setupRoom();
    const [alice, bob, carol] = clients;
    forceTurn(room, results[0]!.playerId, "Ice Cream");

    const announced = waitFor<Record<string, unknown>>(carol!, "guess:result");
    const ack = unwrap(await emitAck<{ correct: boolean; pointsAwarded: number }>(bob!, "guess:submit", { text: "  ICE-cream " }));
    expect(ack.correct).toBe(true);
    expect(ack.pointsAwarded).toBeGreaterThan(0);

    const result = await announced;
    expect(result).toMatchObject({ playerId: results[1]!.playerId, correct: true, pointsAwarded: ack.pointsAwarded });
    expect(JSON.stringify(result).toLowerCase()).not.toContain("ice");
    expect(room.players.get(results[1]!.playerId)!.score).toBe(ack.pointsAwarded);

    // Duplicate guess: rejected, no extra points.
    expect(await emitAck(bob!, "guess:submit", { text: "ice cream" })).toMatchObject({
      ok: false,
      error: { code: "ALREADY_GUESSED" },
    });
    expect(room.players.get(results[1]!.playerId)!.score).toBe(ack.pointsAwarded);
    void alice;
  });

  it("broadcasts incorrect guesses and hints 'close' only to the guesser", async () => {
    const { clients, results, room } = await setupRoom();
    const [, bob, carol] = clients;
    forceTurn(room, results[0]!.playerId, "apple");

    const seenByCarol = waitFor<Record<string, unknown>>(carol!, "guess:result");
    const ack = unwrap(await emitAck<{ correct: boolean; close: boolean }>(bob!, "guess:submit", { text: "aple" }));
    expect(ack).toEqual({ correct: false, close: true, pointsAwarded: 0 });
    expect(await seenByCarol).toEqual({ playerId: results[1]!.playerId, username: "bob", correct: false, text: "aple" });

    const far = unwrap(await emitAck<{ close: boolean }>(bob!, "guess:submit", { text: "banana" }));
    expect(far.close).toBe(false);
  });

  it("the drawer can't guess, and nobody can guess outside a turn", async () => {
    const { clients, results, room } = await setupRoom(["alice", "bob"]);
    expect(await emitAck(clients[1]!, "guess:submit", { text: "apple" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE" },
    });
    forceTurn(room, results[0]!.playerId, "apple");
    expect(await emitAck(clients[0]!, "guess:submit", { text: "apple" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE" },
    });
  });

  it("rejects guesses after the deadline even if the timer hasn't fired yet", async () => {
    const { clients, results, room } = await setupRoom(["alice", "bob"]);
    forceTurn(room, results[0]!.playerId, "apple");
    room.game.turn!.endsAt = Date.now() - 1;
    expect(await emitAck(clients[1]!, "guess:submit", { text: "apple" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE" },
    });
  });

  it("blocks the word in chat during a turn (drawer, guessed players, and spaced-out tricks)", async () => {
    const { clients, results, room } = await setupRoom(["alice", "bob"]);
    const [alice, bob] = clients;
    forceTurn(room, results[0]!.playerId, "apple");
    for (const [client, text] of [
      [alice, "it's an APPLE"],
      [bob, "a p p l e"],
      [bob, "apple!"],
    ] as const) {
      expect(await emitAck(client!, "chat:send", { content: text })).toMatchObject({
        ok: false,
        error: { code: "INVALID_STATE" },
      });
    }
    // Unrelated words that merely contain other letters are fine.
    expect(await emitAck(bob!, "chat:send", { content: "nice drawing" })).toMatchObject({ ok: true });
  });

  it("room state shows the word only to the drawer", async () => {
    const { clients, results, room } = await setupRoom(["alice", "bob"]);
    const [alice, bob] = clients;
    forceTurn(room, results[0]!.playerId, "pineapple");

    const aliceState = waitFor<RoomStateView>(alice!, "room:state");
    const bobState = waitFor<RoomStateView>(bob!, "room:state");
    ctx.server.broadcaster.syncRoomState(room);

    expect((await aliceState).turn).toMatchObject({ word: "pineapple", hint: "_________", wordLength: 9 });
    const guesserView = await bobState;
    expect(guesserView.turn?.word).toBeUndefined();
    expect(guesserView.turn?.hint).toBe("_________");
    expect(JSON.stringify(guesserView)).not.toContain("pineapple");
  });
});
