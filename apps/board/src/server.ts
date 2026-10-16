import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { migrate } from "./db/migrate.js";

const config = loadConfig();
const board = await buildApp(config);
const applied = await migrate(board.db);
if (applied.applied.length) board.app.log.info({ applied: applied.applied }, "migrations applied");

await board.app.listen({ host: config.host, port: config.port });

const shutdown = async (): Promise<void> => {
  board.app.log.info("shutting down");
  await board.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
