// A fake Anthropic Messages API for tests: replays recorded response shapes
// from fixtures/anthropic in the order queued and records every request so
// tests can assert on the model, the system prompt and the output format
// Peter asked for. global.fetch is never real.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "anthropic");

export interface RecordedModelRequest {
  path: string;
  headers: Record<string, string>;
  body: {
    model: string;
    max_tokens: number;
    system?: string;
    messages: { role: string; content: string }[];
    output_config?: { format?: { type: string; schema?: unknown } };
  };
}

export interface FakeAnthropic {
  fetch: typeof fetch;
  requests: RecordedModelRequest[];
  /** Fixture file names to answer the next calls with, in order. Empty: 500. */
  queue: string[];
}

export function fakeAnthropic(queue: string[] = []): FakeAnthropic {
  const fake: FakeAnthropic = {
    requests: [],
    queue: [...queue],
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const headers: Record<string, string> = {};
      const h = init?.headers;
      if (h instanceof Headers) h.forEach((v, k) => (headers[k.toLowerCase()] = v));
      else if (h)
        for (const [k, v] of Object.entries(h as Record<string, string>)) headers[k.toLowerCase()] = v;
      const body = init?.body ? (JSON.parse(String(init.body)) as RecordedModelRequest["body"]) : undefined;
      fake.requests.push({ path: url.pathname, headers, body: body! });
      const next = fake.queue.shift();
      if (!next) {
        return new Response(
          JSON.stringify({ type: "error", error: { type: "api_error", message: "no fixture queued" } }),
          {
            status: 500,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(readFileSync(path.join(fixtures, next), "utf8"), {
        status: 200,
        headers: { "content-type": "application/json", "request-id": `req_${next}` },
      });
    }) as typeof fetch,
  };
  return fake;
}
