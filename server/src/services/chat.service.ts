import { LIMITS } from "../config/limits.js";
import type { Broadcaster } from "../socket/broadcaster.js";
import type { ChatMessage, Player, Room } from "../types/game.types.js";
import { generateId } from "../utils/ids.js";
import { compactText, normalizeText } from "../utils/text.js";
import { GameError } from "./errors.js";

/**
 * Ordinary chat. Guessing is a separate channel (GuessService), so the rule is
 * unambiguous: chat never scores, and a guess is never shown as chat.
 */
export class ChatService {
  constructor(private readonly broadcaster: Broadcaster) {}

  sendMessage(room: Room, player: Player, content: string): ChatMessage {
    if (this.wouldRevealWord(room, content)) {
      throw new GameError("INVALID_STATE", "Messages can't contain the secret word.");
    }
    const message: ChatMessage = {
      id: generateId(),
      type: "chat",
      senderId: player.id,
      username: player.username,
      content,
      timestamp: Date.now(),
    };
    this.append(room, message);
    this.broadcaster.toRoom(room.code, "chat:message", message);
    return message;
  }

  /** Server-generated messages (e.g. "bob guessed the word!"). */
  sendSystemMessage(room: Room, content: string): ChatMessage {
    const message: ChatMessage = {
      id: generateId(),
      type: "system",
      senderId: null,
      username: null,
      content,
      timestamp: Date.now(),
    };
    this.append(room, message);
    this.broadcaster.toRoom(room.code, "chat:message", message);
    return message;
  }

  /**
   * During a live turn, no chat message may contain the word, whoever sends it.
   * This stops the drawer and players who already guessed from leaking it, and
   * stops guessers from bypassing the guess channel. We also compare with all
   * spaces removed, which catches "a p p l e" style evasion.
   */
  private wouldRevealWord(room: Room, content: string): boolean {
    const turn = room.game.turn;
    if (room.game.phase !== "playing" || !turn) return false;
    const word = normalizeText(turn.word);
    const text = normalizeText(content);
    return ` ${text} `.includes(` ${word} `) || compactText(content).includes(compactText(turn.word));
  }

  /** Bounded history: drop the oldest message once the cap is reached. */
  private append(room: Room, message: ChatMessage): void {
    room.chat.push(message);
    if (room.chat.length > LIMITS.chatHistorySize) room.chat.splice(0, room.chat.length - LIMITS.chatHistorySize);
  }
}
