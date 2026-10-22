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
import { forCompany } from "@rosterdock/shared";
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
  /** The private destinations the operator allows; one company's own count only once narrowed to it (companyEgress). */
  allow: PrivateDestinations;
  /** This egress as one company has it; see companyEgress. */
  forCompany?(companyId: string): Egress;
}

/**
 * What one company reaches: the operator's list narrowed to it (every company's entries and its own). On the
 * board's own transport, a company with entries of its own also gets a lookup and kept connections that are
 * its alone, so no other company reaches its destination through a reused connection or a name that changes
 * its answer. Narrowed again, it starts from the whole list, never from another company's.
 */
export function companyEgress(egress: Egress, companyId: string): Egress {
  if (egress.forCompany) return egress.forCompany(companyId);
  return {
    fetch: egress.fetch,
    resolve: egress.resolve,
    allow: forCompany(egress.allow, companyId),
    forCompany: (other) => companyEgress(egress, other),
  };
}

/** One call site's terms. */
export interface ReachOptions {
  /**
   * A redirect: `error` refuses it and names the server it pointed to, never the path (nothing is sent
   * there); `manual` hands the answer back as it is; `same-origin` follows a hop that stays on the origin (or
   * moves the same host from http to https on the default ports) with every header kept and the request as
   * it was sent, and refuses one that leaves it or would turn the request into a GET (a 301, 302 or 303 to
   * anything but a read); `follow`
   * follows any, and a hop that leaves the origin keeps only the headers that say what is wanted. Three hops
   * at most, every one checked again.
   */
  redirect: "error" | "manual" | "same-origin" | "follow";
  /** The whole exchange, names looked up and the body read; for a `stream`, until the answer's headers. */
  timeoutMs: number;
  /** The answer may stay open (MCP's event streams): once its headers are in, its body is the caller's to close. */
  stream?: boolean;
  /**
   * The most of the answer's body that is read, decoded (an event stream counts every event). Past it the
   * body ends with an error, so nothing a server compresses can fill the board's memory. A caller that keeps
   * the start of a longer answer reads it with readCapped and gives one byte more here.
   */
  maxBytes: number;
}

export const MAX_HOPS = 3;
/** How long a kept connection waits idle before it closes. */
const IDLE_MS = 4000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
// What a hop to another origin keeps: nothing that could be a credential, whatever the header is called.
const CROSS_ORIGIN_HEADERS = ["accept", "accept-language", "user-agent", "content-type", "content-language"];
const BODY_HEADERS = [
  "content-type",
  "content-length",
  "content-encoding",
  "content-language",
  "content-location",
];

/** What to give a connection whose server moved it within itself, without naming a path. */
function sameServerHint(from: URL, to: URL): string {
  const upgrade = from.protocol === "http:" && to.protocol === "https:";
  const path = (u: URL) => u.pathname.replace(/\/+$/, "");
  const samePath = from.pathname === to.pathname && from.search === to.search;
  const slashOnly = !samePath && path(from) === path(to) && from.search === to.search;
  if (upgrade && samePath) return "give the connection its address over https";
  if (slashOnly)
    return `give the connection its address ${upgrade ? "over https and " : ""}${to.pathname.endsWith("/") ? "with" : "without"} the trailing slash`;
  return "give the connection the address it points to, on the same server";
}

/** Where a refused redirect pointed, for a person: the server, or the kind of URL; never a path. */
function redirectTarget(from: URL, to: URL): string {
  if (to.protocol !== "http:" && to.protocol !== "https:") return `a ${to.protocol.replace(":", "")} URL`;
  return to.origin === from.origin ? "another address on the same server" : to.origin;
}

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
          return capped(res, opts.maxBytes, url.host);
        }
        await res.body?.cancel().catch(() => {});
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new Error(`${url.host} answered ${res.status} with a location that is no URL`);
        }
        // The same server: the same origin, or the same host moving from http to https on the default ports.
        const sameOrigin =
          next.origin === url.origin ||
          (url.protocol === "http:" &&
            next.protocol === "https:" &&
            next.hostname === url.hostname &&
            url.port === "" &&
            next.port === "");
        if (opts.redirect === "error" || (opts.redirect === "same-origin" && !sameOrigin))
          throw new Error(
            `${url.host} answered ${res.status}, a redirect to ${redirectTarget(url, next)}, which the board does not follow here: use the address it points to`,
          );
        if (hop >= MAX_HOPS) throw new Error(`${url.host} redirected more than ${MAX_HOPS} times`);
        // As fetch does: a POST moved by 301 or 302, and anything but a read moved by 303, becomes a GET.
        const toGet =
          (res.status === 303 && method !== "GET" && method !== "HEAD") ||
          ((res.status === 301 || res.status === 302) && method === "POST");
        // A call that must arrive as it was sent (MCP's JSON-RPC) is refused instead, saying what to change
        // without naming a path, which may carry a token.
        if (toGet && opts.redirect === "same-origin")
          throw new Error(
            `${url.host} answered ${res.status} to a ${method}, which would arrive as a GET without its body: ${sameServerHint(url, next)}`,
          );
        if (toGet) {
          method = "GET";
          body = undefined;
          for (const h of BODY_HEADERS) headers.delete(h);
        }
        if (!sameOrigin)
          for (const h of [...headers.keys()]) if (!CROSS_ORIGIN_HEADERS.includes(h)) headers.delete(h);
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

/** How an answer past its cap ends, so a caller that sees only a wrapped message (an SDK's) can tell it. */
export const READ_NO_FURTHER = "the board read no further";

/** A size for a person: 8 MB, 256 KB. */
function sizePhrase(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.round(bytes / 1024)} KB`;
}

/**
 * The answer with its body cut at `max` bytes: what fits is handed on, then the body ends with an error and
 * nothing more is read from the server.
 */
function capped(res: Response, max: number, host: string): Response {
  if (!res.body) return res;
  const reader = res.body.getReader();
  let total = 0;
  let over = false;
  const tooBig = () => new Error(`${host} answered more than ${sizePhrase(max)}; ${READ_NO_FURTHER}`);
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (over) return controller.error(tooBig());
      const { done, value } = await reader.read();
      if (done) return controller.close();
      if (total + value.byteLength <= max) {
        total += value.byteLength;
        return controller.enqueue(value);
      }
      // What still fits goes on; the next read is the error.
      over = true;
      const room = max - total;
      total = max;
      await reader.cancel().catch(() => {});
      if (room > 0) controller.enqueue(value.subarray(0, room));
      else controller.error(tooBig());
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/**
 * The start of an answer's body, at most `max` bytes, and whether there was more: what was read past it is
 * dropped and the rest is never read. Give the egress `max + 1` as its cap.
 */
export async function readCapped(res: Response, max: number): Promise<{ bytes: Uint8Array; cut: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(), cut: false };
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return { bytes: Buffer.concat(parts).subarray(0, max), cut: true };
    }
  }
  return { bytes: Buffer.concat(parts), cut: false };
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
  const transport = (list: PrivateDestinations): typeof fetch => {
    const socket = egressSocket({ resolve, allow: list });
    return pinnedFetch(socket.lookup, {
      literal: socket.literal,
      agents: {
        // An idle connection closes after a few seconds, as fetch's do; one in use is the caller's.
        http: new http.Agent({ keepAlive: true, maxFreeSockets: 16, timeout: IDLE_MS }),
        https: new https.Agent({ keepAlive: true, maxFreeSockets: 16, timeout: IDLE_MS }),
      },
    });
  };
  // Every company's entries: what the rules read of a list nobody narrowed.
  const shared = transport(allow);
  const own = new Map<string, typeof fetch>();
  const board: Egress = {
    fetch: shared,
    resolve,
    allow,
    forCompany(companyId) {
      const id = companyId.toLowerCase();
      const list = forCompany(allow, id);
      let fetch = shared;
      if (allow.companies?.[id]) {
        fetch = own.get(id) ?? transport(list);
        own.set(id, fetch);
      }
      return { fetch, resolve, allow: list, forCompany: (other) => board.forCompany!(other) };
    },
  };
  return board;
}
