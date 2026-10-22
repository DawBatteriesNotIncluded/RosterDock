// Ending a process tree on Windows, and whether the job can run there. No taskkill or PowerShell runs here:
// their spawns are refused, or made to exit as they would.
import type * as ChildProcesses from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type * as Fs from "node:fs";
import { existsSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { killTree, probeJob } from "../src/kill.js";

// spawn and existsSync as they are, until a test says otherwise.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcesses>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

/** A spawned program that exits with `code`. */
function exiting(code: number): ChildProcess {
  const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
  setImmediate(() => child.emit("exit", code));
  return child as unknown as ChildProcess;
}

it("ends the process alone, and throws nothing, when taskkill cannot even start", () => {
  // What Windows says where a policy refuses taskkill: Node throws it from spawn, where it emits ENOENT.
  vi.mocked(spawn).mockImplementationOnce(() => {
    throw Object.assign(new Error("spawn EPERM"), { code: "EPERM", syscall: "spawn" });
  });
  const kill = vi.fn();
  const child = { pid: 4242, exitCode: null, signalCode: null, kill } as unknown as ChildProcess;
  expect(() => killTree(child)).not.toThrow();
  expect(kill).toHaveBeenCalledWith("SIGKILL");
});

it("takes no job where Windows PowerShell is not there, cannot start, or cannot start the command", async () => {
  vi.mocked(existsSync).mockReturnValueOnce(false);
  expect(await probeJob()).toEqual({ works: false, why: "there is no Windows PowerShell" });
  // A rule that blocks powershell.exe: the spawn throws.
  vi.mocked(existsSync).mockReturnValueOnce(true);
  vi.mocked(spawn).mockImplementationOnce(() => {
    throw Object.assign(new Error("spawn UNKNOWN"), { code: "UNKNOWN", syscall: "spawn" });
  });
  expect(await probeJob()).toEqual({ works: false, why: "Windows PowerShell did not start (UNKNOWN)" });
  // Constrained Language (AppLocker, WDAC): the script exits before cmd.exe starts the command.
  vi.mocked(existsSync).mockReturnValueOnce(true);
  vi.mocked(spawn).mockImplementationOnce(() => exiting(1));
  expect(await probeJob()).toMatchObject({
    works: false,
    why: expect.stringMatching(/^Windows PowerShell exited 1 /),
  });
  // PowerShell ran, but could not make the job (a Windows that cannot nest jobs): no job, though it would run.
  vi.mocked(existsSync).mockReturnValueOnce(true);
  vi.mocked(spawn).mockImplementationOnce(() => exiting(8));
  expect(await probeJob()).toMatchObject({
    works: false,
    why: expect.stringMatching(/could not make a job/),
  });
  // The command ran, and its code came back through the job.
  vi.mocked(existsSync).mockReturnValueOnce(true);
  vi.mocked(spawn).mockImplementationOnce(() => exiting(7));
  expect(await probeJob()).toEqual({ works: true });
});

it("keeps a definite answer, says it, and asks again where Windows PowerShell did not answer in time", async () => {
  vi.useFakeTimers();
  try {
    vi.resetModules();
    vi.mocked(spawn).mockClear();
    const kill = await import("../src/kill.js");
    const heard = vi.fn();
    kill.onJobAnswer(heard);
    // A first start that a scan holds past the probe's wait: no answer, no job for now.
    vi.mocked(existsSync).mockReturnValue(true);
    const hung = Object.assign(new EventEmitter(), { kill: vi.fn() }) as unknown as ChildProcess;
    vi.mocked(spawn).mockImplementationOnce(() => hung);
    const first = kill.jobsWork();
    await vi.advanceTimersByTimeAsync(kill.PROBE_MS);
    expect(await first).toBe(false);
    expect(hung.kill).toHaveBeenCalledWith("SIGKILL");
    expect(heard).toHaveBeenLastCalledWith({ works: false, why: expect.stringMatching(/asked again/) });
    // Asked again: an answer now, kept.
    vi.mocked(spawn).mockImplementationOnce(() => exiting(7));
    const second = kill.jobsWork();
    await vi.advanceTimersByTimeAsync(0);
    expect(await second).toBe(true);
    expect(heard).toHaveBeenLastCalledWith({ works: true });
    expect(await kill.jobsWork()).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(2);
  } finally {
    vi.mocked(existsSync).mockReset();
    vi.useRealTimers();
  }
});

it.runIf(process.platform === "win32")(
  "makes the job on Windows, where it runs the repository's tests",
  async () => {
    // The real Windows PowerShell: a definite yes, or the reason it gives.
    expect(await probeJob()).toEqual({ works: true });
  },
);
