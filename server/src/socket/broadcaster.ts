import type { Server } from "socket.io";
import { toRoomView } from "../services/views.js";
import type { Player, Room } from "../types/game.types.js";
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from "../types/socket.types.js";

export type GameIO = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

type ServerEvent = keyof ServerToClientEvents;
type ServerEventArgs<E extends ServerEvent> = Parameters<ServerToClientEvents[E]>;

/**
 * The only way services talk to clients.
 *
 * Services depend on this interface, not on Socket.IO. That keeps game rules
 * testable with a fake broadcaster (no network), and gives one place to
 * audit what leaves the server.
 */
export interface Broadcaster {
  /** Everyone in the room. */
  toRoom<E extends ServerEvent>(roomCode: string, event: E, ...args: ServerEventArgs<E>): void;
  /** Everyone in the room except one player. */
  toRoomExcept<E extends ServerEvent>(
    roomCode: string,
    except: Player,
    event: E,
    ...args: ServerEventArgs<E>
  ): void;
  /** A single player (no-op if they're disconnected). */
  toPlayer<E extends ServerEvent>(player: Player, event: E, ...args: ServerEventArgs<E>): void;
  /** Sends every connected player their personalized room:state. */
  syncRoomState(room: Room): void;
  /** Kicks an old socket whose session was taken over by a new connection. */
  replaceSession(oldSocketId: string, roomCode: string): void;
}

interface LooseEmitter {
  emit(event: string, ...args: unknown[]): boolean;
}

export class SocketBroadcaster implements Broadcaster {
  constructor(private readonly io: GameIO) {}

  // Socket.IO's emit types can't follow our generic spread, so we narrow via LooseEmitter.
  // Type safety is still enforced at the call sites through the generic signatures above.
  toRoom<E extends ServerEvent>(roomCode: string, event: E, ...args: ServerEventArgs<E>): void {
    (this.io.to(roomCode) as unknown as LooseEmitter).emit(event, ...args);
  }

  toRoomExcept<E extends ServerEvent>(roomCode: string, except: Player, event: E, ...args: ServerEventArgs<E>): void {
    const target = except.socketId ? this.io.to(roomCode).except(except.socketId) : this.io.to(roomCode);
    (target as unknown as LooseEmitter).emit(event, ...args);
  }

  toPlayer<E extends ServerEvent>(player: Player, event: E, ...args: ServerEventArgs<E>): void {
    if (!player.socketId) return;
    (this.io.to(player.socketId) as unknown as LooseEmitter).emit(event, ...args);
  }

  syncRoomState(room: Room): void {
    // One emit per player because the view is personalized (the drawer sees the word).
    const now = Date.now();
    for (const player of room.players.values()) {
      if (player.socketId) this.io.to(player.socketId).emit("room:state", toRoomView(room, player.id, now));
    }
  }

  replaceSession(oldSocketId: string, roomCode: string): void {
    const oldSocket = this.io.sockets.sockets.get(oldSocketId);
    if (!oldSocket) return;
    oldSocket.emit("session:replaced");
    oldSocket.leave(roomCode);
    // Clear identity first, so the disconnect handler treats it as a stale socket.
    oldSocket.data = {};
    oldSocket.disconnect(true);
  }
}
