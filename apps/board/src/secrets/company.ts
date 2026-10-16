// Company secrets: a credential's value set by a person from Settings, kept in
// the board's secret store (the cluster's Secrets, or files under compose),
// never in Postgres. One store entry per company, rosterdock-company-<id>, one key
// per name. The row keeps the name, when it was set and by whom; no route ever
// returns a value. A name a company writes (a connection's credential, its
// webhook) resolves from its entry, then from the names the operator shares
// with every company (ROSTERDOCK_SHARED_ENV_NAMES), and from nothing else: the
// rest of the board's environment (its database, its worker token) never
// reaches a company.
import type { ActorRef } from "@rosterdock/shared";
import type { Db } from "../db/pool.js";
import { HttpError } from "../http-error.js";
import { mutate } from "../mutate.js";
import type { SecretStore } from "./store.js";

export function companySecretName(companyId: string): string {
  return `rosterdock-company-${companyId.toLowerCase()}`;
}

/**
 * The part of the board's environment every company may name: the names the operator shares, read when
 * they are used, and nothing else. No other name of the board's is a key here.
 */
export function sharedEnv(boardEnv: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv {
  const view: NodeJS.ProcessEnv = {};
  for (const name of names)
    Object.defineProperty(view, name, { enumerable: true, get: () => boardEnv[name] });
  return view;
}

/**
 * Where env var NAMES resolve for one company: its store entry over `shared`,
 * the names the operator shares (`sharedEnv`). Without a store, `shared` alone.
 */
export async function companyEnv(
  shared: NodeJS.ProcessEnv,
  store: SecretStore | null | undefined,
  companyId: string,
): Promise<NodeJS.ProcessEnv> {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(shared)) if (value !== undefined) out[name] = value;
  const data = store ? await store.get(companySecretName(companyId)) : null;
  for (const [name, value] of Object.entries(data ?? {})) if (value) out[name] = value;
  return out;
}

/**
 * The same deps, with `env` scoped to the company: `deps.env` is what the board shares (never its whole
 * environment), under the company's own secrets; and `poolScope` the company, so a stdio child started for
 * one company never serves another. What every call on a connection goes through.
 */
export async function withCompanyEnv<
  T extends { env?: NodeJS.ProcessEnv; secrets?: SecretStore | null; poolScope?: string },
>(deps: T, companyId: string): Promise<T> {
  return {
    ...deps,
    env: await companyEnv(deps.env ?? {}, deps.secrets, companyId),
    poolScope: companyId,
  };
}

/** What a call says when a name has no value for the company, without saying whether the board holds one. */
export function notSetForCompany(name: string): string {
  return `${name} is not set for this company (its secrets, or a name the board shares)`;
}

export interface CompanySecretRow {
  company_id: string;
  name: string;
  updated_at: Date;
  updated_by_kind: string;
  updated_by_id: string;
}

export function secretToJson(row: CompanySecretRow) {
  return {
    name: row.name,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: { kind: row.updated_by_kind, id: row.updated_by_id },
  };
}

export async function listCompanySecrets(db: Db, companyId: string): Promise<CompanySecretRow[]> {
  const res = await db.query<CompanySecretRow>(
    "SELECT * FROM company_secrets WHERE company_id = $1 ORDER BY name",
    [companyId],
  );
  return res.rows;
}

function requireStore(store: SecretStore | null | undefined): SecretStore {
  if (!store)
    throw new HttpError(
      409,
      "this board has no secret store to keep a value in; set it where the board runs, or turn one on (board.oauth.enabled on the chart, or ROSTERDOCK_SECRET_STORE)",
    );
  return store;
}

/** Set (or replace) one value. The value goes to the store inside the transaction; the row and the event carry the name only. */
export async function setCompanySecret(
  db: Db,
  store: SecretStore | null | undefined,
  companyId: string,
  actor: ActorRef,
  name: string,
  value: string,
): Promise<CompanySecretRow> {
  const s = requireStore(store);
  const entry = companySecretName(companyId);
  const { result } = await mutate(db, companyId, actor, async (ctx) => {
    const existing = (await s.get(entry)) ?? {};
    await s.put(entry, { ...existing, [name]: value });
    const row = (
      await ctx.client.query<CompanySecretRow>(
        `INSERT INTO company_secrets (company_id, name, updated_by_kind, updated_by_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (company_id, name)
         DO UPDATE SET updated_at = now(), updated_by_kind = EXCLUDED.updated_by_kind, updated_by_id = EXCLUDED.updated_by_id
         RETURNING *`,
        [companyId, name, actor.kind, actor.id],
      )
    ).rows[0]!;
    await ctx.emit("secret.set", { kind: "company", id: companyId }, { name, replaced: name in existing });
    return row;
  });
  return result;
}

/** Forget one value: the key leaves the store entry (the entry goes when it was the last), the row goes, one event. */
export async function deleteCompanySecret(
  db: Db,
  store: SecretStore | null | undefined,
  companyId: string,
  actor: ActorRef,
  name: string,
): Promise<void> {
  const s = requireStore(store);
  const entry = companySecretName(companyId);
  await mutate(db, companyId, actor, async (ctx) => {
    const gone = await ctx.client.query(
      "DELETE FROM company_secrets WHERE company_id = $1 AND name = $2 RETURNING name",
      [companyId, name],
    );
    if (gone.rowCount === 0) throw new HttpError(404, `no value is set for ${name}`);
    const existing = (await s.get(entry)) ?? {};
    const { [name]: _dropped, ...rest } = existing;
    if (Object.keys(rest).length) await s.put(entry, rest);
    else await s.delete(entry);
    await ctx.emit("secret.deleted", { kind: "company", id: companyId }, { name });
  });
}
