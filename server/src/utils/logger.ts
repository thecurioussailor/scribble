/**
 * Minimal logger. Silent during tests to keep output readable.
 * Rule: never log secret words or session tokens.
 */
const silent = process.env.NODE_ENV === "test" || process.env.VITEST !== undefined;

export const logger = {
  info: (...args: unknown[]) => {
    if (!silent) console.log(...args);
  },
  warn: (...args: unknown[]) => {
    if (!silent) console.warn(...args);
  },
  error: (...args: unknown[]) => console.error(...args),
};
