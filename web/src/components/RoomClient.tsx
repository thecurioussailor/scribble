"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, type FormEvent } from "react";
import type { AckError, RoomStateView } from "@/lib/protocol";
import { ROOM_CODE_PATTERN, USERNAME_MAX } from "@/lib/protocol";
import { clearSession, loadName, loadSession, saveName, validateName } from "@/lib/session";
import { getJoinedRoom, getSocket, joinRoom, leaveRoom, resumeRoom, startGame } from "@/lib/socket";
import { GameView } from "./game/GameView";
import { Wordmark } from "./Wordmark";

/**
 * What the room page can be showing. Modelling the screen as a union of
 * states (instead of several booleans) makes impossible combinations,
 * like "loading AND errored", unrepresentable.
 */
type Screen =
  | { kind: "connecting" }
  | { kind: "needs-name" }
  | { kind: "joined"; state: RoomStateView }
  | { kind: "gone"; title: string; detail: string };

function screenForError(error: AckError): Screen {
  switch (error.code) {
    case "ROOM_NOT_FOUND":
      return {
        kind: "gone",
        title: "This room has closed",
        detail: "Rooms close when everyone leaves or the game server restarts. Start a new one and send your friends the link.",
      };
    case "ROOM_FULL":
      return { kind: "gone", title: "This room is full", detail: "Ask the host to start a new room, or try again when someone leaves." };
    default:
      return { kind: "gone", title: "Couldn't open this room", detail: error.message };
  }
}

/** The first screen can be decided synchronously from local state (this component only runs in the browser). */
function initialScreen(code: string): Screen {
  if (!ROOM_CODE_PATTERN.test(code)) {
    return { kind: "gone", title: "That invite link looks wrong", detail: "Room codes are 8 letters and numbers. Check the link and try again." };
  }
  const joined = getJoinedRoom();
  if (joined?.code === code) return { kind: "joined", state: joined.state }; // just came from the landing page
  if (loadSession(code)) return { kind: "connecting" }; // refresh: we can resume our seat
  return { kind: "needs-name" }; // opened an invite link
}

export function RoomClient({ code }: { code: string }) {
  const [screen, setScreen] = useState<Screen>(() => initialScreen(code));

  useEffect(() => {
    if (!ROOM_CODE_PATTERN.test(code)) return;
    const socket = getSocket();
    let active = true;

    /** Rejoin our seat with the saved session token (after a refresh or a reconnect). */
    const resume = async () => {
      const saved = loadSession(code);
      if (!saved || getJoinedRoom()?.code === code) return;
      const res = await resumeRoom(code, saved.username, saved.sessionToken);
      if (!active) return;
      if (res.ok) {
        setScreen({ kind: "joined", state: res.data.state });
      } else {
        clearSession(code);
        setScreen(screenForError(res.error));
      }
    };

    // The server pushes a fresh, personalized view after every change.
    const onState = (state: RoomStateView) => {
      if (state.code === code) setScreen({ kind: "joined", state });
    };
    // After a network drop, Socket.IO reconnects with a NEW socket, so rejoin.
    const onReconnect = () => void resume();
    const onReplaced = () => {
      setScreen({
        kind: "gone",
        title: "You're playing in another tab",
        detail: "This room was opened somewhere else, so this tab stepped aside. Close it, or reload to play here instead.",
      });
    };

    socket.on("room:state", onState);
    socket.on("connect", onReconnect);
    socket.on("session:replaced", onReplaced);
    void resume();

    return () => {
      active = false;
      socket.off("room:state", onState);
      socket.off("connect", onReconnect);
      socket.off("session:replaced", onReplaced);
    };
  }, [code]);

  switch (screen.kind) {
    case "connecting":
      return <Centered><p className="text-lg text-graphite">Connecting to the game server…</p></Centered>;
    case "needs-name":
      return <JoinWithName code={code} onJoined={(state) => setScreen({ kind: "joined", state })} />;
    case "gone":
      return (
        <Centered>
          <h1 className="font-hand text-5xl leading-none text-cobalt">{screen.title}</h1>
          <p className="mt-4 max-w-[42ch] text-lg">{screen.detail}</p>
          <Link href="/" className="crayon crayon-tomato crayon-grain crayon-button font-hand mt-8 inline-block px-7 pb-2 pt-2.5 text-3xl">
            Start a new room
          </Link>
        </Centered>
      );
    case "joined":
      return <JoinedRoom state={screen.state} />;
  }
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col items-start justify-center px-6 py-10">
      <div className="mb-10">
        <Wordmark size="small" />
      </div>
      {children}
    </main>
  );
}

/** Someone opened an invite link without a session for this room: ask for their name. */
function JoinWithName({ code, onJoined }: { code: string; onJoined: (state: RoomStateView) => void }) {
  const nameId = useId();
  const [name, setName] = useState(loadName); // safe: this component never renders on the server
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const problem = validateName(name);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    saveName(name.trim());
    const res = await joinRoom(code, name.trim());
    setBusy(false);
    if (res.ok) onJoined(res.data.state);
    else setError(res.error.message);
  }

  return (
    <Centered>
      <h1 className="font-hand text-5xl leading-none text-cobalt">You&apos;re invited</h1>
      <p className="mt-3 text-lg">Pick a name to join room <span className="font-semibold tracking-[0.12em]">{code}</span>.</p>
      <form onSubmit={onSubmit} noValidate className="mt-8 w-full max-w-sm">
        <label htmlFor={nameId} className="mb-2 block text-[0.95rem] text-graphite">Your name</label>
        <div className="crayon crayon-coat">
          <input
            id={nameId}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={USERNAME_MAX}
            autoComplete="nickname"
            autoFocus
            spellCheck={false}
            className="w-full bg-transparent px-5 py-4 text-xl focus:outline-none"
          />
        </div>
        <button type="submit" disabled={busy} className="crayon crayon-tomato crayon-grain crayon-button font-hand mt-5 block w-full px-6 pb-2.5 pt-3 text-[2.4rem] leading-none">
          {busy ? "Joining…" : "Join room"}
        </button>
        {error && <p role="alert" className="mt-4 font-medium text-tomato-deep">{error}</p>}
      </form>
    </Centered>
  );
}

/** In a room: the game screen while a game runs, otherwise the lobby (before and after games). */
function JoinedRoom({ state }: { state: RoomStateView }) {
  const router = useRouter();
  async function onLeave() {
    await leaveRoom();
    clearSession(state.code);
    router.push("/");
  }
  const gameRunning = state.phase === "starting" || state.phase === "playing" || state.phase === "between_turns";
  // Public games have no lobby: you're dropped straight onto the game screen,
  // which shows "waiting for players" and the final scores as overlays.
  if (state.visibility === "public" || gameRunning) return <GameView state={state} onLeave={onLeave} />;
  return <Lobby state={state} onLeave={onLeave} />;
}

function Lobby({ state, onLeave }: { state: RoomStateView; onLeave: () => void }) {
  const [copied, setCopied] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const inviteLink = `${window.location.origin}/room/${state.code}`;

  const host = state.players.find((p) => p.id === state.hostId);
  const isHost = state.selfId === state.hostId;
  const connectedCount = state.players.filter((p) => p.isConnected).length;
  const finished = state.phase === "finished";
  const canStart = isHost && connectedCount >= 2;

  // After a game, rank by score. Ties share a place, like on the server.
  const standings = finished
    ? [...state.players]
        .sort((a, b) => b.score - a.score)
        .map((p, _i, all) => ({ ...p, place: all.findIndex((q) => q.score === p.score) + 1 }))
    : state.players.map((p) => ({ ...p, place: 0 }));
  const winners = standings.filter((p) => p.place === 1);

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  async function onStart() {
    setStarting(true);
    setStartError(null);
    const res = await startGame();
    setStarting(false);
    if (!res.ok) setStartError(res.error.message);
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col px-5 py-6 sm:px-8">
      <header className="flex items-center justify-between">
        <Wordmark size="small" />
        <button onClick={onLeave} className="rounded-sm text-graphite underline decoration-2 underline-offset-4 hover:text-ink focus-visible:outline-3 focus-visible:outline-offset-4 focus-visible:outline-cobalt">
          Leave room
        </button>
      </header>

      <div className="mt-10 grid flex-1 gap-12 md:mt-16 md:grid-cols-[1.15fr_1fr]">
        <section>
          {finished ? (
            <>
              <p className="text-lg text-graphite">Game over</p>
              <h1 className="font-hand text-[clamp(3rem,7vw,4.75rem)] leading-[0.9] text-cobalt">
                {winners.length === 1 ? `${winners[0]!.username} wins!` : "It's a tie!"}
              </h1>
              {winners.length > 1 && <p className="mt-3 text-lg">{winners.map((w) => w.username).join(" and ")} share first place.</p>}
            </>
          ) : (
            <h1 className="font-hand text-[clamp(3rem,7vw,4.5rem)] leading-[0.9] text-cobalt">Waiting for players</h1>
          )}

          <p className="mt-4 max-w-[40ch] text-lg">
            {finished ? "Invite more friends before the next game:" : "Send this link to your friends. Anyone who opens it can join."}
          </p>
          <div className="mt-4 flex max-w-md flex-col gap-3 sm:flex-row">
            <div className="crayon crayon-coat min-w-0 flex-1 px-4 py-3">
              <p className="truncate text-[0.95rem]" title={inviteLink}>{inviteLink}</p>
            </div>
            <button onClick={copyInvite} className="crayon crayon-coat crayon-cobalt-line crayon-button shrink-0 px-5 py-3 font-semibold text-cobalt">
              <span aria-live="polite">{copied ? "Copied" : "Copy invite link"}</span>
            </button>
          </div>
          <p className="mt-3 text-[0.95rem] text-graphite">
            Room code <span className="font-semibold tracking-[0.12em] text-ink">{state.code}</span>
          </p>

          <div className="mt-10 max-w-sm">
            {isHost ? (
              <>
                <button onClick={onStart} disabled={!canStart || starting} className="crayon crayon-tomato crayon-grain crayon-button font-hand block w-full px-6 pb-2.5 pt-3 text-[2.4rem] leading-none">
                  {starting ? "Starting…" : finished ? "Play again" : "Start game"}
                </button>
                {connectedCount < 2 && <p className="mt-3 text-graphite">You need at least one more player to start.</p>}
              </>
            ) : (
              <p className="text-lg text-graphite">
                Waiting for {host?.username ?? "the host"} to {finished ? "start another game" : "start the game"}.
              </p>
            )}
            {startError && <p role="alert" className="mt-3 font-medium text-tomato-deep">{startError}</p>}
          </div>
        </section>

        <section aria-labelledby="players-heading">
          <h2 id="players-heading" className="text-lg text-graphite">
            {finished ? "Final scores" : `Players ${state.players.length}/${state.settings.maxPlayers}`}
          </h2>
          <ol className="mt-4 space-y-3">
            {standings.map((player) => (
              <li key={player.id} className={`crayon crayon-coat flex items-baseline gap-4 px-5 py-3 ${player.isConnected ? "" : "opacity-55"}`}>
                {finished && <span className="font-hand w-6 shrink-0 text-[1.9rem] leading-none text-cobalt">{player.place}</span>}
                <span className="font-hand min-w-0 flex-1 truncate text-[1.9rem] leading-none">
                  {player.username}
                  {player.id === state.selfId && <span className="ml-2 font-sans text-base text-graphite">(you)</span>}
                </span>
                <span className="shrink-0 text-[0.95rem] text-graphite">
                  {[player.isHost && "Host", !player.isConnected && "Reconnecting", finished && `${player.score} pts`].filter(Boolean).join(", ")}
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </main>
  );
}
