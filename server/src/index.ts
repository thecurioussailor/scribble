import { loadConfig } from "./config/env.js";
import { createGameServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const server = createGameServer(config);
  const port = await server.listen();
  console.log(`[server] listening on http://${config.host}:${port} (${config.nodeEnv})`);

  // Graceful shutdown: Render sends SIGTERM before replacing an instance.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal} received, shutting down...`);
    const forceExit = setTimeout(() => process.exit(1), 10_000);
    forceExit.unref();
    await server.close();
    console.log("[server] closed cleanly");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // A rejected promise nobody awaited: log it, but keep serving.
  process.on("unhandledRejection", (reason) => {
    console.error("[server] unhandled promise rejection:", reason);
  });
  // A synchronous crash may have left game state half-updated, so exit and
  // let Render restart a clean process instead of serving corrupted rooms.
  process.on("uncaughtException", (err) => {
    console.error("[server] uncaught exception, exiting:", err);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error("[server] failed to start:", err);
  process.exit(1);
});
