// Fetching the sources a research document cites, so the reviewer can check
// claims against them instead of trusting a heading. Bounded and guarded:
// http(s) only, public hostnames only (no literal addresses, no localhost, no
// .local or .internal names), a few redirects at most with every hop checked
// again, a timeout and a size cap per source, and only text is read. The
// fetch is injected; tests use a fake and never the network.

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
const MAX_REDIRECTS = 3;
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

/** The page's title and its text without markup, scripts or styles, collapsed and capped. */
export function summarisePage(contentType: string, body: string): { title: string | null; excerpt: string } {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  const looksHtml =
    type === "text/html" ||
    type === "application/xhtml+xml" ||
    /<(?:html|body|p|div)[\s>]/i.test(body.slice(0, 4000));
  const title = looksHtml ? pageTitle(body) : null;
  const text = looksHtml ? decodeEntities(htmlToText(body)) : body;
  // A run of whitespace is one space, or one line break when it holds one.
  const excerpt = text
    .replace(/\s+/g, (ws) => (ws.includes("\n") ? "\n" : " "))
    .trim()
    .slice(0, MAX_EXCERPT_CHARS);
  return { title: title ? decodeEntities(title).replace(/\s+/g, " ").slice(0, 200) : null, excerpt };
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, max);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(Buffer.from(value));
    total += value.length;
    if (total >= max) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, max).toString("utf8");
}

export function sourceFetcher(opts: { fetch: typeof fetch; timeoutMs?: number }): SourceFetcher {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  async function one(url: string): Promise<FetchedSource> {
    const base: FetchedSource = { url, ok: false, status: null, title: null, excerpt: null, note: null };
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const refused = refuseSourceUrl(current);
      if (refused) return { ...base, note: hop ? `redirected to ${current}: ${refused}` : refused };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let res: Response;
        try {
          res = await opts.fetch(current, {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
            headers: {
              accept: "text/html, text/plain;q=0.9, application/json;q=0.8, */*;q=0.1",
              "user-agent": "rosterdock-board (research review)",
            },
          });
        } catch (err) {
          return {
            ...base,
            note: controller.signal.aborted
              ? `no answer in ${Math.round(timeoutMs / 1000)}s`
              : `could not be reached: ${(err as Error).message.slice(0, 120)}`,
          };
        }
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get("location");
          if (!location)
            return { ...base, status: res.status, note: `answered ${res.status} with nowhere to go` };
          current = new URL(location, current).toString();
          continue;
        }
        if (!res.ok) return { ...base, status: res.status, note: `answered ${res.status}` };
        const type = res.headers.get("content-type") ?? "";
        if (!isText(type))
          return { ...base, status: res.status, note: `not text (${type.split(";")[0] || "unknown type"})` };
        let body: string;
        try {
          body = await readCapped(res, MAX_BODY_BYTES);
        } catch (err) {
          return {
            ...base,
            status: res.status,
            note: `could not be read: ${(err as Error).message.slice(0, 120)}`,
          };
        }
        const { title, excerpt } = summarisePage(type, body);
        return { url, ok: true, status: res.status, title, excerpt, note: null };
      } finally {
        clearTimeout(timer);
      }
    }
    return { ...base, note: `more than ${MAX_REDIRECTS} redirects` };
  }
  return { fetch: (urls) => Promise.all(urls.map(one)) };
}
