import { describe, expect, it } from "vitest";
import { poolForQueue, queueNameForPool, RUNS_QUEUE } from "../src/index.js";

describe("run queues and pools", () => {
  it("names the default queue and one per pool, and refuses a name that is not a slug", () => {
    expect(queueNameForPool(null)).toBe(RUNS_QUEUE);
    expect(queueNameForPool(undefined)).toBe("runs");
    expect(queueNameForPool("")).toBe("runs");
    expect(queueNameForPool("secure")).toBe("runs.secure");
    expect(queueNameForPool("no-egress-2")).toBe("runs.no-egress-2");
    expect(() => queueNameForPool("Secure")).toThrow(/not a pool name/);
    expect(() => queueNameForPool("a b")).toThrow(/not a pool name/);
    expect(() => queueNameForPool("-x")).toThrow(/not a pool name/);
    expect(poolForQueue("runs")).toBeNull();
    expect(poolForQueue("runs.secure")).toBe("secure");
    expect(poolForQueue("other")).toBeNull();
  });
});
