import type { AppConfig } from "../config/env.js";
import type { Broadcaster } from "../socket/broadcaster.js";
import { createPlayer, createRoom } from "../store/room.factory.js";
import type { RoomStore } from "../store/room.store.js";
import type { Player, PlayerId, Room } from "../types/game.types.js";
import type { JoinRoomResult } from "../types/socket.types.js";
import { GameError } from "./errors.js";
import { toPublicPlayer, toRoomView } from "./views.js";

/**
 * Callbacks the room service fires so the game engine can react to roster
 * changes (e.g. the drawer leaving). This is dependency inversion: the room
 * service doesn't import the game service, so there's no circular dependency.
 */
export interface GameHooks {
  onPlayerJoined(room: Room, player: Player): void;
  onPlayerDisconnected(room: Room, player: Player): void;
  onPlayerReconnected(room: Room, player: Player): void;
  /** Called after the player has been removed from room.players. */
  onPlayerRemoved(room: Room, player: Player): void;
}

export const noopGameHooks: GameHooks = {
  onPlayerJoined() {},
  onPlayerDisconnected() {},
  onPlayerReconnected() {},
  onPlayerRemoved() {},
};

export interface CreateRoomInput {
  username: string;
  settings?: { rounds?: number; turnDurationSeconds?: number; maxPlayers?: number } | undefined;
}

export interface JoinRoomInput {
  roomCode: string;
  username: string;
  sessionToken?: string | undefined;
}

export type RemovalReason = "left" | "timeout";

export class RoomService {
  private gameHooks: GameHooks = noopGameHooks;

  constructor(
    private readonly store: RoomStore,
    private readonly config: AppConfig,
    private readonly broadcaster: Broadcaster,
  ) {}

  /** Wired after construction because the game service is built after this one. */
  setGameHooks(hooks: GameHooks): void {
    this.gameHooks = hooks;
  }

  createRoom(socketId: string, input: CreateRoomInput): { room: Room; player: Player } {
    const host = createPlayer(input.username, socketId);
    const settings = {
      visibility: "private" as const,
      // A client may lower the cap, never raise it above the server's limit.
      maxPlayers: Math.min(input.settings?.maxPlayers ?? this.config.maxPlayersPerRoom, this.config.maxPlayersPerRoom),
      totalRounds: input.settings?.rounds ?? this.config.defaultRounds,
      turnDurationMs: input.settings?.turnDurationSeconds
        ? input.settings.turnDurationSeconds * 1000
        : this.config.turnDurationMs,
    };
    const room = createRoom(this.store.generateUniqueCode(), host, settings);
    this.store.add(room);
    this.broadcaster.syncRoomState(room);
    return { room, player: host };
  }

  /**
   * Joins a room as a new player, or resumes an existing seat when a valid
   * session token for THIS room is supplied (reconnect).
   */
  joinRoom(socketId: string, input: JoinRoomInput): { room: Room; player: Player; reconnected: boolean } {
    const room = this.store.get(input.roomCode);
    if (!room) throw new GameError("ROOM_NOT_FOUND", "Room not found. Check the invite code.");

    if (input.sessionToken) {
      const session = this.store.findBySession(input.sessionToken);
      // A token for a different room is simply ignored, so the player joins fresh.
      if (session && session.room === room) {
        this.reconnect(room, session.player, socketId);
        return { room, player: session.player, reconnected: true };
      }
    }

    // Disconnected players still hold their seat during the grace period.
    if (room.players.size >= room.settings.maxPlayers) {
      throw new GameError("ROOM_FULL", "This room is full.");
    }
    let username = input.username;
    if (this.isUsernameTaken(room, username)) {
      // Friends can pick another name; strangers in a public room just get "ashu2".
      if (room.settings.visibility === "private") {
        throw new GameError("USERNAME_TAKEN", "That username is already taken in this room.");
      }
      username = this.uniqueUsername(room, username);
    }
    const player = this.addPlayer(room, socketId, username);
    return { room, player, reconnected: false };
  }

  /**
   * "Play with anyone": put the player straight into the busiest public room
   * that has a free seat, or open a new public room if none does.
   *
   * Preferring the BUSIEST room (not a random one) concentrates players, so
   * games fill up instead of everyone waiting alone in separate rooms.
   *
   * CONCURRENCY: synchronous, like everything else in the services. Two people
   * pressing Play at the same instant are handled one after the other, so the
   * seat check and the seat assignment can't interleave and overfill a room.
   */
  quickJoin(socketId: string, requestedName: string): { room: Room; player: Player } {
    const room = this.findPublicRoomWithSpace();
    if (!room) {
      const host = createPlayer(requestedName, socketId);
      const settings = {
        visibility: "public" as const,
        maxPlayers: this.config.maxPlayersPerRoom,
        totalRounds: this.config.defaultRounds,
        turnDurationMs: this.config.turnDurationMs,
      };
      const created = createRoom(this.store.generateUniqueCode(), host, settings);
      this.store.add(created);
      this.broadcaster.syncRoomState(created);
      return { room: created, player: host };
    }
    const player = this.addPlayer(room, socketId, this.uniqueUsername(room, requestedName));
    return { room, player };
  }

  /** Public, not full, and with at least one person actually online. Busiest first, then oldest. */
  private findPublicRoomWithSpace(): Room | null {
    let best: Room | null = null;
    let bestOnline = 0;
    for (const room of this.store.values()) {
      if (room.settings.visibility !== "public") continue;
      if (room.players.size >= room.settings.maxPlayers) continue;
      const online = [...room.players.values()].filter((p) => p.socketId !== null).length;
      if (online === 0) continue; // everyone's disconnected: likely about to be cleaned up
      if (!best || online > bestOnline || (online === bestOnline && room.createdAt < best.createdAt)) {
        best = room;
        bestOnline = online;
      }
    }
    return best;
  }

  /** Shared by join and quick-join: seat a new player and tell everyone. */
  private addPlayer(room: Room, socketId: string, username: string): Player {
    const player = createPlayer(username, socketId);
    room.players.set(player.id, player);
    this.store.addSession(player, room.code);
    this.cancelEmptyRoomCleanup(room);

    this.broadcaster.toRoomExcept(room.code, player, "player:joined", { player: toPublicPlayer(room, player) });
    this.gameHooks.onPlayerJoined(room, player);
    this.broadcaster.syncRoomState(room);
    return player;
  }

  private isUsernameTaken(room: Room, username: string): boolean {
    const wanted = username.toLowerCase();
    for (const existing of room.players.values()) {
      if (existing.username.toLowerCase() === wanted) return true;
    }
    return false;
  }

  /** "ashu" → "ashu2" → "ashu3"…, staying within the 20-character limit. */
  private uniqueUsername(room: Room, username: string): string {
    if (!this.isUsernameTaken(room, username)) return username;
    for (let n = 2; ; n++) {
      const suffix = String(n);
      const candidate = username.slice(0, 20 - suffix.length) + suffix;
      if (!this.isUsernameTaken(room, candidate)) return candidate;
    }
  }

  private reconnect(room: Room, player: Player, socketId: string): void {
    const previousSocketId = player.socketId;
    // Same session, new connection (e.g. a second tab): the newest connection wins.
    if (previousSocketId && previousSocketId !== socketId) {
      this.broadcaster.replaceSession(previousSocketId, room.code);
    }

    const removalTimer = room.timers.playerRemoval.get(player.id);
    if (removalTimer) {
      clearTimeout(removalTimer);
      room.timers.playerRemoval.delete(player.id);
    }

    const wasDisconnected = previousSocketId === null;
    player.socketId = socketId;
    player.disconnectedAt = null;
    this.cancelEmptyRoomCleanup(room);

    if (wasDisconnected) {
      this.broadcaster.toRoomExcept(room.code, player, "player:reconnected", { playerId: player.id });
      this.gameHooks.onPlayerReconnected(room, player);
    }
    this.broadcaster.syncRoomState(room);
  }

  /**
   * A socket dropped. The player keeps their seat (and score) for the grace
   * period, then gets removed permanently.
   */
  handleDisconnect(room: Room, player: Player, socketId: string): void {
    // Stale-socket guard: if the player has already moved to a newer socket,
    // the old socket's disconnect must not affect them.
    if (player.socketId !== socketId) return;

    player.socketId = null;
    player.disconnectedAt = Date.now();
    this.broadcaster.toRoom(room.code, "player:disconnected", { playerId: player.id });
    this.gameHooks.onPlayerDisconnected(room, player);
    this.broadcaster.syncRoomState(room);

    if (this.config.reconnectGraceMs === 0) {
      this.removePlayer(room, player.id, "timeout");
      return;
    }
    const timer = setTimeout(() => {
      room.timers.playerRemoval.delete(player.id);
      // Re-check: the room may have been deleted, or the player may be back.
      if (this.store.get(room.code) !== room || player.socketId !== null) return;
      this.removePlayer(room, player.id, "timeout");
    }, this.config.reconnectGraceMs);
    room.timers.playerRemoval.set(player.id, timer);

    this.scheduleEmptyRoomCleanupIfNeeded(room);
  }

  leaveRoom(room: Room, player: Player): void {
    this.removePlayer(room, player.id, "left");
  }

  /** Permanently removes a player. Reassigns host and deletes empty rooms. */
  removePlayer(room: Room, playerId: PlayerId, reason: RemovalReason): void {
    const player = room.players.get(playerId);
    if (!player) return; // already removed: makes double-removal harmless

    const removalTimer = room.timers.playerRemoval.get(playerId);
    if (removalTimer) clearTimeout(removalTimer);
    room.timers.playerRemoval.delete(playerId);

    room.players.delete(playerId);
    this.store.removeSession(player.sessionToken);

    if (room.players.size === 0) {
      this.store.delete(room.code);
      return;
    }

    let newHostId: PlayerId | null = null;
    if (room.hostId === playerId) {
      newHostId = this.pickNextHost(room);
      room.hostId = newHostId;
    }

    this.broadcaster.toRoom(room.code, "player:left", { playerId, reason, newHostId });
    this.gameHooks.onPlayerRemoved(room, player);
    this.broadcaster.syncRoomState(room);
    this.scheduleEmptyRoomCleanupIfNeeded(room);
  }

  buildJoinResult(room: Room, player: Player, reconnected: boolean): JoinRoomResult {
    return {
      playerId: player.id,
      sessionToken: player.sessionToken,
      state: toRoomView(room, player.id),
      reconnected,
    };
  }

  /** Prefer the longest-standing connected player. Map order is join order. */
  private pickNextHost(room: Room): PlayerId {
    const players = [...room.players.values()];
    const next = players.find((p) => p.socketId !== null) ?? players[0];
    if (!next) throw new Error("pickNextHost called on an empty room");
    return next.id;
  }

  private hasConnectedPlayers(room: Room): boolean {
    for (const p of room.players.values()) if (p.socketId !== null) return true;
    return false;
  }

  /** A room where nobody is connected is abandoned; delete it after a TTL. */
  private scheduleEmptyRoomCleanupIfNeeded(room: Room): void {
    if (this.hasConnectedPlayers(room) || room.timers.emptyRoom) return;
    room.timers.emptyRoom = setTimeout(() => {
      room.timers.emptyRoom = null;
      if (this.store.get(room.code) === room && !this.hasConnectedPlayers(room)) {
        this.store.delete(room.code);
      }
    }, this.config.emptyRoomTtlMs);
  }

  private cancelEmptyRoomCleanup(room: Room): void {
    if (room.timers.emptyRoom) {
      clearTimeout(room.timers.emptyRoom);
      room.timers.emptyRoom = null;
    }
  }
}
