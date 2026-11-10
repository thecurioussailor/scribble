import { z } from "zod";
import { LIMITS } from "../config/limits.js";
import { ROOM_CODE_PATTERN } from "../utils/ids.js";

/**
 * Zod schemas for every piece of untrusted client input.
 * The TypeScript payload types in socket.types.ts are inferred from these,
 * so validation and types can never drift apart.
 */

// Removes control characters (newlines, null bytes) and bidi-override characters
// that can visually reverse text to spoof other players. Emoji are kept intact.
const stripControlChars = (value: string) =>
  value.replace(/[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu, "");

export const usernameSchema = z
  .string()
  .transform(stripControlChars)
  .pipe(
    z
      .string()
      .trim()
      .min(1, "Username is required")
      .max(LIMITS.usernameMaxLength, `Username must be at most ${LIMITS.usernameMaxLength} characters`)
      .regex(/^[\p{L}\p{N} _.\-]+$/u, "Username may only contain letters, numbers, spaces, _ . -"),
  );

export const roomCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(ROOM_CODE_PATTERN, "Invalid room code");

export const sessionTokenSchema = z.string().min(20).max(100).regex(/^[A-Za-z0-9_-]+$/);

export const createRoomSchema = z.object({
  username: usernameSchema,
  settings: z
    .object({
      rounds: z.number().int().min(1).max(LIMITS.maxRounds),
      turnDurationSeconds: z.number().int().min(20).max(240),
      maxPlayers: z.number().int().min(LIMITS.minPlayersToStart).max(20),
    })
    .partial()
    .optional(),
});

export const joinRoomSchema = z.object({
  roomCode: roomCodeSchema,
  username: usernameSchema,
  /** Present when the client is resuming a previous session (reconnect). */
  sessionToken: sessionTokenSchema.optional(),
});

/** "Play with anyone": only a name is needed; the server picks the room. */
export const quickJoinSchema = z.object({ username: usernameSchema });

export const startGameSchema = z
  .object({
    rounds: z.number().int().min(1).max(LIMITS.maxRounds).optional(),
  })
  .optional();

// --- Drawing ---
const normalizedCoord = z.number().finite().min(0).max(1);
export const pointSchema = z.object({ x: normalizedCoord, y: normalizedCoord });
export const strokeIdSchema = z.string().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/);

export const drawStartSchema = z.object({
  strokeId: strokeIdSchema,
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Color must be #RRGGBB"),
  size: z.number().int().min(LIMITS.brushMinSize).max(LIMITS.brushMaxSize),
  point: pointSchema,
});

export const drawMoveSchema = z.object({
  strokeId: strokeIdSchema,
  points: z.array(pointSchema).min(1).max(LIMITS.pointsPerMoveEvent),
});

export const drawEndSchema = z.object({ strokeId: strokeIdSchema });

// --- Chat & guessing ---
export const chatSendSchema = z.object({
  content: z
    .string()
    .transform(stripControlChars)
    .pipe(z.string().trim().min(1, "Message is empty").max(LIMITS.chatMessageMaxLength)),
});

export const guessSubmitSchema = z.object({
  text: z
    .string()
    .transform(stripControlChars)
    .pipe(z.string().trim().min(1, "Guess is empty").max(LIMITS.guessMaxLength)),
});

// --- HTTP: voice ---
export const voiceTokenRequestSchema = z.object({ roomCode: roomCodeSchema });

export type CreateRoomPayload = z.input<typeof createRoomSchema>;
export type JoinRoomPayload = z.input<typeof joinRoomSchema>;
export type QuickJoinPayload = z.input<typeof quickJoinSchema>;
export type StartGamePayload = z.input<typeof startGameSchema>;
export type DrawStartPayload = z.input<typeof drawStartSchema>;
export type DrawMovePayload = z.input<typeof drawMoveSchema>;
export type DrawEndPayload = z.input<typeof drawEndSchema>;
export type ChatSendPayload = z.input<typeof chatSendSchema>;
export type GuessSubmitPayload = z.input<typeof guessSubmitSchema>;
