import type { Broadcaster } from "../socket/broadcaster.js";
import type { Player, Room } from "../types/game.types.js";
import type { GuessAck } from "../types/socket.types.js";
import { calculateGuesserPoints } from "../utils/scoring.js";
import { levenshtein, normalizeText } from "../utils/text.js";
import type { ChatService } from "./chat.service.js";
import { GameError } from "./errors.js";

export class GuessService {
  /** Set by the game engine: checks whether everyone has guessed and ends the turn early. */
  private onCorrectGuess: (room: Room) => void = () => {};

  constructor(
    private readonly broadcaster: Broadcaster,
    private readonly chatService: ChatService,
    private readonly now: () => number = Date.now,
  ) {}

  setCorrectGuessHandler(handler: (room: Room) => void): void {
    this.onCorrectGuess = handler;
  }

  /**
   * CONCURRENCY NOTE: Node runs JavaScript on a single thread, and this method
   * has no `await`. The "has this player already guessed?" check and the write
   * that records the guess therefore happen atomically: two guesses arriving at
   * the same moment are processed one after the other, so double scoring
   * can't happen.
   */
  submitGuess(room: Room, player: Player, rawGuess: string): GuessAck {
    const turn = room.game.turn;
    const now = this.now();
    if (room.game.phase !== "playing" || !turn || now >= turn.endsAt) {
      throw new GameError("INVALID_STATE", "There is no word to guess right now.");
    }
    if (turn.drawerId === player.id) {
      throw new GameError("INVALID_STATE", "The drawer can't guess.");
    }
    if (turn.correctGuesses.has(player.id)) {
      throw new GameError("ALREADY_GUESSED", "You already guessed the word.");
    }

    const guess = normalizeText(rawGuess);
    const answer = normalizeText(turn.word);

    if (guess !== answer) {
      const close = answer.length >= 4 && levenshtein(guess, answer, 1) === 1;
      // Wrong guesses are public, like in Skribbl. The text can't leak the
      // word, because it isn't the word.
      this.broadcaster.toRoom(room.code, "guess:result", {
        playerId: player.id,
        username: player.username,
        correct: false,
        text: rawGuess,
      });
      // "close" goes only to the guesser (via the ack), never to the room.
      return { correct: false, close, pointsAwarded: 0 };
    }

    const points = calculateGuesserPoints({
      remainingMs: turn.endsAt - now,
      durationMs: turn.durationMs,
      guessOrder: turn.correctGuesses.size,
    });
    turn.correctGuesses.set(player.id, { playerId: player.id, points, guessedAt: now });
    player.score += points;

    // Correct guesses never include the text, only who and how many points.
    this.broadcaster.toRoom(room.code, "guess:result", {
      playerId: player.id,
      username: player.username,
      correct: true,
      pointsAwarded: points,
    });
    this.chatService.sendSystemMessage(room, `${player.username} guessed the word!`);
    this.broadcaster.syncRoomState(room);
    this.onCorrectGuess(room);

    return { correct: true, close: false, pointsAwarded: points };
  }
}
