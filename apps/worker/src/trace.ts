// The worker's half of a run's trace: what happened inside the pod (the
// workspace, the engine, the harvest, the repository's tests), posted to the
// OTLP collector when the run ends, with the run's uuid as the trace id and
// the board's root span as the parent. The board posts the other half.

import {
  postSpans,
  runRootSpanId,
  spanIdFor,
  traceIdForRun,
  type OtelSpan,
  type OtlpTarget,
} from "@rosterdock/shared";
import { clip } from "./text.js";

export interface Phase {
  name: string;
  startMs: number;
  endMs: number;
  attributes?: Record<string, string | number | boolean | null | undefined>;
  error?: string | null;
}

/** Records phases as the run goes; `end` closes the open one. */
export interface PhaseRecorder {
  begin(name: string, attributes?: Phase["attributes"]): void;
  end(error?: string | null): void;
  readonly phases: Phase[];
}

export function createPhaseRecorder(now: () => number = Date.now): PhaseRecorder {
  const phases: Phase[] = [];
  let open: Phase | null = null;
  return {
    phases,
    begin(name, attributes) {
      if (open) open.endMs = now();
      open = { name, startMs: now(), endMs: now(), attributes: attributes ?? {} };
      phases.push(open);
    },
    end(error) {
      if (!open) return;
      open.endMs = now();
      if (error) open.error = error;
      open = null;
    },
  };
}

export function workerSpans(runId: string, phases: Phase[]): OtelSpan[] {
  const traceId = traceIdForRun(runId);
  const parent = runRootSpanId(runId);
  return phases.map((p, i) => ({
    traceId,
    spanId: spanIdFor(runId, `worker:${i}:${p.name}`),
    parentSpanId: parent,
    name: p.name,
    startMs: p.startMs,
    endMs: p.endMs,
    attributes: p.attributes ?? {},
    status: p.error ? { code: 2, message: clip(p.error, 500) } : { code: 1 },
  }));
}

export interface WorkerOtlp {
  target: OtlpTarget;
  fetch: typeof fetch;
}

export async function exportWorkerTrace(
  otlp: WorkerOtlp,
  runId: string,
  workerId: string,
  phases: Phase[],
): Promise<{ ok: boolean; error: string | null }> {
  const out = await postSpans(otlp.target, otlp.fetch, workerSpans(runId, phases), {
    "rosterdock.worker_id": workerId,
  });
  return { ok: out.ok, error: out.error };
}
