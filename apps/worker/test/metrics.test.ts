// The worker's metrics page: counters in the Prometheus text format, served
// on a port of its own on localhost for the test. No network beyond it.
import { describe, expect, it } from "vitest";
import { createWorkerMetrics, startMetricsServer } from "../src/metrics.js";

describe("worker metrics", () => {
  it("counts runs by outcome and seconds on them, and says who it is", () => {
    let t = 1_700_000_000_000;
    const m = createWorkerMetrics({ worker: 'w-"1"', pool: null, queue: "runs", now: () => t });
    expect(m.render()).toContain('rosterdock_worker_info{worker="w-\\"1\\"",pool="default",queue="runs"} 1');
    expect(m.render()).toContain("rosterdock_worker_runs_in_flight 0");
    expect(m.render()).toContain("rosterdock_worker_last_run_finished_seconds 0");
    m.runStarted();
    expect(m.render()).toContain("rosterdock_worker_runs_in_flight 1");
    t += 5_000;
    m.runFinished("completed", 4_250);
    m.runStarted();
    m.runFinished("failed", 750);
    m.runFinished("odd", 0);
    const text = m.render();
    expect(text).toContain('rosterdock_worker_runs_total{status="completed"} 1');
    expect(text).toContain('rosterdock_worker_runs_total{status="failed"} 1');
    expect(text).toContain('rosterdock_worker_runs_total{status="blocked"} 0');
    expect(text).toContain('rosterdock_worker_runs_total{status="odd"} 1');
    expect(text).toContain("rosterdock_worker_run_seconds_total 5.000");
    expect(text).toContain("rosterdock_worker_runs_in_flight 0");
    expect(text).toContain("rosterdock_worker_last_run_finished_seconds 1700000005.000");
    expect(text).toContain("rosterdock_worker_up 1");
  });

  it("serves the page on its port, and only that page", async () => {
    const m = createWorkerMetrics({ worker: "w", pool: "research", queue: "runs.research" });
    const served = await startMetricsServer(m, 0, "127.0.0.1");
    try {
      const res = await fetch(`http://127.0.0.1:${served.port}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(await res.text()).toContain('pool="research",queue="runs.research"');
      expect((await fetch(`http://127.0.0.1:${served.port}/healthz`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${served.port}/anything`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${served.port}/metrics`, { method: "POST" })).status).toBe(405);
    } finally {
      await served.close();
    }
  });
});
