// A fake OpenID provider behind an injected fetch: the recorded discovery
// document (Google's, hosts rewritten), a JWKS with one generated RSA key, and
// a token endpoint that checks the client secret, the redirect URI and the
// PKCE verifier before signing an id_token. Tests drive the browser's leg by
// hand: authorize() takes the URL the board redirected to and returns the
// callback URL the provider would send the browser back with.

import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const discoveryFixture = JSON.parse(
  readFileSync(path.join(here, "fixtures", "oidc", "discovery.json"), "utf8"),
) as Record<string, unknown>;

export interface FakeIdentity {
  sub: string;
  email: string;
  name?: string;
  emailVerified?: boolean;
  /** Override claims for the awkward cases (a wrong nonce, another audience). */
  claims?: Record<string, unknown>;
}

export interface OidcFake {
  fetch: typeof fetch;
  issuer: string;
  /** Every request the fake saw, method and URL. */
  calls: { method: string; url: string; body?: string; authorization?: string }[];
  /** The browser's leg: consume the board's redirect, return the provider's callback URL. */
  authorize(authorizeUrl: string, who: FakeIdentity): string;
  /** Sign a token with the fake's key (or a stranger's key with foreign=true). */
  signIdToken(claims: Record<string, unknown>, foreign?: boolean): string;
  /** Replace the signing key, as a provider rotating its keys would. */
  rotateKey(): void;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function createOidcFake(opts: {
  issuer?: string;
  clientId: string;
  clientSecret: string;
  now?: () => number;
  /** Serve an end_session_endpoint (RP-initiated logout), which Google's recorded document does not have. */
  endSession?: boolean;
}): OidcFake {
  const issuer = (opts.issuer ?? "https://id.example.test").replace(/\/+$/, "");
  const discovery = JSON.parse(
    JSON.stringify(discoveryFixture)
      .replaceAll("https://accounts.google.com", issuer)
      .replaceAll("https://oauth2.googleapis.com", `${issuer}/oauth2`)
      .replaceAll("https://openidconnect.googleapis.com", `${issuer}/connect`)
      .replaceAll("https://www.googleapis.com", `${issuer}/keys`),
  ) as Record<string, string>;
  if (opts.endSession) discovery.end_session_endpoint = `${issuer}/logout`;
  let keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let kid = "k1";
  const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pending = new Map<
    string,
    { challenge: string; nonce: string; redirectUri: string; who: FakeIdentity }
  >();
  const calls: OidcFake["calls"] = [];

  const sign = (claims: Record<string, unknown>, foreign = false): string => {
    const header = b64url(JSON.stringify({ alg: "RS256", kid: foreign ? "stranger" : kid, typ: "JWT" }));
    const payload = b64url(JSON.stringify(claims));
    const signer = createSign("sha256");
    signer.update(`${header}.${payload}`);
    const sig = signer.sign(foreign ? stranger.privateKey : keyPair.privateKey);
    return `${header}.${payload}.${b64url(sig)}`;
  };

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ method, url, body, authorization: headers.get("authorization") ?? undefined });
    if (url === `${issuer}/.well-known/openid-configuration`) return json(discovery);
    if (url === discovery.jwks_uri) {
      const jwk = keyPair.publicKey.export({ format: "jwk" }) as Record<string, unknown>;
      return json({ keys: [{ ...jwk, kid, use: "sig", alg: "RS256" }] });
    }
    if (url === discovery.token_endpoint && method === "POST") {
      const form = new URLSearchParams(body ?? "");
      const basic = headers.get("authorization");
      let clientId = form.get("client_id");
      let secret = form.get("client_secret");
      if (basic?.startsWith("Basic ")) {
        const [id, s] = Buffer.from(basic.slice(6), "base64").toString("utf8").split(":");
        clientId = decodeURIComponent(id ?? "");
        secret = decodeURIComponent(s ?? "");
      }
      if (clientId !== opts.clientId || secret !== opts.clientSecret)
        return json({ error: "invalid_client" }, 401);
      if (form.get("grant_type") !== "authorization_code")
        return json({ error: "unsupported_grant_type" }, 400);
      const code = form.get("code") ?? "";
      const issued = pending.get(code);
      pending.delete(code);
      if (!issued) return json({ error: "invalid_grant", error_description: "unknown code" }, 400);
      if (issued.redirectUri !== form.get("redirect_uri"))
        return json({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
      const verifier = form.get("code_verifier") ?? "";
      if (createHash("sha256").update(verifier).digest("base64url") !== issued.challenge)
        return json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
      const nowSeconds = Math.floor((opts.now?.() ?? Date.now()) / 1000);
      const who = issued.who;
      const claims = {
        iss: issuer,
        sub: who.sub,
        aud: opts.clientId,
        iat: nowSeconds,
        exp: nowSeconds + 3600,
        nonce: issued.nonce,
        email: who.email,
        email_verified: who.emailVerified ?? true,
        ...(who.name ? { name: who.name } : {}),
        ...(who.claims ?? {}),
      };
      return json({
        access_token: randomBytes(16).toString("hex"),
        expires_in: 3599,
        scope: "openid email profile",
        token_type: "Bearer",
        id_token: sign(claims),
      });
    }
    return new Response("not found", { status: 404 });
  };

  return {
    fetch: fakeFetch,
    issuer,
    calls,
    authorize(authorizeUrl, who) {
      const u = new URL(authorizeUrl);
      if (!u.toString().startsWith(discovery.authorization_endpoint))
        throw new Error(`not the authorization endpoint: ${authorizeUrl}`);
      const q = u.searchParams;
      if (q.get("response_type") !== "code") throw new Error("response_type must be code");
      if (q.get("client_id") !== opts.clientId) throw new Error("unknown client_id");
      if (q.get("code_challenge_method") !== "S256") throw new Error("PKCE S256 required");
      for (const k of ["redirect_uri", "state", "nonce", "code_challenge", "scope"])
        if (!q.get(k)) throw new Error(`missing ${k}`);
      const code = randomBytes(12).toString("hex");
      pending.set(code, {
        challenge: q.get("code_challenge")!,
        nonce: q.get("nonce")!,
        redirectUri: q.get("redirect_uri")!,
        who,
      });
      const back = new URL(q.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", q.get("state")!);
      return back.toString();
    },
    signIdToken: sign,
    rotateKey() {
      keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
      kid = `k${Date.now()}`;
    },
  };
}
