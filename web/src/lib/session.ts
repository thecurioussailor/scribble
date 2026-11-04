/**
 * Browser storage helpers. Every access is wrapped in try/catch because
 * storage can throw (private browsing, blocked cookies, quota).
 *
 * - The SESSION (secret token) goes in sessionStorage: one session per tab,
 *   so two tabs don't fight over the same seat, and it's gone when the tab closes.
 * - The NAME goes in localStorage: a convenience that pre-fills the field next time.
 */

export interface StoredSession {
  sessionToken: string;
  playerId: string;
  username: string;
}

const sessionKey = (code: string) => `scribble:session:${code.toUpperCase()}`;
const NAME_KEY = "scribble:name";

export function saveSession(code: string, session: StoredSession): void {
  try {
    sessionStorage.setItem(sessionKey(code), JSON.stringify(session));
  } catch {
    /* storage unavailable: reconnect after refresh won't work, the game still does */
  }
}

export function loadSession(code: string): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(sessionKey(code));
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

export function clearSession(code: string): void {
  try {
    sessionStorage.removeItem(sessionKey(code));
  } catch {
    /* ignore */
  }
}

export function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* ignore */
  }
}

export function loadName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Mirrors the server's username rules. Returns an error message, or null if valid. */
export function validateName(raw: string): string | null {
  const name = raw.trim();
  if (!name) return "Enter a name so your friends know who's drawing.";
  if (name.length > 20) return "Keep your name to 20 characters or fewer.";
  if (!/^[\p{L}\p{N} _.\-]+$/u.test(name)) return "Use letters, numbers, spaces, or _ . - in your name.";
  return null;
}
