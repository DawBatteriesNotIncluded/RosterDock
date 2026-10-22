// OAuth on an MCP connection: discovery, registration, the browser's leg,
// the callback, the tokens in the secret store (files in a temporary
// directory here), the bearer on every call, a refresh before expiry, and
// the ways out. The authorization server and the MCP server are fakes behind
// one injected fetch; no network.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetOAuthCaches } from "../src/mcp/oauth.js";
import { fakeMcp } from "./mcp-fake.js";
import { createOAuthFake } from "./oauth-fake.js";
import { seedCompany, startTestBoard, type TestBoard } from "./helpers.js";

const MCP_URL = "https://mcp.hubspot.test/mcp";
const dir = mkdtempSync(path.join(os.tmpdir(), "rosterdock-oauth-"));
let board: TestBoard;
let bare: TestBoard;
const mcp = fakeMcp();
// Access tokens live ten seconds, so the client refreshes before every call after the first. The server
// calls itself by its origin, as Notion does, so the resource on every request must come from the
// metadata, not from the MCP URL.
const RESOURCE = "https://mcp.hubspot.test";
// It also lists client_secret_post and refuses a Basic header beside form credentials, as Notion does and
// n8n needs, so the board must put the secret in the form.
const auth = createOAuthFake({
  mcpUrl: MCP_URL,
  inner: mcp.fetch,
  expiresIn: 10,
  resource: RESOURCE,
  tokenAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
});

beforeAll(async () => {
  resetOAuthCaches();
  board = await startTestBoard(
    { secretStore: { kind: "file", dir }, sharedEnvNames: ["HUBSPOT_OAUTH_CLIENT_SECRET"] },
    { mcpFetch: auth.fetch, env: { HUBSPOT_OAUTH_CLIENT_SECRET: "given-secret-000000" } },
  );
  bare = await startTestBoard({}, { mcpFetch: auth.fetch });
});
afterAll(async () => {
  await board.destroy();
  await bare.destroy();
  rmSync(dir, { recursive: true, force: true });
});

const secretFiles = () => readdirSync(dir);
const callback = (url: string) => url.replace("http://rosterdock.test", "");

describe("OAuth on a connection", () => {
  it("authorises: discovery, a registered client, the browser's leg, the callback, and tokens in the store", async () => {
    const { owner, api, base } = await seedCompany(board, "oa1@example.com");
    const created = await api.post(`${base}/connections`, {
      name: "hubspot",
      catalogId: "hubspot",
      url: MCP_URL,
      oauth: {},
    });
    expect(created.status).toBe(201);
    expect(created.body.authEnvName).toBeNull();
    expect(created.body.oauth).toEqual({
      authorizationServer: null,
      clientId: null,
      clientSecretEnvName: null,
      registered: false,
      scopes: [],
      authorizedAt: null,
    });
    expect((await api.get("/api/features")).body).toEqual({
      oauth: true,
      objectStore: false,
      web: true,
      sharedEnvNames: ["HUBSPOT_OAUTH_CLIENT_SECRET"],
      stdioCommands: [],
      privateDestinations: [],
    });

    const start = await api.post(`${base}/connections/${created.body.id}/oauth/start`, {});
    expect(start.status).toBe(200);
    const u = new URL(start.body.url);
    expect(u.origin + u.pathname).toBe(`${auth.issuer}/authorize`);
    expect(u.searchParams.get("redirect_uri")).toBe("http://rosterdock.test/api/oauth/callback");
    expect(u.searchParams.get("resource")).toBe(RESOURCE);
    expect(u.searchParams.get("scope")).toBe("crm.read crm.write");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    // Discovery went to the resource, then the server; the board registered itself.
    expect(auth.calls.map((c) => c.url)).toEqual(
      expect.arrayContaining([
        "https://mcp.hubspot.test/.well-known/oauth-protected-resource/mcp",
        `${auth.issuer}/.well-known/oauth-authorization-server`,
        `${auth.issuer}/register`,
      ]),
    );
    const row = (await api.get(`${base}/connections/${created.body.id}`)).body;
    expect(row.oauth).toMatchObject({
      authorizationServer: auth.issuer,
      clientId: "client-1",
      registered: true,
      scopes: ["crm.read", "crm.write"],
      authorizedAt: null,
    });
    // The client secret went to the store, not the row, not the events; the registration named the
    // authentication method the server prefers, and the row remembers it.
    const secret = auth.clients.get("client-1")!;
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(secretFiles()).toEqual([`rosterdock-connection-${created.body.id}.json`]);
    const registration = auth.calls.find((c) => c.url === `${auth.issuer}/register`);
    expect(JSON.parse(registration!.body!)).toMatchObject({
      token_endpoint_auth_method: "client_secret_post",
    });

    // A viewer cannot finish it, nor another owner: the attempt is the starter's.
    const back = auth.authorize(start.body.url);
    await api.post(`${base}/members`, { email: "oa1-other@example.com", role: "owner" });
    const other = board.api((await board.login("oa1-other@example.com")).token);
    const refused = await board.app.inject({
      method: "GET",
      url: callback(back),
      headers: { authorization: `Bearer ${(await board.login("oa1-other@example.com")).token}` },
    });
    expect(refused.statusCode).toBe(302);
    expect(refused.headers.location).toBe("http://rosterdock.test/?oauth_error=state");
    void other;

    const done = await board.app.inject({
      method: "GET",
      url: callback(back),
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(done.statusCode).toBe(302);
    expect(done.headers.location).toBe("http://rosterdock.test/?oauth=hubspot");
    const after = (await api.get(`${base}/connections/${created.body.id}`)).body;
    expect(after.oauth.authorizedAt).toMatch(/^20/);
    // The exchange carried the secret in the form, no Authorization header, and the declared resource.
    const exchange = auth.calls.find(
      (c) => c.url === `${auth.issuer}/token` && c.body?.includes("grant_type=authorization_code"),
    )!;
    expect(exchange.authorization).toBeUndefined();
    const exchanged = new URLSearchParams(exchange.body);
    expect(exchanged.get("client_id")).toBe("client-1");
    expect(exchanged.get("client_secret")).toBe(secret);
    expect(exchanged.get("resource")).toBe(RESOURCE);
    const events = (await api.get(`${base}/events`)).body as {
      type: string;
      payload: Record<string, unknown>;
    }[];
    const authorized = events.find((e) => e.type === "connection.updated" && e.payload.authorized === true);
    expect(authorized?.payload).toMatchObject({ name: "hubspot", changes: ["oauth"] });
    expect(JSON.stringify(events)).not.toMatch(/access-|refresh-|client-secret-/);
    // The same callback again is nothing.
    const replay = await board.app.inject({
      method: "GET",
      url: callback(back),
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(replay.headers.location).toBe("http://rosterdock.test/?oauth_error=state");

    // Discovery carries the bearer; the next call finds it expiring and refreshes first.
    const discovered = await api.post(`${base}/connections/${created.body.id}/discover`, {});
    expect(discovered.status).toBe(200);
    expect(discovered.body.tools.length).toBeGreaterThan(0);
    // Ten-second tokens are always within the refresh window: the exchanged token is never sent as is.
    const bearers = auth.calls.filter((c) => c.url === MCP_URL).map((c) => c.authorization);
    expect(auth.issued[0]).toBe("access-1");
    expect(bearers[0]).toBe("Bearer access-2");
    const refreshed = auth.calls.filter(
      (c) => c.url === `${auth.issuer}/token` && c.body?.includes("grant_type=refresh_token"),
    );
    expect(refreshed.length).toBeGreaterThanOrEqual(1);
    expect(refreshed[0]!.authorization).toBeUndefined();
    expect(new URLSearchParams(refreshed[0]!.body).get("client_secret")).toBe(secret);
    expect(bearers.at(-1)).toBe(`Bearer ${auth.issued.at(-1)}`);
    const check = await api.post(`${base}/connections/${created.body.id}/check`, {});
    expect(check.body.lastCheck.ok).toBe(true);
    expect(JSON.stringify(check.body)).not.toMatch(/access-|refresh-/);

    // Back to a credential by name: the tokens go; removing the connection takes the secret with it.
    const byName = await api.patch(`${base}/connections/${created.body.id}`, {
      oauth: null,
      authEnvName: "HUBSPOT_MCP_TOKEN",
    });
    expect(byName.status).toBe(200);
    expect(byName.body.oauth).toBeNull();
    expect(byName.body.authEnvName).toBe("HUBSPOT_MCP_TOKEN");
    expect(secretFiles()).toEqual([]);
    const again = await api.patch(`${base}/connections/${created.body.id}`, {
      oauth: { clientId: "given-1" },
      authEnvName: null,
    });
    expect(again.body.oauth).toMatchObject({ clientId: "given-1", registered: false, authorizedAt: null });
    expect((await api.del(`${base}/connections/${created.body.id}`)).status).toBe(200);
  });

  it("a pre-registered client brings its secret by env var NAME: no registration, the value read where the board runs", async () => {
    auth.clients.set("given-2", "given-secret-000000");
    const { owner, api, base } = await seedCompany(board, "oa-given@example.com");
    // A secret without a client id is nothing; a name that is not set is refused before the consent page.
    expect(
      (
        await api.post(`${base}/connections`, {
          name: "hubspot",
          url: MCP_URL,
          oauth: { clientSecretEnvName: "HUBSPOT_OAUTH_CLIENT_SECRET" },
        })
      ).status,
    ).toBe(400);
    const unset = await api.post(`${base}/connections`, {
      name: "unset",
      url: MCP_URL,
      oauth: { clientId: "given-2", clientSecretEnvName: "HUBSPOT_OAUTH_NOT_SET" },
    });
    const refused = await api.post(`${base}/connections/${unset.body.id}/oauth/start`, {});
    expect(refused.status).toBe(422);
    expect(refused.body.error).toContain("HUBSPOT_OAUTH_NOT_SET is not set for this company");
    const created = await api.post(`${base}/connections`, {
      name: "hubspot",
      url: MCP_URL,
      oauth: { clientId: "given-2", clientSecretEnvName: "HUBSPOT_OAUTH_CLIENT_SECRET" },
    });
    expect(created.status).toBe(201);
    expect(created.body.oauth).toMatchObject({
      clientId: "given-2",
      clientSecretEnvName: "HUBSPOT_OAUTH_CLIENT_SECRET",
      registered: false,
    });
    const before = auth.calls.length;
    const start = await api.post(`${base}/connections/${created.body.id}/oauth/start`, {});
    expect(start.status).toBe(200);
    expect(auth.calls.slice(before).map((c) => c.url)).not.toContain(`${auth.issuer}/register`);
    const done = await board.app.inject({
      method: "GET",
      url: callback(auth.authorize(start.body.url)),
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(done.headers.location).toBe("http://rosterdock.test/?oauth=hubspot");
    const exchange = auth.calls.findLast(
      (c) => c.url === `${auth.issuer}/token` && c.body?.includes("grant_type=authorization_code"),
    )!;
    expect(new URLSearchParams(exchange.body).get("client_secret")).toBe("given-secret-000000");
    // The value went to the server and nowhere else: not the row, not the store, not the events.
    const row = (await api.get(`${base}/connections/${created.body.id}`)).body;
    expect(JSON.stringify(row)).not.toContain("given-secret");
    expect(JSON.stringify((await api.get(`${base}/events`)).body)).not.toContain("given-secret");
    // A call refreshes with the same named secret.
    expect((await api.post(`${base}/connections/${created.body.id}/discover`, {})).status).toBe(200);
    const refreshed = auth.calls.findLast(
      (c) => c.url === `${auth.issuer}/token` && c.body?.includes("grant_type=refresh_token"),
    )!;
    expect(new URLSearchParams(refreshed.body).get("client_secret")).toBe("given-secret-000000");
    expect((await api.del(`${base}/connections/${created.body.id}`)).status).toBe(200);
    expect((await api.del(`${base}/connections/${unset.body.id}`)).status).toBe(200);
  });

  it("a server that lists only client_secret_basic gets the header, and nothing about the client in the form", async () => {
    resetOAuthCaches();
    auth.tokenAuthMethods = ["client_secret_basic", "none"];
    try {
      const { owner, api, base } = await seedCompany(board, "oa-basic@example.com");
      const created = await api.post(`${base}/connections`, { name: "hubspot", url: MCP_URL, oauth: {} });
      expect(created.status).toBe(201);
      const start = await api.post(`${base}/connections/${created.body.id}/oauth/start`, {});
      expect(start.status).toBe(200);
      const clientId = (await api.get(`${base}/connections/${created.body.id}`)).body.oauth
        .clientId as string;
      const registration = auth.calls.findLast((c) => c.url === `${auth.issuer}/register`);
      expect(JSON.parse(registration!.body!)).toMatchObject({
        token_endpoint_auth_method: "client_secret_basic",
      });
      const done = await board.app.inject({
        method: "GET",
        url: callback(auth.authorize(start.body.url)),
        headers: { authorization: `Bearer ${owner.token}` },
      });
      expect(done.headers.location).toBe("http://rosterdock.test/?oauth=hubspot");
      const exchange = auth.calls.findLast(
        (c) => c.url === `${auth.issuer}/token` && c.body?.includes("grant_type=authorization_code"),
      )!;
      expect(exchange.authorization).toMatch(/^Basic /);
      expect(
        Buffer.from(exchange.authorization!.slice(6), "base64").toString("utf8").startsWith(`${clientId}:`),
      ).toBe(true);
      const form = new URLSearchParams(exchange.body);
      expect(form.has("client_id")).toBe(false);
      expect(form.has("client_secret")).toBe(false);
      expect((await api.del(`${base}/connections/${created.body.id}`)).status).toBe(200);
    } finally {
      auth.tokenAuthMethods = ["none", "client_secret_post", "client_secret_basic"];
      resetOAuthCaches();
    }
  });

  it("refuses what cannot work: no store, both credentials, stdio, a server that will not register", async () => {
    const { api, base } = await seedCompany(bare, "oa2@example.com");
    expect((await api.get("/api/features")).body.oauth).toBe(false);
    const c = await api.post(`${base}/connections`, { name: "hubspot", url: MCP_URL, oauth: {} });
    expect(c.status).toBe(201);
    const start = await api.post(`${base}/connections/${c.body.id}/oauth/start`, {});
    expect(start.status).toBe(409);
    expect(start.body.error).toMatch(/secret store/);
    expect(
      (
        await api.post(`${base}/connections`, {
          name: "both",
          url: MCP_URL,
          oauth: {},
          authEnvName: "X_TOKEN",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api.post(`${base}/connections`, {
          name: "child",
          transport: "stdio",
          command: "npx x",
          oauth: {},
        })
      ).status,
    ).toBe(422);
    // A connection by name does not start OAuth.
    const named = await api.post(`${base}/connections`, {
      name: "n8n",
      url: "https://n8n.test/mcp",
      authEnvName: "N8N_MCP_TOKEN",
    });
    expect((await api.post(`${base}/connections/${named.body.id}/oauth/start`, {})).status).toBe(409);

    const { api: api2, base: base2 } = await seedCompany(board, "oa3@example.com");
    const d = await api2.post(`${base2}/connections`, { name: "hubspot", url: MCP_URL, oauth: {} });
    auth.noRegistration = true;
    try {
      const s = await api2.post(`${base2}/connections/${d.body.id}/oauth/start`, {});
      expect(s.status).toBe(502);
      expect(s.body.error).toMatch(/did not register/);
    } finally {
      auth.noRegistration = false;
    }
    // Without a token in the store, a call says what to do and calls nothing.
    const disc = await api2.post(`${base2}/connections/${d.body.id}/discover`, {});
    expect(disc.status).toBe(409);
    expect(disc.body.error).toMatch(/not authorised/);
  });
});
