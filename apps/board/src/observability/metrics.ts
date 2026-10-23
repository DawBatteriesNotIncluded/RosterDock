// Prometheus metrics for the board. A small registry (counters, gauges,
// histograms in the text exposition format; no dependency) fed by the HTTP
// hooks and the event stream, plus a few gauges read from Postgres at scrape
// time. GET /metrics is public on the board's port: the web never proxies it,
// so it is reachable from inside the cluster only. Labels are kept few and
// bounded (no company ids, no task ids); the per-company view is the Costs page.

import { timingSafeEqual } from "node:crypto";
import { bearerToken, TASK_STATUSES, type EventRecord } from "@rosterdock/shared";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/pool.js";
import type { EventBus } from "../events/bus.js";

type Labels = Record<string, string>;

function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${labels[k]}`).join(",");
}

function renderLabels(labels: Labels, extra?: Labels): string {
  const all = { ...labels, ...(extra ?? {}) };
  const keys = Object.keys(all).sort();
  if (!keys.length) return "";
  const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  return `{${keys.map((k) => `${k}="${esc(all[k]!)}"`).join(",")}}`;
}

function fmt(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toPrecision(12)));
}

export class Counter {
  private readonly values = new Map<string, { labels: Labels; value: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels = {}, by = 1): void {
    const key = labelKey(labels);
    const cur = this.values.get(key);
    if (cur) cur.value += by;
    else this.values.set(key, { labels, value: by });
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const v of this.values.values()) lines.push(`${this.name}${renderLabels(v.labels)} ${fmt(v.value)}`);
    return lines.join("\n");
  }
}

export class Gauge {
  private readonly values = new Map<string, { labels: Labels; value: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  set(labels: Labels, value: number): void {
    this.values.set(labelKey(labels), { labels, value });
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const v of this.values.values()) lines.push(`${this.name}${renderLabels(v.labels)} ${fmt(v.value)}`);
    return lines.join("\n");
  }
}

export class Histogram {
  private readonly series = new Map<
    string,
    { labels: Labels; buckets: number[]; sum: number; count: number }
  >();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly bounds: number[],
  ) {}
  observe(labels: Labels, value: number): void {
    const key = labelKey(labels);
    let s = this.series.get(key);
    if (!s) {
      s = { labels, buckets: this.bounds.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    this.bounds.forEach((b, i) => {
      if (value <= b) s.buckets[i]! += 1;
    });
    s.sum += value;
    s.count += 1;
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const s of this.series.values()) {
      this.bounds.forEach((b, i) =>
        lines.push(`${this.name}_bucket${renderLabels(s.labels, { le: fmt(b) })} ${s.buckets[i]}`),
      );
      lines.push(`${this.name}_bucket${renderLabels(s.labels, { le: "+Inf" })} ${s.count}`);
      lines.push(`${this.name}_sum${renderLabels(s.labels)} ${fmt(s.sum)}`);
      lines.push(`${this.name}_count${renderLabels(s.labels)} ${s.count}`);
    }
    return lines.join("\n");
  }
}

export interface Registry {
  counter(name: string, help: string): Counter;
  gauge(name: string, help: string): Gauge;
  histogram(name: string, help: string, bounds: number[]): Histogram;
  /** Gauges computed at scrape time (a Postgres count, process memory). */
  onScrape(fn: () => Promise<void> | void): void;
  render(): Promise<string>;
}

export function createRegistry(): Registry {
  const items: { render(): string }[] = [];
  const scrapers: (() => Promise<void> | void)[] = [];
  return {
    counter(name, help) {
      const c = new Counter(name, help);
      items.push(c);
      return c;
    },
    gauge(name, help) {
      const g = new Gauge(name, help);
      items.push(g);
      return g;
    },
    histogram(name, help, bounds) {
      const h = new Histogram(name, help, bounds);
      items.push(h);
      return h;
    },
    onScrape(fn) {
      scrapers.push(fn);
    },
    async render() {
      for (const fn of scrapers) {
        try {
          await fn();
        } catch {
          // A scraper that fails leaves its gauges stale; the rest still render.
        }
      }
      return items.map((i) => i.render()).join("\n") + "\n";
    },
  };
}

const RUN_TERMINAL: Record<string, string> = {
  "run.completed": "completed",
  "run.failed": "failed",
  "run.stopped": "stopped",
  "run.blocked": "blocked",
};

/** The board's metrics: HTTP, the event stream, runs, tools, approvals, and live gauges. */
export function registerMetrics(
  app: FastifyInstance,
  db: Db,
  bus: EventBus,
  opts: { token?: string | null } = {},
): { stop(): void } {
  const reg = createRegistry();
  const httpRequests = reg.counter(
    "rosterdock_http_requests_total",
    "HTTP requests by method, route and status",
  );
  const httpDuration = reg.histogram(
    "rosterdock_http_request_duration_seconds",
    "HTTP request duration by route",
    [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  );
  const events = reg.counter(
    "rosterdock_events_total",
    "Events appended to the stream, by type (seen by this replica)",
  );
  const runs = reg.counter("rosterdock_runs_total", "Runs that reached an end, by status");
  const runDuration = reg.histogram(
    "rosterdock_run_duration_seconds",
    "Run duration from start to end, by status",
    [10, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200],
  );
  const tokens = reg.counter("rosterdock_tokens_total", "Tokens reported by finished runs, by kind");
  const toolCalls = reg.counter("rosterdock_tool_calls_total", "Tool reads through the broker, by outcome");
  const approvals = reg.counter("rosterdock_approvals_total", "Approval events, by status");
  const live = reg.gauge("rosterdock_runs_live", "Runs queued, running or interrupted right now");
  const pending = reg.gauge("rosterdock_approvals_pending", "Proposed writes waiting on a person");
  const tasks = reg.gauge("rosterdock_tasks", "Tasks on every board, by status");
  const rss = reg.gauge("process_resident_memory_bytes", "Resident memory of this board process");
  const cpu = reg.gauge("process_cpu_seconds_total", "CPU time of this board process");
  const up = reg.gauge("rosterdock_board_up", "1 while the board answers");
  up.set({}, 1);

  app.addHook("onResponse", (req, reply, done) => {
    const route = req.routeOptions.url ?? "unmatched";
    if (route !== "/metrics") {
      const labels = { method: req.method, route, status: String(reply.statusCode) };
      httpRequests.inc(labels);
      httpDuration.observe({ method: req.method, route }, reply.elapsedTime / 1000);
    }
    done();
  });

  const onEvent = (ev: EventRecord) => {
    events.inc({ type: ev.type });
    const p = ev.payload as Record<string, unknown>;
    const status = RUN_TERMINAL[ev.type];
    if (status) {
      runs.inc({ status, kind: String(p.kind ?? "task") });
      if (typeof p.durationMs === "number") runDuration.observe({ status }, p.durationMs / 1000);
      const usage = (p.usage ?? {}) as Record<string, unknown>;
      for (const [kind, key] of [
        ["input", "inputTokens"],
        ["output", "outputTokens"],
        ["cache_read", "cacheReadTokens"],
        ["cache_write", "cacheWriteTokens"],
      ] as const) {
        const n = usage[key];
        if (typeof n === "number" && n > 0) tokens.inc({ kind }, n);
      }
    }
    if (ev.type === "tool.called") toolCalls.inc({ ok: p.ok ? "true" : "false" });
    if (ev.type.startsWith("approval.")) approvals.inc({ status: ev.type.slice("approval.".length) });
  };
  const unsubscribe = bus.fanout.subscribe(onEvent);

  reg.onScrape(async () => {
    const mem = process.memoryUsage();
    rss.set({}, mem.rss);
    const c = process.cpuUsage();
    cpu.set({}, (c.user + c.system) / 1_000_000);
    const liveRows = await db.query<{ status: string; n: number }>(
      "SELECT status, count(*)::int AS n FROM runs WHERE status IN ('queued', 'running', 'interrupted') GROUP BY status",
    );
    for (const s of ["queued", "running", "interrupted"])
      live.set({ status: s }, liveRows.rows.find((r) => r.status === s)?.n ?? 0);
    const pend = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM approvals WHERE status = 'pending'",
    );
    pending.set({}, pend.rows[0]?.n ?? 0);
    const taskRows = await db.query<{ status: string; n: number }>(
      "SELECT status, count(*)::int AS n FROM tasks GROUP BY status",
    );
    for (const s of TASK_STATUSES)
      tasks.set({ status: s }, taskRows.rows.find((r) => r.status === s)?.n ?? 0);
  });

  // Open on the board's port by default (cluster-internal); with a token, only a scraper that presents it.
  app.get("/metrics", { config: { public: true } }, async (req, reply) => {
    if (opts.token) {
      const given = Buffer.from(bearerToken(req.headers.authorization) ?? "");
      const want = Buffer.from(opts.token);
      if (given.length !== want.length || !timingSafeEqual(given, want)) {
        reply.code(401).header("www-authenticate", 'Bearer realm="metrics"');
        return "unauthorized\n";
      }
    }
    reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
    return reg.render();
  });

  return { stop: unsubscribe };
}
