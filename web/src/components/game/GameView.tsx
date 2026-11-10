"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { deadlineStore, feedStore, nextGameStore, pushFeed, turnEndedStore, type FeedItem, type TurnEnded } from "@/lib/live";
import type { PublicPlayer, RoomStateView } from "@/lib/protocol";
import { sendChat, submitGuess } from "@/lib/socket";
import { Wordmark } from "../Wordmark";
import { DrawingCanvas } from "./DrawingCanvas";

type ValueStore<T> = { get: () => T; subscribe: (l: () => void) => () => void };

/** Reads one of the live stores and re-renders when it changes. */
function useStore<T>(store: ValueStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** Whole seconds until a deadline store's time, re-rendered 4×/s while it's set. */
function useSecondsUntil(store: ValueStore<number | null>): number | null {
  const deadline = useStore(store);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === null) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [deadline]);
  return deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / 1000));
}

export function GameView({ state, onLeave }: { state: RoomStateView; onLeave: () => void }) {
  const turnEnded = useStore(turnEndedStore);
  const me = state.players.find((p) => p.id === state.selfId);
  const isDrawer = state.turn?.drawerId === state.selfId;
  const drawer = state.players.find((p) => p.id === state.turn?.drawerId);
  const canDraw = state.phase === "playing" && isDrawer;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-7xl flex-col px-4 py-4 sm:px-6">
      <header className="flex items-center justify-between gap-4">
        <Wordmark size="small" />
        <p className="font-hand text-2xl text-cobalt sm:text-3xl">
          {state.phase === "waiting" ? "Public game" : state.phase === "finished" ? "Game over" : `Round ${Math.max(1, state.round)} of ${state.totalRounds}`}
        </p>
        <button
          onClick={onLeave}
          className="rounded-sm text-graphite underline decoration-2 underline-offset-4 hover:text-ink focus-visible:outline-3 focus-visible:outline-offset-4 focus-visible:outline-cobalt"
        >
          Leave
        </button>
      </header>

      <div className="mt-4 grid flex-1 gap-5 lg:grid-cols-[210px_minmax(0,1fr)_320px]">
        <section className="order-1 lg:order-2" aria-label="Drawing">
          <div className="mb-3 flex items-center gap-4">
            <TurnTimer />
            <WordBar state={state} isDrawer={isDrawer} hasGuessed={me?.hasGuessed ?? false} drawerName={drawer?.username} />
          </div>
          {/* canvasOverlay returns null when there's nothing to show; an always-present overlay element would block drawing. */}
          <DrawingCanvas canDraw={canDraw} overlay={canvasOverlay(state, turnEnded)} />
        </section>

        <ChatPanel state={state} isDrawer={isDrawer} hasGuessed={me?.hasGuessed ?? false} />
        <PlayersPanel state={state} />
      </div>
    </main>
  );
}

function TurnTimer() {
  const seconds = useSecondsUntil(deadlineStore);
  const urgent = seconds !== null && seconds <= 10;
  return (
    <div
      role="timer"
      aria-label={seconds === null ? "Turn timer" : `${seconds} seconds left`}
      className={`crayon flex size-16 shrink-0 items-center justify-center rounded-full font-hand text-[2rem] leading-none ${
        urgent ? "crayon-tomato" : "crayon-coat"
      }`}
      style={{ "--crayon-radius": "50%" } as React.CSSProperties}
    >
      {seconds ?? "–"}
    </div>
  );
}

/** What the player should do right now, plus the word or its hint. */
function WordBar({ state, isDrawer, hasGuessed, drawerName }: { state: RoomStateView; isDrawer: boolean; hasGuessed: boolean; drawerName?: string }) {
  const turn = state.turn;
  if (state.phase !== "playing" || !turn) {
    const message =
      state.phase === "starting"
        ? "Get ready…"
        : state.phase === "waiting"
          ? "Waiting for one more player…"
          : state.phase === "finished"
            ? "The next game starts soon."
            : "Next turn coming up…";
    return <p className="text-lg text-graphite">{message}</p>;
  }
  if (isDrawer) {
    return (
      <p className="text-lg">
        Draw <span className="font-hand text-[2.2rem] leading-none text-tomato-deep">{turn.word}</span>
      </p>
    );
  }
  if (hasGuessed) {
    return <p className="text-lg">You got it! Wait for the others to guess.</p>;
  }
  return (
    <div>
      <p className="text-[0.95rem] text-graphite">{drawerName ?? "Someone"} is drawing. Guess the word.</p>
      <p className="mt-0.5 flex flex-wrap items-baseline gap-x-1 font-hand text-[2rem] leading-none" aria-label={`${turn.wordLength} letters`}>
        {[...turn.hint].map((ch, i) =>
          ch === "_" ? (
            <span key={i} aria-hidden="true" className="inline-block w-[0.9ch] border-b-[3px] border-ink">&nbsp;</span>
          ) : (
            <span key={i} aria-hidden="true" className="w-[0.8ch] text-center">{ch === " " ? " " : ch}</span>
          ),
        )}
        <span className="ml-2 font-sans text-base text-graphite">{turn.wordLength}</span>
      </p>
    </div>
  );
}

const END_REASON: Record<TurnEnded["reason"], string> = {
  time_up: "Time's up!",
  all_guessed: "Everyone got it!",
  drawer_left: "The drawer left the game.",
  not_enough_players: "Not enough players to keep going.",
};

/** Content shown over the canvas between turns, or null during play. */
function canvasOverlay(state: RoomStateView, turnEnded: TurnEnded | null): React.ReactNode {
  // Public rooms only (private rooms show the lobby in these phases).
  if (state.phase === "waiting") return <WaitingOverlay code={state.code} />;
  if (state.phase === "finished") return <FinishedOverlay state={state} />;
  if (state.phase === "starting") {
    return (
      <div>
        <p className="font-hand text-6xl text-cobalt">Get ready</p>
        <p className="mt-2 text-lg">The first turn starts in a moment.</p>
      </div>
    );
  }
  if (state.phase === "between_turns" && turnEnded) {
    const gains = [...turnEnded.scores].filter((s) => s.pointsGained > 0).sort((a, b) => b.pointsGained - a.pointsGained);
    return (
      <div className="w-full max-w-sm">
        <p className="text-lg">{END_REASON[turnEnded.reason]} The word was</p>
        <p className="font-hand text-6xl leading-tight text-tomato-deep">{turnEnded.word}</p>
        {gains.length > 0 ? (
          <ul className="mt-4 space-y-1 text-left text-lg">
            {gains.map((s) => (
              <li key={s.playerId} className="flex justify-between gap-4">
                <span className="truncate">{s.username}</span>
                <span className="font-semibold text-cobalt">+{s.pointsGained}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-lg text-graphite">Nobody guessed it this time.</p>
        )}
      </div>
    );
  }
  return null;
}

/** Alone in a public room: say what happens next, and offer a way to bring a friend. */
function WaitingOverlay({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/room/${code}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="max-w-sm">
      <p className="font-hand text-5xl leading-none text-cobalt">Waiting for one more player</p>
      <p className="mt-3 text-lg">The game starts the moment someone else joins. You can chat while you wait.</p>
      <button onClick={copy} className="crayon crayon-coat crayon-cobalt-line crayon-button mt-5 px-5 py-2.5 font-semibold text-cobalt">
        <span aria-live="polite">{copied ? "Copied" : "Invite a friend"}</span>
      </button>
    </div>
  );
}

/** End of a public game: the standings, then the next game starts on its own. */
function FinishedOverlay({ state }: { state: RoomStateView }) {
  const seconds = useSecondsUntil(nextGameStore);
  const ranked = [...state.players].sort((a, b) => b.score - a.score);
  const topScore = ranked[0]?.score ?? 0;
  const winners = ranked.filter((p) => p.score === topScore);
  return (
    <div className="w-full max-w-sm">
      <p className="font-hand text-5xl leading-none text-cobalt">
        {topScore === 0 ? "Nobody scored this time" : winners.length === 1 ? `${winners[0]!.username} wins!` : "It's a tie!"}
      </p>
      <ol className="mt-4 space-y-1 text-left text-lg">
        {ranked.slice(0, 5).map((p) => (
          <li key={p.id} className="flex justify-between gap-4">
            <span className="truncate">
              {ranked.findIndex((q) => q.score === p.score) + 1}. {p.username}
            </span>
            <span className="font-semibold">{p.score}</span>
          </li>
        ))}
      </ol>
      <p className="mt-4 text-graphite">
        {state.players.filter((p) => p.isConnected).length < 2
          ? "Waiting for more players to start the next game."
          : seconds !== null && seconds > 0
            ? `Next game in ${seconds}…`
            : "Starting the next game…"}
      </p>
    </div>
  );
}

function ChatPanel({ state, isDrawer, hasGuessed }: { state: RoomStateView; isDrawer: boolean; hasGuessed: boolean }) {
  const feed = useStore(feedStore);
  const listRef = useRef<HTMLOListElement>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // Guessing and chatting share one box. While you can still guess, what you
  // type is a guess (sent with guess:submit); otherwise it's chat.
  const isGuessing = state.phase === "playing" && !isDrawer && !hasGuessed;

  // Keep the newest message in view.
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [feed]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    setError(null);
    if (isGuessing) {
      const res = await submitGuess(value);
      if (res.ok) {
        setText("");
        if (!res.data.correct && res.data.close) pushFeed({ kind: "note", text: `"${value}" is close!` });
      } else setError(res.error.message);
    } else {
      const res = await sendChat(value);
      if (res.ok) setText("");
      else setError(res.error.message);
    }
    setSending(false);
  }

  const placeholder = isGuessing
    ? "Type your guess"
    : isDrawer && state.phase === "playing"
      ? "Chat (no spoilers!)"
      : hasGuessed && state.phase === "playing"
        ? "Chat while the others guess"
        : "Say something";

  return (
    <section aria-label="Chat and guesses" className="order-2 flex h-[340px] flex-col lg:order-3 lg:h-[min(640px,calc(100dvh-7rem))]">
      <div className="crayon crayon-coat flex min-h-0 flex-1 flex-col">
        <ol ref={listRef} aria-live="polite" className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-4 py-3 text-[0.98rem] leading-snug">
          {feed.length === 0 && <li className="text-graphite">Guesses and messages show up here.</li>}
          {feed.map((item) => (
            <FeedRow key={item.id} item={item} selfId={state.selfId} />
          ))}
        </ol>
        <form onSubmit={onSubmit} className="flex gap-2 border-t-2 border-ink/80 p-2">
          <label htmlFor="chat-input" className="sr-only">
            {isGuessing ? "Your guess" : "Message"}
          </label>
          <input
            id="chat-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={isGuessing ? 60 : 200}
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
            className="min-w-0 flex-1 rounded-lg bg-transparent px-2 py-2 text-base placeholder:text-graphite/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-cobalt"
          />
          <button
            type="submit"
            disabled={sending || !text.trim()}
            className={`crayon crayon-button shrink-0 px-4 py-2 font-semibold ${isGuessing ? "crayon-tomato crayon-grain" : "crayon-coat text-cobalt crayon-cobalt-line"}`}
          >
            {isGuessing ? "Guess" : "Send"}
          </button>
        </form>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-[0.95rem] font-medium text-tomato-deep">
          {error}
        </p>
      )}
    </section>
  );
}

function FeedRow({ item, selfId }: { item: FeedItem; selfId: string }) {
  switch (item.kind) {
    case "system":
      return <li className="font-semibold text-cobalt">{item.text}</li>;
    case "note":
      return <li className="font-medium text-tomato-deep">{item.text}</li>;
    case "guess":
      return (
        <li className="text-graphite">
          <span className="font-semibold">{item.senderId === selfId ? "You" : item.username}</span> tried &ldquo;{item.text}&rdquo;
        </li>
      );
    case "chat":
      return (
        <li>
          <span className="font-semibold">{item.senderId === selfId ? "You" : item.username}:</span> {item.text}
        </li>
      );
  }
}

function PlayersPanel({ state }: { state: RoomStateView }) {
  const ranked = [...state.players].sort((a, b) => b.score - a.score);
  return (
    <section aria-labelledby="scores-heading" className="order-3 lg:order-1">
      <h2 id="scores-heading" className="text-[0.95rem] text-graphite">
        Scores
      </h2>
      <ol className="mt-2 space-y-2">
        {ranked.map((player) => (
          <PlayerRow key={player.id} player={player} isSelf={player.id === state.selfId} />
        ))}
      </ol>
    </section>
  );
}

function PlayerRow({ player, isSelf }: { player: PublicPlayer; isSelf: boolean }) {
  const status = player.isDrawing ? "Drawing" : player.hasGuessed ? "Guessed" : !player.isConnected ? "Reconnecting" : null;
  return (
    <li className={`crayon crayon-coat px-3.5 py-2 ${player.isConnected ? "" : "opacity-55"}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-hand truncate text-[1.6rem] leading-none">
          {player.username}
          {isSelf && <span className="ml-1.5 font-sans text-sm text-graphite">(you)</span>}
        </span>
        <span className="shrink-0 font-semibold">{player.score}</span>
      </div>
      {status && (
        <span
          className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${
            status === "Drawing" ? "bg-tomato text-ink" : status === "Guessed" ? "bg-[#2e9e5b] text-white" : "bg-ink/10 text-graphite"
          }`}
        >
          {status}
        </span>
      )}
    </li>
  );
}
