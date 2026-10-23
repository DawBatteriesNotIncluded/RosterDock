// A company's own Anthropic key, used by the board itself: an SDK client that takes nothing of the board's
// environment into a request. The SDK's defaults read ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN,
// ANTHROPIC_CUSTOM_HEADERS and ANTHROPIC_LOG from where it runs, and those are the operator's: a company's
// request would go to the operator's base URL, carry the operator's token, or headers that replace the
// company's key (the SDK applies custom headers after the key), or be logged. Here the host is Anthropic's,
// and every request's headers are set anew: the company's key, the API version this SDK speaks, and only
// the SDK's own user agent and body type besides.

import Anthropic from "@anthropic-ai/sdk";

/** Where a company's Anthropic key goes: Anthropic's API, never a base URL the board's environment names. */
export const ANTHROPIC_API = "https://api.anthropic.com";

/** The API version this SDK speaks (what it sends itself); a recording's requests carry it. */
export const ANTHROPIC_VERSION = "2023-06-01";

/** The fetch, sending exactly these headers whatever the SDK, or the environment through it, put there. */
function companyHeaders(fetch: typeof globalThis.fetch, apiKey: string): typeof globalThis.fetch {
  return (input, init) => {
    const given = new Headers(init?.headers);
    const headers = new Headers({
      accept: "application/json",
      "anthropic-version": ANTHROPIC_VERSION,
      "x-api-key": apiKey,
    });
    const agent = given.get("user-agent");
    if (agent && /^Anthropic\/JS [\w.+-]+$/.test(agent)) headers.set("user-agent", agent);
    if (given.get("content-type") === "application/json") headers.set("content-type", "application/json");
    return fetch(input, { ...init, headers });
  };
}

export interface CompanyAnthropicOptions {
  /** The company's key, resolved by the board for this call; one line of printable text (check.ts). */
  apiKey: string;
  /** The company's egress: the address guard, the redirect rule and the caps of the call site. */
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
  maxRetries?: number;
}

/** An SDK client for one company's key, and nothing of the board's. */
export function companyAnthropic(opts: CompanyAnthropicOptions): Anthropic {
  return new Anthropic({
    apiKey: opts.apiKey,
    authToken: null,
    webhookKey: null,
    baseURL: ANTHROPIC_API,
    fetch: companyHeaders(opts.fetch, opts.apiKey),
    timeout: opts.timeoutMs,
    maxRetries: opts.maxRetries ?? 0,
    logLevel: "off",
  });
}
