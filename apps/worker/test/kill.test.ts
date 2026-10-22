// Ending a process tree on Windows. No taskkill runs here: the spawn of it is refused.
import type * as ChildProcesses from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { expect, it, vi } from "vitest";
import { killTree } from "../src/kill.js";

// spawn as it is, until a test refuses it.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcesses>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

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
