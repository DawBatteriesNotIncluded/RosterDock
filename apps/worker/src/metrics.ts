// The worker's own metrics, served on a port of its own so a ServiceMonitor
// can scrape the fleet: which worker and pool this is, runs finished by
// status, seconds spent on runs, whether a run is in flight, when the last
// one ended. A few counters in the Prometheus text format over node:http;
// nothing about a run's content, nothing that names a credential.

import { createServer, type Server } from "node:http";

export interface WorkerMetrics {
  runStarted(): void;
  runFinished(status: string, ms: number): void;
  /** The Prometheus text exposition. */
  render(): string;
}

function label(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

export function createWorkerMetrics(info: {
  worker: string;
  pool: string | null;
  queue: string;
  now?: () => number;
}): WorkerMetrics {
  const now = info.now ?? (() => Date.now());
  const byStatus = new Map<string, number>();
  let seconds = 0;
  let inFlight = 0;
  let lastFinished: number | null = null;
  const infoLabels = `{worker=${label(info.worker)},pool=${label(info.pool ?? "default")},queue=${label(info.queue)}}`;
  return {
    runStarted() {
      inFlight += 1;
    },
    runFinished(status, ms) {
      inFlight = Math.max(0, inFlight - 1);
      byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
      seconds += Math.max(0, ms) / 1000;
      lastFinished = now() / 1000;
    },
    render() {
      const lines = [
        "# HELP rosterdock_worker_info The worker, its pool and the queue it consumes.",
        "# TYPE rosterdock_worker_info gauge",
        `rosterdock_worker_info${infoLabels} 1`,
        "# HELP rosterdock_worker_up 1 while the worker serves this page.",
        "# TYPE rosterdock_worker_up gauge",
        "rosterdock_worker_up 1",
        "# HELP rosterdock_worker_runs_total Runs finished by this worker, by how they ended.",
        "# TYPE rosterdock_worker_runs_total counter",
      ];
      for (const status of ["completed", "failed", "blocked", "stopped", "skipped", "error"])
        lines.push(`rosterdock_worker_runs_total{status=${label(status)}} ${byStatus.get(status) ?? 0}`);
      for (const [status, n] of byStatus)
        if (!["completed", "failed", "blocked", "stopped", "skipped", "error"].includes(status))
          lines.push(`rosterdock_worker_runs_total{status=${label(status)}} ${n}`);
      lines.push(
        "# HELP rosterdock_worker_run_seconds_total Seconds this worker spent on runs.",
        "# TYPE rosterdock_worker_run_seconds_total counter",
        `rosterdock_worker_run_seconds_total ${seconds.toFixed(3)}`,
        "# HELP rosterdock_worker_runs_in_flight Runs this worker is on right now (0 or 1).",
        "# TYPE rosterdock_worker_runs_in_flight gauge",
        `rosterdock_worker_runs_in_flight ${inFlight}`,
        "# HELP rosterdock_worker_last_run_finished_seconds When the last run ended, as unix time; 0 before the first.",
        "# TYPE rosterdock_worker_last_run_finished_seconds gauge",
        `rosterdock_worker_last_run_finished_seconds ${lastFinished === null ? 0 : lastFinished.toFixed(3)}`,
      );
      return `${lines.join("\n")}\n`;
    },
  };
}

/** Serve /metrics (and /healthz) on the port; 0 picks a free one. */
export function startMetricsServer(
  metrics: WorkerMetrics,
  port: number,
  host = "0.0.0.0",
): Promise<{ port: number; server: Server; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    if (path === "/metrics") {
      const body = metrics.render();
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }
    if (path === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address ? address.port : port,
        server,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
