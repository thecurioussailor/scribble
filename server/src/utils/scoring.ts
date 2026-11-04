/**
 * Pure scoring functions: no I/O, no clock, no randomness.
 * Everything they need is passed in, so they're trivial to unit test.
 */

export const SCORING = {
  /** Points for a correct guess at the very last moment. */
  guesserMinPoints: 100,
  /** Extra points for guessing instantly (scaled by time remaining). */
  guesserTimeBonus: 400,
  /** Bonus for being first; each later guesser gets `orderBonusStep` less. */
  firstGuessBonus: 50,
  orderBonusStep: 10,
  /** Drawer earns up to this many points when everyone guesses. */
  drawerMaxPoints: 400,
} as const;

export interface GuesserScoreInput {
  remainingMs: number;
  durationMs: number;
  /** 0 for the first correct guesser, 1 for the second, ... */
  guessOrder: number;
}

/** 100–550 points: faster and earlier guesses earn more. */
export function calculateGuesserPoints({ remainingMs, durationMs, guessOrder }: GuesserScoreInput): number {
  const timeFraction = durationMs > 0 ? clamp(remainingMs / durationMs, 0, 1) : 0;
  const timePoints = Math.round(SCORING.guesserTimeBonus * timeFraction);
  const orderBonus = Math.max(0, SCORING.firstGuessBonus - guessOrder * SCORING.orderBonusStep);
  return SCORING.guesserMinPoints + timePoints + orderBonus;
}

export interface DrawerScoreInput {
  correctGuessCount: number;
  /** Players who could have guessed this turn (everyone except the drawer). */
  eligibleGuesserCount: number;
}

/** The drawer is rewarded for the share of players who understood the drawing. */
export function calculateDrawerPoints({ correctGuessCount, eligibleGuesserCount }: DrawerScoreInput): number {
  if (eligibleGuesserCount <= 0 || correctGuessCount <= 0) return 0;
  const fraction = clamp(correctGuessCount / eligibleGuesserCount, 0, 1);
  return Math.round(SCORING.drawerMaxPoints * fraction);
}

export interface RankablePlayer {
  playerId: string;
  username: string;
  score: number;
}

/** Highest score first; ties share a rank ("1, 1, 3" competition ranking). */
export function rankPlayers<T extends RankablePlayer>(players: T[]): (T & { rank: number })[] {
  const sorted = [...players].sort((a, b) => b.score - a.score || a.username.localeCompare(b.username));
  return sorted.map((player, index) => {
    const firstWithSameScore = sorted.findIndex((p) => p.score === player.score);
    return { ...player, rank: (firstWithSameScore === -1 ? index : firstWithSameScore) + 1 };
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
