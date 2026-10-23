// Replays what a model provider answered the board's Check, as scripts/record-provider-checks.mts recorded it
// in fixtures/providers: every request the board sends must be the next one recorded (its method and URL), and
// gets the answer recorded for it. Each request is kept, headers and all, so a test can say which key went
// where. Nothing here is written by hand: a request the recording does not have fails the check that sent it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CompatibleAuthHeader, ProviderKind } from "@rosterdock/shared";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "providers");

export interface RecordedExchange {
  request: { method: string; url: string; headers: Record<string, string> };
  response: { status: number; contentType: string | null; body: unknown };
}

/** One check as recorded: the provider's settings it was made against, and each request with its answer. */
export interface Recording {
  recorded: string;
  kind: ProviderKind;
  provider: { endpoint: string | null; region: string | null; authHeader: CompatibleAuthHeader | null };
  exchanges: RecordedExchange[];
}

export function recording(name: string): Recording {
  return JSON.parse(readFileSync(path.join(fixtures, name), "utf8")) as Recording;
}

export interface SentRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
}

/** A transport that answers with the recordings, in order, and keeps what was sent. */
export function replay(...recordings: Recording[]): { fetch: typeof fetch; sent: SentRequest[] } {
  const queue = recordings.flatMap((r) => r.exchanges);
  const sent: SentRequest[] = [];
  const answer: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => (headers[name] = value));
    sent.push({ method, url, headers });
    const next = queue.shift();
    if (!next || next.request.method !== method || next.request.url !== url)
      throw new Error(`not recorded: ${method} ${url}`);
    const { status, contentType, body } = next.response;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: contentType ? { "content-type": contentType } : {},
    });
  };
  return { fetch: answer, sent };
}
