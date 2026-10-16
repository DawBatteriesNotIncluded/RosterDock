#!/usr/bin/env node
// Records test/fixtures/kubernetes/*.json from a real API server through
// `kubectl proxy --port=8011`, in a throwaway namespace you may create
// Secrets in:
//
//   kubectl create ns rosterdock-fixtures && kubectl proxy --port=8011 &
//   node apps/board/scripts/record-kubernetes.mjs rosterdock-fixtures
//
// The forbidden and unauthorized fixtures are not recorded here (the proxy
// is you); they keep the documented Status shape. Check the files for
// anything that looks like a secret before committing them.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ns = process.argv[2] ?? "rosterdock-fixtures";
const base = process.env.KUBE_PROXY ?? "http://127.0.0.1:8011";
const name = "rosterdock-connection-0f3c2a1e-fixture";
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "kubernetes");
mkdirSync(out, { recursive: true });

const secret = (data) => ({
  apiVersion: "v1",
  kind: "Secret",
  metadata: { name, labels: { "app.kubernetes.io/managed-by": "rosterdock" } },
  type: "Opaque",
  data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Buffer.from(v).toString("base64")])),
});

async function record(file, method, route, body) {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const headers = {};
  for (const k of ["content-type"]) if (res.headers.get(k)) headers[k] = res.headers.get(k);
  // The namespace recorded is the fixture's; the fake substitutes its own.
  const normalised = text.replaceAll(ns, "rosterdock-smoke");
  writeFileSync(
    path.join(out, `${file}.json`),
    JSON.stringify({ status: res.status, headers, body: normalised }, null, 2) + "\n",
  );
  console.log(file, method, route, res.status);
}

const one = `/api/v1/namespaces/${ns}/secrets/${name}`;
const all = `/api/v1/namespaces/${ns}/secrets`;
await record("secret-missing", "GET", one);
await record(
  "secret-created",
  "POST",
  all,
  secret({ access_token: "fixture-access-1", refresh_token: "fixture-refresh-1" }),
);
await record("secret-get", "GET", one);
await record(
  "secret-replaced",
  "PUT",
  one,
  secret({ access_token: "fixture-access-2", refresh_token: "fixture-refresh-2" }),
);
await record("secret-conflict", "POST", all, secret({ access_token: "fixture-access-3" }));
await record("secret-deleted", "DELETE", one);
await record("secret-delete-missing", "DELETE", one);
