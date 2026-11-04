"use client";

import { useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};

/**
 * Reads a browser-only value (localStorage, window.location…) without a
 * hydration mismatch: during server rendering and hydration React uses
 * `serverValue`, then immediately re-renders with the real browser value.
 *
 * This is the React-recommended replacement for the old
 * `useEffect(() => setX(readBrowserThing()), [])` pattern.
 */
export function useBrowserValue<T>(read: () => T, serverValue: T): T {
  return useSyncExternalStore(noopSubscribe, read, () => serverValue);
}
