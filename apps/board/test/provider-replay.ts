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

/** The headers a key travels in. */
const KEY_HEADERS = ["authorization", "x-api-key", "api-key"];

/**
 * Why a request is not the one recorded, or null: its method and URL, and its headers as recorded (a key
 * where the recording has one, every other value the same, the SDK's user agent aside, which names its
 * version), with no key in a header the recording had none in.
 */
function unlike(recorded: RecordedExchange["request"], sent: SentRequest): string | null {
  if (recorded.method !== sent.method || recorded.url !== sent.url) return "another request";
  for (const [name, value] of Object.entries(recorded.headers)) {
    if (name === "user-agent") continue;
    const now = sent.headers[name];
    if (value === "<key>" ? !now : now !== value) return `the ${name} header`;
  }
  for (const name of KEY_HEADERS)
    if (sent.headers[name] !== undefined && recorded.headers[name] === undefined) return `a key in ${name}`;
  return null;
}

/**
 * A transport that answers with the recordings, in order, and keeps what was sent, and why a request was not
 * the one recorded (`misses`: the check that sent it says only that its call failed, in the board's words).
 */
export function replay(...recordings: Recording[]): {
  fetch: typeof fetch;
  sent: SentRequest[];
  misses: string[];
} {
  const queue = recordings.flatMap((r) => r.exchanges);
  const sent: SentRequest[] = [];
  const misses: string[] = [];
  const answer: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => (headers[name] = value));
    const request = { method, url, headers };
    sent.push(request);
    const next = queue.shift();
    const why = next ? unlike(next.request, request) : "nothing more";
    if (!next || why) {
      misses.push(`${method} ${url}: ${why}`);
      throw new Error(`not recorded (${why}): ${method} ${url}`);
    }
    const { status, contentType, body } = next.response;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: contentType ? { "content-type": contentType } : {},
    });
  };
  return { fetch: answer, sent, misses };
}
