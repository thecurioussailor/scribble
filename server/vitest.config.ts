import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Integration tests open real sockets on random ports; keep them isolated.
    pool: "forks",
    testTimeout: 10_000,
  },
});
