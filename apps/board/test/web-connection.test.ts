// The web connection: the board's own fetch, added in Settings like any connection, granted in a toolbox,
// narrowed by a department's and a client's list of sites, and recorded as an event per page. The web is a
// fake fetch and a fake resolver; nothing leaves the machine.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditUrl } from "../src/web/read.js";
import { CONNECTOR_CATALOG, WEB_CATEGORY } from "../src/mcp/catalog.js";
import {
  addProject,
  addTeammate,
  seedCompany,
  startTestBoard,
  workerClaim,
  type Api,
  type TestBoard,
} from "./helpers.js";

let board: TestBoard;
let baseUrl: string;
const fetched: string[] = [];
const PAGE = "<html><title>Calls API</title><body><p>GET /v2/calls lists calls.</p></body></html>";
const pages: Record<string, () => Response> = {
  "https://help.gong.io/calls": () => new Response(PAGE, { headers: { "content-type": "text/html" } }),
  "https://www.gong.io/": () => new Response(PAGE, { headers: { "content-type": "text/html" } }),
  "https://help.gong.io/signed?token=abc123&page=2": () =>
    new Response("signed page", { headers: { "content-type": "text/plain" } }),
  "https://help.gong.io/away": () =>
    new Response(null, { status: 302, headers: { location: "https://www.hubspot.com/" } }),
  "https://help.gong.io/meta": () =>
    new Response(null, { status: 302, headers: { location: "http://meta.gong-mirror.net/latest" } }),
  "https://docs.example.org/long": () =>
    new Response(`<p>${"word ".repeat(10_000)}</p>`, { headers: { "content-type": "text/html" } }),
};
const names: Record<string, string[]> = {
  "intranet.gong.io": ["10.0.0.5"],
  "meta.gong-mirror.net": ["169.254.169.254"],
};

beforeAll(async () => {
  board = await startTestBoard(
    {},
    {
      webFetch: async (input) => {
        const url = String(input);
        fetched.push(url);
        return (
          pages[url]?.() ?? new Response("nope", { status: 404, headers: { "content-type": "text/plain" } })
        );
      },
      webResolve: async (host) => names[host] ?? ["93.184.215.14"],
    },
  );
  baseUrl = await board.app.listen({ host: "127.0.0.1", port: 0 });
});
afterAll(async () => {
  await board.destroy();
});

async function connect(token: string) {
  const client = new Client({ name: "test", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/api/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): { value: any; isError: boolean } {
  const content = (result.content as { type: string; text?: string }[])[0];
  const t = content?.text ?? "";
  try {
    return { value: JSON.parse(t), isError: !!result.isError };
  } catch {
    return { value: t, isError: !!result.isError };
  }
}

/** A company with the web connection; Cody holds it at `mode` (or not at all) on a task in a run. */
async function setup(
  api: Api,
  base: string,
  opts: {
    mode?: "read" | "ask";
    companyDomains?: string[];
    departmentDomains?: string[];
    clientPolicy?: unknown;
  } = {},
) {
  const web = await api.post(`${base}/connections`, {
    name: "web",
    kind: "web",
    ...(opts.companyDomains ? { domains: opts.companyDomains } : {}),
  });
  expect(web.status).toBe(201);
  const cody = await addTeammate(api, base, "Cody", "researcher");
  if (opts.mode)
    await api.patch(`${base}/teammates/${cody.id}`, { toolbox: [{ connection: "web", mode: opts.mode }] });
  const dept = opts.departmentDomains
    ? (
        await api.post(`${base}/departments`, {
          name: "Research",
          writePolicy: "readonly",
          memberTeammateIds: [cody.id],
          sandbox: { webDomains: opts.departmentDomains },
        })
      ).body
    : null;
  const project = await addProject(api, base);
  if (opts.clientPolicy)
    await api.patch(`${base}/projects/${project.id}`, { clientPolicy: opts.clientPolicy });
  const task = (
    await api.post(`${base}/tasks`, {
      projectId: project.id,
      title: "What Gong's calls API offers",
      description: "Read the docs and cite them.",
      assignee: { kind: "teammate", id: cody.id },
      departmentId: dept?.id ?? null,
      workKind: "research",
    })
  ).body;
  const run = (await api.post(`${base}/tasks/${task.id}/runs`, {})).body;
  const claimed = await workerClaim(board, run.id);
  const client = await connect(claimed.token);
  return { web: web.body, cody, task, run, claimed, client };
}

const fetchCall = (url: string, more: Record<string, unknown> = {}) => ({
  name: "board_tool_call",
  arguments: { connection: "web", tool: "fetch", arguments: { url, ...more } },
});

describe("the web connection", () => {
  it("is added once per company, takes no URL or credential, has one tool that reads, and nothing to discover", async () => {
    const { api, base } = await seedCompany(board, "wc1@example.com");
    const made = await api.post(`${base}/connections`, { name: "web", kind: "web", domains: ["*.Gong.io"] });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      kind: "web",
      url: null,
      command: null,
      authEnvName: null,
      manifest: { domains: ["gong.io"] },
    });
    expect(made.body.tools).toEqual([expect.objectContaining({ name: "fetch", write: false })]);
    const second = await api.post(`${base}/connections`, { name: "web-2", kind: "web" });
    expect(second.status).toBe(409);
    expect(second.body.error).toContain("this company has its web connection already: web");
    expect(
      (await api.post(`${base}/connections`, { name: "w", kind: "web", url: "https://x.example.com" }))
        .status,
    ).toBe(422);
    const mcpWithDomains = await api.post(`${base}/connections`, {
      name: "hubspot",
      url: "https://mcp.hubspot.test/mcp",
      domains: ["gong.io"],
    });
    expect(mcpWithDomains.status).toBe(422);
    // Its one tool reads, always: a person cannot make it a write, nor add another.
    const asWrite = await api.patch(`${base}/connections/${made.body.id}`, {
      tools: [{ name: "fetch", write: true }],
    });
    expect(asWrite.status).toBe(422);
    expect(asWrite.body.error).toContain("has one tool, fetch, and it only reads");
    expect((await api.post(`${base}/connections/${made.body.id}/discover`, {})).status).toBe(422);
    // The company's list is edited on it, and the event says what it became.
    const listed = await api.patch(`${base}/connections/${made.body.id}`, {
      domains: ["gong.io", "https://hubspot.com/docs"],
    });
    expect(listed.body.manifest).toEqual({ domains: ["gong.io", "hubspot.com"] });
    const cleared = await api.patch(`${base}/connections/${made.body.id}`, { domains: [] });
    expect(cleared.body.manifest).toEqual({ domains: null });
    const events = (await api.get(`${base}/events?limit=20`)).body as { type: string; payload: any }[];
    expect(events.filter((e) => e.type === "connection.updated").map((e) => e.payload.domains)).toEqual(
      expect.arrayContaining([["gong.io", "hubspot.com"], null]),
    );
    const checked = await api.post(`${base}/connections/${made.body.id}/check`, {});
    expect(checked.body.lastCheck).toMatchObject({ ok: true, error: null });
    expect((await api.get("/api/features")).body.web).toBe(true);
  });

  it("is granted in the toolbox like any connection: not held, refused; held, read at once, under read or ask", async () => {
    const { api, base } = await seedCompany(board, "wc2@example.com");
    const { client, cody, claimed } = await setup(api, base);
    expect(claimed.pack).toContain("No web tool is in your toolbox for this task");
    fetched.length = 0;
    const refused = text(await client.callTool(fetchCall("https://help.gong.io/calls")));
    expect(refused.isError).toBe(true);
    expect(refused.value).toContain("web is not in your toolbox");
    expect(
      (text(await client.callTool({ name: "board_list_tools", arguments: {} })).value as unknown[]).length,
    ).toBe(0);
    expect(fetched).toEqual([]);

    for (const mode of ["read", "ask"] as const) {
      await api.patch(`${base}/teammates/${cody.id}`, { toolbox: [{ connection: "web", mode }] });
      const listed = text(await client.callTool({ name: "board_list_tools", arguments: {} }));
      expect(listed.value[0]).toMatchObject({ connection: "web", kind: "web", mode, domains: null });
      expect(listed.value[0].tools).toEqual([
        expect.objectContaining({ name: "fetch", write: false, verdict: "run" }),
      ]);
      const read = text(await client.callTool(fetchCall("https://help.gong.io/calls")));
      expect(read.isError).toBe(false);
      expect(read.value).toMatchObject({
        kind: "result",
        connection: "web",
        tool: "fetch",
        result: {
          url: "https://help.gong.io/calls",
          status: 200,
          title: "Calls API",
          text: "GET /v2/calls lists calls.",
          nextOffset: null,
        },
      });
    }
    // Never proposed: a read under ask runs, and no approval waits.
    expect((await api.get(`${base}/approvals?status=pending`)).body).toEqual([]);
    // A client cap switches it off for that client's work.
    const { api: api2, base: base2 } = await seedCompany(board, "wc2b@example.com");
    const capped = await setup(api2, base2, { mode: "read", clientPolicy: { caps: { web: "off" } } });
    const off = text(await capped.client.callTool(fetchCall("https://help.gong.io/calls")));
    expect(off.isError).toBe(true);
    expect(off.value).toContain("web is off for this task");
  });

  it("records every fetch as an event: where, the status and the size; never what the page says", async () => {
    const { api, base } = await seedCompany(board, "wc3@example.com");
    const { client, task, run } = await setup(api, base, { mode: "read" });
    await client.callTool(fetchCall("https://help.gong.io/calls"));
    await client.callTool(fetchCall("https://help.gong.io/signed?token=abc123&page=2"));
    await client.callTool(fetchCall("https://help.gong.io/gone"));
    const events = (await api.get(`${base}/events?limit=40`)).body as { type: string; payload: any }[];
    const calls = events.filter((e) => e.type === "tool.called").map((e) => e.payload);
    expect(calls).toHaveLength(3);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          connection: "web",
          tool: "fetch",
          taskId: task.id,
          runId: run.id,
          teammateName: "Cody",
          ok: true,
          url: "https://help.gong.io/calls",
          status: 200,
          bytes: PAGE.length,
          note: null,
          argumentKeys: ["url"],
        }),
        expect.objectContaining({
          ok: true,
          url: "https://help.gong.io/signed?token=%5Bredacted%5D&page=2",
          status: 200,
        }),
        expect.objectContaining({
          ok: false,
          url: "https://help.gong.io/gone",
          status: 404,
          note: "answered 404",
        }),
      ]),
    );
    const record = JSON.stringify(events);
    expect(record).not.toContain("lists calls");
    expect(record).not.toContain("Calls API");
    expect(record).not.toContain("abc123");
    expect(record).not.toContain("content-type");
  });

  it("refuses an address that is not public, by its name or on a redirect hop, before anything is sent", async () => {
    const { api, base } = await seedCompany(board, "wc4@example.com");
    const { client } = await setup(api, base, { mode: "read" });
    fetched.length = 0;
    const internal = text(await client.callTool(fetchCall("https://intranet.gong.io/wiki")));
    expect(internal.isError).toBe(true);
    expect(internal.value).toContain("intranet.gong.io resolves to 10.0.0.5, a private address");
    const literal = text(await client.callTool(fetchCall("http://169.254.169.254/latest/meta-data/")));
    expect(literal.value).toContain("a literal address is not fetched");
    const local = text(await client.callTool(fetchCall("http://localhost:3000/api/health")));
    expect(local.value).toContain("localhost is not fetched");
    const hop = text(await client.callTool(fetchCall("https://help.gong.io/meta")));
    expect(hop.value).toContain(
      "redirected to http://meta.gong-mirror.net/latest: meta.gong-mirror.net resolves to 169.254.169.254, a link-local address, where cloud metadata lives",
    );
    expect(text(await client.callTool(fetchCall("ftp://gong.io/x"))).value).toContain(
      "ftp links are not fetched",
    );
    expect(text(await client.callTool(fetchCall("https://user:pw@gong.io/"))).value).toContain(
      "credentials in the URL",
    );
    expect(fetched).toEqual(["https://help.gong.io/meta"]);
    const events = (await api.get(`${base}/events?limit=40`)).body as { type: string; payload: any }[];
    const refusals = events.filter((e) => e.type === "tool.called" && !e.payload.ok).map((e) => e.payload);
    expect(refusals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: "https://intranet.gong.io/wiki",
          status: null,
          bytes: 0,
          note: expect.stringContaining("resolves to 10.0.0.5"),
        }),
        expect.objectContaining({
          url: "https://help.gong.io/meta",
          finalUrl: "http://meta.gong-mirror.net/latest",
          note: expect.stringContaining("169.254.169.254"),
        }),
      ]),
    );
  });

  it("reads only the company's sites, narrowed by the department and then the client, on every hop", async () => {
    const { api, base } = await seedCompany(board, "wc5@example.com");
    const { client, claimed } = await setup(api, base, {
      mode: "read",
      companyDomains: ["gong.io", "hubspot.com"],
      // The department cannot add a site the company does not allow: evil.org stays out.
      departmentDomains: ["gong.io", "evil.org"],
      clientPolicy: { webDomains: ["help.gong.io"] },
    });
    const listed = text(await client.callTool({ name: "board_list_tools", arguments: {} }));
    expect(listed.value[0]).toMatchObject({
      connection: "web",
      domains: ["help.gong.io"],
      domainsNarrowed: "narrowed by the Research department's list and the client Globex's list",
    });
    // The brief says the same.
    expect(claimed.spec.web).toEqual({
      fetch: {
        connection: "web",
        domains: ["help.gong.io"],
        narrowed: "narrowed by the Research department's list and the client Globex's list",
      },
      offline: false,
      tools: [],
    });
    expect(claimed.pack).toContain(
      "Sites you may read: only help.gong.io and the sites under it (narrowed by the Research department's list and the client Globex's list).",
    );
    const ok = text(await client.callTool(fetchCall("https://help.gong.io/calls")));
    expect(ok.isError).toBe(false);
    for (const [url, host] of [
      ["https://www.gong.io/", "www.gong.io"],
      ["https://hubspot.com/", "hubspot.com"],
      ["https://evil.org/", "evil.org"],
    ])
      expect(text(await client.callTool(fetchCall(url))).value).toContain(
        `${host} is not a site this task may read (only help.gong.io and the sites under it)`,
      );
    const away = text(await client.callTool(fetchCall("https://help.gong.io/away")));
    expect(away.value).toContain(
      "redirected to https://www.hubspot.com/: www.hubspot.com is not a site this task may read",
    );
    // A person narrows the company's list from Settings; the next call reads the new list.
    const conn = (await api.get(`${base}/connections`)).body.find((c: { kind: string }) => c.kind === "web");
    await api.patch(`${base}/connections/${conn.id}`, { domains: ["hubspot.com"] });
    const none = text(await client.callTool(fetchCall("https://help.gong.io/calls")));
    expect(none.value).toContain("help.gong.io is not a site this task may read (no site)");
  });

  it("pages a long page, and says plainly when the board is kept off the web", async () => {
    const { api, base } = await seedCompany(board, "wc6@example.com");
    const { client } = await setup(api, base, { mode: "read" });
    const first = text(await client.callTool(fetchCall("https://docs.example.org/long")));
    expect(first.value.result.text.length).toBe(30_000);
    expect(first.value.result.chars).toBe("word ".repeat(10_000).trim().length);
    const next = text(
      await client.callTool(
        fetchCall("https://docs.example.org/long", { offset: first.value.result.nextOffset }),
      ),
    );
    expect(next.value.result).toMatchObject({ offset: 30_000, nextOffset: null });
    expect(next.value.result.text.length).toBe(first.value.result.chars - 30_000);
    const bad = text(await client.callTool(fetchCall("https://docs.example.org/long", { offset: -1 })));
    expect(bad.value).toContain("offset is a whole number from 0");
    expect(
      text(
        await client.callTool({ name: "board_tool_call", arguments: { connection: "web", tool: "fetch" } }),
      ).value,
    ).toContain("give the page as url");

    const offline = await startTestBoard({ fetchSources: false });
    try {
      const { api: a, base: b } = await seedCompany(offline, "wc6b@example.com");
      const web = (await a.post(`${b}/connections`, { name: "web", kind: "web" })).body;
      const mate = await addTeammate(a, b, "Rae", "researcher");
      await a.patch(`${b}/teammates/${mate.id}`, { toolbox: [{ connection: "web", mode: "read" }] });
      const project = await addProject(a, b);
      const task = (
        await a.post(`${b}/tasks`, {
          projectId: project.id,
          title: "Read",
          assignee: { kind: "teammate", id: mate.id },
        })
      ).body;
      const run = (await a.post(`${b}/tasks/${task.id}/runs`, {})).body;
      const claimedOffline = await workerClaim(offline, run.id);
      expect(claimedOffline.pack).toContain(
        "this board is kept off the web by its operator: it reads no page",
      );
      const checked = await a.post(`${b}/connections/${web.id}/check`, {});
      expect(checked.body.lastCheck).toMatchObject({ ok: false });
      expect(checked.body.lastCheck.error).toContain("kept off the web by its operator");
      expect((await a.get("/api/features")).body.web).toBe(false);
    } finally {
      await offline.destroy();
    }
  });

  it("travels in a templates file with its list, and a company keeps one", async () => {
    const src = await seedCompany(board, "wc7@example.com");
    const { web } = await setup(src.api, src.base, {
      mode: "read",
      companyDomains: ["gong.io"],
      clientPolicy: { webDomains: ["help.gong.io"] },
    });
    const file = (await src.api.get(`${src.base}/templates/export`)).body;
    expect(file.connections).toEqual([
      expect.objectContaining({ name: "web", kind: "web", manifest: { domains: ["gong.io"] } }),
    ]);
    expect(file.clientPolicies).toEqual([
      { project: "VMS architecture map", policy: { default: null, caps: {}, webDomains: ["help.gong.io"] } },
    ]);
    const dst = await seedCompany(board, "wc7b@example.com");
    const imported = await dst.api.post(`${dst.base}/templates/import`, file);
    expect(imported.body.created.connections).toEqual(["web"]);
    const made = (await dst.api.get(`${dst.base}/connections`)).body;
    expect(made).toEqual([
      expect.objectContaining({
        kind: "web",
        manifest: { domains: ["gong.io"] },
        tools: [expect.objectContaining({ name: "fetch", write: false })],
      }),
    ]);
    const renamed = { ...file, connections: [{ ...file.connections[0], name: "browse" }] };
    const again = await dst.api.post(`${dst.base}/templates/import`, renamed);
    expect(again.body.notes).toContain(
      "connection browse: this company has its web connection already, web; skipped",
    );
    const widened = {
      ...file,
      connections: [{ ...file.connections[0], name: "w2", manifest: { domains: ["not a domain"] } }],
    };
    const third = await seedCompany(board, "wc7c@example.com");
    const refused = await third.api.post(`${third.base}/templates/import`, widened);
    expect(refused.body.notes).toContain("connection w2: not a domain is not a web domain; skipped");
    expect(web.kind).toBe("web");
  });
});

describe("web tools a company brings", () => {
  it("the catalog's web entries pin a version, name their credential by NAME and know their reads", () => {
    const web = CONNECTOR_CATALOG.filter((e) => e.category === WEB_CATEGORY);
    expect(web.map((e) => e.id)).toEqual(["brave-search", "tavily", "exa", "playwright", "fetch"]);
    for (const e of web) {
      // A command runs only as the operator lists it, so it names one exact version.
      if (e.commandExample) expect(e.commandExample, e.id).toMatch(/@\d+\.\d+\.\d+(?:\s|$)/);
      if (e.urlExample) expect(e.urlExample, e.id).toMatch(/^https?:\/\/[^\s]+\/mcp$/);
      if (e.authEnvExample) expect(e.authEnvExample, e.id).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(e.reads.length, e.id).toBeGreaterThan(0);
      expect(
        e.reads.filter((r) => e.writes.includes(r)),
        e.id,
      ).toEqual([]);
      expect(e.docsUrl, e.id).toMatch(/^https:\/\/github\.com\//);
    }
    // A hosted search service takes its key as a bearer, so it travels by NAME like any connection's.
    expect(web.find((e) => e.id === "tavily")).toMatchObject({
      transport: "http",
      authEnvExample: "TAVILY_API_KEY",
    });
  });

  it("a web tool added from the catalog and granted is named in the brief as a web tool", async () => {
    const { api, base } = await seedCompany(board, "wc8@example.com");
    const tavily = await api.post(`${base}/connections`, {
      name: "tavily",
      catalogId: "tavily",
      url: "https://mcp.tavily.test/mcp",
      authEnvName: "TAVILY_API_KEY",
    });
    expect(tavily.status).toBe(201);
    expect(tavily.body.tools.map((t: { name: string; write: boolean }) => [t.name, t.write])).toEqual([
      ["tavily_search", false],
      ["tavily_extract", false],
      ["tavily_crawl", false],
      ["tavily_map", false],
      ["tavily_research", false],
    ]);
    const cody = await addTeammate(api, base, "Cody", "researcher");
    await api.patch(`${base}/teammates/${cody.id}`, { toolbox: [{ connection: "tavily", mode: "read" }] });
    const project = await addProject(api, base);
    const task = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "Who sells call recording",
        assignee: { kind: "teammate", id: cody.id },
        workKind: "research",
      })
    ).body;
    const run = (await api.post(`${base}/tasks/${task.id}/runs`, {})).body;
    const claimed = await workerClaim(board, run.id);
    expect(claimed.spec.web).toEqual({
      fetch: null,
      offline: false,
      tools: [
        {
          connection: "tavily",
          name: "Tavily",
          mode: "read",
          reads: ["tavily_search", "tavily_extract", "tavily_crawl", "tavily_map", "tavily_research"],
          writes: [],
        },
      ],
    });
    expect(claimed.pack).toContain("The company gave you these web tools");
    expect(claimed.pack).toContain("- tavily (Tavily) · reads: tavily_search");
    expect(claimed.pack).not.toContain("No web tool is in your toolbox");
  });
});

describe("what the record keeps of a URL", () => {
  it("drops credentials and the fragment, and redacts secret-named parameters", () => {
    expect(auditUrl("https://docs.example.com/a?page=2#top")).toBe("https://docs.example.com/a?page=2");
    expect(auditUrl("https://s3.example.com/f?X-Amz-Signature=abc&X-Amz-Credential=k&v=1")).toBe(
      "https://s3.example.com/f?X-Amz-Signature=%5Bredacted%5D&X-Amz-Credential=%5Bredacted%5D&v=1",
    );
    expect(auditUrl("https://x.example.com/?access_token=t&api_key=k&key=v&q=gong")).toBe(
      "https://x.example.com/?access_token=%5Bredacted%5D&api_key=%5Bredacted%5D&key=%5Bredacted%5D&q=gong",
    );
    expect(auditUrl("not a url")).toBe("not a url");
  });
});
