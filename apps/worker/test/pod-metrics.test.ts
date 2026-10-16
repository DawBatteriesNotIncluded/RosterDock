// The pod's CPU and memory from the metrics API: quantities, the one GET with
// the pod's token, and the cgroup behind it when the API does not answer.
// fetch is injected and replays fixtures/pod-metrics.json; no cluster.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  createPodMetricsSampler,
  parseCpuMillis,
  parseMemoryBytes,
  podMetricsConfig,
} from "../src/pod-metrics.js";
import { createResourceSampler, type ResourceReader } from "../src/resources.js";

const fixture = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "pod-metrics.json"),
  "utf8",
);

function reader(files: Record<string, string[]>): ResourceReader {
  let t = 1_000_000;
  const calls: Record<string, number> = {};
  return {
    async readFile(p) {
      const versions = files[p];
      if (!versions) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      const i = Math.min(calls[p] ?? 0, versions.length - 1);
      calls[p] = (calls[p] ?? 0) + 1;
      return versions[i]!;
    },
    process: () => ({ cpuMicros: 0, rssBytes: 4096 }),
    now: () => (t += 10_000),
  };
}

const cfg = {
  apiBase: "https://10.96.0.1:443",
  namespace: "rosterdock",
  pod: "rosterdock-worker-788c7c9c7-xm6sz",
  token: async () => "sa-token-fixture",
};

describe("Kubernetes quantities", () => {
  it("reads CPU as millicores and memory as bytes", () => {
    expect(parseCpuMillis("250m")).toBe(250);
    expect(parseCpuMillis("1")).toBe(1000);
    expect(parseCpuMillis("1.5")).toBe(1500);
    expect(parseCpuMillis("123456789n")).toBe(123);
    expect(parseCpuMillis("12500u")).toBe(13);
    expect(parseCpuMillis("nope")).toBe(0);
    expect(parseMemoryBytes("512Mi")).toBe(512 * 1024 * 1024);
    expect(parseMemoryBytes("123456Ki")).toBe(123456 * 1024);
    expect(parseMemoryBytes("1G")).toBe(1e9);
    expect(parseMemoryBytes("4096")).toBe(4096);
    expect(parseMemoryBytes("1e6")).toBe(1e6);
    expect(parseMemoryBytes("")).toBe(0);
  });
});

describe("the pod metrics sampler", () => {
  it("asks the metrics API for this pod with the token and sums the containers", async () => {
    const calls: { url: string; authorization: string | null }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      return new Response(fixture, { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const s = createPodMetricsSampler(cfg, { fetch: fetchImpl, fallback: createResourceSampler(reader({})) });
    expect(s.source).toBe("unknown");
    // 12m + 838m of CPU, 148 Mi + 1.5 Gi of memory across the two containers.
    expect(await s.sample()).toEqual({ cpuMillis: 850, memoryBytes: 155_189_248 + 1_610_612_736 });
    expect(s.source).toBe("metrics-api");
    expect(calls).toEqual([
      {
        url: "https://10.96.0.1:443/apis/metrics.k8s.io/v1beta1/namespaces/rosterdock/pods/rosterdock-worker-788c7c9c7-xm6sz",
        authorization: "Bearer sa-token-fixture",
      },
    ]);
  });

  it("falls back to the cgroup when the API refuses or is unreachable, and says so once", async () => {
    let status = 403;
    let down = false;
    const fetchImpl = (async () => {
      if (down) throw new Error("connect ECONNREFUSED");
      return new Response(JSON.stringify({ kind: "Status", code: status }), { status });
    }) as typeof fetch;
    const warnings: string[] = [];
    const s = createPodMetricsSampler(cfg, {
      fetch: fetchImpl,
      fallback: createResourceSampler(
        reader({
          "/sys/fs/cgroup/cpu.stat": ["usage_usec 5000000\n", "usage_usec 8000000\n", "usage_usec 9000000\n"],
          "/sys/fs/cgroup/memory.current": ["536870912\n"],
        }),
      ),
      log: { warn: (m) => warnings.push(m) },
    });
    expect(await s.sample()).toEqual({ cpuMillis: 0, memoryBytes: 536_870_912 });
    expect(s.source).toBe("cgroup-v2");
    expect(await s.sample()).toEqual({ cpuMillis: 300, memoryBytes: 536_870_912 });
    expect(warnings).toEqual(["pod metrics: the metrics API answered 403; using the cgroup-v2 numbers"]);
    down = true;
    expect(await s.sample()).toEqual({ cpuMillis: 100, memoryBytes: 536_870_912 });
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toMatch(/could not reach the API server: connect ECONNREFUSED/);
    status = 200;
    void status;
  });

  it("is configured from the pod's env and mounts, and is off without ROSTERDOCK_POD_METRICS", async () => {
    const files: Record<string, string> = {
      "/var/run/secrets/kubernetes.io/serviceaccount/namespace": "rosterdock\n",
      "/var/run/secrets/kubernetes.io/serviceaccount/token": "sa-token-1\n",
    };
    const read = async (f: string) => {
      if (!(f in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files[f]!;
    };
    expect(await podMetricsConfig({}, read)).toBeNull();
    const c = await podMetricsConfig(
      { ROSTERDOCK_POD_METRICS: "1", KUBERNETES_SERVICE_HOST: "10.96.0.1", ROSTERDOCK_WORKER_ID: "w-1" },
      read,
    );
    expect(c).toMatchObject({ apiBase: "https://10.96.0.1:443", namespace: "rosterdock", pod: "w-1" });
    expect(await c!.token()).toBe("sa-token-1");
    const named = await podMetricsConfig(
      {
        ROSTERDOCK_POD_METRICS: "1",
        KUBERNETES_SERVICE_HOST: "10.96.0.1",
        KUBERNETES_SERVICE_PORT: "6443",
        ROSTERDOCK_WORKER_ID: "w-1",
        ROSTERDOCK_POD_NAMESPACE: "elsewhere",
      },
      read,
    );
    expect(named).toMatchObject({ apiBase: "https://10.96.0.1:6443", namespace: "elsewhere" });
    await expect(podMetricsConfig({ ROSTERDOCK_POD_METRICS: "1" }, read)).rejects.toThrow(/not in a pod/);
    const base = { DATABASE_URL: "postgres://x", ROSTERDOCK_WORKER_TOKEN: "t" };
    expect(loadConfig(base).podMetrics).toBe(false);
    expect(loadConfig({ ...base, ROSTERDOCK_POD_METRICS: "1" }).podMetrics).toBe(true);
  });
});
