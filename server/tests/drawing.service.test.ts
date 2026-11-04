import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/config/limits.js";
import { DrawingService } from "../src/services/drawing.service.js";
import { buildRoom, FakeBroadcaster, forceTurn } from "./fakes.js";

function setup() {
  const broadcaster = new FakeBroadcaster();
  const service = new DrawingService(broadcaster);
  const { room, players } = buildRoom();
  const [drawer, guesser] = players as [typeof players[0], typeof players[0]];
  forceTurn(room, drawer.id);
  return { broadcaster, service, room, drawer, guesser };
}

const batch = (n: number) => Array.from({ length: n }, (_, i) => ({ x: (i % 100) / 100, y: 0.5 }));

describe("DrawingService", () => {
  it("records strokes and broadcasts to everyone except the drawer", () => {
    const { service, room, drawer, broadcaster } = setup();
    service.startStroke(room, drawer, { strokeId: "s1", color: "#000000", size: 4, point: { x: 0, y: 0 } });
    service.addPoints(room, drawer, "s1", batch(10));
    service.endStroke(room, drawer, "s1");

    expect(room.strokes).toHaveLength(1);
    expect(room.strokes[0]).toMatchObject({ id: "s1", complete: true });
    expect(room.strokePointCount).toBe(11);
    expect(broadcaster.sent.map((e) => e.event)).toEqual(["draw:start", "draw:move", "draw:end"]);
    for (const e of broadcaster.sent) expect(e.target).toContain(`except:${drawer.id}`);
  });

  it("rejects drawing from non-drawers and outside a live turn", () => {
    const { service, room, drawer, guesser } = setup();
    const start = { strokeId: "s1", color: "#000000", size: 4, point: { x: 0, y: 0 } };
    expect(() => service.startStroke(room, guesser, start)).toThrow(/Only the current drawer/);
    room.game.phase = "between_turns";
    expect(() => service.startStroke(room, drawer, start)).toThrow(/Only the current drawer/);
  });

  it("undo removes the last stroke and keeps the point count accurate", () => {
    const { service, room, drawer } = setup();
    service.startStroke(room, drawer, { strokeId: "a", color: "#000000", size: 4, point: { x: 0, y: 0 } });
    service.startStroke(room, drawer, { strokeId: "b", color: "#000000", size: 4, point: { x: 0, y: 0 } });
    service.addPoints(room, drawer, "b", batch(5));
    service.undo(room, drawer);
    expect(room.strokes.map((s) => s.id)).toEqual(["a"]);
    expect(room.strokePointCount).toBe(1);
    // Starting stroke b implicitly completed stroke a (its draw:end was "lost").
    expect(room.strokes[0]!.complete).toBe(true);
  });

  it("only the active stroke accepts points", () => {
    const { service, room, drawer } = setup();
    service.startStroke(room, drawer, { strokeId: "a", color: "#000000", size: 4, point: { x: 0, y: 0 } });
    service.endStroke(room, drawer, "a");
    expect(() => service.addPoints(room, drawer, "a", batch(1))).toThrow(/not active/);
    expect(() => service.addPoints(room, drawer, "zzz", batch(1))).toThrow(/not active/);
  });

  it("caps points per stroke", () => {
    const { service, room, drawer } = setup();
    service.startStroke(room, drawer, { strokeId: "s", color: "#000000", size: 4, point: { x: 0, y: 0 } });
    const fullBatches = Math.floor((LIMITS.pointsPerStroke - 1) / LIMITS.pointsPerMoveEvent);
    for (let i = 0; i < fullBatches; i++) service.addPoints(room, drawer, "s", batch(LIMITS.pointsPerMoveEvent));
    expect(() => service.addPoints(room, drawer, "s", batch(LIMITS.pointsPerMoveEvent))).toThrow(/too long/);
  });

  it("bounds total history and rejects (rather than silently dropping) when full", () => {
    const { service, room, drawer } = setup();
    let strokeNo = 0;
    expect(() => {
      // Keep drawing long strokes until the history limit kicks in.
      for (;;) {
        const id = `s${strokeNo++}`;
        service.startStroke(room, drawer, { strokeId: id, color: "#000000", size: 4, point: { x: 0, y: 0 } });
        for (let i = 0; i < 70; i++) service.addPoints(room, drawer, id, batch(LIMITS.pointsPerMoveEvent));
      }
    }).toThrow(/canvas is full/);
    expect(room.strokePointCount).toBeLessThanOrEqual(LIMITS.historyMaxPoints);

    service.clear(room, drawer);
    expect(room.strokes).toEqual([]);
    expect(room.strokePointCount).toBe(0);
  });
});
