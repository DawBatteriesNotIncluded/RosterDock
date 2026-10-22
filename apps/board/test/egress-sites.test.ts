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
import { loadConnection } from "../src/mcp/connections.js";
import {
  discoverAuthorizationServer,
  discoverResource,
  OAuthError,
  refreshTokens,
  registerClient,
  resetOAuthCaches,
} from "../src/mcp/oauth.js";
import { rawUrl, STYLE_PACKS } from "../src/styles/catalog.js";
import { parsePrivateDestinations } from "../src/web/address.js";
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
const style = STYLE_PACKS.find((p) => p.id === "caveman")!;
/** Answered with a redirect, by URL. */
const redirects: Record<string, [number, string]> = {
  "https://mcp.moved.test/mcp": [307, "http://169.254.169.254/mcp"],
  "https://crm.moved.test/v1": [302, "http://10.0.0.1/"],
  "https://crm.moved.test/v1/contacts": [307, "https://crm.example.test/v1/contacts"],
  "https://hooks.moved.test/services/T0/B0/secret-000": [308, "http://10.0.0.1/hook"],
};
/** Every URL the transport was asked for: what the board sent. */
const sent: string[] = [];
const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  sent.push(url);
  const moved = redirects[url];
  if (moved) return new Response(null, { status: moved[0], headers: { location: moved[1] } });
  const host = new URL(url).hostname;
  if (host.startsWith("crm.")) return crm.fetch(input, init);
  if (host.startsWith("hooks.")) return new Response("ok", { status: 200 });
  if (host === "raw.githubusercontent.com") return new Response("not the pinned file", { status: 200 });
  if (host === "mcp.oauth.test" || host === "auth.intranet.test") return oauth.fetch(input, init);
  return mcp.fetch(input, init);
}) as typeof fetch;

const env: NodeJS.ProcessEnv = {};
const dir = mkdtempSync(path.join(os.tmpdir(), "rosterdock-egress-"));
let board: TestBoard;

beforeAll(async () => {
  resetOAuthCaches();
  board = await startTestBoard(
    {
      privateDestinations: parsePrivateDestinations("mcp.allowed.test,10.9.0.0/16"),
      notifyWebhookUrl: "https://hooks.board.test/own",
      sharedEnvNames: ["GTM_HOOK", "GTM_SMTP"],
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
        "mcp.moved.test answered 307, a redirect to 169.254.169.254, which the board does not follow here: use the address it points to",
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
        "list_contacts could not reach the service: crm.moved.test answered 307, a redirect to crm.example.test, which the board does not follow here: use the address it points to",
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
      "could not reach the registration endpoint: auth.example.test answered 307, a redirect to another address on the same host, which the board does not follow here: use the address it points to",
    );
    const refresh = (endpoint: string) =>
      refreshTokens(
        endpoint,
        { clientId: "c", clientSecret: null, refreshToken: "r", resource: "https://mcp.example.test/mcp" },
        deps,
      );
    await expect(refresh("https://auth.example.test/token")).rejects.toThrow(
      "could not reach the token endpoint: auth.example.test answered 308, a redirect to tokens.example.test, which the board does not follow here",
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
        "hooks.moved.test answered 308, a redirect to 10.0.0.1, which the board does not follow here: use the address it points to",
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
