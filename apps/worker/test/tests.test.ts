// The repository test runner against recorded npm output. No npm is spawned.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerCheckSchema } from "@rosterdock/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectPackageManager, MAX_TEST_OUTPUT_CHARS, runRepoTests, type Exec } from "../src/tests.js";

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

  it("detects the package manager from the lockfile", async () => {
    expect(await detectPackageManager((await repo("pm-npm", { "package.json": PKG })).dir)).toBe("npm");
    expect(await detectPackageManager((await repo("pm-pnpm", { "pnpm-lock.yaml": "" })).dir)).toBe("pnpm");
  });
});
