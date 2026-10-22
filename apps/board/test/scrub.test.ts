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
import { jsonPrefix, scrubber, scrubText } from "../src/mcp/scrub.js";

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
    expect(scrubText("﻿AbC\\u002BdEf\\u002BGhI\\/jKl= tail", [secret])).toBe("﻿[redacted] tail");
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

  it("cuts before it scrubs, room left for a credential the cut fell inside", () => {
    const clean = scrubber([secret]);
    expect(clean.tail).toBe(16 * secret.length);
    expect(scrubber(["short1"]).tail).toBe(256);
    const text = `${"x".repeat(1000)}AbC\\\\u002BdEf`;
    expect(clean.cut(text)).toBe("x".repeat(text.length - clean.tail));
    expect(clean.head("short text", 100)).toBe("short text");
    // A long text: only its first `max` and the tail are read, and what comes back is no longer than `max`.
    const long = `${"y".repeat(900)}${secret}${"y".repeat(1_000_000)}`;
    const head = clean.head(long, 1000);
    expect(head.length).toBeLessThanOrEqual(1000);
    expect(head).toBe(`${"y".repeat(900)}[redacted]${"y".repeat(1000 - 900 - secret.length)}`);
  });

  it("writes a parsed value as JSON within a limit, deep levels as [depth], never the whole of them", () => {
    expect(jsonPrefix({ a: [1, "two", null, { b: true }], c: undefined }, 1000)).toBe(
      '{"a":[1,"two",null,{"b":true}]}',
    );
    expect(jsonPrefix({ a: "x".repeat(100) }, 20)).toBe('{"a":"xxxxxxxxxxxxxx');
    let deep: unknown = 1;
    for (let i = 0; i < 500_000; i++) deep = [deep];
    const started = performance.now();
    expect(jsonPrefix(deep, 1000)).toBe(`${"[".repeat(13)}"[depth]"${"]".repeat(13)}`);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("stays quick at the sizes callers keep: a short and a long credential, many credentials, deep escapes", () => {
    const jwt = `eyJ${"a".repeat(2045)}`;
    const fit = (s: string, n: number) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
    const time = (f: () => unknown) => {
      const started = performance.now();
      f();
      return performance.now() - started;
    };
    // A six-character and a 2 KB credential over 50,000 cells: every cell is searched for both at once.
    // About 25 ms here; building the search per string, it was seconds. The bounds leave room for a slow
    // machine and none for that.
    const cells = { rows: Array.from({ length: 50_000 }, (_, i) => ({ id: i, name: `cell ${i} name` })) };
    expect(time(() => scrubber([jwt, "Zq9#x1"]).value(cells))).toBeLessThan(300);
    // An OpenAPI answer at its cap: plain text with a run of 256 backslashes, so every level is read, and 51
    // credentials searched at once. About 50 ms here.
    const many = Array.from({ length: 51 }, (_, i) => `secret-${i}-${"x".repeat(30)}`);
    const cascade = `${fit("plain text, ", 256 * 1024)}${"\\".repeat(256)}"${fit("more plain ", 256 * 1024)}`;
    expect(time(() => scrubber([...many, jwt]).text(cascade))).toBeLessThan(300);
    // The server's own credential echoed beside escape chains all through it: found at every level, marked once.
    const echo = fit(`${secret}\\u005Cu005Cu005Cu005C`, 512 * 1024);
    let out = "";
    expect(time(() => (out = scrubber([secret]).text(echo)))).toBeLessThan(300);
    expect(out).not.toContain("AbC");
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
  const good = [...new Set(creds.filter((c) => c.length >= 6))];
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
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000;
    const ri = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const alphabet = [...'AbC9xyz+/=\\"u0C5é', "\u{1F600}", "﻿", "\n"];
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
        pick(["z", " ", "\\\\", '\\"', "\\u00e9", "﻿", "\\/", "\u{1F600}"]),
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
      if (rnd() < 0.1) text = `﻿${text}`;
      const got = scrubber(creds).text(text);
      if (got !== reference(text, creds) && !disagreed++) first = JSON.stringify({ creds, text });
    }
    expect(first).toBe("");
    expect(disagreed).toBe(0);
  }, 60_000);
});
