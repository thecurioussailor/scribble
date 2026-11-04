import { Router, type Request, type Response } from "express";
import { GameError } from "../services/errors.js";
import type { VoiceService } from "../services/voice.service.js";
import type { RoomStore } from "../store/room.store.js";
import type { ErrorCode } from "../types/socket.types.js";
import { tryConsume } from "../utils/rate-limiter.js";
import { sessionTokenSchema, voiceTokenRequestSchema } from "../validation/schemas.js";

const HTTP_STATUS: Partial<Record<ErrorCode, number>> = {
  INVALID_PAYLOAD: 400,
  SESSION_INVALID: 401,
  NOT_IN_ROOM: 403,
  RATE_LIMITED: 429,
  VOICE_NOT_CONFIGURED: 503,
};

function sendError(res: Response, code: ErrorCode, message: string): void {
  res.status(HTTP_STATUS[code] ?? 500).json({ error: { code, message } });
}

/** Reads `Authorization: Bearer <sessionToken>`. */
function readBearerToken(req: Request): string | null {
  const header = req.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) return null;
  const parsed = sessionTokenSchema.safeParse(match[1]);
  return parsed.success ? parsed.data : null;
}

/**
 * Voice routes. Authentication reuses the game session token the client got
 * from room:create / room:join. No separate login exists, and the server
 * never trusts a player ID or room membership claimed in the request.
 */
export function createVoiceRouter(store: RoomStore, voice: VoiceService): Router {
  const router = Router();

  /** Lets the frontend decide whether to show voice controls. */
  router.get("/status", (_req, res) => {
    res.json({ enabled: voice.isConfigured() });
  });

  router.post("/token", async (req, res) => {
    const sessionToken = readBearerToken(req);
    if (!sessionToken) {
      sendError(res, "SESSION_INVALID", "Missing or malformed Authorization header.");
      return;
    }
    const session = store.findBySession(sessionToken);
    if (!session) {
      sendError(res, "SESSION_INVALID", "Session not found. Join a room first.");
      return;
    }

    const body = voiceTokenRequestSchema.safeParse(req.body ?? {});
    if (!body.success) {
      sendError(res, "INVALID_PAYLOAD", "Body must be { roomCode }.");
      return;
    }
    // The session must belong to the room being requested. A valid session
    // for room A can't be used to listen in on room B.
    if (session.room.code !== body.data.roomCode) {
      sendError(res, "NOT_IN_ROOM", "You are not a member of that room.");
      return;
    }
    if (!tryConsume(session.player.rateLimits, "voice")) {
      sendError(res, "RATE_LIMITED", "Too many voice token requests.");
      return;
    }

    try {
      res.json(await voice.createToken(session.room, session.player));
    } catch (err) {
      if (err instanceof GameError) {
        const missing = voice.missingSettings();
        sendError(res, err.code, missing.length ? `${err.message} Missing: ${missing.join(", ")}.` : err.message);
        return;
      }
      throw err; // Express 5 forwards async errors to the error handler
    }
  });

  return router;
}
