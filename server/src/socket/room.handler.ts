import { GameError } from "../services/errors.js";
import { logger } from "../utils/logger.js";
import type { Room } from "../types/game.types.js";
import { createRoomSchema, joinRoomSchema } from "../validation/schemas.js";
import type { ConnectionContext } from "./context.js";
import { bindSocketToRoom, enforceRateLimit, parsePayload, requirePlayer, respond, unbindSocket } from "./handler-utils.js";

export function registerRoomHandlers(ctx: ConnectionContext): void {
  const { socket, store, roomService } = ctx;

  /** After joining, send the canvas and chat history so the client can catch up. */
  const sendCatchUp = (room: Room) => {
    socket.emit("draw:sync", { strokes: room.strokes });
    socket.emit("chat:history", { messages: room.chat });
  };

  socket.on("room:create", (payload, ack) => {
    const result = respond(ack, () => {
      enforceRateLimit(ctx.socketRateLimits, "room");
      if (socket.data.roomCode) throw new GameError("ALREADY_IN_ROOM", "Leave your current room first.");
      const input = parsePayload(createRoomSchema, payload);
      const { room, player } = roomService.createRoom(socket.id, input);
      bindSocketToRoom(socket, room, player);
      return roomService.buildJoinResult(room, player, false);
    });
    if (result) logger.info(`[room] created ${result.state.code}`);
  });

  socket.on("room:join", (payload, ack) => {
    let joinedRoom: Room | undefined;
    respond(ack, () => {
      enforceRateLimit(ctx.socketRateLimits, "room");
      if (socket.data.roomCode) throw new GameError("ALREADY_IN_ROOM", "Leave your current room first.");
      const input = parsePayload(joinRoomSchema, payload);
      const { room, player, reconnected } = roomService.joinRoom(socket.id, input);
      bindSocketToRoom(socket, room, player);
      joinedRoom = room;
      return roomService.buildJoinResult(room, player, reconnected);
    });
    // Sent after the ack, so the client already knows it joined.
    if (joinedRoom) sendCatchUp(joinedRoom);
  });

  socket.on("room:leave", (ack) => {
    respond(ack, () => {
      const { room, player } = requirePlayer(socket, store);
      unbindSocket(socket);
      roomService.leaveRoom(room, player);
      return undefined;
    });
  });

  socket.on("disconnect", () => {
    const { roomCode, playerId } = socket.data;
    if (!roomCode || !playerId) return;
    const room = store.get(roomCode);
    const player = room?.players.get(playerId);
    if (room && player) roomService.handleDisconnect(room, player, socket.id);
  });
}
