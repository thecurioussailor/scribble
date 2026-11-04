import type {
  ChatSendPayload,
  CreateRoomPayload,
  DrawEndPayload,
  DrawMovePayload,
  DrawStartPayload,
  GuessSubmitPayload,
  JoinRoomPayload,
  StartGamePayload,
} from "../validation/schemas.js";
import type {
  ChatMessage,
  GamePhase,
  PlayerId,
  Point,
  RoomCode,
  Stroke,
  TurnEndReason,
  TurnScore,
} from "./game.types.js";

/**
 * The Socket.IO event contract. Socket.IO's generics use these interfaces to
 * type-check every `socket.on` / `socket.emit` on the server, and the
 * frontend can import the same file to get the same guarantees.
 */

// ---------- Acknowledgements ----------

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
  | "INTERNAL_ERROR";

export interface AckError {
  code: ErrorCode;
  message: string;
}

export type AckResponse<T = undefined> = { ok: true; data: T } | { ok: false; error: AckError };
export type Ack<T = undefined> = (response: AckResponse<T>) => void;

// ---------- Public views (safe to send) ----------

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
  /** Only present for the drawer (and for everyone after the turn ends). */
  word?: string;
  wordLength: number;
  /** e.g. "_ _ _ _   _ _ _" (spaces in multi-word phrases are revealed). */
  hint: string;
  endsAt: number;
  remainingMs: number;
}

/** Personalized per recipient. The drawer sees the word, guessers don't. */
export interface RoomStateView {
  code: RoomCode;
  hostId: PlayerId;
  /** The ID of the player receiving this view. */
  selfId: PlayerId;
  phase: GamePhase;
  round: number;
  totalRounds: number;
  settings: { maxPlayers: number; turnDurationSeconds: number };
  players: PublicPlayer[];
  turn: PublicTurn | null;
}

export interface LeaderboardEntry {
  playerId: PlayerId;
  username: string;
  score: number;
  rank: number;
}

export interface JoinRoomResult {
  playerId: PlayerId;
  /** Store this (e.g. sessionStorage) and send it back to rejoin after a disconnect. */
  sessionToken: string;
  state: RoomStateView;
  reconnected: boolean;
}

// ---------- Client → Server ----------

export interface ClientToServerEvents {
  "room:create": (payload: CreateRoomPayload, ack: Ack<JoinRoomResult>) => void;
  "room:join": (payload: JoinRoomPayload, ack: Ack<JoinRoomResult>) => void;
  "room:leave": (ack?: Ack) => void;

  "game:start": (payload: StartGamePayload, ack: Ack) => void;

  // Drawing events are high-frequency: ack is optional (use it for debugging).
  "draw:start": (payload: DrawStartPayload, ack?: Ack) => void;
  "draw:move": (payload: DrawMovePayload, ack?: Ack) => void;
  "draw:end": (payload: DrawEndPayload, ack?: Ack) => void;
  "draw:clear": (ack?: Ack) => void;
  "draw:undo": (ack?: Ack) => void;

  "chat:send": (payload: ChatSendPayload, ack: Ack<ChatMessage>) => void;
  "guess:submit": (payload: GuessSubmitPayload, ack: Ack<GuessAck>) => void;
}

export interface GuessAck {
  correct: boolean;
  /** True when the guess is one letter away. Only ever told to the guesser. */
  close: boolean;
  pointsAwarded: number;
}

// ---------- Server → Client ----------

export interface ServerToClientEvents {
  "room:state": (state: RoomStateView) => void;

  "player:joined": (payload: { player: PublicPlayer }) => void;
  "player:left": (payload: { playerId: PlayerId; reason: "left" | "timeout"; newHostId: PlayerId | null }) => void;
  "player:disconnected": (payload: { playerId: PlayerId }) => void;
  "player:reconnected": (payload: { playerId: PlayerId }) => void;

  "game:started": (payload: { totalRounds: number; startsAt: number }) => void;
  "game:turn-started": (payload: {
    round: number;
    totalRounds: number;
    turn: PublicTurn;
  }) => void;
  "game:timer": (payload: { remainingMs: number; endsAt: number }) => void;
  "game:turn-ended": (payload: {
    word: string;
    reason: TurnEndReason;
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
  /** Full canvas history, sent on join/reconnect so late arrivals see the drawing. */
  "draw:sync": (payload: { strokes: Stroke[] }) => void;

  "chat:message": (message: ChatMessage) => void;
  "chat:history": (payload: { messages: ChatMessage[] }) => void;

  "guess:result": (
    payload:
      | { playerId: PlayerId; username: string; correct: true; pointsAwarded: number }
      | { playerId: PlayerId; username: string; correct: false; text: string },
  ) => void;

  /** Sent to an old socket when the same session connects elsewhere (e.g. a second tab). */
  "session:replaced": () => void;
  "server:error": (error: AckError) => void;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface InterServerEvents {}

/** Per-socket server-side data. Set only by the server after a successful join. */
export interface SocketData {
  roomCode?: RoomCode;
  playerId?: PlayerId;
}
