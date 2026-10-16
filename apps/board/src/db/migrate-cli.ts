import { loadConfig } from "../config.js";
import { migrate } from "./migrate.js";
import { createPool } from "./pool.js";

const config = loadConfig();
const db = createPool(config.databaseUrl);
try {
  const result = await migrate(db);
  console.warn(`migrations applied: ${result.applied.length ? result.applied.join(", ") : "none"}`);
  console.warn(`already applied: ${result.skipped.length}`);
} finally {
  await db.end();
}
