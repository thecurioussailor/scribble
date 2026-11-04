import type { GameState, Player, Room, RoomCode, RoomSettings } from "../types/game.types.js";
import { generateId, generateSessionToken } from "../utils/ids.js";

export function createPlayer(username: string, socketId: string | null, now = Date.now()): Player {
  return {
    id: generateId(),
    sessionToken: generateSessionToken(),
    username,
    score: 0,
    socketId,
    joinedAt: now,
    disconnectedAt: null,
    rateLimits: new Map(),
  };
}

export function createInitialGameState(totalRounds: number): GameState {
  return {
    phase: "waiting",
    totalRounds,
    round: 0,
    drawQueue: [],
    turn: null,
    turnSeq: 0,
    usedWords: new Set(),
    lastTurnResult: null,
  };
}

export function createRoom(code: RoomCode, host: Player, settings: RoomSettings, now = Date.now()): Room {
  return {
    code,
    hostId: host.id,
    players: new Map([[host.id, host]]),
    settings,
    game: createInitialGameState(settings.totalRounds),
    strokes: [],
    strokePointCount: 0,
    chat: [],
    createdAt: now,
    timers: { phase: null, tick: null, emptyRoom: null, playerRemoval: new Map() },
  };
}
