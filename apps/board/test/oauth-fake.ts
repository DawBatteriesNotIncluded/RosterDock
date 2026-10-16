// A fake authorization server in front of the MCP fake, behind one injected
// fetch: the protected resource metadata for the MCP URL, the server's own
// metadata, client registration, the token endpoint (a code with PKCE, the
// redirect URI, the client's credentials and the resource checked; a refresh
// that rotates the pair), and the MCP server itself, which answers 401 with a
// WWW-Authenticate pointing at the metadata unless the bearer is one this
// server issued and it has not expired. Tests drive the browser's leg by
// hand: authorize() takes the URL the board built and returns the callback
// URL. The shapes come from fixtures/oauth.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "oauth");
const fixture = (name: string) =>
  JSON.parse(readFileSync(path.join(fixtures, `${name}.json`), "utf8")) as Record<string, unknown>;

export interface OAuthFake {
  fetch: typeof fetch;
  issuer: string;
  /** Every request seen: method, URL, the form or JSON body when there was one, the authorization header. */
  calls: { method: string; url: string; body?: string; authorization?: string }[];
  /** Clients registered: id to secret. */
  clients: Map<string, string>;
  /** The browser's leg: consume the board's redirect, return the callback URL. */
  authorize(authorizeUrl: string): string;
  /** Every access token issued so far, in order. */
  issued: string[];
  /** Refuse registration from now on (a server that wants a pre-registered client). */
  noRegistration: boolean;
  /** What the metadata lists as token endpoint authentication; the board picks post when it is there, else basic. */
  tokenAuthMethods: string[];
}

export function createOAuthFake(opts: {
  mcpUrl: string;
  /** Answers the MCP server's own requests once the bearer is accepted. */
  inner: typeof fetch;
  issuer?: string;
  now?: () => number;
  /** How long an access token lives (seconds). */
  expiresIn?: number;
  scopes?: string[];
  /** What the server calls itself in its protected resource metadata; default the MCP URL. Notion says its origin. */
  resource?: string;
  /** Token endpoint authentication the metadata lists; default basic and none, the RFC 8414 shape. */
  tokenAuthMethods?: string[];
}): OAuthFake {
  const issuer = (opts.issuer ?? "https://auth.example.test").replace(/\/+$/, "");
  const mcp = new URL(opts.mcpUrl);
  const resource = opts.resource ?? opts.mcpUrl;
  const now = () => opts.now?.() ?? Date.now();
  const expiresIn = opts.expiresIn ?? 3600;
  const scopes = opts.scopes ?? ["crm.read", "crm.write"];
  const sub = (doc: Record<string, unknown>) =>
    JSON.parse(
      JSON.stringify(doc)
        .replaceAll("https://auth.example.test", issuer)
        .replaceAll("https://mcp.example.test/mcp", opts.mcpUrl),
    ) as Record<string, unknown>;
  const resourceDoc = { ...sub(fixture("protected-resource")), scopes_supported: scopes, resource };
  const serverDoc = sub(fixture("authorization-server")) as Record<string, string>;
  const pending = new Map<
    string,
    { challenge: string; redirectUri: string; clientId: string; resource: string }
  >();
  const tokens = new Map<string, { expiresAt: number }>();
  const refreshes = new Map<string, string>();
  let n = 0;
  const calls: OAuthFake["calls"] = [];
  const clients = new Map<string, string>();
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const issue = () => {
    n += 1;
    const access = `access-${n}`;
    const refresh = `refresh-${n}`;
    tokens.set(access, { expiresAt: now() + expiresIn * 1000 });
    refreshes.set(refresh, access);
    fake.issued.push(access);
    return {
      ...fixture("token"),
      access_token: access,
      refresh_token: refresh,
      expires_in: expiresIn,
      scope: scopes.join(" "),
    };
  };
  // Strict, like Notion: a Basic header is one authentication method and client credentials in the form
  // are another, and a request that carries both is refused before the client is even looked up.
  const clientOf = (
    form: URLSearchParams,
    headers: Headers,
  ): { id: string; ok: boolean; multiple?: boolean } => {
    let id = form.get("client_id") ?? "";
    let secret: string | null = form.get("client_secret");
    const basic = headers.get("authorization");
    if (basic?.startsWith("Basic ")) {
      if (form.has("client_id") || form.has("client_secret")) return { id, ok: false, multiple: true };
      const [i, s] = Buffer.from(basic.slice(6), "base64").toString("utf8").split(":");
      id = decodeURIComponent(i ?? "");
      secret = decodeURIComponent(s ?? "");
    }
    const known = clients.get(id);
    return { id, ok: known !== undefined && known === (secret ?? "") };
  };

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ method, url, body, authorization: headers.get("authorization") ?? undefined });
    const u = new URL(url);
    if (u.origin === mcp.origin && u.pathname.startsWith("/.well-known/oauth-protected-resource"))
      return u.pathname === `/.well-known/oauth-protected-resource${mcp.pathname}`
        ? json(resourceDoc)
        : new Response("not found", { status: 404 });
    if (url === `${issuer}/.well-known/oauth-authorization-server`)
      return json({ ...serverDoc, token_endpoint_auth_methods_supported: fake.tokenAuthMethods });
    if (url === serverDoc.registration_endpoint && method === "POST") {
      if (fake.noRegistration) return json({ error: "invalid_client_metadata" }, 400);
      const req = JSON.parse(body ?? "{}") as { redirect_uris?: string[]; client_name?: string };
      if (!req.redirect_uris?.length) return json({ error: "invalid_redirect_uri" }, 400);
      const id = `client-${clients.size + 1}`;
      const secret = `client-secret-${randomBytes(8).toString("hex")}`;
      clients.set(id, secret);
      return json(
        {
          ...fixture("registration"),
          client_id: id,
          client_secret: secret,
          redirect_uris: req.redirect_uris,
          client_name: req.client_name,
        },
        201,
      );
    }
    if (url === serverDoc.token_endpoint && method === "POST") {
      const form = new URLSearchParams(body ?? "");
      const client = clientOf(form, headers);
      if (client.multiple)
        return json(
          {
            error: "invalid_request",
            error_description: "Client must not use multiple authentication methods",
          },
          400,
        );
      if (!client.ok) return json({ error: "invalid_client" }, 401);
      const grant = form.get("grant_type");
      if (grant === "authorization_code") {
        const code = form.get("code") ?? "";
        const issuedCode = pending.get(code);
        pending.delete(code);
        if (!issuedCode || issuedCode.clientId !== client.id)
          return json({ error: "invalid_grant", error_description: "unknown code" }, 400);
        if (issuedCode.redirectUri !== form.get("redirect_uri"))
          return json({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
        if (issuedCode.resource !== form.get("resource"))
          return json({ error: "invalid_target", error_description: "resource mismatch" }, 400);
        const verifier = form.get("code_verifier") ?? "";
        if (createHash("sha256").update(verifier).digest("base64url") !== issuedCode.challenge)
          return json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
        return json(issue());
      }
      if (grant === "refresh_token") {
        const old = form.get("refresh_token") ?? "";
        const access = refreshes.get(old);
        refreshes.delete(old);
        if (!access) return json({ error: "invalid_grant", error_description: "unknown refresh token" }, 400);
        tokens.delete(access);
        return json(issue());
      }
      return json({ error: "unsupported_grant_type" }, 400);
    }
    if (u.origin === mcp.origin && u.pathname === mcp.pathname) {
      const bearer = headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
      const live = tokens.get(bearer);
      if (!live || live.expiresAt <= now())
        return new Response(JSON.stringify({ error: "invalid_token" }), {
          status: 401,
          headers: {
            "content-type": "application/json",
            "www-authenticate": `Bearer resource_metadata="${mcp.origin}/.well-known/oauth-protected-resource${mcp.pathname}"`,
          },
        });
      return opts.inner(input, init);
    }
    return new Response("not found", { status: 404 });
  };

  const fake: OAuthFake = {
    fetch: fakeFetch,
    issuer,
    calls,
    clients,
    issued: [],
    noRegistration: false,
    tokenAuthMethods: opts.tokenAuthMethods ?? ["client_secret_basic", "none"],
    authorize(authorizeUrl) {
      const u = new URL(authorizeUrl);
      if (!u.toString().startsWith(serverDoc.authorization_endpoint))
        throw new Error(`not the authorization endpoint: ${authorizeUrl}`);
      const q = u.searchParams;
      if (q.get("response_type") !== "code") throw new Error("response_type must be code");
      if (!clients.has(q.get("client_id") ?? "")) throw new Error("unknown client_id");
      if (q.get("code_challenge_method") !== "S256") throw new Error("PKCE S256 required");
      for (const k of ["redirect_uri", "state", "code_challenge", "resource"])
        if (!q.get(k)) throw new Error(`missing ${k}`);
      if (q.get("resource") !== resource)
        throw new Error(
          `resource must be what the server calls itself (${resource}), got ${q.get("resource")}`,
        );
      const code = randomBytes(12).toString("hex");
      pending.set(code, {
        challenge: q.get("code_challenge")!,
        redirectUri: q.get("redirect_uri")!,
        clientId: q.get("client_id")!,
        resource: q.get("resource")!,
      });
      const back = new URL(q.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", q.get("state")!);
      return back.toString();
    },
  };
  return fake;
}
