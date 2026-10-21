// Reading a page from the web, for the board: the sources a research document
// cites, so the reviewer can check claims against them instead of trusting a
// heading, and the pages a teammate reads through the company's web connection
// (web/read.ts). Bounded and guarded: http(s) only, public hostnames only (no
// literal addresses, no localhost, no .local or .internal names), every address
// a name resolves to public (web/address.ts), a few redirects at most with every
// hop checked again, one deadline and a size cap per page, and only text is
// read; secret-shaped strings in it are redacted. The fetch and the resolver are
// injected; tests use fakes and never the network.

import { redactRawSecrets } from "@rosterdock/shared";
import { publicAddresses } from "../web/address.js";
import type { WebReader } from "../web/transport.js";

export interface FetchedSource {
  url: string;
  /** Answered 2xx with text. */
  ok: boolean;
  status: number | null;
  title: string | null;
  /** The page's text, whitespace collapsed, at most MAX_EXCERPT_CHARS. */
  excerpt: string | null;
  /** Why it was not read: refused, timed out, not text, an error, a status. */
  note: string | null;
}

export interface SourceFetcher {
  fetch(urls: string[]): Promise<FetchedSource[]>;
}

export const MAX_SOURCES = 10;
export const MAX_EXCERPT_CHARS = 1500;
const MAX_BODY_BYTES = 512 * 1024;
export const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 5000;

const URL_RE = /https?:\/\/[^\s<>()"'\]]+/g;

/** Unique http(s) links in the documents, in order of first appearance, at most MAX_SOURCES. */
export function extractSourceUrls(documents: { content: string | null }[]): string[] {
  const seen = new Set<string>();
  for (const d of documents) {
    for (const m of (d.content ?? "").matchAll(URL_RE)) {
      let end = m[0].length; // without the punctuation of the sentence around it
      while (end > 0 && ".,;:!?".includes(m[0][end - 1]!)) end--;
      const url = m[0].slice(0, end);
      seen.add(url);
      if (seen.size >= MAX_SOURCES) return [...seen];
    }
  }
  return [...seen];
}

/** Why a URL is not fetched, or null when it may be. */
export function refuseSourceUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not a URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return `${url.protocol.replace(":", "")} links are not fetched`;
  if (url.username || url.password) return "credentials in the URL";
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return "no host";
  if (host === "localhost" || host.endsWith(".localhost")) return "localhost is not fetched";
  if (host.startsWith("[") || host.includes(":") || /^[\d.]+$/.test(host))
    return "a literal address is not fetched";
  if (!host.includes(".") || /\.(local|internal|lan|home|corp|intranet|test|invalid)$/.test(host))
    return "an internal name is not fetched";
  return null;
}

/** A Content-Type's media type, as a note may quote it: printable, without parameters, at most 80 characters. */
function mediaType(contentType: string): string {
  return contentType
    .split(";")[0]!
    .trim()
    .replace(/[^\x21-\x7e]/g, "")
    .slice(0, 80);
}

function isText(contentType: string): boolean {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/xhtml+xml" ||
    type === "application/xml" ||
    type === "application/ld+json"
  );
}

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Character references, each read once: `&amp;lt;` is the text `&lt;`, not `<`. */
function decodeEntities(s: string): string {
  return s.replace(
    /&(?:(nbsp|amp|lt|gt|quot|apos)|#(\d{1,7})|#x([\da-f]{1,6}));/gi,
    (ref: string, name?: string, dec?: string, hex?: string) => {
      if (name) return ENTITIES[name.toLowerCase()]!;
      const code = dec ? Number(dec) : parseInt(hex!, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ref;
    },
  );
}

// Elements whose content is not the page's text. The title is read on its own. The rest of a
// page's head is tags, and `</head>` is optional, so the head is not skipped as one block.
const SKIPPED = ["title", "script", "style"] as const;
type Skipped = (typeof SKIPPED)[number];
// An end tag is the name followed by whitespace, a slash or `>`: `</script >` ends a script too.
const END_TAG = Object.fromEntries(SKIPPED.map((n) => [n, new RegExp(`</${n}[\\s/>]`, "gi")])) as Record<
  Skipped,
  RegExp
>;
const BLOCKS = new Set([
  "br",
  "p",
  "div",
  "li",
  "tr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "section",
  "article",
]);
const TAG_START = /[a-z/!?]/i;
const TAG_NAME = /\/?([a-z][^\s/>]*)/iy;
// A comment ends at `-->`, or at `--!>` as browsers also accept; `<!-->` is an empty one.
const COMMENT_END = /--!?>/g;

/** Where `re` next matches from `from`, or -1. */
function searchFrom(re: RegExp, s: string, from: number): number {
  re.lastIndex = from;
  return re.exec(s)?.index ?? -1;
}

function pageTitle(html: string): string | null {
  const open = /<title[\s/>]/i.exec(html);
  if (!open) return null;
  const gt = html.indexOf(">", open.index);
  const close = gt < 0 ? -1 : searchFrom(END_TAG.title, html, gt + 1);
  return close < 0 ? null : html.slice(gt + 1, close).trim() || null;
}

/**
 * The text of a page with its markup dropped. One pass with no backtracking: the page is not ours,
 * and a regular expression that backtracks can be made to take minutes on half a megabyte of it.
 * What is left over is never rendered as HTML; it only has to read well.
 */
function htmlToText(html: string): string {
  let out = "";
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    const next = html[lt + 1] ?? "";
    if (html.startsWith("<!--", lt)) {
      const end = searchFrom(COMMENT_END, html, lt + 2);
      if (end < 0) break;
      out += " ";
      i = COMMENT_END.lastIndex;
      continue;
    }
    if (!TAG_START.test(next)) {
      out += "<"; // `a < b` is text, not a tag
      i = lt + 1;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt < 0) break; // a tag the page never closes: nothing after it is text
    i = gt + 1;
    TAG_NAME.lastIndex = lt + 1;
    const name = TAG_NAME.exec(html)?.[1]?.toLowerCase() ?? "";
    const closing = next === "/";
    if (!closing && (SKIPPED as readonly string[]).includes(name)) {
      const end = searchFrom(END_TAG[name as Skipped], html, gt + 1);
      const endGt = end < 0 ? -1 : html.indexOf(">", end);
      if (endGt < 0) break;
      i = endGt + 1;
    }
    out += !closing && BLOCKS.has(name) ? "\n" : " ";
  }
  return out;
}

/** The page's title and its whole text without markup, scripts or styles, whitespace collapsed. */
export function pageText(contentType: string, body: string): { title: string | null; text: string } {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  const looksHtml =
    type === "text/html" ||
    type === "application/xhtml+xml" ||
    /<(?:html|body|p|div)[\s>]/i.test(body.slice(0, 4000));
  const title = looksHtml ? pageTitle(body) : null;
  const text = looksHtml ? decodeEntities(htmlToText(body)) : body;
  // A run of whitespace is one space, or one line break when it holds one.
  return {
    title: title ? decodeEntities(title).replace(/\s+/g, " ").slice(0, 200) : null,
    text: text.replace(/\s+/g, (ws) => (ws.includes("\n") ? "\n" : " ")).trim(),
  };
}

/** The page's title and its text without markup, scripts or styles, collapsed and capped. */
export function summarisePage(contentType: string, body: string): { title: string | null; excerpt: string } {
  const { title, text } = pageText(contentType, body);
  return { title, excerpt: text.slice(0, MAX_EXCERPT_CHARS) };
}

/** The body's first `max` bytes, as text in the charset the server named (UTF-8 otherwise). */
async function readCapped(
  res: Response,
  max: number,
  contentType: string,
): Promise<{ body: string; bytes: number; cut: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let cut = false;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(Buffer.from(value));
      total += value.length;
      if (total >= max) {
        cut = true;
        await reader.cancel().catch(() => {});
        break;
      }
    }
  }
  const bytes = Buffer.concat(chunks).subarray(0, max);
  const charset = /charset\s*=\s*"?([\w.:-]{1,40})/i.exec(contentType)?.[1];
  const decode = (label: string) => new TextDecoder(label).decode(bytes);
  let body: string;
  try {
    body = decode(charset ?? "utf-8");
  } catch {
    body = decode("utf-8"); // a charset the decoder does not know
  }
  return { body, bytes: bytes.length, cut };
}

/** The longest URL a note or a record keeps; a teammate asks for at most 2,000 characters anyway. */
export const MAX_RECORD_URL_CHARS = 2000;
// Query parameters whose values are a credential more often than not: signed URLs, tokens, sessions.
const SECRET_PARAM_WORDS = [
  "token",
  "secret",
  "password",
  "passwd",
  "pwd",
  "apikey",
  "api_key",
  "api-key",
  "credential",
  "signature",
  "auth",
  "session",
];
const SECRET_PARAM_NAMES = new Set(["key", "sig", "code", "sid"]);

function secretParam(name: string): boolean {
  const n = name.toLowerCase();
  return SECRET_PARAM_NAMES.has(n) || n.startsWith("x-amz-") || SECRET_PARAM_WORDS.some((w) => n.includes(w));
}

/**
 * A URL as a note or a record keeps it: at most MAX_RECORD_URL_CHARS, without its fragment or credentials,
 * the values of secret-named query parameters redacted, and any key-shaped string left in it (a token in the
 * path) redacted too. A note about a redirect names the hop this way, never as the server sent it.
 */
export function recordUrl(raw: string): string {
  const cut = raw.slice(0, MAX_RECORD_URL_CHARS);
  let url: URL;
  try {
    url = new URL(cut);
  } catch {
    return redactRawSecrets(cut);
  }
  url.hash = "";
  url.username = "";
  url.password = "";
  for (const name of [...new Set(url.searchParams.keys())])
    if (secretParam(name)) url.searchParams.set(name, "[redacted]");
  return redactRawSecrets(url.toString()).slice(0, MAX_RECORD_URL_CHARS);
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

/** What reading one page came to. */
export interface FetchedPage {
  /** As asked. */
  url: string;
  /** Where the last hop went, after any redirects. */
  finalUrl: string;
  /** Answered 2xx with text. */
  ok: boolean;
  status: number | null;
  contentType: string | null;
  /** Body bytes read, at most the cap. */
  bytes: number;
  /** The body reached the cap and was cut there. */
  cut: boolean;
  title: string | null;
  /** The page's whole text (of what was read), whitespace collapsed, secret-shaped strings redacted. */
  text: string | null;
  /** Why it was not read: refused, timed out, not text, an error, a status. */
  note: string | null;
}

export interface PageRequest {
  url: string;
  /** For every hop and the body together. */
  timeoutMs: number;
  maxBytes: number;
  userAgent: string;
  /** Why a host may not be read here (a company's list of sites), or null; asked again on every hop. */
  hostRefusal?: (host: string) => string | null;
}

/**
 * One page through the guard: every hop's URL and every address its name resolves to are checked before
 * anything is sent there, and redirects are followed here, never by the fetch, so none skips the check.
 */
export async function fetchPage(web: WebReader, req: PageRequest): Promise<FetchedPage> {
  const base: FetchedPage = {
    url: req.url,
    finalUrl: req.url,
    ok: false,
    status: null,
    contentType: null,
    bytes: 0,
    cut: false,
    title: null,
    text: null,
    note: null,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  // The deadline covers looking a name up too: a resolver that never answers does not hold the page.
  const deadline = aborted(controller.signal);
  const late = `no answer in ${Math.round(req.timeoutMs / 1000)}s`;
  let current = req.url;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const at = { ...base, finalUrl: current };
      const where = hop ? `redirected to ${recordUrl(current)}: ` : "";
      const refused =
        refuseSourceUrl(current) ?? req.hostRefusal?.(new URL(current).hostname.replace(/\.$/, "")) ?? null;
      if (refused) return { ...at, note: `${where}${refused}` };
      try {
        await Promise.race([
          publicAddresses(web.resolve, new URL(current).hostname.replace(/\.$/, "")),
          deadline,
        ]);
      } catch (err) {
        return { ...at, note: controller.signal.aborted ? late : `${where}${(err as Error).message}` };
      }
      let res: Response;
      try {
        res = await web.fetch(current, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            accept: "text/html, text/plain;q=0.9, application/json;q=0.8, */*;q=0.1",
            "user-agent": req.userAgent,
          },
        });
      } catch (err) {
        return {
          ...at,
          note: controller.signal.aborted
            ? late
            : `could not be reached: ${(err as Error).message.slice(0, 160)}`,
        };
      }
      const type = res.headers.get("content-type") ?? "";
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => {});
        const location = res.headers.get("location");
        if (!location)
          return { ...at, status: res.status, note: `answered ${res.status} with nowhere to go` };
        try {
          current = new URL(location, current).toString();
        } catch {
          return { ...at, status: res.status, note: `answered ${res.status} with a location that is no URL` };
        }
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return { ...at, status: res.status, contentType: type || null, note: `answered ${res.status}` };
      }
      if (!isText(type)) {
        await res.body?.cancel().catch(() => {});
        return {
          ...at,
          status: res.status,
          contentType: type || null,
          // The server's own words stay out of a note: only the media type, clipped.
          note: `not text (${mediaType(type) || "unknown type"})`,
        };
      }
      let read: Awaited<ReturnType<typeof readCapped>>;
      try {
        read = await readCapped(res, req.maxBytes, type);
      } catch (err) {
        return {
          ...at,
          status: res.status,
          contentType: type,
          note: controller.signal.aborted
            ? late
            : `could not be read: ${(err as Error).message.slice(0, 120)}`,
        };
      }
      const { title, text } = pageText(type, read.body);
      return {
        ...at,
        ok: true,
        status: res.status,
        contentType: type,
        bytes: read.bytes,
        cut: read.cut,
        title: title === null ? null : redactRawSecrets(title),
        text: redactRawSecrets(text),
      };
    }
    return { ...base, finalUrl: current, note: `more than ${MAX_REDIRECTS} redirects` };
  } finally {
    clearTimeout(timer);
  }
}

export function sourceFetcher(web: WebReader, opts: { timeoutMs?: number } = {}): SourceFetcher {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  async function one(url: string): Promise<FetchedSource> {
    const page = await fetchPage(web, {
      url,
      timeoutMs,
      maxBytes: MAX_BODY_BYTES,
      userAgent: "rosterdock-board (research review)",
    });
    return {
      url,
      ok: page.ok,
      status: page.status,
      title: page.title,
      excerpt: page.text === null ? null : page.text.slice(0, MAX_EXCERPT_CHARS),
      note: page.note,
    };
  }
  return { fetch: (urls) => Promise.all(urls.map(one)) };
}
