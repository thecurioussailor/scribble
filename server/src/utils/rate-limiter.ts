/**
 * Token-bucket rate limiting.
 *
 * Each player has one bucket per action category. A bucket holds up to
 * `capacity` tokens and refills continuously at `refillPerSecond`. Every action
 * costs one token; with no tokens left, the action is rejected.
 * This allows short bursts (fast scribbling) while capping the sustained rate.
 */
export interface RateLimitRule {
  capacity: number;
  refillPerSecond: number;
}

export interface RateLimitBucket {
  tokens: number;
  lastRefillAt: number;
}

export const RATE_LIMITS = {
  /** Room lifecycle actions: create/join/leave. */
  room: { capacity: 5, refillPerSecond: 0.5 },
  game: { capacity: 3, refillPerSecond: 0.5 },
  /** Clients should batch points ~every 30ms, so ~33 events/s is normal use. */
  draw: { capacity: 120, refillPerSecond: 60 },
  chat: { capacity: 5, refillPerSecond: 1 },
  guess: { capacity: 6, refillPerSecond: 2 },
  /** Voice tokens: a few retries are fine, a token-minting loop is not. */
  voice: { capacity: 5, refillPerSecond: 0.1 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitCategory = keyof typeof RATE_LIMITS;

/** Returns true if the action is allowed (and consumes a token). Pure apart from mutating the bucket map. */
export function tryConsume(
  buckets: Map<string, RateLimitBucket>,
  category: RateLimitCategory,
  now: number = Date.now(),
): boolean {
  const rule = RATE_LIMITS[category];
  let bucket = buckets.get(category);
  if (!bucket) {
    bucket = { tokens: rule.capacity, lastRefillAt: now };
    buckets.set(category, bucket);
  }

  const elapsedSeconds = Math.max(0, now - bucket.lastRefillAt) / 1000;
  bucket.tokens = Math.min(rule.capacity, bucket.tokens + elapsedSeconds * rule.refillPerSecond);
  bucket.lastRefillAt = now;

  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}
