// A credential out of what a service says back: an OpenAPI answer, an MCP tool's answer, error or
// description, an error the MCP SDK words from a server's body. A service may echo what it was sent, as it
// is or as JSON escapes it, and a string in its answer may carry JSON of its own (a request log, echoed
// headers), escaped again for every level it is nested.
//
// A text is searched as it is, then read one level of escapes at a time, the whole text each time, and
// searched again: nine levels at most, fewer once a level holds no escape. Every credential is searched at
// once (Aho-Corasick, built for each call from the credentials it holds), and every place one
// is found is marked in one array the size of the text, so the work and the memory are linear in the text,
// however many credentials there are and however often they occur. What is scrubbed is bounded first: a
// long text is cut before it is read, and a parsed value is walked within a budget.

/** Credentials shorter than this are never scrubbed: taking them out would blank ordinary text. */
export const SCRUB_MIN_CHARS = 6;
/** The most levels of JSON escapes read: a credential nested deeper than this is not found. */
export const SCRUB_MAX_DEPTH = 8;
/** Levels of a parsed value walked: deeper is written "[depth]", as the broker does with every result. */
export const SCRUB_MAX_NESTING = 12;
/**
 * How many characters a cut text drops per character of the longest credential: one character escaped
 * four levels deep by JSON nesting, each level doubling the backslashes of the one inside it (a slash
 * written with a backslash takes 16 there, a plus written as a six-character escape 13). An encoder that
 * writes every character of an escape as an escape again takes more than this from the second level on.
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

const isHex = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);

function hex4(s: string, at: number): number {
  let v = 0;
  for (let j = at; j < at + 4; j++) {
    const c = s.charCodeAt(j);
    if (!isHex(c)) return -1;
    v = v * 16 + (c <= 57 ? c - 48 : (c | 0x20) - 87);
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

/**
 * Where an escape the end of a text cut short begins: a run of backslashes at the very end, or one before
 * a `u` and fewer than four hex digits. The text's length when it ends on no such thing.
 */
function brokenEscape(s: string, end = s.length): number {
  let i = end;
  let digits = 0;
  while (digits < 3 && i > 0 && isHex(s.charCodeAt(i - 1))) {
    i--;
    digits++;
  }
  if (i > 1 && s.charCodeAt(i - 1) === U && s.charCodeAt(i - 2) === BACKSLASH) i--;
  else i = end;
  if (i === end || s.charCodeAt(i - 1) === BACKSLASH) while (i > 0 && s.charCodeAt(i - 1) === BACKSLASH) i--;
  return i;
}

/**
 * Where the escapes a cut broke begin, however many end the text: a level read from one cut short can end
 * in the remains of several (an escape's digits written as escapes themselves, cut off), one after another.
 */
function brokenEscapes(s: string): number {
  let end = s.length;
  for (let next = brokenEscape(s, end); next < end; next = brokenEscape(s, end)) end = next;
  return end;
}

// Every character a scrubber has searched, at every level, and every automaton built, in this process: what
// tests hold the work to, where a wall clock on a shared runner would not tell.
let searched = 0;
let built = 0;

/** How many characters scrubbers have searched in this process, every level counted. */
export function scrubbedChars(): number {
  return searched;
}

/** How many automata scrubbers have built in this process: one for each scrubber with credentials. */
export function automataBuilt(): number {
  return built;
}

/** A level: its text, and where each of its characters begins in the original (null: the same place). */
interface Level {
  s: string;
  /** from[i]: where character i begins in the original; from[s.length]: the original's length. */
  from: Uint32Array | null;
}

const origin = (level: Level, i: number) => (level.from ? level.from[i]! : i);

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
 * Every credential at once: a trie of them with failure links (Aho-Corasick), in typed arrays the size of
 * the credentials together. From the root an ASCII character goes through a table and any other through a
 * map; below it a node keeps its first child inline and any others in a map. `longest[node]`: the longest
 * credential that ends at this node's place in a text, 0 for none; `depth[node]`: how much of a credential
 * the node has read.
 */
class Automaton {
  private readonly rootAscii = new Int32Array(128);
  private readonly rootOther = new Map<number, number>();
  private char: Int32Array;
  private child: Int32Array;
  private fail: Int32Array;
  private longest: Int32Array;
  private depth: Int32Array;
  private readonly more = new Map<number, Map<number, number>>();
  readonly nodes: number;

  constructor(needles: readonly string[]) {
    built++;
    const size = needles.reduce((n, s) => n + s.length, 1);
    this.char = new Int32Array(size).fill(-1);
    this.child = new Int32Array(size);
    this.fail = new Int32Array(size);
    this.longest = new Int32Array(size);
    this.depth = new Int32Array(size);
    const firsts: number[] = [];
    let nodes = 1;
    for (const text of needles) {
      let node = 0;
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        let next = this.step(node, c);
        if (next <= 0) {
          next = nodes++;
          this.depth[next] = i + 1;
          if (node === 0) {
            if (c < 128) this.rootAscii[c] = next;
            else this.rootOther.set(c, next);
            firsts.push(next);
          } else if (this.char[node] === -1) {
            this.char[node] = c;
            this.child[node] = next;
          } else {
            let others = this.more.get(node);
            if (!others) this.more.set(node, (others = new Map()));
            others.set(c, next);
          }
        }
        node = next;
      }
      this.longest[node] = text.length;
    }
    this.nodes = nodes;
    // Credentials that share a start share nodes: the arrays keep only the nodes there are.
    this.char = this.char.slice(0, nodes);
    this.child = this.child.slice(0, nodes);
    this.fail = this.fail.slice(0, nodes);
    this.longest = this.longest.slice(0, nodes);
    this.depth = this.depth.slice(0, nodes);
    // Failure links, breadth first: a node's is the longest proper suffix of its text that is in the trie.
    const queue = firsts;
    for (let q = 0; q < queue.length; q++) {
      const u = queue[q]!;
      const link = (c: number, v: number) => {
        let f = this.fail[u]!;
        let to = this.step(f, c);
        while (to < 0) {
          f = this.fail[f]!;
          to = this.step(f, c);
        }
        this.fail[v] = to;
        this.longest[v] = Math.max(this.longest[v]!, this.longest[to]!);
        queue.push(v);
      };
      if (this.char[u]! >= 0) link(this.char[u]!, this.child[u]!);
      for (const [c, v] of this.more.get(u) ?? []) link(c, v);
    }
  }

  /** What the automaton holds in its arrays, in bytes. */
  get bytes(): number {
    return [this.char, this.child, this.fail, this.longest, this.depth].reduce((n, a) => n + a.byteLength, 0);
  }

  /** Where `c` leads from `node` in the trie: from the root always somewhere (0: the root); below it, -1 for nowhere. */
  private step(node: number, c: number): number {
    if (node === 0) return c < 128 ? this.rootAscii[c]! : (this.rootOther.get(c) ?? 0);
    if (this.char[node] === c) return this.child[node]!;
    return this.more.get(node)?.get(c) ?? -1;
  }

  /**
   * Every place a credential ends in `s`, with the longest that ends there: mark(start, end) in `s`. Returns
   * how much of a credential the text has read when it reaches `at`: what may be the start of one cut off there.
   */
  scan(s: string, mark: (start: number, end: number) => void, at = s.length): number {
    let node = 0;
    let partial = 0;
    searched += s.length;
    for (let i = 0; i < s.length; i++) {
      if (i === at) partial = this.depth[node]!;
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
    return at >= s.length ? this.depth[node]! : partial;
  }
}

export interface Scrubber {
  /** The credentials out of a text, as written or JSON-escaped up to SCRUB_MAX_DEPTH levels deep. */
  text(text: string): string;
  /**
   * A text its reader cut at a cap: scrubbed, and its end dropped from `tail` characters before it, or from
   * an escape the cut broke if that begins sooner, whatever the end holds: so what a teammate reads never
   * depends on how much of a credential a guess at it matched.
   */
  cut(text: string): string;
  /**
   * At most `max` characters of a text that may echo what a teammate sent, scrubbed. One longer than `max`
   * and `tail` more is cut there first, then dropped as `cut` drops, so the work is bounded by `max` and
   * `tail`; one shorter is scrubbed whole, and then cut to `max`.
   */
  head(text: string, max: number): string;
  /**
   * At most `max` characters of a text no teammate wrote (a tool's name or description), scrubbed, the work
   * bounded by `max`: the end is dropped from where a credential may begin that the cut fell inside, at any
   * level, or from an escape the cut broke.
   */
  prefix(text: string, max: number): string;
  /**
   * The credentials out of a parsed value: every string, every key, every number that holds one. Levels past
   * SCRUB_MAX_NESTING are written "[depth]" and never read.
   */
  value(value: unknown): unknown;
  /**
   * As `value`, within a budget of characters: strings and keys count their length, anything else a few.
   * What comes past it is left out (an array or an object ends early, a string is cut as `head` cuts), and
   * `cut` says so.
   */
  bounded(value: unknown, budget: number): { value: unknown; cut: boolean };
  /**
   * The value a JSON text holds once it is scrubbed: a credential the server wrote into it unescaped (whose
   * own backslashes JSON would read away) goes as text does. Undefined when the scrubbed text is not JSON,
   * scrubbing having broken it or not: such a text is the caller's to keep as text, through `digits`.
   */
  json(text: string): { value: unknown } | undefined;
  /**
   * A scrubbed text a teammate reads as text, its number tokens whose value is a credential of digits (with
   * its leading zeros gone, or rounded past fifteen digits) redacted as well: what `value` does for a number,
   * for a text that is not read as a value.
   */
  digits(text: string): string;
  /**
   * What a cut drops: room for the longest credential escaped as ESCAPED_CHAR_MAX allows, 256 at least, so a
   * credential the cut fell inside leaves nothing of itself.
   */
  readonly tail: number;
}

/** The text with every marked stretch written once as "[redacted]", up to `end` in it. */
function assemble(t: string, marks: Int32Array | null, end: number): string {
  if (!marks) return end >= t.length ? t : t.slice(0, end);
  let length = 0;
  for (let i = 0, open = 0; i < end; i++) {
    const was = open;
    open += marks[i]!;
    length += open ? (was ? 0 : REDACTED.length) : 1;
  }
  const codes = new Uint16Array(length);
  let k = 0;
  for (let i = 0, open = 0; i < end; i++) {
    const was = open;
    open += marks[i]!;
    if (!open) codes[k++] = t.charCodeAt(i);
    else if (!was) for (let j = 0; j < REDACTED.length; j++) codes[k++] = REDACTED.charCodeAt(j);
  }
  return fromCodes(codes, k);
}

class Scrubbing implements Scrubber {
  readonly tail: number;
  private readonly shortest: number;
  private readonly numeric: Set<number>;

  readonly automaton: Automaton | null;

  /** `given`: the credentials; `needles`: everything the automaton searches for, their decoded forms too. */
  constructor(given: readonly string[], needles: readonly string[], automaton: Automaton | null) {
    this.automaton = automaton;
    this.shortest = needles.length ? Math.min(...needles.map((n) => n.length)) : Infinity;
    this.tail = Math.max(256, Math.max(0, ...given.map((n) => n.length)) * ESCAPED_CHAR_MAX);
    // A credential of digits may come back as a JSON number: 007 as 7, twenty digits rounded.
    this.numeric = new Set(given.filter((n) => /^\d+$/.test(n)).map(Number));
  }

  /**
   * Every credential in `t` at every level, marked +1 where it begins and -1 where it ends; and, when `guard`
   * is set, where in `t` the end stops being safe to show: an escape the end broke, or a credential it may
   * have cut, at whichever level begins soonest.
   */
  private find(t: string, guard: boolean): { marks: Int32Array | null; safe: number } {
    const automaton = this.automaton;
    let marks: Int32Array | null = null;
    let safe = t.length;
    if (!automaton || (t.length < this.shortest && !guard)) return { marks, safe };
    let level: Level | null = { s: t, from: null };
    for (let depth = 0; level; depth++) {
      const current: Level = level;
      const broken = guard ? brokenEscapes(current.s) : current.s.length;
      const partial = automaton.scan(
        current.s,
        (start, end) => {
          marks ??= new Int32Array(t.length + 1);
          marks[origin(current, start)]! += 1;
          marks[origin(current, end)]! -= 1;
        },
        broken,
      );
      if (guard) safe = Math.min(safe, origin(current, broken - partial));
      if (depth === SCRUB_MAX_DEPTH || current.s.indexOf("\\") < 0) break;
      level = readLevel(current, t.length);
    }
    return { marks, safe };
  }

  text(t: string): string {
    if (!this.automaton || t.length < this.shortest) return t;
    return assemble(t, this.find(t, false).marks, t.length);
  }

  cut(t: string): string {
    const { marks } = this.find(t, false);
    return assemble(t, marks, brokenEscapes(t.slice(0, Math.max(0, t.length - this.tail))));
  }

  head(t: string, max: number): string {
    if (t.length <= max) return this.text(t);
    if (t.length <= max + this.tail) return this.text(t).slice(0, max);
    return this.cut(t.slice(0, max + this.tail)).slice(0, max);
  }

  prefix(t: string, max: number): string {
    if (t.length <= max) return this.text(t);
    const kept = t.slice(0, max);
    const { marks, safe } = this.find(kept, true);
    return assemble(kept, marks, safe);
  }

  value(v: unknown): unknown {
    return this.automaton ? this.walk(v, 0, null) : v;
  }

  bounded(v: unknown, budget: number): { value: unknown; cut: boolean } {
    const left = { chars: budget, cut: false };
    return { value: this.walk(v, 0, left), cut: left.cut };
  }

  json(t: string): { value: unknown } | undefined {
    try {
      return { value: JSON.parse(this.text(t)) as unknown };
    } catch {
      return undefined;
    }
  }

  digits(t: string): string {
    if (!this.numeric.size) return t;
    return t.replace(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (m) =>
      this.numeric.has(Number(m)) ? REDACTED : m,
    );
  }

  private walk(v: unknown, depth: number, left: { chars: number; cut: boolean } | null): unknown {
    const spend = (n: number) => {
      if (left) left.chars -= n;
    };
    if (depth > SCRUB_MAX_NESTING) {
      spend(DEPTH.length);
      return DEPTH;
    }
    if (typeof v === "string") {
      if (!left || v.length <= left.chars) {
        spend(v.length);
        return this.text(v);
      }
      left.cut = true;
      const head = this.head(v, Math.max(0, left.chars));
      left.chars = 0;
      return head;
    }
    if (typeof v === "number" || typeof v === "bigint") {
      spend(8);
      if (typeof v === "number" && this.numeric.has(v)) return REDACTED;
      const written = String(v);
      return this.text(written) === written ? v : REDACTED;
    }
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (const x of v) {
        if (left && left.chars <= 0) {
          left.cut = true;
          break;
        }
        spend(1);
        out.push(this.walk(x, depth + 1, left));
      }
      return out;
    }
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k in v) {
        if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
        // A key the budget would cut, or that uses it up (or none left), leaves its entry out: a cut key could lose the
        // name that marks its value secret, and a value under it with no budget left would pass whole.
        if (left && k.length + 1 >= left.chars) {
          left.cut = true;
          break;
        }
        spend(k.length + 1);
        out[this.text(k)] = this.walk((v as Record<string, unknown>)[k], depth + 1, left);
      }
      return out;
    }
    spend(4);
    return v;
  }
}

/**
 * A scrubber for these credentials: the ones set and long enough to tell from ordinary text. Built for each
 * call and dropped with it: nothing of a credential outlives the call that used it.
 */
export function scrubber(secrets: readonly (string | null | undefined)[]): Scrubber {
  const given = [...new Set(secrets.filter((s): s is string => !!s && s.length >= SCRUB_MIN_CHARS))];
  // A credential that holds escapes of its own (`\n`, `\"`) and that a server writes into JSON as it is
  // reads, once parsed, as what JSON makes of them: that is searched for too, level by level, each form new
  // to the search, and all of them together no more than the credentials themselves again, so the automaton
  // built for each call is at most twice their size.
  const needles = new Set(given);
  let room = given.reduce((n, c) => n + c.length, 0);
  for (const credential of given) {
    let read = credential;
    for (let i = 0; i < SCRUB_MAX_DEPTH && read.includes("\\"); i++) {
      try {
        read = JSON.parse(`"${read}"`) as string;
      } catch {
        break;
      }
      if (read.length < SCRUB_MIN_CHARS || needles.has(read)) continue;
      if (read.length > room) break;
      needles.add(read);
      room -= read.length;
    }
  }
  const all = [...needles];
  return new Scrubbing(given, all, given.length ? new Automaton(all) : null);
}

/** One text, once: scrubber(secrets).text(text). */
export function scrubText(text: string, secrets: readonly (string | null | undefined)[]): string {
  return scrubber(secrets).text(text);
}
