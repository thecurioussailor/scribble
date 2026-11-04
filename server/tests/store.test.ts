import { describe, expect, it, vi } from "vitest";
import { createPlayer, createRoom } from "../src/store/room.factory.js";
import { RoomStore } from "../src/store/room.store.js";
import { ROOM_CODE_PATTERN } from "../src/utils/ids.js";

const settings = { maxPlayers: 8, totalRounds: 3, turnDurationMs: 80_000 };

function makeRoom(store: RoomStore) {
  const host = createPlayer("alice", "socket-1");
  const room = createRoom(store.generateUniqueCode(), host, settings);
  store.add(room);
  return { room, host };
}

describe("RoomStore", () => {
  it("generates readable, unambiguous room codes", () => {
    const store = new RoomStore();
    const codes = new Set(Array.from({ length: 500 }, () => store.generateUniqueCode()));
    expect(codes.size).toBe(500);
    for (const code of codes) expect(code).toMatch(ROOM_CODE_PATTERN);
  });

  it("indexes players by session token", () => {
    const store = new RoomStore();
    const { room, host } = makeRoom(store);
    expect(store.findBySession(host.sessionToken)).toEqual({ room, player: host });
    expect(store.findBySession("unknown-token-xxxxxxxxxxxx")).toBeNull();
  });

  it("session tokens and player IDs are distinct and unguessable", () => {
    const a = createPlayer("a", null);
    const b = createPlayer("b", null);
    expect(a.sessionToken).not.toBe(b.sessionToken);
    expect(a.sessionToken).not.toBe(a.id);
    expect(a.sessionToken.length).toBeGreaterThanOrEqual(43);
  });

  it("delete() removes sessions and clears every timer", () => {
    vi.useFakeTimers();
    const store = new RoomStore();
    const { room, host } = makeRoom(store);
    const fired = vi.fn();
    room.timers.phase = setTimeout(fired, 1000);
    room.timers.tick = setInterval(fired, 100);
    room.timers.playerRemoval.set(host.id, setTimeout(fired, 1000));

    expect(store.delete(room.code)).toBe(true);
    vi.advanceTimersByTime(5000);

    expect(fired).not.toHaveBeenCalled();
    expect(store.get(room.code)).toBeUndefined();
    expect(store.findBySession(host.sessionToken)).toBeNull();
    vi.useRealTimers();
  });
});
