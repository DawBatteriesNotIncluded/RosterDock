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
      const url = m[0].replace(/[.,;:!?]+$/, "");
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

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

/** The page's title and its text without markup, scripts or styles, collapsed and capped. */
export function summarisePage(contentType: string, body: string): { title: string | null; excerpt: string } {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  const looksHtml =
    type === "text/html" ||
    type === "application/xhtml+xml" ||
    /<(?:html|body|p|div)[\s>]/i.test(body.slice(0, 4000));
  let title: string | null = null;
  let text = body;
  if (looksHtml) {
    title = /<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1]?.trim() || null;
    text = body
      .replace(/<head[\s\S]*?<\/head>/gi, " ")
      .replace(/<title[\s\S]*?<\/title>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(?:br|p|div|li|tr|h[1-6]|section|article)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ");
    text = decodeEntities(text);
  }
  const excerpt = text
    .replace(/[ \t\r\f]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
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
