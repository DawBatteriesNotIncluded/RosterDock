import { describe, expect, it } from "vitest";
import { createFanout, tailFrom } from "../src/index.js";

interface Ev {
  seq: number;
  type: string;
}

describe("createFanout", () => {
  it("isolates a throwing subscriber from the others and from the publisher", () => {
    const fanout = createFanout<Ev>();
    const seen: number[] = [];
    fanout.subscribe(() => {
      throw new Error("broken subscriber");
    });
    fanout.subscribe((e) => seen.push(e.seq));
    expect(() => fanout.publish({ seq: 1, type: "x" })).not.toThrow();
    expect(seen).toEqual([1]);
  });

  it("unsubscribes", () => {
    const fanout = createFanout<Ev>();
    const seen: number[] = [];
    const off = fanout.subscribe((e) => seen.push(e.seq));
    fanout.publish({ seq: 1, type: "x" });
    off();
    fanout.publish({ seq: 2, type: "x" });
    expect(seen).toEqual([1]);
    expect(fanout.size).toBe(0);
  });
});

describe("tailFrom", () => {
  it("replays the backlog then goes live with no gap and no duplicate", async () => {
    const fanout = createFanout<Ev>();
    const written: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const tail = tailFrom<Ev>({
      fanout,
      readBacklog: async () => {
        // Rows 3 and 4 land while the backlog read is in flight. Row 3 is also
        // in the backlog result (the classic overlap); row 4 is live-only.
        fanout.publish({ seq: 3, type: "live-overlap" });
        fanout.publish({ seq: 4, type: "live-only" });
        await gate;
        return [
          { seq: 1, type: "backlog" },
          { seq: 2, type: "backlog" },
          { seq: 3, type: "backlog" },
        ];
      },
      write: (e) => {
        written.push(e.seq);
      },
    });

    release();
    const off = await tail;
    fanout.publish({ seq: 5, type: "live" });
    off();
    fanout.publish({ seq: 6, type: "after-unsubscribe" });

    expect(written).toEqual([1, 2, 3, 4, 5]);
  });

  it("applies the filter to backlog and live rows alike", async () => {
    const fanout = createFanout<Ev>();
    const written: string[] = [];
    const off = await tailFrom<Ev>({
      fanout,
      readBacklog: async () => [
        { seq: 1, type: "task" },
        { seq: 2, type: "other" },
      ],
      write: (e) => {
        written.push(e.type);
      },
      filter: (e) => e.type === "task",
    });
    fanout.publish({ seq: 3, type: "other" });
    fanout.publish({ seq: 4, type: "task" });
    off();
    expect(written).toEqual(["task", "task"]);
  });

  it("stops and reports when the writer signals backpressure", async () => {
    const fanout = createFanout<Ev>();
    let stalled = false;
    const written: number[] = [];
    await tailFrom<Ev>({
      fanout,
      readBacklog: async () => [],
      write: (e) => {
        written.push(e.seq);
        return e.seq < 2;
      },
      onStall: () => {
        stalled = true;
      },
    });
    fanout.publish({ seq: 1, type: "x" });
    fanout.publish({ seq: 2, type: "x" });
    fanout.publish({ seq: 3, type: "x" });
    expect(written).toEqual([1, 2]);
    expect(stalled).toBe(true);
    expect(fanout.size).toBe(0);
  });
});
