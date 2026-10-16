// One OpenTelemetry trace per run, from the board's side: when a run ends, the
// board builds the run's spans from what it already holds (the run row, its
// step events, the tool calls it brokered for the run) and posts them to the
// OTLP collector. The worker posts its own spans (workspace, engine, harvest,
// tests) for the same trace id with the run's root span as their parent, so
// the collector shows both halves as one trace. Nothing here is a
// visualisation-only event: the spans are a projection of the event stream
// and the run tables, posted after the fact.

import {
  postSpans,
  runRootSpanId,
  spanIdFor,
  traceIdForRun,
  type OtelSpan,
  type OtlpTarget,
} from "@rosterdock/shared";
import type { EventRecord } from "@rosterdock/shared";
import type { Db } from "../db/pool.js";
import type { EventBus } from "../events/bus.js";
import { listRunEvents, loadRun, type RunRow } from "../runs/service.js";

export interface TracingDeps {
  db: Db;
  target: OtlpTarget;
  fetch: typeof fetch;
  log: { warn(m: string): void };
}

const TERMINAL = new Set(["run.completed", "run.failed", "run.stopped", "run.blocked"]);

/** The spans the board can tell for one finished run. Pure given the rows. */
export function runSpans(
  run: RunRow,
  extra: {
    taskNumber: number | null;
    teammateName: string | null;
    steps: { at: string; text: string }[];
    toolCalls: { at: string; connection: string; tool: string; ok: boolean; error: string | null }[];
  },
): OtelSpan[] {
  const traceId = traceIdForRun(run.id);
  const root = runRootSpanId(run.id);
  const startMs = (run.started_at ?? run.queued_at).getTime();
  const endMs = (run.finished_at ?? new Date()).getTime();
  const usage = run.usage ?? {};
  const total =
    (usage.inputTokens ?? 0) +
    (usage.outputTokens ?? 0) +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0);
  const spans: OtelSpan[] = [
    {
      traceId,
      spanId: root,
      name: `run ${run.kind}`,
      kind: 2,
      startMs,
      endMs,
      attributes: {
        "rosterdock.company_id": run.company_id,
        "rosterdock.run_id": run.id,
        "rosterdock.task_id": run.task_id,
        "rosterdock.task_number": extra.taskNumber,
        "rosterdock.teammate_id": run.teammate_id,
        "rosterdock.teammate": extra.teammateName,
        "rosterdock.engine": run.engine,
        "rosterdock.model": run.model,
        "rosterdock.kind": run.kind,
        "rosterdock.attempt": run.attempt,
        "rosterdock.status": run.status,
        "rosterdock.worker_id": run.worker_id,
        "rosterdock.tokens.input": usage.inputTokens ?? 0,
        "rosterdock.tokens.output": usage.outputTokens ?? 0,
        "rosterdock.tokens.cache_read": usage.cacheReadTokens ?? 0,
        "rosterdock.tokens.cache_write": usage.cacheWriteTokens ?? 0,
        "rosterdock.tokens.total": total,
        "rosterdock.cost_minor_units": run.cost_minor_units,
        "rosterdock.duration_ms": run.duration_ms,
        "rosterdock.blocker": run.blocker?.code ?? null,
      },
      status:
        run.status === "failed"
          ? { code: 2, message: (run.error ?? "the run failed").slice(0, 500) }
          : { code: 1 },
    },
  ];
  if (run.started_at && run.started_at.getTime() > run.queued_at.getTime()) {
    spans.push({
      traceId,
      spanId: spanIdFor(run.id, "queued"),
      parentSpanId: root,
      name: "queued",
      startMs: run.queued_at.getTime(),
      endMs: run.started_at.getTime(),
      attributes: {},
    });
  }
  extra.steps.forEach((step, i) => {
    const next = extra.steps[i + 1];
    spans.push({
      traceId,
      spanId: spanIdFor(run.id, `step:${i}`),
      parentSpanId: root,
      name: `step: ${step.text}`.slice(0, 120),
      startMs: new Date(step.at).getTime(),
      endMs: next ? new Date(next.at).getTime() : endMs,
      attributes: { "rosterdock.step": step.text.slice(0, 200) },
    });
  });
  extra.toolCalls.forEach((call, i) => {
    const at = new Date(call.at).getTime();
    spans.push({
      traceId,
      spanId: spanIdFor(run.id, `tool:${i}`),
      parentSpanId: root,
      name: `tool ${call.connection}.${call.tool}`,
      kind: 3,
      startMs: at,
      endMs: at,
      attributes: {
        "rosterdock.connection": call.connection,
        "rosterdock.tool": call.tool,
        "rosterdock.ok": call.ok,
        "rosterdock.error": call.error,
      },
      status: call.ok ? { code: 1 } : { code: 2, message: (call.error ?? "refused").slice(0, 500) },
    });
  });
  return spans;
}

export async function exportRunTrace(deps: TracingDeps, runId: string): Promise<void> {
  const run = await loadRun(deps.db, runId);
  const task = (
    await deps.db.query<{ number: number }>("SELECT number FROM tasks WHERE id = $1", [run.task_id])
  ).rows[0];
  const mate = (
    await deps.db.query<{ name: string }>("SELECT name FROM teammates WHERE id = $1", [run.teammate_id])
  ).rows[0];
  const events = await listRunEvents(deps.db, run.id, 0, 2000);
  const steps = events
    .filter((e) => e.type === "step" && typeof e.payload.text === "string")
    .map((e) => ({ at: e.at, text: String(e.payload.text) }));
  const calls = await deps.db.query<{
    created_at: Date;
    payload: { connection: string; tool: string; ok: boolean; error: string | null };
  }>(
    "SELECT created_at, payload FROM events WHERE company_id = $1 AND type = 'tool.called' AND payload->>'runId' = $2 ORDER BY seq",
    [run.company_id, run.id],
  );
  const spans = runSpans(run, {
    taskNumber: task?.number ?? null,
    teammateName: mate?.name ?? null,
    steps,
    toolCalls: calls.rows.map((c) => ({
      at: c.created_at.toISOString(),
      connection: c.payload.connection,
      tool: c.payload.tool,
      ok: !!c.payload.ok,
      error: c.payload.error ?? null,
    })),
  });
  const out = await postSpans(deps.target, deps.fetch, spans);
  if (!out.ok) deps.log.warn(`trace for run ${run.id} not exported: ${out.error}`);
}

/** A bus subscriber: every run that ends on any replica is traced once by the replica that sees it first. */
export function startRunTracer(deps: TracingDeps, bus: EventBus): () => void {
  const seen = new Set<string>();
  return bus.fanout.subscribe((ev: EventRecord) => {
    if (!TERMINAL.has(ev.type) || !ev.subject) return;
    const key = `${ev.companyId}:${ev.seq}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 5000) for (const k of [...seen].slice(0, 2500)) seen.delete(k);
    void exportRunTrace(deps, ev.subject.id).catch((err) =>
      deps.log.warn(`trace export failed: ${(err as Error).message}`),
    );
  });
}
