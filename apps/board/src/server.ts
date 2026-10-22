import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { migrate } from "./db/migrate.js";

const config = loadConfig();
const board = await buildApp(config);
const applied = await migrate(board.db);
if (applied.applied.length) board.app.log.info({ applied: applied.applied }, "migrations applied");
// A private destination given to a company the board does not have allows nothing; say so once.
const named = Object.keys(config.privateDestinations.companies ?? {});
if (named.length) {
  const known = new Set(
    (
      await board.db.query<{ id: string }>("SELECT id FROM companies WHERE id = ANY($1::uuid[])", [named])
    ).rows.map((r) => r.id),
  );
  for (const id of named.filter((n) => !known.has(n)))
    board.app.log.warn(
      `ROSTERDOCK_PRIVATE_DESTINATIONS gives entries to company ${id}, which this board does not have`,
    );
}

await board.app.listen({ host: config.host, port: config.port });

const shutdown = async (): Promise<void> => {
  board.app.log.info("shutting down");
  await board.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
