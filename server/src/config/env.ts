import { existsSync } from "node:fs";
import { z } from "zod";

// Load .env in local development without needing the dotenv package.
// On Render, variables come from the dashboard, so the file won't exist.
if (existsSync(".env") && process.env.NODE_ENV !== "test") {
  process.loadEnvFile(".env");
}

/** Treats empty strings (e.g. `LIVEKIT_URL=`) as "not set". */
const optionalString = z
  .string()
  .trim()
  .transform((value) => (value === "" ? undefined : value))
  .optional();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  HOST: z.string().default("0.0.0.0"),
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:3000")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim().replace(/\/$/, ""))
        .filter(Boolean),
    ),

  MAX_PLAYERS_PER_ROOM: z.coerce.number().int().min(2).max(20).default(8),
  DEFAULT_ROUNDS: z.coerce.number().int().min(1).max(10).default(3),
  TURN_DURATION_SECONDS: z.coerce.number().int().min(10).max(300).default(80),
  RECONNECT_GRACE_SECONDS: z.coerce.number().int().min(0).max(600).default(30),
  EMPTY_ROOM_TTL_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),

  LIVEKIT_URL: optionalString,
  LIVEKIT_API_KEY: optionalString,
  LIVEKIT_API_SECRET: optionalString,
  LIVEKIT_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(600),
});

export type Env = z.infer<typeof envSchema>;

/** Game/server settings derived from env. Passed explicitly so tests can override them. */
export interface AppConfig {
  nodeEnv: Env["NODE_ENV"];
  port: number;
  host: string;
  corsOrigins: string[];
  maxPlayersPerRoom: number;
  defaultRounds: number;
  turnDurationMs: number;
  reconnectGraceMs: number;
  emptyRoomTtlMs: number;
  /** Countdown after the host presses Start. */
  startCountdownMs: number;
  /** Pause between turns so players can see the scores. */
  betweenTurnsMs: number;
  /** Public rooms: how long the final scores stay up before the next game starts. */
  publicRestartDelayMs: number;
  livekit: {
    url: string | undefined;
    apiKey: string | undefined;
    apiSecret: string | undefined;
    tokenTtlSeconds: number;
  };
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    // Fail fast at boot: a misconfigured server is worse than one that won't start.
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    host: env.HOST,
    corsOrigins: env.CORS_ORIGINS,
    maxPlayersPerRoom: env.MAX_PLAYERS_PER_ROOM,
    defaultRounds: env.DEFAULT_ROUNDS,
    turnDurationMs: env.TURN_DURATION_SECONDS * 1000,
    reconnectGraceMs: env.RECONNECT_GRACE_SECONDS * 1000,
    emptyRoomTtlMs: env.EMPTY_ROOM_TTL_SECONDS * 1000,
    startCountdownMs: 3_000,
    betweenTurnsMs: 5_000,
    publicRestartDelayMs: 12_000,
    livekit: {
      url: env.LIVEKIT_URL,
      apiKey: env.LIVEKIT_API_KEY,
      apiSecret: env.LIVEKIT_API_SECRET,
      tokenTtlSeconds: env.LIVEKIT_TOKEN_TTL_SECONDS,
    },
  };
}

/** Builds a config for tests: defaults + overrides, without reading process.env. */
export function createTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...loadConfig({ NODE_ENV: "test" }), ...overrides };
}
