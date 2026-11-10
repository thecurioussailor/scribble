import type { AppConfig } from "../config/env.js";
import { LIMITS } from "../config/limits.js";
import type { Broadcaster } from "../socket/broadcaster.js";
import type { RoomStore } from "../store/room.store.js";
import type { Player, Room, TurnEndReason, TurnScore } from "../types/game.types.js";
import type { LeaderboardEntry } from "../types/socket.types.js";
import { calculateDrawerPoints, rankPlayers } from "../utils/scoring.js";
import { pickWord as defaultPickWord } from "../utils/words.js";
import type { ChatService } from "./chat.service.js";
import type { DrawingService } from "./drawing.service.js";
import { GameError } from "./errors.js";
import type { GameHooks } from "./room.service.js";
import { toPublicTurn } from "./views.js";

/**
 * The game engine: a server-authoritative state machine.
 *
 *   waiting/finished ─start→ starting ─countdown→ playing ─end→ between_turns ─pause→ playing …
 *                                                                              └─(no turns left)→ finished
 *
 * Concurrency rules this class follows:
 *  1. All methods are synchronous (no `await`), so each transition is atomic.
 *  2. A room has at most ONE pending phase timer. Every transition clears the
 *     old one before setting a new one, so timers can't overlap.
 *  3. Timer callbacks capture the turn sequence number and phase they were created
 *     for, and do nothing if the game has moved on (a "stale" timer).
 *  4. Every transition checks the current phase first, so calling it twice
 *     (e.g. "all guessed" and "time up" in the same tick) is harmless.
 */
export class GameService implements GameHooks {
  constructor(
    private readonly store: RoomStore,
    private readonly config: AppConfig,
    private readonly broadcaster: Broadcaster,
    private readonly drawingService: DrawingService,
    private readonly chatService: ChatService,
    private readonly pickWord: (used: Set<string>) => string = defaultPickWord,
  ) {}

  // ───────────────────────────── Commands ─────────────────────────────

  /** The host's "Start game" button (private rooms only). */
  startGame(room: Room, player: Player, options: { rounds?: number | undefined } = {}): void {
    if (room.settings.visibility === "public") {
      throw new GameError("INVALID_STATE", "Public games start on their own when enough players join.");
    }
    if (room.hostId !== player.id) throw new GameError("NOT_HOST", "Only the host can start the game.");
    if (room.game.phase !== "waiting" && room.game.phase !== "finished") {
      throw new GameError("GAME_IN_PROGRESS", "A game is already in progress.");
    }
    if (this.connectedPlayers(room).length < LIMITS.minPlayersToStart) {
      throw new GameError("NOT_ENOUGH_PLAYERS", `At least ${LIMITS.minPlayersToStart} players are needed to start.`);
    }
    this.beginGame(room, options.rounds ?? room.settings.totalRounds);
  }

  /**
   * Public rooms have no host button: a game begins as soon as 2 players are
   * online, whether the room is new (waiting) or between games (finished).
   */
  private maybeAutoStart(room: Room): void {
    if (room.settings.visibility !== "public") return;
    if (room.game.phase !== "waiting") return; // "finished" restarts via its own timer
    if (this.connectedPlayers(room).length >= LIMITS.minPlayersToStart) {
      this.beginGame(room, room.settings.totalRounds);
    }
  }

  private beginGame(room: Room, totalRounds: number): void {
    // Reset per-game state. turnSeq is NOT reset: it keeps increasing across
    // games, so a timer from a previous game can never match a new turn.
    const game = room.game;
    game.phase = "starting";
    game.totalRounds = totalRounds;
    game.round = 0;
    game.drawQueue = [];
    game.turn = null;
    game.usedWords.clear();
    game.lastTurnResult = null;
    for (const p of room.players.values()) p.score = 0;

    const startsAt = Date.now() + this.config.startCountdownMs;
    this.broadcaster.toRoom(room.code, "game:started", { totalRounds: game.totalRounds, startsAt });
    this.broadcaster.syncRoomState(room);
    this.schedulePhase(room, this.config.startCountdownMs, () => this.startNextTurn(room));
  }

  /** Called after every correct guess: ends the turn early once everyone has guessed. */
  checkAllGuessed(room: Room): void {
    const turn = room.game.turn;
    if (room.game.phase !== "playing" || !turn || turn.correctGuesses.size === 0) return;
    // Only connected guessers count, so a player who went offline doesn't block the turn.
    const pending = this.connectedPlayers(room).filter(
      (p) => p.id !== turn.drawerId && !turn.correctGuesses.has(p.id),
    );
    if (pending.length === 0) this.endTurn(room, "all_guessed");
  }

  // ─────────────────────────── Transitions ────────────────────────────

  private startNextTurn(room: Room): void {
    const game = room.game;
    if (game.phase !== "starting" && game.phase !== "between_turns") return;

    if (this.connectedPlayers(room).length < LIMITS.minPlayersToStart) {
      this.finishGame(room);
      return;
    }

    const drawer = this.takeNextDrawer(room);
    if (!drawer) {
      this.finishGame(room); // every round is done
      return;
    }

    const now = Date.now();
    const durationMs = room.settings.turnDurationMs;
    game.turnSeq += 1;
    game.phase = "playing";
    game.turn = {
      seq: game.turnSeq,
      drawerId: drawer.id,
      word: this.pickWord(game.usedWords),
      startedAt: now,
      endsAt: now + durationMs,
      durationMs,
      correctGuesses: new Map(),
    };

    this.drawingService.resetCanvas(room);
    // Personalized: only the drawer's copy of the event contains the word.
    for (const player of room.players.values()) {
      this.broadcaster.toPlayer(player, "game:turn-started", {
        round: game.round,
        totalRounds: game.totalRounds,
        turn: toPublicTurn(room, player.id, now)!,
      });
    }
    this.broadcaster.syncRoomState(room);

    const seq = game.turnSeq;
    this.schedulePhase(room, durationMs, () => this.endTurn(room, "time_up", seq));
    room.timers.tick = setInterval(() => {
      const turn = room.game.turn;
      if (!turn || turn.seq !== seq) return;
      this.broadcaster.toRoom(room.code, "game:timer", {
        remainingMs: Math.max(0, turn.endsAt - Date.now()),
        endsAt: turn.endsAt,
      });
    }, 1000);
  }

  /**
   * Ends the live turn. `expectedSeq` is passed by the turn timer: if the turn
   * already ended (e.g. everyone guessed) and a new one began, the stale
   * timer's call is ignored.
   */
  private endTurn(room: Room, reason: TurnEndReason, expectedSeq?: number): void {
    const game = room.game;
    const turn = game.turn;
    if (game.phase !== "playing" || !turn) return;
    if (expectedSeq !== undefined && turn.seq !== expectedSeq) return;

    this.clearTurnTimers(room);

    // Drawer points (only if the drawer is still in the room).
    const drawer = room.players.get(turn.drawerId);
    const eligibleGuessers = Math.max(turn.correctGuesses.size, room.players.size - (drawer ? 1 : 0));
    const drawerPoints = drawer
      ? calculateDrawerPoints({ correctGuessCount: turn.correctGuesses.size, eligibleGuesserCount: eligibleGuessers })
      : 0;
    if (drawer) drawer.score += drawerPoints;

    const scores: TurnScore[] = [...room.players.values()].map((p) => ({
      playerId: p.id,
      username: p.username,
      pointsGained: p.id === turn.drawerId ? drawerPoints : (turn.correctGuesses.get(p.id)?.points ?? 0),
      totalScore: p.score,
    }));

    game.lastTurnResult = { word: turn.word, reason, drawerId: turn.drawerId, scores };
    game.turn = null;
    game.phase = "between_turns";

    const isLastTurn = game.drawQueue.length === 0 && game.round >= game.totalRounds;
    const nextTurnAt = isLastTurn ? null : Date.now() + this.config.betweenTurnsMs;
    this.broadcaster.toRoom(room.code, "game:turn-ended", {
      word: turn.word, // safe now: the turn is over
      reason,
      drawerId: turn.drawerId,
      scores,
      nextTurnAt,
    });
    this.chatService.sendSystemMessage(room, `The word was "${turn.word}".`);
    this.broadcaster.syncRoomState(room);

    this.schedulePhase(room, this.config.betweenTurnsMs, () => this.startNextTurn(room));
  }

  private finishGame(room: Room): void {
    const game = room.game;
    if (game.phase === "finished" || game.phase === "waiting") return;

    this.clearTurnTimers(room);
    game.phase = "finished";
    game.turn = null;
    game.drawQueue = [];

    const isPublic = room.settings.visibility === "public";
    this.broadcaster.toRoom(room.code, "game:finished", {
      leaderboard: this.leaderboard(room),
      nextGameInMs: isPublic ? this.config.publicRestartDelayMs : null,
    });
    this.broadcaster.syncRoomState(room);

    // Public rooms keep going: after the final scores, play again if there are
    // still 2+ people online, otherwise wait for the next arrival.
    if (isPublic) {
      this.schedulePhase(room, this.config.publicRestartDelayMs, () => {
        if (this.connectedPlayers(room).length >= LIMITS.minPlayersToStart) {
          this.beginGame(room, room.settings.totalRounds);
        } else {
          room.game.phase = "waiting";
          this.broadcaster.syncRoomState(room);
        }
      });
    }
  }

  // ─────────────────── GameHooks (roster changes) ───────────────────

  onPlayerJoined(room: Room, player: Player): void {
    // A late joiner gets a turn this round (they're appended to the queue).
    const phase = room.game.phase;
    if (phase === "playing" || phase === "between_turns") room.game.drawQueue.push(player.id);
    this.maybeAutoStart(room);
  }

  onPlayerDisconnected(room: Room): void {
    // A guesser going offline may mean everyone left has now guessed.
    // A disconnected DRAWER keeps the turn: they may reconnect within the
    // grace period. If they don't, onPlayerRemoved ends the turn.
    this.checkAllGuessed(room);
  }

  onPlayerReconnected(room: Room): void {
    // The client gets room:state and draw:sync from the room service. In a
    // public room, a returning player might be the second person needed.
    this.maybeAutoStart(room);
  }

  onPlayerRemoved(room: Room, player: Player): void {
    const game = room.game;
    if (game.phase === "waiting" || game.phase === "finished") return;

    game.drawQueue = game.drawQueue.filter((id) => id !== player.id);

    if (room.players.size < LIMITS.minPlayersToStart) {
      if (game.phase === "playing") this.endTurn(room, "not_enough_players");
      this.finishGame(room);
      return;
    }
    if (game.phase === "playing" && game.turn?.drawerId === player.id) {
      this.endTurn(room, "drawer_left");
      return;
    }
    this.checkAllGuessed(room);
  }

  // ───────────────────────────── Helpers ──────────────────────────────

  /** Pops the next drawer, starting a new round when the queue empties. */
  private takeNextDrawer(room: Room): Player | null {
    const game = room.game;
    for (;;) {
      if (game.drawQueue.length === 0) {
        if (game.round >= game.totalRounds) return null;
        game.round += 1;
        // Turn order = join order (Map iteration order).
        game.drawQueue = [...room.players.keys()];
      }
      const nextId = game.drawQueue.shift()!;
      const candidate = room.players.get(nextId);
      // Skip players who left or are offline: they lose this turn.
      if (candidate && candidate.socketId !== null) return candidate;
    }
  }

  leaderboard(room: Room): LeaderboardEntry[] {
    return rankPlayers(
      [...room.players.values()].map((p) => ({ playerId: p.id, username: p.username, score: p.score })),
    );
  }

  private connectedPlayers(room: Room): Player[] {
    return [...room.players.values()].filter((p) => p.socketId !== null);
  }

  /**
   * Replaces the room's single phase timer. Clearing first guarantees we
   * never have two transitions scheduled at once.
   */
  private schedulePhase(room: Room, delayMs: number, action: () => void): void {
    if (room.timers.phase) clearTimeout(room.timers.phase);
    const phaseAtSchedule = room.game.phase;
    const seqAtSchedule = room.game.turnSeq;
    room.timers.phase = setTimeout(() => {
      room.timers.phase = null;
      // Stale-timer guards: room deleted, or the game moved on without us.
      if (this.store.get(room.code) !== room) return;
      if (room.game.phase !== phaseAtSchedule || room.game.turnSeq !== seqAtSchedule) return;
      action();
    }, delayMs);
  }

  private clearTurnTimers(room: Room): void {
    if (room.timers.phase) clearTimeout(room.timers.phase);
    if (room.timers.tick) clearInterval(room.timers.tick);
    room.timers.phase = null;
    room.timers.tick = null;
  }
}
