// The repository test runner against recorded npm output. No npm is spawned.
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerCheckSchema } from "@rosterdock/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  detectPackageManager,
  execCommand,
  MAX_TEST_OUTPUT_CHARS,
  runRepoTests,
  testEnvironment,
  type Exec,
} from "../src/tests.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "rosterdock-tests-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function repo(name: string, files: Record<string, string>) {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  for (const [p, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, p)), { recursive: true });
    await writeFile(path.join(dir, p), content, "utf8");
  }
  return { dir, repo: true };
}

function recorded(
  outputs: Record<string, { code: number; file?: string; repeat?: number; timedOut?: boolean }>,
) {
  const calls: { command: string; args: string[]; env: Record<string, string> }[] = [];
  const exec: Exec = async (command, args, opts) => {
    calls.push({ command, args, env: opts.env });
    const key = `${command} ${args.join(" ")}`;
    const hit = outputs[key];
    if (!hit) throw new Error(`unexpected command ${key}`);
    return {
      code: hit.code,
      output: hit.file ? (await readFile(path.join(fixtures, hit.file), "utf8")).repeat(hit.repeat ?? 1) : "",
      timedOut: hit.timedOut ?? false,
    };
  };
  return { exec, calls };
}

const PKG = '{ "name": "demo", "version": "1.0.0", "scripts": { "test": "node test.js" } }\n';
const env = { PATH: "x" };

describe("runRepoTests", () => {
  it("is nothing without a repository, and not run without a test script", async () => {
    expect(await runRepoTests({ dir: root, repo: false }, { env, timeoutMs: 1000 })).toBeNull();
    const none = await repo("no-script", { "package.json": '{ "name": "x" }' });
    expect(await runRepoTests(none, { env, timeoutMs: 1000 })).toMatchObject({
      kind: "tests",
      ok: null,
      title: "Tests not run: no test script in package.json",
    });
    const nopkg = await repo("no-pkg", { "README.md": "x" });
    expect((await runRepoTests(nopkg, { env, timeoutMs: 1000 }))?.title).toMatch(/no package.json/);
  });

  it("installs when node_modules is missing, then reports the recorded pass", async () => {
    const ws = await repo("pass", { "package.json": PKG, "pnpm-lock.yaml": "" });
    const { exec, calls } = recorded({
      "pnpm install --frozen-lockfile --ignore-scripts": { code: 0 },
      "pnpm test": { code: 0, file: "npm-test-pass.txt" },
    });
    const check = await runRepoTests(ws, { exec, env, timeoutMs: 1000 });
    expect(check).toMatchObject({ kind: "tests", ok: true, title: "pnpm test passed" });
    expect(check?.detail).toContain("1 passing");
    expect(calls.map((c) => c.command)).toEqual(["pnpm", "pnpm"]);
  });

  it("reports the recorded failure with its output, skipping install when node_modules exists", async () => {
    const ws = await repo("fail", { "package.json": PKG, "node_modules/.keep": "" });
    const { exec, calls } = recorded({ "npm test": { code: 1, file: "npm-test-fail.txt" } });
    const check = await runRepoTests(ws, { exec, env, timeoutMs: 1000 });
    expect(check).toMatchObject({ ok: false, title: "npm test failed (exit 1)" });
    expect(check?.detail).toContain("AssertionError");
    expect(calls).toHaveLength(1);
  });

  it("keeps the end of a recorded output longer than the limit, within what the board accepts", async () => {
    const ws = await repo("long-fail", { "package.json": PKG, "node_modules/.keep": "" });
    const { exec } = recorded({ "npm test": { code: 1, file: "npm-test-fail.txt", repeat: 30 } });
    const output = (await readFile(path.join(fixtures, "npm-test-fail.txt"), "utf8")).repeat(30);
    expect(output.length).toBeGreaterThan(MAX_TEST_OUTPUT_CHARS);
    const check = await runRepoTests(ws, { exec, env, timeoutMs: 1000 });
    expect(WorkerCheckSchema.safeParse(check).success).toBe(true);
    const detail = check?.detail ?? "";
    expect(detail.startsWith("…")).toBe(true);
    expect(detail.length).toBeLessThanOrEqual(MAX_TEST_OUTPUT_CHARS);
    expect(output.endsWith(detail.slice(1))).toBe(true);
  });

  it("cuts a long log beside an emoji without leaving half of it, which the board's jsonb refuses", async () => {
    const ws = await repo("emoji-fail", { "package.json": PKG, "node_modules/.keep": "" });
    const recordedFail = await readFile(path.join(fixtures, "npm-test-fail.txt"), "utf8");
    // The closing line puts the cut the tail makes between the two halves of an emoji.
    const output = `${recordedFail}${"✅ ok 😀\n".repeat(4000)}done\n`;
    const exec: Exec = async () => ({ code: 1, output, timedOut: false });
    const check = await runRepoTests(ws, { exec, env, timeoutMs: 1000 });
    const detail = check?.detail ?? "";
    expect(detail.isWellFormed()).toBe(true);
    expect(detail.startsWith("…")).toBe(true);
    expect(detail.length).toBeLessThanOrEqual(MAX_TEST_OUTPUT_CHARS);
    expect(output.endsWith(detail.slice(1))).toBe(true);
    expect(WorkerCheckSchema.safeParse(check).success).toBe(true);
  });

  it("a failed install or a timeout is reported, never thrown", async () => {
    const ws = await repo("install-fails", { "package.json": PKG, "yarn.lock": "" });
    const { exec } = recorded({ "yarn install --frozen-lockfile --ignore-scripts": { code: 1 } });
    expect(await runRepoTests(ws, { exec, env, timeoutMs: 1000 })).toMatchObject({
      ok: null,
      title: "Tests not run: yarn install failed (exit 1)",
    });
    const slow = await repo("slow", { "package.json": PKG, "node_modules/.keep": "" });
    const t = recorded({ "npm test": { code: null as unknown as number, timedOut: true } });
    expect(await runRepoTests(slow, { exec: t.exec, env, timeoutMs: 5000 })).toMatchObject({
      ok: false,
      title: "npm test timed out after 5 s",
    });
  });

  it("runs the repository's scripts with a bare environment: no model keys, no board or git credentials", async () => {
    const ws = await repo("bare-env", { "package.json": PKG, "pnpm-lock.yaml": "" });
    const { exec, calls } = recorded({
      "pnpm install --frozen-lockfile --ignore-scripts": { code: 0 },
      "pnpm test": { code: 0, file: "npm-test-pass.txt" },
    });
    const engineEnv = {
      PATH: "/usr/bin",
      HOME: "/home/node",
      TMPDIR: "/tmp",
      USER: "node",
      ANTHROPIC_API_KEY: "model-key",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
      OPENAI_API_KEY: "model-key",
      CODEX_API_KEY: "model-key",
      DATABASE_URL: "postgres://board",
      ROSTERDOCK_WORKER_TOKEN: "fleet-token",
      ROSTERDOCK_GIT_TOKEN: "git-token",
    };
    await runRepoTests(ws, { exec, env: engineEnv, timeoutMs: 1000 });
    expect(calls).toHaveLength(2);
    for (const call of calls)
      expect(call.env).toEqual({ PATH: "/usr/bin", HOME: "/home/node", TMPDIR: "/tmp", CI: "1" });
  });

  it("reads a command's output as a stream, so a character on a pipe boundary arrives whole", async () => {
    // This Node stands in for the package manager: no npm runs here. By name and with a script file, as a
    // package manager is run: on Windows the command goes through cmd, which splits a path or code with spaces.
    await writeFile(
      path.join(root, "stream.js"),
      'process.stdout.write("— ✅ 😀 ".repeat(20000));\n',
      "utf8",
    );
    const res = await execCommand("node", ["stream.js"], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 10_000,
    });
    expect(res.code).toBe(0);
    expect(res.output.includes("\ufffd")).toBe(false);
    expect(res.output.endsWith("— ✅ 😀 ")).toBe(true);
  });

  it("ends a command past its time limit, with what a Windows shim started under it", async () => {
    // Found on PATH like a package manager: on Windows a .cmd shim, which cmd.exe runs and which starts
    // this Node in turn; elsewhere the program itself. It would hold the step for a minute.
    const bin = path.join(root, "sleeper-bin");
    await mkdir(bin, { recursive: true });
    const sleep = `"${process.execPath}" -e "setTimeout(() => {}, 60000)"`;
    if (process.platform === "win32") await writeFile(path.join(bin, "sleeper.cmd"), `@${sleep}\r\n`);
    else await writeFile(path.join(bin, "sleeper"), `#!/bin/sh\nexec ${sleep}\n`, { mode: 0o755 });
    const started = Date.now();
    const res = await execCommand("sleeper", [], {
      cwd: root,
      env: { ...testEnvironment(process.env), PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
      timeoutMs: 500,
    });
    expect(res.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  /**
   * A Node that stands in for a test runner: it starts one that holds its output open, as a worker or a server
   * would, and then waits, or with `exit` ends at once and leaves it running.
   */
  async function holder(
    name: string,
    exit?: number,
  ): Promise<{ script: string; pidFile: string; held(): number; started(): Promise<void> }> {
    const script = path.join(root, `${name}.cjs`);
    const pidFile = path.join(root, `${name}.pid`);
    await writeFile(
      script,
      [
        'const { spawn } = require("node:child_process");',
        'const held = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "inherit" });',
        'require("node:fs").writeFileSync(process.argv[2], String(held.pid));',
        exit === undefined ? "setTimeout(() => {}, 60000);" : `process.exit(${exit});`,
        "",
      ].join("\n"),
    );
    const held = () => Number(readFileSync(pidFile, "utf8"));
    const started = async () => {
      while (!existsSync(pidFile)) await new Promise((r) => setTimeout(r, 50));
    };
    return { script, pidFile, held, started };
  }

  /** Whether a process ended within a few seconds; one still there is ended, so no test leaves one behind. */
  async function ended(pid: number): Promise<boolean> {
    for (const until = Date.now() + 5000; Date.now() < until;) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    process.kill(pid, "SIGKILL");
    return false;
  }

  // On Windows the command starts once PowerShell has made its job; elsewhere at once.
  const STARTS_WITHIN_MS = process.platform === "win32" ? 8000 : 500;

  it("ends a command past its time limit, and every process it started, though one holds its output open", async () => {
    const h = await holder("held-open");
    const started = Date.now();
    const res = await execCommand(process.execPath, [h.script, h.pidFile], {
      cwd: root,
      env: testEnvironment(process.env),
      timeoutMs: STARTS_WITHIN_MS,
    });
    expect(res.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(STARTS_WITHIN_MS + 10_000);
    expect(await ended(h.held())).toBe(true);
  });

  it("ends what a command left running when it ends by itself, and reports the command's own exit", async () => {
    // A test script that passes and leaves its server running: the server holds the output open.
    const h = await holder("left-running", 7);
    const started = Date.now();
    const res = await execCommand(process.execPath, [h.script, h.pidFile], {
      cwd: root,
      env: testEnvironment(process.env),
      timeoutMs: 60_000,
    });
    expect(res).toMatchObject({ code: 7, timedOut: false });
    expect(Date.now() - started).toBeLessThan(STARTS_WITHIN_MS + 10_000);
    expect(await ended(h.held())).toBe(true);
  });

  it("ends a command, and every process it started, at once when the run stops", async () => {
    const h = await holder("stopped");
    const stop = new AbortController();
    void h.started().then(() => stop.abort());
    const res = await execCommand(process.execPath, [h.script, h.pidFile], {
      cwd: root,
      env: testEnvironment(process.env),
      timeoutMs: 60_000,
      signal: stop.signal,
    });
    expect(res.timedOut).toBe(false);
    expect(await ended(h.held())).toBe(true);
    // Already stopped: nothing starts.
    expect(
      await execCommand(process.execPath, [h.script, path.join(root, "never.pid")], {
        cwd: root,
        env: testEnvironment(process.env),
        timeoutMs: 60_000,
        signal: stop.signal,
      }),
    ).toEqual({ code: null, output: "", timedOut: false });
    expect(existsSync(path.join(root, "never.pid"))).toBe(false);
  });

  it("hands the run's stop to every command, and gives no check for tests a stop cut short", async () => {
    const ws = await repo("stop-install", { "package.json": PKG });
    const stop = new AbortController();
    const signals: (AbortSignal | undefined)[] = [];
    const exec: Exec = async (_command, _args, opts) => {
      signals.push(opts.signal);
      stop.abort();
      return { code: null, output: "", timedOut: false };
    };
    expect(await runRepoTests(ws, { exec, env, timeoutMs: 1000, signal: stop.signal })).toBeNull();
    // Stopped during the install: the tests never start.
    expect(signals).toEqual([stop.signal]);
    const ran = await repo("stop-test", { "package.json": PKG, "node_modules/.keep": "" });
    const late = new AbortController();
    const test: Exec = async () => {
      late.abort();
      return { code: 1, output: "", timedOut: false };
    };
    expect(await runRepoTests(ran, { exec: test, env, timeoutMs: 1000, signal: late.signal })).toBeNull();
  });

  it("detects the package manager from the lockfile", async () => {
    expect(await detectPackageManager((await repo("pm-npm", { "package.json": PKG })).dir)).toBe("npm");
    expect(await detectPackageManager((await repo("pm-pnpm", { "pnpm-lock.yaml": "" })).dir)).toBe("pnpm");
  });
});
