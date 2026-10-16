// A fake HTTP service for the OpenAPI runtime tests: replays the response
// bodies in fixtures/openapi by method and path over an injected fetch and
// records every request, so tests can assert the exact URL, headers and body
// that left the board. global.fetch is never real.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "openapi");
const fixture = (name: string) => readFileSync(path.join(fixtures, name), "utf8");

export interface RecordedHttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface FakeOpenApi {
  fetch: typeof fetch;
  requests: RecordedHttpRequest[];
  /** Answer every request with this status and a body that must never travel. */
  failWith: number | null;
  /** Answer GET /contacts with a body this many bytes long. */
  bigResponseBytes: number | null;
}

export function fakeOpenApi(): FakeOpenApi {
  const fake: FakeOpenApi = {
    requests: [],
    failWith: null,
    bigResponseBytes: null,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const headers: Record<string, string> = {};
      const h = init?.headers;
      if (h instanceof Headers) h.forEach((v, k) => (headers[k.toLowerCase()] = v));
      else if (h)
        for (const [k, v] of Object.entries(h as Record<string, string>)) headers[k.toLowerCase()] = v;
      fake.requests.push({ method, url, headers, body: init?.body ? String(init.body) : null });
      const json = (status: number, text: string) =>
        new Response(text, { status, headers: { "content-type": "application/json" } });
      if (fake.failWith)
        return json(fake.failWith, JSON.stringify({ error: "server error", secret: "should-never-travel" }));
      const { pathname } = new URL(url);
      if (method === "GET" && pathname === "/v1/contacts") {
        if (fake.bigResponseBytes)
          return json(200, JSON.stringify({ blob: "x".repeat(fake.bigResponseBytes) }));
        return json(200, fixture("contacts-list.json"));
      }
      if (method === "GET" && /^\/v1\/contacts\/[^/]+$/.test(pathname))
        return json(200, fixture("contact.json"));
      if (method === "POST" && pathname === "/v1/contacts") return json(201, fixture("contact-created.json"));
      if (method === "DELETE" && /^\/v1\/contacts\/[^/]+$/.test(pathname))
        return new Response(null, { status: 204 });
      if (method === "GET" && pathname === "/v1/reports/run") return json(200, JSON.stringify({ rows: [] }));
      return json(404, JSON.stringify({ error: `no fake for ${method} ${pathname}` }));
    }) as typeof fetch,
  };
  return fake;
}
