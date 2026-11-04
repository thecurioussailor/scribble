import { describe, expect, it } from "vitest";
import { RATE_LIMITS, tryConsume, type RateLimitBucket } from "../src/utils/rate-limiter.js";

describe("tryConsume (token bucket)", () => {
  it("allows a burst up to capacity, then rejects", () => {
    const buckets = new Map<string, RateLimitBucket>();
    const t = 1_000_000;
    const { capacity } = RATE_LIMITS.chat;
    for (let i = 0; i < capacity; i++) expect(tryConsume(buckets, "chat", t)).toBe(true);
    expect(tryConsume(buckets, "chat", t)).toBe(false);
  });

  it("refills over time", () => {
    const buckets = new Map<string, RateLimitBucket>();
    const t = 1_000_000;
    while (tryConsume(buckets, "chat", t));
    // chat refills at 1 token/second
    expect(tryConsume(buckets, "chat", t + 500)).toBe(false);
    expect(tryConsume(buckets, "chat", t + 1_600)).toBe(true);
  });

  it("keeps categories independent", () => {
    const buckets = new Map<string, RateLimitBucket>();
    const t = 1_000_000;
    while (tryConsume(buckets, "chat", t));
    expect(tryConsume(buckets, "draw", t)).toBe(true);
  });
});
