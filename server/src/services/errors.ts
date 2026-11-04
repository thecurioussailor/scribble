import type { ErrorCode } from "../types/socket.types.js";

/**
 * An expected, client-facing failure (bad input, wrong permissions, etc.).
 * Its message is safe to show to users. Any other thrown error is treated
 * as an internal bug and replaced with a generic message.
 */
export class GameError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GameError";
  }
}
