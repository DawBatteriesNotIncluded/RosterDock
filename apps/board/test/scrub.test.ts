// What a service says back loses the credential: as written, JSON-escaped at any depth up to eight, in
// text and in parsed values however deep, never a credential too short to tell from ordinary text.
import { describe, expect, it } from "vitest";
import { cutTail, scrubCut, scrubText, scrubValue } from "../src/mcp/scrub.js";

const secret = "AbC+dEf+GhI/jKl=";

describe("scrubbing a credential", () => {
  it("finds it as written and escaped, one level or several, and finds every credential given", () => {
    expect(scrubText(`a ${secret} b`, [secret])).toBe("a [redacted] b");
    expect(scrubText("a AbC\\u002BdEf\\u002bGhI\\/jKl= b", [secret])).toBe("a [redacted] b");
    // Escaped by .NET and PHP, then carried as JSON in a string three times over: four levels to read.
    let nested = '{"authorization":"Bearer AbC\\u002BdEf\\u002BGhI\\/jKl="}';
    for (let i = 0; i < 3; i++) nested = JSON.stringify({ nested });
    expect(nested).not.toContain(secret);
    expect(scrubText(nested, [secret])).not.toMatch(/AbC|dEf|GhI/);
    let unwrapped: unknown = JSON.parse(scrubText(nested, [secret]));
    for (let i = 0; i < 3; i++) unwrapped = JSON.parse((unwrapped as { nested: string }).nested);
    expect(unwrapped).toEqual({ authorization: "Bearer [redacted]" });
    expect(scrubText(`x ${secret} y other-secret-0000`, [secret, "other-secret-0000", null])).toBe(
      "x [redacted] y [redacted]",
    );
    // Shorter than 6: never, or every "abc" in an answer would go.
    expect(scrubText("abc abc", ["abc"])).toBe("abc abc");
  });

  it("takes it out of a parsed value however deep, keys too", () => {
    let deep: unknown = { token: `Bearer ${secret}`, [secret]: 1 };
    for (let i = 0; i < 30; i++) deep = { inner: [deep] };
    let out = scrubValue(deep, [secret]);
    for (let i = 0; i < 30; i++) out = (out as { inner: unknown[] }).inner[0];
    expect(out).toEqual({ token: "Bearer [redacted]", "[redacted]": 1 });
  });

  it("drops a cut text's end, room for the credential escaped three levels deep", () => {
    expect(cutTail([secret])).toBe(16 * secret.length);
    expect(cutTail(["short1"])).toBe(256);
    const text = `${"x".repeat(1000)}AbC\\\\u002BdEf`;
    const cut = scrubCut(text, [secret]);
    expect(cut).toBe("x".repeat(text.length - 16 * secret.length));
  });
});
