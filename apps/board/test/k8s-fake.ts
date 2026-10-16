// A fake Kubernetes API server for the Secret operations the board's secret
// store makes: replays the shapes in fixtures/kubernetes over an injected
// fetch, keeps the Secrets put so a GET returns them, checks the bearer and
// the namespace the way the API server would, and records every request.
// global.fetch is never real.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "kubernetes");
interface Recorded {
  status: number;
  headers: Record<string, string>;
  body: string;
}
const fixture = (name: string): Recorded =>
  JSON.parse(readFileSync(path.join(fixtures, `${name}.json`), "utf8"));
const FIXTURE_NAME = "rosterdock-connection-0f3c2a1e-fixture";

export interface RecordedK8sRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

export interface FakeKubernetes {
  fetch: typeof fetch;
  requests: RecordedK8sRequest[];
  /** Secrets by name, data decoded. */
  secrets: Map<string, Record<string, string>>;
  /** Answer everything with the forbidden Status (a service account without the Role). */
  forbid: boolean;
}

export function fakeKubernetes(opts: { apiBase: string; namespace: string; token: string }): FakeKubernetes {
  const prefix = `/api/v1/namespaces/${opts.namespace}/secrets`;
  const fake: FakeKubernetes = {
    requests: [],
    secrets: new Map(),
    forbid: false,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = Object.fromEntries(
        Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      );
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      fake.requests.push({ method, path: url.pathname, headers, body });
      const replay = (name: string, edit?: (parsed: Record<string, unknown>) => void) => {
        const r = fixture(name);
        const parsed = JSON.parse(r.body) as Record<string, unknown>;
        edit?.(parsed);
        return new Response(JSON.stringify(parsed), { status: r.status, headers: r.headers });
      };
      if (url.origin !== new URL(opts.apiBase).origin) return new Response("wrong host", { status: 502 });
      if (headers.authorization !== `Bearer ${opts.token}`) return replay("unauthorized");
      if (!url.pathname.startsWith(prefix)) return new Response("not found", { status: 404 });
      const name = url.pathname.slice(prefix.length + 1) || null;
      const rename = (parsed: Record<string, unknown>, n: string) => {
        const meta = parsed.metadata as Record<string, unknown> | undefined;
        if (meta) meta.name = n;
        if (typeof parsed.message === "string") parsed.message = parsed.message.replaceAll(FIXTURE_NAME, n);
        const details = parsed.details as Record<string, unknown> | undefined;
        if (details) details.name = n;
      };
      const encode = (data: Record<string, string>) =>
        Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Buffer.from(v).toString("base64")]));
      const decode = (data: unknown) =>
        Object.fromEntries(
          Object.entries((data ?? {}) as Record<string, string>).map(([k, v]) => [
            k,
            Buffer.from(v, "base64").toString("utf8"),
          ]),
        );
      if (fake.forbid) return replay("secret-forbidden", (p) => rename(p, name ?? FIXTURE_NAME));
      if (method === "GET" && name) {
        const have = fake.secrets.get(name);
        if (!have) return replay("secret-missing", (p) => rename(p, name));
        return replay("secret-get", (p) => {
          rename(p, name);
          p.data = encode(have);
        });
      }
      if (method === "POST" && !name && body) {
        const n = String((body.metadata as Record<string, unknown>).name);
        if (fake.secrets.has(n)) return replay("secret-conflict", (p) => rename(p, n));
        fake.secrets.set(n, decode(body.data));
        return replay("secret-created", (p) => {
          rename(p, n);
          p.data = body.data;
        });
      }
      if (method === "PUT" && name && body) {
        if (!fake.secrets.has(name)) return replay("secret-missing", (p) => rename(p, name));
        fake.secrets.set(name, decode(body.data));
        return replay("secret-replaced", (p) => {
          rename(p, name);
          p.data = body.data;
        });
      }
      if (method === "DELETE" && name) {
        if (!fake.secrets.delete(name)) return replay("secret-delete-missing", (p) => rename(p, name));
        return replay("secret-deleted", (p) => rename(p, name));
      }
      return new Response("method not allowed", { status: 405 });
    }) as typeof fetch,
  };
  return fake;
}
