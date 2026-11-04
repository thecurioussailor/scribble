import { describe, expect, it } from "vitest";
import {
  chatSendSchema,
  drawMoveSchema,
  drawStartSchema,
  joinRoomSchema,
  usernameSchema,
} from "../src/validation/schemas.js";

describe("input validation", () => {
  it("trims usernames and rejects bad ones", () => {
    expect(usernameSchema.parse("  alice ")).toBe("alice");
    expect(usernameSchema.safeParse("").success).toBe(false);
    expect(usernameSchema.safeParse("a".repeat(21)).success).toBe(false);
    expect(usernameSchema.safeParse("<script>").success).toBe(false);
  });

  it("normalizes room codes to upper case", () => {
    const parsed = joinRoomSchema.parse({ roomCode: " abcdefgh ", username: "bob" });
    expect(parsed.roomCode).toBe("ABCDEFGH");
    expect(joinRoomSchema.safeParse({ roomCode: "ABC", username: "bob" }).success).toBe(false);
  });

  it("rejects out-of-range coordinates, bad colors and brush sizes", () => {
    const valid = { strokeId: "s1", color: "#ff0000", size: 4, point: { x: 0.5, y: 0.5 } };
    expect(drawStartSchema.safeParse(valid).success).toBe(true);
    expect(drawStartSchema.safeParse({ ...valid, point: { x: 1.5, y: 0 } }).success).toBe(false);
    expect(drawStartSchema.safeParse({ ...valid, point: { x: Number.NaN, y: 0 } }).success).toBe(false);
    expect(drawStartSchema.safeParse({ ...valid, color: "red" }).success).toBe(false);
    expect(drawStartSchema.safeParse({ ...valid, size: 500 }).success).toBe(false);
  });

  it("caps points per draw:move batch", () => {
    const points = Array.from({ length: 65 }, () => ({ x: 0.1, y: 0.1 }));
    expect(drawMoveSchema.safeParse({ strokeId: "s1", points }).success).toBe(false);
  });

  it("strips control characters from chat and enforces length", () => {
    expect(chatSendSchema.parse({ content: " hi\u0000 there‮ " }).content).toBe("hi there");
    expect(chatSendSchema.safeParse({ content: "x".repeat(201) }).success).toBe(false);
    expect(chatSendSchema.safeParse({ content: "   " }).success).toBe(false);
  });
});
