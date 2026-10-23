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

describe("0037_read_only_label", () => {
  it("holds a tool kept as a read on a server's read-only label alone as a write, and keeps every other word", async () => {
    await migrate(pool, await migrationsUpTo("0037_read_only_label.sql", false));
    const company = (
      await pool.query<{ id: string }>("INSERT INTO companies (name) VALUES ('Labels') RETURNING id")
    ).rows[0]!.id;
    const old = "2026-10-01T00:00:00.000Z";
    const connection = async (name: string, catalogId: string | null, kind: string, tools: unknown[]) =>
      (
        await pool.query<{ id: string }>(
          `INSERT INTO connections (company_id, name, catalog_id, kind, url, tools, discovered_at, updated_at)
           VALUES ($1, $2, $3, $4, 'https://mcp.example.test/mcp', $5, $6, $6) RETURNING id`,
          [company, name, catalogId, kind, JSON.stringify(tools), old],
        )
      ).rows[0]!.id;
    const tool = (name: string, write: boolean, source: string, more: Record<string, unknown> = {}) => ({
      name,
      description: "",
      write,
      source,
      ...more,
    });
    const github = [
      // The label alone: GitHub's server calls these read-only and neither the name nor the catalog agrees.
      tool("issue_read", false, "annotation", { description: "Read an issue" }),
      tool("pull_request_read", false, "annotation", { off: true }),
      // A second sign: the name reads, or the catalog lists it as a read.
      tool("list_branches", false, "annotation"),
      tool("get_issue", false, "annotation"),
      // A tool the catalog knows writes, labelled read-only by the server.
      tool("merge_pull_request", false, "annotation"),
      // The server's word that it writes, a person's, the catalog's and the default stay.
      tool("create_issue", true, "annotation"),
      tool("issue_comments", false, "person"),
      tool("search_code", false, "catalog"),
      tool("get_or_create_label", true, "default"),
    ];
    const slack = [
      tool("slack_read_channel", false, "annotation"),
      tool("slack_send_message", false, "annotation"),
      tool("slack_whoami", false, "annotation"),
    ];
    // No catalog entry: the catalog's word belongs to the connector a connection was added from.
    const crm = [
      tool("crm:read_notes", false, "annotation"),
      tool("slack_read_channel", false, "annotation"),
    ];
    const openapi = [tool("list_contacts", false, "method"), tool("create_contact", true, "method")];
    const ids = {
      github: await connection("github", "github", "mcp", github),
      slack: await connection("slack", "slack", "mcp", slack),
      crm: await connection("crm", null, "mcp", crm),
      openapi: await connection("books", null, "openapi", openapi),
      clean: await connection("gong", "gong", "mcp", [tool("list_calls", false, "annotation")]),
    };

    expect((await migrate(pool, await migrationsUpTo("0037_read_only_label.sql", true))).applied).toEqual([
      "0037_read_only_label.sql",
    ]);

    const row = async (id: string) =>
      (
        await pool.query<{ tools: unknown[]; updated_at: Date }>(
          "SELECT tools, updated_at FROM connections WHERE id = $1",
          [id],
        )
      ).rows[0]!;
    const held = { write: true, source: "unconfirmed" };
    expect((await row(ids.github)).tools).toEqual([
      { ...github[0], ...held },
      { ...github[1], ...held },
      github[2],
      github[3],
      { ...github[4], write: true, source: "catalog" },
      ...github.slice(5),
    ]);
    expect((await row(ids.slack)).tools).toEqual([
      slack[0],
      { ...slack[1], write: true, source: "catalog" },
      { ...slack[2], ...held },
    ]);
    expect((await row(ids.crm)).tools).toEqual([crm[0], { ...crm[1], ...held }]);
    // A connection with nothing to hold is left as it was, its update time too.
    for (const [id, tools] of [
      [ids.openapi, openapi],
      [ids.clean, [tool("list_calls", false, "annotation")]],
    ] as const) {
      const r = await row(id);
      expect(r.tools).toEqual(tools);
      expect(r.updated_at.toISOString()).toBe(old);
    }
    expect((await row(ids.github)).updated_at.toISOString()).not.toBe(old);
  });
});

describe("0039_planning_usage", () => {
  it("carries what goals and org proposals spent planning into usage Costs and budgets read", async () => {
    await migrate(pool, await migrationsUpTo("0039_planning_usage.sql", false));
    const one = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
      (await pool.query<T>(sql, params)).rows[0]!;
    const company = (
      await one<{ id: string }>("INSERT INTO companies (name) VALUES ('Planned') RETURNING id")
    ).id;
    const project = (
      await one<{ id: string }>(
        "INSERT INTO projects (company_id, name) VALUES ($1, 'Digest') RETURNING id",
        [company],
      )
    ).id;
    const peter = (
      await one<{ id: string }>(
        `INSERT INTO teammates (company_id, name, handle, role, engine, model)
         VALUES ($1, 'Peter', 'peter', 'project manager', 'claude_code', 'claude-opus-5-5') RETURNING id`,
        [company],
      )
    ).id;
    const person = "00000000-0000-4000-8000-000000000001";
    const goal = async (title: string, planner: string | null, usage: object, plannedAt: string | null) =>
      (
        await one<{ id: string }>(
          `INSERT INTO goals (company_id, project_id, opened_project, text, title, planner, planning_usage, planned_at,
                              created_at, created_by_kind, created_by_id)
           VALUES ($1, $2, false, $3, $3, $4, $5, $6, '2026-09-20T09:00:00Z', 'user', $7) RETURNING id`,
          [company, project, title, planner, JSON.stringify(usage), plannedAt, person],
        )
      ).id;
    // Planned by the model; planned by role after the model's plans were refused; never planned with one.
    const byModel = await goal(
      "By model",
      "model:claude-opus-5",
      { inputTokens: 1690, outputTokens: 940, calls: 1 },
      "2026-09-21T10:00:00Z",
    );
    const refused = await goal(
      "Refused",
      "heuristic (the model's plan was refused: task 1 names @nobody)",
      { inputTokens: 3000, outputTokens: 800, cacheReadTokens: 200, calls: 2 },
      null,
    );
    await goal("By role", "heuristic", {}, "2026-09-21T10:00:00Z");
    await pool.query(
      `INSERT INTO drafts (company_id, kind, brief, proposal, planner, usage, created_by_kind, created_by_id, created_at)
       VALUES ($1, 'org', 'Staff it', '{}', 'model:claude-opus-5', $2, 'teammate', $3, '2026-09-22T08:00:00Z'),
              ($1, 'audit', '', '{}', 'audit', '{}', 'teammate', $3, '2026-09-22T08:00:00Z')`,
      [company, JSON.stringify({ inputTokens: 2100, outputTokens: 700, calls: 1 }), peter],
    );

    expect((await migrate(pool, await migrationsUpTo("0039_planning_usage.sql", true))).applied).toEqual([
      "0039_planning_usage.sql",
    ]);

    const rows = (
      await pool.query(
        `SELECT purpose, goal_id, project_id, teammate_id, model, calls, input_tokens::int, output_tokens::int,
                cache_read_tokens::int, created_at
         FROM planning_usage WHERE company_id = $1 ORDER BY created_at, purpose`,
        [company],
      )
    ).rows;
    expect(rows).toEqual([
      // Still waiting on its plan when the model was refused: dated when it was opened, on Peter's model.
      {
        purpose: "plan",
        goal_id: refused,
        project_id: project,
        teammate_id: peter,
        model: "claude-opus-5-5",
        calls: 2,
        input_tokens: 3000,
        output_tokens: 800,
        cache_read_tokens: 200,
        created_at: new Date("2026-09-20T09:00:00Z"),
      },
      {
        purpose: "plan",
        goal_id: byModel,
        project_id: project,
        teammate_id: peter,
        model: "claude-opus-5",
        calls: 1,
        input_tokens: 1690,
        output_tokens: 940,
        cache_read_tokens: 0,
        created_at: new Date("2026-09-21T10:00:00Z"),
      },
      {
        purpose: "org",
        goal_id: null,
        project_id: null,
        teammate_id: peter,
        model: "claude-opus-5",
        calls: 1,
        input_tokens: 2100,
        output_tokens: 700,
        cache_read_tokens: 0,
        created_at: new Date("2026-09-22T08:00:00Z"),
      },
    ]);
  });
});
