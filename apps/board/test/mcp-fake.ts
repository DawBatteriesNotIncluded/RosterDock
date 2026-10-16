// A fake Streamable HTTP MCP server for tests: replays the recorded JSON-RPC
// shapes in fixtures/mcp over an injected fetch and records every request so
// tests can assert on the bearer header and the exact tool arguments sent.
// global.fetch is never real.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp");
const fixture = (name: string) =>
  JSON.parse(readFileSync(path.join(fixtures, name), "utf8")) as Record<string, unknown>;

export interface RecordedMcpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: { jsonrpc: string; id?: number | string; method: string; params?: Record<string, unknown> } | null;
}

export interface FakeMcp {
  fetch: typeof fetch;
  requests: RecordedMcpRequest[];
  /** tools/call requests, in order: tool name and the arguments received. */
  calls: { name: string; arguments: Record<string, unknown> }[];
  /** Fail every request with this HTTP status. */
  failWith: number | null;
  /** Answer tools/call for these tool names with the error fixture. */
  errorTools: Set<string>;
}

export function fakeMcp(): FakeMcp {
  const fake: FakeMcp = {
    requests: [],
    calls: [],
    failWith: null,
    errorTools: new Set(),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const headers: Record<string, string> = {};
      const h = init?.headers;
      if (h instanceof Headers) h.forEach((v, k) => (headers[k.toLowerCase()] = v));
      else if (Array.isArray(h)) for (const [k, v] of h) headers[k.toLowerCase()] = v;
      else if (h)
        for (const [k, v] of Object.entries(h as Record<string, string>)) headers[k.toLowerCase()] = v;
      const body = init?.body ? (JSON.parse(String(init.body)) as RecordedMcpRequest["body"]) : null;
      fake.requests.push({ url, method, headers, body });
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
      if (fake.failWith) return json(fake.failWith, { error: "fixture failure" });
      if (method === "DELETE") return new Response(null, { status: 200 });
      if (method === "GET") return new Response(null, { status: 405 });
      if (!body) return json(400, { error: "no body" });
      // Notifications (no id) are accepted with no body.
      if (body.id === undefined || body.id === null) return new Response(null, { status: 202 });
      const withId = (f: Record<string, unknown>) => ({ ...f, id: body.id });
      switch (body.method) {
        case "initialize":
          return json(200, withId(fixture("initialize.json")));
        case "tools/list":
          return json(200, withId(fixture("tools-list.json")));
        case "tools/call": {
          const name = String(body.params?.name ?? "");
          const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
          fake.calls.push({ name, arguments: args });
          if (fake.errorTools.has(name)) return json(200, withId(fixture("tools-call-error.json")));
          try {
            return json(200, withId(fixture(`tools-call-${name}.json`)));
          } catch {
            return json(200, {
              jsonrpc: "2.0",
              id: body.id,
              error: { code: -32602, message: `unknown tool ${name}` },
            });
          }
        }
        case "ping":
          return json(200, { jsonrpc: "2.0", id: body.id, result: {} });
        default:
          return json(200, {
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32601, message: `method not found: ${body.method}` },
          });
      }
    }) as typeof fetch,
  };
  return fake;
}
