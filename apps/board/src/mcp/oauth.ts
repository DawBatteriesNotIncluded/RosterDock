// OAuth for an MCP server, the way the protocol's authorization spec lays it
// out (revision 2025-06-18): the server names its authorization server
// (RFC 9728 protected resource metadata, else the server's own origin), the
// authorization server describes itself (RFC 8414, else OpenID discovery),
// the board registers a client there when it was not given one (RFC 7591),
// then authorization code with PKCE (RFC 7636) and the server URL as the
// resource (RFC 8707), and refresh when the access token is about to expire.
// No client library: a few requests through the board's egress (web/egress.ts),
// since every URL here is one the MCP server or its authorization server named:
// each reaches only a public address or a private one the operator lists.
// Discovery follows a redirect, every hop checked again; registration and the
// token requests, which carry a secret or a code, follow none. Nothing here
// stores anything: the caller keeps the tokens in the secret store, and every
// error text is free of them.
import { trimTrailingSlashes } from "@rosterdock/shared";
import { codeChallenge } from "../auth/oidc.js";
import { egressFetch, type Egress } from "../web/egress.js";

/** One request to an authorization server: its names, its answer and its body. */
export const OAUTH_TIMEOUT_MS = 15_000;

export interface OAuthDeps {
  /** How the servers are reached; tests inject its transport and resolver. */
  egress: Egress;
  now?: () => number;
  log: { warn(msg: string): void };
}

export type OAuthErrorCode = "server" | "registration" | "state" | "token" | "store" | "forbidden";

export class OAuthError extends Error {
  readonly code: OAuthErrorCode;
  /** The server's own error code (invalid_grant, invalid_target), when it gave one: safe to show, never a value. */
  readonly detail: string | null;
  constructor(code: OAuthErrorCode, message: string, detail: string | null = null) {
    super(message);
    this.name = "OAuthError";
    this.code = code;
    this.detail = detail;
  }
}

export interface AuthorizationServer {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: string[];
  scopes_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
}

/**
 * How the client secret travels to the token endpoint. `post` puts client_id and client_secret in the
 * form; `basic` puts them in an Authorization header and nothing in the form. Servers differ: Notion
 * refuses a header with a client_id in the form as "multiple authentication methods", n8n reads no
 * header at all, and RFC 8414 says a server that lists nothing takes basic.
 */
export type TokenAuth = "basic" | "post";

export function tokenAuthFor(
  as: Pick<AuthorizationServer, "token_endpoint_auth_methods_supported">,
): TokenAuth {
  return as.token_endpoint_auth_methods_supported?.includes("client_secret_post") ? "post" : "basic";
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** ISO time, from expires_in; null when the server said nothing. */
  expiresAt: string | null;
  scope: string | null;
}

const DISCOVERY_TTL_MS = 10 * 60_000;
const servers = new Map<string, { at: number; doc: AuthorizationServer }>();

/** Test hook: forget every cached document. */
export function resetOAuthCaches(): void {
  servers.clear();
}

async function getJson(
  url: string,
  deps: OAuthDeps,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  try {
    const res = await egressFetch(deps.egress, { redirect: "follow", timeoutMs: OAUTH_TIMEOUT_MS })(url, {
      headers: { accept: "application/json" },
    });
    const json = res.ok ? ((await res.json().catch(() => null)) as Record<string, unknown> | null) : null;
    return { status: res.status, json };
  } catch (err) {
    throw new OAuthError("server", `could not reach ${new URL(url).host}: ${(err as Error).message}`);
  }
}

/** The well-known URLs for a resource or an issuer with a path: the path-aware form first, then the root. */
function wellKnown(base: string, suffix: string): string[] {
  const u = new URL(base);
  const path = trimTrailingSlashes(u.pathname);
  const root = `${u.origin}/.well-known/${suffix}`;
  return path && path !== "/" ? [`${u.origin}/.well-known/${suffix}${path}`, root] : [root];
}

/**
 * Who authorises access to this MCP server: its protected resource metadata, else the server itself.
 * The metadata also says what the server calls itself (`resource`, RFC 8707): that identifier, not the
 * MCP URL, is what the authorization server expects on the authorize and token requests. Notion, for one,
 * is `https://mcp.notion.com` while its MCP URL ends in `/mcp`, and its token endpoint refuses the latter.
 */
export async function discoverResource(
  mcpUrl: string,
  deps: OAuthDeps,
): Promise<{ authorizationServer: string; scopes: string[] | null; resource: string | null }> {
  for (const url of wellKnown(mcpUrl, "oauth-protected-resource")) {
    const { status, json } = await getJson(url, deps);
    if (status === 200 && json) {
      const list = json.authorization_servers;
      const first = Array.isArray(list) && typeof list[0] === "string" ? trimTrailingSlashes(list[0]) : null;
      if (first) {
        const scopes = Array.isArray(json.scopes_supported)
          ? json.scopes_supported.filter((s): s is string => typeof s === "string")
          : null;
        const resource = typeof json.resource === "string" && json.resource ? json.resource : null;
        return { authorizationServer: first, scopes, resource };
      }
    }
  }
  return { authorizationServer: new URL(mcpUrl).origin, scopes: null, resource: null };
}

/** The authorization server's endpoints, cached ten minutes. */
export async function discoverAuthorizationServer(
  issuer: string,
  deps: OAuthDeps,
): Promise<AuthorizationServer> {
  const key = trimTrailingSlashes(issuer);
  const now = deps.now?.() ?? Date.now();
  const cached = servers.get(key);
  if (cached && now - cached.at < DISCOVERY_TTL_MS) return cached.doc;
  const candidates = [
    ...wellKnown(key, "oauth-authorization-server"),
    `${key}/.well-known/openid-configuration`,
    ...wellKnown(key, "openid-configuration"),
  ];
  for (const url of candidates) {
    const { status, json } = await getJson(url, deps);
    if (status !== 200 || !json) continue;
    if (typeof json.authorization_endpoint !== "string" || typeof json.token_endpoint !== "string") continue;
    const doc: AuthorizationServer = {
      issuer: typeof json.issuer === "string" ? trimTrailingSlashes(json.issuer) : key,
      authorization_endpoint: json.authorization_endpoint,
      token_endpoint: json.token_endpoint,
      ...(typeof json.registration_endpoint === "string"
        ? { registration_endpoint: json.registration_endpoint }
        : {}),
      ...(Array.isArray(json.code_challenge_methods_supported)
        ? { code_challenge_methods_supported: json.code_challenge_methods_supported as string[] }
        : {}),
      ...(Array.isArray(json.scopes_supported)
        ? { scopes_supported: json.scopes_supported as string[] }
        : {}),
      ...(Array.isArray(json.token_endpoint_auth_methods_supported)
        ? {
            token_endpoint_auth_methods_supported: json.token_endpoint_auth_methods_supported.filter(
              (m): m is string => typeof m === "string",
            ),
          }
        : {}),
    };
    if (doc.code_challenge_methods_supported && !doc.code_challenge_methods_supported.includes("S256"))
      throw new OAuthError("server", `${new URL(key).host} does not support PKCE with S256`);
    servers.set(key, { at: now, doc });
    return doc;
  }
  throw new OAuthError("server", `${new URL(key).host} publishes no authorization server metadata`);
}

/** Register the board as a client (RFC 7591). The secret, when one is issued, is the caller's to keep. */
export async function registerClient(
  as: AuthorizationServer,
  redirectUri: string,
  deps: OAuthDeps,
  tokenAuth: TokenAuth = "basic",
): Promise<{ clientId: string; clientSecret: string | null }> {
  if (!as.registration_endpoint)
    throw new OAuthError(
      "registration",
      `${new URL(as.issuer).host} does not register clients; give the connection a client id`,
    );
  let res: Response;
  try {
    res = await egressFetch(deps.egress, { redirect: "error", timeoutMs: OAUTH_TIMEOUT_MS })(
      as.registration_endpoint,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          client_name: "RosterDock",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: tokenAuth === "post" ? "client_secret_post" : "client_secret_basic",
        }),
      },
    );
  } catch (err) {
    throw new OAuthError(
      "registration",
      `could not reach the registration endpoint: ${(err as Error).message}`,
    );
  }
  const body = (await res.json().catch(() => ({}))) as {
    client_id?: unknown;
    client_secret?: unknown;
    error?: unknown;
  };
  if (!res.ok || typeof body.client_id !== "string") {
    const detail = typeof body.error === "string" ? body.error : null;
    deps.log.warn(`oauth client registration failed: ${res.status} ${detail ?? ""}`.trim());
    throw new OAuthError("registration", "the authorization server did not register the client", detail);
  }
  return {
    clientId: body.client_id,
    clientSecret: typeof body.client_secret === "string" && body.client_secret ? body.client_secret : null,
  };
}

/** Where to send the browser. */
export function authorizationUrl(
  as: AuthorizationServer,
  input: {
    clientId: string;
    redirectUri: string;
    scopes: string[];
    state: string;
    verifier: string;
    resource: string;
  },
): string {
  const url = new URL(as.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  if (input.scopes.length) url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", codeChallenge(input.verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", input.resource);
  return url.toString();
}

async function tokenRequest(
  tokenEndpoint: string,
  form: URLSearchParams,
  client: { clientId: string; clientSecret: string | null; tokenAuth?: TokenAuth | null },
  deps: OAuthDeps,
): Promise<TokenSet> {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  // One authentication method, never two: with a header the form carries no client credentials at all.
  if (client.clientSecret && (client.tokenAuth ?? "basic") === "basic") {
    headers.authorization = `Basic ${Buffer.from(
      `${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`,
    ).toString("base64")}`;
  } else {
    form.set("client_id", client.clientId);
    if (client.clientSecret) form.set("client_secret", client.clientSecret);
  }
  let res: Response;
  try {
    res = await egressFetch(deps.egress, { redirect: "error", timeoutMs: OAUTH_TIMEOUT_MS })(tokenEndpoint, {
      method: "POST",
      headers,
      body: form.toString(),
    });
  } catch (err) {
    throw new OAuthError("token", `could not reach the token endpoint: ${(err as Error).message}`);
  }
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
    error?: unknown;
  };
  if (!res.ok || typeof body.access_token !== "string" || !body.access_token) {
    // The server's error code is safe to log and to show; its description may echo our request.
    const detail = typeof body.error === "string" ? body.error : null;
    deps.log.warn(`oauth token request failed: ${res.status} ${detail ?? ""}`.trim());
    throw new OAuthError("token", "the authorization server did not issue a token", detail);
  }
  const now = deps.now?.() ?? Date.now();
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : null,
    expiresAt:
      typeof body.expires_in === "number" && body.expires_in > 0
        ? new Date(now + body.expires_in * 1000).toISOString()
        : null,
    scope: typeof body.scope === "string" ? body.scope : null,
  };
}

/** The code from the callback becomes tokens. */
export async function exchangeCode(
  tokenEndpoint: string,
  input: {
    clientId: string;
    clientSecret: string | null;
    tokenAuth?: TokenAuth | null;
    code: string;
    redirectUri: string;
    verifier: string;
    resource: string;
  },
  deps: OAuthDeps,
): Promise<TokenSet> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
    resource: input.resource,
  });
  return tokenRequest(tokenEndpoint, form, input, deps);
}

/** New tokens for an old refresh token; the server may rotate the refresh token. */
export async function refreshTokens(
  tokenEndpoint: string,
  input: {
    clientId: string;
    clientSecret: string | null;
    tokenAuth?: TokenAuth | null;
    refreshToken: string;
    resource: string;
  },
  deps: OAuthDeps,
): Promise<TokenSet> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    resource: input.resource,
  });
  const set = await tokenRequest(tokenEndpoint, form, input, deps);
  return { ...set, refreshToken: set.refreshToken ?? input.refreshToken };
}

/** Within this many milliseconds of expiry an access token is refreshed before use. */
export const REFRESH_AHEAD_MS = 60_000;

export function isExpiring(expiresAt: string | null | undefined, now: number): boolean {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) && t - now < REFRESH_AHEAD_MS;
}
