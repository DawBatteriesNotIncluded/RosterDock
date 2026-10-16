// OpenID Connect sign-in: the authorization-code flow with PKCE against one
// provider, discovered from its issuer. The board holds the client secret by
// NAME (ROSTERDOCK_OIDC_CLIENT_SECRET in the cluster secret) and never stores a
// token from the provider: the id_token is verified (signature against the
// provider's JWKS, issuer, audience, expiry, nonce) and then only the subject,
// email and name are kept on the user row. Memberships come from the email
// claim: an owner grants a membership by email, and the person who signs in
// with that email through the provider is that user. The login attempt (state,
// nonce, PKCE verifier) lives in Postgres so any replica can finish it.
//
// No SDK: discovery, JWKS and the token exchange are plain fetch (injected so
// tests replay a recorded provider), and signatures are checked with node:crypto.

import { createHash, createPublicKey, randomBytes, verify as cryptoVerify } from "node:crypto";
import type { Queryable } from "../db/pool.js";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  /** Value read from the env var NAME ROSTERDOCK_OIDC_CLIENT_SECRET; never logged, never stored. */
  clientSecret: string | null;
  /** How the client secret travels to the token endpoint. */
  tokenAuth: "basic" | "post";
  scopes: string;
  /** Shown on the sign-in button. */
  displayName: string;
  /** Lowercased email domains allowed to sign in; empty, or `*`, allows every verified email (refused at start for a public provider unless `*`). */
  allowedDomains: string[];
}

export interface OidcDeps {
  fetch: typeof fetch;
  now?: () => number;
  log: { warn(m: string): void };
}

export class OidcError extends Error {
  /** A short code the web can turn into a sentence. */
  readonly code: "provider" | "state" | "token" | "email" | "domain";
  constructor(code: OidcError["code"], message: string) {
    super(message);
    this.name = "OidcError";
    this.code = code;
  }
}

// --- Discovery and keys ------------------------------------------------------------

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
}

const DISCOVERY_TTL_MS = 60 * 60_000;
const JWKS_REFETCH_MIN_MS = 60_000;

// One of the provider's signing keys (RSA or EC) as its JWKS lists it. A type alias, not an interface:
// it keeps the implicit index signature that makes it assignable to node:crypto's JsonWebKey in
// @types/node 22, and every field it shares with webcrypto.JsonWebKey (what createPublicKey takes in 26)
// is an optional string, so it is assignable there too.
type Jwk = {
  kty?: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
};

interface Cache {
  discovery: { at: number; doc: Discovery } | null;
  jwks: { at: number; keys: Jwk[] } | null;
}
const caches = new Map<string, Cache>();

function cacheFor(issuer: string): Cache {
  let c = caches.get(issuer);
  if (!c) {
    c = { discovery: null, jwks: null };
    caches.set(issuer, c);
  }
  return c;
}

/** Test hook: forget every cached document. */
export function resetOidcCaches(): void {
  caches.clear();
}

function trimSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

export async function discover(config: OidcConfig, deps: OidcDeps): Promise<Discovery> {
  const cache = cacheFor(config.issuer);
  const now = deps.now?.() ?? Date.now();
  if (cache.discovery && now - cache.discovery.at < DISCOVERY_TTL_MS) return cache.discovery.doc;
  const url = `${trimSlash(config.issuer)}/.well-known/openid-configuration`;
  const res = await deps.fetch(url, { headers: { accept: "application/json" } }).catch((err: Error) => {
    throw new OidcError("provider", `could not reach the identity provider: ${err.message}`);
  });
  if (!res.ok) throw new OidcError("provider", `the identity provider answered ${res.status} to discovery`);
  const doc = (await res.json()) as Partial<Discovery>;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri || !doc.issuer)
    throw new OidcError("provider", "the discovery document is missing an endpoint");
  if (trimSlash(doc.issuer) !== trimSlash(config.issuer))
    throw new OidcError("provider", "the discovery document names a different issuer");
  cache.discovery = { at: now, doc: doc as Discovery };
  return doc as Discovery;
}

async function fetchJwks(config: OidcConfig, deps: OidcDeps, force = false): Promise<Jwk[]> {
  const cache = cacheFor(config.issuer);
  const now = deps.now?.() ?? Date.now();
  if (cache.jwks && (!force || now - cache.jwks.at < JWKS_REFETCH_MIN_MS)) return cache.jwks.keys;
  const doc = await discover(config, deps);
  const res = await deps
    .fetch(doc.jwks_uri, { headers: { accept: "application/json" } })
    .catch((err: Error) => {
      throw new OidcError("provider", `could not fetch the provider's keys: ${err.message}`);
    });
  if (!res.ok) throw new OidcError("provider", `the identity provider answered ${res.status} for its keys`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  cache.jwks = { at: now, keys };
  return keys;
}

// --- PKCE and randomness ----------------------------------------------------------------

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// --- The id_token ---------------------------------------------------------------------

export interface IdClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  [k: string]: unknown;
}

const ALGS: Record<string, { hash: string; kty: "RSA" | "EC"; ec?: boolean }> = {
  RS256: { hash: "sha256", kty: "RSA" },
  RS384: { hash: "sha384", kty: "RSA" },
  RS512: { hash: "sha512", kty: "RSA" },
  ES256: { hash: "sha256", kty: "EC", ec: true },
  ES384: { hash: "sha384", kty: "EC", ec: true },
};

function b64json(part: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new OidcError("token", "the id_token is not well formed");
  }
}

/** Verify a compact JWS with one of the provider's keys and return its claims. Pure given the keys. */
export function verifyJwt(token: string, keys: Jwk[]): IdClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new OidcError("token", "the id_token is not well formed");
  const [h, p, s] = parts as [string, string, string];
  const header = b64json(h) as { alg?: string; kid?: string };
  const alg = ALGS[header.alg ?? ""];
  if (!alg)
    throw new OidcError("token", `the id_token uses an unsupported algorithm (${header.alg ?? "none"})`);
  const candidates = keys.filter(
    (k) =>
      k.kty === alg.kty && (!header.kid || !k.kid || k.kid === header.kid) && (!k.use || k.use === "sig"),
  );
  if (!candidates.length) throw new OidcError("token", "no provider key matches the id_token");
  const data = Buffer.from(`${h}.${p}`);
  const sig = Buffer.from(s, "base64url");
  const ok = candidates.some((jwk) => {
    try {
      const key = createPublicKey({ key: jwk, format: "jwk" });
      return cryptoVerify(alg.hash, data, alg.ec ? { key, dsaEncoding: "ieee-p1363" } : key, sig);
    } catch {
      return false;
    }
  });
  if (!ok) throw new OidcError("token", "the id_token signature does not verify");
  return b64json(p) as unknown as IdClaims;
}

export function checkClaims(
  claims: IdClaims,
  expect: { issuer: string; clientId: string; nonce: string; nowSeconds: number },
): void {
  if (trimSlash(String(claims.iss ?? "")) !== trimSlash(expect.issuer))
    throw new OidcError("token", "the id_token was issued by someone else");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(expect.clientId)) throw new OidcError("token", "the id_token is for another client");
  if (typeof claims.exp !== "number" || claims.exp + 60 < expect.nowSeconds)
    throw new OidcError("token", "the id_token has expired");
  if (typeof claims.sub !== "string" || !claims.sub)
    throw new OidcError("token", "the id_token has no subject");
  if (claims.nonce !== expect.nonce) throw new OidcError("token", "the id_token does not match this sign-in");
}

/** The email the memberships key on, or why not. */
export function emailFrom(claims: IdClaims, allowedDomains: string[]): string {
  const email = typeof claims.email === "string" ? claims.email.trim() : "";
  if (!email || !email.includes("@")) throw new OidcError("email", "the identity provider sent no email");
  if (claims.email_verified === false)
    throw new OidcError("email", "the email is not verified with the provider");
  const domain = email.split("@")[1]!.toLowerCase();
  if (allowedDomains.length && !allowedDomains.includes("*") && !allowedDomains.includes(domain))
    throw new OidcError("domain", `${domain} is not a domain that may sign in here`);
  return email;
}

export function nameFrom(claims: IdClaims, email: string): string {
  const n = typeof claims.name === "string" && claims.name.trim() ? claims.name.trim() : null;
  const u =
    typeof claims.preferred_username === "string" && claims.preferred_username.trim()
      ? claims.preferred_username.trim()
      : null;
  return (n ?? u ?? email.split("@")[0] ?? email).slice(0, 120);
}

// --- The flow -------------------------------------------------------------------------------------

export const LOGIN_TTL_SECONDS = 10 * 60;

/** Start a sign-in: record the attempt and return where to send the browser. */
export async function beginLogin(
  db: Queryable,
  config: OidcConfig,
  deps: OidcDeps,
  input: { redirectUri: string; returnTo: string },
): Promise<{ url: string; state: string }> {
  const doc = await discover(config, deps);
  const state = randomToken(24);
  const nonce = randomToken(24);
  const verifier = randomToken(48);
  await db.query("DELETE FROM oidc_logins WHERE expires_at < now()");
  await db.query(
    `INSERT INTO oidc_logins (state, nonce, code_verifier, return_to, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' seconds')::interval)`,
    [state, nonce, verifier, input.returnTo, String(LOGIN_TTL_SECONDS)],
  );
  const url = new URL(doc.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", config.scopes);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", codeChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return { url: url.toString(), state };
}

/** What the provider says about the person beyond name and email; refreshed on every sign-in. */
export interface UserProfile {
  picture?: string;
  preferredUsername?: string;
  givenName?: string;
  familyName?: string;
  locale?: string;
}

export interface SignedInIdentity {
  subject: string;
  email: string;
  name: string;
  profile: UserProfile;
  returnTo: string;
}

/** The standard profile claims, each kept only when it is a short string (a picture only as an https URL). */
export function profileFrom(claims: IdClaims): UserProfile {
  const str = (v: unknown, max: number) =>
    typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : undefined;
  const picture = str(claims.picture, 2000);
  const out: UserProfile = {};
  if (picture && /^https:\/\//i.test(picture)) out.picture = picture;
  const preferredUsername = str(claims.preferred_username, 120);
  if (preferredUsername) out.preferredUsername = preferredUsername;
  const givenName = str(claims.given_name, 120);
  if (givenName) out.givenName = givenName;
  const familyName = str(claims.family_name, 120);
  if (familyName) out.familyName = familyName;
  const locale = str(claims.locale, 35);
  if (locale) out.locale = locale;
  return out;
}

/** Finish a sign-in: the code becomes a verified identity. Consumes the login attempt. */
export async function finishLogin(
  db: Queryable,
  config: OidcConfig,
  deps: OidcDeps,
  input: { code: string; state: string; redirectUri: string },
): Promise<SignedInIdentity> {
  const attempt = (
    await db.query<{ nonce: string; code_verifier: string; return_to: string }>(
      "DELETE FROM oidc_logins WHERE state = $1 AND expires_at > now() RETURNING nonce, code_verifier, return_to",
      [input.state],
    )
  ).rows[0];
  if (!attempt) throw new OidcError("state", "this sign-in was not started here, or it took too long");
  const doc = await discover(config, deps);
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: config.clientId,
    code_verifier: attempt.code_verifier,
  });
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (config.clientSecret) {
    if (config.tokenAuth === "post") form.set("client_secret", config.clientSecret);
    else
      headers.authorization = `Basic ${Buffer.from(
        `${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`,
      ).toString("base64")}`;
  }
  const res = await deps
    .fetch(doc.token_endpoint, { method: "POST", headers, body: form.toString() })
    .catch((err: Error) => {
      throw new OidcError("provider", `could not reach the token endpoint: ${err.message}`);
    });
  const body = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string };
  if (!res.ok || !body.id_token) {
    // The provider's error code is safe to log; its description may echo our request.
    deps.log.warn(`oidc token exchange failed: ${res.status} ${body.error ?? ""}`.trim());
    throw new OidcError("token", "the identity provider did not issue a token");
  }
  let keys = await fetchJwks(config, deps);
  let claims: IdClaims;
  try {
    claims = verifyJwt(body.id_token, keys);
  } catch (err) {
    // A rotated key: fetch the set once more before giving up.
    if (!(err instanceof OidcError) || err.code !== "token") throw err;
    keys = await fetchJwks(config, deps, true);
    claims = verifyJwt(body.id_token, keys);
  }
  checkClaims(claims, {
    issuer: config.issuer,
    clientId: config.clientId,
    nonce: attempt.nonce,
    nowSeconds: Math.floor((deps.now?.() ?? Date.now()) / 1000),
  });
  const email = emailFrom(claims, config.allowedDomains);
  return {
    subject: claims.sub,
    email,
    name: nameFrom(claims, email),
    profile: profileFrom(claims),
    returnTo: attempt.return_to,
  };
}

/**
 * The user for a verified identity: by subject first, then by email (an owner invited them before they
 * ever signed in, so the memberships already exist), else a new row.
 */
export async function upsertOidcUser(
  db: Queryable,
  identity: SignedInIdentity,
): Promise<{ id: string; email: string; name: string }> {
  const bySubject = await db.query<{ id: string; email: string; name: string }>(
    "SELECT id, email, name FROM users WHERE oidc_subject = $1",
    [identity.subject],
  );
  if (bySubject.rows[0]) {
    const row = bySubject.rows[0];
    // Follow a changed email when nobody else holds it; the name and the profile follow the provider.
    const updated = await db.query<{ id: string; email: string; name: string }>(
      `UPDATE users SET name = $2,
         email = CASE WHEN EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower($3) AND u.id <> $1) THEN email ELSE $3 END,
         profile = $4, updated_at = now()
       WHERE id = $1 RETURNING id, email, name`,
      [row.id, identity.name, identity.email, JSON.stringify(identity.profile)],
    );
    return updated.rows[0]!;
  }
  const byEmail = await db.query<{ id: string; oidc_subject: string | null }>(
    "SELECT id, oidc_subject FROM users WHERE lower(email) = lower($1)",
    [identity.email],
  );
  const existing = byEmail.rows[0];
  if (existing) {
    if (existing.oidc_subject && existing.oidc_subject !== identity.subject)
      throw new OidcError("email", "this email already belongs to another identity");
    const updated = await db.query<{ id: string; email: string; name: string }>(
      "UPDATE users SET oidc_subject = $2, name = $3, profile = $4, updated_at = now() WHERE id = $1 RETURNING id, email, name",
      [existing.id, identity.subject, identity.name, JSON.stringify(identity.profile)],
    );
    return updated.rows[0]!;
  }
  const inserted = await db.query<{ id: string; email: string; name: string }>(
    "INSERT INTO users (email, name, oidc_subject, profile) VALUES ($1, $2, $3, $4) RETURNING id, email, name",
    [identity.email, identity.name, identity.subject, JSON.stringify(identity.profile)],
  );
  return inserted.rows[0]!;
}

/** A return-to path the board will send the browser back to: same origin, a path only. */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\"))
    return "/";
  return value.slice(0, 500);
}
