// Migrations that move data, run on rows written in the shape before them: the
// database is migrated up to the one under test, seeded with plain SQL, then
// migrated through it. No board, no network.
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_MIGRATIONS_DIR, migrate } from "../src/db/migrate.js";
import { createTestDb, type TestDb } from "./helpers.js";

let testDb: TestDb;
let pool: pg.Pool;
const dirs: string[] = [];

/** A directory with the migrations before `name`, and `name` too when it says so: where to stop. */
async function migrationsUpTo(name: string, through: boolean): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rosterdock-migrations-"));
  dirs.push(dir);
  for (const file of await readdir(DEFAULT_MIGRATIONS_DIR))
    if (/^\d{4}_.+\.sql$/.test(file) && (file < name || (through && file === name)))
      await copyFile(path.join(DEFAULT_MIGRATIONS_DIR, file), path.join(dir, file));
  return dir;
}

beforeAll(async () => {
  testDb = await createTestDb();
  pool = new pg.Pool({ connectionString: testDb.url, max: 2 });
});
afterAll(async () => {
  await pool.end();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  await testDb.drop();
});

describe("0033_task_goal", () => {
  it("gives every task in a goal's project that goal, and moves a goal's token cap onto the goal", async () => {
    await migrate(pool, await migrationsUpTo("0033_task_goal.sql", false));
    const one = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
      (await pool.query<T>(sql, params)).rows[0]!;
    const company = (await one<{ id: string }>("INSERT INTO companies (name) VALUES ('Old') RETURNING id"))
      .id;
    const project = async (name: string) =>
      (
        await one<{ id: string }>("INSERT INTO projects (company_id, name) VALUES ($1, $2) RETURNING id", [
          company,
          name,
        ])
      ).id;
    const [first, second, byHand] = [
      await project("First"),
      await project("Second"),
      await project("By hand"),
    ];
    const person = "00000000-0000-4000-8000-000000000001";
    const goal = async (projectId: string, title: string) =>
      (
        await one<{ id: string }>(
          `INSERT INTO goals (company_id, project_id, text, title, created_by_kind, created_by_id)
           VALUES ($1, $2, $3, $3, 'user', $4) RETURNING id`,
          [company, projectId, title, person],
        )
      ).id;
    const [goalOne, goalTwo] = [await goal(first, "One"), await goal(second, "Two")];
    let number = 0;
    const task = async (projectId: string) =>
      (
        await one<{ id: string }>(
          `INSERT INTO tasks (company_id, project_id, number, title, created_by_kind, created_by_id)
           VALUES ($1, $2, $3, 'A task', 'user', $4) RETURNING id`,
          [company, projectId, ++number, person],
        )
      ).id;
    const tasks = {
      first: [await task(first), await task(first)],
      second: await task(second),
      byHand: await task(byHand),
    };
    // Goal one's cap, as a project budget; a person's weekly budget on the hand-made project.
    await pool.query(
      `INSERT INTO budgets (company_id, scope_kind, scope_id, tokens_limit, window_kind)
       VALUES ($1, 'project', $2, 1000, 'goal'), ($1, 'project', $3, 5000, 'week')`,
      [company, first, byHand],
    );

    expect((await migrate(pool, await migrationsUpTo("0033_task_goal.sql", true))).applied).toEqual([
      "0033_task_goal.sql",
    ]);

    const goalOf = async (id: string) =>
      (await one<{ goal_id: string | null }>("SELECT goal_id FROM tasks WHERE id = $1", [id])).goal_id;
    for (const id of tasks.first) expect(await goalOf(id)).toBe(goalOne);
    expect(await goalOf(tasks.second)).toBe(goalTwo);
    expect(await goalOf(tasks.byHand)).toBeNull();
    const budgets = (
      await pool.query(
        "SELECT scope_kind, scope_id, tokens_limit::int, window_kind FROM budgets ORDER BY tokens_limit",
      )
    ).rows;
    expect(budgets).toEqual([
      { scope_kind: "goal", scope_id: goalOne, tokens_limit: 1000, window_kind: "goal" },
      { scope_kind: "project", scope_id: byHand, tokens_limit: 5000, window_kind: "week" },
    ]);
  });
});

describe("0036_stub_usage", () => {
  it("moves a stub run's usage off its teammate's model and drops the price it was given", async () => {
    await migrate(pool, await migrationsUpTo("0036_stub_usage.sql", false));
    const one = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
      (await pool.query<T>(sql, params)).rows[0]!;
    const company = (await one<{ id: string }>("INSERT INTO companies (name) VALUES ('Stubs') RETURNING id"))
      .id;
    const project = (
      await one<{ id: string }>("INSERT INTO projects (company_id, name) VALUES ($1, 'Demo') RETURNING id", [
        company,
      ])
    ).id;
    const person = "00000000-0000-4000-8000-000000000001";
    const task = (
      await one<{ id: string }>(
        `INSERT INTO tasks (company_id, project_id, number, title, created_by_kind, created_by_id)
         VALUES ($1, $2, 1, 'A task', 'user', $3) RETURNING id`,
        [company, project, person],
      )
    ).id;
    // One teammate on the stub, one on Claude Code, both naming the same model.
    const mate = async (name: string, engine: string) =>
      (
        await one<{ id: string }>(
          `INSERT INTO teammates (company_id, name, handle, role, engine, model)
           VALUES ($1, $2, lower($2), 'Engineer', $3, 'claude-sonnet-5-5') RETURNING id`,
          [company, name, engine],
        )
      ).id;
    const run = async (teammate: string, engine: string) => {
      const id = (
        await one<{ id: string }>(
          `INSERT INTO runs (company_id, task_id, teammate_id, engine, model, status, cost_minor_units, created_by_kind, created_by_id)
           VALUES ($1, $2, $3, $4, 'claude-sonnet-5-5', 'completed', 45, 'user', $5) RETURNING id`,
          [company, task, teammate, engine, person],
        )
      ).id;
      await pool.query(
        `INSERT INTO run_usage (company_id, run_id, task_id, teammate_id, project_id, model, input_tokens, output_tokens, cost_minor_units)
         VALUES ($1, $2, $3, $4, $5, 'claude-sonnet-5-5', 1200, 300, 45)`,
        [company, id, task, teammate, project],
      );
      return id;
    };
    const stubRun = await run(await mate("Stubby", "stub"), "stub");
    const realRun = await run(await mate("Cody", "claude_code"), "claude_code");

    expect((await migrate(pool, await migrationsUpTo("0036_stub_usage.sql", true))).applied).toEqual([
      "0036_stub_usage.sql",
    ]);

    const usageOf = (id: string) =>
      one("SELECT model, input_tokens::int, cost_minor_units::int FROM run_usage WHERE run_id = $1", [id]);
    const costOf = async (id: string) =>
      (
        await one<{ cost: number | null }>("SELECT cost_minor_units::int AS cost FROM runs WHERE id = $1", [
          id,
        ])
      ).cost;
    expect(await usageOf(stubRun)).toEqual({ model: "stub", input_tokens: 1200, cost_minor_units: null });
    expect(await costOf(stubRun)).toBeNull();
    expect(await usageOf(realRun)).toEqual({
      model: "claude-sonnet-5-5",
      input_tokens: 1200,
      cost_minor_units: 45,
    });
    expect(await costOf(realRun)).toBe(45);
  });
});
