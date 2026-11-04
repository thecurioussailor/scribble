"use client";

import { io, type Socket } from "socket.io-client";
import { attachLiveListeners } from "./live";
import type { AckResponse, ChatMessage, ClientToServerEvents, GuessAck, JoinRoomResult, ServerToClientEvents } from "./protocol";
import { saveSession } from "./session";

export type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:4000";

/**
 * ONE socket for the whole app, kept in module scope.
 *
 * Next.js client-side navigation (landing page → /room/CODE) doesn't reload
 * the JS, so the room page reuses the same connection. If a fresh socket
 * were created there, the server would see a stranger instead of the
 * player who just created the room.
 */
let socket: GameSocket | null = null;

/**
 * Which room this socket has joined. Reset on every disconnect, because a
 * reconnected socket is a NEW connection that must rejoin with its session token.
 */
let joined: { code: string; state: JoinRoomResult["state"] } | null = null;

export function getSocket(): GameSocket {
  if (!socket) {
    socket = io(SERVER_URL, {
      transports: ["websocket"],
      // Keep retrying: Render's free tier can take ~30–60s to wake up.
      reconnectionDelayMax: 5000,
    });
    socket.on("disconnect", () => {
      joined = null;
    });
    // Live game data (strokes, chat, timer) is collected from the very first event.
    attachLiveListeners(socket);
  }
  return socket;
}

export function getJoinedRoom() {
  return joined;
}

/** Resolves once connected, or rejects after `timeoutMs` (server down or asleep). */
function waitForConnection(s: GameSocket, timeoutMs: number): Promise<void> {
  if (s.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      s.off("connect", onConnect);
      reject(new Error("connect timeout"));
    }, timeoutMs);
    const onConnect = () => {
      clearTimeout(timer);
      resolve();
    };
    s.once("connect", onConnect);
  });
}

const OFFLINE: AckResponse<never> = {
  ok: false,
  error: { code: "TIMEOUT", message: "Can't reach the game server. Check your connection and try again." },
};

/** Shared by create/join: emit with a timeout, then remember the session on success. */
async function enterRoom(
  send: (s: GameSocket) => Promise<AckResponse<JoinRoomResult>>,
  username: string,
): Promise<AckResponse<JoinRoomResult>> {
  const s = getSocket();
  try {
    await waitForConnection(s, 50_000);
    const res = await send(s);
    if (res.ok) {
      joined = { code: res.data.state.code, state: res.data.state };
      saveSession(res.data.state.code, { sessionToken: res.data.sessionToken, playerId: res.data.playerId, username });
    }
    return res;
  } catch {
    return OFFLINE;
  }
}

export function createRoom(username: string) {
  return enterRoom((s) => s.timeout(8000).emitWithAck("room:create", { username }), username);
}

export function joinRoom(roomCode: string, username: string, sessionToken?: string) {
  return enterRoom(
    (s) => s.timeout(8000).emitWithAck("room:join", { roomCode, username, ...(sessionToken ? { sessionToken } : {}) }),
    username,
  );
}

export async function leaveRoom(): Promise<void> {
  const s = getSocket();
  joined = null;
  if (!s.connected) return;
  await s
    .timeout(3000)
    .emitWithAck("room:leave")
    .catch(() => undefined);
}

export async function startGame(): Promise<AckResponse> {
  const s = getSocket();
  try {
    return await s.timeout(8000).emitWithAck("game:start", {});
  } catch {
    return OFFLINE;
  }
}

/**
 * Rejoin a room with a saved session token (after a refresh or reconnect).
 *
 * Deduplicated: React (in dev Strict Mode) and our own "connect" listener can
 * both ask to resume at almost the same moment. Sending two room:join events
 * would make the second fail with ALREADY_IN_ROOM, so concurrent callers share
 * one in-flight request.
 */
let resumeInFlight: { code: string; promise: Promise<AckResponse<JoinRoomResult>> } | null = null;

export function resumeRoom(code: string, username: string, sessionToken: string) {
  if (resumeInFlight?.code === code) return resumeInFlight.promise;
  const promise = joinRoom(code, username, sessionToken).finally(() => {
    resumeInFlight = null;
  });
  resumeInFlight = { code, promise };
  return promise;
}

/** Shared shape for acked game actions: emit with a timeout, map a timeout to a friendly error. */
async function sendWithAck<T>(send: (s: GameSocket) => Promise<AckResponse<T>>): Promise<AckResponse<T>> {
  try {
    return await send(getSocket());
  } catch {
    return OFFLINE;
  }
}

export function sendChat(content: string) {
  return sendWithAck<ChatMessage>((s) => s.timeout(5000).emitWithAck("chat:send", { content }));
}

export function submitGuess(text: string) {
  return sendWithAck<GuessAck>((s) => s.timeout(5000).emitWithAck("guess:submit", { text }));
}
