import { AccessToken, RoomServiceClient, TrackSource } from "livekit-server-sdk";
import type { AppConfig } from "../config/env.js";
import type { Player, Room } from "../types/game.types.js";
import { logger } from "../utils/logger.js";
import { GameError } from "./errors.js";

export interface VoiceTokenResult {
  /** JWT the frontend passes to `room.connect(url, token)` in livekit-client. */
  token: string;
  /** LiveKit server URL (public, not a secret). */
  url: string;
  roomName: string;
  identity: string;
  expiresAt: number;
}

/**
 * Issues LiveKit access tokens. The API key/secret never leave the server:
 * the client only ever receives a signed, short-lived JWT.
 *
 * Least privilege: the token can join ONE room and publish ONLY microphone
 * audio. No camera, no screen share, no data channel, no admin rights.
 * Mute and deafen are client-side (mute the local mic track, or stop
 * playing remote tracks), so they need no extra server permissions.
 */
export class VoiceService {
  private readonly roomClient: RoomServiceClient | null;

  constructor(private readonly config: AppConfig["livekit"]) {
    this.roomClient = this.isConfigured()
      ? new RoomServiceClient(toHttpUrl(config.url!), config.apiKey!, config.apiSecret!)
      : null;
  }

  isConfigured(): boolean {
    return Boolean(this.config.url && this.config.apiKey && this.config.apiSecret);
  }

  /** Which settings are missing (for a helpful error/startup warning). Names only, never values. */
  missingSettings(): string[] {
    const missing: string[] = [];
    if (!this.config.url) missing.push("LIVEKIT_URL");
    if (!this.config.apiKey) missing.push("LIVEKIT_API_KEY");
    if (!this.config.apiSecret) missing.push("LIVEKIT_API_SECRET");
    return missing;
  }

  /** One LiveKit room per game room. The prefix avoids clashes with other apps on the same project. */
  static voiceRoomName(roomCode: string): string {
    return `scribble-${roomCode}`;
  }

  async createToken(room: Room, player: Player): Promise<VoiceTokenResult> {
    if (!this.isConfigured()) {
      throw new GameError("VOICE_NOT_CONFIGURED", "Voice chat is not configured on this server.");
    }
    const roomName = VoiceService.voiceRoomName(room.code);
    const ttlSeconds = this.config.tokenTtlSeconds;

    const accessToken = new AccessToken(this.config.apiKey, this.config.apiSecret, {
      identity: player.id, // public ID, so voice participants map 1:1 to game players
      name: player.username,
      ttl: ttlSeconds,
    });
    accessToken.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canPublishSources: [TrackSource.MICROPHONE],
      canSubscribe: true,
      canPublishData: false,
      canUpdateOwnMetadata: false,
    });

    return {
      token: await accessToken.toJwt(),
      url: this.config.url!,
      roomName,
      identity: player.id,
      expiresAt: Date.now() + ttlSeconds * 1000,
    };
  }

  /**
   * A token only gates JOINING: an already-connected LiveKit participant stays
   * connected after the token expires. So when a player leaves the game, we
   * also kick them from the voice room. Best-effort: failures are logged, not thrown.
   */
  removeParticipant(roomCode: string, playerId: string): void {
    if (!this.roomClient) return;
    this.roomClient.removeParticipant(VoiceService.voiceRoomName(roomCode), playerId).catch((err: unknown) => {
      // "not found" just means they never joined voice. That's normal.
      const message = err instanceof Error ? err.message : String(err);
      if (!/not found/i.test(message)) logger.warn(`[voice] could not remove participant: ${message}`);
    });
  }
}

/** RoomServiceClient talks HTTP(S); LiveKit URLs are usually given as ws(s)://. */
function toHttpUrl(url: string): string {
  return url.replace(/^ws(s?):\/\//, "http$1://");
}
