import cors from "cors";
import express, { type ErrorRequestHandler, type Express } from "express";
import type { AppConfig } from "./config/env.js";
import { createVoiceRouter } from "./routes/voice.routes.js";
import type { VoiceService } from "./services/voice.service.js";
import type { RoomStore } from "./store/room.store.js";

export interface AppDeps {
  store: RoomStore;
  voiceService: VoiceService;
}

/**
 * Builds the Express app (plain HTTP routes only).
 * Socket.IO is attached separately to the same HTTP server in server.ts.
 */
export function createApp(config: AppConfig, deps: AppDeps): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(cors({ origin: config.corsOrigins, credentials: true }));
  app.use(express.json({ limit: "10kb" }));

  // Render pings this to decide whether the instance is healthy.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", uptimeSeconds: Math.round(process.uptime()), rooms: deps.store.size });
  });

  app.use("/api/voice", createVoiceRouter(deps.store, deps.voiceService));

  app.use((_req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } });
  });

  // Never leak stack traces or internals to clients.
  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    const status = typeof err?.status === "number" ? err.status : 500;
    if (status >= 500) console.error("[http] unhandled error:", err);
    res.status(status).json({
      error: {
        code: status === 400 ? "BAD_REQUEST" : "INTERNAL_ERROR",
        message: status >= 500 ? "Something went wrong" : String(err.message ?? "Bad request"),
      },
    });
  };
  app.use(errorHandler);

  return app;
}
