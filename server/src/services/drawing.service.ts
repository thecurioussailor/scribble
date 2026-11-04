import { LIMITS } from "../config/limits.js";
import type { Broadcaster } from "../socket/broadcaster.js";
import type { Player, Point, Room, Stroke } from "../types/game.types.js";
import { GameError } from "./errors.js";

export interface StrokeStartInput {
  strokeId: string;
  color: string;
  size: number;
  point: Point;
}

/**
 * Drawing is sent as small vector events, not images:
 *   draw:start (color, size, first point) → draw:move (batches of points)… → draw:end
 *
 * The server keeps every stroke of the current turn so a player who joins or
 * reconnects mid-turn can rebuild the canvas from `draw:sync`.
 *
 * The drawer renders their own strokes locally, so we broadcast to everyone
 * EXCEPT the drawer. Echoing back would double the traffic for no benefit.
 */
export class DrawingService {
  constructor(private readonly broadcaster: Broadcaster) {}

  /** Authorization: only the current drawer, only while a turn is live. */
  assertIsDrawer(room: Room, player: Player): void {
    if (room.game.phase !== "playing" || room.game.turn?.drawerId !== player.id) {
      throw new GameError("NOT_DRAWER", "Only the current drawer can draw.");
    }
  }

  startStroke(room: Room, player: Player, input: StrokeStartInput): void {
    this.assertIsDrawer(room, player);
    if (room.strokes.some((s) => s.id === input.strokeId)) {
      throw new GameError("INVALID_PAYLOAD", "Duplicate stroke id.");
    }
    this.assertHistoryHasRoom(room, 1);

    // If the previous stroke never got its draw:end (e.g. a lost packet), close it.
    const previous = room.strokes.at(-1);
    if (previous) previous.complete = true;

    room.strokes.push({
      id: input.strokeId,
      color: input.color,
      size: input.size,
      points: [input.point],
      complete: false,
    });
    room.strokePointCount += 1;
    this.broadcaster.toRoomExcept(room.code, player, "draw:start", {
      strokeId: input.strokeId,
      color: input.color,
      size: input.size,
      point: input.point,
    });
  }

  addPoints(room: Room, player: Player, strokeId: string, points: Point[]): void {
    this.assertIsDrawer(room, player);
    const stroke = this.getActiveStroke(room, strokeId);
    if (stroke.points.length + points.length > LIMITS.pointsPerStroke) {
      throw new GameError("INVALID_STATE", "Stroke is too long. Start a new one.");
    }
    this.assertHistoryHasRoom(room, points.length);

    stroke.points.push(...points);
    room.strokePointCount += points.length;
    this.broadcaster.toRoomExcept(room.code, player, "draw:move", { strokeId, points });
  }

  endStroke(room: Room, player: Player, strokeId: string): void {
    this.assertIsDrawer(room, player);
    const stroke = this.getActiveStroke(room, strokeId);
    stroke.complete = true;
    this.broadcaster.toRoomExcept(room.code, player, "draw:end", { strokeId });
  }

  undo(room: Room, player: Player): void {
    this.assertIsDrawer(room, player);
    const removed = room.strokes.pop();
    if (!removed) return; // nothing to undo; not an error
    room.strokePointCount -= removed.points.length;
    this.broadcaster.toRoomExcept(room.code, player, "draw:undo", { strokeId: removed.id });
  }

  clear(room: Room, player: Player): void {
    this.assertIsDrawer(room, player);
    this.resetCanvas(room);
  }

  /** Used by the game engine between turns. Broadcasts to everyone, drawer included. */
  resetCanvas(room: Room): void {
    room.strokes = [];
    room.strokePointCount = 0;
    this.broadcaster.toRoom(room.code, "draw:clear");
  }

  /** Only the most recent, unfinished stroke can receive points. */
  private getActiveStroke(room: Room, strokeId: string): Stroke {
    const stroke = room.strokes.at(-1);
    if (!stroke || stroke.id !== strokeId || stroke.complete) {
      throw new GameError("INVALID_STATE", "That stroke is not active.");
    }
    return stroke;
  }

  /**
   * We REJECT new points when the history is full instead of dropping old
   * strokes. Dropping would make a reconnecting player's canvas differ from
   * everyone else's. The drawer can clear or undo to free space.
   */
  private assertHistoryHasRoom(room: Room, additionalPoints: number): void {
    if (room.strokePointCount + additionalPoints > LIMITS.historyMaxPoints) {
      throw new GameError("INVALID_STATE", "The canvas is full. Clear or undo to keep drawing.");
    }
  }
}
