// A credential out of what a service says back: an OpenAPI answer, an MCP tool's answer or error, an error
// the MCP SDK words from a server's body. A service may echo what it was sent, as it is or as JSON escapes
// it, and a string in its answer may carry JSON of its own (a request log, echoed headers), escaped again
// for every level it is nested. Every value is found by reading the text one level of escapes at a time
// and searching each level; the search is Knuth-Morris-Pratt, so the work is linear in the text at every
// level, whatever the text or the credential holds.

/** Credentials shorter than this are never scrubbed: taking them out would blank ordinary text. */
export const SCRUB_MIN_CHARS = 6;
/** The most levels of JSON escapes read: a credential nested deeper than this is not found. */
export const SCRUB_MAX_DEPTH = 8;
/**
 * The most characters one character of a credential takes three levels deep, from an encoder that writes
 * every character as \uXXXX (`\u005Cu005Cu002B` for `+`): what a cut text's dropped end makes room for.
 */
export const ESCAPED_CHAR_MAX = 16;

const REDACTED = "[redacted]";

// What a JSON escape of one character reads as: the short escapes, a slash escaped as PHP writes it.
const SHORT_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

const HEX = /^[\da-fA-F]{4}$/;

/** Where `needle` starts in `hay`, occurrences that do not overlap: Knuth-Morris-Pratt, O(hay + needle). */
function occurrences(hay: string, needle: string): number[] {
  const m = needle.length;
  const fail = new Int32Array(m);
  for (let i = 1, k = 0; i < m; i++) {
    while (k > 0 && needle.charCodeAt(i) !== needle.charCodeAt(k)) k = fail[k - 1]!;
    if (needle.charCodeAt(i) === needle.charCodeAt(k)) k++;
    fail[i] = k;
  }
  const out: number[] = [];
  for (let i = 0, k = 0; i < hay.length; i++) {
    const c = hay.charCodeAt(i);
    while (k > 0 && c !== needle.charCodeAt(k)) k = fail[k - 1]!;
    if (c === needle.charCodeAt(k)) k++;
    if (k === m) {
      out.push(i - m + 1);
      k = 0;
    }
  }
  return out;
}

/**
 * Where the credentials are in a text, as [start, end) in the text: as written, and as JSON escapes any of
 * their characters (\uXXXX in either case, a short escape) at any depth up to SCRUB_MAX_DEPTH. Each level is
 * the one before with one level of escapes read; every read character keeps where it began in the text, and
 * the characters tile the text, so a match at any level is a span of whole escapes in it.
 */
function secretSpans(text: string, secrets: readonly string[]): [number, number][] {
  const spans: [number, number][] = [];
  let level = text;
  // Where each character of `level` begins in `text`, and text.length after the last; null: the same index.
  let from: Uint32Array | null = null;
  for (let depth = 0; ; depth++) {
    const at = (i: number) => (from ? from[i]! : i);
    for (const secret of secrets)
      for (const s of occurrences(level, secret)) spans.push([at(s), at(s + secret.length)]);
    if (depth === SCRUB_MAX_DEPTH || !level.includes("\\")) return spans;
    let read = "";
    const starts = new Uint32Array(level.length + 1);
    let n = 0;
    for (let i = 0; i < level.length;) {
      let c = level[i]!;
      let width = 1;
      if (c === "\\" && i + 1 < level.length) {
        const next = level[i + 1]!;
        if (next === "u" && HEX.test(level.slice(i + 2, i + 6))) {
          c = String.fromCharCode(parseInt(level.slice(i + 2, i + 6), 16));
          width = 6;
        } else if (next in SHORT_ESCAPES) {
          c = SHORT_ESCAPES[next]!;
          width = 2;
        }
      }
      starts[n++] = at(i);
      read += c;
      i += width;
    }
    starts[n] = text.length;
    // Nothing was an escape: no deeper level to read.
    if (read.length === level.length) return spans;
    level = read;
    from = starts.subarray(0, n + 1);
  }
}

/** The credentials worth scrubbing: set, and long enough not to blank ordinary text. */
function worth(secrets: readonly (string | null | undefined)[]): string[] {
  return [...new Set(secrets.filter((s): s is string => !!s && s.length >= SCRUB_MIN_CHARS))];
}

/** The credentials out of a text, as written or JSON-escaped at any depth. */
export function scrubText(text: string, secrets: readonly (string | null | undefined)[]): string {
  const these = worth(secrets);
  if (!these.length || !text) return text;
  const spans = secretSpans(text, these).sort((a, b) => a[0] - b[0]);
  if (!spans.length) return text;
  let out = "";
  let at = 0;
  for (const [s, e] of spans) {
    if (e <= at) continue;
    out += `${text.slice(at, Math.max(at, s))}${REDACTED}`;
    at = Math.max(at, e);
  }
  return out + text.slice(at);
}

/** The credentials out of every string in a parsed value, keys and values, as scrubText takes them out of text. */
export function scrubValue(value: unknown, secrets: readonly (string | null | undefined)[]): unknown {
  const these = worth(secrets);
  if (!these.length) return value;
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return scrubText(v, these);
    // Deeper than this, the rest is scrubbed as its JSON text, escapes read, and read back.
    if (depth > 12)
      try {
        const text = JSON.stringify(v);
        return text === undefined ? v : (JSON.parse(scrubText(text, these)) as unknown);
      } catch {
        return REDACTED;
      }
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [
          scrubText(k, these),
          walk(x, depth + 1),
        ]),
      );
    return v;
  };
  return walk(value, 0);
}

/**
 * How much of a cut text's end is dropped: room for a whole credential escaped a few levels deep, 256
 * characters at least, so a credential the cut fell inside leaves nothing of itself.
 */
export function cutTail(secrets: readonly (string | null | undefined)[]): number {
  return Math.max(256, ...worth(secrets).map((s) => s.length * ESCAPED_CHAR_MAX));
}

/**
 * Text cut at a cap: the credentials scrubbed, and a fixed length of the end dropped whatever it holds, so
 * what a teammate reads never depends on how much of a credential a guess of it matched.
 */
export function scrubCut(text: string, secrets: readonly (string | null | undefined)[]): string {
  const whole = scrubText(text, secrets);
  return whole.slice(0, Math.max(0, whole.length - cutTail(secrets)));
}
