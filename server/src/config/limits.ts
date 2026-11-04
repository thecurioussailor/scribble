/**
 * Hard limits that protect the server from abuse and unbounded memory growth.
 * These are deliberately not env-configurable: they are part of the protocol
 * contract the frontend relies on.
 */
export const LIMITS = {
  usernameMaxLength: 20,
  chatMessageMaxLength: 200,
  guessMaxLength: 60,
  chatHistorySize: 50,

  /** Max points the client may batch into one draw:move event. */
  pointsPerMoveEvent: 64,
  /** Max points in a single stroke (a very long continuous line). */
  pointsPerStroke: 5_000,
  /** Total points kept for canvas recovery; oldest strokes are dropped first. */
  historyMaxPoints: 50_000,
  brushMinSize: 1,
  brushMaxSize: 50,

  /** Max bytes per Socket.IO message (enforced by the transport). */
  maxSocketPayloadBytes: 16 * 1024,

  minPlayersToStart: 2,
  maxRounds: 10,
} as const;
