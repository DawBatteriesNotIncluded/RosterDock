// Behavioural drift: a teammate whose runs suddenly cost more, take longer, or
// get sent back more often than their own baseline. The baseline is the
// teammate's own recent history (median and spread of their finished task
// runs; their reviews' decisions), so a heavy model is not "drift" and a cheap
// one that triples is. A departure is one event, teammate.drift, recorded by
// Peter as the observer; the notifier pushes it, Activity says it in a
// sentence, and the teammate's page carries the line while it stands. Never a
// gate: nothing stops, a person decides what to make of it.

import type { EventRecord } from "@rosterdock/shared";
import type { Db, Queryable } from "../db/pool.js";
import type { EventBus } from "../events/bus.js";
import { mutate } from "../mutate.js";
import { companyManager } from "../peter/seat.js";

export type DriftMetric = "cost" | "duration" | "rejection";

/** Enough history to call something a departure. */
export const MIN_BASELINE_RUNS = 5;
export const MIN_BASELINE_DECISIONS = 5;
/** How many finished runs the baseline looks back over. */
export const BASELINE_RUNS = 30;
/** Decisions in the recent window, and the minimum in it before a rate means anything. */
export const RECENT_DECISIONS = 10;
export const MIN_RECENT_DECISIONS = 5;
/** The latest sample must be at least this many times the median, and beyond this many MADs. */
export const RATIO_FLOOR = 1.5;
export const MAD_FACTOR = 3;

/** What counts as a departure. The defaults; a company narrows or widens them in Settings (`settings.drift`). */
export interface DriftThresholds {
  ratioFloor: number;
  madFactor: number;
  rejectionRateFloor: number;
  rejectionRateDelta: number;
}
export const DEFAULT_THRESHOLDS: DriftThresholds = {
  ratioFloor: RATIO_FLOOR,
  madFactor: MAD_FACTOR,
  rejectionRateFloor: 0.5,
  rejectionRateDelta: 0.3,
};
const BOUNDS: Record<keyof DriftThresholds, [number, number]> = {
  ratioFloor: [1, 20],
  madFactor: [0, 20],
  rejectionRateFloor: [0, 1],
  rejectionRateDelta: [0, 1],
};

/** The company's drift thresholds from its settings, each within bounds, else the default. */
export function driftThresholds(settings: Record<string, unknown> | null | undefined): DriftThresholds {
  const d = (settings?.drift ?? {}) as Record<string, unknown>;
  const out = { ...DEFAULT_THRESHOLDS };
  for (const key of Object.keys(BOUNDS) as (keyof DriftThresholds)[]) {
    const v = d[key];
    const [lo, hi] = BOUNDS[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi) out[key] = v;
  }
  return out;
}
/** The recent rejection rate must be at least this, and this much above the baseline rate. */
export const REJECTION_RATE_FLOOR = DEFAULT_THRESHOLDS.rejectionRateFloor;
export const REJECTION_RATE_DELTA = DEFAULT_THRESHOLDS.rejectionRateDelta;
/** One alert per teammate and metric in this window. */
export const REPEAT_AFTER_MS = 24 * 3600_000;

export interface DriftFinding {
  metric: DriftMetric;
  /** The latest value (tokens, ms, or a rate 0..1). */
  value: number;
  /** The baseline it departed from (the median, or the earlier rate). */
  baseline: number;
  ratio: number;
  samples: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * A departure of the latest sample from its predecessors: beyond three median
 * absolute deviations and at least 1.5 times the median. Pure.
 */
export function detectOutlier(
  metric: "cost" | "duration",
  previous: number[],
  latest: number,
  t: DriftThresholds = DEFAULT_THRESHOLDS,
): DriftFinding | null {
  if (previous.length < MIN_BASELINE_RUNS) return null;
  const med = median(previous);
  if (med <= 0) return null;
  const mad = median(previous.map((x) => Math.abs(x - med)));
  const spread = Math.max(mad * t.madFactor, med * (t.ratioFloor - 1));
  if (latest <= med + spread) return null;
  return { metric, value: latest, baseline: med, ratio: latest / med, samples: previous.length };
}

/**
 * Rejections: the rate over the most recent decisions on the teammate's work
 * against the rate over the ones before. Decisions newest first. Pure.
 */
export function detectRejectionDrift(
  decisionsNewestFirst: boolean[],
  t: DriftThresholds = DEFAULT_THRESHOLDS,
): DriftFinding | null {
  const recent = decisionsNewestFirst.slice(0, RECENT_DECISIONS);
  const earlier = decisionsNewestFirst.slice(RECENT_DECISIONS);
  if (recent.length < MIN_RECENT_DECISIONS || earlier.length < MIN_BASELINE_DECISIONS) return null;
  const rate = (xs: boolean[]) => xs.filter(Boolean).length / xs.length;
  const now = rate(recent);
  const before = rate(earlier);
  if (now < t.rejectionRateFloor || now < before + t.rejectionRateDelta) return null;
  return {
    metric: "rejection",
    value: now,
    baseline: before,
    ratio: before > 0 ? now / before : Infinity,
    samples: earlier.length,
  };
}

export interface TeammateBaseline {
  teammateId: string;
  runs: number;
  cost: { median: number | null; latest: number | null; ratio: number | null };
  duration: { median: number | null; latest: number | null; ratio: number | null };
  rejection: { recentRate: number | null; baselineRate: number | null; decisions: number };
  /** The standing departures, newest first, within the repeat window. */
  drift: { metric: DriftMetric; value: number; baseline: number; ratio: number; at: string }[];
}

interface RunSample {
  id: string;
  tokens: number;
  duration_ms: number | null;
}

async function recentRuns(db: Queryable, teammateId: string, limit: number): Promise<RunSample[]> {
  const res = await db.query<{
    id: string;
    usage: Record<string, number> | null;
    duration_ms: number | null;
  }>(
    `SELECT id, usage, duration_ms FROM runs
     WHERE teammate_id = $1 AND kind = 'task' AND status IN ('completed', 'failed')
     ORDER BY finished_at DESC NULLS LAST, created_at DESC LIMIT $2`,
    [teammateId, limit],
  );
  return res.rows.map((r) => {
    const u = r.usage ?? {};
    return {
      id: r.id,
      tokens:
        (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0),
      duration_ms: r.duration_ms,
    };
  });
}

/** Decisions on reviews the teammate authored, newest first: true when the work was sent back. */
async function recentDecisions(db: Queryable, teammateId: string, limit: number): Promise<boolean[]> {
  const res = await db.query<{ decision: string }>(
    `SELECT d.decision FROM review_decisions d JOIN reviews r ON r.id = d.review_id
     WHERE r.author_kind = 'teammate' AND r.author_id = $1
     ORDER BY d.created_at DESC LIMIT $2`,
    [teammateId, limit],
  );
  return res.rows.map((r) => r.decision !== "approve");
}

async function standingDrift(db: Queryable, companyId: string, teammateId: string) {
  const res = await db.query<{ payload: Record<string, unknown>; created_at: Date }>(
    `SELECT payload, created_at FROM events
     WHERE company_id = $1 AND type = 'teammate.drift' AND subject_kind = 'teammate' AND subject_id = $2
       AND created_at > now() - ($3 || ' milliseconds')::interval
     ORDER BY seq DESC`,
    [companyId, teammateId, String(REPEAT_AFTER_MS)],
  );
  return res.rows.map((r) => ({
    metric: r.payload.metric as DriftMetric,
    value: Number(r.payload.value),
    baseline: Number(r.payload.baseline),
    ratio: Number(r.payload.ratio),
    at: r.created_at.toISOString(),
  }));
}

export async function teammateBaseline(
  db: Queryable,
  companyId: string,
  teammateId: string,
): Promise<TeammateBaseline> {
  const runs = await recentRuns(db, teammateId, BASELINE_RUNS + 1);
  const [latest, ...previous] = runs;
  const costs = previous.map((r) => r.tokens);
  const durations = previous.map((r) => r.duration_ms).filter((d): d is number => d !== null);
  const costMedian = costs.length ? median(costs) : null;
  const durationMedian = durations.length ? median(durations) : null;
  const decisions = await recentDecisions(db, teammateId, RECENT_DECISIONS * 4);
  const recent = decisions.slice(0, RECENT_DECISIONS);
  const earlier = decisions.slice(RECENT_DECISIONS);
  const rate = (xs: boolean[]) => (xs.length ? xs.filter(Boolean).length / xs.length : null);
  return {
    teammateId,
    runs: runs.length,
    cost: {
      median: costMedian,
      latest: latest?.tokens ?? null,
      ratio: latest && costMedian ? latest.tokens / costMedian : null,
    },
    duration: {
      median: durationMedian,
      latest: latest?.duration_ms ?? null,
      ratio: latest?.duration_ms && durationMedian ? latest.duration_ms / durationMedian : null,
    },
    rejection: { recentRate: rate(recent), baselineRate: rate(earlier), decisions: decisions.length },
    drift: await standingDrift(db, companyId, teammateId),
  };
}

export interface DriftDeps {
  db: Db;
  log: { warn(m: string): void };
}

/** Record a departure once per teammate, metric and window. Returns what was recorded. */
async function record(
  deps: DriftDeps,
  companyId: string,
  teammateId: string,
  finding: DriftFinding,
  context: Record<string, unknown>,
): Promise<boolean> {
  const standing = await standingDrift(deps.db, companyId, teammateId);
  if (standing.some((d) => d.metric === finding.metric)) return false;
  const mate = (
    await deps.db.query<{ name: string }>("SELECT name FROM teammates WHERE id = $1 AND company_id = $2", [
      teammateId,
      companyId,
    ])
  ).rows[0];
  if (!mate) return false;
  const manager = await companyManager(deps.db, companyId);
  const actor = manager
    ? { kind: "teammate" as const, id: manager.id }
    : { kind: "teammate" as const, id: teammateId };
  await mutate(deps.db, companyId, actor, async (ctx) => {
    await ctx.emit(
      "teammate.drift",
      { kind: "teammate", id: teammateId },
      {
        teammateName: mate.name,
        managerName: manager?.name ?? null,
        metric: finding.metric,
        value: Math.round(finding.value * 1000) / 1000,
        baseline: Math.round(finding.baseline * 1000) / 1000,
        ratio: Math.round(finding.ratio * 100) / 100,
        samples: finding.samples,
        ...context,
      },
    );
  });
  return true;
}

/** After a task run ends: is its cost or duration a departure from the teammate's baseline? */
async function companyThresholds(db: Queryable, companyId: string): Promise<DriftThresholds> {
  const row = (
    await db.query<{ settings: Record<string, unknown> | null }>(
      "SELECT settings FROM companies WHERE id = $1",
      [companyId],
    )
  ).rows[0];
  return driftThresholds(row?.settings);
}

export async function checkRunDrift(
  deps: DriftDeps,
  companyId: string,
  runId: string,
): Promise<DriftFinding[]> {
  const run = (
    await deps.db.query<{ teammate_id: string; task_id: string; kind: string }>(
      "SELECT teammate_id, task_id, kind FROM runs WHERE id = $1 AND company_id = $2",
      [runId, companyId],
    )
  ).rows[0];
  if (!run || run.kind !== "task") return [];
  const runs = await recentRuns(deps.db, run.teammate_id, BASELINE_RUNS + 1);
  const latest = runs.find((r) => r.id === runId);
  if (!latest) return [];
  const previous = runs.filter((r) => r.id !== runId);
  const task = (
    await deps.db.query<{ number: number; title: string }>("SELECT number, title FROM tasks WHERE id = $1", [
      run.task_id,
    ])
  ).rows[0];
  const context = { runId, taskId: run.task_id, number: task?.number ?? null, title: task?.title ?? null };
  const t = await companyThresholds(deps.db, companyId);
  const found: DriftFinding[] = [];
  const cost = detectOutlier(
    "cost",
    previous.map((r) => r.tokens),
    latest.tokens,
    t,
  );
  if (cost && (await record(deps, companyId, run.teammate_id, cost, context))) found.push(cost);
  if (latest.duration_ms !== null) {
    const duration = detectOutlier(
      "duration",
      previous.map((r) => r.duration_ms).filter((d): d is number => d !== null),
      latest.duration_ms,
      t,
    );
    if (duration && (await record(deps, companyId, run.teammate_id, duration, context))) found.push(duration);
  }
  return found;
}

/** After a review decision: is the author's work being sent back more than it used to be? */
export async function checkRejectionDrift(
  deps: DriftDeps,
  companyId: string,
  reviewId: string,
): Promise<DriftFinding | null> {
  const review = (
    await deps.db.query<{ author_kind: string; author_id: string; task_id: string }>(
      "SELECT author_kind, author_id, task_id FROM reviews WHERE id = $1 AND company_id = $2",
      [reviewId, companyId],
    )
  ).rows[0];
  if (!review || review.author_kind !== "teammate") return null;
  const decisions = await recentDecisions(deps.db, review.author_id, RECENT_DECISIONS * 4);
  const finding = detectRejectionDrift(decisions, await companyThresholds(deps.db, companyId));
  if (!finding) return null;
  const task = (
    await deps.db.query<{ number: number; title: string }>("SELECT number, title FROM tasks WHERE id = $1", [
      review.task_id,
    ])
  ).rows[0];
  const recorded = await record(deps, companyId, review.author_id, finding, {
    reviewId,
    taskId: review.task_id,
    number: task?.number ?? null,
    title: task?.title ?? null,
  });
  return recorded ? finding : null;
}

const RUN_DONE = new Set(["run.completed", "run.failed"]);
const SENT_BACK = new Set(["review.changes_requested", "review.vetoed"]);

/** A bus subscriber: every finished run and every rejection is checked once, on the replica that sees it first. */
export function startDriftWatch(deps: DriftDeps, bus: EventBus): () => void {
  const seen = new Set<string>();
  return bus.fanout.subscribe((ev: EventRecord) => {
    if (!ev.subject) return;
    const isRun = RUN_DONE.has(ev.type);
    const isReview = SENT_BACK.has(ev.type);
    if (!isRun && !isReview) return;
    const key = `${ev.companyId}:${ev.seq}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 5000) for (const k of [...seen].slice(0, 2500)) seen.delete(k);
    const work = isRun
      ? checkRunDrift(deps, ev.companyId, ev.subject.id)
      : checkRejectionDrift(deps, ev.companyId, ev.subject.id);
    void work.catch((err) => deps.log.warn(`drift check failed: ${(err as Error).message}`));
  });
}
