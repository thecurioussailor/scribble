import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { LIMITS } from "../config/limits.js";
import type { GameIO } from "./broadcaster.js";
import type { HandlerContext } from "./context.js";
import { registerChatHandlers } from "./chat.handler.js";
import { registerGameHandlers } from "./game.handler.js";
import { registerDrawingHandlers } from "./drawing.handler.js";
import { registerRoomHandlers } from "./room.handler.js";

export function createSocketServer(httpServer: HttpServer, corsOrigins: string[]): GameIO {
  return new Server(httpServer, {
    cors: { origin: corsOrigins, credentials: true },
    // Rejects oversized messages at the transport layer before any parsing.
    maxHttpBufferSize: LIMITS.maxSocketPayloadBytes,
    // Detect dead connections (closed laptop, lost signal) within ~15s.
    pingInterval: 10_000,
    pingTimeout: 5_000,
  });
}

export function registerSocketHandlers(io: GameIO, deps: HandlerContext): void {
  io.on("connection", (socket) => {
    const ctx = { ...deps, socket, socketRateLimits: new Map() };
    registerRoomHandlers(ctx);
    registerDrawingHandlers(ctx);
    registerChatHandlers(ctx);
    registerGameHandlers(ctx);
  });
}
