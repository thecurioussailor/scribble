import { drawEndSchema, drawMoveSchema, drawStartSchema } from "../validation/schemas.js";
import type { ConnectionContext } from "./context.js";
import { enforceRateLimit, parsePayload, requirePlayer, respond } from "./handler-utils.js";

/**
 * Drawing events are high-frequency. Acks are optional: the client may pass
 * one while debugging, and otherwise rejected events are dropped silently
 * (replying to every rejected packet would let a spammer amplify traffic).
 *
 * Order of checks for every event: membership → rate limit → validation → rules.
 */
export function registerDrawingHandlers(ctx: ConnectionContext): void {
  const { socket, store, drawingService } = ctx;

  /** Shared preamble: who are you, and are you within your rate limit? */
  const authorize = () => {
    const { room, player } = requirePlayer(socket, store);
    enforceRateLimit(player.rateLimits, "draw");
    return { room, player };
  };

  socket.on("draw:start", (payload, ack) => {
    respond(ack, () => {
      const { room, player } = authorize();
      drawingService.startStroke(room, player, parsePayload(drawStartSchema, payload));
    });
  });

  socket.on("draw:move", (payload, ack) => {
    respond(ack, () => {
      const { room, player } = authorize();
      const input = parsePayload(drawMoveSchema, payload);
      drawingService.addPoints(room, player, input.strokeId, input.points);
    });
  });

  socket.on("draw:end", (payload, ack) => {
    respond(ack, () => {
      const { room, player } = authorize();
      drawingService.endStroke(room, player, parsePayload(drawEndSchema, payload).strokeId);
    });
  });

  socket.on("draw:undo", (ack) => {
    respond(ack, () => {
      const { room, player } = authorize();
      drawingService.undo(room, player);
    });
  });

  socket.on("draw:clear", (ack) => {
    respond(ack, () => {
      const { room, player } = authorize();
      drawingService.clear(room, player);
    });
  });
}
