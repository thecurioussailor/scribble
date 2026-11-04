import type { Socket } from "socket.io";
import type { z } from "zod";
import { GameError } from "../services/errors.js";
import type { RoomStore } from "../store/room.store.js";
import type { Player, Room } from "../types/game.types.js";
import type {
  AckResponse,
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from "../types/socket.types.js";
import { logger } from "../utils/logger.js";
import { tryConsume, type RateLimitBucket, type RateLimitCategory } from "../utils/rate-limiter.js";

export type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

/**
 * Runs a handler and turns its outcome into an acknowledgement:
 *  - return value → { ok: true, data }
 *  - GameError    → { ok: false, error } (safe, user-facing message)
 *  - anything else → logged, and a generic INTERNAL_ERROR (never leak internals)
 *
 * Returns the data on success (so callers can do follow-up work), else undefined.
 * `ack` is typed unknown because a malicious client can send anything (or nothing).
 */
export function respond<T>(ack: unknown, handler: () => T, onError?: (error: GameError) => void): T | undefined {
  const reply = typeof ack === "function" ? (ack as (r: AckResponse<T>) => void) : undefined;
  try {
    const data = handler();
    reply?.({ ok: true, data });
    return data;
  } catch (err) {
    if (err instanceof GameError) {
      reply?.({ ok: false, error: { code: err.code, message: err.message } });
      onError?.(err);
    } else {
      logger.error("[socket] unexpected handler error:", err);
      reply?.({ ok: false, error: { code: "INTERNAL_ERROR", message: "Something went wrong" } });
    }
    return undefined;
  }
}

/** Validates untrusted input with Zod, throwing a GameError on failure. */
export function parsePayload<S extends z.ZodType>(schema: S, payload: unknown): z.output<S> {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new GameError("INVALID_PAYLOAD", `${where}${issue?.message ?? "Invalid payload"}`);
  }
  return result.data;
}

export function enforceRateLimit(buckets: Map<string, RateLimitBucket>, category: RateLimitCategory): void {
  if (!tryConsume(buckets, category)) {
    throw new GameError("RATE_LIMITED", "You're doing that too fast. Slow down a little.");
  }
}

/**
 * Resolves the room and player bound to this socket, the membership check
 * every in-room action goes through. The identity comes from socket.data,
 * which only the server sets, never from the client payload.
 */
export function requirePlayer(socket: GameSocket, store: RoomStore): { room: Room; player: Player } {
  const { roomCode, playerId } = socket.data;
  const room = roomCode ? store.get(roomCode) : undefined;
  const player = playerId ? room?.players.get(playerId) : undefined;
  // The last check rejects stale sockets that were replaced by a newer connection.
  if (!room || !player || player.socketId !== socket.id) {
    throw new GameError("NOT_IN_ROOM", "You are not in a room.");
  }
  return { room, player };
}

export function bindSocketToRoom(socket: GameSocket, room: Room, player: Player): void {
  void socket.join(room.code);
  socket.data.roomCode = room.code;
  socket.data.playerId = player.id;
}

export function unbindSocket(socket: GameSocket): void {
  if (socket.data.roomCode) void socket.leave(socket.data.roomCode);
  socket.data = {};
}
