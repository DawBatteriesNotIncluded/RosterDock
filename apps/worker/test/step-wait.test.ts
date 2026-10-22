// On Windows a test step first waits for the job's probe (jobsWork). That wait is the step's: its time limit and
// Stop end it. Windows is stood in for, and the probe never answers here, so no command starts.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as Kill from "../src/kill.js";
import { execCommand } from "../src/tests.js";

vi.mock("../src/kill.js", async (importOriginal) => {
  const actual = await importOriginal<typeof Kill>();
  return { ...actual, jobsWork: vi.fn(() => new Promise<boolean>(() => {})) };
});

const platform = process.platform;
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "win32" });
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: platform });
});

it("ends a step at its time limit while the job's probe has not answered", async () => {
  const started = Date.now();
  expect(await execCommand("npm", ["test"], { cwd: ".", env: {}, timeoutMs: 300 })).toEqual({
    code: null,
    output: "",
    timedOut: true,
  });
  expect(Date.now() - started).toBeLessThan(2000);
});

it("ends a step on Stop while the job's probe has not answered", async () => {
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 200);
  expect(
    await execCommand("npm", ["test"], { cwd: ".", env: {}, timeoutMs: 60_000, signal: stop.signal }),
  ).toEqual({ code: null, output: "", timedOut: false });
});
