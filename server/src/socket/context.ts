import type { AppConfig } from "../config/env.js";
import type { ChatService } from "../services/chat.service.js";
import type { GameService } from "../services/game.service.js";
import type { DrawingService } from "../services/drawing.service.js";
import type { GuessService } from "../services/guess.service.js";
import type { RoomService } from "../services/room.service.js";
import type { RoomStore } from "../store/room.store.js";
import type { RateLimitBucket } from "../utils/rate-limiter.js";
import type { Broadcaster } from "./broadcaster.js";
import type { GameSocket } from "./handler-utils.js";

/** Shared dependencies every handler receives. */
export interface HandlerContext {
  config: AppConfig;
  store: RoomStore;
  broadcaster: Broadcaster;
  roomService: RoomService;
  drawingService: DrawingService;
  chatService: ChatService;
  guessService: GuessService;
  gameService: GameService;
}

/** Per-connection state. */
export interface ConnectionContext extends HandlerContext {
  socket: GameSocket;
  /** Rate limits for actions taken before the socket has a player identity (create/join). */
  socketRateLimits: Map<string, RateLimitBucket>;
}
