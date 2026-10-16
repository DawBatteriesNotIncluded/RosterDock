// Pod CPU and memory from the cgroup (v2, then v1), else the process; CPU is
// millicores over the interval since the last sample. And the JSON log lines.
import { describe, expect, it } from "vitest";
import { createLog, formatLine, logFormatFrom } from "../src/log.js";
import { createResourceSampler, type ResourceReader } from "../src/resources.js";

function reader(files: Record<string, string[]>, proc = { cpuMicros: 0, rssBytes: 100 }): ResourceReader {
  let t = 1_000_000;
  const calls: Record<string, number> = {};
  return {
    async readFile(path) {
      const versions = files[path];
      if (!versions) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      const i = Math.min(calls[path] ?? 0, versions.length - 1);
      calls[path] = (calls[path] ?? 0) + 1;
      return versions[i]!;
    },
    process: () => proc,
    now: () => (t += 10_000),
  };
}

describe("resource sampler", () => {
  it("reads cgroup v2 and turns CPU time over the interval into millicores", async () => {
    const s = createResourceSampler(
      reader({
        "/sys/fs/cgroup/cpu.stat": [
          "usage_usec 5000000\nuser_usec 4000000\nsystem_usec 1000000\n",
          "usage_usec 8000000\nuser_usec 6500000\nsystem_usec 1500000\n",
        ],
        "/sys/fs/cgroup/memory.current": ["536870912\n", "600000000\n"],
      }),
    );
    const first = await s.sample();
    expect(first).toEqual({ cpuMillis: 0, memoryBytes: 536_870_912 });
    expect(s.source).toBe("cgroup-v2");
    // 3 s of CPU over 10 s of wall clock: 300 millicores.
    const second = await s.sample();
    expect(second).toEqual({ cpuMillis: 300, memoryBytes: 600_000_000 });
  });

  it("falls back to cgroup v1, then to the process itself", async () => {
    const v1 = createResourceSampler(
      reader({
        "/sys/fs/cgroup/cpu/cpuacct.usage": ["1000000000\n", "21000000000\n"],
        "/sys/fs/cgroup/memory/memory.usage_in_bytes": ["1024\n", "2048\n"],
      }),
    );
    expect(await v1.sample()).toEqual({ cpuMillis: 0, memoryBytes: 1024 });
    expect(v1.source).toBe("cgroup-v1");
    // 20 s of CPU over 10 s of wall clock: two cores.
    expect(await v1.sample()).toEqual({ cpuMillis: 2000, memoryBytes: 2048 });

    const proc = { cpuMicros: 0, rssBytes: 4096 };
    const p = createResourceSampler(reader({}, proc));
    expect(await p.sample()).toEqual({ cpuMillis: 0, memoryBytes: 4096 });
    expect(p.source).toBe("process");
    proc.cpuMicros = 500_000;
    expect(await p.sample()).toEqual({ cpuMillis: 50, memoryBytes: 4096 });
  });
});

describe("worker log", () => {
  it("writes one JSON object per line in a cluster and plain lines on a terminal", () => {
    const at = new Date("2026-09-12T10:00:00.000Z");
    expect(
      formatLine(
        "json",
        "info",
        { worker: "w1", service: "rosterdock-worker" },
        "claimed",
        { runId: "r" },
        at,
      ),
    ).toBe(
      '{"level":"info","time":"2026-09-12T10:00:00.000Z","worker":"w1","service":"rosterdock-worker","msg":"claimed","runId":"r"}',
    );
    expect(formatLine("text", "warn", { worker: "w1" }, "slow", undefined, at)).toBe("[worker w1] slow");
    expect(logFormatFrom({}, true)).toBe("text");
    expect(logFormatFrom({}, false)).toBe("json");
    expect(logFormatFrom({ ROSTERDOCK_LOG_FORMAT: "TEXT" }, false)).toBe("text");
    const out: string[] = [];
    const err: string[] = [];
    const log = createLog(
      "json",
      { worker: "w1" },
      { stdout: (l) => out.push(l), stderr: (l) => err.push(l) },
    );
    log.info("hello", { n: 1 });
    log.warn("oops");
    expect(JSON.parse(out[0]!)).toMatchObject({ level: "info", worker: "w1", msg: "hello", n: 1 });
    expect(JSON.parse(err[0]!)).toMatchObject({ level: "warn", msg: "oops" });
  });
});
