// What the operator lets a company reach. An owner or admin manages their own
// company, never the board: the names they write resolve from the company's
// secrets and the names the operator shares (ROSTERDOCK_SHARED_ENV_NAMES), never
// from the rest of the board's environment, and a name that is the board's own
// is refused when it is written; a stdio connection runs inside the board, so
// only a command line the operator lists (ROSTERDOCK_STDIO_COMMANDS) is ever
// started. Who may found a company is the operator's call too
// (ROSTERDOCK_COMPANY_CREATORS), and a public sign-in provider with no domain list
// does not start. The MCP server and the webhook are fakes behind injected
// fetches; the one stdio server is the fixture replayer. No network.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCompanyCreators } from "@rosterdock/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emailFrom } from "../src/auth/oidc.js";
import { createSession } from "../src/auth/tokens.js";
import { loadConfig } from "../src/config.js";
import { callConnectionTool } from "../src/mcp/call.js";
import { callMcpTool, discoverTools, mcpClientPool } from "../src/mcp/client.js";
import { loadConnection } from "../src/mcp/connections.js";
import { withCompanyEnv } from "../src/secrets/company.js";
import { fakeMcp } from "./mcp-fake.js";
import { seedCompany, startTestBoard, type TestBoard } from "./helpers.js";

const DB_URL = "postgres://rosterdock:board-db-secret-000@db.internal:5432/rosterdock";
const WORKER_TOKEN = "board-worker-token-000000";
const SHARED = "shared-mcp-token-000000";
const dir = mkdtempSync(path.join(os.tmpdir(), "rosterdock-operator-"));
const stdioScript = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "mcp",
  "stdio-server.mjs",
);
/** What the operator lists: the fixture server exactly, and the filesystem server on any folders. */
const STDIO = [
  { command: process.execPath, args: [stdioScript], more: false },
  { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem@2026.8.31"], more: true },
];
/** A command that leaves a file behind if it ever starts. */
const marker = path.join(dir, "started");
const shell = {
  command: process.execPath,
  args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'x')", marker],
};
const mcp = fakeMcp();
const posts: string[] = [];
let board: TestBoard;

beforeAll(async () => {
  board = await startTestBoard(
    { secretStore: { kind: "file", dir }, sharedEnvNames: ["SHARED_MCP_TOKEN"], stdioCommands: STDIO },
    {
      mcpFetch: mcp.fetch,
      notifyFetch: async (input) => {
        posts.push(String(input));
        return new Response("ok", { status: 200 });
      },
      env: { DATABASE_URL: DB_URL, ROSTERDOCK_WORKER_TOKEN: WORKER_TOKEN, SHARED_MCP_TOKEN: SHARED },
    },
  );
});
afterAll(async () => {
  await board.destroy();
  rmSync(dir, { recursive: true, force: true });
});

/** Every header and body the fake MCP server has seen, as one string. */
const seenByServer = () => JSON.stringify(mcp.requests);

describe("env var names a company writes", () => {
  it("an owner cannot name DATABASE_URL, or any name the board keeps: refused on every write, never sent", async () => {
    const { api, base } = await seedCompany(board, "op1@example.com");
    const refusedBecause = (res: { status: number; body: { error: string } }, name: string) => {
      expect(res.status).toBe(403);
      expect(res.body.error).toContain(`${name} is the board's own`);
    };
    refusedBecause(
      await api.post(`${base}/connections`, {
        name: "exfil",
        url: "https://attacker.test/mcp",
        authEnvName: "DATABASE_URL",
      }),
      "DATABASE_URL",
    );
    refusedBecause(
      await api.post(`${base}/connections`, {
        name: "exfil",
        url: "https://attacker.test/mcp",
        envNames: ["ROSTERDOCK_WORKER_TOKEN"],
      }),
      "ROSTERDOCK_WORKER_TOKEN",
    );
    refusedBecause(
      await api.post(`${base}/connections`, {
        name: "exfil",
        url: "https://attacker.test/mcp",
        oauth: { clientId: "x", clientSecretEnvName: "DATABASE_URL" },
      }),
      "DATABASE_URL",
    );
    refusedBecause(
      await api.post(`${base}/connections/openapi`, {
        name: "exfil",
        url: "https://attacker.test",
        authEnvName: "DATABASE_URL",
        spec: { openapi: "3.0.0", info: { title: "x", version: "1" }, paths: {} },
        allow: ["x"],
      }),
      "DATABASE_URL",
    );
    // A connection that exists cannot be pointed at one either.
    const ok = await api.post(`${base}/connections`, { name: "crm", url: "https://attacker.test/mcp" });
    expect(ok.status).toBe(201);
    refusedBecause(
      await api.patch(`${base}/connections/${ok.body.id}`, { authEnvName: "DATABASE_URL" }),
      "DATABASE_URL",
    );
    // Nor a notification target.
    refusedBecause(
      await api.patch(base, { settings: { notify: { webhookEnvName: "DATABASE_URL" } } }),
      "DATABASE_URL",
    );
    refusedBecause(
      await api.patch(base, {
        settings: { notify: { email: { smtpUrlEnvName: "DATABASE_URL", to: ["ops@example.test"] } } },
      }),
      "DATABASE_URL",
    );
    expect(seenByServer()).not.toContain("board-db-secret");
  });

  it("a row from before names the board's own: it resolves to nothing, and nothing is sent", async () => {
    const { api, base, companyId } = await seedCompany(board, "op2@example.com");
    const row = (
      await board.db.query<{ id: string }>(
        `INSERT INTO connections (company_id, name, kind, transport, url, auth_env_name)
         VALUES ($1, 'old', 'mcp', 'http', 'https://attacker.test/mcp', 'DATABASE_URL') RETURNING id`,
        [companyId],
      )
    ).rows[0]!;
    const before = mcp.requests.length;
    const res = await api.post(`${base}/connections/${row.id}/discover`, {});
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("DATABASE_URL is not set for this company");
    expect(mcp.requests.length).toBe(before);
    const checked = await api.post(`${base}/connections/${row.id}/check`, {});
    expect(checked.body.lastCheck).toMatchObject({ ok: false });
    expect(mcp.requests.length).toBe(before);
    // The same for a webhook named in the settings before: no notification, never a post to that value.
    await board.db.query(
      `UPDATE companies SET settings = '{"notify":{"webhookEnvName":"DATABASE_URL"}}' WHERE id = $1`,
      [companyId],
    );
    const sent = await api.post(`${base}/notify/test`, {});
    expect(sent.body.sent).toBe(false);
    expect(posts.join(" ")).not.toContain("board-db-secret");
    // A change elsewhere in the settings leaves the name as it was rather than refusing the change.
    const drift = await api.patch(base, {
      settings: { notify: { webhookEnvName: "DATABASE_URL" }, drift: { ratioFloor: 3 } },
    });
    expect(drift.status).toBe(200);
  });

  it("a file's connection that names the board's own is skipped with a note; the rest of the file lands", async () => {
    const { api, base } = await seedCompany(board, "op3@example.com");
    const report = await api.post(`${base}/templates/import`, {
      format: "rosterdock/templates/1",
      connections: [
        { name: "exfil", url: "https://attacker.test/mcp", authEnvName: "DATABASE_URL" },
        { name: "crm", url: "https://crm.test/mcp", authEnvName: "SHARED_MCP_TOKEN" },
      ],
    });
    expect(report.status).toBe(200);
    expect(report.body.created.connections).toEqual(["crm"]);
    expect(report.body.notes).toEqual([
      expect.stringMatching(/^connection exfil: DATABASE_URL is the board's own .*; skipped$/),
    ]);
    const names = ((await api.get(`${base}/connections`)).body as { name: string }[]).map((c) => c.name);
    expect(names).toEqual(["crm"]);
  });

  it("a name the operator shares reaches every company; a company's own secret is its own; nothing else is the board's", async () => {
    const { api, base } = await seedCompany(board, "op4@example.com");
    const shared = await api.post(`${base}/connections`, {
      name: "crm",
      url: "https://mcp.hubspot.test/mcp",
      authEnvName: "SHARED_MCP_TOKEN",
    });
    expect(shared.status).toBe(201);
    expect((await api.post(`${base}/connections/${shared.body.id}/discover`, {})).status).toBe(200);
    expect(mcp.requests.at(-1)?.headers.authorization).toBe(`Bearer ${SHARED}`);
    // A name the board does not hold is the company's to set.
    const own = await api.post(`${base}/connections`, {
      name: "own",
      url: "https://mcp.hubspot.test/mcp",
      authEnvName: "ACME_MCP_TOKEN",
    });
    expect(own.status).toBe(201);
    expect((await api.post(`${base}/connections/${own.body.id}/discover`, {})).status).toBe(409);
    expect((await api.put(`${base}/secrets/ACME_MCP_TOKEN`, { value: "acme-own-000000" })).status).toBe(200);
    expect((await api.post(`${base}/connections/${own.body.id}/discover`, {})).status).toBe(200);
    expect(mcp.requests.at(-1)?.headers.authorization).toBe("Bearer acme-own-000000");
    // A company that sets a value under one of the board's names gets its own value, never the board's.
    expect(
      (await api.put(`${base}/secrets/ROSTERDOCK_WORKER_TOKEN`, { value: "company-own-000000" })).status,
    ).toBe(200);
    const mine = await api.post(`${base}/connections`, {
      name: "mine",
      url: "https://mcp.hubspot.test/mcp",
      authEnvName: "ROSTERDOCK_WORKER_TOKEN",
    });
    expect(mine.status).toBe(201);
    expect((await api.post(`${base}/connections/${mine.body.id}/discover`, {})).status).toBe(200);
    expect(mcp.requests.at(-1)?.headers.authorization).toBe("Bearer company-own-000000");
    expect(seenByServer()).not.toContain(WORKER_TOKEN);
    // What the board shares is a name in its features, never a value, and only for people who manage connections.
    expect((await api.get("/api/features")).body.sharedEnvNames).toEqual(["SHARED_MCP_TOKEN"]);
    const viewer = await board.login("op4-viewer@example.com");
    await api.post(`${base}/members`, { email: "op4-viewer@example.com", role: "viewer" });
    const seen = (await board.api(viewer.token).get("/api/features")).body;
    expect(seen).toEqual({ oauth: true, objectStore: false });
  });

  it("the board will not start sharing one of its own names", () => {
    const env = { DATABASE_URL: DB_URL };
    expect(
      loadConfig({ ...env, ROSTERDOCK_SHARED_ENV_NAMES: " HUBSPOT_MCP_TOKEN, N8N_MCP_TOKEN " })
        .sharedEnvNames,
    ).toEqual(["HUBSPOT_MCP_TOKEN", "N8N_MCP_TOKEN"]);
    expect(loadConfig(env).sharedEnvNames).toEqual([]);
    for (const own of [
      "DATABASE_URL",
      "ROSTERDOCK_WORKER_TOKEN",
      "S3_SECRET_KEY",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
    ])
      expect(() => loadConfig({ ...env, ROSTERDOCK_SHARED_ENV_NAMES: `HUBSPOT_MCP_TOKEN,${own}` })).toThrow(
        `${own} is the board's own`,
      );
    expect(() => loadConfig({ ...env, ROSTERDOCK_SHARED_ENV_NAMES: "not a name" })).toThrow(
      "not an env var name",
    );
  });
});

describe("stdio connections", () => {
  it("a command line the operator does not list never starts: refused on create, change, discover, check, call and import", async () => {
    const { api, base, companyId } = await seedCompany(board, "op6@example.com");
    const made = await api.post(`${base}/connections`, { name: "shell", transport: "stdio", ...shell });
    expect(made.status).toBe(403);
    expect(made.body.error).toMatch(/^this board does not run .* for connections; the operator lists/);
    // Listed with more arguments than the operator allowed, or a different package after an allowed start.
    expect(
      (
        await api.post(`${base}/connections`, {
          name: "fixture",
          transport: "stdio",
          command: process.execPath,
          args: [stdioScript, "--inspect"],
        })
      ).status,
    ).toBe(403);
    const drive = await api.post(`${base}/connections`, {
      name: "drive",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem@2026.8.31", "/srv/drive"],
    });
    expect(drive.status).toBe(201);
    expect(
      (await api.patch(`${base}/connections/${drive.body.id}`, { args: ["-y", "some-other-server"] })).status,
    ).toBe(403);
    expect(
      (await api.patch(`${base}/connections/${drive.body.id}`, { command: process.execPath })).status,
    ).toBe(403);
    // A row from before the rule, or from a board that listed it then: nothing starts it.
    const old = (
      await board.db.query<{ id: string }>(
        `INSERT INTO connections (company_id, name, kind, transport, command, args)
         VALUES ($1, 'old', 'mcp', 'stdio', $2, $3) RETURNING id`,
        [companyId, shell.command, JSON.stringify(shell.args)],
      )
    ).rows[0]!;
    const discovered = await api.post(`${base}/connections/${old.id}/discover`, {});
    expect(discovered.status).toBe(403);
    const checked = await api.post(`${base}/connections/${old.id}/check`, {});
    expect(checked.body.lastCheck).toMatchObject({ ok: false });
    expect(checked.body.lastCheck.error).toContain("nothing was started");
    const row = await loadConnection(board.db, companyId, old.id);
    const called = await callConnectionTool(row, { stdioCommands: STDIO }, "whoami", {});
    expect(called).toMatchObject({ ok: false });
    expect((called as { error: string }).error).toContain("nothing was started");
    // It can still be switched off or removed.
    expect((await api.patch(`${base}/connections/${old.id}`, { enabled: false })).status).toBe(200);
    // A file's stdio connection the board would not run is skipped with a note.
    const report = await api.post(`${base}/templates/import`, {
      format: "rosterdock/templates/1",
      connections: [{ name: "filed", transport: "stdio", ...shell }],
    });
    expect(report.body.created.connections).toEqual([]);
    expect(report.body.notes).toEqual([
      expect.stringMatching(/^connection filed: this board does not run .* for connections; .*skipped$/),
    ]);
    expect(existsSync(marker)).toBe(false);
  });

  it("a listed command line runs exactly as listed; a board that lists none runs none", async () => {
    const { api, base } = await seedCompany(board, "op7@example.com");
    const fixture = await api.post(`${base}/connections`, {
      name: "fixture",
      transport: "stdio",
      command: process.execPath,
      args: [stdioScript],
    });
    expect(fixture.status).toBe(201);
    const found = await api.post(`${base}/connections/${fixture.body.id}/discover`, {});
    expect(found.status).toBe(200);
    expect(found.body.tools.map((t: { name: string }) => t.name)).toContain("manage_crm_objects");
    // The board says which lines it runs, for the Add form.
    expect((await api.get("/api/features")).body.stdioCommands).toEqual([
      `${process.execPath} ${stdioScript}`,
      "npx -y @modelcontextprotocol/server-filesystem@2026.8.31 *",
    ]);
    // Without a list, the client starts nothing at all.
    await expect(
      discoverTools({ transport: "stdio", command: shell.command, args: shell.args }, {}),
    ).rejects.toThrow("this board runs no commands for connections");
    expect(existsSync(marker)).toBe(false);
  });

  it("a pooled child serves one company with one set of values, never another", async () => {
    const pool = mcpClientPool({ idleMs: 60_000 });
    const target = {
      transport: "stdio" as const,
      command: process.execPath,
      args: [stdioScript],
      authEnvName: "XERO_FIXTURE_TOKEN",
      envNames: ["ROSTERDOCK_FIXTURE_AUTH_ENV"],
    };
    // What every call on a connection goes through scopes the pool to the connection's company.
    const scoped = async (companyId: string, token: string) =>
      withCompanyEnv(
        {
          env: { XERO_FIXTURE_TOKEN: token, ROSTERDOCK_FIXTURE_AUTH_ENV: "XERO_FIXTURE_TOKEN" },
          stdioCommands: STDIO,
          pool,
        },
        companyId,
      );
    try {
      expect((await scoped("company-a", "a-token-000000")).poolScope).toBe("company-a");
      await callMcpTool(target, await scoped("company-a", "a-token-000000"), "whoami", {});
      await callMcpTool(target, await scoped("company-a", "a-token-000000"), "whoami", {});
      expect(pool.stats()).toEqual({ open: 1, connects: 1 });
      // Another company with the same connection gets a child of its own, even with the same values.
      await callMcpTool(target, await scoped("company-b", "a-token-000000"), "whoami", {});
      expect(pool.stats()).toEqual({ open: 2, connects: 2 });
      // A rotated value starts a new child rather than reusing the one holding the old value.
      await callMcpTool(target, await scoped("company-a", "rotated-000000"), "whoami", {});
      expect(pool.stats()).toEqual({ open: 3, connects: 3 });
    } finally {
      await pool.closeAll();
    }
  }, 30_000);

  it("the operator's list parses at start: exact lines, a final * for more, never a bare *", () => {
    const env = { DATABASE_URL: DB_URL };
    expect(loadConfig(env).stdioCommands).toEqual([]);
    expect(
      loadConfig({
        ...env,
        ROSTERDOCK_STDIO_COMMANDS:
          "npx -y @modelcontextprotocol/server-memory@2026.8.31, npx -y @modelcontextprotocol/server-filesystem@2026.8.31 *",
      }).stdioCommands,
    ).toEqual([
      { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory@2026.8.31"], more: false },
      { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem@2026.8.31"], more: true },
    ]);
    expect(() => loadConfig({ ...env, ROSTERDOCK_STDIO_COMMANDS: "*" })).toThrow("names no command");
  });
});

describe("who may found a company", () => {
  /** A person signed in through the provider: a user and a session, no dev login. */
  async function person(on: TestBoard, email: string) {
    const id = (
      await on.db.query<{ id: string }>("INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id", [
        email,
        email.split("@")[0],
      ])
    ).rows[0]!.id;
    return on.api(await createSession(on.db, id, 3600, "oidc"));
  }

  it("with no list and no dev login: whoever founds the first company on an empty board, and nobody after", async () => {
    const empty = await startTestBoard({ devLogin: false });
    try {
      const first = await person(empty, "first@example.com");
      const stranger = await person(empty, "stranger@gmail.test");
      expect((await first.get("/api/auth/me")).body.mayCreateCompany).toBe(true);
      expect((await first.post("/api/companies", { name: "Acme" })).status).toBe(201);
      expect((await stranger.get("/api/auth/me")).body.mayCreateCompany).toBe(false);
      const refused = await stranger.post("/api/companies", { name: "Squat" });
      expect(refused.status).toBe(403);
      expect(refused.body.error).toContain("ROSTERDOCK_COMPANY_CREATORS");
      // The first owner too: more companies are the operator's to allow.
      expect((await first.post("/api/companies", { name: "Acme Two" })).status).toBe(403);
      // An invitation still works: the owner adds the stranger, who reaches that company and no other.
      const acme = (await first.get("/api/companies")).body[0].id as string;
      expect(
        (await first.post(`/api/companies/${acme}/members`, { email: "stranger@gmail.test", role: "viewer" }))
          .status,
      ).toBe(201);
      expect((await stranger.get("/api/companies")).body.map((c: { name: string }) => c.name)).toEqual([
        "Acme",
      ]);
    } finally {
      await empty.destroy();
    }
  });

  it("two people on an empty board at once: one founds it, the other is refused", async () => {
    const empty = await startTestBoard({ devLogin: false });
    try {
      const [a, b] = await Promise.all([person(empty, "a@example.com"), person(empty, "b@example.com")]);
      const results = await Promise.all([
        a.post("/api/companies", { name: "A" }),
        b.post("/api/companies", { name: "B" }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 403]);
      expect((await empty.db.query("SELECT 1 FROM companies")).rowCount).toBe(1);
    } finally {
      await empty.destroy();
    }
  });

  it("with a list: only the emails and domains on it, dev login or not", async () => {
    const listed = await startTestBoard({
      companyCreators: parseCompanyCreators("Ana@Acme.test, @founders.test"),
    });
    try {
      const make = async (email: string) => {
        const api = listed.api((await listed.login(email)).token);
        return {
          may: (await api.get("/api/auth/me")).body.mayCreateCompany as boolean,
          status: (await api.post("/api/companies", { name: email.split("@")[0]! })).status,
        };
      };
      expect(await make("ana@acme.test")).toEqual({ may: true, status: 201 });
      expect(await make("ana@acme.test")).toEqual({ may: true, status: 201 });
      expect(await make("bo@founders.test")).toEqual({ may: true, status: 201 });
      expect(await make("eve@acme.test")).toEqual({ may: false, status: 403 });
      expect(await make("eve@founders.test.evil")).toEqual({ may: false, status: 403 });
    } finally {
      await listed.destroy();
    }
  });

  it("the list parses at start: emails, @domains, * for anyone; nothing else", () => {
    const env = { DATABASE_URL: DB_URL };
    expect(loadConfig(env).companyCreators).toBeNull();
    expect(
      loadConfig({ ...env, ROSTERDOCK_COMPANY_CREATORS: " Ana@Acme.test ,@founders.test" }).companyCreators,
    ).toEqual({ anyone: false, emails: ["ana@acme.test"], domains: ["founders.test"] });
    expect(loadConfig({ ...env, ROSTERDOCK_COMPANY_CREATORS: "*" }).companyCreators?.anyone).toBe(true);
    expect(() => loadConfig({ ...env, ROSTERDOCK_COMPANY_CREATORS: "acme.test" })).toThrow(
      "not an email, an @domain or *",
    );
  });
});

describe("signing in through a public provider", () => {
  const oidc = { DATABASE_URL: DB_URL, ROSTERDOCK_OIDC_CLIENT_ID: "rosterdock" };

  it("the board will not start open to every account at the provider unless the operator says *", () => {
    for (const issuer of [
      "https://accounts.google.com",
      "https://accounts.google.com/",
      "https://login.microsoftonline.com/common/v2.0",
      "https://gitlab.com",
    ])
      expect(() => loadConfig({ ...oidc, ROSTERDOCK_OIDC_ISSUER: issuer })).toThrow(
        "where anyone can hold an account, and ROSTERDOCK_OIDC_ALLOWED_DOMAINS is empty",
      );
    const google = { ...oidc, ROSTERDOCK_OIDC_ISSUER: "https://accounts.google.com" };
    expect(
      loadConfig({ ...google, ROSTERDOCK_OIDC_ALLOWED_DOMAINS: "example.com" }).oidc?.allowedDomains,
    ).toEqual(["example.com"]);
    expect(loadConfig({ ...google, ROSTERDOCK_OIDC_ALLOWED_DOMAINS: "*" }).oidc?.allowedDomains).toEqual([
      "*",
    ]);
    // A provider of the operator's own (a Keycloak realm, a tenant) lets in only its accounts: no list needed.
    expect(
      loadConfig({ ...oidc, ROSTERDOCK_OIDC_ISSUER: "https://sso.acme.test/realms/acme" }).oidc,
    ).not.toBeNull();
    // * lets every verified email in; a list only its domains.
    const claims = { sub: "s", email: "someone@gmail.com", email_verified: true };
    expect(emailFrom(claims, ["*"])).toBe("someone@gmail.com");
    expect(() => emailFrom(claims, ["example.com"])).toThrow(
      "gmail.com is not a domain that may sign in here",
    );
  });
});
