import { TokenVerifier } from "livekit-server-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { createRoom, emitAck, joinRoom, startTestServer, type TestContext } from "./helpers.js";

// Fake credentials: tokens are signed locally, no LiveKit account or network needed.
const LIVEKIT = {
  url: "wss://example.livekit.cloud",
  apiKey: "test-api-key",
  apiSecret: "test-api-secret-that-is-long-enough-for-hs256",
  tokenTtlSeconds: 600,
};

let ctx: TestContext;
afterEach(async () => {
  await ctx?.cleanup();
});

async function requestToken(sessionToken: string | null, body: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sessionToken !== null) headers.authorization = `Bearer ${sessionToken}`;
  const res = await fetch(`${ctx.url}/api/voice/token`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe("voice token endpoint", () => {
  it("issues a token scoped to the player's voice room with mic-only permissions", async () => {
    ctx = await startTestServer({ livekit: LIVEKIT });
    const alice = await ctx.connectClient();
    const { state, sessionToken, playerId } = await createRoom(alice);

    const { status, body } = await requestToken(sessionToken, { roomCode: state.code });
    expect(status).toBe(200);
    expect(body).toMatchObject({ url: LIVEKIT.url, roomName: `scribble-${state.code}`, identity: playerId });

    const claims = await new TokenVerifier(LIVEKIT.apiKey, LIVEKIT.apiSecret).verify(body.token);
    expect(claims.sub).toBe(playerId);
    expect(claims.name).toBe("alice");
    expect(claims.video).toMatchObject({
      room: `scribble-${state.code}`,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
    });
    expect(claims.video?.canPublishSources).toEqual(["microphone"]);
    // No administrative powers.
    for (const admin of ["roomAdmin", "roomCreate", "roomList", "roomRecord", "recorder", "ingressAdmin"] as const) {
      expect(claims.video?.[admin]).toBeFalsy();
    }
    // Short-lived.
    const lifetime = (claims as { exp: number }).exp - Math.floor(Date.now() / 1000);
    expect(lifetime).toBeGreaterThan(590);
    expect(lifetime).toBeLessThanOrEqual(600);
  });

  it("never exposes the API secret", async () => {
    ctx = await startTestServer({ livekit: LIVEKIT });
    const alice = await ctx.connectClient();
    const { state, sessionToken } = await createRoom(alice);
    const { body } = await requestToken(sessionToken, { roomCode: state.code });
    expect(JSON.stringify(body)).not.toContain(LIVEKIT.apiSecret);
  });

  it("rejects requests without a valid session (401)", async () => {
    ctx = await startTestServer({ livekit: LIVEKIT });
    expect((await requestToken(null, { roomCode: "ABCDEFGH" })).status).toBe(401);
    const forged = await requestToken("forged-session-token-aaaaaaaaaaaaaaaaaaaa", { roomCode: "ABCDEFGH" });
    expect(forged.status).toBe(401);
    expect(forged.body.error.code).toBe("SESSION_INVALID");
  });

  it("rejects a valid session asking for a different room (403)", async () => {
    ctx = await startTestServer({ livekit: LIVEKIT });
    const alice = await ctx.connectClient();
    const bob = await ctx.connectClient();
    const aliceRoom = await createRoom(alice, "alice");
    const bobRoom = await createRoom(bob, "bob");

    const res = await requestToken(bobRoom.sessionToken, { roomCode: aliceRoom.state.code });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("NOT_IN_ROOM");
  });

  it("revokes access once the player leaves the room", async () => {
    ctx = await startTestServer({ livekit: LIVEKIT });
    const alice = await ctx.connectClient();
    const bob = await ctx.connectClient();
    const { state } = await createRoom(alice);
    const bobResult = await joinRoom(bob, state.code, "bob");
    expect((await requestToken(bobResult.sessionToken, { roomCode: state.code })).status).toBe(200);

    await emitAck(bob, "room:leave");
    expect((await requestToken(bobResult.sessionToken, { roomCode: state.code })).status).toBe(401);
  });

  it("validates the body (400) and rate-limits (429)", async () => {
    ctx = await startTestServer({ livekit: LIVEKIT });
    const alice = await ctx.connectClient();
    const { state, sessionToken } = await createRoom(alice);

    expect((await requestToken(sessionToken, { roomCode: 42 })).status).toBe(400);

    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await requestToken(sessionToken, { roomCode: state.code })).status);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses.at(-1)).toBe(429);
  });

  it("returns a helpful 503 when LiveKit is not configured", async () => {
    ctx = await startTestServer(); // no livekit settings
    const status = await fetch(`${ctx.url}/api/voice/status`).then((r) => r.json());
    expect(status).toEqual({ enabled: false });

    const alice = await ctx.connectClient();
    const { state, sessionToken } = await createRoom(alice);
    const res = await requestToken(sessionToken, { roomCode: state.code });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("VOICE_NOT_CONFIGURED");
    expect(res.body.error.message).toContain("LIVEKIT_API_KEY");
  });

  it("reports voice as enabled when configured", async () => {
    ctx = await startTestServer({ livekit: LIVEKIT });
    expect(await fetch(`${ctx.url}/api/voice/status`).then((r) => r.json())).toEqual({ enabled: true });
  });
});
