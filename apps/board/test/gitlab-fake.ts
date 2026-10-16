// A fake GitLab REST API v4 for tests: replays recorded response shapes from
// fixtures/gitlab and records every request so tests can assert on the
// commit actions and the merge request the provider built. global.fetch is
// never real.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RecordedRequest } from "./github-fake.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "gitlab");
const fixture = (name: string) => readFileSync(path.join(fixtures, name), "utf8");

export interface FakeGitLab {
  fetch: typeof fetch;
  requests: RecordedRequest[];
  /** Base file contents served raw by GET /repository/files/:path/raw, keyed by path. */
  contents: Record<string, string>;
  /** The head branch already exists from an earlier round (DELETE answers 204 instead of 404). */
  branchExists: boolean;
  /** Fail every call with this status. */
  failWith: number | null;
}

export function fakeGitLab(contents: Record<string, string> = {}): FakeGitLab {
  const gl: FakeGitLab = {
    requests: [],
    contents,
    branchExists: false,
    failWith: null,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = Object.fromEntries(
        Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      );
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      // Paths are recorded without the API root (/api/v4), as the provider names them.
      gl.requests.push({ method, path: url.pathname.replace(/^\/api\/v4/, "") + url.search, headers, body });
      const json = (status: number, text: string) =>
        new Response(text, { status, headers: { "content-type": "application/json" } });
      if (gl.failWith) return json(gl.failWith, JSON.stringify({ message: "401 Unauthorized" }));
      const p = url.pathname;
      if (method === "GET" && /\/repository\/commits\/[0-9a-f]{40}$/.test(p))
        return json(200, fixture("commit.json"));
      if (method === "GET" && /\/repository\/files\/[^/]+\/raw$/.test(p)) {
        const file = decodeURIComponent(p.split("/repository/files/")[1]!.replace(/\/raw$/, ""));
        const text = gl.contents[file];
        if (text === undefined) return json(404, JSON.stringify({ message: "404 File Not Found" }));
        return new Response(text, { status: 200, headers: { "content-type": "text/plain" } });
      }
      if (method === "DELETE" && p.includes("/repository/branches/"))
        return gl.branchExists
          ? new Response(null, { status: 204 })
          : json(404, JSON.stringify({ message: "404 Branch Not Found" }));
      if (method === "POST" && p.endsWith("/repository/commits"))
        return json(201, fixture("commit-created.json"));
      if (method === "POST" && p.endsWith("/merge_requests")) return json(201, fixture("merge-request.json"));
      if (method === "POST" && /\/merge_requests\/\d+\/notes$/.test(p))
        return json(201, fixture("note.json"));
      if (method === "PUT" && /\/merge_requests\/\d+$/.test(p)) {
        const mr = JSON.parse(fixture("merge-request.json")) as Record<string, unknown>;
        mr.state = "closed";
        return json(200, JSON.stringify(mr));
      }
      return json(404, JSON.stringify({ message: `no fake for ${method} ${p}` }));
    }) as typeof fetch,
  };
  return gl;
}
