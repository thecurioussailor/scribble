import { describe, expect, it } from "vitest";
import { calculateDrawerPoints, calculateGuesserPoints, rankPlayers, SCORING } from "../src/utils/scoring.js";
import { compactText, levenshtein, normalizeText } from "../src/utils/text.js";

describe("normalizeText", () => {
  it.each([
    ["  Apple ", "apple"],
    ["APPLE", "apple"],
    ["ice-cream", "ice cream"],
    ["Ice   Cream!!", "ice cream"],
    ["Café", "cafe"],
    ["ＡＰＰＬＥ", "apple"], // full-width letters
  ])("%j → %j", (input, expected) => {
    expect(normalizeText(input)).toBe(expected);
  });

  it("compactText removes spaces", () => {
    expect(compactText("a p p l e")).toBe("apple");
  });
});

describe("levenshtein", () => {
  it("measures edit distance", () => {
    expect(levenshtein("apple", "apple")).toBe(0);
    expect(levenshtein("apple", "appel")).toBe(2);
    expect(levenshtein("apple", "aple")).toBe(1);
    expect(levenshtein("apple", "zzzzzzzzzz", 1)).toBe(2); // capped
  });
});

describe("calculateGuesserPoints", () => {
  const durationMs = 80_000;

  it("rewards speed", () => {
    const fast = calculateGuesserPoints({ remainingMs: 75_000, durationMs, guessOrder: 1 });
    const slow = calculateGuesserPoints({ remainingMs: 5_000, durationMs, guessOrder: 1 });
    expect(fast).toBeGreaterThan(slow);
  });

  it("rewards guessing first", () => {
    const first = calculateGuesserPoints({ remainingMs: 40_000, durationMs, guessOrder: 0 });
    const second = calculateGuesserPoints({ remainingMs: 40_000, durationMs, guessOrder: 1 });
    expect(first - second).toBe(SCORING.orderBonusStep);
  });

  it("has fixed bounds", () => {
    expect(calculateGuesserPoints({ remainingMs: durationMs, durationMs, guessOrder: 0 })).toBe(550);
    expect(calculateGuesserPoints({ remainingMs: 0, durationMs, guessOrder: 99 })).toBe(SCORING.guesserMinPoints);
    // Defensive: bad inputs never produce negative or NaN scores.
    expect(calculateGuesserPoints({ remainingMs: -5, durationMs: 0, guessOrder: 0 })).toBe(150);
  });
});

describe("calculateDrawerPoints", () => {
  it("scales with the share of players who guessed", () => {
    expect(calculateDrawerPoints({ correctGuessCount: 0, eligibleGuesserCount: 3 })).toBe(0);
    expect(calculateDrawerPoints({ correctGuessCount: 3, eligibleGuesserCount: 3 })).toBe(SCORING.drawerMaxPoints);
    expect(calculateDrawerPoints({ correctGuessCount: 1, eligibleGuesserCount: 2 })).toBe(SCORING.drawerMaxPoints / 2);
    expect(calculateDrawerPoints({ correctGuessCount: 1, eligibleGuesserCount: 0 })).toBe(0);
  });
});

describe("rankPlayers", () => {
  it("sorts by score and gives ties the same rank", () => {
    const ranked = rankPlayers([
      { playerId: "a", username: "a", score: 100 },
      { playerId: "b", username: "b", score: 300 },
      { playerId: "c", username: "c", score: 100 },
    ]);
    expect(ranked.map((p) => [p.playerId, p.rank])).toEqual([
      ["b", 1],
      ["a", 2],
      ["c", 2],
    ]);
  });
});
