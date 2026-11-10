import type { Player, Room } from "../types/game.types.js";
import type { PublicPlayer, PublicTurn, RoomStateView } from "../types/socket.types.js";

/**
 * Mappers from internal models → public views.
 *
 * SECURITY: these are the ONLY functions that decide what clients see.
 * Every field is copied explicitly. Never spread (`...player`) an internal object.
 */

/** "ice cream" → "___ _____". Letters are hidden; spaces/hyphens are shown. */
export function buildHint(word: string): string {
  return word.replace(/[\p{L}\p{N}]/gu, "_");
}

export function toPublicPlayer(room: Room, player: Player): PublicPlayer {
  const turn = room.game.turn;
  return {
    id: player.id,
    username: player.username,
    score: player.score,
    isHost: room.hostId === player.id,
    isConnected: player.socketId !== null,
    isDrawing: turn?.drawerId === player.id,
    hasGuessed: turn?.correctGuesses.has(player.id) ?? false,
  };
}

export function toPublicTurn(room: Room, viewerId: string, now = Date.now()): PublicTurn | null {
  const turn = room.game.turn;
  if (!turn) return null;
  const view: PublicTurn = {
    drawerId: turn.drawerId,
    wordLength: turn.word.length,
    hint: buildHint(turn.word),
    endsAt: turn.endsAt,
    remainingMs: Math.max(0, turn.endsAt - now),
  };
  // Only the drawer learns the word while the turn is live.
  if (viewerId === turn.drawerId) view.word = turn.word;
  return view;
}

export function toRoomView(room: Room, viewerId: string, now = Date.now()): RoomStateView {
  return {
    code: room.code,
    hostId: room.hostId,
    selfId: viewerId,
    visibility: room.settings.visibility,
    phase: room.game.phase,
    round: room.game.round,
    totalRounds: room.game.totalRounds,
    settings: {
      maxPlayers: room.settings.maxPlayers,
      turnDurationSeconds: Math.round(room.settings.turnDurationMs / 1000),
    },
    players: [...room.players.values()].map((p) => toPublicPlayer(room, p)),
    turn: toPublicTurn(room, viewerId, now),
  };
}
