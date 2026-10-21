// Connections and the board's MCP client: the catalog, adding a connection with
// its credential by NAME, tool discovery over HTTP against recorded JSON-RPC
// (classification from annotations, the catalog and names; a person's
// reclassification survives), the stdio transport against a fixture replayer,
// and the toolbox and client-policy columns. No real MCP server, no network.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyOn } from "../src/broker/broker.js";
import { migrate } from "../src/db/migrate.js";
import { callMcpTool, discoverTools, mcpClientPool } from "../src/mcp/client.js";
import type { ConnectionRow } from "../src/mcp/connections.js";
import { fakeMcp } from "./mcp-fake.js";
import { addProject, addTeammate, seedCompany, startTestBoard, type TestBoard } from "./helpers.js";

let board: TestBoard;
const mcp = fakeMcp();
const READS_BY_NAME = "0033_reads_by_name.sql";
const env: NodeJS.ProcessEnv = { HUBSPOT_MCP_TOKEN: "fixture-token-000000" };
const stdioScript = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "mcp",
  "stdio-server.mjs",
);

beforeAll(async () => {
  board = await startTestBoard({ sharedEnvNames: ["HUBSPOT_MCP_TOKEN"] }, { mcpFetch: mcp.fetch, env });
});
afterAll(async () => {
  await board.destroy();
});

describe("connections", () => {
  it("lists the catalog with env var NAME examples and no values", async () => {
    const { api } = await seedCompany(board, "cn1@example.com");
    const res = await api.get("/api/catalog/connectors");
    expect(res.status).toBe(200);
    const ids = res.body.map((e: { id: string }) => e.id);
    expect(ids).toEqual(
      expect.arrayContaining(["hubspot", "slack", "xero", "n8n", "gong", "notion", "github"]),
    );
    const hubspot = res.body.find((e: { id: string }) => e.id === "hubspot");
    expect(hubspot.authEnvExample).toBe("HUBSPOT_MCP_TOKEN");
    expect(hubspot.writes).toContain("manage_crm_objects");
    // Notion authorises by OAuth only: no token to name, and the Add flow starts at OAuth.
    const notion = res.body.find((e: { id: string }) => e.id === "notion");
    expect(notion).toMatchObject({
      auth: "oauth",
      transport: "http",
      urlExample: "https://mcp.notion.com/mcp",
    });
    expect(notion.authEnvExample).toBeUndefined();
    expect(notion.reads).toContain("notion-search");
    expect(notion.writes).toContain("notion-create-pages");
    expect(JSON.stringify(res.body)).not.toMatch(/sk-|xox[a-z]-|Bearer /);
  });

  it("adds a connection from the catalog, discovers its tools over HTTP and classifies them", async () => {
    const { api, base } = await seedCompany(board, "cn2@example.com");
    const created = await api.post(`${base}/connections`, {
      name: "hubspot",
      catalogId: "hubspot",
      url: "https://mcp.hubspot.test/mcp",
      authEnvName: "HUBSPOT_MCP_TOKEN",
    });
    expect(created.status).toBe(201);
    expect(created.body.authEnvName).toBe("HUBSPOT_MCP_TOKEN");
    // Seeded from the catalog until discovery.
    expect(created.body.tools.find((t: { name: string }) => t.name === "manage_crm_objects")).toMatchObject({
      write: true,
      source: "catalog",
    });
    expect(created.body.discoveredAt).toBeNull();
    // A value where a NAME belongs is refused.
    expect(
      (
        await api.post(`${base}/connections`, {
          name: "slack",
          url: "https://mcp.slack.test/mcp",
          authEnvName: "xoxb-1234567890-abcdefghij",
        })
      ).status,
    ).toBe(400);
    expect(
      (await api.post(`${base}/connections`, { name: "hubspot", url: "https://x.test/mcp" })).status,
    ).toBe(409);
    expect((await api.post(`${base}/connections`, { name: "nourl" })).status).toBe(422);

    // A check before discovery: the server answers, and the catalog's guess is compared with what is there.
    const checked = await api.post(`${base}/connections/${created.body.id}/check`, {});
    expect(checked.status).toBe(200);
    expect(checked.body.lastCheck).toMatchObject({ ok: true, error: null, tools: { seen: 5 } });
    expect([...checked.body.lastCheck.tools.extra].sort()).toEqual(["run_report", "whoami"]);
    expect([...checked.body.lastCheck.tools.missing].sort()).toEqual([
      "get_crm_objects",
      "manage_campaign_objects",
      "manage_marketing_email",
      "manage_segment",
      "query_crm_data",
      "search_owners",
    ]);
    expect(typeof checked.body.lastCheck.latencyMs).toBe("number");
    mcp.requests.length = 0;
    const discovered = await api.post(`${base}/connections/${created.body.id}/discover`, {});
    expect(discovered.status).toBe(200);
    const tools = discovered.body.tools as {
      name: string;
      write: boolean;
      source: string;
      description: string;
    }[];
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.search_crm_objects).toMatchObject({ write: false, source: "annotation" });
    expect(byName.manage_crm_objects).toMatchObject({ write: true, source: "annotation" });
    expect(byName.get_properties).toMatchObject({ write: false, source: "catalog" });
    expect(byName.run_report).toMatchObject({ write: true, source: "default" });
    expect(byName.whoami).toMatchObject({ write: false, source: "annotation" });
    expect(byName.run_report!.description).toContain("saved report");
    expect(discovered.body.discoveredAt).not.toBeNull();
    // The credential travelled as a header, by value resolved from the NAME, and never into the row or events.
    const listReq = mcp.requests.find((r) => r.body?.method === "tools/list");
    expect(listReq?.headers.authorization).toBe("Bearer fixture-token-000000");
    expect(JSON.stringify(discovered.body)).not.toContain("fixture-token");
    const events = (await api.get(`${base}/events?limit=20`)).body as { type: string; payload: any }[];
    expect(JSON.stringify(events)).not.toContain("fixture-token");
    const ev = events.find((e) => e.type === "connection.updated");
    expect(ev?.payload.discovered).toBe(5);
    expect(ev?.payload.writes).toEqual(["manage_crm_objects", "run_report"]);

    // A person reclassifies run_report as a read; the next discovery keeps their word.
    const patched = await api.patch(`${base}/connections/${created.body.id}`, {
      tools: [{ name: "run_report", write: false }],
    });
    expect(patched.body.tools.find((t: { name: string }) => t.name === "run_report")).toMatchObject({
      write: false,
      source: "person",
    });
    const again = await api.post(`${base}/connections/${created.body.id}/discover`, {});
    expect(again.body.tools.find((t: { name: string }) => t.name === "run_report")).toMatchObject({
      write: false,
      source: "person",
    });
    // A person switches one tool off: it keeps its classification, the flag survives discovery, and
    // switching it on again clears it. A tool line that says neither is refused.
    const off = await api.patch(`${base}/connections/${created.body.id}`, {
      tools: [{ name: "whoami", off: true }],
    });
    expect(off.body.tools.find((t: { name: string }) => t.name === "whoami")).toMatchObject({
      off: true,
      write: false,
      source: "annotation",
    });
    const rediscovered = await api.post(`${base}/connections/${created.body.id}/discover`, {});
    expect(rediscovered.body.tools.find((t: { name: string }) => t.name === "whoami")).toMatchObject({
      off: true,
      source: "annotation",
    });
    const offEvent = (await api.get(`${base}/events?limit=10`)).body.find(
      (e: { type: string; payload: any }) => e.type === "connection.updated" && e.payload.switchedOff?.length,
    );
    expect(offEvent?.payload).toMatchObject({ switchedOff: ["whoami"], off: ["whoami"] });
    const on = await api.patch(`${base}/connections/${created.body.id}`, {
      tools: [{ name: "whoami", off: false }],
    });
    expect(on.body.tools.find((t: { name: string }) => t.name === "whoami").off).toBe(false);
    expect(
      (await api.patch(`${base}/connections/${created.body.id}`, { tools: [{ name: "whoami" }] })).status,
    ).toBe(400);
    expect(
      (
        await api.patch(`${base}/connections/${created.body.id}`, {
          tools: [{ name: "not_here", off: true }],
        })
      ).status,
    ).toBe(422);
    // After discovery the row and the server agree; a server that is down fails the check, scrubbed.
    const agreed = await api.post(`${base}/connections/${created.body.id}/check`, {});
    expect(agreed.body.lastCheck.tools).toEqual({ seen: 5, missing: [], extra: [] });
    mcp.failWith = 503;
    const down = await api.post(`${base}/connections/${created.body.id}/check`, {});
    mcp.failWith = null;
    expect(down.body.lastCheck.ok).toBe(false);
    expect(down.body.lastCheck.error).not.toContain("fixture-token");
    expect((await api.get(`${base}/connections/${created.body.id}`)).body.lastCheck.ok).toBe(false);
    const checkedEvents = (await api.get(`${base}/events?limit=30`)).body.filter(
      (e: { type: string }) => e.type === "connection.checked",
    );
    expect(checkedEvents.map((e: any) => e.payload.ok)).toEqual([false, true, true]);
    expect(JSON.stringify(checkedEvents)).not.toContain("fixture-token");
    // Disable, then remove.
    expect((await api.patch(`${base}/connections/${created.body.id}`, { enabled: false })).body.enabled).toBe(
      false,
    );
    expect((await api.del(`${base}/connections/${created.body.id}`)).status).toBe(200);
    expect((await api.get(`${base}/connections`)).body).toHaveLength(0);
  });

  it("only owners and admins manage connections; a missing credential NAME is reported, not guessed", async () => {
    const { api, base } = await seedCompany(board, "cn3@example.com");
    const viewer = await board.login("cn3-viewer@example.com", "Vee");
    await api.post(`${base}/members`, { email: "cn3-viewer@example.com", role: "viewer" });
    expect((await board.api(viewer.token).get(`${base}/connections`)).status).toBe(200);
    expect(
      (await board.api(viewer.token).post(`${base}/connections`, { name: "x", url: "https://x.test/mcp" }))
        .status,
    ).toBe(403);
    const c = (
      await api.post(`${base}/connections`, {
        name: "gong",
        catalogId: "gong",
        url: "https://mcp.gong.test/mcp",
        authEnvName: "GONG_MCP_TOKEN",
      })
    ).body;
    const res = await api.post(`${base}/connections/${c.id}/discover`, {});
    expect(res.status).toBe(409);
    // The client itself says why, by name.
    await expect(
      discoverTools(
        { transport: "http", url: "https://mcp.gong.test/mcp", authEnvName: "GONG_MCP_TOKEN" },
        {
          fetch: mcp.fetch,
          env,
        },
      ),
    ).rejects.toThrow("GONG_MCP_TOKEN is not set for this company");
  });

  it("calls a tool with exactly the arguments given and returns structured content, text, or the error", async () => {
    const target = {
      transport: "http" as const,
      url: "https://mcp.hubspot.test/mcp",
      authEnvName: "HUBSPOT_MCP_TOKEN",
    };
    mcp.calls.length = 0;
    const read = await callMcpTool(target, { fetch: mcp.fetch, env }, "search_crm_objects", {
      objectType: "company",
      query: "warm",
    });
    expect(read).toEqual({
      ok: true,
      result: expect.objectContaining({
        total: 2,
        results: expect.arrayContaining([expect.objectContaining({ id: "101" })]),
      }),
    });
    expect(mcp.calls[0]).toEqual({
      name: "search_crm_objects",
      arguments: { objectType: "company", query: "warm" },
    });
    const write = await callMcpTool(target, { fetch: mcp.fetch, env }, "manage_crm_objects", {
      action: "create",
      objectType: "company",
      properties: { name: "Q3 warm accounts" },
    });
    expect(write.ok).toBe(true);
    expect((write as { result: { id: string } }).result.id).toBe("301");
    mcp.errorTools.add("whoami");
    const failed = await callMcpTool(target, { fetch: mcp.fetch, env }, "whoami", {});
    mcp.errorTools.delete("whoami");
    expect(failed).toEqual({ ok: false, error: "unauthorized: no credential was presented" });
    const unknown = await callMcpTool(target, { fetch: mcp.fetch, env }, "no_such_tool", {});
    expect(unknown.ok).toBe(false);
    expect((unknown as { error: string }).error).toContain("unknown tool");
    mcp.failWith = 503;
    const down = await callMcpTool(target, { fetch: mcp.fetch, env }, "whoami", {});
    mcp.failWith = null;
    expect(down.ok).toBe(false);
    expect((down as { error: string }).error).not.toContain("fixture-token");
  });

  it("speaks to a stdio server the board spawns, handing it only the named env vars", async () => {
    const target = {
      transport: "stdio" as const,
      command: process.execPath,
      args: [stdioScript],
      authEnvName: "XERO_FIXTURE_TOKEN",
      envNames: ["ROSTERDOCK_FIXTURE_AUTH_ENV"],
    };
    const stdioEnv: NodeJS.ProcessEnv = {
      XERO_FIXTURE_TOKEN: "fixture-xero-secret-000",
      ROSTERDOCK_FIXTURE_AUTH_ENV: "XERO_FIXTURE_TOKEN",
    };
    // The operator lists the command line; a path with spaces is fine as an object.
    const stdioCommands = [{ command: process.execPath, args: [stdioScript], more: false }];
    const tools = await discoverTools(target, { env: stdioEnv, stdioCommands });
    expect(tools.map((t) => t.name)).toContain("manage_crm_objects");
    const who = await callMcpTool(target, { env: stdioEnv, stdioCommands }, "whoami", {});
    expect(who).toEqual({
      ok: true,
      result: "authenticated as fixture-user@example.com (credential by name)",
    });
    // Without the named credential the child never sees a value, and says so.
    const bare = await callMcpTool(
      { ...target, authEnvName: null, envNames: ["ROSTERDOCK_FIXTURE_AUTH_ENV"] },
      { env: { ROSTERDOCK_FIXTURE_AUTH_ENV: "XERO_FIXTURE_TOKEN" }, stdioCommands },
      "whoami",
      {},
    );
    expect(bare).toEqual({ ok: false, error: "unauthorized: no credential was presented" });
    await expect(discoverTools(target, { env: {}, stdioCommands })).rejects.toThrow(
      "ROSTERDOCK_FIXTURE_AUTH_ENV is not set",
    );
    // A pool keeps the child between calls: one process serves discovery and the calls, closed when idle.
    const pool = mcpClientPool({ idleMs: 300 });
    const pooled = { env: stdioEnv, pool, stdioCommands };
    await discoverTools(target, pooled);
    await callMcpTool(target, pooled, "whoami", {});
    expect(await callMcpTool(target, pooled, "whoami", {})).toMatchObject({ ok: true });
    expect(pool.stats()).toEqual({ open: 1, connects: 1 });
    // HTTP is never pooled.
    await callMcpTool(
      { transport: "http", url: "https://mcp.hubspot.test/mcp", authEnvName: "HUBSPOT_MCP_TOKEN" },
      { fetch: mcp.fetch, env, pool },
      "whoami",
      {},
    );
    expect(pool.stats()).toEqual({ open: 1, connects: 1 });
    await new Promise((r) => setTimeout(r, 600));
    expect(pool.stats()).toEqual({ open: 0, connects: 1 });
    await callMcpTool(target, pooled, "whoami", {});
    expect(pool.stats()).toEqual({ open: 1, connects: 2 });
    await pool.closeAll();
    expect(pool.stats().open).toBe(0);
  }, 30_000);

  it("a teammate's toolbox names connections that exist; a project's client policy is stored and returned", async () => {
    const { api, base } = await seedCompany(board, "cn4@example.com");
    const cody = await addTeammate(api, base, "Cody");
    expect(
      (await api.patch(`${base}/teammates/${cody.id}`, { toolbox: [{ connection: "hubspot", mode: "ask" }] }))
        .status,
    ).toBe(422);
    await api.post(`${base}/connections`, {
      name: "hubspot",
      catalogId: "hubspot",
      url: "https://h.test/mcp",
    });
    await api.post(`${base}/connections`, { name: "slack", catalogId: "slack", url: "https://s.test/mcp" });
    const saved = await api.patch(`${base}/teammates/${cody.id}`, {
      toolbox: [
        { connection: "hubspot", mode: "ask" },
        { connection: "slack", mode: "read" },
      ],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.toolbox).toEqual([
      { connection: "hubspot", mode: "ask" },
      { connection: "slack", mode: "read" },
    ]);
    expect(
      (
        await api.patch(`${base}/teammates/${cody.id}`, {
          toolbox: [
            { connection: "hubspot", mode: "ask" },
            { connection: "hubspot", mode: "read" },
          ],
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await api.patch(`${base}/teammates/${cody.id}`, {
          toolbox: [{ connection: "hubspot", mode: "auto" }],
        })
      ).status,
    ).toBe(400);
    const hired = await api.post(`${base}/teammates`, {
      name: "Sid",
      role: "SDR",
      model: "claude-sonnet-5",
      toolbox: [{ connection: "slack", mode: "read" }],
    });
    expect(hired.status).toBe(201);
    expect(hired.body.toolbox).toEqual([{ connection: "slack", mode: "read" }]);

    // A partial update touches only what it names: the toolbox, engine and persona survive a rename.
    const renamed = await api.patch(`${base}/teammates/${cody.id}`, { name: "Cody 2" });
    expect(renamed.body.toolbox).toEqual([
      { connection: "hubspot", mode: "ask" },
      { connection: "slack", mode: "read" },
    ]);
    expect(renamed.body.engine).toBe("claude_code");
    expect(renamed.body.model).toBe("claude-sonnet-5");

    const project = await addProject(api, base);
    expect((await api.get(`${base}/projects/${project.id}`)).body.clientPolicy).toEqual({
      default: null,
      caps: {},
    });
    const policy = await api.patch(`${base}/projects/${project.id}`, {
      clientPolicy: { default: "read", caps: { slack: "off" } },
    });
    expect(policy.status).toBe(200);
    expect(policy.body.clientPolicy).toEqual({ default: "read", caps: { slack: "off" } });
    expect(policy.body.client).toBe("Globex");
    // Renaming the project keeps its client and policy.
    const renamedProject = await api.patch(`${base}/projects/${project.id}`, { name: "VMS map v2" });
    expect(renamedProject.status).toBe(200);
    expect(renamedProject.body.client).toBe("Globex");
    expect(renamedProject.body.clientPolicy).toEqual({ default: "read", caps: { slack: "off" } });
    const events = (await api.get(`${base}/events?limit=10`)).body as { type: string; payload: any }[];
    expect(
      events.find((e) => e.type === "project.updated" && e.payload.clientPolicy)?.payload.clientPolicy,
    ).toEqual({
      default: "read",
      caps: { slack: "off" },
    });
  });

  it("a name makes a tool a read only with a reading verb and no second verb, at a call and in what discovery kept", async () => {
    // Not discovered and not in the catalog: the broker reads the name when the call comes.
    const bare = { tools: [], discovered_at: null, catalog_id: null } as unknown as ConnectionRow;
    for (const tool of ["export_contacts", "preview_campaign", "check_in", "get_or_create_contact"])
      expect(classifyOn(bare, tool).write, tool).toBe(true);
    expect(classifyOn(bare, "list_contacts").write).toBe(false);

    // A discovery under the old rule kept some of those as reads by their name: the upgrade makes them
    // writes. What a person, an annotation or the catalog said stays as it was.
    const { api, base } = await seedCompany(board, "cn6@example.com");
    const conn = (await api.post(`${base}/connections`, { name: "crm", url: "https://crm.test/mcp" })).body;
    const kept = [
      { name: "export_contacts", description: "Export to CSV", write: false, source: "name" },
      { name: "crm.preview_campaign", description: "", write: false, source: "name", off: true },
      { name: "find_and_merge_duplicates", description: "", write: false, source: "name" },
      { name: "list_contacts", description: "", write: false, source: "name" },
      { name: "export_audit_log", description: "", write: false, source: "person" },
      { name: "check_quota", description: "", write: false, source: "annotation" },
      { name: "create_contact", description: "", write: true, source: "default" },
    ];
    await board.db.query("UPDATE connections SET tools = $2, discovered_at = now() WHERE id = $1", [
      conn.id,
      JSON.stringify(kept),
    ]);
    await board.db.query("DELETE FROM schema_migrations WHERE name = $1", [READS_BY_NAME]);
    expect((await migrate(board.db)).applied).toEqual([READS_BY_NAME]);
    expect((await api.get(`${base}/connections/${conn.id}`)).body.tools).toEqual([
      { name: "export_contacts", description: "Export to CSV", write: true, source: "default" },
      { name: "crm.preview_campaign", description: "", write: true, source: "default", off: true },
      { name: "find_and_merge_duplicates", description: "", write: true, source: "default" },
      ...kept.slice(3),
    ]);
  });
});
