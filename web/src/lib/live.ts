"use client";

import type {
  ChatMessage,
  LeaderboardEntry,
  Point,
  ServerToClientEvents,
  Stroke,
} from "./protocol";
import type { GameSocket } from "./socket";

/**
 * Live game data that arrives as a STREAM of socket events (strokes, chat,
 * timer ticks…).
 *
 * Why not keep it in React state inside components? Because events can
 * arrive while no component is listening. For example, after a refresh the
 * server sends `draw:sync` right after the join ack, a moment BEFORE the
 * game screen mounts. A component-level listener would miss it and show a
 * blank canvas. These stores are subscribed once, when the socket is created,
 * so nothing is ever missed, and components just read from them.
 */

type Listener = () => void;

/** A tiny observable value that works with React's useSyncExternalStore. */
function createValueStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      listeners.forEach((l) => l());
    },
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// ─────────────────────────────── Strokes ───────────────────────────────

/**
 * Tells the canvas how much to repaint: "append" draws only the new points
 * (cheap, happens ~30×/s while drawing); "full" repaints everything (undo,
 * clear, sync, resize).
 */
export type CanvasChange = { kind: "full" } | { kind: "append"; stroke: Stroke; fromIndex: number };

class StrokeStore {
  strokes: Stroke[] = [];
  private listeners = new Set<(change: CanvasChange) => void>();

  subscribe(listener: (change: CanvasChange) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(change: CanvasChange) {
    this.listeners.forEach((l) => l(change));
  }

  start(stroke: { strokeId: string; color: string; size: number; point: Point }) {
    const previous = this.strokes.at(-1);
    if (previous) previous.complete = true;
    const created: Stroke = { id: stroke.strokeId, color: stroke.color, size: stroke.size, points: [stroke.point], complete: false };
    this.strokes.push(created);
    this.emit({ kind: "append", stroke: created, fromIndex: 0 });
  }

  move(strokeId: string, points: Point[]) {
    const stroke = this.strokes.at(-1);
    if (!stroke || stroke.id !== strokeId) return;
    const fromIndex = stroke.points.length;
    stroke.points.push(...points);
    this.emit({ kind: "append", stroke, fromIndex });
  }

  end(strokeId: string) {
    const stroke = this.strokes.find((s) => s.id === strokeId);
    if (stroke) stroke.complete = true;
  }

  /** Remote undo names the stroke; local undo removes the last one. */
  undo(strokeId?: string) {
    if (strokeId) this.strokes = this.strokes.filter((s) => s.id !== strokeId);
    else this.strokes.pop();
    this.emit({ kind: "full" });
  }

  clear() {
    this.strokes = [];
    this.emit({ kind: "full" });
  }

  replaceAll(strokes: Stroke[]) {
    // Copy so later local mutations never touch the event payload.
    this.strokes = strokes.map((s) => ({ ...s, points: [...s.points] }));
    this.emit({ kind: "full" });
  }
}

export const strokeStore = new StrokeStore();

// ──────────────────────────────── Feed ─────────────────────────────────

export type FeedItem =
  | { id: string; kind: "chat"; senderId: string | null; username: string; text: string }
  | { id: string; kind: "system"; text: string }
  | { id: string; kind: "guess"; senderId: string; username: string; text: string }
  | { id: string; kind: "note"; text: string };

const FEED_LIMIT = 120;
export const feedStore = createValueStore<FeedItem[]>([]);

function fromChat(message: ChatMessage): FeedItem {
  return message.type === "system"
    ? { id: message.id, kind: "system", text: message.content }
    : { id: message.id, kind: "chat", senderId: message.senderId, username: message.username ?? "?", text: message.content };
}

let localId = 0;
/** Appends an item (new array each time, so React sees the change). */
export function pushFeed(item: FeedItem | Omit<Extract<FeedItem, { kind: "note" }>, "id">) {
  const withId = ("id" in item ? item : { ...item, id: `local-${++localId}` }) as FeedItem;
  feedStore.set([...feedStore.get(), withId].slice(-FEED_LIMIT));
}

// ──────────────────────────── Turn & game ──────────────────────────────

/**
 * When the current turn ends, in THIS browser's clock.
 *
 * The server sends `endsAt` in ITS clock, but the player's computer clock can
 * be seconds off. So we use the server's `remainingMs` ("41 s left") and add
 * it to our own Date.now() when the message arrives. Clock skew can't
 * distort the countdown, and each `game:timer` tick corrects drift.
 */
export const deadlineStore = createValueStore<number | null>(null);

export type TurnEnded = Parameters<ServerToClientEvents["game:turn-ended"]>[0];
export const turnEndedStore = createValueStore<TurnEnded | null>(null);
export const leaderboardStore = createValueStore<LeaderboardEntry[] | null>(null);

// ──────────────────────────── Wiring ───────────────────────────────────

/** Called exactly once, when the shared socket is created. */
export function attachLiveListeners(socket: GameSocket) {
  socket.on("draw:start", (e) => strokeStore.start(e));
  socket.on("draw:move", (e) => strokeStore.move(e.strokeId, e.points));
  socket.on("draw:end", (e) => strokeStore.end(e.strokeId));
  socket.on("draw:undo", (e) => strokeStore.undo(e.strokeId));
  socket.on("draw:clear", () => strokeStore.clear());
  socket.on("draw:sync", (e) => strokeStore.replaceAll(e.strokes));

  socket.on("chat:history", ({ messages }) => feedStore.set(messages.map(fromChat)));
  socket.on("chat:message", (message) => pushFeed(fromChat(message)));
  socket.on("guess:result", (result) => {
    // Correct guesses are announced by the server's system message instead,
    // which also lands in chat history for players who reconnect.
    if (!result.correct) {
      pushFeed({ id: `g-${Date.now()}-${result.playerId}`, kind: "guess", senderId: result.playerId, username: result.username, text: result.text });
    }
  });

  socket.on("room:state", (state) => {
    deadlineStore.set(state.turn && state.phase === "playing" ? Date.now() + state.turn.remainingMs : null);
  });
  socket.on("game:timer", ({ remainingMs }) => deadlineStore.set(Date.now() + remainingMs));
  socket.on("game:started", () => {
    turnEndedStore.set(null);
    leaderboardStore.set(null);
  });
  socket.on("game:turn-started", ({ turn }) => {
    turnEndedStore.set(null);
    deadlineStore.set(Date.now() + turn.remainingMs);
  });
  socket.on("game:turn-ended", (result) => {
    turnEndedStore.set(result);
    deadlineStore.set(null);
  });
  socket.on("game:finished", ({ leaderboard }) => {
    leaderboardStore.set(leaderboard);
    deadlineStore.set(null);
  });
}
