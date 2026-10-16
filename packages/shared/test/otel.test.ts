import { describe, expect, it } from "vitest";
import {
  otlpHeaders,
  otlpTracesBody,
  otlpTracesEndpoint,
  postSpans,
  runRootSpanId,
  spanIdFor,
  traceIdForRun,
} from "../src/index.js";

const RUN = "6b493e5f-a98f-4f86-8347-cb7bd6b90367";

describe("trace and span ids", () => {
  it("uses the run uuid as the trace id and derives stable span ids from it", () => {
    expect(traceIdForRun(RUN)).toBe("6b493e5fa98f4f868347cb7bd6b90367");
    expect(traceIdForRun("not-a-uuid")).toMatch(/^[0-9a-f]{32}$/);
    expect(runRootSpanId(RUN)).toMatch(/^[0-9a-f]{16}$/);
    expect(runRootSpanId(RUN)).toBe(spanIdFor(RUN, "run"));
    expect(spanIdFor(RUN, "engine")).not.toBe(spanIdFor(RUN, "run"));
    expect(spanIdFor("other", "run")).not.toBe(runRootSpanId(RUN));
  });
});

describe("OTLP JSON", () => {
  it("encodes spans with typed attributes, nanosecond times and a status", () => {
    const body = otlpTracesBody({ "service.name": "rosterdock-board" }, [
      {
        traceId: traceIdForRun(RUN),
        spanId: runRootSpanId(RUN),
        name: "run task",
        kind: 2,
        startMs: 1_757_671_200_000,
        endMs: 1_757_671_260_500,
        attributes: {
          "rosterdock.run_id": RUN,
          "rosterdock.tokens.total": 1234,
          "rosterdock.ok": true,
          "rosterdock.cost": 2.5,
          skip: null,
        },
        status: { code: 2, message: "the engine failed" },
      },
      {
        traceId: traceIdForRun(RUN),
        spanId: spanIdFor(RUN, "engine"),
        parentSpanId: runRootSpanId(RUN),
        name: "engine claude_code",
        startMs: 1_757_671_210_000,
        endMs: 1_757_671_200_000, // never before it starts
        attributes: {},
      },
    ]) as any;
    expect(body.resourceSpans[0].resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "rosterdock-board" } },
    ]);
    const [root, child] = body.resourceSpans[0].scopeSpans[0].spans;
    expect(root.traceId).toBe("6b493e5fa98f4f868347cb7bd6b90367");
    expect(root.kind).toBe(2);
    expect(root.startTimeUnixNano).toBe("1757671200000000000");
    expect(root.endTimeUnixNano).toBe("1757671260500000000");
    expect(root.attributes).toEqual([
      { key: "rosterdock.run_id", value: { stringValue: RUN } },
      { key: "rosterdock.tokens.total", value: { intValue: "1234" } },
      { key: "rosterdock.ok", value: { boolValue: true } },
      { key: "rosterdock.cost", value: { doubleValue: 2.5 } },
    ]);
    expect(root.status).toEqual({ code: 2, message: "the engine failed" });
    expect(child.parentSpanId).toBe(root.spanId);
    expect(child.kind).toBe(1);
    expect(child.endTimeUnixNano).toBe(child.startTimeUnixNano);
    expect(child.status).toBeUndefined();
  });

  it("reads the standard exporter variables", () => {
    expect(otlpTracesEndpoint({})).toBeNull();
    expect(otlpTracesEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4318/" })).toBe(
      "http://otel-collector:4318/v1/traces",
    );
    expect(
      otlpTracesEndpoint({
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://a:4318",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://b.test/traces",
      }),
    ).toBe("https://b.test/traces");
    expect(otlpHeaders("authorization=Bearer%20abc,x-tenant=t1, bad ,=nope")).toEqual({
      authorization: "Bearer abc",
      "x-tenant": "t1",
    });
    expect(otlpHeaders(undefined)).toEqual({});
  });

  it("posts a batch and reports a collector that is down without throwing", async () => {
    const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
    const ok: typeof fetch = async (url, init) => {
      calls.push({
        url: String(url),
        headers: Object.fromEntries(new Headers(init?.headers)),
        body: JSON.parse(String(init?.body)),
      });
      return new Response("{}", { status: 200 });
    };
    const target = {
      endpoint: "https://otel.test/v1/traces",
      headers: { "x-key": "k" },
      serviceName: "rosterdock-worker",
    };
    const span = {
      traceId: traceIdForRun(RUN),
      spanId: spanIdFor(RUN, "engine"),
      name: "engine",
      startMs: 1,
      endMs: 2,
      attributes: {},
    };
    expect(await postSpans(target, ok, [span], { "rosterdock.worker_id": "w1" })).toEqual({
      ok: true,
      status: 200,
      error: null,
    });
    expect(calls[0]!.url).toBe(target.endpoint);
    expect(calls[0]!.headers["x-key"]).toBe("k");
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(calls[0]!.body.resourceSpans[0].resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "rosterdock-worker" } },
      { key: "rosterdock.worker_id", value: { stringValue: "w1" } },
    ]);
    expect(await postSpans(target, ok, [])).toEqual({ ok: true, status: null, error: null });
    expect(calls).toHaveLength(1);
    const down: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await postSpans(target, down, [span])).toEqual({ ok: false, status: null, error: "ECONNREFUSED" });
    const refusing: typeof fetch = async () => new Response("no", { status: 503 });
    expect((await postSpans(target, refusing, [span])).error).toBe("collector answered 503");
  });
});
