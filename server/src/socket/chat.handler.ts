import { chatSendSchema, guessSubmitSchema } from "../validation/schemas.js";
import type { ConnectionContext } from "./context.js";
import { enforceRateLimit, parsePayload, requirePlayer, respond } from "./handler-utils.js";

export function registerChatHandlers(ctx: ConnectionContext): void {
  const { socket, store, chatService, guessService } = ctx;

  socket.on("chat:send", (payload, ack) => {
    respond(ack, () => {
      const { room, player } = requirePlayer(socket, store);
      enforceRateLimit(player.rateLimits, "chat");
      const { content } = parsePayload(chatSendSchema, payload);
      return chatService.sendMessage(room, player, content);
    });
  });

  socket.on("guess:submit", (payload, ack) => {
    respond(ack, () => {
      const { room, player } = requirePlayer(socket, store);
      enforceRateLimit(player.rateLimits, "guess");
      const { text } = parsePayload(guessSubmitSchema, payload);
      return guessService.submitGuess(room, player, text);
    });
  });
}
