import pg from "pg";

const { Pool, types } = pg;

// bigint (event seq) comes back as a JS number; task numbers and seqs never
// approach 2^53 in practice.
types.setTypeParser(20, (value) => Number(value));

export type Db = pg.Pool;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string, max = 10): Db {
  return new Pool({ connectionString, max });
}

/** Run `fn` inside a transaction. Rolls back on throw. */
export async function withTransaction<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The original error is the one that matters.
    }
    throw err;
  } finally {
    client.release();
  }
}
