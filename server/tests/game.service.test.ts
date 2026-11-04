import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestConfig } from "../src/config/env.js";
import { ChatService } from "../src/services/chat.service.js";
import { DrawingService } from "../src/services/drawing.service.js";
import { GameService } from "../src/services/game.service.js";
import { GuessService } from "../src/services/guess.service.js";
import { RoomService } from "../src/services/room.service.js";
import { RoomStore } from "../src/store/room.store.js";
import type { Player } from "../src/types/game.types.js";
import { SCORING } from "../src/utils/scoring.js";
import { buildRoom, FakeBroadcaster } from "./fakes.js";

const TURN_MS = 80_000;
const COUNTDOWN_MS = 3_000;
const PAUSE_MS = 5_000;

/** Builds the full service graph with a fake broadcaster and a predictable word list. */
function createEngine(names = ["alice", "bob"], rounds = 2) {
  const config = createTestConfig({
    startCountdownMs: COUNTDOWN_MS,
    betweenTurnsMs: PAUSE_MS,
    reconnectGraceMs: 30_000,
    emptyRoomTtlMs: 60_000,
  });
  const store = new RoomStore();
  const broadcaster = new FakeBroadcaster();
  const drawing = new DrawingService(broadcaster);
  const chat = new ChatService(broadcaster);
  const guess = new GuessService(broadcaster, chat);
  const words = ["apple", "banana", "cherry", "dragon", "eagle", "falcon"];
  let wordIndex = 0;
  const game = new GameService(store, config, broadcaster, drawing, chat, () => words[wordIndex++ % words.length]!);
  const rooms = new RoomService(store, config, broadcaster);
  rooms.setGameHooks(game);
  guess.setCorrectGuessHandler((r) => game.checkAllGuessed(r));

  const { room, players } = buildRoom(names);
  room.settings.turnDurationMs = TURN_MS;
  room.settings.totalRounds = rounds;
  store.add(room);
  const byName = Object.fromEntries(players.map((p) => [p.username, p])) as Record<string, Player>;
  return { store, broadcaster, game, guess, rooms, room, players: byName };
}

/** Starts the game and skips the countdown so the first turn is live. */
function startAndSkipCountdown(engine: ReturnType<typeof createEngine>) {
  engine.game.startGame(engine.room, engine.players.alice!);
  vi.advanceTimersByTime(COUNTDOWN_MS);
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("starting a game", () => {
  it("only the host can start, and only with 2+ connected players", () => {
    const solo = createEngine(["alice"]);
    expect(() => solo.game.startGame(solo.room, solo.players.alice!)).toThrow(/At least 2 players/);

    const e = createEngine(["alice", "bob"]);
    expect(() => e.game.startGame(e.room, e.players.bob!)).toThrow(/Only the host/);

    e.players.bob!.socketId = null; // bob is offline
    expect(() => e.game.startGame(e.room, e.players.alice!)).toThrow(/At least 2 players/);
  });

  it("moves through starting → playing and rejects a second start", () => {
    const e = createEngine();
    e.game.startGame(e.room, e.players.alice!);
    expect(e.room.game.phase).toBe("starting");
    expect(e.broadcaster.events("game:started")).toHaveLength(1);
    expect(() => e.game.startGame(e.room, e.players.alice!)).toThrow(/already in progress/);

    vi.advanceTimersByTime(COUNTDOWN_MS);
    expect(e.room.game.phase).toBe("playing");
    expect(e.room.game.round).toBe(1);
    expect(e.room.game.turn?.drawerId).toBe(e.players.alice!.id); // join order
  });

  it("sends the word only to the drawer in game:turn-started", () => {
    const e = createEngine();
    startAndSkipCountdown(e);
    const turnEvents = e.broadcaster.events("game:turn-started");
    const forAlice = turnEvents.find((ev) => ev.target === `player:${e.players.alice!.id}`)!;
    const forBob = turnEvents.find((ev) => ev.target === `player:${e.players.bob!.id}`)!;
    expect(forAlice.args[0]).toMatchObject({ turn: { word: "apple", hint: "_____" } });
    expect(JSON.stringify(forBob.args[0])).not.toContain("apple");
  });

  it("clears the canvas at the start of each turn", () => {
    const e = createEngine();
    startAndSkipCountdown(e);
    expect(e.broadcaster.events("draw:clear")).toHaveLength(1);
  });
});

describe("turn timer", () => {
  it("ticks every second and ends the turn when time expires", () => {
    const e = createEngine();
    startAndSkipCountdown(e);

    vi.advanceTimersByTime(TURN_MS - 1);
    expect(e.room.game.phase).toBe("playing");
    expect(e.broadcaster.events("game:timer").length).toBe(79);

    vi.advanceTimersByTime(1);
    expect(e.room.game.phase).toBe("between_turns");
    const [ended] = e.broadcaster.events("game:turn-ended");
    expect(ended!.args[0]).toMatchObject({ word: "apple", reason: "time_up" });

    // The tick interval stops with the turn.
    const ticks = e.broadcaster.events("game:timer").length;
    vi.advanceTimersByTime(3_000);
    expect(e.broadcaster.events("game:timer").length).toBe(ticks);
  });

  it("rejects late guesses even if the timer callback hasn't run yet", () => {
    const e = createEngine();
    startAndSkipCountdown(e);
    vi.setSystemTime(Date.now() + TURN_MS); // clock past the deadline; timers not run
    expect(() => e.guess.submitGuess(e.room, e.players.bob!, "apple")).toThrow(/no word to guess/);
  });
});

describe("guessing ends turns", () => {
  it("ends the turn early when all guessers are correct, and scores the drawer", () => {
    const e = createEngine();
    startAndSkipCountdown(e);
    vi.advanceTimersByTime(20_000);

    const ack = e.guess.submitGuess(e.room, e.players.bob!, "Apple");
    expect(ack.correct).toBe(true);
    expect(e.room.game.phase).toBe("between_turns");
    expect(e.broadcaster.events("game:turn-ended")[0]!.args[0]).toMatchObject({ reason: "all_guessed" });
    expect(e.players.bob!.score).toBe(ack.pointsAwarded);
    expect(e.players.alice!.score).toBe(SCORING.drawerMaxPoints); // 1 of 1 guessed
  });

  it("a stale timer from an early-ended turn never ends the next turn", () => {
    const e = createEngine();
    startAndSkipCountdown(e);
    vi.advanceTimersByTime(10_000);
    e.guess.submitGuess(e.room, e.players.bob!, "apple"); // turn 1 ends at t=10s

    vi.advanceTimersByTime(PAUSE_MS); // turn 2 starts at t=15s (bob draws)
    const turnTwoSeq = e.room.game.turn!.seq;
    expect(e.room.game.turn!.drawerId).toBe(e.players.bob!.id);

    // t=80s is when turn 1's original timer WOULD have fired.
    vi.advanceTimersByTime(70_000);
    expect(e.room.game.phase).toBe("playing");
    expect(e.room.game.turn!.seq).toBe(turnTwoSeq);
    expect(e.broadcaster.events("game:turn-ended")).toHaveLength(1);
  });

  it("ending a turn twice is harmless (no duplicate transitions)", () => {
    const e = createEngine(["alice", "bob", "carol"]);
    startAndSkipCountdown(e);
    e.guess.submitGuess(e.room, e.players.bob!, "apple");
    e.guess.submitGuess(e.room, e.players.carol!, "apple");
    e.game.checkAllGuessed(e.room);
    e.game.checkAllGuessed(e.room);
    expect(e.broadcaster.events("game:turn-ended")).toHaveLength(1);
  });

  it("a disconnected guesser doesn't block the all-guessed check", () => {
    const e = createEngine(["alice", "bob", "carol"]);
    startAndSkipCountdown(e);
    e.rooms.handleDisconnect(e.room, e.players.carol!, e.players.carol!.socketId!);
    e.guess.submitGuess(e.room, e.players.bob!, "apple");
    expect(e.broadcaster.events("game:turn-ended")[0]!.args[0]).toMatchObject({ reason: "all_guessed" });
  });
});

describe("rounds and game completion", () => {
  it("gives every player one turn per round, then finishes with a leaderboard", () => {
    const e = createEngine(["alice", "bob"], 2);
    startAndSkipCountdown(e);
    const drawers: string[] = [];

    for (let turn = 0; turn < 4; turn++) {
      expect(e.room.game.phase).toBe("playing");
      drawers.push(e.room.players.get(e.room.game.turn!.drawerId)!.username);
      // Guesser scores, so the leaderboard has something to rank.
      const guesser = drawers.at(-1) === "alice" ? e.players.bob! : e.players.alice!;
      e.guess.submitGuess(e.room, guesser, e.room.game.turn!.word);
      vi.advanceTimersByTime(PAUSE_MS);
    }

    expect(drawers).toEqual(["alice", "bob", "alice", "bob"]);
    expect(e.room.game.phase).toBe("finished");
    expect(e.room.game.round).toBe(2);
    const [finished] = e.broadcaster.events("game:finished");
    const { leaderboard } = finished!.args[0] as { leaderboard: { rank: number; score: number }[] };
    expect(leaderboard).toHaveLength(2);
    expect(leaderboard[0]!.rank).toBe(1);
    expect(leaderboard[0]!.score).toBeGreaterThanOrEqual(leaderboard[1]!.score);
    // The last turn tells clients there is no next turn.
    expect(e.broadcaster.events("game:turn-ended").at(-1)!.args[0]).toMatchObject({ nextTurnAt: null });
  });

  it("uses different words within a game", () => {
    const e = createEngine(["alice", "bob"], 2);
    startAndSkipCountdown(e);
    const words = new Set<string>();
    for (let i = 0; i < 4; i++) {
      words.add(e.room.game.turn!.word);
      vi.advanceTimersByTime(TURN_MS + PAUSE_MS);
    }
    expect(words.size).toBe(4);
  });

  it("can be restarted after finishing, with scores reset", () => {
    const e = createEngine(["alice", "bob"], 1);
    startAndSkipCountdown(e);
    e.guess.submitGuess(e.room, e.players.bob!, "apple");
    vi.advanceTimersByTime(PAUSE_MS + TURN_MS + PAUSE_MS);
    expect(e.room.game.phase).toBe("finished");
    expect(e.players.bob!.score).toBeGreaterThan(0);

    e.game.startGame(e.room, e.players.alice!);
    expect(e.room.game.phase).toBe("starting");
    expect(e.players.bob!.score).toBe(0);
  });
});

describe("players leaving mid-game", () => {
  it("ends the turn when the drawer leaves, and the game continues", () => {
    const e = createEngine(["alice", "bob", "carol"]);
    startAndSkipCountdown(e);
    e.rooms.removePlayer(e.room, e.players.alice!.id, "left");

    expect(e.broadcaster.events("game:turn-ended")[0]!.args[0]).toMatchObject({ reason: "drawer_left" });
    vi.advanceTimersByTime(PAUSE_MS);
    expect(e.room.game.phase).toBe("playing");
    expect(e.room.game.turn!.drawerId).toBe(e.players.bob!.id);
  });

  it("finishes the game when fewer than 2 players remain", () => {
    const e = createEngine(["alice", "bob"]);
    startAndSkipCountdown(e);
    e.rooms.removePlayer(e.room, e.players.bob!.id, "left");
    expect(e.room.game.phase).toBe("finished");
    expect(e.broadcaster.events("game:finished")).toHaveLength(1);
    // No timers left behind.
    vi.advanceTimersByTime(TURN_MS * 2);
    expect(e.broadcaster.events("game:turn-started").length).toBe(2); // only the first turn (2 recipients)
  });

  it("a drawer who reconnects within the grace period keeps their turn", () => {
    const e = createEngine(["alice", "bob"]);
    startAndSkipCountdown(e);
    const alice = e.players.alice!;
    e.rooms.handleDisconnect(e.room, alice, alice.socketId!);
    vi.advanceTimersByTime(10_000);
    expect(e.room.game.phase).toBe("playing");

    e.rooms.joinRoom("socket-new", { roomCode: e.room.code, username: "alice", sessionToken: alice.sessionToken });
    vi.advanceTimersByTime(25_000); // past the original grace deadline
    expect(e.room.game.phase).toBe("playing");
    expect(e.room.game.turn!.drawerId).toBe(alice.id);
  });

  it("a drawer who doesn't come back loses the turn after the grace period", () => {
    const e = createEngine(["alice", "bob", "carol"]);
    startAndSkipCountdown(e);
    e.rooms.handleDisconnect(e.room, e.players.alice!, e.players.alice!.socketId!);
    vi.advanceTimersByTime(30_000);
    expect(e.broadcaster.events("game:turn-ended")[0]!.args[0]).toMatchObject({ reason: "drawer_left" });
  });

  it("a player who joins mid-round is queued to draw this round", () => {
    const e = createEngine(["alice", "bob"]);
    startAndSkipCountdown(e);
    const { player: dave } = e.rooms.joinRoom("socket-dave", { roomCode: e.room.code, username: "dave" });
    expect(e.room.game.drawQueue).toEqual([e.players.bob!.id, dave.id]);
  });

  it("offline players are skipped when their turn comes", () => {
    const e = createEngine(["alice", "bob", "carol"]);
    startAndSkipCountdown(e);
    e.rooms.handleDisconnect(e.room, e.players.bob!, e.players.bob!.socketId!);
    vi.advanceTimersByTime(TURN_MS + PAUSE_MS);
    expect(e.room.game.turn!.drawerId).toBe(e.players.carol!.id);
  });
});
