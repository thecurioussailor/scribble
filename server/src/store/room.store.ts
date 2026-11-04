import type { Player, PlayerId, Room, RoomCode } from "../types/game.types.js";
import { generateRoomCode } from "../utils/ids.js";

interface SessionEntry {
  roomCode: RoomCode;
  playerId: PlayerId;
}

/** Cancels every timer a room owns. Safe to call more than once. */
export function clearRoomTimers(room: Room): void {
  const { timers } = room;
  if (timers.phase) clearTimeout(timers.phase);
  if (timers.tick) clearInterval(timers.tick);
  if (timers.emptyRoom) clearTimeout(timers.emptyRoom);
  for (const timer of timers.playerRemoval.values()) clearTimeout(timer);
  timers.phase = null;
  timers.tick = null;
  timers.emptyRoom = null;
  timers.playerRemoval.clear();
}

/**
 * In-memory storage for all rooms plus a session-token index.
 *
 * The store only stores. Game rules live in the services. Swapping this class
 * for a Redis-backed one later is how you'd scale beyond a single instance.
 */
export class RoomStore {
  private readonly rooms = new Map<RoomCode, Room>();
  /** sessionToken → where that player lives. Enables O(1) auth for HTTP and reconnects. */
  private readonly sessions = new Map<string, SessionEntry>();

  get size(): number {
    return this.rooms.size;
  }

  /** Generates a code that isn't in use. Collisions are astronomically rare, but we still check. */
  generateUniqueCode(): RoomCode {
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = generateRoomCode();
      if (!this.rooms.has(code)) return code;
    }
    throw new Error("Could not generate a unique room code");
  }

  add(room: Room): void {
    if (this.rooms.has(room.code)) throw new Error(`Room ${room.code} already exists`);
    this.rooms.set(room.code, room);
    for (const player of room.players.values()) this.addSession(player, room.code);
  }

  get(code: RoomCode): Room | undefined {
    return this.rooms.get(code);
  }

  /** Removes a room, all its timers, and all its sessions. */
  delete(code: RoomCode): boolean {
    const room = this.rooms.get(code);
    if (!room) return false;
    clearRoomTimers(room);
    for (const player of room.players.values()) this.sessions.delete(player.sessionToken);
    this.rooms.delete(code);
    return true;
  }

  addSession(player: Player, roomCode: RoomCode): void {
    this.sessions.set(player.sessionToken, { roomCode, playerId: player.id });
  }

  removeSession(sessionToken: string): void {
    this.sessions.delete(sessionToken);
  }

  /** Resolves a session token to its live room + player, or null if stale. */
  findBySession(sessionToken: string): { room: Room; player: Player } | null {
    const entry = this.sessions.get(sessionToken);
    if (!entry) return null;
    const room = this.rooms.get(entry.roomCode);
    const player = room?.players.get(entry.playerId);
    if (!room || !player) {
      this.sessions.delete(sessionToken); // self-heal a dangling index entry
      return null;
    }
    return { room, player };
  }

  values(): IterableIterator<Room> {
    return this.rooms.values();
  }

  /** Used on shutdown: clears every timer so the process can exit. */
  clear(): void {
    for (const code of [...this.rooms.keys()]) this.delete(code);
  }
}
