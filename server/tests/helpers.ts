import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { createTestConfig, type AppConfig } from "../src/config/env.js";
import { createGameServer, type GameServer } from "../src/server.js";
import type {
  AckResponse,
  ClientToServerEvents,
  JoinRoomResult,
  ServerToClientEvents,
} from "../src/types/socket.types.js";

export type TestClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

export interface TestContext {
  server: GameServer;
  url: string;
  clients: TestClient[];
  /** Opens a new connected client; it is closed automatically in cleanup(). */
  connectClient(): Promise<TestClient>;
  cleanup(): Promise<void>;
}

export async function startTestServer(overrides: Partial<AppConfig> = {}): Promise<TestContext> {
  const server = createGameServer(createTestConfig(overrides));
  const port = await server.listen(0, "127.0.0.1");
  const url = `http://127.0.0.1:${port}`;
  const clients: TestClient[] = [];

  return {
    server,
    url,
    clients,
    async connectClient() {
      const client: TestClient = connect(url, { transports: ["websocket"], forceNew: true, reconnection: false });
      clients.push(client);
      await new Promise<void>((resolve, reject) => {
        client.once("connect", () => resolve());
        client.once("connect_error", reject);
      });
      return client;
    },
    async cleanup() {
      for (const c of clients) c.disconnect();
      await server.close();
    },
  };
}

/** Emits an event and resolves with the server's acknowledgement. */
export function emitAck<T = undefined>(client: TestClient, event: string, ...args: unknown[]): Promise<AckResponse<T>> {
  // Tests deliberately send malformed payloads, so we bypass the typed emit here.
  const loose = client as unknown as { timeout(ms: number): { emitWithAck(ev: string, ...a: unknown[]): Promise<unknown> } };
  return loose.timeout(2000).emitWithAck(event, ...args) as Promise<AckResponse<T>>;
}

/** Resolves with the next payload of `event` (rejects after a timeout). */
export function waitFor<T = unknown>(client: TestClient, event: string, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const loose = client as unknown as { once(ev: string, fn: (p: T) => void): void; off(ev: string, fn: (p: T) => void): void };
    const timer = setTimeout(() => {
      loose.off(event, handler);
      reject(new Error(`Timed out waiting for "${event}"`));
    }, timeoutMs);
    const handler = (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    };
    loose.once(event, handler);
  });
}

/** Asserts that `event` is NOT received within `ms`. */
export async function expectNoEvent(client: TestClient, event: string, ms = 150): Promise<void> {
  const received = await waitFor(client, event, ms).then(
    () => true,
    () => false,
  );
  if (received) throw new Error(`Expected no "${event}" event, but one arrived`);
}

/** Unwraps a successful ack or throws with the error, which keeps tests short. */
export function unwrap<T>(response: AckResponse<T>): T {
  if (!response.ok) throw new Error(`Expected ok ack, got ${response.error.code}: ${response.error.message}`);
  return response.data;
}

export async function createRoom(client: TestClient, username = "alice", settings?: object): Promise<JoinRoomResult> {
  return unwrap(await emitAck<JoinRoomResult>(client, "room:create", { username, settings }));
}

export async function joinRoom(
  client: TestClient,
  roomCode: string,
  username: string,
  sessionToken?: string,
): Promise<JoinRoomResult> {
  return unwrap(await emitAck<JoinRoomResult>(client, "room:join", { roomCode, username, sessionToken }));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until `condition` is true (for server-side state assertions). */
export async function eventually(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("Condition not met in time");
    await sleep(10);
  }
}
