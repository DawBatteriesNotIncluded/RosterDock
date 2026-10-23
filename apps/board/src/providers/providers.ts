// Company model providers: a company's own model account, one row each, with the env var NAMES its
// credentials resolve under and the models it serves (@rosterdock/shared providers.ts). Owners and admins add,
// change and remove them (model.manage). A write is checked against what the operator offers
// (ROSTERDOCK_MODEL_PROVIDERS), names that are the board's own are refused (operator.ts), and an endpoint
// the company gives must be one the board may reach for it (web/address.ts): public, or private where the
// operator lists it. Only the board ever resolves a value, when it makes a call; nothing here reads one.

import {
  addressListed,
  assertNoRawSecrets,
  RawSecretError,
  hostListed,
  isAddress,
  PROVIDER_KIND_LABELS,
  type ActorRef,
  type CompatibleAuthHeader,
  type ModelProvider,
  type ModelProvidersPolicy,
  type ProviderKind,
  type ProviderModel,
  type ProviderModelInput,
  type UpdateModelProviderInput,
  ModelProviderSchema,
} from "@rosterdock/shared";
import type { z, ZodType } from "zod";
import type { Db, Queryable } from "../db/pool.js";
import { conflict, HttpError, notFound } from "../http-error.js";
import { mutate } from "../mutate.js";
import { assertCompanyEnvNames, type OperatorPolicy } from "../operator.js";
import {
  reachableAddresses,
  RefusedAddress,
  refuseDestination,
  refusedLiteral,
  type Resolve,
} from "../web/address.js";
import { companyEgress, type Egress } from "../web/egress.js";

/** The last check of a provider's key and models, kept on the row. */
export interface ProviderCheck {
  ok: boolean;
  at: string;
  latencyMs: number;
  detail: string | null;
  listed: number;
}

export interface ProviderRow {
  id: string;
  company_id: string;
  name: string;
  label: string;
  kind: ProviderKind;
  endpoint: string | null;
  region: string | null;
  auth_header: CompatibleAuthHeader | null;
  credentials: Record<string, string>;
  models: ProviderModel[];
  enabled: boolean;
  last_check: ProviderCheck | null;
  archived_at: Date | null;
  created_by_kind: string;
  created_by_id: string;
  created_at: Date;
  updated_at: Date;
}

export interface ProviderDeps {
  db: Db;
  /** What the operator lets companies name and reach. */
  operator: OperatorPolicy;
  /** ROSTERDOCK_MODEL_PROVIDERS. */
  policy: ModelProvidersPolicy;
  /** What a company's endpoint is checked with: the resolver and the operator's private destinations. */
  egress: Egress;
}

/** Where a credential's value comes from, as a person reads it; never the value. */
export type CredentialState =
  { state: "set"; setAt: string; setBy: ActorRef } | { state: "shared" } | { state: "missing" };

export function providerToJson(
  row: ProviderRow,
  states: Record<string, CredentialState>,
  policy: ModelProvidersPolicy,
) {
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    label: row.label,
    kind: row.kind,
    endpoint: row.endpoint,
    region: row.region,
    authHeader: row.auth_header,
    credentials: row.credentials,
    credentialStates: states,
    models: row.models,
    enabled: row.enabled,
    /** Whether the operator still offers this kind; a provider of a kind no longer offered is kept, unused. */
    offered: policy.kinds.includes(row.kind),
    lastCheck: row.last_check,
    archivedAt: row.archived_at?.toISOString() ?? null,
    createdBy: { kind: row.created_by_kind, id: row.created_by_id },
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Where each name on these rows gets its value for the company: a secret the company set (when, and by whom),
 * a name the operator shares, or nothing yet. A name the company set wins over a shared one, as it resolves.
 */
export async function credentialStates(
  db: Queryable,
  companyId: string,
  sharedEnvNames: readonly string[],
  rows: readonly ProviderRow[],
): Promise<Map<string, Record<string, CredentialState>>> {
  const names = [...new Set(rows.flatMap((r) => Object.values(r.credentials)))];
  const set = new Map<string, CredentialState>();
  if (names.length) {
    const res = await db.query<{
      name: string;
      updated_at: Date;
      updated_by_kind: ActorRef["kind"];
      updated_by_id: string;
    }>(
      "SELECT name, updated_at, updated_by_kind, updated_by_id FROM company_secrets WHERE company_id = $1 AND name = ANY($2)",
      [companyId, names],
    );
    for (const s of res.rows)
      set.set(s.name, {
        state: "set",
        setAt: s.updated_at.toISOString(),
        setBy: { kind: s.updated_by_kind, id: s.updated_by_id },
      });
  }
  const shared = new Set(sharedEnvNames);
  const stateOf = (name: string): CredentialState =>
    set.get(name) ?? (shared.has(name) ? { state: "shared" } : { state: "missing" });
  return new Map(
    rows.map((r) => [
      r.id,
      Object.fromEntries(Object.entries(r.credentials).map(([role, name]) => [role, stateOf(name)])),
    ]),
  );
}

export async function listProviders(db: Queryable, companyId: string): Promise<ProviderRow[]> {
  const res = await db.query<ProviderRow>(
    "SELECT * FROM model_providers WHERE company_id = $1 ORDER BY created_at, name",
    [companyId],
  );
  return res.rows;
}

export async function loadProvider(db: Queryable, companyId: string, id: string): Promise<ProviderRow> {
  const res = await db.query<ProviderRow>("SELECT * FROM model_providers WHERE id = $1 AND company_id = $2", [
    id,
    companyId,
  ]);
  const row = res.rows[0];
  if (!row) throw notFound("model provider");
  return row;
}

/** How long an endpoint's name may take to resolve before the endpoint is refused. */
const RESOLVE_MS = 10_000;

/** A resolver that gives up after `ms`, so a lookup that never answers fails a write instead of holding it. */
function bounded(resolve: Resolve, ms: number): Resolve {
  return (host) =>
    new Promise((done, fail) => {
      const timer = setTimeout(() => fail(Object.assign(new Error("timed out"), { code: "ETIMEOUT" })), ms);
      resolve(host).then(
        (addresses) => {
          clearTimeout(timer);
          done(addresses);
        },
        (err: unknown) => {
          clearTimeout(timer);
          fail(err);
        },
      );
    });
}

/** Why a company may not add a provider of this kind here, or null: the operator offers it. */
export function kindRefusal(policy: ModelProvidersPolicy, kind: ProviderKind): string | null {
  return policy.kinds.includes(kind)
    ? null
    : `this board's operator does not offer ${PROVIDER_KIND_LABELS[kind]} providers (ROSTERDOCK_MODEL_PROVIDERS)`;
}

/**
 * Why the board will not call this endpoint for the company, or null. It is https, or plain http to a server
 * the operator lists; and every address it has is public, or private where the operator lists it for every
 * company or for this one. A refusal says what kind of address it met, never which.
 */
export async function endpointRefusal(
  egress: Pick<Egress, "resolve" | "allow">,
  endpoint: string,
): Promise<string | null> {
  const url = new URL(endpoint);
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const literal = isAddress(host);
  const resolve = bounded(egress.resolve, RESOLVE_MS);
  if (url.protocol === "http:" && !hostListed(host, egress.allow)) {
    const addresses = literal ? [] : await resolve(host).catch(() => [] as string[]);
    if (!addresses.length || !addresses.every((a) => addressListed(a, egress.allow)))
      return `refused: ${host} is plain http to a server this board's operator does not list; use https, or ask the operator to list it (ROSTERDOCK_PRIVATE_DESTINATIONS)`;
  }
  if (literal) {
    const why = refuseDestination(host, egress.allow);
    return why ? refusedLiteral(host, why) : null;
  }
  try {
    await reachableAddresses(resolve, host, egress.allow);
    return null;
  } catch (err) {
    if (err instanceof RefusedAddress) return err.message;
    throw err;
  }
}

async function assertEndpoint(deps: ProviderDeps, companyId: string, endpoint: string | null | undefined) {
  if (!endpoint) return;
  const refusal = await endpointRefusal(companyEgress(deps.egress, companyId), endpoint);
  if (refusal) throw new HttpError(422, refusal);
}

/** The models as the row keeps them: one Check listed stays listed; any other was typed by a person. */
function keptModels(given: readonly ProviderModelInput[], before: readonly ProviderModel[]): ProviderModel[] {
  const listed = new Set(before.filter((m) => m.source === "listed").map((m) => m.id));
  return given.map((m) => ({ ...m, source: listed.has(m.id) ? "listed" : "typed" }));
}

/** The columns a provider's kind fills; the others stay null. */
function columns(p: ModelProvider) {
  const endpoint = p.kind === "azure_openai" || p.kind === "openai_compatible" ? p.endpoint : null;
  const region = p.kind === "bedrock" ? p.region : null;
  // A compatible server's key goes in the header the person named, authorization unless they said otherwise.
  const authHeader =
    p.kind === "openai_compatible" && p.credentials.apiKey ? (p.authHeader ?? "authorization") : null;
  return { endpoint, region, authHeader, credentials: p.credentials as Record<string, string> };
}

/** What every provider event carries: names and settings, never a value. */
function eventPayload(row: ProviderRow): Record<string, unknown> {
  return {
    name: row.name,
    label: row.label,
    kind: row.kind,
    endpoint: row.endpoint,
    region: row.region,
    credentials: row.credentials,
    models: row.models.length,
    enabled: row.enabled,
  };
}

// The fields a provider body has. A refusal names only these: a field it does not know is "?", and its
// message is the board's, since a key pasted where a field's name goes would otherwise be said back.
const FIELDS = new Set([
  "kind",
  "name",
  "label",
  "models",
  "enabled",
  "credentials",
  "endpoint",
  "region",
  "authHeader",
  "archived",
  "id",
  "family",
  "contextWindow",
  "apiKey",
  "bearerToken",
]);

/** A schema's refusal as the board answers it: the fields' names and the schema's words, never what was sent. */
export function safeIssues(issues: readonly z.core.$ZodIssue[]) {
  return issues.map((i) => ({
    code: i.code,
    path: i.path.map((p) => (typeof p === "number" || (typeof p === "string" && FIELDS.has(p)) ? p : "?")),
    message:
      i.code === "unrecognized_keys" || i.code === "invalid_key"
        ? "a field this kind of provider does not take"
        : i.message,
  }));
}

/** parseBody for a provider: the schema, with a refusal that says nothing back, then the raw-secret guard. */
export function parseProviderBody<T>(schema: ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw new HttpError(400, "invalid request body", safeIssues(parsed.error.issues));
  try {
    assertNoRawSecrets(parsed.data);
  } catch (err) {
    if (err instanceof RawSecretError) throw new HttpError(422, err.message, err.findings);
    throw err;
  }
  return parsed.data;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === "23505";
}

export async function createProvider(
  deps: ProviderDeps,
  companyId: string,
  actor: ActorRef,
  input: ModelProvider,
): Promise<ProviderRow> {
  const refusal = kindRefusal(deps.policy, input.kind);
  if (refusal) throw new HttpError(403, refusal);
  const c = columns(input);
  await assertCompanyEnvNames(deps.operator, companyId, Object.values(c.credentials));
  await assertEndpoint(deps, companyId, c.endpoint);
  try {
    const { result } = await mutate(deps.db, companyId, actor, async (ctx) => {
      const row = (
        await ctx.client.query<ProviderRow>(
          `INSERT INTO model_providers
             (company_id, name, label, kind, endpoint, region, auth_header, credentials, models, enabled,
              created_by_kind, created_by_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING *`,
          [
            companyId,
            input.name,
            input.label,
            input.kind,
            c.endpoint,
            c.region,
            c.authHeader,
            JSON.stringify(c.credentials),
            JSON.stringify(keptModels(input.models, [])),
            input.enabled,
            actor.kind,
            actor.id,
          ],
        )
      ).rows[0]!;
      await ctx.emit("model_provider.created", { kind: "model_provider", id: row.id }, eventPayload(row));
      return row;
    });
    return result;
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict(`this company already has a provider named ${input.name}`);
    throw err;
  }
}

/** The row as the schema's input, with a change applied: what is checked again as a whole. */
function merged(row: ProviderRow, patch: UpdateModelProviderInput): Record<string, unknown> {
  const credentials = patch.credentials ?? row.credentials;
  const out: Record<string, unknown> = {
    kind: row.kind,
    name: row.name,
    label: patch.label ?? row.label,
    models: patch.models ?? row.models.map(({ source: _source, ...m }) => m),
    enabled: patch.enabled ?? row.enabled,
    credentials,
  };
  // A field another kind takes is passed on when given, so the schema refuses it.
  if (patch.endpoint !== undefined || row.endpoint !== null) out.endpoint = patch.endpoint ?? row.endpoint;
  if (patch.region !== undefined || row.region !== null) out.region = patch.region ?? row.region;
  if (patch.authHeader !== undefined) out.authHeader = patch.authHeader;
  // A key taken away takes its header with it.
  else if (row.kind === "openai_compatible") out.authHeader = credentials.apiKey ? row.auth_header : null;
  return out;
}

/** What a change makes of a row: the provider it becomes, its columns and models, and the fields it changes. */
function plan(row: ProviderRow, patch: UpdateModelProviderInput) {
  const parsed = ModelProviderSchema.safeParse(merged(row, patch));
  if (!parsed.success) throw new HttpError(400, "invalid request body", safeIssues(parsed.error.issues));
  const next = parsed.data;
  const c = columns(next);
  const models = keptModels(next.models, row.models);
  const archive = patch.archived === true && !row.archived_at;
  const restore = patch.archived === false && !!row.archived_at;
  const changes = [
    next.label !== row.label && "label",
    c.endpoint !== row.endpoint && "endpoint",
    c.region !== row.region && "region",
    c.authHeader !== row.auth_header && "authHeader",
    !sameJson(c.credentials, row.credentials) && "credentials",
    !sameJson(models, row.models) && "models",
    next.enabled !== row.enabled && "enabled",
    (archive || restore) && "archived",
  ].filter((f): f is string => !!f);
  return { next, c, models, archive, restore, changes };
}

/**
 * Whether two JSON values are the same whatever order their keys are in: Postgres keeps jsonb's keys in its
 * own order (by length, then bytes), never the order the board wrote them in.
 */
function sameJson(a: unknown, b: unknown): boolean {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .filter(([, x]) => x !== undefined)
              .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** A change that changes nothing: nothing is written, no event says otherwise, and the row is answered as it is. */
class Unchanged {
  constructor(readonly row: ProviderRow) {}
}

export async function updateProvider(
  deps: ProviderDeps,
  companyId: string,
  actor: ActorRef,
  id: string,
  patch: UpdateModelProviderInput,
): Promise<ProviderRow> {
  // What the change brings in is checked before the row is held: the names it adds, and the endpoint it moves
  // to (a lookup, never inside the transaction).
  const before = await loadProvider(deps.db, companyId, id);
  const first = plan(before, patch);
  const had = new Set(Object.values(before.credentials));
  await assertCompanyEnvNames(
    deps.operator,
    companyId,
    Object.values(first.c.credentials).filter((n) => !had.has(n)),
  );
  if (first.c.endpoint !== before.endpoint) await assertEndpoint(deps, companyId, first.c.endpoint);
  try {
    const { result } = await mutate(deps.db, companyId, actor, async (ctx) => {
      // The row as it is now, held until commit: a change made meanwhile is built on, never undone. A field
      // this change does not name keeps the row's value, which its own change checked.
      const row = (
        await ctx.client.query<ProviderRow>(
          "SELECT * FROM model_providers WHERE id = $1 AND company_id = $2 FOR UPDATE",
          [id, companyId],
        )
      ).rows[0];
      if (!row) throw notFound("model provider");
      const { next, c, models, archive, restore, changes } = plan(row, patch);
      if (!changes.length) throw new Unchanged(row);
      const updated = (
        await ctx.client.query<ProviderRow>(
          `UPDATE model_providers
              SET label = $3, endpoint = $4, region = $5, auth_header = $6, credentials = $7, models = $8,
                  enabled = $9,
                  archived_at = CASE WHEN $10 THEN now() WHEN $11 THEN NULL ELSE archived_at END,
                  updated_at = now()
            WHERE id = $1 AND company_id = $2
            RETURNING *`,
          [
            id,
            companyId,
            next.label,
            c.endpoint,
            c.region,
            c.authHeader,
            JSON.stringify(c.credentials),
            JSON.stringify(models),
            next.enabled,
            archive,
            restore,
          ],
        )
      ).rows[0]!;
      await ctx.emit(
        archive ? "model_provider.archived" : "model_provider.updated",
        { kind: "model_provider", id },
        { ...eventPayload(updated), changes, archived: !!updated.archived_at },
      );
      return updated;
    });
    return result;
  } catch (err) {
    if (err instanceof Unchanged) return err.row;
    throw err;
  }
}

export async function deleteProvider(db: Db, companyId: string, actor: ActorRef, id: string): Promise<void> {
  await mutate(db, companyId, actor, async (ctx) => {
    const gone = (
      await ctx.client.query<ProviderRow>(
        "DELETE FROM model_providers WHERE id = $1 AND company_id = $2 RETURNING *",
        [id, companyId],
      )
    ).rows[0];
    if (!gone) throw notFound("model provider");
    await ctx.emit(
      "model_provider.deleted",
      { kind: "model_provider", id },
      { name: gone.name, label: gone.label, kind: gone.kind },
    );
  });
}
