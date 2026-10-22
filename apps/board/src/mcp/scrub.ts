// A credential out of what a service says back: an OpenAPI answer, an MCP tool's answer, error or
// description, an error the MCP SDK words from a server's body. A service may echo what it was sent, as it
// is or as JSON escapes it, and a string in its answer may carry JSON of its own (a request log, echoed
// headers), escaped again for every level it is nested.
//
// The text is searched as it is, then read one level of escapes at a time and searched again, eight levels
// at most. A deeper level is read only around the escapes of the one above (a credential found there and
// not above holds one), so plain stretches are read once. The search is Knuth-Morris-Pratt with each
// credential's table built once per scrubber, and a text or a stretch shorter than the shortest credential
// is not searched (reading escapes only shortens it). The work is linear in the text: nine passes over it
// at most, whatever it or the credential holds, and one pass when it has no escape.

/** Credentials shorter than this are never scrubbed: taking them out would blank ordinary text. */
export const SCRUB_MIN_CHARS = 6;
/** The most levels of JSON escapes read: a credential nested deeper than this is not found. */
export const SCRUB_MAX_DEPTH = 8;
/**
 * The most characters one character of a credential takes three levels deep, from an encoder that writes
 * every character as \uXXXX (`\u005Cu002B` for `+`): what a cut text's dropped end makes room for.
 */
export const ESCAPED_CHAR_MAX = 16;

const REDACTED = "[redacted]";
const BACKSLASH = 0x5c;
const U = 0x75;
// What a JSON escape of one character reads as, by the character after the backslash: the short escapes,
// and a slash escaped as PHP writes it. -1: not an escape.
const SHORT = new Int32Array(128).fill(-1);
for (const [k, v] of Object.entries({
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
}))
  SHORT[k.charCodeAt(0)] = v.charCodeAt(0);
// The most characters one read character takes at the level above: \uXXXX.
const ESCAPE_MAX = 6;
const utf16 = new TextDecoder("utf-16le");

/** A credential and its Knuth-Morris-Pratt table, built once. */
interface Needle {
  text: string;
  fail: Int32Array;
}

function needle(text: string): Needle {
  const fail = new Int32Array(text.length);
  for (let i = 1, k = 0; i < text.length; i++) {
    while (k > 0 && text.charCodeAt(i) !== text.charCodeAt(k)) k = fail[k - 1]!;
    if (text.charCodeAt(i) === text.charCodeAt(k)) k++;
    fail[i] = k;
  }
  return { text, fail };
}

/** Where the needle starts in `hay`, occurrences that do not overlap: O(hay). */
function occurrences(hay: string, n: Needle): number[] {
  const out: number[] = [];
  const m = n.text.length;
  for (let i = 0, k = 0; i < hay.length; i++) {
    const c = hay.charCodeAt(i);
    while (k > 0 && c !== n.text.charCodeAt(k)) k = n.fail[k - 1]!;
    if (c === n.text.charCodeAt(k)) k++;
    if (k === m) {
      out.push(i - m + 1);
      k = 0;
    }
  }
  return out;
}

/** A stretch of one level: its text, and where each of its characters begins in the original (and its end). */
interface Stretch {
  s: string;
  /** from[i]: where character i begins in the original text; from[s.length]: where the stretch ends. */
  from: Uint32Array | null;
  /** With no `from`: where the stretch begins in the original, character for character. */
  base: number;
}

const origin = (st: Stretch, i: number) => (st.from ? st.from[i]! : st.base + i);

function hex4(s: string, at: number): number {
  let v = 0;
  for (let j = at; j < at + 4; j++) {
    const c = s.charCodeAt(j);
    const d = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
    if (d < 0) return -1;
    v = v * 16 + d;
  }
  return v;
}

/** [from, to) of a stretch, one level of escapes read, each character keeping where it began in the original. */
function readLevel(st: Stretch, from: number, to: number): Stretch {
  const codes = new Uint16Array(to - from);
  const starts = new Uint32Array(to - from + 1);
  let n = 0;
  for (let i = from; i < to;) {
    let c = st.s.charCodeAt(i);
    let width = 1;
    if (c === BACKSLASH && i + 1 < to) {
      const next = st.s.charCodeAt(i + 1);
      const short = next < 128 ? SHORT[next]! : -1;
      const v = next === U && i + 6 <= to ? hex4(st.s, i + 2) : -1;
      if (v >= 0) {
        c = v;
        width = 6;
      } else if (short >= 0) {
        c = short;
        width = 2;
      }
    }
    codes[n] = c;
    starts[n] = origin(st, i);
    n++;
    i += width;
  }
  starts[n] = origin(st, to);
  return { s: utf16.decode(codes.subarray(0, n)), from: starts.subarray(0, n + 1), base: 0 };
}

/**
 * The stretches of a level worth reading one level deeper: around each backslash, as far as a credential
 * escaped there could reach, merged. None begins inside a run of backslashes, so pairs read as pairs.
 */
function aroundEscapes(s: string, longest: number): [number, number][] {
  const reach = ESCAPE_MAX * (longest + 1);
  const out: [number, number][] = [];
  for (let i = s.indexOf("\\"); i >= 0; i = s.indexOf("\\", i + 1)) {
    const to = Math.min(s.length, i + reach);
    const last = out[out.length - 1];
    const from = Math.max(0, i - reach);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    // A stretch starts afresh only with no backslash within reach before it, so never inside a run of them.
    else out.push([from, to]);
  }
  return out;
}

export interface Scrubber {
  /** The credentials out of a text, as written or JSON-escaped up to SCRUB_MAX_DEPTH levels deep. */
  text(text: string): string;
  /** The credentials out of every string, key and number in a parsed value, however deep. */
  value(value: unknown): unknown;
  /** A text cut at a cap: scrubbed, and a fixed length of its end dropped whatever it holds. */
  cut(text: string): string;
}

/** A scrubber for these credentials: the ones set and long enough to tell from ordinary text. */
export function scrubber(secrets: readonly (string | null | undefined)[]): Scrubber {
  const needles = [...new Set(secrets.filter((s): s is string => !!s && s.length >= SCRUB_MIN_CHARS))].map(
    needle,
  );
  const shortest = Math.min(...needles.map((n) => n.text.length));
  const longest = Math.max(0, ...needles.map((n) => n.text.length));
  // How much of a cut text's end is dropped: room for a whole credential escaped three levels deep, 256 at
  // least, so a credential the cut fell inside leaves nothing of itself, and what a teammate reads never
  // depends on how much of a credential a guess of it matched.
  const tail = Math.max(256, longest * ESCAPED_CHAR_MAX);

  const spans = (text: string): [number, number][] => {
    const found: [number, number][] = [];
    let level: Stretch[] = [{ s: text, from: null, base: 0 }];
    for (let depth = 0; level.length; depth++) {
      const deeper: Stretch[] = [];
      for (const st of level) {
        for (const n of needles)
          for (const at of occurrences(st.s, n)) found.push([origin(st, at), origin(st, at + n.text.length)]);
        if (depth === SCRUB_MAX_DEPTH) continue;
        for (const [from, to] of aroundEscapes(st.s, longest)) {
          if (to - from < shortest) continue;
          const read = readLevel(st, from, to);
          // Nothing read was an escape, or too little is left to hold a credential: nothing deeper.
          if (read.s.length < to - from && read.s.length >= shortest) deeper.push(read);
        }
      }
      level = deeper;
    }
    return found;
  };

  const text = (t: string): string => {
    if (!needles.length || t.length < shortest) return t;
    const found = spans(t).sort((a, b) => a[0] - b[0]);
    if (!found.length) return t;
    let out = "";
    let at = 0;
    for (const [s, e] of found) {
      if (e <= at) continue;
      out += `${t.slice(at, Math.max(at, s))}${REDACTED}`;
      at = Math.max(at, e);
    }
    return out + t.slice(at);
  };

  const holds = (t: string) => text(t) !== t;
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return text(v);
    // A credential of digits, echoed as a number.
    if (typeof v === "number" || typeof v === "bigint") return holds(String(v)) ? REDACTED : v;
    // Deeper than this, the rest is scrubbed as its JSON text, escapes read, and read back.
    if (depth > 12)
      try {
        const json = JSON.stringify(v);
        return json === undefined ? v : (JSON.parse(text(json)) as unknown);
      } catch {
        return REDACTED;
      }
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [text(k), walk(x, depth + 1)]),
      );
    return v;
  };

  return {
    text,
    value: (v) => (needles.length ? walk(v, 0) : v),
    cut: (t) => {
      const whole = text(t);
      return whole.slice(0, Math.max(0, whole.length - tail));
    },
  };
}

/** One text, once: scrubber(secrets).text(text). */
export function scrubText(text: string, secrets: readonly (string | null | undefined)[]): string {
  return scrubber(secrets).text(text);
}
