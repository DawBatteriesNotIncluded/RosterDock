// The OpenAPI runtime: a spec plus an allowlist becomes a connection whose tools
// are HTTP operations; mutating methods are always writes; the broker treats it
// like any connection (reads run, writes are approvals, the approved body is
// the request body); limits and redaction are enforced. A fake service replays
// recorded bodies; no network.
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildOpenApiManifest,
  callOpenApiOperation,
  parseOpenApiText,
  scanOpenApi,
  toolNameFor,
} from "../src/mcp/openapi.js";
import { parsePrivateDestinations } from "../src/web/address.js";
import { boardEgress } from "../src/web/egress.js";
import { fakeOpenApi } from "./openapi-fake.js";
import {
  addProject,
  addTeammate,
  seedCompany,
  startTestBoard,
  testEgress,
  workerClaim,
  workerComplete,
  type TestBoard,
} from "./helpers.js";

const spec = JSON.parse(
  readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "openapi", "crm-openapi.json"),
    "utf8",
  ),
) as Record<string, unknown>;

let board: TestBoard;
let baseUrl: string;
const service = fakeOpenApi();
const env: NodeJS.ProcessEnv = { CRM_API_TOKEN: "fixture-crm-secret-000" };

beforeAll(async () => {
  board = await startTestBoard({ sharedEnvNames: ["CRM_API_TOKEN"] }, { mcpFetch: service.fetch, env });
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
  const t = (result.content as { text?: string }[])[0]?.text ?? "";
  try {
    return { value: JSON.parse(t), isError: !!result.isError };
  } catch {
    return { value: t, isError: !!result.isError };
  }
}

describe("the OpenAPI runtime", () => {
  it("scans a spec into operations classified by method, and builds a manifest from an allowlist", () => {
    const scan = scanOpenApi(spec);
    expect(scan.errors).toEqual([]);
    expect(scan.operations.map((o) => [o.name, o.method, o.write])).toEqual([
      ["list_contacts", "get", false],
      ["create_contact", "post", true],
      ["get_contact", "get", false],
      ["delete_contact", "delete", true],
      ["run_report", "get", false],
    ]);
    expect(toolNameFor("getHubSpotDealV3")).toBe("get_hub_spot_deal_v3");
    const built = buildOpenApiManifest(spec, {
      allow: ["listContacts", "getContact", "createContact", "runReport"],
      writes: ["runReport"],
      timeoutMs: 999_999,
    });
    expect(built.errors).toEqual([]);
    expect(built.manifest?.timeoutMs).toBe(30_000);
    expect(built.manifest?.operations.map((o) => [o.name, o.write])).toEqual([
      ["list_contacts", false],
      ["get_contact", false],
      ["create_contact", true],
      ["run_report", true],
    ]);
    // Unknown ids and a spec without a version are refused; nothing is partially built.
    expect(buildOpenApiManifest(spec, { allow: ["nope"] }).errors).toContain(
      "operationId nope is not in the spec",
    );
    expect(buildOpenApiManifest({ paths: {} }, { allow: ["x"] }).errors[0]).toContain('"openapi": "3.x"');
    expect(scanOpenApi("yaml: no").errors[0]).toContain("a parsed object, or JSON or YAML text");
  });

  it("reads a spec as text: YAML and JSON alike, refusing what is neither", async () => {
    const yamlText = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "openapi", "crm-openapi.yaml"),
      "utf8",
    );
    expect(parseOpenApiText(yamlText).spec).toEqual(spec);
    expect(parseOpenApiText(JSON.stringify(spec)).spec).toEqual(spec);
    expect(parseOpenApiText("").error).toBe("the spec is empty");
    expect(parseOpenApiText("{ not json").error).toMatch(/not valid JSON/);
    expect(parseOpenApiText("- a\n- b").error).toMatch(/an object/);
    expect(parseOpenApiText("a: [\n").error).toMatch(/not valid YAML/);
    // Through the routes: the YAML text previews and registers the same connection as the JSON object.
    const { api, base } = await seedCompany(board, "oa2@example.com");
    const preview = await api.post(`${base}/connections/openapi/preview`, { spec: yamlText });
    expect(preview.status).toBe(200);
    expect(preview.body.operations.map((o: { operationId: string }) => o.operationId)).toEqual([
      "listContacts",
      "createContact",
      "getContact",
      "deleteContact",
      "runReport",
    ]);
    const broken = await api.post(`${base}/connections/openapi/preview`, { spec: "openapi: [\n" });
    expect(broken.status).toBe(422);
    expect(broken.body.error).toMatch(/not valid YAML/);
    const created = await api.post(`${base}/connections/openapi`, {
      name: "crm-yaml",
      url: "https://crm.example.test/v1",
      spec: yamlText,
      allow: ["listContacts"],
    });
    expect(created.status).toBe(201);
    expect(created.body.tools.map((t: { name: string }) => t.name)).toEqual(["list_contacts"]);
  });

  it("scrubs the credential from an answer, cut or escaped, and a cut answer says nothing of a guess at it", async () => {
    const secret = env.CRM_API_TOKEN!;
    const manifest = buildOpenApiManifest(spec, { allow: ["listContacts"] }).manifest!;
    const target = { url: "https://crm.example.test/v1", authEnvName: "CRM_API_TOKEN" };
    const answering = (body: string) =>
      (async () =>
        new Response(body, { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const call = async (body: string, maxResponseBytes: number, values: NodeJS.ProcessEnv = env) =>
      callOpenApiOperation(
        target,
        { ...manifest, maxResponseBytes },
        { egress: testEgress(answering(body)), env: values },
        "list_contacts",
        {},
      );
    // An answer that echoes the request's header, cut 9 characters into the credential: the end is dropped.
    const head = `{"echo":"${"p".repeat(400)} Authorization: Bearer `;
    const cut = await call(`${head}${secret}","more":"${"x".repeat(200)}"}`, head.length + 9);
    expect(cut).toMatchObject({ ok: true, result: { truncated: true } });
    const text = (cut as { result: { text: string } }).result.text;
    expect(text.length).toBe(head.length + 9 - 16 * secret.length);
    expect(text).not.toContain(secret.slice(0, 4));
    // A teammate that pads its guess at the credential to the cut learns nothing: right or wrong, the same text.
    const guess = (g: string) =>
      call(`{"echo":"${"p".repeat(400)}${g}","more":"${"x".repeat(300)}"}`, 410 + g.length);
    expect(await guess(secret.slice(0, 6))).toEqual(await guess("zzzzzz"));
    // As JSON escapes it, slash and all: scrubbed in the text and in what is parsed.
    const slashed = { CRM_API_TOKEN: "ab/cd/ef/gh/ij" };
    const escaped = await call('{"auth":"ab\\/cd\\/ef\\/gh\\/ij","n":1}', 4096, slashed);
    expect(escaped).toEqual({ ok: true, result: { auth: "[redacted]", n: 1 } });
    // Escaped as .NET writes `+`, cut or whole, and as a key.
    const plus = { CRM_API_TOKEN: "AbC+dEf+GhI/jKl=" };
    const unicode = "AbC\\u002BdEf\\u002bGhI\\/jKl=";
    const cutPlus = await call(`{"echo":"${unicode}","more":"${"x".repeat(600)}"}`, 400, plus);
    expect(JSON.stringify(cutPlus)).not.toMatch(/AbC|dEf|GhI/);
    expect(JSON.stringify(cutPlus)).toContain("[redacted]");
    const keyed = await call(`{"${unicode}":1,"AbC+dEf+GhI/jKl=":2}`, 4096, plus);
    expect(keyed).toEqual({ ok: true, result: { "[redacted]": 2 } });
  });

  it("scrubs the credential however deep JSON in an answer escapes it, cut, line by line or after a BOM", async () => {
    const manifest = buildOpenApiManifest(spec, { allow: ["listContacts"] }).manifest!;
    const secret = "AbC+dEf+GhI/jKl=";
    const call = (body: string, maxResponseBytes = 4096) => {
      const answering = (async () =>
        new Response(body, { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
      return callOpenApiOperation(
        { url: "https://crm.example.test/v1", authEnvName: "CRM_API_TOKEN" },
        { ...manifest, maxResponseBytes },
        { egress: testEgress(answering), env: { CRM_API_TOKEN: secret } },
        "list_contacts",
        {},
      );
    };
    // A request log whose headers are JSON written by PHP (\/) and .NET (+), kept as a string: in the
    // answer the credential is escaped twice. Written out as the service sends it.
    const headers = '{"authorization":"Bearer AbC\\u002BdEf\\u002BGhI\\/jKl="}';
    const clean = '{"authorization":"Bearer [redacted]"}';
    const body = JSON.stringify({ log: [{ path: "/v1/contacts", headers }] });
    expect(body).not.toContain(secret);
    expect(await call(body)).toEqual({
      ok: true,
      result: { log: [{ path: "/v1/contacts", headers: clean }] },
    });
    // After a byte order mark, still JSON.
    expect(await call(`﻿${body}`)).toEqual({
      ok: true,
      result: { log: [{ path: "/v1/contacts", headers: clean }] },
    });
    // Escaped three times: a log entry whose body carries the headers string.
    const thrice = JSON.stringify({ log: [{ body: JSON.stringify({ headers }) }] });
    expect(await call(thrice)).toEqual({
      ok: true,
      result: { log: [{ body: JSON.stringify({ headers: clean }) }] },
    });
    // A long log cut at its cap: never parsed, and still nothing of the credential.
    const long = JSON.stringify({
      log: Array.from({ length: 40 }, (_, i) => ({ path: `/v1/contacts/${i}`, headers })),
    });
    const cut = await call(long, 2000);
    expect(cut).toMatchObject({ ok: true, result: { truncated: true } });
    const cutText = (cut as { result: { text: string } }).result.text;
    expect(cutText).toContain("[redacted]");
    expect(cutText).not.toMatch(/AbC|dEf|GhI|jKl/);
    // Newline-delimited JSON: each line cleaned, a secret-looking key too, and written back as lines.
    const ndjson = `${JSON.stringify({ path: "/a", headers })}\n${JSON.stringify({ path: "/b", token: "t-1" })}\n`;
    expect(await call(ndjson)).toEqual({
      ok: true,
      result: `${JSON.stringify({ path: "/a", headers: clean })}\n${JSON.stringify({ path: "/b", token: "[redacted]" })}\n`,
    });
  });

  it("never repeats a reason phrase", async () => {
    const manifest = buildOpenApiManifest(spec, { allow: ["listContacts"] }).manifest!;
    const secret = "AbC+dEf+GhI/jKl=";
    // A refusal whose reason phrase echoes the credential, from a real server: the status alone comes back.
    const server = http.createServer((_req, res) => {
      res.writeHead(401, `Invalid token ${secret}`);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const port = (server.address() as AddressInfo).port;
      const refused = await callOpenApiOperation(
        { url: `http://crm.test:${port}/v1`, authEnvName: "CRM_API_TOKEN" },
        manifest,
        {
          egress: boardEgress(parsePrivateDestinations("127.0.0.1"), async () => ["127.0.0.1"]),
          env: { CRM_API_TOKEN: secret },
        },
        "list_contacts",
        {},
      );
      expect(refused).toEqual({ ok: false, error: "list_contacts answered HTTP 401" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("scrubs a large answer in one linear pass, whatever its strings or the credential hold", async () => {
    const manifest = {
      ...buildOpenApiManifest(spec, { allow: ["listContacts"] }).manifest!,
      maxResponseBytes: 2_000_000,
    };
    const call = async (body: string, secret: string) => {
      const answering = (async () =>
        new Response(body, { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
      const started = performance.now();
      const outcome = await callOpenApiOperation(
        { url: "https://crm.example.test/v1", authEnvName: "CRM_API_TOKEN" },
        manifest,
        { egress: testEgress(answering), env: { CRM_API_TOKEN: secret } },
        "list_contacts",
        {},
      );
      return { outcome, ms: performance.now() - started };
    };
    // Half a megabyte of empty strings, and a credential of backslashes in a run of escaped backslashes: a
    // pattern built per string held the board's event loop 2.3 s for the first, a backtracking one 5.3 s for
    // the second. A few tens of milliseconds now; the bound leaves room for a slow machine.
    const empties = await call(
      `[${Array.from({ length: 170_000 }, () => '""').join(",")}]`,
      env.CRM_API_TOKEN!,
    );
    expect(empties.outcome.ok).toBe(true);
    expect(empties.ms).toBeLessThan(250);
    const backslashes = await call(`{"v":"${"\\\\".repeat(120_000)}"}`, `${"\\".repeat(24)}tail00`);
    expect(backslashes.outcome.ok).toBe(true);
    expect(backslashes.ms).toBeLessThan(250);
    // A long credential of one character over and over but one, in a megabyte of that character: indexOf
    // took 730 ms for it, comparing the credential afresh at every place; this search is one pass.
    const nearly = await call(`{"v":"${"a".repeat(1_000_000)}"}`, `${"a".repeat(2048)}b${"a".repeat(2047)}`);
    expect(nearly.outcome.ok).toBe(true);
    expect(nearly.ms).toBeLessThan(250);
    // And the scan finds what the pattern found: escaped or not, wherever it starts.
    const mixed = await call(
      `{"a":"x${"\\u0041bC+dEf+GhI\\/jKl="}y","b":"AbC\\u002bdEf+GhI/jKl="}`,
      "AbC+dEf+GhI/jKl=",
    );
    expect(mixed.outcome).toEqual({ ok: true, result: { a: "x[redacted]y", b: "[redacted]" } });
  });

  it("calls an operation with path and query parameters, the credential by name, and redacts the answer", async () => {
    const manifest = buildOpenApiManifest(spec, {
      allow: ["listContacts", "getContact", "createContact"],
    }).manifest!;
    const target = { url: "https://crm.example.test/v1", authEnvName: "CRM_API_TOKEN" };
    service.requests.length = 0;
    const list = await callOpenApiOperation(
      target,
      manifest,
      { egress: testEgress(service.fetch), env },
      "list_contacts",
      {
        query: { domain: "globex.example" },
      },
    );
    expect(list.ok).toBe(true);
    const rows = (list as { result: { results: Record<string, unknown>[] } }).result.results;
    expect(rows[0]!.apiToken).toBe("[redacted]");
    expect(rows[1]!.email).toBe("ben@globex.example");
    expect(service.requests[0]).toMatchObject({
      method: "GET",
      url: "https://crm.example.test/v1/contacts?domain=globex.example",
      headers: { authorization: "Bearer fixture-crm-secret-000", accept: "application/json" },
      body: null,
    });
    const one = await callOpenApiOperation(
      target,
      manifest,
      { egress: testEgress(service.fetch), env },
      "get_contact",
      {
        pathParams: { contactId: "c 101" },
      },
    );
    expect(one.ok).toBe(true);
    expect(service.requests[1]!.url).toBe("https://crm.example.test/v1/contacts/c%20101");
    // Missing path parameter, unknown operation, missing credential: nothing is called.
    const n = service.requests.length;
    expect(
      await callOpenApiOperation(
        target,
        manifest,
        { egress: testEgress(service.fetch), env },
        "get_contact",
        {},
      ),
    ).toEqual({
      ok: false,
      error: "path parameter contactId is required and must be a scalar; nothing was called",
    });
    expect(
      (
        await callOpenApiOperation(
          target,
          manifest,
          { egress: testEgress(service.fetch), env },
          "delete_contact",
          {},
        )
      ).ok,
    ).toBe(false);
    expect(
      await callOpenApiOperation(
        target,
        manifest,
        { egress: testEgress(service.fetch), env: {} },
        "list_contacts",
        {},
      ),
    ).toEqual({
      ok: false,
      error:
        "CRM_API_TOKEN is not set for this company (its secrets, or a name the board shares); nothing was called",
    });
    expect(service.requests).toHaveLength(n);
    // A failing service: the status line only, never its body; an oversize answer is capped.
    service.failWith = 503;
    const down = await callOpenApiOperation(
      target,
      manifest,
      { egress: testEgress(service.fetch), env },
      "list_contacts",
      {},
    );
    service.failWith = null;
    expect(down).toEqual({ ok: false, error: "list_contacts answered HTTP 503" });
    service.bigResponseBytes = 300 * 1024;
    const big = await callOpenApiOperation(
      target,
      manifest,
      { egress: testEgress(service.fetch), env },
      "list_contacts",
      {},
    );
    service.bigResponseBytes = null;
    expect((big as { result: { truncated: boolean; text: string } }).result.truncated).toBe(true);
    expect((big as { result: { text: string } }).result.text.length).toBeLessThanOrEqual(
      manifest.maxResponseBytes,
    );
    // A body over the cap never leaves.
    const huge = await callOpenApiOperation(
      target,
      manifest,
      { egress: testEgress(service.fetch), env },
      "create_contact",
      {
        body: { blob: "x".repeat(manifest.maxRequestBytes + 10) },
      },
    );
    expect((huge as { error: string }).error).toContain("over");
  });

  it("is a connection like any other: preview, add with an allowlist, read through the broker, write as an approval", async () => {
    const { api, base } = await seedCompany(board, "oa1@example.com");
    const preview = await api.post(`${base}/connections/openapi/preview`, { spec });
    expect(preview.status).toBe(200);
    expect(preview.body.operations.map((o: { operationId: string }) => o.operationId)).toEqual([
      "listContacts",
      "createContact",
      "getContact",
      "deleteContact",
      "runReport",
    ]);
    const created = await api.post(`${base}/connections/openapi`, {
      name: "crm",
      url: "https://crm.example.test/v1",
      authEnvName: "CRM_API_TOKEN",
      spec,
      allow: ["listContacts", "getContact", "createContact"],
    });
    expect(created.status).toBe(201);
    expect(created.body.kind).toBe("openapi");
    expect(
      created.body.tools.map((t: { name: string; write: boolean; source: string }) => [
        t.name,
        t.write,
        t.source,
      ]),
    ).toEqual([
      ["list_contacts", false, "method"],
      ["get_contact", false, "method"],
      ["create_contact", true, "method"],
    ]);
    expect(created.body.manifest.operations).toHaveLength(3);
    // Discovery is for MCP; an OpenAPI connection carries its manifest.
    expect((await api.post(`${base}/connections/${created.body.id}/discover`, {})).status).toBe(422);
    // A check is one GET on the base URL with the credential; any answer but an error means it is there.
    service.requests.length = 0;
    const checked = await api.post(`${base}/connections/${created.body.id}/check`, {});
    expect(checked.body.lastCheck).toMatchObject({
      ok: true,
      error: null,
      tools: { seen: 3, missing: [], extra: [] },
    });
    expect(service.requests[0]).toMatchObject({
      method: "GET",
      url: "https://crm.example.test/v1",
      headers: { authorization: "Bearer fixture-crm-secret-000" },
    });
    service.failWith = 503;
    const down = await api.post(`${base}/connections/${created.body.id}/check`, {});
    service.failWith = null;
    expect(down.body.lastCheck).toMatchObject({ ok: false, error: "the service answered HTTP 503" });
    // A bad allowlist is refused with the reasons.
    const bad = await api.post(`${base}/connections/openapi`, {
      name: "crm2",
      url: "https://crm.example.test/v1",
      spec,
      allow: ["nope"],
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toContain("operationId nope is not in the spec");

    const cody = await addTeammate(api, base, "Cody");
    await api.patch(`${base}/teammates/${cody.id}`, { toolbox: [{ connection: "crm", mode: "ask" }] });
    const project = await addProject(api, base);
    const task = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "Add the new champion to the CRM",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    const run = (await api.post(`${base}/tasks/${task.id}/runs`, {})).body;
    const claimed = await workerClaim(board, run.id);
    expect(claimed.pack).toContain(
      "- crm (reads run, writes are proposed) · reads: list_contacts, get_contact · writes (proposed): create_contact",
    );
    const client = await connect(claimed.token);
    service.requests.length = 0;
    const read = text(
      await client.callTool({
        name: "board_tool_call",
        arguments: {
          connection: "crm",
          tool: "get_contact",
          arguments: { pathParams: { contactId: "c-101" } },
        },
      }),
    );
    expect(read.isError).toBe(false);
    expect(read.value.result.email).toBe("ana@globex.example");
    expect(service.requests[0]!.url).toBe("https://crm.example.test/v1/contacts/c-101");
    const proposed = text(
      await client.callTool({
        name: "board_tool_call",
        arguments: {
          connection: "crm",
          tool: "create_contact",
          arguments: { body: { email: "new@globex.example", name: "New Contact" } },
          title: "Create the contact New Contact in the CRM",
          why: "They signed the champion agreement today.",
        },
      }),
    );
    expect(proposed.value.kind).toBe("proposed");
    expect(service.requests).toHaveLength(1);
    await workerComplete(board, claimed.token, run.id, { status: "completed" });
    const pending = (await api.get(`${base}/approvals?status=pending`)).body;
    const decided = await api.post(`${base}/approvals/${pending[0].id}/approve`, {});
    expect(decided.body.status).toBe("executed");
    expect(decided.body.result.id).toBe("c-301");
    const sent = service.requests[1]!;
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe("https://crm.example.test/v1/contacts");
    expect(JSON.parse(sent.body!)).toEqual({ email: "new@globex.example", name: "New Contact" });
    expect(sent.headers.authorization).toBe("Bearer fixture-crm-secret-000");
    expect(JSON.stringify(decided.body)).not.toContain("fixture-crm-secret");
  });
});
