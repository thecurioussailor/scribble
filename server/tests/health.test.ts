import { afterEach, describe, expect, it } from "vitest";
import { createTestConfig } from "../src/config/env.js";
import { createGameServer, type GameServer } from "../src/server.js";

describe("HTTP basics", () => {
  let server: GameServer;
  afterEach(() => server?.close());

  it("GET /health returns ok", async () => {
    server = createGameServer(createTestConfig());
    const port = await server.listen(0, "127.0.0.1");
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", rooms: 0 });
  });

  it("unknown routes return a JSON 404", async () => {
    server = createGameServer(createTestConfig());
    const port = await server.listen(0, "127.0.0.1");
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});
