// OpenTelemetry traces without an SDK: pure span shapes and the OTLP/HTTP JSON
// encoding, so the board and the worker can each post their spans for one run
// to a collector with plain fetch. One trace per run: the trace id is the run's
// uuid, the root span id is derived from it, and the worker's spans name that
// root as their parent, so the two halves join in the collector without either
// side talking to the other.

import { createHash } from "node:crypto";
import { trimTrailingSlashes } from "./text.js";

export type OtelAttrValue = string | number | boolean;

export interface OtelSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  /** 1 internal, 2 server, 3 client. */
  kind?: 1 | 2 | 3;
  startMs: number;
  endMs: number;
  attributes: Record<string, OtelAttrValue | null | undefined>;
  /** 1 ok, 2 error. */
  status?: { code: 1 | 2; message?: string };
}

const HEX32 = /^[0-9a-f]{32}$/;

/** The run's uuid without dashes is a valid 128-bit trace id. */
export function traceIdForRun(runId: string): string {
  const hex = runId.replace(/-/g, "").toLowerCase();
  return HEX32.test(hex) ? hex : createHash("sha256").update(runId).digest("hex").slice(0, 32);
}

/** A stable 64-bit span id for a named span of a run, so both halves agree without talking. */
export function spanIdFor(runId: string, name: string): string {
  return createHash("sha256").update(`${runId}:${name}`).digest("hex").slice(0, 16);
}

export function runRootSpanId(runId: string): string {
  return spanIdFor(runId, "run");
}

function attrValue(v: OtelAttrValue): Record<string, unknown> {
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
}

function attrs(
  a: Record<string, OtelAttrValue | null | undefined>,
): { key: string; value: Record<string, unknown> }[] {
  return Object.entries(a)
    .filter((e): e is [string, OtelAttrValue] => e[1] !== null && e[1] !== undefined)
    .map(([key, value]) => ({ key, value: attrValue(value) }));
}

const nanos = (ms: number) => `${Math.round(ms)}000000`;

/** The body of a POST to /v1/traces. */
export function otlpTracesBody(
  resource: Record<string, OtelAttrValue>,
  spans: OtelSpan[],
  scope: { name: string; version?: string } = { name: "rosterdock" },
): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: { attributes: attrs(resource) },
        scopeSpans: [
          {
            scope,
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: s.kind ?? 1,
              startTimeUnixNano: nanos(s.startMs),
              endTimeUnixNano: nanos(Math.max(s.startMs, s.endMs)),
              attributes: attrs(s.attributes),
              ...(s.status ? { status: s.status } : {}),
            })),
          },
        ],
      },
    ],
  };
}

/** OTEL_EXPORTER_OTLP_HEADERS: "k=v,k2=v2", values percent-encoded per the spec. */
export function otlpHeaders(value: string | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (value ?? "").split(",")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/** The traces endpoint from the standard variables; null when none is set. */
export function otlpTracesEndpoint(env: { [k: string]: string | undefined }): string | null {
  const direct = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (direct) return direct;
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  return base ? `${trimTrailingSlashes(base)}/v1/traces` : null;
}

export interface OtlpTarget {
  endpoint: string;
  headers: Record<string, string>;
  serviceName: string;
}

/** Post one batch of spans. Never throws: a collector that is down loses spans, not runs. */
export async function postSpans(
  target: OtlpTarget,
  fetchFn: typeof fetch,
  spans: OtelSpan[],
  resource: Record<string, OtelAttrValue> = {},
): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  if (!spans.length) return { ok: true, status: null, error: null };
  try {
    const res = await fetchFn(target.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...target.headers },
      body: JSON.stringify(otlpTracesBody({ "service.name": target.serviceName, ...resource }, spans)),
    });
    return { ok: res.ok, status: res.status, error: res.ok ? null : `collector answered ${res.status}` };
  } catch (err) {
    return { ok: false, status: null, error: (err as Error).message };
  }
}
