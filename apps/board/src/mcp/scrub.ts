// A credential out of what a service says back: an OpenAPI answer, an MCP tool's answer, error or
// description, an error the MCP SDK words from a server's body. A service may echo what it was sent, as it
// is or as JSON escapes it, and a string in its answer may carry JSON of its own (a request log, echoed
// headers), escaped again for every level it is nested.
//
// A text is searched as it is, then read one level of escapes at a time, the whole text each time, and
// searched again: nine levels at most, fewer once a level holds no escape. Every credential is searched at
// once (Aho-Corasick, built once per scrubber), and every place one is found is marked in one array the
// size of the text, so the work and the memory are linear in the text, however many credentials there are
// and however often they occur. Callers bound the text first: an answer is cut before it is scrubbed.

/** Credentials shorter than this are never scrubbed: taking them out would blank ordinary text. */
export const SCRUB_MIN_CHARS = 6;
/** The most levels of JSON escapes read: a credential nested deeper than this is not found. */
export const SCRUB_MAX_DEPTH = 8;
/** Levels of a parsed value walked: deeper is written "[depth]", as the broker does with every result. */
export const SCRUB_MAX_NESTING = 12;
/**
 * How many characters a cut text drops per character of the longest credential: one character escaped
 * four levels deep by JSON nesting, each level doubling the backslashes of the one inside it (a slash
 * written `\/` takes 16 there, a `+` written `+` 13). An encoder that writes every character of an
 * escape as \uXXXX again takes more than this from the second level on.
 */
export const ESCAPED_CHAR_MAX = 16;

const REDACTED = "[redacted]";
const DEPTH = "[depth]";
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

/** UTF-16 code units as a string, unit for unit: a byte order mark and a lone surrogate kept as they are. */
function fromCodes(codes: Uint16Array, n: number): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i += 8192)
    parts.push(
      String.fromCharCode.apply(null, codes.subarray(i, Math.min(n, i + 8192)) as unknown as number[]),
    );
  return parts.join("");
}

/** A level: its text, and where each of its characters begins in the original (null: the same place). */
interface Level {
  s: string;
  /** from[i]: where character i begins in the original; from[s.length]: the original's length. */
  from: Uint32Array | null;
}

/** The next level: one level of escapes read, every character keeping where it began; null if none was an escape. */
function readLevel(level: Level, end: number): Level | null {
  const { s, from } = level;
  const n = s.length;
  const codes = new Uint16Array(n);
  const starts = new Uint32Array(n + 1);
  let k = 0;
  let read = false;
  for (let i = 0; i < n;) {
    let c = s.charCodeAt(i);
    let width = 1;
    if (c === BACKSLASH && i + 1 < n) {
      const next = s.charCodeAt(i + 1);
      const v = next === U && i + 6 <= n ? hex4(s, i + 2) : -1;
      const short = next < 128 ? SHORT[next]! : -1;
      if (v >= 0) {
        c = v;
        width = 6;
      } else if (short >= 0) {
        c = short;
        width = 2;
      }
    }
    if (width > 1) read = true;
    codes[k] = c;
    starts[k] = from ? from[i]! : i;
    k++;
    i += width;
  }
  if (!read) return null;
  starts[k] = end;
  return { s: fromCodes(codes, k), from: starts.subarray(0, k + 1) };
}

/**
 * Every credential at once: a trie of them with failure links (Aho-Corasick). From the root an ASCII
 * character goes through a table and any other through a map; below it a node keeps its first child inline
 * and any others in a map. `longest[node]`: the longest credential that ends at this node's place in a
 * text, 0 for none.
 */
class Automaton {
  private readonly rootAscii = new Int32Array(128);
  private readonly rootOther = new Map<number, number>();
  private readonly firsts: number[] = [];
  private readonly char: number[] = [-1];
  private readonly child: number[] = [0];
  private readonly more: (Map<number, number> | undefined)[] = [undefined];
  private readonly fail: number[] = [0];
  private readonly longest: number[] = [0];

  constructor(needles: readonly string[]) {
    for (const text of needles) {
      let node = 0;
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        let next = this.step(node, c);
        if (next <= 0) {
          next = this.char.length;
          this.char.push(-1);
          this.child.push(0);
          this.more.push(undefined);
          this.fail.push(0);
          this.longest.push(0);
          if (node === 0) {
            if (c < 128) this.rootAscii[c] = next;
            else this.rootOther.set(c, next);
            this.firsts.push(next);
          } else if (this.char[node] === -1) {
            this.char[node] = c;
            this.child[node] = next;
          } else (this.more[node] ??= new Map()).set(c, next);
        }
        node = next;
      }
      this.longest[node] = text.length;
    }
    // Failure links, breadth first: a node's is the longest proper suffix of its text that is in the trie.
    const queue = [...this.firsts];
    for (let q = 0; q < queue.length; q++) {
      const u = queue[q]!;
      for (const [c, v] of this.children(u)) {
        let f = this.fail[u]!;
        let to = this.step(f, c);
        while (to < 0) {
          f = this.fail[f]!;
          to = this.step(f, c);
        }
        this.fail[v] = to;
        this.longest[v] = Math.max(this.longest[v]!, this.longest[to]!);
        queue.push(v);
      }
    }
  }

  /** Where `c` leads from `node` in the trie: from the root always somewhere (0: the root); below it, -1 for nowhere. */
  private step(node: number, c: number): number {
    if (node === 0) return c < 128 ? this.rootAscii[c]! : (this.rootOther.get(c) ?? 0);
    if (this.char[node] === c) return this.child[node]!;
    return this.more[node]?.get(c) ?? -1;
  }

  private children(node: number): [number, number][] {
    const out: [number, number][] = [];
    if (this.char[node]! >= 0) out.push([this.char[node]!, this.child[node]!]);
    for (const e of this.more[node] ?? []) out.push(e);
    return out;
  }

  /** Every place a credential ends in `s`, with the longest that ends there: mark(start, end) in `s`. */
  scan(s: string, mark: (start: number, end: number) => void): void {
    let node = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      let to = this.step(node, c);
      while (to < 0) {
        node = this.fail[node]!;
        to = this.step(node, c);
      }
      node = to;
      const len = this.longest[node]!;
      if (len) mark(i + 1 - len, i + 1);
    }
  }
}

export interface Scrubber {
  /** The credentials out of a text, as written or JSON-escaped up to SCRUB_MAX_DEPTH levels deep. */
  text(text: string): string;
  /**
   * The credentials out of a parsed value: every string, every key, every number that holds one. Levels
   * past SCRUB_MAX_NESTING are written "[depth]" and never read.
   */
  value(value: unknown): unknown;
  /** A text cut at a cap: scrubbed, and its last `tail` characters dropped whatever they hold. */
  cut(text: string): string;
  /**
   * At most `max` characters of a text, scrubbed. A longer one is cut to `max` and `tail` more before it is
   * scrubbed, then cut as `cut` does: the work is bounded by `max`, whatever the text's length.
   */
  head(text: string, max: number): string;
  /**
   * What a cut drops: room for the longest credential escaped as ESCAPED_CHAR_MAX allows, 256 at least, so
   * a credential the cut fell inside leaves nothing of itself, and what a teammate reads never depends on
   * how much of a credential a guess of it matched. A caller cutting a text keeps this much more, scrubs,
   * then cuts.
   */
  readonly tail: number;
}

/** A scrubber for these credentials: the ones set and long enough to tell from ordinary text. */
export function scrubber(secrets: readonly (string | null | undefined)[]): Scrubber {
  const needles = [...new Set(secrets.filter((s): s is string => !!s && s.length >= SCRUB_MIN_CHARS))];
  const shortest = needles.length ? Math.min(...needles.map((n) => n.length)) : Infinity;
  const longest = Math.max(0, ...needles.map((n) => n.length));
  const tail = Math.max(256, longest * ESCAPED_CHAR_MAX);
  const automaton = needles.length ? new Automaton(needles) : null;
  // A credential of digits may come back as a JSON number: 007 as 7, twenty digits rounded.
  const numeric = needles.filter((n) => /^\d+$/.test(n)).map(Number);

  const text = (t: string): string => {
    if (!automaton || t.length < shortest) return t;
    // +1 where a credential begins, -1 where it ends, in the original text; allocated at the first one found.
    let marks: Int32Array | null = null;
    let level: Level | null = { s: t, from: null };
    for (let depth = 0; level && level.s.length >= shortest; depth++) {
      const from = level.from;
      automaton.scan(level.s, (start, end) => {
        marks ??= new Int32Array(t.length + 1);
        marks[from ? from[start]! : start]! += 1;
        marks[from ? from[end]! : end]! -= 1;
      });
      if (depth === SCRUB_MAX_DEPTH || level.s.indexOf("\\") < 0) break;
      level = readLevel(level, t.length);
    }
    if (!marks) return t;
    // The text with every marked stretch written once as "[redacted]": counted, then written, in typed arrays.
    const covered: Int32Array = marks;
    let length = 0;
    for (let i = 0, open = 0; i < t.length; i++) {
      const was = open;
      open += covered[i]!;
      length += open ? (was ? 0 : REDACTED.length) : 1;
    }
    const codes = new Uint16Array(length);
    let k = 0;
    for (let i = 0, open = 0; i < t.length; i++) {
      const was = open;
      open += covered[i]!;
      if (!open) codes[k++] = t.charCodeAt(i);
      else if (!was) for (let j = 0; j < REDACTED.length; j++) codes[k++] = REDACTED.charCodeAt(j);
    }
    return fromCodes(codes, k);
  };

  const walk = (v: unknown, depth: number): unknown => {
    if (depth > SCRUB_MAX_NESTING) return DEPTH;
    if (typeof v === "string") return text(v);
    if (typeof v === "number" || typeof v === "bigint") {
      if (typeof v === "number" && numeric.includes(v)) return REDACTED;
      const written = String(v);
      return text(written) === written ? v : REDACTED;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [text(k), walk(x, depth + 1)]),
      );
    return v;
  };

  const cut = (t: string): string => {
    const whole = text(t);
    return whole.slice(0, Math.max(0, whole.length - tail));
  };

  return {
    text,
    value: (v) => (automaton ? walk(v, 0) : v),
    cut,
    head: (t, max) => (t.length <= max ? text(t) : cut(t.slice(0, max + tail))),
    tail,
  };
}

/** One text, once: scrubber(secrets).text(text). */
export function scrubText(text: string, secrets: readonly (string | null | undefined)[]): string {
  return scrubber(secrets).text(text);
}

/**
 * A parsed value as JSON, levels past SCRUB_MAX_NESTING written "[depth]", and no longer than `limit`: the
 * whole of it when it fits, else its first `limit` characters. Never stringifies a deep subtree whole.
 */
export function jsonPrefix(value: unknown, limit: number): string {
  const parts: string[] = [];
  let length = 0;
  const put = (s: string) => {
    parts.push(s);
    length += s.length;
  };
  const write = (v: unknown, depth: number): void => {
    if (length >= limit) return;
    if (depth > SCRUB_MAX_NESTING) return put(JSON.stringify(DEPTH));
    if (Array.isArray(v)) {
      put("[");
      for (let i = 0; i < v.length && length < limit; i++) {
        if (i) put(",");
        write(v[i] ?? null, depth + 1);
      }
      return put("]");
    }
    if (v && typeof v === "object") {
      put("{");
      let first = true;
      for (const k of Object.keys(v)) {
        if (length >= limit) break;
        const x = (v as Record<string, unknown>)[k];
        if (x === undefined || typeof x === "function") continue;
        if (!first) put(",");
        first = false;
        put(`${JSON.stringify(k)}:`);
        write(x, depth + 1);
      }
      return put("}");
    }
    put(JSON.stringify(v) ?? "null");
  };
  write(value, 0);
  const json = parts.join("");
  return json.length > limit ? json.slice(0, limit) : json;
}
