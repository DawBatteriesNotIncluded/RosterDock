// A company's price table, as every cost reads it: a run's, a manager's call's, Costs, the monthly report
// and the CSVs. A price belongs to a provider and a model, or to the board's own models (no provider). What a
// run or a call through a provider costs is, in order: that provider's price for the model; the company's
// price for the model on the board's own models (so a company that moves to its own Anthropic key keeps its
// prices); for a company Anthropic provider, which bills per token at Anthropic's prices, the list price, when
// the company keeps its prices in the list's currency; else no price yet, never zero. A company keeps one
// currency. Seat prices are the board's own models' alone.

import type { ProviderKind } from "@rosterdock/shared";
import type { Queryable } from "../db/pool.js";
import type { ModelPrice } from "./cost.js";
import { listPriceFor } from "./list-prices.js";

/** What a run or a call went through: a company provider's id, or null for the board's own models. */
export type ProviderId = string | null;

/** What a person calls a usage line's provider. */
export const BOARD_OWN_MODELS = "This board's own models";

export interface PriceRow {
  id: string;
  model: string;
  provider_id: string | null;
  currency: string;
  input_per_million: string | number | null;
  output_per_million: string | number | null;
  cache_read_per_million: string | number | null;
  cache_write_per_million: string | number | null;
  seat_price_month: string | number | null;
  estimate: boolean;
  updated_at: Date;
}

export interface ProviderInfo {
  id: string;
  name: string;
  label: string;
  kind: ProviderKind;
}

export interface PriceTable {
  /** The company's one currency: its prices'; null before it has any. */
  currency: string | null;
  /**
   * The currency a report shows its money in: the company's; before it has a price, USD when Anthropic's list
   * priced something (asked after pricing), else GBP, the board's default for a first price.
   */
  displayCurrency(): string;
  /** What a run or a call on this provider and model costs per token, or null: no price yet. */
  priceOf(providerId: ProviderId, model: string): ModelPrice | null;
  /** The board's own models' seat price for a teammate on this model or engine, the key it was found by. */
  seatFor(model: string, engine: string): { key: string; month: number } | null;
  /** The company's providers, removed ones absent. */
  providers: Map<string, ProviderInfo>;
  /** What a person calls a usage line's provider. */
  providerLabel(providerId: ProviderId): string;
  rows: number;
}

const num = (v: string | number | null): number | null => (v === null ? null : Number(v));

export function toPrice(r: PriceRow): ModelPrice {
  return {
    model: r.model,
    currency: r.currency,
    inputPerMillion: num(r.input_per_million),
    outputPerMillion: num(r.output_per_million),
    cacheReadPerMillion: num(r.cache_read_per_million),
    cacheWritePerMillion: num(r.cache_write_per_million),
    seatPriceMonth: num(r.seat_price_month),
  };
}

/**
 * A provider's price when there is none of its own: the board's own price for the model, then, for a company
 * Anthropic provider, Anthropic's list price, if the company's prices are in its currency or it has none yet
 * (its first then sets the list's).
 */
export function fallbackPrice(
  kind: ProviderKind | null,
  model: string,
  own: ModelPrice | null,
  currency: string | null,
): ModelPrice | null {
  // A seat on the board's own models says nothing of what a provider's tokens cost: a provider bills per token.
  if (own && perToken(own)) return own;
  if (kind !== "anthropic") return null;
  const list = listPriceFor(model);
  return list && (currency === null || list.currency === currency) ? { ...list, seatPriceMonth: null } : null;
}

/** Whether a price says what tokens cost: a seat alone does not. */
export function perToken(p: ModelPrice): boolean {
  return [p.inputPerMillion, p.outputPerMillion, p.cacheReadPerMillion, p.cacheWritePerMillion].some(
    (v) => v !== null,
  );
}

/** The company's one currency: its prices'; null before it has any. */
export async function companyCurrency(db: Queryable, companyId: string): Promise<string | null> {
  const res = await db.query<{ currency: string }>(
    "SELECT currency FROM model_prices WHERE company_id = $1 ORDER BY model LIMIT 1",
    [companyId],
  );
  return res.rows[0]?.currency ?? null;
}

export async function priceTable(db: Queryable, companyId: string): Promise<PriceTable> {
  const rows = (
    await db.query<PriceRow>("SELECT * FROM model_prices WHERE company_id = $1 ORDER BY model", [companyId])
  ).rows;
  const providers = new Map(
    (
      await db.query<ProviderInfo>(
        "SELECT id, name, label, kind FROM model_providers WHERE company_id = $1",
        [companyId],
      )
    ).rows.map((p) => [p.id, p]),
  );
  // A removed provider's usage stays, under the label its removal recorded.
  const removed = new Map(
    (
      await db.query<{ id: string; label: string | null }>(
        `SELECT DISTINCT ON (subject_id) subject_id AS id, COALESCE(payload->>'label', payload->>'name') AS label
           FROM events
          WHERE company_id = $1 AND subject_kind = 'model_provider' AND type = 'model_provider.deleted'
          ORDER BY subject_id, seq DESC`,
        [companyId],
      )
    ).rows.map((r) => [r.id, r.label]),
  );
  const key = (providerId: ProviderId, model: string) => `${providerId ?? ""}\u0000${model}`;
  const byKey = new Map(rows.map((r) => [key(r.provider_id, r.model), r]));
  const own = (model: string) => {
    const r = byKey.get(key(null, model));
    return r ? toPrice(r) : null;
  };
  const currency = rows[0]?.currency ?? null;
  let usedList = false;
  return {
    currency,
    displayCurrency: () => currency ?? (usedList ? "USD" : "GBP"),
    priceOf(providerId, model) {
      if (providerId === null) return own(model);
      const r = byKey.get(key(providerId, model));
      // A provider's row that says nothing per token prices nothing: the fallbacks do.
      if (r && perToken(toPrice(r))) return toPrice(r);
      const price = fallbackPrice(providers.get(providerId)?.kind ?? null, model, own(model), currency);
      if (price && currency === null) usedList = true;
      return price;
    },
    seatFor(model, engine) {
      for (const k of [model, engine]) {
        const r = byKey.get(key(null, k));
        if (r && r.seat_price_month !== null) return { key: r.model, month: Number(r.seat_price_month) };
      }
      return null;
    },
    providers,
    providerLabel(providerId) {
      if (providerId === null) return BOARD_OWN_MODELS;
      // Each removed provider keeps a line of its own, by id.
      const label = providers.get(providerId)?.label;
      if (label) return label;
      const was = removed.get(providerId);
      return was ? `${was} (removed)` : "A removed provider";
    },
    rows: rows.length,
  };
}

/** One run's or call's price: the same order as the table's, read for one provider and model. */
export async function priceFor(
  db: Queryable,
  companyId: string,
  providerId: ProviderId,
  model: string,
): Promise<ModelPrice | null> {
  const row = (
    await db.query<PriceRow>(
      "SELECT * FROM model_prices WHERE company_id = $1 AND provider_id IS NOT DISTINCT FROM $2::uuid AND model = $3",
      [companyId, providerId, model],
    )
  ).rows[0];
  if (row && (providerId === null || perToken(toPrice(row)))) return toPrice(row);
  if (providerId === null) return null;
  const kind = (
    await db.query<{ kind: ProviderKind }>(
      "SELECT kind FROM model_providers WHERE id = $1 AND company_id = $2",
      [providerId, companyId],
    )
  ).rows[0]?.kind;
  const own = await priceFor(db, companyId, null, model);
  return fallbackPrice(kind ?? null, model, own, await companyCurrency(db, companyId));
}

/**
 * The Anthropic API id a Bedrock Claude model's list price is looked up by: its cross-Region prefix,
 * `anthropic.`, a version suffix (`-v1:0`) and a date (`-20250929`) dropped. Only an estimate: AWS sets its own
 * prices.
 */
export function bedrockListModel(id: string): string {
  return id
    .replace(/^(?:[a-z-]+\.)?anthropic\./, "")
    .replace(/-v\d+(?::\d+)?$/, "")
    .replace(/-\d{8}$/, "");
}
