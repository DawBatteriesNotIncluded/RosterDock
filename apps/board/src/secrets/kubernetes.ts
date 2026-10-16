// The cluster's Secrets as the board's secret store: one Opaque Secret per
// name in the board's own namespace, through the API server with the pod's
// service account token (mounted only when the chart's board.oauth.enabled is
// on, with a Role for Secrets in that namespace and nothing else). No client
// library: four requests over fetch, injected in tests. The token is read
// from its file at each request, since the kubelet rotates it.
import { readFile } from "node:fs/promises";
import { assertSecretName, SecretStoreError, type SecretData, type SecretStore } from "./store.js";

export interface KubernetesSecretsConfig {
  /** https://<KUBERNETES_SERVICE_HOST>:<PORT>, no path. */
  apiBase: string;
  namespace: string;
  /** The bearer for the API server; read per request. */
  token: () => Promise<string>;
}

export interface KubernetesDeps {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

/** What a pod finds around it: the API server from the env, the namespace and the token from the mount. */
export async function inClusterSecretsConfig(
  env: NodeJS.ProcessEnv = process.env,
  read: (file: string) => Promise<string> = (f) => readFile(f, "utf8"),
): Promise<KubernetesSecretsConfig> {
  const host = env.KUBERNETES_SERVICE_HOST?.trim();
  const port = env.KUBERNETES_SERVICE_PORT?.trim() || "443";
  if (!host)
    throw new Error(
      "ROSTERDOCK_SECRET_STORE=kubernetes needs KUBERNETES_SERVICE_HOST; the board is not in a pod",
    );
  const apiBase = env.ROSTERDOCK_KUBERNETES_API?.trim().replace(/\/+$/, "") || `https://${host}:${port}`;
  const namespace = env.ROSTERDOCK_KUBERNETES_NAMESPACE?.trim() || (await read(`${SA_DIR}/namespace`)).trim();
  const tokenFile = env.ROSTERDOCK_KUBERNETES_TOKEN_FILE?.trim() || `${SA_DIR}/token`;
  return { apiBase, namespace, token: async () => (await read(tokenFile)).trim() };
}

interface Status {
  kind?: string;
  status?: string;
  reason?: string;
  message?: string;
  code?: number;
}

export function kubernetesSecretStore(cfg: KubernetesSecretsConfig, deps: KubernetesDeps = {}): SecretStore {
  const doFetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const collection = `${cfg.apiBase}/api/v1/namespaces/${encodeURIComponent(cfg.namespace)}/secrets`;
  const call = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${await cfg.token()}`,
      accept: "application/json",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await doFetch(`${collection}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  };
  // Only the reason and the message of a Status: neither ever carries the data.
  const fail = (status: number, json: Record<string, unknown>): never => {
    const s = json as Status;
    const why =
      s.kind === "Status" ? `${s.reason ?? "error"}: ${s.message ?? ""}`.trim() : `status ${status}`;
    throw new SecretStoreError(status, `the secret store refused (${why})`);
  };
  const body = (name: string, data: SecretData) => ({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name, labels: { "app.kubernetes.io/managed-by": "rosterdock" } },
    type: "Opaque",
    data: Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, Buffer.from(v, "utf8").toString("base64")]),
    ),
  });
  return {
    kind: "kubernetes",
    async get(name) {
      const { status, json } = await call("GET", `/${assertSecretName(name)}`);
      if (status === 404) return null;
      if (status !== 200) fail(status, json);
      const data = (json.data ?? {}) as Record<string, unknown>;
      const out: SecretData = {};
      for (const [k, v] of Object.entries(data))
        if (typeof v === "string") out[k] = Buffer.from(v, "base64").toString("utf8");
      return out;
    },
    async put(name, data) {
      assertSecretName(name);
      // Replace what is there; create it when there is nothing yet.
      const replaced = await call("PUT", `/${name}`, body(name, data));
      if (replaced.status === 200 || replaced.status === 201) return;
      if (replaced.status !== 404) fail(replaced.status, replaced.json);
      const created = await call("POST", "", body(name, data));
      if (created.status !== 201) fail(created.status, created.json);
    },
    async delete(name) {
      const { status, json } = await call("DELETE", `/${assertSecretName(name)}`);
      if (status === 200 || status === 404) return;
      fail(status, json);
    },
  };
}
