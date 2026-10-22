// What a service says back loses the credential: as written, JSON-escaped at any depth up to eight, in
// text and in parsed values however deep, numbers too, never a credential too short to tell from ordinary
// text; and the work stays linear in what was said, however many strings it holds or however long the
// credential is.
import { describe, expect, it } from "vitest";
import { scrubber, scrubText } from "../src/mcp/scrub.js";

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
    // Shorter than 6: never, or every "abc" in an answer would go.
    expect(scrubText("abc abc", ["abc"])).toBe("abc abc");
  });

  it("takes it out of a parsed value however deep, keys and numbers too", () => {
    let deep: unknown = { token: `Bearer ${secret}`, [secret]: 1 };
    for (let i = 0; i < 30; i++) deep = { inner: [deep] };
    let out = scrubber([secret]).value(deep);
    for (let i = 0; i < 30; i++) out = (out as { inner: unknown[] }).inner[0];
    expect(out).toEqual({ token: "Bearer [redacted]", "[redacted]": 1 });
    // A PIN-like credential of digits, echoed as a JSON number.
    expect(scrubber(["12345678"]).value({ pin: 12345678, also: 912345678, n: 7, s: "x12345678" })).toEqual({
      pin: "[redacted]",
      also: "[redacted]",
      n: 7,
      s: "x[redacted]",
    });
  });

  it("drops a cut text's end, room for the credential escaped three levels deep", () => {
    const text = `${"x".repeat(1000)}AbC\\\\u002BdEf`;
    expect(scrubber([secret]).cut(text)).toBe("x".repeat(text.length - 16 * secret.length));
    expect(scrubber(["short1"]).cut("y".repeat(1000))).toBe("y".repeat(1000 - 256));
  });

  it("stays linear: a long credential over many short strings, and a long text with a deep run of escapes", () => {
    // An ordinary JWT's length, over 300,000 short cells: each cell too short to hold it is passed over. A
    // table built per string took 5.1 s here; about 0.1 s now, most of it copying the value. Each bound below
    // leaves room for a slow machine and none for the old cost.
    const jwt = `eyJ${"a".repeat(2045)}`;
    const cells = { rows: Array.from({ length: 300_000 }, (_, i) => ({ id: i, name: `cell ${i}` })) };
    let started = performance.now();
    scrubber([jwt]).value(cells);
    expect(performance.now() - started).toBeLessThan(800);
    // Eight megabytes of plain text with one run of 256 backslashes: the deeper levels read only around it
    // (2.9 s when every level read the whole text; about 45 ms now).
    const long = `${"plain text, ".repeat(350_000)}${"\\".repeat(256)}"${"more plain text ".repeat(250_000)}`;
    started = performance.now();
    expect(scrubber([jwt]).text(long)).toBe(long);
    expect(performance.now() - started).toBeLessThan(600);
    // And escapes everywhere, nested three deep: still a few passes over the text.
    const dense = JSON.stringify(
      JSON.stringify(JSON.stringify({ log: Array(40_000).fill({ "a/b": 'c"d' }) })),
    );
    started = performance.now();
    scrubber([secret]).text(dense);
    expect(performance.now() - started).toBeLessThan(600);
  });
});
