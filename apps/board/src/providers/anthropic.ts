// A company's own Anthropic key, used by the board itself: an SDK client that reads nothing of the board's
// environment. The SDK's defaults take ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_CUSTOM_HEADERS and
// ANTHROPIC_LOG from where it runs, and those are the operator's: a company's request would go to the
// operator's base URL, carry the operator's token or headers, or be logged. Here the host is Anthropic's, the
// one credential is the company's key, and only the headers the API reads leave the board.

import Anthropic from "@anthropic-ai/sdk";

/** Where a company's Anthropic key goes: Anthropic's API, never a base URL the board's environment names. */
export const ANTHROPIC_API = "https://api.anthropic.com";

/** What a company's request may carry: the SDK's own headers and the key, nothing the environment added. */
const SENT =
  /^(?:accept|anthropic-beta|anthropic-version|content-length|content-type|user-agent|x-api-key|x-stainless-[a-z-]+)$/;

/** The fetch, with every header but those dropped. */
function onlySent(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    for (const name of [...headers.keys()]) if (!SENT.test(name)) headers.delete(name);
    return fetch(input, { ...init, headers });
  };
}

export interface CompanyAnthropicOptions {
  /** The company's key, resolved by the board for this call. */
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
    fetch: onlySent(opts.fetch),
    timeout: opts.timeoutMs,
    maxRetries: opts.maxRetries ?? 0,
    logLevel: "off",
  });
}
