"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { strokeStore } from "@/lib/live";
import type { Point, Stroke } from "@/lib/protocol";
import { getSocket } from "@/lib/socket";

/** Crayon box: the illustration's colours first, then a few extras every drawing game needs. */
const COLORS = [
  { name: "Black", value: "#000000" },
  { name: "Cobalt", value: "#1c38a8" },
  { name: "Tomato", value: "#e44a26" },
  { name: "Sunflower", value: "#f2c230" },
  { name: "Leaf", value: "#2e9e5b" },
  { name: "Sky", value: "#5bb8f0" },
  { name: "Pink", value: "#f29bb2" },
  { name: "Brown", value: "#8b5a2b" },
  { name: "Grey", value: "#9a9a9a" },
] as const;
const ERASER = "#ffffff";
/** Brush sizes in the protocol's abstract units (1–50); scaled to the canvas below. */
const SIZES = [4, 10, 20, 36] as const;

/** Every canvas is drawn as if it were 800 units wide, so a brush looks the same on every screen. */
const REFERENCE_WIDTH = 800;
/** Ignore tiny jitters: points closer than this (in 0–1 units) add bytes but no detail. */
const MIN_POINT_DISTANCE = 0.0015;
const FLUSH_INTERVAL_MS = 30;
const MAX_POINTS_PER_EVENT = 64;

function paintStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, fromIndex: number) {
  const { width, height } = ctx.canvas;
  const lineWidth = (stroke.size * width) / REFERENCE_WIDTH;
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const pts = stroke.points;
  if (pts.length === 1) {
    // A single tap draws a dot.
    ctx.beginPath();
    ctx.arc(pts[0]!.x * width, pts[0]!.y * height, lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  // Start one point back so the new segment connects to the existing line.
  const start = Math.max(0, fromIndex - 1);
  ctx.beginPath();
  ctx.moveTo(pts[start]!.x * width, pts[start]!.y * height);
  for (let i = start + 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x * width, pts[i]!.y * height);
  ctx.stroke();
}

function repaint(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  for (const stroke of strokeStore.strokes) paintStroke(ctx, stroke, 0);
}

let strokeCounter = 0;
const newStrokeId = () => `s${Date.now().toString(36)}${(++strokeCounter).toString(36)}`;

interface ActiveStroke {
  id: string;
  last: Point;
  /** Points drawn locally but not yet sent: flushed every 30 ms as one draw:move. */
  pending: Point[];
  timer: ReturnType<typeof setInterval>;
}

/**
 * The shared canvas.
 *
 * Rendering: everything is drawn from `strokeStore`, whether the stroke came
 * from this player's pointer or from the network. One code path means the
 * drawer and the guessers always see the same picture.
 *
 * Input (drawer only): pointer events → normalized 0–1 points → drawn locally
 * at once (no waiting for the network) → batched and sent every 30 ms.
 */
export function DrawingCanvas({ canDraw, overlay }: { canDraw: boolean; overlay?: React.ReactNode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef<ActiveStroke | null>(null);
  const [color, setColor] = useState<string>(COLORS[0].value);
  const [size, setSize] = useState<number>(SIZES[1]);

  // Keep the canvas pixel-sharp at any size, and repaint when the store changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      repaint(ctx);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const unsubscribe = strokeStore.subscribe((change) => {
      if (change.kind === "full") repaint(ctx);
      else paintStroke(ctx, change.stroke, change.fromIndex);
    });
    return () => {
      observer.disconnect();
      unsubscribe();
    };
  }, []);

  // If the turn ends mid-stroke, stop sending.
  useEffect(() => {
    if (!canDraw && activeRef.current) {
      clearInterval(activeRef.current.timer);
      activeRef.current = null;
    }
  }, [canDraw]);

  function toPoint(event: { clientX: number; clientY: number }): Point {
    const rect = canvasRef.current!.getBoundingClientRect();
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    // Round to 4 decimals: plenty of precision, fewer bytes on the wire.
    const round = (v: number) => Math.round(v * 10_000) / 10_000;
    return { x: round(clamp((event.clientX - rect.left) / rect.width)), y: round(clamp((event.clientY - rect.top) / rect.height)) };
  }

  function flush() {
    const active = activeRef.current;
    if (!active || active.pending.length === 0) return;
    getSocket().emit("draw:move", { strokeId: active.id, points: active.pending.splice(0, MAX_POINTS_PER_EVENT) });
  }

  function onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!canDraw || event.button > 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = toPoint(event);
    const id = newStrokeId();
    strokeStore.start({ strokeId: id, color, size, point });
    getSocket().emit("draw:start", { strokeId: id, color, size, point });
    activeRef.current = { id, last: point, pending: [], timer: setInterval(flush, FLUSH_INTERVAL_MS) };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    const active = activeRef.current;
    if (!active) return;
    // Coalesced events recover the in-between positions the browser merged, for smoother curves.
    const samples = event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent];
    const fresh: Point[] = [];
    for (const sample of samples) {
      const point = toPoint(sample);
      if (Math.hypot(point.x - active.last.x, point.y - active.last.y) < MIN_POINT_DISTANCE) continue;
      fresh.push(point);
      active.last = point;
    }
    if (fresh.length === 0) return;
    strokeStore.move(active.id, fresh);
    active.pending.push(...fresh);
    if (active.pending.length >= MAX_POINTS_PER_EVENT) flush();
  }

  function onPointerUp() {
    const active = activeRef.current;
    if (!active) return;
    clearInterval(active.timer);
    while (active.pending.length) flush();
    getSocket().emit("draw:end", { strokeId: active.id });
    strokeStore.end(active.id);
    activeRef.current = null;
  }

  function undo() {
    strokeStore.undo();
    getSocket().emit("draw:undo");
  }

  function clear() {
    strokeStore.clear();
    getSocket().emit("draw:clear");
  }

  return (
    <div>
      <div className="crayon crayon-coat relative p-[5px]">
        <canvas
          ref={canvasRef}
          aria-label={canDraw ? "Drawing board. Draw your word here." : "Drawing board. Watch and guess the word."}
          role="img"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className={`block aspect-[4/3] w-full touch-none rounded-[13px] bg-white ${canDraw ? "cursor-crosshair" : "cursor-default"}`}
        />
        {overlay && (
          <div className="absolute inset-[5px] flex items-center justify-center rounded-[13px] bg-paper/92 p-6 text-center">
            {overlay}
          </div>
        )}
      </div>

      {canDraw && (
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-3" role="toolbar" aria-label="Drawing tools">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Colour">
            {[...COLORS, { name: "Eraser", value: ERASER }].map((c) => (
              <button
                key={c.value}
                type="button"
                aria-label={c.name}
                aria-pressed={color === c.value}
                title={c.name}
                onClick={() => setColor(c.value)}
                className={`size-8 rounded-full border-[2.5px] transition-transform focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-cobalt ${
                  color === c.value ? "scale-110 border-ink ring-2 ring-ink ring-offset-2 ring-offset-paper" : "border-ink/70"
                } ${c.value === ERASER ? "bg-[repeating-linear-gradient(45deg,#fff_0_4px,#e5e3de_4px_8px)]" : ""}`}
                style={c.value === ERASER ? undefined : { backgroundColor: c.value }}
              />
            ))}
          </div>

          <div className="flex items-center gap-1.5" role="group" aria-label="Brush size">
            {SIZES.map((s) => (
              <button
                key={s}
                type="button"
                aria-label={`Brush size ${s}`}
                aria-pressed={size === s}
                onClick={() => setSize(s)}
                className={`flex size-9 items-center justify-center rounded-full focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-cobalt ${
                  size === s ? "bg-ink/10 ring-2 ring-ink" : "hover:bg-ink/5"
                }`}
              >
                <span className="rounded-full bg-ink" style={{ width: 4 + s / 2.2, height: 4 + s / 2.2 }} />
              </button>
            ))}
          </div>

          <div className="ml-auto flex gap-2">
            <button type="button" onClick={undo} className="crayon crayon-coat crayon-button px-4 py-1.5 font-semibold">
              Undo
            </button>
            <button type="button" onClick={clear} className="crayon crayon-coat crayon-button px-4 py-1.5 font-semibold">
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
