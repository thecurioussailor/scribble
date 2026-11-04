import type { Broadcaster } from "../src/socket/broadcaster.js";
import { createPlayer, createRoom } from "../src/store/room.factory.js";
import type { Player, Room } from "../src/types/game.types.js";

export interface SentEvent {
  target: string;
  event: string;
  args: unknown[];
}

/** Records every event instead of sending it, for testing services without sockets. */
export class FakeBroadcaster implements Broadcaster {
  sent: SentEvent[] = [];

  toRoom(roomCode: string, event: string, ...args: unknown[]) {
    this.sent.push({ target: `room:${roomCode}`, event, args });
  }
  toRoomExcept(roomCode: string, except: Player, event: string, ...args: unknown[]) {
    this.sent.push({ target: `room:${roomCode}-except:${except.id}`, event, args });
  }
  toPlayer(player: Player, event: string, ...args: unknown[]) {
    this.sent.push({ target: `player:${player.id}`, event, args });
  }
  syncRoomState(room: Room) {
    this.sent.push({ target: `room:${room.code}`, event: "room:state(sync)", args: [] });
  }
  replaceSession() {}

  events(name: string): SentEvent[] {
    return this.sent.filter((e) => e.event === name);
  }
  clear() {
    this.sent = [];
  }
}

/** Builds a room with N connected players directly in memory. */
export function buildRoom(usernames: string[] = ["alice", "bob"]): { room: Room; players: Player[] } {
  const players = usernames.map((name, i) => createPlayer(name, `socket-${i}`));
  const room = createRoom("TESTROOM", players[0]!, { maxPlayers: 8, totalRounds: 2, turnDurationMs: 80_000 });
  for (const p of players.slice(1)) room.players.set(p.id, p);
  return { room, players };
}

/** Puts a room into a live turn without running the game engine. */
export function forceTurn(room: Room, drawerId: string, word = "apple"): void {
  const now = Date.now();
  room.game.phase = "playing";
  room.game.round = 1;
  room.game.turnSeq += 1;
  room.game.turn = {
    seq: room.game.turnSeq,
    drawerId,
    word,
    startedAt: now,
    endsAt: now + room.settings.turnDurationMs,
    durationMs: room.settings.turnDurationMs,
    correctGuesses: new Map(),
  };
}
