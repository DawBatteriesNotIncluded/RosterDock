// How the board reaches a destination a company chose: a connection's MCP
// server or OpenAPI service, the OAuth endpoints its server names, a webhook or
// an SMTP server named in Settings, and a style pack's file. Before anything is
// sent, every hop's name is resolved and every address it gets checked
// (address.ts reachableAddresses): public, or private where the operator lists
// it (ROSTERDOCK_PRIVATE_DESTINATIONS). The board's own transport then connects
// only to addresses its lookup checked the same way (transport.ts), so a name
// cannot pass with one address and connect to another. What a redirect does is
// the call site's: refused, handed back, or followed with every hop checked
// again. What the operator configures (the git hosts, OIDC, OTLP, the object
// store, the Kubernetes API, the model API, the board's own webhook and SMTP
// server) does not come through here. Tests inject the transport and the
// resolver and never reach the network.

import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import {
  NO_PRIVATE_DESTINATIONS,
  reachableAddresses,
  RefusedAddress,
  refuseDestination,
  refusedLiteral,
  type PrivateDestinations,
  type Resolve,
} from "./address.js";
import { guardedLookup, pinnedFetch, systemResolve } from "./transport.js";

/** What a company's destinations are reached with. */
export interface Egress {
  /** Sends one request and follows no redirect: the board's pinned transport, or a fake in tests. */
  fetch: typeof fetch;
  /** What every hop's name is checked with. */
  resolve: Resolve;
  /** The private destinations the operator allows. */
  allow: PrivateDestinations;
}

/** One call site's terms. */
export interface ReachOptions {
  /**
   * A redirect: `error` refuses it and names the host it pointed to (nothing is sent there), `manual` hands
   * the answer back as it is, `follow` follows three at most, every hop checked again, and drops the
   * credential headers when a hop leaves the origin.
   */
  redirect: "error" | "manual" | "follow";
  /** The whole exchange, names looked up and the body read; for a `stream`, until the answer's headers. */
  timeoutMs: number;
  /** The answer may stay open (MCP's event streams): once its headers are in, its body is the caller's to close. */
  stream?: boolean;
}

export const MAX_HOPS = 3;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];
const BODY_HEADERS = [
  "content-type",
  "content-length",
  "content-encoding",
  "content-language",
  "content-location",
];

/** A promise that rejects once the signal aborts; it is never left rejected with no one listening. */
function aborted(signal: AbortSignal): Promise<never> {
  const p = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new Error("aborted"));
    else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  p.catch(() => {});
  return p;
}

/** The host as an address or a name: without IPv6 brackets or a trailing dot. */
function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

/** Check a URL before anything is sent to it: its scheme, then its address, or every address its name has. */
async function admit(egress: Egress, url: URL, signal: AbortSignal): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new RefusedAddress(`refused: ${url.protocol.replace(":", "")} is not reached, only http and https`);
  if (url.username || url.password)
    throw new RefusedAddress("refused: a URL with credentials in it; give the credential by name instead");
  const host = hostOf(url);
  if (!host) throw new RefusedAddress("refused: the URL has no host");
  if (isIP(host)) {
    const why = refuseDestination(host, egress.allow);
    if (why) throw new RefusedAddress(refusedLiteral(host, why));
    return;
  }
  await Promise.race([reachableAddresses(egress.resolve, host, egress.allow), aborted(signal)]);
}

/**
 * A fetch for one call site: every hop checked before it is sent, the call site's redirect rule, one
 * deadline. A refusal throws RefusedAddress, whose message starts with "refused:".
 */
export function egressFetch(egress: Egress, opts: ReachOptions): typeof fetch {
  return async (input, init) => {
    let url = new URL(input instanceof Request ? input.url : String(input));
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), opts.timeoutMs);
    timer.unref();
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;
    let method = (init?.method ?? "GET").toUpperCase();
    let body = init?.body;
    const headers = new Headers(init?.headers);
    try {
      for (let hop = 0; ; hop++) {
        await admit(egress, url, signal);
        const res = await egress.fetch(url.toString(), {
          ...init,
          method,
          headers,
          body,
          redirect: "manual",
          signal,
        });
        const location = REDIRECTS.has(res.status) ? res.headers.get("location") : null;
        if (location === null || opts.redirect === "manual") {
          if (opts.stream) clearTimeout(timer);
          return res;
        }
        await res.body?.cancel().catch(() => {});
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new Error(`${url.host} answered ${res.status} with a location that is no URL`);
        }
        // Where it points goes no further than its host: a path may carry a token.
        if (opts.redirect === "error")
          throw new Error(
            `${url.host} answered ${res.status}, a redirect to ${next.host === url.host ? "another address on the same host" : next.host}, which the board does not follow here: use the address it points to`,
          );
        if (hop >= MAX_HOPS) throw new Error(`${url.host} redirected more than ${MAX_HOPS} times`);
        // As fetch does: a POST moved by 301 or 302, and anything but a read moved by 303, becomes a GET.
        if (
          (res.status === 303 && method !== "GET" && method !== "HEAD") ||
          ((res.status === 301 || res.status === 302) && method === "POST")
        ) {
          method = "GET";
          body = undefined;
          for (const h of BODY_HEADERS) headers.delete(h);
        }
        if (next.origin !== url.origin) for (const h of CREDENTIAL_HEADERS) headers.delete(h);
        url = next;
      }
    } catch (err) {
      clearTimeout(timer);
      if (deadline.signal.aborted && !init?.signal?.aborted)
        throw new Error(`${url.host} gave no answer in ${Math.round(opts.timeoutMs / 1000)}s`);
      throw err;
    }
  };
}

/** For a socket of the board's own (SMTP): a lookup that admits only what egressFetch would, and the check of an address written as the host. */
export function egressSocket(egress: Pick<Egress, "resolve" | "allow">): {
  lookup: LookupFunction;
  literal(address: string): string | null;
} {
  return {
    lookup: guardedLookup(egress.resolve, egress.allow),
    literal(address) {
      const why = refuseDestination(address, egress.allow);
      return why ? refusedLiteral(address, why) : null;
    },
  };
}

let fallback: Egress | null = null;

/** The board's own with nothing private allowed, for a caller given no egress: never a plain fetch. */
export function defaultEgress(): Egress {
  return (fallback ??= boardEgress());
}

/**
 * The board's own: the pinned transport over the system resolver, connections kept between requests (each
 * opened through the lookup), and the operator's list.
 */
export function boardEgress(
  allow: PrivateDestinations = NO_PRIVATE_DESTINATIONS,
  resolve: Resolve = systemResolve,
): Egress {
  const socket = egressSocket({ resolve, allow });
  return {
    fetch: pinnedFetch(socket.lookup, {
      literal: socket.literal,
      agents: {
        http: new http.Agent({ keepAlive: true, maxFreeSockets: 16 }),
        https: new https.Agent({ keepAlive: true, maxFreeSockets: 16 }),
      },
    }),
    resolve,
    allow,
  };
}
