// How the board reaches the web: one request at a time over node's own HTTP
// client, through a lookup that resolves the name, checks every address it gets
// (address.ts) and hands the socket only those. What was checked is what the
// socket connects to, so a name that answers with a public address for the check
// and a private one for the connection (DNS rebinding) gets no second answer. No
// redirect is followed here: the caller checks every hop itself (reviews/sources.ts,
// egress.ts). The same transport carries what a company's connections, OAuth and
// webhooks send (egress.ts): a body, an answer that streams, the private addresses
// the operator lists. Tests inject a fetch and a resolver instead and never reach
// the network.

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { pipeline, Readable } from "node:stream";
import zlib from "node:zlib";
import { publicAddresses, reachableAddresses, type PrivateDestinations, type Resolve } from "./address.js";

export type { Resolve } from "./address.js";

/** What the board reads the web with: a fetch that follows no redirect, and the resolver its hops are checked with. */
export interface WebReader {
  fetch: typeof fetch;
  resolve: Resolve;
}

/** Every address the system resolver gives for a name, as the socket would get them. */
export const systemResolve: Resolve = (host) =>
  new Promise((resolve, reject) =>
    dnsLookup(host, { all: true }, (err, addresses: LookupAddress[]) =>
      err ? reject(err) : resolve(addresses.map((a) => a.address)),
    ),
  );

/**
 * A lookup for a socket: the name's addresses, only once each one is public. With the operator's list, a
 * company's destination: public, or private where the list allows it (address.ts reachableAddresses).
 */
export function guardedLookup(resolve: Resolve, allow?: PrivateDestinations): LookupFunction {
  return (hostname, options, callback) => {
    (allow ? reachableAddresses(resolve, hostname, allow) : publicAddresses(resolve, hostname)).then(
      (found) => {
        const family = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : options.family;
        const addresses = found
          .map((address) => ({ address, family: isIP(address) }))
          .filter((a) => !family || a.family === family);
        if (!addresses.length) {
          const err: NodeJS.ErrnoException = new Error(`${hostname} has no IPv${family} address`);
          err.code = "ENOTFOUND";
          callback(err, "", 0);
        } else if (options.all) callback(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      (err: Error) => callback(Object.assign(err, { code: "EREFUSED" }), "", 0),
    );
  };
}

/** A decoder for the encoding the server names, or null when the body is sent as it is. */
function decoderFor(res: http.IncomingMessage): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null {
  const encoding = String(res.headers["content-encoding"] ?? "")
    .trim()
    .toLowerCase();
  return encoding === "gzip" || encoding === "x-gzip"
    ? zlib.createGunzip()
    : encoding === "deflate"
      ? zlib.createInflate()
      : encoding === "br"
        ? zlib.createBrotliDecompress()
        : null;
}

/** What the web reader never needs and a company's destinations may: an address in the URL, kept connections. */
export interface PinnedOptions {
  /** Why an address written in the URL is not connected to, or null to connect. Default: every one is refused. */
  literal?: (address: string) => string | null;
  /** Connections kept between requests, per protocol; each socket was opened through the lookup. Default: none. */
  agents?: { http: http.Agent; https: https.Agent };
}

// Headers the transport sets itself, never a caller: Host above all, or a company could name a server
// (a credential header called Host, say) other than the one its URL reached, behind a shared ingress.
const OWN_HEADERS = [
  "host",
  "connection",
  "content-length",
  "expect",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

/** A request body as the bytes to send: a string, URL-encoded form or bytes, as the board's callers send. */
function bodyBytes(body: RequestInit["body"], headers: Record<string, string>): Buffer | null {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") {
    headers["content-type"] ??= "text/plain;charset=UTF-8";
    return Buffer.from(body, "utf8");
  }
  if (body instanceof URLSearchParams) {
    headers["content-type"] ??= "application/x-www-form-urlencoded;charset=UTF-8";
    return Buffer.from(body.toString(), "utf8");
  }
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError("only a string, a form or bytes is sent as a body");
}

/**
 * A fetch that connects through `lookup` and nothing else: one request, its body sent whole, its answer
 * streamed as it arrives (decoded when compressed), no redirect followed, no proxy. A literal address in the
 * URL is refused unless `literal` admits it, since no lookup would see it.
 */
export function pinnedFetch(lookup: LookupFunction, opts: PinnedOptions = {}): typeof fetch {
  const literal = opts.literal ?? (() => "a literal address is not fetched");
  return (input, init) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.protocol !== "http:" && url.protocol !== "https:")
        return reject(new TypeError(`${url.protocol} is not fetched`));
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const refused = isIP(host) ? literal(host) : null;
      if (refused) return reject(new TypeError(refused));
      const method = (init?.method ?? "GET").toUpperCase();
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, name) => {
        if (!OWN_HEADERS.includes(name)) headers[name] = value;
      });
      headers["accept-encoding"] = "gzip, deflate, br";
      let body: Buffer | null;
      try {
        body = bodyBytes(init?.body, headers);
      } catch (err) {
        return reject(err as Error);
      }
      if (body) headers["content-length"] = String(body.length);
      const secure = url.protocol === "https:";
      const req = (secure ? https : http).request(
        url,
        {
          method,
          headers,
          lookup,
          agent: opts.agents ? (secure ? opts.agents.https : opts.agents.http) : false,
          ...(init?.signal ? { signal: init.signal } : {}),
        },
        (res) => {
          try {
            const status = res.statusCode ?? 0;
            const out = new Headers();
            for (const [name, value] of Object.entries(res.headers))
              for (const v of [value ?? []].flat()) out.append(name, v);
            const empty = status === 204 || status === 205 || status === 304 || method === "HEAD";
            if (empty) res.on("error", () => {}).resume();
            // Decoded as it is read, so a reader that stops early stops the decoding too. What arrives is no
            // longer what the server's length and encoding described.
            const decoder = empty ? null : decoderFor(res);
            if (decoder) {
              out.delete("content-encoding");
              out.delete("content-length");
            }
            const source: Readable = decoder ? pipeline(res, decoder, () => {}) : res;
            const stream = empty ? null : (Readable.toWeb(source) as ReadableStream<Uint8Array>);
            resolve(new Response(stream, { status, statusText: res.statusMessage ?? "", headers: out }));
          } catch (err) {
            res.destroy();
            reject(err as Error);
          }
        },
      );
      req.on("error", reject);
      req.end(body ?? undefined);
    });
}

/** The board's reader: the pinned fetch over the system resolver. */
export function boardWebReader(resolve: Resolve = systemResolve): WebReader {
  return { fetch: pinnedFetch(guardedLookup(resolve)), resolve };
}
