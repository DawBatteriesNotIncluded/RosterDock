// Spans that are not a run's: Peter's model calls and the broker's reads a
// teammate makes outside a run (a manager token). Each is its own one-span
// trace, posted to the same OTLP collector as the run traces; a run's reads
// stay inside the run's trace, built when the run ends. The sink is the one
// place that knows the collector; everything else hands it spans.

import { postSpans, spanIdFor, traceIdForRun, type OtelSpan, type OtlpTarget } from "@rosterdock/shared";
import { randomUUID } from "node:crypto";

export interface SpanSink {
  post(spans: OtelSpan[]): Promise<void>;
}

export function otlpSink(
  target: OtlpTarget,
  fetch: typeof globalThis.fetch,
  log: { warn(m: string): void },
): SpanSink {
  return {
    async post(spans) {
      const out = await postSpans(target, fetch, spans);
      if (!out.ok) log.warn(`spans not exported: ${out.error}`);
    },
  };
}

/** A one-span trace of its own: a fresh trace id, a span id from it. */
export function standaloneSpan(
  name: string,
  startMs: number,
  endMs: number,
  attributes: OtelSpan["attributes"],
  status: OtelSpan["status"],
  kind?: OtelSpan["kind"],
): OtelSpan {
  const key = randomUUID();
  return {
    traceId: traceIdForRun(key),
    spanId: spanIdFor(key, name),
    name,
    ...(kind !== undefined ? { kind } : {}),
    startMs,
    endMs,
    attributes,
    status,
  };
}
