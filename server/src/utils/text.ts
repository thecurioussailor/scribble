/**
 * Normalizes free text for comparison so that guesses match fairly:
 *   "  Ice-Cream! " → "ice cream"
 *   "CAFÉ"          → "cafe"
 *
 * Steps: Unicode compatibility form (full-width letters → normal), strip
 * accents, lower-case, treat any run of non-alphanumerics as one space, trim.
 */
export function normalizeText(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/\p{M}/gu, "") // combining marks (accents)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Same as normalizeText but with all spaces removed: "i c e cream" → "icecream". */
export function compactText(input: string): string {
  return normalizeText(input).replace(/ /g, "");
}

/** Classic dynamic-programming edit distance, capped for speed. */
export function levenshtein(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > max) return max + 1; // early exit: can't get closer
    previous = current;
  }
  return previous[b.length]!;
}
