import type { RateLimitBucket } from "../utils/rate-limiter.js";

/**
 * INTERNAL server-side models. These contain secrets (session tokens, the
 * current word) and must NEVER be sent to clients directly. Clients only ever
 * receive the "view" types from socket.types.ts, built by explicit mapper
 * functions. That way a new field can't leak by accident.
 */

export type PlayerId = string;
export type RoomCode = string;

export type GamePhase = "waiting" | "starting" | "playing" | "between_turns" | "finished";

export interface Player {
  /** Public ID, visible to everyone in the room. */
  id: PlayerId;
  /** SECRET. Proves identity across reconnects. Only the owner ever sees it. */
  sessionToken: string;
  username: string;
  score: number;
  /** null while disconnected. A player's identity is NOT their socket. */
  socketId: string | null;
  joinedAt: number;
  disconnectedAt: number | null;
  rateLimits: Map<string, RateLimitBucket>;
}

export interface Point {
  /** Normalized 0..1 (fraction of canvas width), so all screen sizes agree. */
  x: number;
  /** Normalized 0..1 (fraction of canvas height). */
  y: number;
}

export interface Stroke {
  id: string;
  color: string;
  size: number;
  points: Point[];
  complete: boolean;
}

export interface CorrectGuess {
  playerId: PlayerId;
  points: number;
  guessedAt: number;
}

export type TurnEndReason = "time_up" | "all_guessed" | "drawer_left" | "not_enough_players";

export interface Turn {
  /**
   * Monotonic turn number for this room. Timer callbacks capture it and bail
   * out if it changed, so a stale timer can never end the wrong turn.
   */
  seq: number;
  drawerId: PlayerId;
  /** SECRET until the turn ends. */
  word: string;
  startedAt: number;
  endsAt: number;
  durationMs: number;
  /** Map preserves insertion order = order of correct guesses. */
  correctGuesses: Map<PlayerId, CorrectGuess>;
}

export interface TurnScore {
  playerId: PlayerId;
  username: string;
  pointsGained: number;
  totalScore: number;
}

export interface TurnResult {
  word: string;
  reason: TurnEndReason;
  drawerId: PlayerId;
  scores: TurnScore[];
}

export interface GameState {
  phase: GamePhase;
  totalRounds: number;
  /** 1-based while a game runs; 0 before the first round. */
  round: number;
  /** Players still due to draw in the current round (in order). */
  drawQueue: PlayerId[];
  turn: Turn | null;
  turnSeq: number;
  usedWords: Set<string>;
  lastTurnResult: TurnResult | null;
}

/**
 * private: invite-only, host starts the game (friends).
 * public: anyone can be matched in via "Play"; games start and restart on their own.
 */
export type RoomVisibility = "public" | "private";

export interface RoomSettings {
  visibility: RoomVisibility;
  maxPlayers: number;
  totalRounds: number;
  turnDurationMs: number;
}

export interface ChatMessage {
  id: string;
  type: "chat" | "system";
  /** null for system messages. */
  senderId: PlayerId | null;
  username: string | null;
  content: string;
  timestamp: number;
}

/**
 * All timers belonging to a room live here, so deleting a room can clear
 * every one of them. A forgotten timer is both a memory leak and a source
 * of "ghost" events firing into a room that no longer exists.
 */
export interface RoomTimers {
  /** Drives phase transitions: starting → playing → between_turns → ... */
  phase: NodeJS.Timeout | null;
  /** 1-second game:timer broadcasts during a turn. */
  tick: NodeJS.Timeout | null;
  /** Deletes the room after it has been empty for a while. */
  emptyRoom: NodeJS.Timeout | null;
  /** Per-player grace-period timers for disconnected players. */
  playerRemoval: Map<PlayerId, NodeJS.Timeout>;
}

export interface Room {
  code: RoomCode;
  hostId: PlayerId;
  /** Map preserves join order, which we use for turn order and host succession. */
  players: Map<PlayerId, Player>;
  settings: RoomSettings;
  game: GameState;
  /** Bounded drawing history for canvas recovery. */
  strokes: Stroke[];
  strokePointCount: number;
  /** Bounded recent chat history. */
  chat: ChatMessage[];
  createdAt: number;
  timers: RoomTimers;
}
