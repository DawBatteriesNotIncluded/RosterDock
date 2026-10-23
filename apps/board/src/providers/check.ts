// Check: whether a company's model provider takes its key, and which models the key reaches. One call that
// lists models, per kind, which spends no tokens: Anthropic's and OpenAI's /v1/models, an Azure resource's
// /openai/v1/models, Bedrock's system inference profiles and on-demand foundation models in the region, a
// compatible server's /models. The board makes it, with the key resolved for the company (its secrets, then
// the names the operator shares) and sent only in the header its kind takes, through the address guard: the
// host is checked again at the call, a redirect is refused, the answer is capped. A refusal is said in the
// board's words: what a provider answers to a refused key (OpenAI's names part of the key) is never kept,
// logged or shown. The models the key reaches are kept on the row for a person to add from; Check itself
// adds no model to the provider's list and takes none off.

import Anthropic from "@anthropic-ai/sdk";
import {
  labelLooksLikeKey,
  listedFamily,
  MAX_PROVIDER_LABEL,
  type ActorRef,
  type CompatibleAuthHeader,
  type ListedModel,
  type ProviderKind,
} from "@rosterdock/shared";
import { conflict, HttpError, notFound } from "../http-error.js";
import { mutate } from "../mutate.js";
import { companyEnv, notSetForCompany, sharedEnv } from "../secrets/company.js";
import { companyEgress, egressFetch, readBudget, type Egress } from "../web/egress.js";
import { companyAnthropic } from "./anthropic.js";
import {
  keptModels,
  kindRefusal,
  loadProvider,
  type ProviderCheck,
  type ProviderDeps,
  type ProviderRow,
} from "./providers.js";

/** How long a provider has to list its models. */
const LIST_TIMEOUT_MS = 15_000;
/** The most of one answer that is read: a long list of models is tens of kilobytes. */
const LIST_MAX_BYTES = 4 * 1024 * 1024;
/** What one check may read in all, and how many requests it may make (Bedrock pages its profiles). */
const CHECK_BUDGET_BYTES = 8 * 1024 * 1024;
const CHECK_REQUESTS = 8;
/** Bedrock's pages of inference profiles read at most. */
const BEDROCK_PAGES = 5;
/** The most models one check keeps for a person to add from; how many the key reaches is counted in full. */
export const MAX_LISTED = 500;

/** Where and how a provider's models are listed. */
export type ListTarget = Pick<ProviderRow, "kind" | "endpoint" | "region" | "auth_header">;

/** The models a key reaches. */
export interface Listing {
  /** At most MAX_LISTED, each one a person can add as it is. */
  models: ListedModel[];
  /** How many the key reaches. */
  total: number;
}

/** Why a list did not come back, already in the board's words. */
export class NotListed extends Error {}

const NOT_A_LIST = "the provider answered, but not with a list of models";

/** What an HTTP status from a provider's list means, in the board's words: never what the provider said. */
export function statusWords(kind: ProviderKind, status: number): string {
  switch (status) {
    case 401:
      return "the key was refused (HTTP 401): it is wrong, revoked or expired";
    case 403:
      return kind === "bedrock"
        ? "the key was refused (HTTP 403): it is wrong or expired, or may not list Bedrock's models in this region"
        : "the key may not list models here (HTTP 403): the account, or its network rules, do not allow it";
    case 404:
      return "nothing at this address lists models (HTTP 404): check the address";
    case 429:
      return "the provider is limiting requests (HTTP 429): try again in a minute";
  }
  return status >= 500
    ? `the provider could not answer (HTTP ${status}): try again later`
    : `the provider answered HTTP ${status}, not a list of models`;
}

/** The header a key goes in, as its kind (or a compatible server's setting) says. */
function keyHeader(
  kind: ProviderKind,
  header: CompatibleAuthHeader | null,
  key: string,
): Record<string, string> {
  if (kind === "azure_openai") return { "api-key": key };
  if (kind === "openai_compatible" && header && header !== "authorization") return { [header]: key };
  return { authorization: `Bearer ${key}` };
}

/** A GET whose answer is JSON: a status that is not 2xx, or a body that is not JSON, is said in the board's words. */
async function getJson(
  kind: ProviderKind,
  fetch: typeof globalThis.fetch,
  url: string,
  headers: Record<string, string>,
): Promise<unknown> {
  const res = await fetch(url, { method: "GET", headers: { accept: "application/json", ...headers } });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new NotListed(statusWords(kind, res.status));
  }
  // A cap or the deadline ends the read in the board's own words; a body that does not parse is not said
  // back, since a parse error quotes it.
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new NotListed(NOT_A_LIST);
  }
}

/** Whether an id is one a person can add as it is: what a provider's model id may be (providers.ts). */
function addable(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 120 && !/\s/.test(id);
}

/** The models found, once each, with the board's guess at whose they are, and a label only when it reads as one. */
function listing(
  kind: ProviderKind,
  found: { id: string; label?: unknown; contextWindow?: unknown }[],
): Listing {
  const seen = new Set<string>();
  const models: ListedModel[] = [];
  for (const m of found) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    if (models.length >= MAX_LISTED) continue;
    const label = typeof m.label === "string" ? m.label.trim() : "";
    const window = m.contextWindow;
    models.push({
      id: m.id,
      family: listedFamily(kind, m.id),
      ...(label && label.length <= MAX_PROVIDER_LABEL && !labelLooksLikeKey(label) ? { label } : {}),
      ...(typeof window === "number" && Number.isInteger(window) && window > 0 && window <= 100_000_000
        ? { contextWindow: window }
        : {}),
    });
  }
  return { models, total: seen.size };
}

/** OpenAI's list, which Azure and compatible servers answer too: `{ data: [{ id }] }`. */
function openAiList(kind: ProviderKind, body: unknown): Listing {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new NotListed(NOT_A_LIST);
  return listing(
    kind,
    data.map((m) => (m as { id?: unknown } | null)?.id).flatMap((id) => (addable(id) ? [{ id }] : [])),
  );
}

async function listAnthropic(key: string, fetch: typeof globalThis.fetch): Promise<Listing> {
  const client = companyAnthropic({ apiKey: key, fetch, timeoutMs: LIST_TIMEOUT_MS + 5_000 });
  const found: { id: string; label?: unknown; contextWindow?: unknown }[] = [];
  for await (const m of client.models.list({ limit: 1000 })) {
    // A retired model stays in Anthropic's catalogue as its record, but nothing runs on it.
    if (m.lifecycle === "retired" || !addable(m.id)) continue;
    found.push({ id: m.id, label: m.display_name, contextWindow: m.max_input_tokens });
    if (found.length >= 4 * MAX_LISTED) break;
  }
  return listing("anthropic", found);
}

interface BedrockProfiles {
  inferenceProfileSummaries?: {
    inferenceProfileId?: unknown;
    inferenceProfileName?: unknown;
    status?: unknown;
  }[];
  nextToken?: unknown;
}
interface BedrockModels {
  modelSummaries?: { modelId?: unknown; modelName?: unknown; outputModalities?: unknown }[];
}

/**
 * Bedrock in the region: its system inference profiles (us.anthropic.…, global.openai.…), which most models
 * are reached through, then the foundation models it runs on demand by their own ids, those that answer in text.
 */
async function listBedrock(region: string, key: string, fetch: typeof globalThis.fetch): Promise<Listing> {
  const base = `https://bedrock.${region}.amazonaws.com`;
  const auth = { authorization: `Bearer ${key}` };
  const found: { id: string; label?: unknown }[] = [];
  let next: string | null = null;
  for (let page = 0; page < BEDROCK_PAGES; page++) {
    const query = new URLSearchParams({ maxResults: "1000", typeEquals: "SYSTEM_DEFINED" });
    if (next) query.set("nextToken", next);
    const body = (await getJson(
      "bedrock",
      fetch,
      `${base}/inference-profiles?${query}`,
      auth,
    )) as BedrockProfiles;
    if (!Array.isArray(body?.inferenceProfileSummaries)) throw new NotListed(NOT_A_LIST);
    for (const p of body.inferenceProfileSummaries)
      if (addable(p?.inferenceProfileId) && (p.status === undefined || p.status === "ACTIVE"))
        found.push({ id: p.inferenceProfileId, label: p.inferenceProfileName });
    next = typeof body.nextToken === "string" && body.nextToken ? body.nextToken : null;
    if (!next) break;
  }
  const models = (await getJson(
    "bedrock",
    fetch,
    `${base}/foundation-models?byInferenceType=ON_DEMAND`,
    auth,
  )) as BedrockModels;
  if (!Array.isArray(models?.modelSummaries)) throw new NotListed(NOT_A_LIST);
  for (const m of models.modelSummaries)
    if (addable(m?.modelId) && Array.isArray(m.outputModalities) && m.outputModalities.includes("TEXT"))
      found.push({ id: m.modelId, label: m.modelName });
  return listing("bedrock", found);
}

/**
 * The models this key reaches on this provider, through `fetch` (the company's egress in the board; the
 * recorder's transport when the answers are recorded). The key goes only in the header its kind takes.
 */
export async function listModels(
  target: ListTarget,
  key: string | null,
  fetch: typeof globalThis.fetch,
): Promise<Listing> {
  const kind = target.kind;
  const auth = key ? keyHeader(kind, target.auth_header, key) : {};
  switch (kind) {
    case "anthropic":
      if (!key) throw new NotListed("an Anthropic provider needs a key");
      return listAnthropic(key, fetch);
    case "openai":
      return openAiList(kind, await getJson(kind, fetch, "https://api.openai.com/v1/models", auth));
    case "azure_openai":
      return openAiList(kind, await getJson(kind, fetch, `${target.endpoint}/openai/v1/models`, auth));
    case "bedrock":
      if (!key) throw new NotListed("a Bedrock provider needs its API key");
      return listBedrock(target.region!, key, fetch);
    case "openai_compatible":
      return openAiList(kind, await getJson(kind, fetch, `${target.endpoint}/models`, auth));
  }
}

/** The value of the provider's key for the company, or null for a compatible server that takes none. */
async function providerKey(deps: ProviderDeps, companyId: string, row: ProviderRow): Promise<string | null> {
  const name = row.credentials.apiKey ?? row.credentials.bearerToken ?? null;
  if (!name) return null;
  const shared = sharedEnv(deps.operator.boardEnv, deps.operator.sharedEnvNames);
  const value = (await companyEnv(shared, deps.operator.store, companyId))[name];
  if (!value) throw new NotListed(notSetForCompany(name));
  return value;
}

/** What a check that did not work says: the board's words, never a provider's body. */
function checkWords(err: unknown): string {
  if (err instanceof NotListed) return err.message;
  // An answer that does not parse: a parse error quotes the answer.
  if (err instanceof SyntaxError) return NOT_A_LIST;
  // The SDK's error for a status carries the provider's body in its message: only the status is read.
  if (err instanceof Anthropic.APIError && typeof err.status === "number")
    return statusWords("anthropic", err.status);
  // A call that got no answer (the address guard, the deadline, the cap, the connection): the SDK wraps
  // the transport's own error, whose words are the board's.
  const inner = err instanceof Anthropic.APIConnectionError && err.cause instanceof Error ? err.cause : err;
  const message = inner instanceof Error ? inner.message : "";
  return (message || "no answer").slice(0, 300);
}

/** The fetch a check sends with: the company's egress, no redirect followed, the answer capped. */
function checkFetch(egress: Egress, companyId: string): typeof globalThis.fetch {
  return egressFetch(companyEgress(egress, companyId), {
    redirect: "error",
    timeoutMs: LIST_TIMEOUT_MS,
    maxBytes: LIST_MAX_BYTES,
    budget: readBudget(CHECK_BUDGET_BYTES, CHECK_REQUESTS),
  });
}

/**
 * Check a provider: list the models its key reaches and keep the outcome on the row, with an event. A
 * provider archived, or of a kind the operator no longer offers, is not called.
 */
export async function checkProvider(
  deps: ProviderDeps,
  companyId: string,
  actor: ActorRef,
  id: string,
): Promise<ProviderRow> {
  const row = await loadProvider(deps.db, companyId, id);
  if (row.archived_at) throw conflict(`${row.label} is archived: bring it back to check it`);
  const refusal = kindRefusal(deps.policy, row.kind);
  if (refusal) throw new HttpError(403, refusal);
  const started = Date.now();
  let check: ProviderCheck;
  try {
    const key = await providerKey(deps, companyId, row);
    const { models, total } = await listModels(row, key, checkFetch(deps.egress, companyId));
    check = { ok: true, at: "", latencyMs: 0, detail: null, listed: total, models };
  } catch (err) {
    check = { ok: false, at: "", latencyMs: 0, detail: checkWords(err), listed: 0 };
  }
  check.at = new Date().toISOString();
  check.latencyMs = Date.now() - started;
  const { result } = await mutate(deps.db, companyId, actor, async (ctx) => {
    // The row as it is now: a model added or taken off meanwhile is kept as it is, marked against this check.
    const current = (
      await ctx.client.query<ProviderRow>(
        "SELECT * FROM model_providers WHERE id = $1 AND company_id = $2 FOR UPDATE",
        [id, companyId],
      )
    ).rows[0];
    if (!current) throw notFound("model provider");
    const models = check.ok ? keptModels(current.models, current.models, check) : current.models;
    const updated = (
      await ctx.client.query<ProviderRow>(
        "UPDATE model_providers SET last_check = $3, models = $4 WHERE id = $1 AND company_id = $2 RETURNING *",
        [id, companyId, JSON.stringify(check), JSON.stringify(models)],
      )
    ).rows[0]!;
    await ctx.emit(
      "model_provider.checked",
      { kind: "model_provider", id },
      {
        name: updated.name,
        label: updated.label,
        kind: updated.kind,
        ok: check.ok,
        latencyMs: check.latencyMs,
        detail: check.detail,
        listed: check.listed,
      },
    );
    return updated;
  });
  return result;
}
