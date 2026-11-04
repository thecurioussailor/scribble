/**
 * Client copy of the server's Socket.IO contract (server/src/types/socket.types.ts).
 *
 * Keep the two in sync by hand for now. When the project grows, move the
 * contract into a shared package (e.g. an npm workspace) so both sides import
 * one file and the compiler catches any drift.
 */

export type PlayerId = string;
export type GamePhase = "waiting" | "starting" | "playing" | "between_turns" | "finished";

export type ErrorCode =
  | "INVALID_PAYLOAD"
  | "RATE_LIMITED"
  | "ROOM_NOT_FOUND"
  | "ROOM_FULL"
  | "USERNAME_TAKEN"
  | "ALREADY_IN_ROOM"
  | "NOT_IN_ROOM"
  | "NOT_HOST"
  | "NOT_DRAWER"
  | "INVALID_STATE"
  | "NOT_ENOUGH_PLAYERS"
  | "GAME_IN_PROGRESS"
  | "ALREADY_GUESSED"
  | "SESSION_INVALID"
  | "VOICE_NOT_CONFIGURED"
  | "INTERNAL_ERROR"
  // Client-only: the server didn't answer in time.
  | "TIMEOUT";

export interface AckError {
  code: ErrorCode;
  message: string;
}
export type AckResponse<T = undefined> = { ok: true; data: T } | { ok: false; error: AckError };
type Ack<T = undefined> = (response: AckResponse<T>) => void;

export interface Point {
  x: number;
  y: number;
}
export interface Stroke {
  id: string;
  color: string;
  size: number;
  points: Point[];
  complete: boolean;
}
export interface ChatMessage {
  id: string;
  type: "chat" | "system";
  senderId: PlayerId | null;
  username: string | null;
  content: string;
  timestamp: number;
}

export interface PublicPlayer {
  id: PlayerId;
  username: string;
  score: number;
  isHost: boolean;
  isConnected: boolean;
  isDrawing: boolean;
  hasGuessed: boolean;
}

export interface PublicTurn {
  drawerId: PlayerId;
  word?: string;
  wordLength: number;
  hint: string;
  endsAt: number;
  remainingMs: number;
}

export interface RoomStateView {
  code: string;
  hostId: PlayerId;
  selfId: PlayerId;
  phase: GamePhase;
  round: number;
  totalRounds: number;
  settings: { maxPlayers: number; turnDurationSeconds: number };
  players: PublicPlayer[];
  turn: PublicTurn | null;
}

export interface JoinRoomResult {
  playerId: PlayerId;
  sessionToken: string;
  state: RoomStateView;
  reconnected: boolean;
}

export interface TurnScore {
  playerId: PlayerId;
  username: string;
  pointsGained: number;
  totalScore: number;
}
export interface LeaderboardEntry {
  playerId: PlayerId;
  username: string;
  score: number;
  rank: number;
}
export interface GuessAck {
  correct: boolean;
  close: boolean;
  pointsAwarded: number;
}

export interface ClientToServerEvents {
  "room:create": (
    payload: { username: string; settings?: { rounds?: number; turnDurationSeconds?: number; maxPlayers?: number } },
    ack: Ack<JoinRoomResult>,
  ) => void;
  "room:join": (payload: { roomCode: string; username: string; sessionToken?: string }, ack: Ack<JoinRoomResult>) => void;
  "room:leave": (ack?: Ack) => void;
  "game:start": (payload: { rounds?: number }, ack: Ack) => void;
  "draw:start": (payload: { strokeId: string; color: string; size: number; point: Point }, ack?: Ack) => void;
  "draw:move": (payload: { strokeId: string; points: Point[] }, ack?: Ack) => void;
  "draw:end": (payload: { strokeId: string }, ack?: Ack) => void;
  "draw:clear": (ack?: Ack) => void;
  "draw:undo": (ack?: Ack) => void;
  "chat:send": (payload: { content: string }, ack: Ack<ChatMessage>) => void;
  "guess:submit": (payload: { text: string }, ack: Ack<GuessAck>) => void;
}

export interface ServerToClientEvents {
  "room:state": (state: RoomStateView) => void;
  "player:joined": (payload: { player: PublicPlayer }) => void;
  "player:left": (payload: { playerId: PlayerId; reason: "left" | "timeout"; newHostId: PlayerId | null }) => void;
  "player:disconnected": (payload: { playerId: PlayerId }) => void;
  "player:reconnected": (payload: { playerId: PlayerId }) => void;
  "game:started": (payload: { totalRounds: number; startsAt: number }) => void;
  "game:turn-started": (payload: { round: number; totalRounds: number; turn: PublicTurn }) => void;
  "game:timer": (payload: { remainingMs: number; endsAt: number }) => void;
  "game:turn-ended": (payload: {
    word: string;
    reason: "time_up" | "all_guessed" | "drawer_left" | "not_enough_players";
    drawerId: PlayerId;
    scores: TurnScore[];
    nextTurnAt: number | null;
  }) => void;
  "game:finished": (payload: { leaderboard: LeaderboardEntry[] }) => void;
  "draw:start": (payload: { strokeId: string; color: string; size: number; point: Point }) => void;
  "draw:move": (payload: { strokeId: string; points: Point[] }) => void;
  "draw:end": (payload: { strokeId: string }) => void;
  "draw:clear": () => void;
  "draw:undo": (payload: { strokeId: string }) => void;
  "draw:sync": (payload: { strokes: Stroke[] }) => void;
  "chat:message": (message: ChatMessage) => void;
  "chat:history": (payload: { messages: ChatMessage[] }) => void;
  "guess:result": (
    payload:
      | { playerId: PlayerId; username: string; correct: true; pointsAwarded: number }
      | { playerId: PlayerId; username: string; correct: false; text: string },
  ) => void;
  "session:replaced": () => void;
  "server:error": (error: AckError) => void;
}

/** Same rules as the server's Zod schemas, so users see problems before sending. */
export const USERNAME_MAX = 20;
export const USERNAME_PATTERN = /^[\p{L}\p{N} _.\-]+$/u;
export const ROOM_CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;
