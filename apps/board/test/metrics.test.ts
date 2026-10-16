// Prometheus metrics: the registry renders the text format; the board counts
// requests, events, finished runs and tokens, and reads live gauges at scrape.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRegistry } from "../src/observability/metrics.js";
import {
  addProject,
  addTeammate,
  seedCompany,
  startTestBoard,
  workerClaim,
  workerComplete,
  type TestBoard,
} from "./helpers.js";

let board: TestBoard;
beforeAll(async () => {
  board = await startTestBoard();
});
afterAll(async () => {
  await board.destroy();
});

describe("the registry (pure)", () => {
  it("renders counters, gauges and histograms in the exposition format with escaped labels", async () => {
    const reg = createRegistry();
    const c = reg.counter("x_total", "x things");
    c.inc({ route: "/a" });
    c.inc({ route: "/a" }, 2);
    c.inc({ route: 'q"uote\\' });
    const g = reg.gauge("g", "a gauge");
    g.set({}, 1.5);
    const h = reg.histogram("d_seconds", "durations", [0.1, 1]);
    h.observe({ r: "x" }, 0.05);
    h.observe({ r: "x" }, 0.5);
    h.observe({ r: "x" }, 5);
    reg.onScrape(() => g.set({}, 2));
    const text = await reg.render();
    expect(text).toContain("# TYPE x_total counter");
    expect(text).toContain('x_total{route="/a"} 3');
    expect(text).toContain('x_total{route="q\\"uote\\\\"} 1');
    expect(text).toContain("g 2");
    expect(text).toContain('d_seconds_bucket{le="0.1",r="x"} 1');
    expect(text).toContain('d_seconds_bucket{le="1",r="x"} 2');
    expect(text).toContain('d_seconds_bucket{le="+Inf",r="x"} 3');
    expect(text).toContain('d_seconds_sum{r="x"} 5.55');
    expect(text).toContain('d_seconds_count{r="x"} 3');
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("GET /metrics behind a bearer", () => {
  it("answers 401 without the token and the exposition with it", async () => {
    const guarded = await startTestBoard({ metricsToken: "scrape-me" });
    try {
      const none = await guarded.app.inject({ method: "GET", url: "/metrics" });
      expect(none.statusCode).toBe(401);
      expect(none.headers["www-authenticate"]).toBe('Bearer realm="metrics"');
      const wrong = await guarded.app.inject({
        method: "GET",
        url: "/metrics",
        headers: { authorization: "Bearer scrape-you" },
      });
      expect(wrong.statusCode).toBe(401);
      const ok = await guarded.app.inject({
        method: "GET",
        url: "/metrics",
        headers: { authorization: "Bearer scrape-me" },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.body).toContain("rosterdock_http_requests_total");
    } finally {
      await guarded.destroy();
    }
  });
});

describe("GET /metrics", () => {
  it("is public, counts requests and finished runs, and reads live gauges", async () => {
    const { api, base } = await seedCompany(board, "m1@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const project = await addProject(api, base);
    const task = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "t",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    const run = (await api.post(`${base}/tasks/${task.id}/runs`, {})).body;
    const claimed = await workerClaim(board, run.id);
    // Heartbeats carry the pod's CPU and memory (M6); the live panel shows them.
    const hb = await claimed.api.post(`/api/worker/runs/${run.id}/heartbeat`, {
      step: "running",
      resources: { cpuMillis: 320, memoryBytes: 512 * 1024 * 1024 },
    });
    expect(hb.status).toBe(200);
    const liveRun = (await api.get(`${base}/runs/${run.id}`)).body;
    expect(liveRun.resources).toEqual({ cpuMillis: 320, memoryBytes: 536_870_912 });
    let scrape = await board.app.inject({ method: "GET", url: "/metrics" });
    expect(scrape.statusCode).toBe(200);
    expect(scrape.headers["content-type"]).toMatch(/^text\/plain/);
    expect(scrape.body).toContain('rosterdock_runs_live{status="running"} 1');
    await workerComplete(board, claimed.token, run.id, {
      status: "completed",
      summary: "done",
      usage: { inputTokens: 1000, outputTokens: 50 },
      durationMs: 42_000,
    });
    await board.bus.waitFor(base.split("/").at(-1)!, (await api.get(`${base}/events?limit=1`)).body[0].seq);
    scrape = await board.app.inject({ method: "GET", url: "/metrics" });
    const text = scrape.body;
    expect(text).toContain("# TYPE rosterdock_http_requests_total counter");
    expect(text).toMatch(
      /rosterdock_http_requests_total\{method="POST",route="\/api\/companies\/:companyId\/tasks",status="201"\} \d+/,
    );
    expect(text).toMatch(
      /rosterdock_http_request_duration_seconds_count\{method="GET",route="\/api\/companies\/:companyId\/runs\/:runId"\} \d+/,
    );
    expect(text).toContain('rosterdock_runs_total{kind="task",status="completed"} 1');
    expect(text).toContain('rosterdock_run_duration_seconds_bucket{le="60",status="completed"} 1');
    expect(text).toContain('rosterdock_tokens_total{kind="input"} 1000');
    expect(text).toContain('rosterdock_tokens_total{kind="output"} 50');
    expect(text).toMatch(/rosterdock_events_total\{type="run\.completed"\} 1/);
    expect(text).toMatch(/rosterdock_events_total\{type="review\.opened"\} 1/);
    expect(text).toContain('rosterdock_runs_live{status="running"} 0');
    expect(text).toContain("rosterdock_approvals_pending 0");
    expect(text).toMatch(/rosterdock_tasks\{status="review"\} 1/);
    expect(text).toMatch(/process_resident_memory_bytes \d+/);
    expect(text).toContain("rosterdock_board_up 1");
    // The scrape itself is not counted.
    expect(text).not.toContain('route="/metrics"');
  });
});
