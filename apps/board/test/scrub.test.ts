// What a service says back loses the credential: as written, JSON-escaped at any depth up to eight, in
// text and in parsed values, numbers too, never a credential too short to tell from ordinary text. The
// work and the memory stay linear in what is scrubbed, however many credentials there are, however long or
// often they occur; and a plain reference reader, level by level, agrees with it on every fuzzed case.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { automataBuilt, scrubbedChars, scrubber, scrubSteps, scrubText } from "../src/mcp/scrub.js";

const secret = "AbC+dEf+GhI/jKl=";

describe("scrubbing a credential", () => {
  it("finds it as written and escaped, one level or several, and finds every credential given", () => {
    expect(scrubText(`a ${secret} b`, [secret])).toBe("a [redacted] b");
    expect(scrubText("a AbC\\u002BdEf\\u002bGhI\\/jKl= b", [secret])).toBe("a [redacted] b");
    // Escaped by .NET and PHP, then carried as JSON in a string three times over: four levels to read.
    let nested = '{"authorization":"Bearer AbC\\u002BdEf\\u002BGhI\\/jKl="}';
    for (let i = 0; i < 3; i++) nested = JSON.stringify({ nested });
    expect(nested).not.toContain(secret);
    const scrubbed = scrubText(`${"plain ".repeat(5000)}${nested}${" plain".repeat(5000)}`, [secret]);
    expect(scrubbed).not.toMatch(/AbC|dEf|GhI/);
    let unwrapped: unknown = JSON.parse(scrubbed.slice(6 * 5000, scrubbed.length - 6 * 5000));
    for (let i = 0; i < 3; i++) unwrapped = JSON.parse((unwrapped as { nested: string }).nested);
    expect(unwrapped).toEqual({ authorization: "Bearer [redacted]" });
    expect(scrubText(`x ${secret} y other-secret-0000`, [secret, "other-secret-0000", null])).toBe(
      "x [redacted] y [redacted]",
    );
    // One credential inside another's place, and a credential that overlaps itself: all of it goes.
    expect(scrubText("abcabcabc!", ["abcabc"])).toBe("[redacted]!");
    // Shorter than 6: never, or every "abc" in an answer would go.
    expect(scrubText("abc abc", ["abc"])).toBe("abc abc");
  });

  it("keeps every character in its place at every level: a byte order mark, a surrogate escaped apart, eight levels down", () => {
    // A byte order mark first, as text and as an escape read one level down.
    expect(scrubText("\uFEFFAbC\\u002BdEf\\u002BGhI\\/jKl= tail", [secret])).toBe("\uFEFF[redacted] tail");
    expect(scrubText("\\uFEFFAbC\\\\u002BdEf\\\\u002BGhI\\\\/jKl= tail", [secret])).toBe(
      "\\uFEFF[redacted] tail",
    );
    // An astral character whose two halves are escaped at different depths: the pair forms two levels down.
    const astral = "x\u{1F600}yzab";
    expect(scrubText("before x\\uD83D\\\\uDE00yzab after", [astral])).toBe("before [redacted] after");
    // A six-character credential eight levels down, its backslash written as \ at every level.
    let cascade = "Ab\\u002Bc/d";
    for (let i = 0; i < 7; i++) cascade = cascade.split("\\").join("\\u005C");
    expect(scrubText(`${"z".repeat(300)}${cascade}${"z".repeat(300)}`, ["Ab+c/d"])).toBe(
      `${"z".repeat(300)}[redacted]${"z".repeat(300)}`,
    );
  });

  it("takes it out of a parsed value, keys and numbers too, and writes what is past twelve levels as the broker does", () => {
    const clean = scrubber([secret]);
    expect(clean.value({ token: `Bearer ${secret}`, [secret]: 1, list: [secret] })).toEqual({
      token: "Bearer [redacted]",
      "[redacted]": 1,
      list: ["[redacted]"],
    });
    let deep: unknown = secret;
    for (let i = 0; i < 30; i++) deep = [deep];
    let out = clean.value(deep);
    for (let i = 0; i < 13; i++) out = (out as unknown[])[0];
    expect(out).toBe("[depth]");
    // A credential of digits echoed as a number: within it, as its value with leading zeros gone, and past
    // fifteen digits, where JSON.parse rounds it the same way.
    expect(scrubber(["12345678"]).value({ pin: 12345678, also: 912345678, n: 7, s: "x12345678" })).toEqual({
      pin: "[redacted]",
      also: "[redacted]",
      n: 7,
      s: "x[redacted]",
    });
    expect(scrubber(["00123456"]).value({ pin: 123456 })).toEqual({ pin: "[redacted]" });
    const long = "12345678901234567890";
    expect(scrubber([long]).value(JSON.parse(`{"pin":${long}}`))).toEqual({ pin: "[redacted]" });
  });

  it("cuts a text its reader cut, never through an escape, the same whatever a guess at the credential matched", () => {
    const clean = scrubber([secret]);
    expect(clean.tail).toBe(16 * secret.length);
    expect(scrubber(["short1"]).tail).toBe(256);
    const text = `${"x".repeat(1000)}AbC\\\\u002BdEf`;
    expect(clean.cut(text)).toBe("x".repeat(text.length - clean.tail));
    // A run of backslashes the cut falls inside goes whole: what follows it was cut off.
    expect(scrubber(["short1"]).cut(`${"x".repeat(300)}${"\\".repeat(20)}${"y".repeat(246)}`)).toBe(
      "x".repeat(300),
    );
  });

  it("keeps the head of a text that may echo a teammate: scrubbed whole when it is short, cut first when it is long", () => {
    const clean = scrubber([secret]);
    expect(clean.head("short text", 100)).toBe("short text");
    // Longer than `max` and the tail: only that much is read, and what comes back is no longer than `max`.
    const long = `${"y".repeat(900)}${secret}${"y".repeat(1_000_000)}`;
    expect(clean.head(long, 1000)).toBe(
      `${"y".repeat(900)}[redacted]${"y".repeat(1000 - 900 - secret.length)}`,
    );
    // Longer than `max` but within the tail: nothing was cut, so nothing is dropped but past `max`. With a
    // token as long as a JWT the tail is 32 KB, and a 2,500-character description came back empty.
    const jwt = `eyJ${"a".repeat(2045)}`;
    const token = scrubber([jwt]);
    expect(token.head("a".repeat(2500), 2000)).toBe("a".repeat(2000));
    expect(token.head(`${"b".repeat(1990)}${jwt}${"b".repeat(500)}`, 2000)).toBe(
      `${"b".repeat(1990)}[redacted]`,
    );
    // Eight megabytes with a run of 256 backslashes all through it: only the head and the tail are read.
    const runs = `${"plain words, ".repeat(10)}${"\\".repeat(256)}x`.repeat(25_000);
    const before = scrubbedChars();
    clean.head(runs, 200_000);
    expect(scrubbedChars() - before).toBeLessThan(9 * (200_000 + clean.tail));
  });

  it("keeps the head of a text no teammate wrote, its end dropped where a credential may have been cut, at any level", () => {
    const clean = scrubber([secret]);
    expect(clean.prefix("y".repeat(5000), 2000)).toBe("y".repeat(2000));
    // Cut inside the credential as written, inside it escaped, inside an escape, and three levels down.
    expect(clean.prefix(`${"z".repeat(1995)}${secret}`, 2000)).toBe("z".repeat(1995));
    expect(clean.prefix(`${"z".repeat(1990)}AbC\\u002BdEf\\u002BGhI\\/jKl=`, 2000)).toBe("z".repeat(1990));
    expect(clean.prefix(`${"z".repeat(1996)}\\u002Bmore`, 2000)).toBe("z".repeat(1996));
    let deep = "AbC\\u002BdEf\\u002BGhI\\/jKl=";
    for (let i = 0; i < 2; i++) deep = JSON.stringify(deep).slice(1, -1);
    expect(clean.prefix(`${"z".repeat(1980)}${deep}`, 2000)).toBe("z".repeat(1980));
    // What only looks like the start of something is kept, and a credential whole before the cut is redacted.
    expect(clean.prefix(`${"z".repeat(1995)}QQQQQQQQ`, 2000)).toBe(`${"z".repeat(1995)}QQQQQ`);
    expect(clean.prefix(`${secret}${"z".repeat(3000)}`, 2000)).toBe(`[redacted]${"z".repeat(2000 - 16)}`);
    // A level that ends in two broken escapes: a text whose every character is written as an escape, cut
    // anywhere in the credential, never shows four characters of it at any level.
    const every = (t: string) =>
      Array.from({ length: t.length }, (_, i) => `\\u${t.charCodeAt(i).toString(16).padStart(4, "0")}`).join(
        "",
      );
    const outer = every(`zz ${"AbC\\u002BdEf\\u002BGhI\\/jKl="} zz`);
    for (let at = 20; at < outer.length - 20; at += 3) {
      const shown = decodeAll(clean.prefix(`${outer.slice(0, at)}${"q".repeat(3000)}`, at));
      for (let i = 0; i + 4 <= secret.length; i++)
        expect(
          shown.some((level) => level.includes(secret.slice(i, i + 4))),
          `cut at ${at}`,
        ).toBe(false);
    }
    // The work is bounded by `max`, whatever the text's length.
    const before = scrubbedChars();
    clean.prefix(`${"\\".repeat(256)}x`.repeat(30_000), 2000);
    expect(scrubbedChars() - before).toBeLessThan(9 * 2000);
  });

  it("keeps nothing of a credential between calls, and holds credentials that share a start in the nodes they share", () => {
    const one = scrubber([secret]);
    expect(scrubber([secret])).not.toBe(one);
    // A credential holding U+0000 is itself, not the two it would split into.
    expect(scrubber(["abcdef\u0000ghijkl"]).text("abcdef and ghijkl")).toBe("abcdef and ghijkl");
    expect(scrubber(["abcdef", "ghijkl"]).text("abcdef and ghijkl")).toBe("[redacted] and [redacted]");
    // 51 credentials of 8,192 characters sharing 8,191: about 8,200 nodes, not 418,000.
    const common = "k".repeat(8191);
    const shared = Array.from({ length: 51 }, (_, i) => `${common}${String.fromCharCode(65 + i)}`);
    const automaton = (scrubber(shared) as unknown as { automaton: { nodes: number; bytes: number } })
      .automaton;
    expect(automaton.nodes).toBeLessThan(8300);
    expect(automaton.bytes).toBeLessThan(200_000);
    expect(scrubber(shared).text(`x ${shared[7]} y`)).toBe("x [redacted] y");
  });

  it("reads JSON so that nothing a credential left in it is lost", () => {
    // A credential holding escapes of its own is searched for as JSON reads it too.
    const odd = 'tok\\n\\"en-12345';
    expect(scrubber([odd]).value({ echo: 'Bearer tok\n"en-12345' })).toEqual({ echo: "Bearer [redacted]" });
    expect(scrubber([odd]).json('{"echo":"Bearer tok\\n\\"en-12345"}')).toEqual({
      value: { echo: "Bearer [redacted]" },
      numbers: [],
    });
    // A number past what a double keeps, whose digits hold a credential: its token in the text says so.
    const digits = scrubber(["123456789012345678901234"]);
    const read = digits.json('{"id":91234567890123456789012345,"n":7}')!;
    expect(read.numbers).toEqual([91234567890123456789012345]);
    expect(digits.value(read.value, read.numbers)).toEqual({ id: "[redacted]", n: 7 });
    expect(digits.json("not json")).toBeUndefined();
  });

  it("walks a parsed value within a budget, keeping what fits and saying it cut the rest", () => {
    const clean = scrubber([secret]);
    const rows = Array.from({ length: 1000 }, (_, i) => ({ i, note: `${secret} ${"n".repeat(90)}` }));
    const { value, cut } = clean.bounded({ rows }, 5000);
    expect(cut).toBe(true);
    const kept = (value as { rows: unknown[] }).rows;
    expect(kept.length).toBeGreaterThan(10);
    expect(kept.length).toBeLessThan(100);
    expect(JSON.stringify(value)).not.toContain("AbC");
    expect(clean.bounded({ [secret]: 1, list: [secret] }, 1000)).toEqual({
      value: { "[redacted]": 1, list: ["[redacted]"] },
      cut: false,
    });
    // A string past the budget is cut as a head is.
    expect(clean.bounded(`${"x".repeat(10_000)}${secret}`, 100)).toEqual({
      value: "x".repeat(100),
      cut: true,
    });
    let deep: unknown = secret;
    for (let i = 0; i < 30; i++) deep = [deep];
    let out = clean.bounded(deep, 1000).value;
    for (let i = 0; i < 13; i++) out = (out as unknown[])[0];
    expect(out).toBe("[depth]");
    expect(scrubber(["12345678"]).bounded({ pin: 12345678 }, 100).value).toEqual({ pin: "[redacted]" });
    // A key the budget would cut, or that uses it up, leaves its entry out: cut, "api_key" could read "api_ke",
    // and the number under it pass the broker's redaction.
    expect(clean.bounded({ a: 1, [`api_key_${"x".repeat(50)}`]: 123456 }, 30)).toEqual({
      value: { a: 1 },
      cut: true,
    });
    expect(clean.bounded({ abc: 1 }, 4)).toEqual({ value: {}, cut: true });
    // An object far wider than the budget: what is past it is never read.
    const wide = Object.fromEntries(Array.from({ length: 100_000 }, (_, i) => [`k${i}`, "v".repeat(20)]));
    const before = scrubbedChars();
    expect(clean.bounded(wide, 1000).cut).toBe(true);
    expect(scrubbedChars() - before).toBeLessThan(1000);
  });

  it("does work linear in what it reads: one automaton for every credential, one pass a level", () => {
    const jwt = `eyJ${"a".repeat(2045)}`;
    const fit = (s: string, n: number) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
    // What is counted is the work: characters searched, at every level, and automata built. A wall clock on
    // a shared CI runner swings by ten times; it backs these up at two seconds for gross regressions only.
    const work = (f: () => unknown) => {
      const [chars, builds, started] = [scrubbedChars(), automataBuilt(), performance.now()];
      f();
      expect(performance.now() - started).toBeLessThan(2000);
      return { chars: scrubbedChars() - chars, builds: automataBuilt() - builds };
    };
    // A six-character and a 2 KB credential over 50,000 cells: one automaton for both, each cell read once.
    // Built per string, it was 50,000 automata and seconds.
    const cells = { rows: Array.from({ length: 50_000 }, (_, i) => ({ id: i, name: `cell ${i} name` })) };
    const cellChars = cells.rows.reduce((n, r) => n + r.name.length, 0);
    expect(work(() => scrubber([jwt, "Zq9#x1"]).value(cells))).toEqual({ chars: cellChars, builds: 1 });
    // An OpenAPI answer at its cap: plain text with a run of 256 backslashes, so all nine levels are read, and
    // 52 credentials searched at once: nine passes over the text at most, not nine for each credential.
    const many = Array.from({ length: 51 }, (_, i) => `secret-${i}-${"x".repeat(30)}`);
    const cascade = `${fit("plain text, ", 256 * 1024)}${"\\".repeat(256)}"${fit("more plain ", 256 * 1024)}`;
    const read = work(() => scrubber([...many, jwt]).text(cascade));
    expect(read.builds).toBe(1);
    expect(read.chars).toBeGreaterThan(8 * cascade.length - 1000);
    expect(read.chars).toBeLessThanOrEqual(9 * cascade.length);
    // The server's own credential echoed beside escape chains all through it: found at every level, marked once.
    const echo = fit(`${secret}\\u005Cu005Cu005Cu005C`, 512 * 1024);
    let out = "";
    expect(work(() => (out = scrubber([secret]).text(echo))).chars).toBeLessThanOrEqual(9 * echo.length);
    expect(out).not.toContain("AbC");
    // The search follows a failure link at most once for each character it reads: a credential that matches
    // all but its last character at every place costs no more.
    const [steps, chars] = [scrubSteps(), scrubbedChars()];
    scrubber([`${"a".repeat(2048)}b${"a".repeat(2047)}`, "aaaaaaaaab"]).text("a".repeat(1_000_000));
    expect(scrubSteps() - steps).toBeLessThanOrEqual(2 * (scrubbedChars() - chars));
    // Fifty credentials of 8 KB: one automaton, built in a few tens of milliseconds here.
    const big = Array.from(
      { length: 50 },
      (_, i) => `${String.fromCharCode(65 + (i % 26))}${i}-${"q".repeat(8190)}`,
    );
    expect(work(() => scrubber(big)).builds).toBe(1);
  });

  it("stays within its memory: an 8 MB echo of the credential near escapes, in a worker held to 64 MB", async () => {
    // Every place found was a [start, end] pair before, half a gigabyte for this; now one array the text's size.
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "mcp", "scrub.ts"),
      "utf8",
    );
    const js = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const code = `
      const { parentPort, workerData } = require("node:worker_threads");
      import("data:text/javascript;base64," + workerData.js).then(({ scrubber }) => {
        const unit = workerData.secret + workerData.chain;
        const echo = unit.repeat(Math.ceil((8 * 1024 * 1024) / unit.length));
        const out = scrubber([workerData.secret, "Zq9#x1"]).text(echo);
        parentPort.postMessage({ length: out.length, leaked: out.includes("AbC") });
      });`;
    const result = await new Promise<{ length: number; leaked: boolean }>((resolve, reject) => {
      const worker = new Worker(code, {
        eval: true,
        workerData: { js: Buffer.from(js).toString("base64"), secret, chain: "\\u005Cu005Cu005C\\\\" },
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
      });
      worker.once("message", (m) => {
        resolve(m as { length: number; leaked: boolean });
        void worker.terminate();
      });
      worker.once("error", reject);
    });
    expect(result.leaked).toBe(false);
    expect(result.length).toBeGreaterThan(0);
  });
});

/** A text and every level of escapes read from it, up to eight. */
function decodeAll(text: string): string[] {
  const levels = [text];
  for (let d = 0; d < 8; d++) {
    const last = levels[levels.length - 1]!;
    let read = "";
    for (let i = 0; i < last.length;) {
      if (last[i] === "\\" && last[i + 1] === "u" && /^[\da-fA-F]{4}$/.test(last.slice(i + 2, i + 6))) {
        read += String.fromCharCode(parseInt(last.slice(i + 2, i + 6), 16));
        i += 6;
      } else if (last[i] === "\\" && i + 1 < last.length && last[i + 1]! in SHORT) {
        read += SHORT[last[i + 1]!];
        i += 2;
      } else read += last[i++];
    }
    if (read === last) break;
    levels.push(read);
  }
  return levels;
}

// A plain reader to check the scrubber against: whole levels read with string concatenation, as before,
// and every occurrence of every credential found with indexOf, overlapping or not.
const SHORT: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};
function reference(text: string, creds: string[]): string {
  const given = creds.filter((c) => c.length >= 6);
  // And what JSON reads a credential's own escapes as, level by level.
  const decoded = given.flatMap((c) => {
    const out: string[] = [];
    for (let i = 0, read = c; i < 8 && read.includes("\\"); i++) {
      try {
        read = JSON.parse(`"${read}"`) as string;
      } catch {
        break;
      }
      if (read.length >= 6) out.push(read);
    }
    return out;
  });
  const good = [...new Set([...given, ...decoded])];
  if (!good.length) return text;
  const covered = new Uint8Array(text.length);
  let level = text;
  let from = Array.from({ length: text.length + 1 }, (_, i) => i);
  for (let depth = 0; depth <= 8; depth++) {
    for (const c of good)
      for (let i = level.indexOf(c); i >= 0; i = level.indexOf(c, i + 1))
        for (let j = from[i]!; j < from[i + c.length]!; j++) covered[j] = 1;
    if (depth === 8 || !level.includes("\\")) break;
    let read = "";
    const next: number[] = [];
    for (let i = 0; i < level.length;) {
      let c = level[i]!;
      let width = 1;
      if (c === "\\" && i + 1 < level.length) {
        const n = level[i + 1]!;
        if (n === "u" && /^[\da-fA-F]{4}$/.test(level.slice(i + 2, i + 6))) {
          c = String.fromCharCode(parseInt(level.slice(i + 2, i + 6), 16));
          width = 6;
        } else if (n in SHORT) {
          c = SHORT[n]!;
          width = 2;
        }
      }
      next.push(from[i]!);
      read += c;
      i += width;
    }
    if (read.length === level.length) break;
    next.push(text.length);
    level = read;
    from = next;
  }
  let out = "";
  for (let i = 0; i < text.length; i++)
    if (!covered[i]) out += text[i];
    else if (i === 0 || !covered[i - 1]) out += "[redacted]";
  return out;
}

describe("the scrubber against a plain reader", () => {
  it("agrees on 50,000 fuzzed texts: encoders mixed, nested up to eight deep, byte order marks, astral characters", () => {
    let seed = 20261022;
    const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x80000000;
    const ri = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const alphabet = [...'AbC9xyz+/=\\"u0C5é', "\u{1F600}", "\uFEFF", "\n"];
    const hex = (c: number) => `\\u${c.toString(16).padStart(4, "0")}`;
    const encoders: ((s: string) => string)[] = [
      // JSON.stringify; PHP's \/; .NET's \u for + " < > & ' and anything past ASCII; every character as \u;
      // only the backslash and the quote as \u; and a mix, character by character.
      (s) => JSON.stringify(s).slice(1, -1),
      (s) => JSON.stringify(s).slice(1, -1).split("/").join("\\/"),
      (s) =>
        Array.from({ length: s.length }, (_, i) => {
          const c = s[i]!;
          if (c === "\\") return "\\\\";
          return "+\"<>&'".includes(c) || s.charCodeAt(i) > 0x7e || s.charCodeAt(i) < 0x20
            ? hex(s.charCodeAt(i))
            : c;
        }).join(""),
      (s) => Array.from({ length: s.length }, (_, i) => hex(s.charCodeAt(i))).join(""),
      (s) => s.split("\\").join("\\u005C").split('"').join("\\u0022"),
      (s) =>
        Array.from({ length: s.length }, (_, i) => {
          const c = s[i]!;
          if (c === "\\") return rnd() < 0.5 ? "\\\\" : hex(92);
          if (c === '"') return '\\"';
          return rnd() < 0.2 ? hex(s.charCodeAt(i)) : c;
        }).join(""),
    ];
    const filler = () =>
      Array.from({ length: ri(0, 12) }, () =>
        pick(["z", " ", "\\\\", '\\"', "\\u00e9", "\uFEFF", "\\/", "\u{1F600}"]),
      ).join("");
    let disagreed = 0;
    let first = "";
    for (let n = 0; n < 50_000; n++) {
      const creds = Array.from({ length: rnd() < 0.8 ? 1 : 2 }, () =>
        Array.from({ length: ri(6, 14) }, () => pick(alphabet)).join(""),
      );
      let text = `${filler()}${creds.join(pick(["", " ", "\\"]))}${filler()}`;
      for (let d = ri(0, 8); d > 0; d--) {
        // Past a few hundred characters, plain JSON nesting only: every character as \u grows sixfold a level.
        const enc = text.length > 300 ? encoders[0]! : pick(encoders);
        text = `${filler()}${enc(text)}${filler()}`;
      }
      if (rnd() < 0.1) text = `\uFEFF${text}`;
      const got = scrubber(creds).text(text);
      if (got !== reference(text, creds) && !disagreed++) first = JSON.stringify({ creds, text });
    }
    expect(first).toBe("");
    expect(disagreed).toBe(0);
    // About 13 s here on its own, and four times that on a busy CI runner beside the other suites.
  }, 150_000);
});
