// The secret store the board can write to: the file store in a temporary
// directory, the Kubernetes store against a fake API server that replays the
// documented shapes, and how the config names one. No cluster, no network.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { fileSecretStore } from "../src/secrets/file.js";
import { inClusterSecretsConfig, kubernetesSecretStore } from "../src/secrets/kubernetes.js";
import { connectionSecretName, SecretStoreError } from "../src/secrets/store.js";
import { fakeKubernetes } from "./k8s-fake.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "rosterdock-secrets-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the file secret store", () => {
  it("puts, gets, replaces and forgets, and a second store on the directory sees the same", async () => {
    const store = fileSecretStore(dir);
    const name = connectionSecretName("0F3C2A1E-0000-4000-8000-000000000001");
    expect(name).toBe("rosterdock-connection-0f3c2a1e-0000-4000-8000-000000000001");
    expect(await store.get(name)).toBeNull();
    await store.put(name, { access_token: "fixture-access-1", refresh_token: "fixture-refresh-1" });
    expect(await store.get(name)).toEqual({
      access_token: "fixture-access-1",
      refresh_token: "fixture-refresh-1",
    });
    await store.put(name, { access_token: "fixture-access-2" });
    expect(await store.get(name)).toEqual({ access_token: "fixture-access-2" });
    expect(await fileSecretStore(dir).get(name)).toEqual({ access_token: "fixture-access-2" });
    await store.delete(name);
    await store.delete(name);
    expect(await store.get(name)).toBeNull();
    await expect(store.get("../etc/passwd")).rejects.toBeInstanceOf(SecretStoreError);
    await expect(store.put("Not A Name", {})).rejects.toThrow(/not a secret name/);
  });
});

describe("the Kubernetes secret store", () => {
  const cfg = {
    apiBase: "https://10.96.0.1:443",
    namespace: "rosterdock-smoke",
    token: async () => "sa-token-fixture",
  };

  it("creates on the first put, replaces after, reads the data back decoded and deletes", async () => {
    const k8s = fakeKubernetes({ apiBase: cfg.apiBase, namespace: cfg.namespace, token: "sa-token-fixture" });
    const store = kubernetesSecretStore(cfg, { fetch: k8s.fetch });
    const name = connectionSecretName("0f3c2a1e-0000-4000-8000-000000000002");
    expect(await store.get(name)).toBeNull();
    await store.put(name, { access_token: "fixture-access-1", refresh_token: "fixture-refresh-1" });
    // A replace that finds nothing, then a create.
    expect(k8s.requests.slice(-2).map((r) => [r.method, r.path])).toEqual([
      ["PUT", `/api/v1/namespaces/rosterdock-smoke/secrets/${name}`],
      ["POST", "/api/v1/namespaces/rosterdock-smoke/secrets"],
    ]);
    const created = k8s.requests.at(-1)!;
    expect(created.headers.authorization).toBe("Bearer sa-token-fixture");
    expect(created.headers["content-type"]).toBe("application/json");
    expect(created.body).toMatchObject({
      apiVersion: "v1",
      kind: "Secret",
      type: "Opaque",
      metadata: { name, labels: { "app.kubernetes.io/managed-by": "rosterdock" } },
      data: { access_token: Buffer.from("fixture-access-1").toString("base64") },
    });
    expect(await store.get(name)).toEqual({
      access_token: "fixture-access-1",
      refresh_token: "fixture-refresh-1",
    });
    await store.put(name, { access_token: "fixture-access-2" });
    expect(k8s.requests.at(-1)!.method).toBe("PUT");
    expect(await store.get(name)).toEqual({ access_token: "fixture-access-2" });
    expect(k8s.secrets.get(name)).toEqual({ access_token: "fixture-access-2" });
    await store.delete(name);
    await store.delete(name);
    expect(await store.get(name)).toBeNull();
  });

  it("says why the server refused, without the data, and refuses a bad name before any request", async () => {
    const k8s = fakeKubernetes({ apiBase: cfg.apiBase, namespace: cfg.namespace, token: "sa-token-fixture" });
    const store = kubernetesSecretStore(cfg, { fetch: k8s.fetch });
    k8s.forbid = true;
    const err = await store
      .put("rosterdock-connection-x", { access_token: "fixture-access-9" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(SecretStoreError);
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/Forbidden: secrets "rosterdock-connection-x" is forbidden/);
    expect(err.message).not.toContain("fixture-access-9");
    k8s.forbid = false;
    const wrong = kubernetesSecretStore({ ...cfg, token: async () => "another" }, { fetch: k8s.fetch });
    await expect(wrong.get("rosterdock-connection-x")).rejects.toMatchObject({ status: 401 });
    await expect(store.get("no spaces here")).rejects.toThrow(/not a secret name/);
    expect(k8s.requests.filter((r) => r.path.includes("no spaces"))).toEqual([]);
  });

  it("finds the API server, the namespace and the token where a pod has them", async () => {
    const files: Record<string, string> = {
      "/var/run/secrets/kubernetes.io/serviceaccount/namespace": "rosterdock\n",
      "/var/run/secrets/kubernetes.io/serviceaccount/token": "sa-token-1\n",
    };
    const read = async (f: string) => {
      if (!(f in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files[f]!;
    };
    const c = await inClusterSecretsConfig(
      { KUBERNETES_SERVICE_HOST: "10.96.0.1", KUBERNETES_SERVICE_PORT: "443" },
      read,
    );
    expect(c.apiBase).toBe("https://10.96.0.1:443");
    expect(c.namespace).toBe("rosterdock");
    expect(await c.token()).toBe("sa-token-1");
    files["/var/run/secrets/kubernetes.io/serviceaccount/token"] = "sa-token-2\n";
    expect(await c.token()).toBe("sa-token-2");
    const named = await inClusterSecretsConfig(
      { KUBERNETES_SERVICE_HOST: "10.96.0.1", ROSTERDOCK_KUBERNETES_NAMESPACE: "elsewhere" },
      read,
    );
    expect(named.namespace).toBe("elsewhere");
    await expect(inClusterSecretsConfig({}, read)).rejects.toThrow(/not in a pod/);
  });
});

describe("the config names the store", () => {
  const base = { DATABASE_URL: "postgres://x" };
  it("reads ROSTERDOCK_SECRET_STORE", () => {
    expect(loadConfig(base).secretStore).toBeNull();
    expect(loadConfig({ ...base, ROSTERDOCK_SECRET_STORE: "kubernetes" }).secretStore).toEqual({
      kind: "kubernetes",
    });
    expect(
      loadConfig({ ...base, ROSTERDOCK_SECRET_STORE: "file:/var/lib/rosterdock/secrets" }).secretStore,
    ).toEqual({
      kind: "file",
      dir: "/var/lib/rosterdock/secrets",
    });
    expect(() => loadConfig({ ...base, ROSTERDOCK_SECRET_STORE: "vault" })).toThrow(
      /ROSTERDOCK_SECRET_STORE/,
    );
  });
});
