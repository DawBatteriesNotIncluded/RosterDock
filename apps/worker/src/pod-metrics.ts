// The pod's CPU and memory from the Kubernetes metrics API (metrics.k8s.io),
// for a runtime whose engine forks beyond what the cgroup counts. On by
// ROSTERDOCK_POD_METRICS, which the chart sets with worker.podMetrics.enabled
// along with the one thing it needs: the pod's service account token, read
// from its file at each request, and a Role that may get pod metrics and
// nothing else. The cgroup sampler stays behind it: when the API does not
// answer, the numbers come from there, and the source says so. No client
// library: one GET over fetch, injected in tests.
import { readFile } from "node:fs/promises";
import type { ResourceSample, ResourceSampler } from "./resources.js";

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

export interface PodMetricsConfig {
  /** https://<KUBERNETES_SERVICE_HOST>:<PORT>, no path. */
  apiBase: string;
  namespace: string;
  pod: string;
  /** The bearer for the API server; read per request. */
  token: () => Promise<string>;
}

/** A Kubernetes CPU quantity as millicores: 250m, 1, 1.5, 123456n, 12u. */
export function parseCpuMillis(q: string): number {
  const m = /^\s*([0-9.]+)\s*(n|u|m)?\s*$/.exec(q);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  const factor = m[2] === "n" ? 1e-6 : m[2] === "u" ? 1e-3 : m[2] === "m" ? 1 : 1000;
  return Math.max(0, Math.round(n * factor));
}

const MEMORY_UNITS: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
};

/** A Kubernetes memory quantity as bytes: 512Mi, 123456Ki, 1G, 1e6, 4096. */
export function parseMemoryBytes(q: string): number {
  const m = /^\s*([0-9.]+(?:e[0-9]+)?)\s*(Ki|Mi|Gi|Ti|k|K|M|G|T)?\s*$/.exec(q);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n * (m[2] ? MEMORY_UNITS[m[2]]! : 1)));
}

/**
 * What the pod finds around it, or null when ROSTERDOCK_POD_METRICS is off. On, the API server comes from the
 * env the kubelet sets, the namespace from ROSTERDOCK_POD_NAMESPACE (the downward API) or the token's mount,
 * and the pod's name from ROSTERDOCK_WORKER_ID (the same downward API field).
 */
export async function podMetricsConfig(
  env: NodeJS.ProcessEnv = process.env,
  read: (file: string) => Promise<string> = (f) => readFile(f, "utf8"),
): Promise<PodMetricsConfig | null> {
  if (env.ROSTERDOCK_POD_METRICS !== "1" && env.ROSTERDOCK_POD_METRICS !== "true") return null;
  const host = env.KUBERNETES_SERVICE_HOST?.trim();
  if (!host)
    throw new Error("ROSTERDOCK_POD_METRICS needs KUBERNETES_SERVICE_HOST; the worker is not in a pod");
  const port = env.KUBERNETES_SERVICE_PORT?.trim() || "443";
  const pod = env.ROSTERDOCK_WORKER_ID?.trim();
  if (!pod) throw new Error("ROSTERDOCK_POD_METRICS needs ROSTERDOCK_WORKER_ID, the pod's name");
  const namespace = env.ROSTERDOCK_POD_NAMESPACE?.trim() || (await read(`${SA_DIR}/namespace`)).trim();
  const tokenFile = env.ROSTERDOCK_KUBERNETES_TOKEN_FILE?.trim() || `${SA_DIR}/token`;
  return {
    apiBase: env.ROSTERDOCK_KUBERNETES_API?.trim().replace(/\/+$/, "") || `https://${host}:${port}`,
    namespace,
    pod,
    token: async () => (await read(tokenFile)).trim(),
  };
}

export interface PodMetricsDeps {
  fetch: typeof fetch;
  /** Where the numbers come from when the API does not answer. */
  fallback: ResourceSampler;
  log?: { warn(msg: string): void };
  timeoutMs?: number;
}

interface PodMetrics {
  containers?: { name?: string; usage?: { cpu?: string; memory?: string } }[];
}

/** A sampler that asks the metrics API, and the cgroup when it cannot. */
export function createPodMetricsSampler(cfg: PodMetricsConfig, deps: PodMetricsDeps): ResourceSampler {
  const url = `${cfg.apiBase}/apis/metrics.k8s.io/v1beta1/namespaces/${encodeURIComponent(cfg.namespace)}/pods/${encodeURIComponent(cfg.pod)}`;
  let live = false;
  let lastWarning = "";
  const warn = (why: string) => {
    if (why === lastWarning) return;
    lastWarning = why;
    deps.log?.warn(`pod metrics: ${why}; using the ${deps.fallback.source} numbers`);
  };
  const fromApi = async (): Promise<ResourceSample | null> => {
    let res: Response;
    try {
      res = await deps.fetch(url, {
        headers: { authorization: `Bearer ${await cfg.token()}`, accept: "application/json" },
        signal: AbortSignal.timeout(deps.timeoutMs ?? 5_000),
      });
    } catch (err) {
      warn(`could not reach the API server: ${(err as Error).message}`);
      return null;
    }
    if (!res.ok) {
      warn(`the metrics API answered ${res.status}`);
      return null;
    }
    const body = (await res.json().catch(() => null)) as PodMetrics | null;
    if (!body?.containers?.length) {
      warn("the metrics API listed no containers");
      return null;
    }
    let cpuMillis = 0;
    let memoryBytes = 0;
    for (const c of body.containers) {
      cpuMillis += parseCpuMillis(c.usage?.cpu ?? "0");
      memoryBytes += parseMemoryBytes(c.usage?.memory ?? "0");
    }
    lastWarning = "";
    return { cpuMillis, memoryBytes };
  };
  return {
    get source() {
      return live ? "metrics-api" : deps.fallback.source;
    },
    async sample() {
      // The cgroup sampler keeps its interval going either way, so a fallback has a rate at once.
      const cg = await deps.fallback.sample().catch(() => null);
      const api = await fromApi();
      live = api !== null;
      return api ?? cg ?? { cpuMillis: 0, memoryBytes: 0 };
    },
  };
}
