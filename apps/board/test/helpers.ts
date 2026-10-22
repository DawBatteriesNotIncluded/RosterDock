// Test harness: every test file gets its own throwaway database created from
// the admin connection, migrated, and dropped afterwards. No network beyond
// localhost Postgres; global.fetch is never real.

import { randomBytes } from "node:crypto";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { buildApp, type BoardApp } from "../src/app.js";
import type { ApprovalExecutor } from "../src/approvals/service.js";
import type { BoardConfig } from "../src/config.js";
import type { SmtpOptions } from "../src/notify/smtp.js";
import type { PlannerStatus } from "../src/peter/planners.js";
import type { StylePack } from "../src/styles/catalog.js";
import { migrate } from "../src/db/migrate.js";
import { NO_PRIVATE_DESTINATIONS, parsePrivateDestinations, type Resolve } from "../src/web/address.js";
import type { Egress } from "../src/web/egress.js";

/**
 * What a name resolves to in a test that does not say: an address the board's guard takes as public. Only a
 * fake transport is ever handed it; a test with real sockets resolves its names to 127.0.0.1 itself.
 */
export const PUBLIC_TEST_ADDRESS = "93.184.215.14";

/**
 * A company's destinations in a test (web/egress.ts): the fake transport given, every name public unless
 * the test resolves it otherwise, and the private destinations it allows (as ROSTERDOCK_PRIVATE_DESTINATIONS).
 */
export function testEgress(
  transport: typeof fetch,
  opts: { resolve?: Resolve; allow?: string } = {},
): Egress {
  return {
    fetch: transport,
    resolve: opts.resolve ?? (async () => [PUBLIC_TEST_ADDRESS]),
    allow: parsePrivateDestinations(opts.allow),
  };
}

const ADMIN_URL =
  process.env.ROSTERDOCK_TEST_ADMIN_URL ?? "postgres://rosterdock:rosterdock@localhost:5432/postgres";

export interface TestDb {
  url: string;
  name: string;
  drop(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const name = `rosterdock_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    name,
    async drop() {
      const client = new pg.Client({ connectionString: ADMIN_URL });
      await client.connect();
      try {
        await sessionsGone(client, name);
        await client.query(`DROP DATABASE IF EXISTS ${name}`);
      } finally {
        await client.end();
      }
    },
  };
}

/**
 * Wait until no client is left on the database. A board's close() asks each of its connections to end, but
 * pool.end() resolves before the server has let them go: dropping the database WITH (FORCE) in that gap
 * killed them mid-close, and the board's pool raised the kill as an uncaught error. A session still here
 * after the wait was never closed, and the drop names it rather than forcing it out.
 */
async function sessionsGone(admin: pg.Client, name: string, timeoutMs = 10_000): Promise<void> {
  for (const until = Date.now() + timeoutMs; ;) {
    const left = await admin.query<{ application_name: string; state: string | null; query: string }>(
      `SELECT application_name, state, left(query, 120) AS query FROM pg_stat_activity
       WHERE datname = $1 AND backend_type = 'client backend'`,
      [name],
    );
    if (!left.rowCount) return;
    if (Date.now() > until)
      throw new Error(`${left.rowCount} sessions still open on ${name}: ${JSON.stringify(left.rows)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export function testConfig(databaseUrl: string, overrides: Partial<BoardConfig> = {}): BoardConfig {
  return {
    databaseUrl,
    host: "127.0.0.1",
    port: 0,
    logLevel: "silent",
    devLogin: true,
    cookieSecure: false,
    corsOrigin: null,
    sessionTtlSeconds: 3600,
    signInRateLimit: 60,
    workerToken: "test-worker-token",
    reaperIntervalMs: 15_000,
    runStaleAfterMs: 90_000,
    chaseBlockedForMs: 10 * 60_000,
    // Test files run in parallel against one Postgres (100 connections): keep each board small.
    dbPoolMax: 3,
    githubToken: "ghs_test_token",
    githubApiBase: "https://api.github.test",
    gitlabToken: null,
    gitlabApiBase: "https://gitlab.com/api/v4",
    anthropicApiKey: null,
    anthropicApiBase: null,
    peterClaudeBin: null,
    peterCodexBin: null,
    peterIntervalMs: 0,
    notifyWebhookUrl: null,
    notifyEmail: null,
    publicUrl: "http://rosterdock.test",
    oidc: null,
    otlp: null,
    storage: null,
    metricsToken: null,
    fetchSources: true,
    privateDestinations: NO_PRIVATE_DESTINATIONS,
    secretStore: null,
    sharedEnvNames: [],
    stdioCommands: [],
    companyCreators: null,
    ...overrides,
  };
}

export interface TestBoard extends BoardApp {
  db_: TestDb;
  /** Dev-login as a user; returns a bearer token. */
  login(email: string, name?: string): Promise<{ token: string; userId: string }>;
  api(token: string): Api;
  destroy(): Promise<void>;
}

export interface Api {
  get(url: string): Promise<{ status: number; body: any }>;
  post(url: string, body?: unknown): Promise<{ status: number; body: any }>;
  patch(url: string, body?: unknown): Promise<{ status: number; body: any }>;
  put(url: string, body?: unknown): Promise<{ status: number; body: any }>;
  del(url: string): Promise<{ status: number; body: any }>;
}

function makeApi(app: FastifyInstance, token: string | null): Api {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const call = async (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, body?: unknown) => {
    const res = await app.inject({ method, url, headers, ...(body !== undefined ? { payload: body } : {}) });
    let parsed: unknown = res.body;
    try {
      parsed = res.body ? JSON.parse(res.body) : null;
    } catch {
      // non-JSON body (e.g. SSE)
    }
    return { status: res.statusCode, body: parsed as any };
  };
  return {
    get: (url) => call("GET", url),
    post: (url, body) => call("POST", url, body ?? {}),
    patch: (url, body) => call("PATCH", url, body ?? {}),
    put: (url, body) => call("PUT", url, body ?? {}),
    del: (url) => call("DELETE", url),
  };
}

export async function startTestBoard(
  overrides: Partial<BoardConfig> = {},
  opts: {
    githubFetch?: typeof fetch;
    gitlabFetch?: typeof fetch;
    modelFetch?: typeof fetch;
    peterCliPrefixArgs?: string[];
    peterCodexPrefixArgs?: string[];
    plannerStatuses?: () => Promise<PlannerStatus[]>;
    stylesFetch?: typeof fetch;
    styleCatalog?: readonly StylePack[];
    stylesVendorDir?: string;
    approvalExecutor?: ApprovalExecutor;
    mcpFetch?: typeof fetch;
    notifyFetch?: typeof fetch;
    oidcFetch?: typeof fetch;
    otlpFetch?: typeof fetch;
    storageFetch?: typeof fetch;
    webFetch?: typeof fetch;
    webResolve?: (host: string) => Promise<string[]>;
    egressResolve?: Resolve;
    smtp?: SmtpOptions;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<TestBoard> {
  const testDb = await createTestDb();
  // Never the real fetch: a board without a fake GitHub gets one that answers nothing.
  const githubFetch =
    opts.githubFetch ??
    (async () => new Response(JSON.stringify({ message: "no GitHub in this test" }), { status: 503 }));
  // Peter's model is likewise never real: a key without a modelFetch is refused.
  if (overrides.anthropicApiKey && !opts.modelFetch)
    throw new Error("a test board with a model key needs a recorded modelFetch");
  if (overrides.peterClaudeBin && !opts.peterCliPrefixArgs)
    throw new Error("a test board that plans through the Claude CLI needs a recorded replayer");
  if (overrides.peterCodexBin && !opts.peterCodexPrefixArgs)
    throw new Error("a test board that plans through the Codex CLI needs a recorded replayer");
  // Nor are the real CLIs asked whether they are signed in.
  if ((overrides.peterClaudeBin || overrides.peterCodexBin) && !opts.plannerStatuses)
    throw new Error("a test board with a model CLI says what the CLIs answer (plannerStatuses)");
  if (overrides.oidc && !opts.oidcFetch) throw new Error("a test board with OIDC needs a fake provider");
  if (overrides.otlp && !opts.otlpFetch)
    throw new Error("a test board with a collector needs a recording fetch");
  if (overrides.storage && !opts.storageFetch)
    throw new Error("a test board with an object store needs a fake store");
  if (overrides.gitlabToken && !opts.gitlabFetch)
    throw new Error("a test board with a GitLab token needs a fake GitLab");
  const board = await buildApp(testConfig(testDb.url, overrides), {
    logger: false,
    githubFetch,
    ...(opts.gitlabFetch ? { gitlabFetch: opts.gitlabFetch } : {}),
    ...(opts.modelFetch ? { modelFetch: opts.modelFetch } : {}),
    ...(opts.peterCliPrefixArgs ? { peterCliPrefixArgs: opts.peterCliPrefixArgs } : {}),
    ...(opts.peterCodexPrefixArgs ? { peterCodexPrefixArgs: opts.peterCodexPrefixArgs } : {}),
    ...(opts.plannerStatuses ? { plannerStatuses: opts.plannerStatuses } : {}),
    // Nor GitHub: a style pack a test does not fake answers nothing.
    stylesFetch: opts.stylesFetch ?? (async () => new Response("no GitHub in this test", { status: 503 })),
    ...(opts.styleCatalog ? { styleCatalog: opts.styleCatalog } : {}),
    // Nor the build's own copies: a test that wants some names its directory.
    stylesVendorDir: opts.stylesVendorDir ?? null,
    ...(opts.storageFetch ? { storageFetch: opts.storageFetch } : {}),
    // Nor the web: a page a test does not fake answers nothing, and a name it does not resolve is public.
    webFetch: opts.webFetch ?? (async () => new Response("no web in this test", { status: 503 })),
    webResolve: opts.webResolve ?? (async () => [PUBLIC_TEST_ADDRESS]),
    // Nor a company's destinations: a name a test does not resolve is public, and nothing reaches the network.
    egressResolve: opts.egressResolve ?? (async () => [PUBLIC_TEST_ADDRESS]),
    ...(opts.approvalExecutor ? { approvalExecutor: opts.approvalExecutor } : {}),
    // Never the real fetch: a board without a fake MCP server gets one that answers nothing.
    mcpFetch:
      opts.mcpFetch ??
      (async () => new Response(JSON.stringify({ error: "no MCP server in this test" }), { status: 503 })),
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.smtp ? { smtp: opts.smtp } : {}),
    ...(opts.oidcFetch ? { oidcFetch: opts.oidcFetch } : {}),
    ...(opts.otlpFetch ? { otlpFetch: opts.otlpFetch } : {}),
    // Nor the webhook: a board without a recording fetch posts to one that records nothing.
    notifyFetch: opts.notifyFetch ?? (async () => new Response("ok", { status: 200 })),
  });
  await migrate(board.db);
  await board.app.ready();
  return {
    ...board,
    db_: testDb,
    async login(email, name) {
      const res = await board.app.inject({
        method: "POST",
        url: "/api/auth/dev-login",
        payload: { email, name },
      });
      if (res.statusCode !== 200) throw new Error(`dev-login failed: ${res.statusCode} ${res.body}`);
      const body = JSON.parse(res.body) as { token: string; user: { id: string } };
      return { token: body.token, userId: body.user.id };
    },
    api(token) {
      return makeApi(board.app, token);
    },
    async destroy() {
      await board.close();
      await testDb.drop();
    },
  };
}

/** Claim a queued run as the worker fleet; returns the run token and pack. */
export async function workerClaim(board: TestBoard, runId: string) {
  const job = (
    await board.db.query<{ job_id: string | null }>("SELECT job_id FROM runs WHERE id = $1", [runId])
  ).rows[0];
  const res = await board.app.inject({
    method: "POST",
    url: "/api/worker/claim",
    headers: { "x-rosterdock-worker-token": "test-worker-token" },
    payload: { runId, jobId: job?.job_id ?? "00000000-0000-4000-8000-000000000000", workerId: "w" },
  });
  if (res.statusCode !== 201) throw new Error(`claim failed: ${res.statusCode} ${res.body}`);
  const body = JSON.parse(res.body) as { token: string; pack: string; spec: Record<string, unknown> };
  return { ...body, api: board.api(body.token) };
}

/** Finish a claimed run as the worker would. */
export async function workerComplete(
  board: TestBoard,
  token: string,
  runId: string,
  body: Record<string, unknown> = { status: "completed", summary: "done" },
) {
  // As the worker does right after cloning: the commit the run's changes stand on.
  if (typeof body.baseSha === "string")
    await board.api(token).post(`/api/worker/runs/${runId}/cloned`, { sha: body.baseSha });
  const res = await board.api(token).post(`/api/worker/runs/${runId}/complete`, { usage: {}, ...body });
  if (res.status !== 200) throw new Error(`complete failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** A company with an owner, ready for tests. */
export async function seedCompany(board: TestBoard, ownerEmail = "owner@example.com") {
  const owner = await board.login(ownerEmail, "Daniel");
  const api = board.api(owner.token);
  const created = await api.post("/api/companies", { name: "GTM Studio", template: "GTM company" });
  if (created.status !== 201) throw new Error(`company create failed: ${JSON.stringify(created.body)}`);
  const companyId = created.body.id as string;
  return { owner, api, companyId, base: `/api/companies/${companyId}` };
}

/** The project manager seated with the company. */
export async function seatedPeter(api: Api, base: string) {
  const mates = (await api.get(`${base}/teammates`)).body as { id: string; handle: string; name: string }[];
  const peter = mates.find((t) => t.handle === "peter");
  if (!peter) throw new Error("no Peter seated with the company");
  return peter;
}

export async function addTeammate(api: Api, base: string, name: string, role = "n8n engineer") {
  const res = await api.post(`${base}/teammates`, { name, role, model: "claude-sonnet-5" });
  if (res.status !== 201) throw new Error(`teammate create failed: ${JSON.stringify(res.body)}`);
  return res.body as { id: string; handle: string; name: string };
}

export async function addProject(api: Api, base: string, name = "VMS architecture map") {
  const res = await api.post(`${base}/projects`, { name, client: "Globex" });
  if (res.status !== 201) throw new Error(`project create failed: ${JSON.stringify(res.body)}`);
  return res.body as { id: string };
}
