import { describe, expect, it } from "vitest";
import { clip, tail } from "../src/text.js";

// "😀" is two UTF-16 code units: a high surrogate and a low one.
const EMOJI = "😀";

describe("clip and tail", () => {
  it("never cut an astral character in half, and stay within the limit", () => {
    const text = `a${EMOJI.repeat(10)}`; // the pairs sit at odd offsets
    for (let max = 0; max <= text.length; max++) {
      for (const out of [clip(text, max), tail(text, max), clip(text, max, "…"), tail(text, max, "…")]) {
        expect(out.isWellFormed()).toBe(true);
        expect(out.length).toBeLessThanOrEqual(Math.max(max, 1));
        expect(JSON.stringify(out)).not.toMatch(/\\ud[89a-f]/i);
      }
    }
    // A cut inside the pair drops the half rather than replacing it.
    expect(clip(`ab${EMOJI}`, 3)).toBe("ab");
    expect(tail(`${EMOJI}ab`, 3)).toBe("ab");
  });

  it("mark a cut with the ellipsis inside the limit, and leave a short text as it is", () => {
    expect(clip("abcdef", 4, "…")).toBe("abc…");
    expect(tail("abcdef", 4, "…")).toBe("…def");
    expect(clip("abc", 4, "…")).toBe("abc");
    expect(tail("abc", 4, "…")).toBe("abc");
  });

  it("make a lone surrogate already in the text well formed", () => {
    expect(clip("a\ud800b", 10)).toBe("a�b");
    expect(tail("a\udc00b", 10)).toBe("a�b");
  });
});
