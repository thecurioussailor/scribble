import { startGameSchema } from "../validation/schemas.js";
import type { ConnectionContext } from "./context.js";
import { enforceRateLimit, parsePayload, requirePlayer, respond } from "./handler-utils.js";

export function registerGameHandlers(ctx: ConnectionContext): void {
  const { socket, store, gameService } = ctx;

  socket.on("game:start", (payload, ack) => {
    // The payload is optional, so accept `emit("game:start", callback)` too.
    if (typeof payload === "function" && ack === undefined) {
      ack = payload as unknown as typeof ack;
      payload = {};
    }
    respond(ack, () => {
      const { room, player } = requirePlayer(socket, store);
      enforceRateLimit(player.rateLimits, "game");
      const options = parsePayload(startGameSchema, payload ?? {});
      gameService.startGame(room, player, { rounds: options?.rounds });
    });
  });
}
