import { describe, expect, it } from "vitest";
import { asSentence, bearerToken, trimTrailingSlashes } from "../src/index.js";

// Long enough that the regular expressions these replace take seconds (time grows with the square of
// the length); a single scan takes a few milliseconds.
const LONG = 200_000;

function timed<T>(f: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = f();
  return { value, ms: performance.now() - start };
}

describe("helpers for text anyone can send", () => {
  it("bearer token: the scheme in any case, then whitespace, then the token, trimmed", () => {
    expect(bearerToken("Bearer abc.def")).toBe("abc.def");
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken("BEARER \t abc  ")).toBe("abc");
    expect(bearerToken("Bearer a b")).toBe("a b");
    for (const header of [
      undefined,
      null,
      "",
      "Bearer",
      "Bearer ",
      "Bearer    ",
      "Bearerabc",
      "Basic abc",
      "Token abc",
    ])
      expect(bearerToken(header)).toBeNull();
  });

  it("bearer token: a header of nothing but whitespace answers at once", () => {
    const { value, ms } = timed(() => bearerToken(`Bearer${" ".repeat(LONG)}\n`));
    expect(value).toBeNull();
    expect(ms).toBeLessThan(250);
    expect(timed(() => bearerToken(`Bearer${" ".repeat(LONG)}x`)).value).toBe("x");
  });

  it("trailing slashes: all of them, and nothing else", () => {
    expect(trimTrailingSlashes("https://id.example.test/")).toBe("https://id.example.test");
    expect(trimTrailingSlashes("https://id.example.test///")).toBe("https://id.example.test");
    expect(trimTrailingSlashes("https://id.example.test/realms/acme")).toBe(
      "https://id.example.test/realms/acme",
    );
    expect(trimTrailingSlashes("///")).toBe("");
    expect(trimTrailingSlashes("")).toBe("");
  });

  it("trailing slashes: a long run of slashes that does not end the string answers at once", () => {
    const input = `https://${"/".repeat(LONG)}x`;
    const { value, ms } = timed(() => trimTrailingSlashes(input));
    expect(value).toBe(input);
    expect(ms).toBeLessThan(250);
    expect(trimTrailingSlashes(`x${"/".repeat(LONG)}`)).toBe("x");
  });

  it("a note quoted in a sentence ends it once: its own full stop kept, one added when it has none", () => {
    // Seen on a live board: a rejection note that ended in a full stop read "try again..".
    expect(asSentence("Not this week, try again.")).toBe("Not this week, try again.");
    expect(asSentence("Not this week, try again")).toBe("Not this week, try again.");
    expect(asSentence("Not this week, try again.  \n")).toBe("Not this week, try again.");
    for (const own of ["Why?", "Stop!", "Wait…", 'He said "no."', "(see the runbook.)", "‘as agreed.’"])
      expect(asSentence(own)).toBe(own);
    expect(asSentence('He said "no"')).toBe('He said "no".');
    expect(asSentence("")).toBe("");
    const { value, ms } = timed(() => asSentence(`a${")".repeat(LONG)}`));
    expect(value).toBe(`a${")".repeat(LONG)}.`);
    expect(ms).toBeLessThan(250);
  });
});
