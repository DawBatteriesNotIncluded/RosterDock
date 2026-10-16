// The repository test runner against recorded npm output. No npm is spawned.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectPackageManager, runRepoTests, type Exec } from "../src/tests.js";

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

function recorded(outputs: Record<string, { code: number; file?: string; timedOut?: boolean }>) {
  const calls: { command: string; args: string[] }[] = [];
  const exec: Exec = async (command, args) => {
    calls.push({ command, args });
    const key = `${command} ${args.join(" ")}`;
    const hit = outputs[key];
    if (!hit) throw new Error(`unexpected command ${key}`);
    return {
      code: hit.code,
      output: hit.file ? await readFile(path.join(fixtures, hit.file), "utf8") : "",
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

  it("detects the package manager from the lockfile", async () => {
    expect(await detectPackageManager((await repo("pm-npm", { "package.json": PKG })).dir)).toBe("npm");
    expect(await detectPackageManager((await repo("pm-pnpm", { "pnpm-lock.yaml": "" })).dir)).toBe("pnpm");
  });
});
