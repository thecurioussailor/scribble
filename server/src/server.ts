import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "./app.js";
import type { AppConfig } from "./config/env.js";
import { ChatService } from "./services/chat.service.js";
import { DrawingService } from "./services/drawing.service.js";
import { GameService } from "./services/game.service.js";
import { GuessService } from "./services/guess.service.js";
import { RoomService } from "./services/room.service.js";
import { VoiceService } from "./services/voice.service.js";
import { logger } from "./utils/logger.js";
import { SocketBroadcaster, type Broadcaster, type GameIO } from "./socket/broadcaster.js";
import { createSocketServer, registerSocketHandlers } from "./socket/index.js";
import { RoomStore } from "./store/room.store.js";

export interface GameServer {
  httpServer: HttpServer;
  io: GameIO;
  store: RoomStore;
  broadcaster: Broadcaster;
  roomService: RoomService;
  drawingService: DrawingService;
  chatService: ChatService;
  guessService: GuessService;
  gameService: GameService;
  voiceService: VoiceService;
  /** Starts listening. Use port 0 in tests to get a random free port. */
  listen(port?: number, host?: string): Promise<number>;
  /** Disconnects all sockets, clears every room timer, and stops the HTTP server. */
  close(): Promise<void>;
}

/**
 * Composition root: the single place where every dependency is created and wired.
 * Kept separate from index.ts so tests can spin up isolated servers.
 */
export function createGameServer(config: AppConfig): GameServer {
  const store = new RoomStore();
  const voiceService = new VoiceService(config.livekit);
  const app = createApp(config, { store, voiceService });
  const httpServer = createServer(app);
  const io = createSocketServer(httpServer, config.corsOrigins);
  const broadcaster = new SocketBroadcaster(io);
  const roomService = new RoomService(store, config, broadcaster);
  const drawingService = new DrawingService(broadcaster);
  const chatService = new ChatService(broadcaster);
  const guessService = new GuessService(broadcaster, chatService);
  const gameService = new GameService(store, config, broadcaster, drawingService, chatService);

  // Close the loops without circular imports: room and guess events drive the game.
  roomService.setGameHooks({
    onPlayerJoined: (room, player) => gameService.onPlayerJoined(room, player),
    onPlayerDisconnected: (room) => gameService.onPlayerDisconnected(room),
    onPlayerReconnected: () => gameService.onPlayerReconnected(),
    onPlayerRemoved: (room, player) => {
      gameService.onPlayerRemoved(room, player);
      voiceService.removeParticipant(room.code, player.id);
    },
  });
  guessService.setCorrectGuessHandler((room) => gameService.checkAllGuessed(room));

  const missingVoice = voiceService.missingSettings();
  if (missingVoice.length > 0 && missingVoice.length < 3) {
    logger.warn(`[voice] LiveKit is partially configured; voice is disabled. Missing: ${missingVoice.join(", ")}`);
  } else if (missingVoice.length === 3) {
    logger.info("[voice] LiveKit not configured; voice chat disabled (the game works without it).");
  }

  registerSocketHandlers(io, {
    config,
    store,
    broadcaster,
    roomService,
    drawingService,
    chatService,
    guessService,
    gameService,
  });

  return {
    httpServer,
    io,
    store,
    broadcaster,
    roomService,
    drawingService,
    chatService,
    guessService,
    gameService,
    voiceService,
    listen(port = config.port, host = config.host) {
      return new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          httpServer.off("error", reject);
          resolve((httpServer.address() as AddressInfo).port);
        });
      });
    },
    async close() {
      // io.close() disconnects every socket and closes the HTTP server.
      await new Promise<void>((resolve) => io.close(() => resolve()));
      httpServer.closeAllConnections();
      // Disconnects above may have scheduled grace timers; clear everything.
      store.clear();
    },
  };
}
