import { afterEach, describe, expect, it } from "vitest";
import type { LeaderboardEntry, PublicTurn } from "../src/types/socket.types.js";
import { createRoom, emitAck, joinRoom, startTestServer, unwrap, waitFor, type TestContext } from "./helpers.js";

let ctx: TestContext;
afterEach(async () => {
  await ctx?.cleanup();
});

interface TurnStarted {
  round: number;
  turn: PublicTurn;
}

describe("full game over real sockets", () => {
  it("plays a complete 1-round game from start to leaderboard", async () => {
    ctx = await startTestServer({ startCountdownMs: 50, betweenTurnsMs: 50, turnDurationMs: 400 });
    const alice = await ctx.connectClient();
    const bob = await ctx.connectClient();
    const host = await createRoom(alice, "alice", { rounds: 1 });
    const guest = await joinRoom(bob, host.state.code, "bob");

    // Non-host can't start.
    expect(await emitAck(bob, "game:start", {})).toMatchObject({ ok: false, error: { code: "NOT_HOST" } });

    const aliceTurn = waitFor<TurnStarted>(alice, "game:turn-started");
    const bobTurn = waitFor<TurnStarted>(bob, "game:turn-started");
    unwrap(await emitAck(alice, "game:start", {}));

    // Turn 1: alice draws. Only she receives the word.
    const drawerView = await aliceTurn;
    const guesserView = await bobTurn;
    expect(drawerView.turn.drawerId).toBe(host.playerId);
    expect(drawerView.turn.word).toBeTruthy();
    expect(guesserView.turn.word).toBeUndefined();
    expect(guesserView.turn.hint).toMatch(/^[_ \-]+$/);

    // Bob guesses correctly → turn ends early.
    const ended = waitFor<{ reason: string; word: string }>(alice, "game:turn-ended");
    const nextTurn = waitFor<TurnStarted>(bob, "game:turn-started");
    const guess = unwrap(await emitAck<{ correct: boolean }>(bob, "guess:submit", { text: drawerView.turn.word }));
    expect(guess.correct).toBe(true);
    expect(await ended).toMatchObject({ reason: "all_guessed", word: drawerView.turn.word });

    // Turn 2: bob draws, nobody guesses, time runs out → game finishes.
    expect((await nextTurn).turn.drawerId).toBe(guest.playerId);
    const finished = await waitFor<{ leaderboard: LeaderboardEntry[] }>(alice, "game:finished", 3000);
    expect(finished.leaderboard.map((e) => e.username)).toContain("bob");
    expect(finished.leaderboard[0]!.rank).toBe(1);

    const room = ctx.server.store.get(host.state.code)!;
    expect(room.game.phase).toBe("finished");
    expect(room.timers.phase).toBeNull();
    expect(room.timers.tick).toBeNull();
  });

  it("clients have no way to set scores, timers, words or turns", async () => {
    ctx = await startTestServer();
    const alice = await ctx.connectClient();
    await createRoom(alice);
    // Unknown events are simply ignored; there is no handler that accepts these.
    for (const evil of ["game:set-score", "game:timer", "game:turn-ended", "room:state"]) {
      (alice as unknown as { emit(e: string, p: unknown): void }).emit(evil, { score: 999999 });
    }
    await new Promise((r) => setTimeout(r, 100));
    const room = [...ctx.server.store.values()][0]!;
    expect([...room.players.values()][0]!.score).toBe(0);
  });
});
