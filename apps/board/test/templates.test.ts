// Templates as files: a company's shape exports by name and imports into
// another company; what exists is skipped, what is missing is created, toolbox
// grants resolve against the company's connections, and the raw-secret guard
// holds the import boundary. The shipped example files stay importable.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseStdioCommands, stdioCommandAllowed } from "@rosterdock/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";
import { addProject, addTeammate, seedCompany, startTestBoard, type TestBoard } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const example = (name: string) =>
  JSON.parse(readFileSync(path.join(here, "..", "..", "..", "deploy", "templates", name), "utf8"));

let board: TestBoard;
beforeAll(async () => {
  // The demo files' local servers run inside the board: the operator lists their exact command lines, as
  // the demo guides (deploy/demo/*/README.md) give them.
  board = await startTestBoard({
    stdioCommands: parseStdioCommands(
      [
        "npx -y @modelcontextprotocol/server-filesystem@2026.8.31 ~/Lighthouse/drive",
        "npx -y @modelcontextprotocol/server-filesystem@2026.8.31 ~/Lighthouse/staging",
        "npx -y @modelcontextprotocol/server-filesystem@2026.8.31 ~/Cirrus/drive",
        "npx -y @modelcontextprotocol/server-filesystem@2026.8.31 ~/Cirrus/staging",
        "npx -y @modelcontextprotocol/server-memory@2026.8.31",
        "npx -y @playwright/mcp@0.0.83 --headless --isolated --browser chromium --allowed-origins http://127.0.0.1:4178",
      ].join(","),
    ),
  });
});
afterAll(async () => {
  await board.destroy();
});

describe("the built-in templates", () => {
  it("run on an engine a worker has, on the current models", async () => {
    const { api } = await seedCompany(board, "tf-builtin@example.com");
    const builtIn = ((await api.get("/api/templates/teammates")).body as any[]).filter(
      (t) => t.companyId === null,
    );
    expect(builtIn).toHaveLength(9);
    expect(builtIn.find((t) => t.name === "Cody 3").engine).toBe("claude_code");
    expect(new Set(builtIn.map((t) => t.engine))).toEqual(new Set(["claude_code"]));
    expect(new Set(builtIn.map((t) => t.model))).toEqual(new Set(["claude-opus-5-5", "claude-sonnet-5-5"]));
  });

  it("a company's own templates are read through the company, and nobody else's company sees them", async () => {
    const a = await seedCompany(board, "tf-own-a@example.com");
    const imported = await a.api.post(`${a.base}/templates/import`, {
      format: "rosterdock/templates/1",
      teammateTemplates: [
        {
          name: "Closer",
          role: "account executive",
          model: "claude-sonnet-5",
          personaMd: "Our pricing floor.",
        },
      ],
    });
    expect(imported.status).toBe(200);
    const own = (await a.api.get(`${a.base}/templates/teammates`)).body as any[];
    expect(own.filter((t) => t.companyId === null)).toHaveLength(9);
    expect(own.find((t) => t.name === "Closer")).toMatchObject({
      companyId: a.companyId,
      personaMd: "Our pricing floor.",
    });

    // A person or a teammate of another company names the company in the board-wide route, or asks it.
    const b = await seedCompany(board, "tf-own-b@example.com");
    const ricky = await addTeammate(b.api, b.base, "Ricky");
    const asRicky = board.api((await b.api.post(`${b.base}/teammates/${ricky.id}/tokens`, {})).body.token);
    for (const api of [b.api, asRicky]) {
      const builtIn = await api.get(`/api/templates/teammates?companyId=${a.companyId}`);
      expect(builtIn.status).toBe(200);
      expect(builtIn.body).toHaveLength(9);
      expect(builtIn.body.every((t: any) => t.companyId === null)).toBe(true);
      expect((await api.get(`${a.base}/templates/teammates`)).status).toBe(403);
    }
  });
});

describe("templates as files", () => {
  it("exports a company by name and imports it into another, resolving members, leads and templates", async () => {
    const src = await seedCompany(board, "tf1@example.com");
    const cody = await addTeammate(src.api, src.base, "Cody");
    const verifier = await addTeammate(src.api, src.base, "Verifier", "reviewer");
    const conn = await src.api.post(`${src.base}/connections`, {
      name: "n8n",
      catalogId: "n8n",
      url: "https://n8n.test/mcp",
    });
    expect(conn.status).toBe(201);
    expect(
      (
        await src.api.patch(`${src.base}/teammates/${cody.id}`, {
          toolbox: [{ connection: "n8n", mode: "ask" }],
        })
      ).status,
    ).toBe(200);
    const dept = await src.api.post(`${src.base}/departments`, {
      name: "Engineering",
      writePolicy: "drafts",
      leadTeammateId: cody.id,
      memberTeammateIds: [verifier.id],
      sandbox: { timeoutSeconds: 900 },
    });
    expect(dept.status).toBe(201);
    // A project whose client narrows what n8n may do, and one that says nothing (not exported).
    const vms = await addProject(src.api, src.base, "VMS architecture map");
    expect(
      (
        await src.api.patch(`${src.base}/projects/${vms.id}`, {
          clientPolicy: { default: "read", caps: { n8n: "read" } },
        })
      ).status,
    ).toBe(200);
    await addProject(src.api, src.base, "Unrelated");

    const exported = await src.api.get(`${src.base}/templates/export`);
    expect(exported.status).toBe(200);
    const file = exported.body;
    expect(file.format).toBe("rosterdock/templates/1");
    expect(file.company).toEqual({ name: "GTM Studio", template: "GTM company" });
    expect(file.teammates.map((t: any) => t.name)).toEqual(["Peter", "Cody", "Verifier"]);
    expect(file.teammates.find((t: any) => t.name === "Peter").template).toBe("Peter");
    expect(file.teammates.find((t: any) => t.name === "Cody").toolbox).toEqual([
      { connection: "n8n", mode: "ask" },
    ]);
    expect(file.departments).toEqual([
      {
        name: "Engineering",
        slug: "engineering",
        writePolicy: "drafts",
        sandbox: { timeoutSeconds: 900 },
        lead: "Cody",
        members: ["Cody", "Verifier"],
      },
    ]);
    // Connections by name (env var NAMES only) and the client policies that narrow something.
    expect(file.connections).toEqual([
      expect.objectContaining({
        name: "n8n",
        catalogId: "n8n",
        kind: "mcp",
        transport: "http",
        url: "https://n8n.test/mcp",
        authEnvName: null,
        envNames: [],
        enabled: true,
      }),
    ]);
    expect(file.connections[0].tools.length).toBeGreaterThan(0);
    expect(file.clientPolicies).toEqual([
      { project: "VMS architecture map", policy: { default: "read", caps: { n8n: "read" } } },
    ]);

    // Into a fresh company that has Peter, no n8n connection and nothing else.
    const dst = await seedCompany(board, "tf2@example.com");
    const imported = await dst.api.post(`${dst.base}/templates/import`, file);
    expect(imported.status).toBe(200);
    expect(imported.body.created).toEqual({
      teammateTemplates: [],
      teammates: ["Cody", "Verifier"],
      departments: ["Engineering"],
      connections: ["n8n"],
    });
    expect(imported.body.skipped).toEqual(["teammate Peter"]);
    // The connection came with the file, so Cody's grant holds; the project did not, so its policy waits.
    expect(imported.body.notes).toEqual([
      "client policy for VMS architecture map: no project by that name here; skipped",
    ]);
    expect(imported.body.clientPolicies).toEqual([]);
    const conns = (await dst.api.get(`${dst.base}/connections`)).body as any[];
    expect(conns.map((c) => [c.name, c.url, c.authEnvName])).toEqual([["n8n", "https://n8n.test/mcp", null]]);
    const mates = (await dst.api.get(`${dst.base}/teammates`)).body as any[];
    const cody2 = mates.find((t) => t.name === "Cody");
    expect(cody2.role).toBe("n8n engineer");
    expect(cody2.toolbox).toEqual([{ connection: "n8n", mode: "ask" }]);
    expect(cody2.departments).toEqual([{ id: expect.any(String), name: "Engineering", isLead: true }]);
    const depts = (await dst.api.get(`${dst.base}/departments`)).body as any[];
    expect(depts[0].leadTeammateId).toBe(cody2.id);
    expect(depts[0].members.map((m: any) => m.name)).toEqual(["Cody", "Verifier"]);
    expect(depts[0].sandbox).toEqual({ timeoutSeconds: 900 });
    // With the project in place, importing again sets its policy; everything else is already here.
    const vms2 = await addProject(dst.api, dst.base, "VMS architecture map");
    const again = await dst.api.post(`${dst.base}/templates/import`, file);
    expect(again.body.created).toEqual({
      teammateTemplates: [],
      teammates: [],
      departments: [],
      connections: [],
    });
    expect(again.body.clientPolicies).toEqual(["VMS architecture map"]);
    expect(again.body.skipped).toEqual([
      "connection n8n",
      "teammate Peter",
      "teammate Cody",
      "teammate Verifier",
      "department Engineering",
    ]);
    expect((await dst.api.get(`${dst.base}/projects/${vms2.id}`)).body.clientPolicy).toEqual({
      default: "read",
      caps: { n8n: "read" },
    });
    // The event stream says what happened.
    const events = (await dst.api.get(`${dst.base}/events?limit=50`)).body as any[];
    const imports = events.filter(
      (e) => e.type === "company.updated" && e.payload.changes?.[0] === "templates.imported",
    );
    expect(imports).toHaveLength(2);
    expect(imports.at(-1).payload.created.teammates).toEqual(["Cody", "Verifier"]);
    expect(events.filter((e) => e.type === "teammate.created" && e.payload.fromFile)).toHaveLength(2);
  });

  it("the shipped example files import: a company from the global templates, a department with its own template", async () => {
    const { api, base } = await seedCompany(board, "tf3@example.com");
    for (const name of ["hubspot", "slack", "gong", "n8n"])
      expect(
        (await api.post(`${base}/connections`, { name, catalogId: name, url: `https://${name}.test/mcp` }))
          .status,
      ).toBe(201);
    const company = await api.post(`${base}/templates/import`, example("gtm-company.json"));
    expect(company.status).toBe(200);
    expect(company.body.created.teammates).toEqual([
      "Archy",
      "Cody",
      "Verifier",
      "Ricky",
      "Brody",
      "Reporter",
      "Cody 3",
    ]);
    expect(company.body.created.departments).toEqual(["Engineering", "Research", "Marketing ops"]);
    expect(company.body.notes).toEqual([]);
    const mates = (await api.get(`${base}/teammates`)).body as any[];
    const cody3 = mates.find((t) => t.name === "Cody 3");
    // The file overrides the template's engine (opencode is not enabled) and keeps its persona.
    expect(cody3.engine).toBe("claude_code");
    expect(cody3.personaMd).toMatch(/HubSpot/);
    expect(cody3.toolbox).toEqual([{ connection: "hubspot", mode: "ask" }]);

    const finance = await api.post(`${base}/templates/import`, example("finance-department.json"));
    expect(finance.status).toBe(200);
    expect(finance.body.created).toEqual({
      teammateTemplates: ["Bookkeeper"],
      teammates: ["Finn", "Bookkeeper"],
      departments: ["Finance"],
      connections: [],
    });
    expect(finance.body.skipped).toEqual(["teammate Verifier"]);
    // xero is not connected here: the grants are dropped, and the file says so per teammate.
    expect(finance.body.notes).toEqual([
      "teammate Finn: no connection named xero here; grant dropped",
      "teammate Bookkeeper: no connection named xero here; grant dropped",
    ]);
    const bookkeeper = (await api.get(`${base}/teammates`)).body.find((t: any) => t.name === "Bookkeeper");
    expect(bookkeeper.role).toBe("bookkeeper");
    expect(bookkeeper.personaMd).toMatch(/never post, pay or reconcile/);
    const templates = (await api.get(`${base}/templates/teammates`)).body;
    expect(templates.some((t: any) => t.name === "Bookkeeper" && t.companyId !== null)).toBe(true);
  });

  it("the Lighthouse demo file imports whole: its local connections first, with a person's gates as written", async () => {
    const { api, base } = await seedCompany(board, "tf-lighthouse@example.com");
    const res = await api.post(`${base}/templates/import`, example("lighthouse-company.json"));
    expect(res.status).toBe(200);
    expect(res.body.created.connections).toEqual(["drive", "staging", "notes", "browser"]);
    expect(res.body.created.teammates).toHaveLength(17);
    expect(res.body.created.departments).toEqual(["Research", "Engineering", "Marketing", "Finance"]);
    // Every grant found its connection: nothing dropped.
    expect(res.body.notes).toEqual([]);

    const connections = (await api.get(`${base}/connections`)).body as any[];
    const tool = (conn: string, name: string) =>
      connections.find((c) => c.name === conn).tools.find((t: any) => t.name === name);
    expect(connections.every((c) => c.transport === "stdio" && c.command === "npx")).toBe(true);
    // Staging is scratch: its writes are not gated. The drive's moves and every delete in the notes are off.
    expect(tool("staging", "write_file")).toMatchObject({ write: false, source: "person" });
    expect(tool("drive", "move_file")).toMatchObject({ off: true });
    expect(tool("notes", "delete_entities")).toMatchObject({ off: true });
    expect(tool("browser", "browser_run_code_unsafe")).toMatchObject({ off: true });
    // The browser reaches one origin and never file:// URLs.
    const browser = connections.find((c) => c.name === "browser");
    expect(browser.args).toContain("http://127.0.0.1:4178");
    expect(browser.args).not.toContain("--allow-unrestricted-file-access");

    const mates = (await api.get(`${base}/teammates`)).body as any[];
    const mate = (name: string) => mates.find((t) => t.name === name);
    expect(mate("Dex").engine).toBe("codex");
    // Only QA holds the browser, and only the tools named on the line.
    expect(
      mates.filter((t) => t.toolbox.some((e: any) => e.connection === "browser")).map((t) => t.name),
    ).toEqual(["Tess"]);
    expect(mate("Tess").toolbox.find((e: any) => e.connection === "browser").tools).not.toContain(
      "browser_click",
    );
    // Makers may propose a drive write; leads and reviewers read it.
    expect(mate("Fern").toolbox.find((e: any) => e.connection === "drive")).toMatchObject({ mode: "ask" });
    for (const name of ["Ricky", "Archy", "Edie", "Tess", "Verifier"])
      expect(mate(name).toolbox.find((e: any) => e.connection === "drive")?.mode).toBe("read");

    const departments = (await api.get(`${base}/departments`)).body as any[];
    for (const d of departments) {
      // A lead plans; a reviewer is on hand, so no review waits for a person.
      expect(d.leadTeammateId).toBeTruthy();
      expect(d.members.some((m: any) => /(review|verif|\bqa\b)/i.test(m.role))).toBe(true);
    }
    // Research reaches the web from its sandbox, so it is not a read-only department.
    const research = departments.find((d) => d.name === "Research");
    expect(research.writePolicy).toBe("drafts");
    expect(research.sandbox.allowedTools).toContain("WebSearch");
  });

  it("the Cirrus demo file imports whole: two local folders, makers who may propose, reviewers who read", async () => {
    const { api, base } = await seedCompany(board, "tf-cirrus@example.com");
    const res = await api.post(`${base}/templates/import`, example("cirrus-company.json"));
    expect(res.status).toBe(200);
    expect(res.body.created.connections).toEqual(["drive", "staging"]);
    expect(res.body.created.teammates).toHaveLength(15);
    expect(res.body.created.departments).toEqual([
      "Customer Insight",
      "Customer Care",
      "AI Engineering",
      "Content",
    ]);
    expect(res.body.notes).toEqual([]);

    const connections = (await api.get(`${base}/connections`)).body as any[];
    const tool = (conn: string, name: string) =>
      connections.find((c) => c.name === conn).tools.find((t: any) => t.name === name);
    expect(tool("drive", "move_file")).toMatchObject({ off: true });
    expect(tool("staging", "write_file")).toMatchObject({ write: false, source: "person" });

    const mates = (await api.get(`${base}/teammates`)).body as any[];
    const mate = (name: string) => mates.find((t) => t.name === name);
    // The company's own Archy and Reporter, not the global personas of the same name.
    expect(mate("Archy").role).toBe("AI engineering lead");
    expect(mate("Reporter").role).toBe("editorial writer");
    // Whoever writes to customers may only propose it; whoever reviews only reads.
    expect(mate("Sage").toolbox.find((e: any) => e.connection === "drive")).toMatchObject({ mode: "ask" });
    expect(mate("Sage").toolbox.find((e: any) => e.connection === "drive").tools).not.toContain("edit_file");
    for (const name of ["Iris", "Archy", "Edie", "Tess"])
      expect(mate(name).toolbox.find((e: any) => e.connection === "drive")?.mode).toBe("read");

    const departments = (await api.get(`${base}/departments`)).body as any[];
    for (const d of departments) {
      expect(d.leadTeammateId).toBeTruthy();
      expect(d.members.some((m: any) => /(review|verif|\bqa\b)/i.test(m.role))).toBe(true);
      // A lead never takes a task in its own goal: two makers at least, so no plan leans on the reviewer.
      const makers = d.members.filter(
        (m: any) => m.id !== d.leadTeammateId && !/(review|verif|\bqa\b)/i.test(m.role),
      );
      if (d.name !== "Customer Care") expect(makers.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("the cluster example lists the demos' servers on their own folders, and nothing wider", () => {
    const values = YAML.parse(
      readFileSync(
        path.join(here, "..", "..", "..", "deploy", "helm", "rosterdock", "examples", "local.yaml"),
        "utf8",
      ),
    ) as { board: { stdioCommands: string[] } };
    const listed = parseStdioCommands(values.board.stdioCommands.join(","));
    expect(listed.some((c) => c.more)).toBe(false);
    // Where deploy/scripts/demo.mjs --board-root starts each demo's connections on the board's volume.
    for (const [file, from, to] of [
      ["lighthouse-company.json", "~/Lighthouse", "/home/node/Lighthouse"],
      ["cirrus-company.json", "~/Cirrus", "/home/node/Lighthouse/cirrus"],
    ] as const) {
      for (const c of example(file).connections as { command: string; args: string[] }[]) {
        const args = c.args.map((a) => (a.startsWith(`${from}/`) ? `${to}${a.slice(from.length)}` : a));
        expect(stdioCommandAllowed(listed, c.command, args), `${file}: ${c.command} ${args.join(" ")}`).toBe(
          true,
        );
      }
    }
  });

  it("leaves a Codex teammate out of a department whose tool list Codex cannot keep to, with a note", async () => {
    const { api, base } = await seedCompany(board, "tf5@example.com");
    const imported = await api.post(`${base}/templates/import`, {
      format: "rosterdock/templates/1",
      teammates: [
        {
          name: "Dex",
          role: "automation engineer",
          engine: "codex",
          model: "gpt-6-astra",
          personaMd: "Scripts.",
        },
        { name: "Scout", role: "market analyst", model: "claude-sonnet-5-5", personaMd: "Research." },
      ],
      departments: [
        {
          name: "Research",
          lead: "Dex",
          members: ["Scout", "Dex"],
          sandbox: { allowedTools: ["Read(./**)", "Write(./**)", "WebSearch"] },
        },
        {
          name: "Engineering",
          lead: "Dex",
          sandbox: { allowedTools: ["Read(./**)", "Write(./**)", "Bash"] },
        },
      ],
    });
    expect(imported.status).toBe(200);
    expect(imported.body.created.departments).toEqual(["Research", "Engineering"]);
    expect(imported.body.notes).toEqual([
      "department Research: Dex runs on Codex, which cannot keep to its tool list (it reads files and runs commands only through its shell, and the list leaves out Bash); not added",
    ]);
    const depts = (await api.get(`${base}/departments`)).body;
    expect(
      depts.map((d: any) => [d.name, d.leadTeammateId !== null, d.members.map((m: any) => m.name)]),
    ).toEqual([
      ["Research", false, ["Scout"]],
      ["Engineering", true, ["Dex"]],
    ]);
  });

  it("refuses a file that carries a credential value, a wrong format, or a stranger's role", async () => {
    const { api, base, companyId } = await seedCompany(board, "tf4@example.com");
    const leaky = {
      format: "rosterdock/templates/1",
      teammates: [
        {
          name: "Leaky",
          role: "engineer",
          model: "claude-sonnet-5",
          personaMd: "Use the key below.",
          playbooks: ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ"],
        },
      ],
    };
    expect((await api.post(`${base}/templates/import`, leaky)).status).toBe(422);
    expect((await api.post(`${base}/templates/import`, { format: "rosterdock/templates/2" })).status).toBe(
      400,
    );
    expect((await api.get(`${base}/teammates`)).body.map((t: any) => t.name)).toEqual(["Peter"]);
    const viewer = await board.login("tf4-viewer@example.com");
    expect(
      (await api.post(`${base}/members`, { email: "tf4-viewer@example.com", role: "viewer" })).status,
    ).toBe(201);
    const asViewer = board.api(viewer.token);
    expect((await asViewer.get(`/api/companies/${companyId}/templates/export`)).status).toBe(200);
    expect(
      (
        await asViewer.post(`/api/companies/${companyId}/templates/import`, {
          format: "rosterdock/templates/1",
        })
      ).status,
    ).toBe(403);
  });
});
