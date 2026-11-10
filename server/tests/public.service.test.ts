import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestConfig } from "../src/config/env.js";
import { ChatService } from "../src/services/chat.service.js";
import { DrawingService } from "../src/services/drawing.service.js";
import { GameService } from "../src/services/game.service.js";
import { GuessService } from "../src/services/guess.service.js";
import { RoomService } from "../src/services/room.service.js";
import { RoomStore } from "../src/store/room.store.js";
import { FakeBroadcaster } from "./fakes.js";

const COUNTDOWN = 3_000;
const TURN = 80_000;
const PAUSE = 5_000;
const RESTART = 12_000;

function createEngine(overrides: Parameters<typeof createTestConfig>[0] = {}) {
  const config = createTestConfig({
    startCountdownMs: COUNTDOWN,
    turnDurationMs: TURN,
    betweenTurnsMs: PAUSE,
    publicRestartDelayMs: RESTART,
    reconnectGraceMs: 30_000,
    emptyRoomTtlMs: 60_000,
    maxPlayersPerRoom: 3,
    defaultRounds: 1,
    ...overrides,
  });
  const store = new RoomStore();
  const broadcaster = new FakeBroadcaster();
  const drawing = new DrawingService(broadcaster);
  const chat = new ChatService(broadcaster);
  const guess = new GuessService(broadcaster, chat);
  const game = new GameService(store, config, broadcaster, drawing, chat);
  const rooms = new RoomService(store, config, broadcaster);
  rooms.setGameHooks(game);
  guess.setCorrectGuessHandler((r) => game.checkAllGuessed(r));

  let socketNo = 0;
  const quickJoin = (name: string) => rooms.quickJoin(`socket-${++socketNo}`, name);
  return { store, broadcaster, game, rooms, quickJoin };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("matchmaking (room:quick-join)", () => {
  it("opens a public room for the first player, who waits there alone", () => {
    const e = createEngine();
    const { room } = e.quickJoin("ashu");
    expect(room.settings.visibility).toBe("public");
    expect(room.players.size).toBe(1);
    expect(room.game.phase).toBe("waiting");
  });

  it("puts the next player in the same room and starts the game on its own", () => {
    const e = createEngine();
    const first = e.quickJoin("ashu");
    const second = e.quickJoin("suruchi");
    expect(second.room).toBe(first.room);
    expect(first.room.game.phase).toBe("starting"); // nobody pressed Start
    vi.advanceTimersByTime(COUNTDOWN);
    expect(first.room.game.phase).toBe("playing");
  });

  it("gives strangers with the same name a unique one instead of rejecting them", () => {
    const e = createEngine();
    e.quickJoin("ashu");
    const second = e.quickJoin("Ashu");
    const third = e.quickJoin("ASHU");
    expect(second.player.username).toBe("Ashu2");
    expect(third.player.username).toBe("ASHU3");
  });

  it("keeps long names within 20 characters when adding a number", () => {
    const e = createEngine();
    const long = "abcdefghijklmnopqrst"; // 20 chars
    e.quickJoin(long);
    expect(e.quickJoin(long).player.username).toBe("abcdefghijklmnopqrs2");
  });

  it("opens a new room when every public room is full", () => {
    const e = createEngine(); // max 3 players
    const a = e.quickJoin("p1").room;
    e.quickJoin("p2");
    e.quickJoin("p3");
    const fourth = e.quickJoin("p4").room;
    expect(fourth).not.toBe(a);
    expect(e.store.size).toBe(2);
  });

  it("prefers the busiest room so games fill up", () => {
    const e = createEngine();
    const a = e.quickJoin("a1").room;
    const leaver = e.quickJoin("a2");
    e.quickJoin("a3"); // room A full
    const b = e.quickJoin("b1").room; // room B: 1 player
    e.rooms.leaveRoom(a, leaver.player); // room A: 2 players, 1 seat free
    expect(e.quickJoin("newcomer").room).toBe(a);
    expect(b.players.size).toBe(1);
  });

  it("never matches anyone into a private room", () => {
    const e = createEngine();
    const { room: privateRoom } = e.rooms.createRoom("socket-x", { username: "host" });
    const { room } = e.quickJoin("stranger");
    expect(room).not.toBe(privateRoom);
    expect(privateRoom.players.size).toBe(1);
  });

  it("skips public rooms where nobody is online", () => {
    const e = createEngine();
    const { room, player } = e.quickJoin("ghost");
    e.rooms.handleDisconnect(room, player, player.socketId!);
    expect(e.quickJoin("newcomer").room).not.toBe(room);
  });
});

describe("public games run themselves", () => {
  it("rejects the host's Start button: public games start automatically", () => {
    const e = createEngine();
    const { room, player } = e.quickJoin("ashu");
    expect(() => e.game.startGame(room, player)).toThrow(/start on their own/);
  });

  it("starts the next game automatically after the final scores", () => {
    const e = createEngine();
    const { room } = e.quickJoin("ashu");
    e.quickJoin("suruchi");
    // 1 round × 2 drawers, nobody guesses: countdown, turn, pause, turn, pause → finished.
    vi.advanceTimersByTime(COUNTDOWN + TURN + PAUSE + TURN + PAUSE);
    expect(room.game.phase).toBe("finished");
    const finished = e.broadcaster.events("game:finished").at(-1)!;
    expect(finished.args[0]).toMatchObject({ nextGameInMs: RESTART });

    vi.advanceTimersByTime(RESTART);
    expect(room.game.phase).toBe("starting");
    expect(e.broadcaster.events("game:started")).toHaveLength(2);
  });

  it("goes back to waiting if only one player is left, then starts when someone joins", () => {
    const e = createEngine();
    const { room } = e.quickJoin("ashu");
    const leaver = e.quickJoin("suruchi");
    vi.advanceTimersByTime(COUNTDOWN);
    e.rooms.leaveRoom(room, leaver.player); // 1 player left → game over
    expect(room.game.phase).toBe("finished");

    vi.advanceTimersByTime(RESTART);
    expect(room.game.phase).toBe("waiting");

    expect(e.quickJoin("harshi").room).toBe(room);
    expect(room.game.phase).toBe("starting");
  });

  it("a returning player can be the second one that starts the game", () => {
    // Long grace period so bob is "away" (not removed) for the whole scenario.
    const e = createEngine({ reconnectGraceMs: 10 * 60_000 });
    const { room } = e.quickJoin("ashu");
    const bob = e.quickJoin("bob");
    vi.advanceTimersByTime(COUNTDOWN);
    e.rooms.handleDisconnect(room, bob.player, bob.player.socketId!);
    // Bob's still in his grace period; the game continues until the turn and pause end.
    vi.advanceTimersByTime(TURN + PAUSE); // next turn: bob is offline → only 1 online → finished
    expect(room.game.phase).toBe("finished");
    vi.advanceTimersByTime(RESTART);
    expect(room.game.phase).toBe("waiting");

    e.rooms.joinRoom("socket-bob-2", { roomCode: room.code, username: "bob", sessionToken: bob.player.sessionToken });
    expect(room.game.phase).toBe("starting");
  });

  it("private rooms keep the host's Start button and never restart on their own", () => {
    const e = createEngine();
    const { room, player } = e.rooms.createRoom("socket-h", { username: "host" });
    e.rooms.joinRoom("socket-g", { roomCode: room.code, username: "guest" });
    expect(room.game.phase).toBe("waiting"); // no auto-start
    e.game.startGame(room, player);
    vi.advanceTimersByTime(COUNTDOWN + TURN + PAUSE + TURN + PAUSE);
    expect(room.game.phase).toBe("finished");
    expect(e.broadcaster.events("game:finished").at(-1)!.args[0]).toMatchObject({ nextGameInMs: null });
    vi.advanceTimersByTime(RESTART * 3);
    expect(room.game.phase).toBe("finished");
  });
});
