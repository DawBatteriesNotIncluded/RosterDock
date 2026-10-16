// A fake GitHub REST API for tests: replays recorded response shapes from
// fixtures/github and records every request so tests can assert on the
// blobs, tree, commit and pull request the provider built. global.fetch is
// never real.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "github");
const fixture = (name: string) => readFileSync(path.join(fixtures, name), "utf8");

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeGitHub {
  fetch: typeof fetch;
  requests: RecordedRequest[];
  /** Base file contents served by GET /contents, keyed by path. */
  contents: Record<string, string>;
  /** Make the ref creation return 422 so the provider must force-update the branch. */
  branchExists: boolean;
  /** Fail every call with this status (network or auth problems). */
  failWith: number | null;
}

export function fakeGitHub(contents: Record<string, string> = {}): FakeGitHub {
  const gh: FakeGitHub = {
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
      gh.requests.push({ method, path: url.pathname + url.search, headers, body });
      const json = (status: number, text: string) =>
        new Response(text, { status, headers: { "content-type": "application/json" } });
      if (gh.failWith) return json(gh.failWith, JSON.stringify({ message: "Bad credentials" }));
      const p = url.pathname;
      if (method === "GET" && /\/git\/commits\/[0-9a-f]{40}$/.test(p))
        return json(200, fixture("commit.json"));
      if (method === "GET" && p.includes("/contents/")) {
        const file = decodeURIComponent(p.split("/contents/")[1]!);
        const text = gh.contents[file];
        if (text === undefined) return json(404, JSON.stringify({ message: "Not Found" }));
        const body = JSON.parse(fixture("contents.json")) as Record<string, unknown>;
        body.path = file;
        body.content = Buffer.from(text, "utf8").toString("base64");
        return json(200, JSON.stringify(body));
      }
      if (method === "POST" && p.endsWith("/git/blobs")) {
        const b = JSON.parse(fixture("blob.json")) as Record<string, unknown>;
        b.sha = `blob${String(gh.requests.length).padStart(36, "0")}`;
        return json(201, JSON.stringify(b));
      }
      if (method === "POST" && p.endsWith("/git/trees")) return json(201, fixture("tree.json"));
      if (method === "POST" && p.endsWith("/git/commits")) return json(201, fixture("commit-created.json"));
      if (method === "POST" && p.endsWith("/git/refs")) {
        if (gh.branchExists) return json(422, JSON.stringify({ message: "Reference already exists" }));
        return json(201, fixture("ref.json"));
      }
      if (method === "PATCH" && p.includes("/git/refs/heads/")) return json(200, fixture("ref.json"));
      if (method === "POST" && p.endsWith("/pulls")) return json(201, fixture("pull.json"));
      if (method === "POST" && /\/issues\/\d+\/comments$/.test(p))
        return json(201, JSON.stringify({ id: 1 }));
      if (method === "PATCH" && /\/pulls\/\d+$/.test(p)) {
        const pr = JSON.parse(fixture("pull.json")) as Record<string, unknown>;
        pr.state = "closed";
        return json(200, JSON.stringify(pr));
      }
      return json(404, JSON.stringify({ message: `no fake for ${method} ${p}` }));
    }) as typeof fetch,
  };
  return gh;
}
