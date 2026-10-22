// Authorising a connection by OAuth: start (discover, register when needed,
// record the attempt, say where to send the browser) and finish (consume the
// attempt, exchange the code, keep the tokens in the secret store, mark the
// row). The row keeps what is not secret; the store keeps the client secret
// and the tokens under the connection's name; events name neither.
import type { ActorRef } from "@rosterdock/shared";
import { randomToken } from "../auth/oidc.js";
import type { Db } from "../db/pool.js";
import { HttpError } from "../http-error.js";
import { mutate } from "../mutate.js";
import { companyEnv, notSetForCompany } from "../secrets/company.js";
import {
  connectionSecretName,
  SecretStoreError,
  type SecretData,
  type SecretStore,
} from "../secrets/store.js";
import { companyEgress } from "../web/egress.js";
import { loadConnection, oauthResource, type ConnectionOAuth, type ConnectionRow } from "./connections.js";
import {
  authorizationUrl,
  discoverAuthorizationServer,
  discoverResource,
  exchangeCode,
  OAuthError,
  registerClient,
  resourceAllowed,
  tokenAuthFor,
  type OAuthDeps,
  type TokenSet,
} from "./oauth.js";

export const START_TTL_SECONDS = 10 * 60;

export interface AuthorizeDeps {
  store: SecretStore | null;
  oauth: OAuthDeps;
  /** The names the board shares with every company (secrets/company.ts sharedEnv). Default: none. */
  env?: NodeJS.ProcessEnv;
}

/** A pre-registered client's secret by name: the company's store entry, else a name the board shares; refused, by name only, when neither has it. */
async function namedClientSecret(row: ConnectionRow, deps: AuthorizeDeps): Promise<string | null> {
  const name = row.oauth?.clientSecretEnvName;
  if (!name) return null;
  const value = (await companyEnv(deps.env ?? {}, deps.store, row.company_id))[name];
  if (!value) throw new HttpError(422, `${notSetForCompany(name)}; set it and press Authorise again`);
  return value;
}

/** What the store keeps for a connection: the client secret when one was issued, and the tokens. */
export function tokenData(existing: SecretData | null, set: TokenSet): SecretData {
  const out: SecretData = {};
  if (existing?.client_secret) out.client_secret = existing.client_secret;
  out.access_token = set.accessToken;
  if (set.refreshToken) out.refresh_token = set.refreshToken;
  if (set.expiresAt) out.expires_at = set.expiresAt;
  return out;
}

function remote(err: unknown): never {
  if (err instanceof OAuthError) throw new HttpError(502, err.message);
  if (err instanceof SecretStoreError) throw new HttpError(502, err.message);
  throw err;
}

async function saveOAuth(
  db: Db,
  row: ConnectionRow,
  actor: ActorRef,
  oauth: ConnectionOAuth,
  payload: Record<string, unknown>,
): Promise<void> {
  await mutate(db, row.company_id, actor, async (ctx) => {
    await ctx.client.query(
      "UPDATE connections SET oauth = $3, updated_at = now() WHERE id = $1 AND company_id = $2",
      [row.id, row.company_id, JSON.stringify(oauth)],
    );
    await ctx.emit(
      "connection.updated",
      { kind: "connection", id: row.id },
      { name: row.name, changes: ["oauth"], ...payload },
    );
  });
}

/** Where to send the browser; the attempt is recorded so any replica can finish it. */
export async function startAuthorization(
  db: Db,
  deps: AuthorizeDeps,
  input: {
    companyId: string;
    connectionId: string;
    actor: ActorRef;
    userId: string;
    redirectUri: string;
    returnTo: string;
  },
): Promise<{ url: string }> {
  if (!deps.store)
    throw new HttpError(
      409,
      "OAuth needs a secret store the board can write to, and the board has none configured",
    );
  const row = await loadConnection(db, input.companyId, input.connectionId);
  if (!row.oauth) throw new HttpError(409, `${row.name} authenticates by env var name, not OAuth`);
  if (row.kind !== "mcp" || row.transport !== "http" || !row.url)
    throw new HttpError(422, "OAuth is for MCP servers over HTTP");
  // A secret the person named must be there before anyone is sent to a consent page.
  await namedClientSecret(row, deps);
  // The company's own: its private destinations, and no other company's.
  const oauth: OAuthDeps = { ...deps.oauth, egress: companyEgress(deps.oauth.egress, row.company_id) };
  let meta = row.oauth;
  try {
    let scopesHint: string[] | null = null;
    let issuer = meta.authorizationServer;
    let declared = meta.resource ?? null;
    // The resource identifier is read with the issuer, and again for a row from before it was kept, or that
    // keeps one this server may not speak for (resourceAllowed), from before the board checked that.
    if (!issuer || meta.resource == null || (meta.resource && !resourceAllowed(meta.resource, row.url))) {
      const found = await discoverResource(row.url, oauth);
      issuer ??= found.authorizationServer;
      scopesHint = found.scopes;
      declared = found.resource;
    }
    const resource = declared ?? row.url;
    const as = await discoverAuthorizationServer(issuer, oauth);
    const tokenAuth = tokenAuthFor(as);
    let clientId = meta.clientId;
    let registered = meta.registered;
    if (!clientId) {
      const reg = await registerClient(as, input.redirectUri, oauth, tokenAuth);
      clientId = reg.clientId;
      registered = true;
      const name = connectionSecretName(row.id);
      const { client_secret: _old, ...rest } = (await deps.store.get(name)) ?? {};
      await deps.store.put(name, reg.clientSecret ? { ...rest, client_secret: reg.clientSecret } : rest);
    }
    const scopes = meta.scopes.length ? meta.scopes : (scopesHint ?? []);
    const next: ConnectionOAuth = {
      ...meta,
      authorizationServer: as.issuer,
      tokenEndpoint: as.token_endpoint,
      clientId,
      registered,
      scopes,
      resource: declared,
      tokenAuth,
    };
    if (JSON.stringify(next) !== JSON.stringify(meta)) {
      await saveOAuth(db, row, input.actor, next, {
        authorizationServer: as.issuer,
        clientId,
        registered,
      });
      meta = next;
    }
    const state = randomToken(24);
    const verifier = randomToken(48);
    await db.query("DELETE FROM oauth_starts WHERE expires_at < now()");
    await db.query(
      `INSERT INTO oauth_starts (state, company_id, connection_id, user_id, code_verifier, redirect_uri, return_to, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8 || ' seconds')::interval)`,
      [
        state,
        row.company_id,
        row.id,
        input.userId,
        verifier,
        input.redirectUri,
        input.returnTo,
        String(START_TTL_SECONDS),
      ],
    );
    return {
      url: authorizationUrl(as, {
        clientId,
        redirectUri: input.redirectUri,
        scopes,
        state,
        verifier,
        resource,
      }),
    };
  } catch (err) {
    return remote(err);
  }
}

interface StartRow {
  state: string;
  company_id: string;
  connection_id: string;
  user_id: string;
  code_verifier: string;
  redirect_uri: string;
  return_to: string;
}

/** The callback: the code becomes tokens in the store, and the row says when it was authorised. */
export async function finishAuthorization(
  db: Db,
  deps: AuthorizeDeps,
  input: {
    code: string;
    state: string;
    userId: string;
    actor: ActorRef;
    /** Whether this person may manage the connections of the company the attempt names. */
    canManage(companyId: string): Promise<boolean>;
  },
): Promise<{ companyId: string; connectionId: string; name: string; returnTo: string }> {
  if (!deps.store) throw new OAuthError("store", "the board has no secret store");
  const pending = (
    await db.query<StartRow>("SELECT * FROM oauth_starts WHERE state = $1 AND expires_at > now()", [
      input.state,
    ])
  ).rows[0];
  if (!pending) throw new OAuthError("state", "this authorisation was not started here, or it took too long");
  if (pending.user_id !== input.userId)
    throw new OAuthError("state", "this authorisation was started by someone else");
  if (!(await input.canManage(pending.company_id)))
    throw new OAuthError("forbidden", "you may not manage this company's connections");
  const consumed = await db.query("DELETE FROM oauth_starts WHERE state = $1 RETURNING state", [input.state]);
  if (!consumed.rowCount) throw new OAuthError("state", "this authorisation was already finished");
  const row = await loadConnection(db, pending.company_id, pending.connection_id).catch(() => null);
  if (!row?.oauth?.tokenEndpoint || !row.oauth.clientId || !row.url)
    throw new OAuthError("state", "the connection changed while it was being authorised");
  const name = connectionSecretName(row.id);
  const existing = await deps.store.get(name);
  const set = await exchangeCode(
    row.oauth.tokenEndpoint,
    {
      clientId: row.oauth.clientId,
      clientSecret: existing?.client_secret ?? (await namedClientSecret(row, deps)),
      tokenAuth: row.oauth.tokenAuth ?? null,
      code: input.code,
      redirectUri: pending.redirect_uri,
      verifier: pending.code_verifier,
      resource: oauthResource(row) ?? row.url,
    },
    { ...deps.oauth, egress: companyEgress(deps.oauth.egress, row.company_id) },
  );
  await deps.store.put(name, tokenData(existing, set));
  const authorizedAt = new Date(deps.oauth.now?.() ?? Date.now()).toISOString();
  await saveOAuth(db, row, input.actor, { ...row.oauth, authorizedAt }, { authorized: true, authorizedAt });
  return { companyId: row.company_id, connectionId: row.id, name: row.name, returnTo: pending.return_to };
}
