import { randomBytes, randomInt } from "node:crypto";

/**
 * Invite-code alphabet without look-alike characters (0/O, 1/I/L), so codes
 * are easy to read aloud. 31^8 ≈ 8.5 × 10^11 possible codes: not guessable
 * by brute force at any rate our limits allow.
 */
const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LENGTH = 8;

/** Uses crypto.randomInt (CSPRNG), never Math.random, for anything security-relevant. */
export function generateRoomCode(): string {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

export const ROOM_CODE_PATTERN = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

/** Secret bearer token proving "I am this player". 256 bits of entropy. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Public, non-secret identifier (player IDs, message IDs). */
export function generateId(): string {
  return randomBytes(9).toString("base64url");
}
