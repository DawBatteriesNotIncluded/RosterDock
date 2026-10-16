// What this pod is using: CPU in millicores over the interval since the last
// sample and memory in bytes. From the cgroup when there is one (v2 first,
// then v1), which counts the engine child process too; from this process
// alone otherwise (a laptop, a test). Reported with every heartbeat.

import { readFile } from "node:fs/promises";

export interface ResourceSample {
  cpuMillis: number;
  memoryBytes: number;
}

export interface ResourceReader {
  /** Reads a file as text; rejects when it does not exist. Injected in tests. */
  readFile(path: string): Promise<string>;
  /** CPU time used by this process in microseconds, and its resident set. */
  process(): { cpuMicros: number; rssBytes: number };
  now(): number;
}

export const defaultReader: ResourceReader = {
  readFile: (p) => readFile(p, "utf8"),
  process() {
    const c = process.cpuUsage();
    return { cpuMicros: c.user + c.system, rssBytes: process.memoryUsage().rss };
  },
  now: () => Date.now(),
};

async function cgroupV2(r: ResourceReader): Promise<{ cpuMicros: number; memoryBytes: number } | null> {
  try {
    const stat = await r.readFile("/sys/fs/cgroup/cpu.stat");
    const usage = /usage_usec\s+(\d+)/.exec(stat);
    if (!usage) return null;
    const mem = (await r.readFile("/sys/fs/cgroup/memory.current")).trim();
    return { cpuMicros: Number(usage[1]), memoryBytes: Number(mem) };
  } catch {
    return null;
  }
}

async function cgroupV1(r: ResourceReader): Promise<{ cpuMicros: number; memoryBytes: number } | null> {
  try {
    const nanos = Number((await r.readFile("/sys/fs/cgroup/cpu/cpuacct.usage")).trim());
    const mem = Number((await r.readFile("/sys/fs/cgroup/memory/memory.usage_in_bytes")).trim());
    if (!Number.isFinite(nanos) || !Number.isFinite(mem)) return null;
    return { cpuMicros: nanos / 1000, memoryBytes: mem };
  } catch {
    return null;
  }
}

export interface ResourceSampler {
  /** The next sample; the first call reports 0 CPU (no interval yet). */
  sample(): Promise<ResourceSample>;
  /** Where the numbers come from, once known. */
  readonly source: "metrics-api" | "cgroup-v2" | "cgroup-v1" | "process" | "unknown";
}

export function createResourceSampler(reader: ResourceReader = defaultReader): ResourceSampler {
  let last: { at: number; cpuMicros: number } | null = null;
  let source: ResourceSampler["source"] = "unknown";
  const read = async (): Promise<{ cpuMicros: number; memoryBytes: number }> => {
    if (source === "unknown" || source === "cgroup-v2") {
      const v2 = await cgroupV2(reader);
      if (v2) {
        source = "cgroup-v2";
        return v2;
      }
    }
    if (source === "unknown" || source === "cgroup-v1") {
      const v1 = await cgroupV1(reader);
      if (v1) {
        source = "cgroup-v1";
        return v1;
      }
    }
    source = "process";
    const p = reader.process();
    return { cpuMicros: p.cpuMicros, memoryBytes: p.rssBytes };
  };
  return {
    get source() {
      return source;
    },
    async sample() {
      const now = reader.now();
      const cur = await read();
      let cpuMillis = 0;
      if (last && now > last.at) {
        const wallMicros = (now - last.at) * 1000;
        cpuMillis = Math.max(0, Math.round(((cur.cpuMicros - last.cpuMicros) / wallMicros) * 1000));
      }
      last = { at: now, cpuMicros: cur.cpuMicros };
      return { cpuMillis, memoryBytes: Math.max(0, Math.round(cur.memoryBytes)) };
    },
  };
}
