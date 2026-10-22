// Every place a company chooses where the board connects, held to the egress check through the board
// itself: an MCP server over HTTP (its check and a tool call), an OpenAPI service (its check and an
// operation), the OAuth endpoints a server names, a webhook and an SMTP server named in Settings, and a style
// pack's download. For each: an address in the URL, a public-looking name that resolves to a private address,
// a redirect hop to one, and the operator's list admitting what it names and nothing else. The refusal is
// what Settings and the event log show. The transports and the resolver are fakes; nothing reaches the network.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EventRecord } from "@rosterdock/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callConnectionTool } from "../src/mcp/call.js";
import { callMcpTool, discoverTools } from "../src/mcp/client.js";
import { scrubbedChars } from "../src/mcp/scrub.js";
import { loadConnection } from "../src/mcp/connections.js";
import {
  authorizationUrl,
  discoverAuthorizationServer,
  resourceAllowed,
  discoverResource,
  IssuerUnusable,
  OAuthError,
  refreshTokens,
  registerClient,
  resetOAuthCaches,
} from "../src/mcp/oauth.js";
import { rawUrl, STYLE_PACKS } from "../src/styles/catalog.js";
import { parsePrivateDestinations } from "../src/web/address.js";
import { companyEgress } from "../src/web/egress.js";
import { fileSecretStore } from "../src/secrets/file.js";
import { connectionSecretName } from "../src/secrets/store.js";
import { fakeMcp } from "./mcp-fake.js";
import { createOAuthFake } from "./oauth-fake.js";
import { fakeOpenApi } from "./openapi-fake.js";
import { PUBLIC_TEST_ADDRESS, seedCompany, startTestBoard, testEgress, type TestBoard } from "./helpers.js";

const NOT_ALLOWED = "which this board's operator has not allowed";

const names: Record<string, string[]> = {
  localhost: ["127.0.0.1"],
  "mcp.intranet.test": ["10.0.0.5"],
  "mcp.allowed.test": ["10.0.0.6"],
  "auth.intranet.test": ["10.0.0.8"],
  "auth.allowed.test": ["10.0.0.9"],
  "crm.intranet.test": ["10.0.0.40"],
  "hooks.intranet.test": ["169.254.169.254"],
  "hooks.board.test": ["10.0.0.30"],
  "smtp.intranet.test": ["10.0.0.25"],
  "mcp.only-a.test": ["10.0.0.71"],
  "hooks.only-a.test": ["10.0.0.72"],
  "auth.only-a.test": ["10.0.0.73"],
};
const resolve = async (host: string) => names[host] ?? [PUBLIC_TEST_ADDRESS];

const spec = JSON.parse(
  readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "openapi", "crm-openapi.json"),
    "utf8",
  ),
) as Record<string, unknown>;

const mcp = fakeMcp();
const crm = fakeOpenApi();
// The MCP server's metadata names an authorization server that resolves to a private address.
const oauth = createOAuthFake({
  mcpUrl: "https://mcp.oauth.test/mcp",
  inner: mcp.fetch,
  issuer: "https://auth.intranet.test",
});
// One whose authorization server is public, for a row that kept a resource from before the origin check.
const reauth = createOAuthFake({
  mcpUrl: "https://mcp.reauth.test/mcp",
  inner: mcp.fetch,
  issuer: "https://auth.reauth.test",
});
const style = STYLE_PACKS.find((p) => p.id === "caveman")!;
/** Answered with a redirect, by URL. */
const redirects: Record<string, [number, string]> = {
  "https://mcp.moved.test/mcp": [307, "http://169.254.169.254/mcp"],
  "https://mcp.slash.test/mcp": [308, "https://mcp.slash.test/mcp/"],
  "https://crm.moved.test/v1": [302, "http://10.0.0.1/"],
  "https://crm.moved.test/v1/contacts": [307, "https://crm.example.test/v1/contacts"],
  "https://hooks.moved.test/services/T0/B0/secret-000": [308, "http://10.0.0.1/hook"],
};
/** Answered with this JSON, by URL: metadata a test writes for itself. */
const documents: Record<string, unknown> = {
  "https://mcp.script.test/.well-known/oauth-protected-resource/mcp": {
    resource: "https://mcp.script.test/mcp",
    authorization_servers: ["https://auth.script.test"],
  },
  "https://auth.script.test/.well-known/oauth-authorization-server": {
    issuer: "https://auth.script.test",
    authorization_endpoint: "javascript:fetch('/api/companies').then((r) => r.text())//",
    token_endpoint: "https://auth.script.test/token",
    registration_endpoint: "https://auth.script.test/register",
    code_challenge_methods_supported: ["S256"],
  },
};
/** Answered 500, by URL: a step a test makes fail. */
const failing = new Set<string>();
/** Every URL the transport was asked for: what the board sent. */
const sent: string[] = [];
const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  sent.push(url);
  const moved = redirects[url];
  if (moved) return new Response(null, { status: moved[0], headers: { location: moved[1] } });
  if (url in documents)
    return new Response(JSON.stringify(documents[url]), { headers: { "content-type": "application/json" } });
  if (failing.has(url)) return new Response("{}", { status: 500 });
  const host = new URL(url).hostname;
  // An authorization server that is down.
  if (host === "auth.down.test") return new Response(null, { status: 503 });
  if (host.startsWith("crm.")) return crm.fetch(input, init);
  if (host.startsWith("hooks.")) return new Response("ok", { status: 200 });
  if (host === "raw.githubusercontent.com") return new Response("not the pinned file", { status: 200 });
  if (host === "mcp.oauth.test" || host === "auth.intranet.test") return oauth.fetch(input, init);
  if (host === "mcp.reauth.test" || host === "auth.reauth.test") return reauth.fetch(input, init);
  return mcp.fetch(input, init);
}) as typeof fetch;

const env: NodeJS.ProcessEnv = {};
// The operator's list. Company ids exist only once the companies do, so a test gives a company its entries
// after creating it, on this same list the board reads.
const allow = parsePrivateDestinations("mcp.allowed.test,10.9.0.0/16");
const dir = mkdtempSync(path.join(os.tmpdir(), "rosterdock-egress-"));
let board: TestBoard;

beforeAll(async () => {
  resetOAuthCaches();
  board = await startTestBoard(
    {
      privateDestinations: allow,
      notifyWebhookUrl: "https://hooks.board.test/own",
      sharedEnvNames: ["GTM_HOOK", "GTM_SMTP", "SLASH_MCP_TOKEN", "HOOK_ONLY_A"],
      secretStore: { kind: "file", dir },
    },
    {
      mcpFetch: transport,
      notifyFetch: transport,
      stylesFetch: transport,
      egressResolve: resolve,
      env,
    },
  );
});
afterAll(async () => {
  await board.destroy();
  rmSync(dir, { recursive: true, force: true });
});

async function eventsOf(api: Awaited<ReturnType<typeof seedCompany>>["api"], base: string, type: string) {
  return ((await api.get(`${base}/events?limit=100`)).body as EventRecord[]).filter((e) => e.type === type);
}

describe("a company's MCP server over HTTP", () => {
  it("is refused at a private address, in its URL or behind its name, or behind a redirect, as Settings and the event log say", async () => {
    const { api, base } = await seedCompany(board, "egress-mcp@example.com");
    const cases: [string, string, string][] = [
      [
        "intranet",
        "https://mcp.intranet.test/mcp",
        `refused: mcp.intranet.test resolves to a private address, ${NOT_ALLOWED}`,
      ],
      [
        "metadata",
        "http://169.254.169.254/mcp",
        `refused: 169.254.169.254 is a link-local address, where cloud metadata lives, ${NOT_ALLOWED}`,
      ],
      [
        "loopback",
        "http://localhost:3001/mcp",
        `refused: localhost resolves to a loopback address, ${NOT_ALLOWED}`,
      ],
      ["literal", "http://10.0.0.5:8080/mcp", `refused: 10.0.0.5 is a private address, ${NOT_ALLOWED}`],
      [
        "moved",
        "https://mcp.moved.test/mcp",
        "mcp.moved.test answered 307, a redirect to http://169.254.169.254, which the board does not follow here: use the address it points to",
      ],
    ];
    sent.length = 0;
    for (const [name, url, error] of cases) {
      const created = await api.post(`${base}/connections`, { name, transport: "http", url });
      expect(created.status, name).toBe(201);
      const checked = await api.post(`${base}/connections/${created.body.id}/check`, {});
      expect(checked.body.lastCheck, name).toMatchObject({ ok: false, error });
    }
    // Only the redirect's first hop was sent anywhere: nothing went to a private address.
    expect(sent).toEqual(["https://mcp.moved.test/mcp"]);
    const checks = await eventsOf(api, base, "connection.checked");
    expect(checks.map((e) => e.payload.error).sort()).toEqual(cases.map((c) => c[2]).sort());
  });

  it("follows its server's own redirect, /mcp to /mcp/, with the bearer, as it did before the check", async () => {
    const { api, base } = await seedCompany(board, "egress-slash@example.com");
    env.SLASH_MCP_TOKEN = "slash-token-000000";
    const created = await api.post(`${base}/connections`, {
      name: "slash",
      transport: "http",
      url: "https://mcp.slash.test/mcp",
      authEnvName: "SLASH_MCP_TOKEN",
    });
    mcp.requests.length = 0;
    const checked = await api.post(`${base}/connections/${created.body.id}/check`, {});
    expect(checked.body.lastCheck).toMatchObject({ ok: true, error: null });
    expect(mcp.requests.every((r) => r.url === "https://mcp.slash.test/mcp/")).toBe(true);
    expect(mcp.requests[0]!.headers.authorization).toBe("Bearer slash-token-000000");
  });

  it("refuses to use or refresh a token a row kept for a resource its server may not speak for", async () => {
    sent.length = 0;
    const called = await callMcpTool(
      {
        transport: "http",
        url: "https://mcp.hostile.test/mcp",
        oauth: {
          secretName: "rosterdock-connection-kept",
          authorizationServer: "https://auth.real.test",
          authorizedAt: "2026-10-01T00:00:00.000Z",
          tokenEndpoint: "https://auth.real.test/token",
          clientId: "c",
          resource: "https://api.real.test/mcp",
          tokenAuth: null,
          clientSecretEnvName: null,
        },
      },
      { egress: testEgress(transport, { resolve }) },
      "whoami",
      {},
    );
    expect(called).toEqual({
      ok: false,
      error:
        "the connection's authorisation names a resource this server may not speak for (press Authorise on its card); nothing was called",
    });
    expect(sent).toEqual([]);
  });

  it("sends nothing another issuer issued, and a refresh that lost a race to Authorise writes nothing back", async () => {
    const store = fileSecretStore(dir);
    const secretName = "rosterdock-connection-race";
    const target = {
      transport: "http" as const,
      url: "https://mcp.race.test/mcp",
      oauth: {
        secretName,
        authorizationServer: "https://auth.race.test",
        authorizedAt: "2026-10-01T00:00:00.000Z",
        tokenEndpoint: "https://auth.race.test/token",
        clientId: "c",
        resource: "https://mcp.race.test/mcp",
        tokenAuth: null,
        clientSecretEnvName: null,
      },
    };
    // An entry another issuer's, as a late write leaves one: neither sent nor refreshed.
    sent.length = 0;
    await store.put(secretName, {
      issuer: "https://auth.other.test",
      access_token: "other-access-0000",
      refresh_token: "other-refresh-0000",
    });
    expect(
      await callMcpTool(target, { egress: testEgress(transport, { resolve }), secrets: store }, "whoami", {}),
    ).toEqual({
      ok: false,
      error: "the connection is not authorised (press Authorise on its card); nothing was called",
    });
    expect(sent).toEqual([]);
    // A refresh in flight while Authorise moves the connection: its answer serves this call, and the store
    // keeps what Authorise left, not the old issuer's secret and tokens.
    await store.put(secretName, {
      issuer: "https://auth.race.test",
      client_secret: "race-secret-0000",
      access_token: "race-access-0000",
      refresh_token: "race-refresh-0000",
      expires_at: "2026-01-01T00:00:00.000Z",
    });
    const racing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== "https://auth.race.test/token") return transport(input, init);
      await store.put(secretName, { issuer: "https://auth.new.test" });
      return new Response(
        JSON.stringify({
          access_token: "race-access-0001",
          refresh_token: "race-refresh-0001",
          expires_in: 3600,
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    expect(
      await callMcpTool(target, { egress: testEgress(racing, { resolve }), secrets: store }, "whoami", {}),
    ).toMatchObject({ ok: true });
    expect(await store.get(secretName)).toEqual({ issuer: "https://auth.new.test" });
  });

  it("takes the credential out of what an MCP server says back, its errors included, however JSON escapes it", async () => {
    // The recorded error answer, its words replaced by an echo of the bearer as a proxied API's log writes it:
    // JSON in a string, PHP's \/ and .NET's +.
    const recorded = (name: string) =>
      JSON.parse(
        readFileSync(
          path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp", name),
          "utf8",
        ),
      ) as { result: Record<string, unknown> };
    const error = recorded("tools-call-error.json");
    // The recorded tools list, its first description echoing the bearer too: kept on the row, shown to teammates.
    const listed = recorded("tools-list.json") as { result: { tools: Record<string, unknown>[] } };
    const echoed = 'upstream refused {"authorization":"Bearer AbC\\u002BdEf\\u002BGhI\\/jKl="}';
    const clean = 'upstream refused {"authorization":"Bearer [redacted]"}';
    const echoing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body
        ? (JSON.parse(String(init.body)) as { id?: number; method?: string; params?: { name?: string } })
        : null;
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
      // Text with a run of 256 backslashes, so every level is read, the credential echoed beside it.
      const run = `${echoed} ${"\\".repeat(256)}x and some plain words between the runs `;
      if (body?.method === "tools/list") {
        const [first, ...rest] = listed.result.tools;
        // At /mcp-wide, a page of 1,801 tools: the first with a name and a description of a megabyte each.
        const wide = String(input instanceof Request ? input.url : input).endsWith("/mcp-wide");
        const tools = wide
          ? [
              { ...first, name: run.repeat(2800), description: run.repeat(2800) },
              ...Array.from({ length: 1800 }, (_, i) => ({ ...first, name: `t${i}`, description: run })),
            ]
          : [{ ...first, description: echoed }, ...rest];
        return json(200, { ...listed, id: body.id, result: { ...listed.result, tools } });
      }
      if (body?.method !== "tools/call") return transport(input, init);
      // A server error whose body the SDK repeats in its own words, short or of 3.6 MB.
      if (body.params?.name === "broken") return json(500, { error: echoed });
      if (body.params?.name === "broken-huge")
        return json(500, { error: run.repeat(Math.ceil(3_600_000 / run.length)) });
      // The recorded error answer's shape, its text and any structured content written in as JSON text: Node
      // 22's JSON.stringify would overflow its stack on the 100,000 levels below.
      const tool = body.params?.name;
      const shaped = (text: string, structured: string | null) =>
        new Response(
          JSON.stringify({
            ...error,
            id: body.id,
            result: {
              ...error.result,
              content: [{ type: "text", text: "@T" }],
              isError: tool === "failing" || tool === "huge-error",
              ...(structured === null ? {} : { structuredContent: { nested: "@S" } }),
            },
          })
            .replace('"@T"', () => text)
            .replace('"@S"', () => structured ?? ""),
          { headers: { "content-type": "application/json" } },
        );
      // Structured content past what a teammate reads, nested past what the broker keeps; and 7 MB of text or
      // of structured content, the credential echoed all through it beside chains of escapes.
      const chain = run;
      const mb = (n: number) => chain.repeat(Math.ceil((n * 1_000_000) / chain.length));
      // One string of 3.6 MB as a value, one as a key, one as a tool's error; and JSON as text, its numbers
      // holding a credential of digits.
      if (tool === "huge-leaf") return shaped(JSON.stringify(echoed), JSON.stringify(mb(3.6)));
      if (tool === "huge-key") return shaped(JSON.stringify(echoed), JSON.stringify({ [mb(3.6)]: 1 }));
      if (tool === "huge-error") return shaped(JSON.stringify(mb(3.6)), null);
      if (tool === "digits") return shaped(JSON.stringify('{"id":90012345678,"pin":12345678,"n":7}'), null);
      // 7.8 MB of JSON as text, nested millions deep; and the credential written into JSON as it is.
      if (tool === "nested-text")
        return shaped(JSON.stringify(`${"[".repeat(3_900_000)}${"]".repeat(3_900_000)}`), null);
      if (tool === "interpolated")
        return shaped(JSON.stringify('{"echo":"Bearer tok\\n\\"en-12345","n":1}'), null);
      if (tool === "large")
        return shaped(
          JSON.stringify(echoed),
          JSON.stringify({ log: Array.from({ length: 4000 }, (_, i) => ({ i, echoed })) }),
        );
      if (tool === "deep")
        return shaped(
          JSON.stringify(echoed),
          `${"[".repeat(100_000)}${JSON.stringify(echoed)}${"]".repeat(100_000)}`,
        );
      if (tool === "huge-text")
        return shaped(JSON.stringify(chain.repeat(Math.ceil(3_600_000 / chain.length))), null);
      if (tool === "huge-structured")
        return shaped(
          JSON.stringify(echoed),
          JSON.stringify({ log: Array(Math.ceil(3_600_000 / chain.length)).fill(chain) }),
        );
      return shaped(JSON.stringify(echoed), null);
    }) as typeof fetch;
    const target = {
      transport: "http" as const,
      url: "https://mcp.echo.test/mcp",
      authEnvName: "ECHO_TOKEN",
    };
    const deps = { egress: testEgress(echoing, { resolve }), env: { ECHO_TOKEN: "AbC+dEf+GhI/jKl=" } };
    const call = (tool: string) => callMcpTool(target, deps, tool, {});
    expect((await discoverTools(target, deps))[0]!.description).toBe(clean);
    expect(await call("failing")).toEqual({ ok: false, error: clean });
    expect(await call("answering")).toEqual({ ok: true, result: clean });
    // Larger than a teammate reads: walked as a value as far as it goes, the credential out, and said to be cut.
    const large = (await call("large")) as { ok: true; result: { truncated: boolean; value: unknown } };
    expect(large.result.truncated).toBe(true);
    expect(JSON.stringify(large.result.value).length).toBeLessThan(260_000);
    expect(JSON.stringify(large.result.value)).toContain("[redacted]");
    expect(JSON.stringify(large.result.value)).not.toMatch(/AbC|dEf|GhI/);
    // Nested past twelve levels: written "[depth]" there, as the broker would, never read whole.
    let deep = ((await call("deep")) as { ok: true; result: { nested: unknown } }).result.nested;
    for (let i = 0; i < 12; i++) deep = (deep as unknown[])[0];
    expect(deep).toBe("[depth]");
    // 3.6 MB of either, a run of 256 backslashes all through it so every level is read, is cut before it is
    // scrubbed: what the server sent does not set the work. Scrubbing all of it reads 14 million characters.
    // So is one string of 3.6 MB as a value, as a key, or as an error, the tool's or one the SDK words from a
    // server's body.
    for (const tool of [
      "huge-text",
      "huge-structured",
      "huge-leaf",
      "huge-key",
      "huge-error",
      "broken-huge",
    ]) {
      const before = scrubbedChars();
      const huge = (await call(tool)) as { ok: boolean; result?: unknown };
      expect(scrubbedChars() - before, tool).toBeLessThan(3_000_000);
      expect(huge.ok, tool).toBe(!["huge-error", "broken-huge"].includes(tool));
      expect(JSON.stringify(huge), tool).not.toMatch(/AbC|dEf|GhI/);
    }
    // A key the budget cannot hold leaves its entry out, rather than lose the name that marks it secret.
    expect(((await call("huge-key")) as { result: unknown }).result).toEqual({
      truncated: true,
      value: { nested: {} },
    });
    // A tools page of 1,801, the first with fields of a megabyte: a thousand read, each field to 2,000.
    const before = scrubbedChars();
    const wide = await discoverTools({ ...target, url: "https://mcp.echo.test/mcp-wide" }, deps);
    expect(scrubbedChars() - before).toBeLessThan(1_600_000);
    expect(wide).toHaveLength(1000);
    expect(wide[0]!.description.length).toBeLessThanOrEqual(2000);
    expect(JSON.stringify(wide)).not.toMatch(/AbC|dEf|GhI/);
    // JSON as text is read as a value first: a number holding the credential of digits, or equal to it with
    // its leading zeros gone, goes; scrubbing the text first broke the JSON and kept the second.
    const pin = await callMcpTool(
      { ...target, authEnvName: "PIN_TOKEN" },
      { ...deps, env: { PIN_TOKEN: "0012345678" } },
      "digits",
      {},
    );
    expect(pin).toEqual({ ok: true, result: { id: "[redacted]", pin: "[redacted]", n: 7 } });
    // A credential holding escapes of its own, written into JSON as it is: JSON reads them away, so the text is
    // scrubbed before it is parsed.
    const interpolated = await callMcpTool(
      { ...target, authEnvName: "ODD_TOKEN" },
      { ...deps, env: { ODD_TOKEN: 'tok\\n\\"en-12345' } },
      "interpolated",
      {},
    );
    expect(interpolated).toEqual({ ok: true, result: { echo: "Bearer [redacted]", n: 1 } });
    // JSON text past the budget is never parsed: nested millions deep, it took 645 MB to. It comes back cut,
    // as text, and the board's peak memory barely moves.
    const peak = process.resourceUsage().maxRSS;
    const reads = scrubbedChars();
    const nested = (await call("nested-text")) as { ok: true; result: unknown };
    expect(typeof nested.result).toBe("string");
    expect((nested.result as string).length).toBeLessThanOrEqual(200_000);
    expect(scrubbedChars() - reads).toBeLessThan(3_000_000);
    expect(process.resourceUsage().maxRSS - peak).toBeLessThan(300 * 1024);
    expect(((await call("huge-text")) as { result: string }).result.length).toBeLessThanOrEqual(200_000);
    const broken = await call("broken");
    expect(broken.ok).toBe(false);
    expect(JSON.stringify(broken)).toContain("[redacted]");
    expect(JSON.stringify(broken)).not.toMatch(/AbC|dEf|GhI/);
  });

  it("reaches what the operator lists, a name or a range, and nothing beside it; a tool call is held to the same", async () => {
    const { api, base, companyId } = await seedCompany(board, "egress-allow@example.com");
    const add = async (name: string, url: string) =>
      (await api.post(`${base}/connections`, { name, transport: "http", url })).body.id as string;
    const listedName = await add("listed-name", "https://mcp.allowed.test/mcp");
    const listedRange = await add("listed-range", "http://10.9.1.2/mcp");
    const unlisted = await add("unlisted", "http://10.10.1.2/mcp");
    const check = async (id: string) =>
      (await api.post(`${base}/connections/${id}/check`, {})).body.lastCheck;
    expect(await check(listedName)).toMatchObject({ ok: true, error: null });
    expect(await check(listedRange)).toMatchObject({ ok: true, error: null });
    expect(await check(unlisted)).toMatchObject({
      ok: false,
      error: `refused: 10.10.1.2 is a private address, ${NOT_ALLOWED}`,
    });
    // A tool call goes through the same door as the broker's.
    const deps = { egress: testEgress(transport, { resolve, allow: "mcp.allowed.test,10.9.0.0/16" }) };
    expect(
      await callConnectionTool(await loadConnection(board.db, companyId, listedName), deps, "whoami", {}),
    ).toMatchObject({
      ok: true,
    });
    expect(
      await callConnectionTool(await loadConnection(board.db, companyId, unlisted), deps, "whoami", {}),
    ).toEqual({
      ok: false,
      error: `refused: 10.10.1.2 is a private address, ${NOT_ALLOWED}`,
    });
    // The people who manage connections see what the operator lists; a viewer does not.
    expect((await api.get("/api/features")).body.privateDestinations).toEqual([
      "mcp.allowed.test",
      "10.9.0.0/16",
    ]);
    const viewer = await board.login("egress-viewer@example.com");
    await api.post(`${base}/members`, { email: "egress-viewer@example.com", role: "viewer" });
    expect((await board.api(viewer.token).get("/api/features")).body.privateDestinations).toBeUndefined();
    const intranet = await add("intranet", "https://mcp.intranet.test/mcp");
    expect(
      await callConnectionTool(await loadConnection(board.db, companyId, intranet), deps, "whoami", {}),
    ).toEqual({
      ok: false,
      error: `refused: mcp.intranet.test resolves to a private address, ${NOT_ALLOWED}`,
    });
  });
});

describe("a company's OpenAPI service", () => {
  it("is refused at a private address, behind its name or a redirect; its check takes a redirect as an answer and follows none", async () => {
    const { api, base, companyId } = await seedCompany(board, "egress-openapi@example.com");
    const add = async (name: string, url: string) => {
      const created = await api.post(`${base}/connections/openapi`, {
        name,
        url,
        spec,
        allow: ["listContacts"],
      });
      expect(created.status).toBe(201);
      return created.body.id as string;
    };
    const intranet = await add("crm-intranet", "https://crm.intranet.test/v1");
    const literal = await add("crm-literal", "http://10.0.0.40/v1");
    const moved = await add("crm-moved", "https://crm.moved.test/v1");
    sent.length = 0;
    const check = async (id: string) =>
      (await api.post(`${base}/connections/${id}/check`, {})).body.lastCheck;
    expect(await check(intranet)).toMatchObject({
      ok: false,
      error: `could not reach the service: refused: crm.intranet.test resolves to a private address, ${NOT_ALLOWED}`,
    });
    expect(await check(literal)).toMatchObject({
      ok: false,
      error: `could not reach the service: refused: 10.0.0.40 is a private address, ${NOT_ALLOWED}`,
    });
    // The service answered: a redirect is an answer here, and nothing follows it.
    expect(await check(moved)).toMatchObject({ ok: true });
    expect(sent).toEqual(["https://crm.moved.test/v1"]);
    const deps = { egress: testEgress(transport, { resolve }) };
    const call = async (id: string) =>
      callConnectionTool(await loadConnection(board.db, companyId, id), deps, "list_contacts", {});
    expect(await call(intranet)).toEqual({
      ok: false,
      error: `list_contacts could not reach the service: refused: crm.intranet.test resolves to a private address, ${NOT_ALLOWED}`,
    });
    // An operation, a write above all, goes where the manifest says or nowhere: even a public redirect is refused.
    expect(await call(moved)).toEqual({
      ok: false,
      error:
        "list_contacts could not reach the service: crm.moved.test answered 307, a redirect to https://crm.example.test, which the board does not follow here: use the address it points to",
    });
    expect(sent).toEqual(["https://crm.moved.test/v1", "https://crm.moved.test/v1/contacts"]);
  });
});

describe("OAuth for a company's connection", () => {
  it("refuses an authorization server the MCP server names at a private address, as the person who pressed Authorise is told", async () => {
    const { api, base } = await seedCompany(board, "egress-oauth@example.com");
    const created = await api.post(`${base}/connections`, {
      name: "hubspot",
      url: "https://mcp.oauth.test/mcp",
      oauth: {},
    });
    expect(created.status).toBe(201);
    sent.length = 0;
    const start = await api.post(`${base}/connections/${created.body.id}/oauth/start`, {});
    expect(start.status).toBe(502);
    expect(start.body.error).toBe(
      `could not reach auth.intranet.test: refused: auth.intranet.test resolves to a private address, ${NOT_ALLOWED}`,
    );
    // The resource metadata was read; nothing reached the authorization server.
    expect(sent).toEqual(["https://mcp.oauth.test/.well-known/oauth-protected-resource/mcp"]);
  });

  it("sends a person only to a web page, and calls only https or a listed server, whatever the metadata says", async () => {
    resetOAuthCaches();
    const { api, base } = await seedCompany(board, "egress-oauth-script@example.com");
    const created = await api.post(`${base}/connections`, {
      name: "scripted",
      url: "https://mcp.script.test/mcp",
      oauth: {},
    });
    const start = await api.post(`${base}/connections/${created.body.id}/oauth/start`, {});
    expect(start.status).toBe(502);
    expect(start.body).toEqual({
      error: "auth.script.test names an authorization endpoint that is a javascript URL, not https",
    });
    // The same rules where the metadata is read.
    const metadata: Record<string, Record<string, unknown>> = {};
    const fake = (async (input: RequestInfo | URL) => {
      const doc = metadata[String(input)];
      return doc
        ? new Response(JSON.stringify(doc), { headers: { "content-type": "application/json" } })
        : new Response("{}", { status: 404 });
    }) as typeof fetch;
    const deps = (allow?: string) => ({ egress: testEgress(fake, { resolve, allow }), log: { warn() {} } });
    const server = (issuer: string, endpoints: Record<string, string>) => {
      metadata[`${issuer}/.well-known/oauth-authorization-server`] = {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        ...endpoints,
      };
    };
    server("https://data.example.test", { authorization_endpoint: "data:text/html,<script>1</script>" });
    server("https://plain.example.test", { token_endpoint: "http://plain.example.test/token" });
    server("https://register.example.test", { registration_endpoint: "ftp://register.example.test/" });
    server("http://dev.example.test", {});
    await expect(discoverAuthorizationServer("https://data.example.test", deps())).rejects.toThrow(
      "data.example.test names an authorization endpoint that is a data URL, not https",
    );
    await expect(discoverAuthorizationServer("https://plain.example.test", deps())).rejects.toThrow(
      "plain.example.test names a token endpoint that is plain http to a server this board's operator does not list",
    );
    await expect(discoverAuthorizationServer("https://register.example.test", deps())).rejects.toThrow(
      "register.example.test names a registration endpoint that is a ftp URL, not https",
    );
    await expect(discoverAuthorizationServer("http://dev.example.test", deps())).rejects.toThrow(
      "the authorization server's address is plain http to a server this board's operator does not list",
    );
    // Plain http to a server the operator lists, such as one on this machine in development, is taken.
    expect(
      (await discoverAuthorizationServer("http://dev.example.test", deps("dev.example.test"))).token_endpoint,
    ).toBe("http://dev.example.test/token");
    // The resource metadata: its authorization server is held to the same, and it speaks for its own origin only.
    const resourceAt = (mcp: string, doc: Record<string, unknown>) => {
      const u = new URL(mcp);
      metadata[`${u.origin}/.well-known/oauth-protected-resource${u.pathname}`] = doc;
    };
    resourceAt("https://one.example.test/mcp", { authorization_servers: ["javascript:alert(1)"] });
    resourceAt("https://two.example.test/mcp", {
      authorization_servers: ["https://auth.example.test"],
      resource: "https://api.othervendor.test/mcp",
    });
    resourceAt("https://three.example.test/mcp", {
      authorization_servers: ["https://auth.example.test"],
      resource: "https://three.example.test",
    });
    await expect(discoverResource("https://one.example.test/mcp", deps())).rejects.toThrow(
      "one.example.test names an authorization server that is a javascript URL, not https",
    );
    await expect(discoverResource("https://two.example.test/mcp", deps())).rejects.toThrow(
      "two.example.test declares itself a resource that is not this server",
    );
    expect(await discoverResource("https://three.example.test/mcp", deps())).toMatchObject({
      authorizationServer: "https://auth.example.test",
      resource: "https://three.example.test",
    });
    // On a shared origin, a server speaks for its own path and what is above it, never for a sibling.
    resourceAt("https://gw.example.test/servers/a/mcp", {
      authorization_servers: ["https://auth.example.test"],
      resource: "https://gw.example.test/servers/b",
    });
    resourceAt("https://gw.example.test/servers/c/mcp", {
      authorization_servers: ["https://auth.example.test"],
      resource: "https://gw.example.test/servers/c",
    });
    await expect(discoverResource("https://gw.example.test/servers/a/mcp", deps())).rejects.toThrow(
      "gw.example.test declares itself a resource that is not this server",
    );
    expect(await discoverResource("https://gw.example.test/servers/c/mcp", deps())).toMatchObject({
      resource: "https://gw.example.test/servers/c",
    });
    for (const [declared, ok] of [
      ["https://gw.example.test/servers/c/mcp", true],
      ["https://gw.example.test/servers/c/", true],
      ["https://gw.example.test/", true],
      ["https://gw.example.test/servers/cc", false],
      ["https://gw.example.test/servers/c/mcp/more", false],
      ["https://gw.example.test/servers/c/mcp/", false],
      ["https://gw.example.test:8443/servers/c", false],
      ["not a url", false],
    ] as const)
      expect(resourceAllowed(declared, "https://gw.example.test/servers/c/mcp"), declared).toBe(ok);
    // The issuer a row keeps is the one asked for and checked, whatever the document calls itself; and a
    // document past its cap is said to be one, not a server out of reach.
    metadata["https://keyed.example.test/.well-known/oauth-authorization-server"] = {
      issuer: "http://keycloak.internal:8080/realms/x",
      authorization_endpoint: "https://keyed.example.test/authorize",
      token_endpoint: "https://keyed.example.test/token",
    };
    expect((await discoverAuthorizationServer("https://keyed.example.test", deps())).issuer).toBe(
      "https://keyed.example.test",
    );
    metadata["https://big.example.test/.well-known/oauth-authorization-server"] = {
      padding: "x".repeat(300_000),
    };
    await expect(discoverAuthorizationServer("https://big.example.test", deps())).rejects.toThrow(
      "big.example.test answered with a document larger than 256 KB",
    );
    // Plain http to a name whose every address is in a listed range is taken, as for a connection.
    names["keycloak.ranged.test"] = ["10.40.0.5"];
    server("http://keycloak.ranged.test", {});
    expect(
      (await discoverAuthorizationServer("http://keycloak.ranged.test", deps("10.40.0.0/16"))).token_endpoint,
    ).toBe("http://keycloak.ranged.test/token");
    resetOAuthCaches();
    await expect(
      discoverAuthorizationServer("http://keycloak.ranged.test", deps("10.41.0.0/16")),
    ).rejects.toThrow(
      "the authorization server's address is plain http to a server this board's operator does not list",
    );
    // Refused, but not unusable: a name that does not resolve now may later, so Authorise moves nothing.
    names["keycloak.ranged.test"] = [];
    const unresolved = await discoverAuthorizationServer(
      "http://keycloak.ranged.test",
      deps("10.40.0.0/16"),
    ).catch((err: unknown) => err);
    expect(unresolved).toBeInstanceOf(OAuthError);
    expect(unresolved).not.toBeInstanceOf(IssuerUnusable);
    expect((unresolved as Error).message).toBe(
      "the authorization server's address is plain http to a name that does not resolve",
    );
    // With no range listed it could resolve into, it is refused outright, and Authorise may move on.
    const unlisted = await discoverAuthorizationServer(
      "http://keycloak.ranged.test",
      deps("auth.other.test"),
    ).catch((err: unknown) => err);
    expect(unlisted).toBeInstanceOf(IssuerUnusable);
    expect((unlisted as Error).message).toBe(
      "the authorization server's address is plain http to a server this board's operator does not list",
    );
    delete names["keycloak.ranged.test"];
    // An issuer or a token endpoint a row kept from before these checks is held to them before anything goes there.
    await expect(discoverAuthorizationServer("javascript:alert(1)", deps())).rejects.toThrow(
      "the authorization server's address is a javascript URL, not https",
    );
    await expect(
      refreshTokens(
        "http://plain.example.test/token",
        { clientId: "c", clientSecret: "s", refreshToken: "r", resource: "https://mcp.example.test/mcp" },
        deps(),
      ),
    ).rejects.toThrow("the token endpoint is plain http to a server this board's operator does not list");
    // And where the consent URL is built, whatever reached it.
    expect(() =>
      authorizationUrl(
        {
          issuer: "https://x.test",
          authorization_endpoint: "javascript:alert(1)",
          token_endpoint: "https://x.test/t",
        },
        {
          clientId: "c",
          redirectUri: "http://rosterdock.test/cb",
          scopes: [],
          state: "s",
          verifier: "v",
          resource: "r",
        },
      ),
    ).toThrow("x.test names an authorization endpoint that is not a web page");
  });

  it("discovers again a resource a connection kept on another server's origin from before the check", async () => {
    resetOAuthCaches();
    const { api, base, companyId } = await seedCompany(board, "egress-oauth-kept@example.com");
    const created = await api.post(`${base}/connections`, {
      name: "kept",
      url: "https://mcp.reauth.test/mcp",
      oauth: {},
    });
    expect((await api.post(`${base}/connections/${created.body.id}/oauth/start`, {})).status).toBe(200);
    const store = fileSecretStore(dir);
    const name = connectionSecretName(created.body.id);
    const registeredSecret = (await store.get(name))?.client_secret;
    const row = async () =>
      (
        await board.db.query<{ oauth: Record<string, unknown> }>(
          "SELECT oauth FROM connections WHERE id = $1",
          [created.body.id],
        )
      ).rows[0]!.oauth;
    // What a row kept before: tokens, minted for another service's resource.
    const authorised = async (patch: Record<string, unknown>) => {
      await store.put(name, {
        ...(registeredSecret ? { client_secret: registeredSecret } : {}),
        access_token: "old-access-000000",
        refresh_token: "old-refresh-000000",
      });
      await board.db.query(
        "UPDATE connections SET oauth = oauth || $3::jsonb WHERE id = $1 AND company_id = $2",
        [created.body.id, companyId, JSON.stringify({ authorizedAt: "2026-10-01T00:00:00.000Z", ...patch })],
      );
    };
    await authorised({ resource: "https://api.other.test/mcp" });
    const again = await api.post(`${base}/connections/${created.body.id}/oauth/start`, {});
    expect(again.status).toBe(200);
    expect(new URL(again.body.url).searchParams.get("resource")).toBe("https://mcp.reauth.test/mcp");
    expect((await row()).resource).toBe("https://mcp.reauth.test/mcp");
    // Before anyone consents, the old tokens are gone and the row is not authorised: nothing old is sent if the
    // person never comes back. The client the board registered there stays.
    expect((await row()).authorizedAt).toBeNull();
    expect(await store.get(name)).toEqual({
      issuer: "https://auth.reauth.test",
      ...(registeredSecret ? { client_secret: registeredSecret } : {}),
    });
    // A row that kept an issuer that is refused now (the document's own word, from before the board kept the one
    // it asked for): found again from the server's document, its tokens gone, its client registered there anew.
    const clientBefore = (await row()).clientId;
    await authorised({ authorizationServer: "http://keycloak.internal:8080/realms/x", registered: true });
    const healed = await api.post(`${base}/connections/${created.body.id}/oauth/start`, {});
    expect(healed.status).toBe(200);
    expect((await row()).authorizationServer).toBe("https://auth.reauth.test");
    expect((await row()).authorizedAt).toBeNull();
    expect((await row()).clientId).not.toBe(clientBefore);
    expect((await store.get(name))?.access_token).toBeUndefined();
  });

  it("moves a connection to another issuer only when its own is refused or publishes nothing, the row first, never a person's client", async () => {
    resetOAuthCaches();
    const { owner, api, base, companyId } = await seedCompany(board, "egress-oauth-moved@example.com");
    const created = await api.post(`${base}/connections`, {
      name: "moved",
      url: "https://mcp.reauth.test/mcp",
      oauth: {},
    });
    const start = () => api.post(`${base}/connections/${created.body.id}/oauth/start`, {});
    expect((await start()).status).toBe(200);
    const store = fileSecretStore(dir);
    const name = connectionSecretName(created.body.id);
    const row = async () =>
      (
        await board.db.query<{ oauth: Record<string, unknown> }>(
          "SELECT oauth FROM connections WHERE id = $1",
          [created.body.id],
        )
      ).rows[0]!.oauth;
    // What a row kept from another issuer: its client, its secret and its tokens.
    const old = {
      client_secret: "old-client-secret-0000",
      access_token: "old-access-000000",
      refresh_token: "old-refresh-000000",
    };
    const kept = async (patch: Record<string, unknown>) => {
      await store.put(name, old);
      await board.db.query(
        "UPDATE connections SET oauth = oauth || $3::jsonb WHERE id = $1 AND company_id = $2",
        [
          created.body.id,
          companyId,
          JSON.stringify({ authorizedAt: "2026-10-01T00:00:00.000Z", clientId: "old-client", ...patch }),
        ],
      );
    };
    // An issuer that is down is the answer for now: nothing moves and nothing goes.
    await kept({ authorizationServer: "https://auth.down.test", registered: true });
    const down = await start();
    expect(down.status).toBe(502);
    expect(down.body.error).toBe("auth.down.test answered HTTP 503 for its authorization server metadata");
    expect(await row()).toMatchObject({
      authorizationServer: "https://auth.down.test",
      clientId: "old-client",
    });
    expect(await store.get(name)).toEqual(old);
    // A refused issuer moves to the one the server names. The row and its event come first, so when
    // registering there fails the connection is left with no client and no authorisation, not stranded,
    // and the store with neither the old secret nor a token.
    const refused = "http://keycloak.internal:8080/realms/x";
    await kept({ authorizationServer: refused, registered: true });
    failing.add("https://auth.reauth.test/register");
    const half = await start();
    failing.clear();
    expect(half.status).toBe(502);
    expect(await row()).toMatchObject({
      authorizationServer: "https://auth.reauth.test",
      clientId: null,
      registered: false,
      authorizedAt: null,
    });
    expect(await store.get(name)).toEqual({ issuer: "https://auth.reauth.test" });
    const moved = (await api.get(`${base}/events`)).body as EventRecord[];
    expect(
      moved.some(
        (e) =>
          e.type === "connection.updated" &&
          e.subject?.id === created.body.id &&
          e.payload.authorizationServer === "https://auth.reauth.test" &&
          e.payload.authorized === false,
      ),
    ).toBe(true);
    // The next Authorise registers there and goes on.
    const begun = await start();
    expect(begun.status).toBe(200);
    expect(await row()).toMatchObject({ authorizationServer: "https://auth.reauth.test", registered: true });
    expect((await row()).clientId).not.toBeNull();
    expect((await store.get(name))?.issuer).toBe("https://auth.reauth.test");
    // Begun there and finished after the connection moved on: the code and its verifier stay where they began.
    await board.db.query(
      "UPDATE connections SET oauth = oauth || $3::jsonb WHERE id = $1 AND company_id = $2",
      [created.body.id, companyId, JSON.stringify({ authorizationServer: "https://auth.elsewhere.test" })],
    );
    sent.length = 0;
    const late = await board.app.inject({
      method: "GET",
      url: `/api/oauth/callback?code=c-1&state=${new URL(begun.body.url).searchParams.get("state")}`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(late.headers.location).toBe("http://rosterdock.test/?oauth_error=moved");
    expect(sent).toEqual([]);
    // A client a person gave was registered at the issuer it was given for: neither it nor its secret moves.
    await kept({ authorizationServer: refused, registered: false });
    const given = await start();
    expect(given.status).toBe(409);
    expect(given.body.error).toBe(
      "moved's server now names auth.reauth.test as its authorization server, and the client id it was given is for another; remove the connection and add it again with a client id registered at auth.reauth.test",
    );
    expect(await row()).toMatchObject({ authorizationServer: refused, clientId: "old-client" });
    expect(await store.get(name)).toEqual(old);
  });

  it("follows discovery's redirects with every hop checked, follows none for registration or a token, and reaches a listed server", async () => {
    resetOAuthCaches();
    const t: string[] = [];
    const routes: Record<string, () => Response> = {
      "https://mcp.example.test/.well-known/oauth-protected-resource/mcp": () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        }),
      "https://auth.example.test/register": () =>
        new Response(null, { status: 307, headers: { location: "https://auth.example.test/register/v2" } }),
      "https://auth.example.test/token": () =>
        new Response(null, { status: 308, headers: { location: "https://tokens.example.test/token" } }),
    };
    const fake = (async (input: RequestInfo | URL) => {
      const url = String(input);
      t.push(url);
      return routes[url]?.() ?? new Response("{}", { status: 404 });
    }) as typeof fetch;
    const deps = { egress: testEgress(fake, { resolve }), log: { warn() {} } };
    await expect(discoverResource("https://mcp.example.test/mcp", deps)).rejects.toThrow(
      `could not reach mcp.example.test: refused: 169.254.169.254 is a link-local address, where cloud metadata lives, ${NOT_ALLOWED}`,
    );
    await expect(discoverAuthorizationServer("https://auth.intranet.test", deps)).rejects.toThrow(
      `could not reach auth.intranet.test: refused: auth.intranet.test resolves to a private address, ${NOT_ALLOWED}`,
    );
    const as = {
      issuer: "https://auth.example.test",
      authorization_endpoint: "https://auth.example.test/authorize",
      token_endpoint: "https://auth.example.test/token",
      registration_endpoint: "https://auth.example.test/register",
    };
    const registered = await registerClient(as, "http://rosterdock.test/api/oauth/callback", deps).catch(
      (e: OAuthError) => e,
    );
    expect(registered).toBeInstanceOf(OAuthError);
    expect((registered as OAuthError).message).toBe(
      "could not reach the registration endpoint: auth.example.test answered 307, a redirect to another address on the same server, which the board does not follow here: use the address it points to",
    );
    const refresh = (endpoint: string) =>
      refreshTokens(
        endpoint,
        { clientId: "c", clientSecret: null, refreshToken: "r", resource: "https://mcp.example.test/mcp" },
        deps,
      );
    await expect(refresh("https://auth.example.test/token")).rejects.toThrow(
      "could not reach the token endpoint: auth.example.test answered 308, a redirect to https://tokens.example.test, which the board does not follow here",
    );
    await expect(refresh("https://auth.intranet.test/token")).rejects.toThrow(
      `could not reach the token endpoint: refused: auth.intranet.test resolves to a private address, ${NOT_ALLOWED}`,
    );
    expect(t).toEqual([
      "https://mcp.example.test/.well-known/oauth-protected-resource/mcp",
      "https://auth.example.test/register",
      "https://auth.example.test/token",
    ]);
    // An authorization server the operator lists is reached though it is private.
    const listed = createOAuthFake({
      mcpUrl: "https://mcp.example.test/mcp",
      inner: mcp.fetch,
      issuer: "https://auth.allowed.test",
    });
    const doc = await discoverAuthorizationServer("https://auth.allowed.test", {
      egress: testEgress(listed.fetch, { resolve, allow: "auth.allowed.test" }),
      log: { warn() {} },
    });
    expect(doc.token_endpoint).toBe("https://auth.allowed.test/token");
  });
});

describe("a company's notifications", () => {
  it("are refused at a private webhook or behind a redirect, and at a private SMTP server; the board's own webhook is the operator's", async () => {
    const { api, base } = await seedCompany(board, "egress-notify@example.com");
    const test = async () => (await api.post(`${base}/notify/test`, {})).body;
    // The board's own webhook, which the operator set, is posted to as it is, private address and all.
    sent.length = 0;
    expect(await test()).toEqual({ sent: true, target: "ROSTERDOCK_NOTIFY_WEBHOOK_URL", error: null });
    expect(sent).toEqual(["https://hooks.board.test/own"]);

    expect((await api.patch(base, { settings: { notify: { webhookEnvName: "GTM_HOOK" } } })).status).toBe(
      200,
    );
    env.GTM_HOOK = "https://hooks.intranet.test/services/T0/B0/secret-000";
    sent.length = 0;
    expect(await test()).toEqual({
      sent: false,
      target: "GTM_HOOK",
      error: `refused: hooks.intranet.test resolves to a link-local address, where cloud metadata lives, ${NOT_ALLOWED}`,
    });
    env.GTM_HOOK = "https://hooks.moved.test/services/T0/B0/secret-000";
    const moved = await test();
    expect(moved).toEqual({
      sent: false,
      target: "GTM_HOOK",
      error:
        "hooks.moved.test answered 308, a redirect to http://10.0.0.1, which the board does not follow here: use the address it points to",
    });
    expect(JSON.stringify(moved)).not.toContain("secret-000");
    expect(sent).toEqual(["https://hooks.moved.test/services/T0/B0/secret-000"]);

    const email = { smtpUrlEnvName: "GTM_SMTP", to: ["ops@example.test"], from: "board@example.test" };
    expect((await api.patch(base, { settings: { notify: { email } } })).status).toBe(200);
    // With no webhook of its own the company's notices go to the board's as well, which takes them.
    env.GTM_SMTP = "smtp://owner:pw@smtp.intranet.test:587/";
    expect(await test()).toEqual({
      sent: true,
      target: "ROSTERDOCK_NOTIFY_WEBHOOK_URL",
      error: `email: refused: smtp.intranet.test resolves to a private address, ${NOT_ALLOWED}`,
    });
    env.GTM_SMTP = "smtp://owner:pw@10.0.0.25:587/";
    expect(await test()).toMatchObject({
      error: `email: refused: 10.0.0.25 is a private address, ${NOT_ALLOWED}`,
    });
  });
});

describe("a private destination the operator gives one company", () => {
  it("is that company's alone: its connections, OAuth and webhook reach it, another company's are refused", async () => {
    const a = await seedCompany(board, "egress-company-a@example.com");
    const b = await seedCompany(board, "egress-company-b@example.com");
    // 10.9.0.0/16 is every company's already, and covers 10.9.4.0/24: listed for A too, neither is shown as
    // A's own.
    allow.companies = parsePrivateDestinations(
      `${a.companyId}=mcp.only-a.test,${a.companyId}=hooks.only-a.test,${a.companyId}=10.9.0.0/16,${a.companyId}=10.9.4.0/24`,
    ).companies;
    try {
      const refused = (host: string) => `refused: ${host} resolves to a private address, ${NOT_ALLOWED}`;
      // A connection.
      const check = async (c: typeof a) => {
        const created = await c.api.post(`${c.base}/connections`, {
          name: "only-a",
          transport: "http",
          url: "https://mcp.only-a.test/mcp",
        });
        return (await c.api.post(`${c.base}/connections/${created.body.id}/check`, {})).body.lastCheck;
      };
      expect(await check(a)).toMatchObject({ ok: true, error: null });
      expect(await check(b)).toMatchObject({ ok: false, error: refused("mcp.only-a.test") });
      // Its OAuth: A reaches the server (which publishes no metadata), B is refused before anything is sent.
      resetOAuthCaches();
      const authorise = async (c: typeof a) => {
        const created = await c.api.post(`${c.base}/connections`, {
          name: "only-a-oauth",
          url: "https://mcp.only-a.test/mcp",
          oauth: {},
        });
        return (await c.api.post(`${c.base}/connections/${created.body.id}/oauth/start`, {})).body.error;
      };
      expect(await authorise(a)).toBe("mcp.only-a.test publishes no authorization server metadata");
      expect(await authorise(b)).toBe(`could not reach mcp.only-a.test: ${refused("mcp.only-a.test")}`);
      // Its webhook.
      env.HOOK_ONLY_A = "https://hooks.only-a.test/services/T0/B0/secret-000";
      const notify = async (c: typeof a) => {
        await c.api.patch(c.base, { settings: { notify: { webhookEnvName: "HOOK_ONLY_A" } } });
        return (await c.api.post(`${c.base}/notify/test`, {})).body;
      };
      expect(await notify(a)).toEqual({ sent: true, target: "HOOK_ONLY_A", error: null });
      expect(await notify(b)).toEqual({
        sent: false,
        target: "HOOK_ONLY_A",
        error: refused("hooks.only-a.test"),
      });
      // What Settings shows: A's owners see A's own entries, asked for A; nobody else sees them.
      const features = async (c: typeof a, companyId?: string) =>
        (await c.api.get(`/api/features${companyId ? `?companyId=${companyId}` : ""}`)).body;
      expect(await features(a, a.companyId)).toMatchObject({
        privateDestinations: ["mcp.allowed.test", "10.9.0.0/16", "mcp.only-a.test", "hooks.only-a.test"],
        companyPrivateDestinations: ["mcp.only-a.test", "hooks.only-a.test"],
      });
      expect(await features(a)).toMatchObject({
        privateDestinations: ["mcp.allowed.test", "10.9.0.0/16"],
        companyPrivateDestinations: [],
      });
      for (const asked of [a.companyId, b.companyId, "not-a-company"])
        expect(await features(b, asked), asked).toMatchObject({
          privateDestinations: ["mcp.allowed.test", "10.9.0.0/16"],
          companyPrivateDestinations: [],
        });
    } finally {
      delete allow.companies;
    }
  });
  it("never hands one company an authorization server's metadata the board read for another", async () => {
    resetOAuthCaches();
    const a = "4f1aee73-e65e-4c8d-83f7-aa1169379d7f";
    const b = "0b6c1f0e-27f4-4a8e-9a43-3d5c4c6c1d2e";
    const fake = (async (input: RequestInfo | URL) =>
      String(input) === "https://auth.only-a.test/.well-known/oauth-authorization-server"
        ? new Response(
            JSON.stringify({
              issuer: "https://auth.only-a.test",
              authorization_endpoint: "https://auth.only-a.test/authorize",
              token_endpoint: "https://auth.only-a.test/token",
            }),
            { headers: { "content-type": "application/json" } },
          )
        : new Response("{}", { status: 404 })) as typeof fetch;
    const egress = testEgress(fake, { resolve, allow: `${a}=auth.only-a.test` });
    const as = (company: string) => ({ egress: companyEgress(egress, company), log: { warn() {} } });
    expect((await discoverAuthorizationServer("https://auth.only-a.test", as(a))).token_endpoint).toBe(
      "https://auth.only-a.test/token",
    );
    // Read for A a moment ago, cached: B is still refused, as if nothing were cached.
    await expect(discoverAuthorizationServer("https://auth.only-a.test", as(b))).rejects.toThrow(
      `could not reach auth.only-a.test: refused: auth.only-a.test resolves to a private address, ${NOT_ALLOWED}`,
    );
  });
});

describe("a style pack's download", () => {
  it("is refused at a private address, behind the name or a redirect", async () => {
    const { api, base } = await seedCompany(board, "egress-styles@example.com");
    names["raw.githubusercontent.com"] = ["10.0.0.3"];
    sent.length = 0;
    try {
      const behindName = await api.put(`${base}/styles/${style.id}`, { enabled: true });
      expect(behindName.status).toBe(502);
      expect(behindName.body.error).toBe(
        `could not download ${style.label} from ${style.source.repo}: refused: raw.githubusercontent.com resolves to a private address, ${NOT_ALLOWED}`,
      );
      expect(sent).toEqual([]);
      delete names["raw.githubusercontent.com"];
      redirects[rawUrl(style)] = [301, "http://169.254.169.254/latest/meta-data/"];
      const behindRedirect = await api.put(`${base}/styles/${style.id}`, { enabled: true });
      expect(behindRedirect.status).toBe(502);
      expect(behindRedirect.body.error).toBe(
        `could not download ${style.label} from ${style.source.repo}: refused: 169.254.169.254 is a link-local address, where cloud metadata lives, ${NOT_ALLOWED}`,
      );
      expect(sent).toEqual([rawUrl(style)]);
    } finally {
      delete names["raw.githubusercontent.com"];
      delete redirects[rawUrl(style)];
    }
  });
});
