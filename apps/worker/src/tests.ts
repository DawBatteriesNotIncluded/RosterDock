// The repository's own tests, run in the workspace after the diff is captured
// (so nothing the tests write pollutes the review). The result is one review
// check: the board shows it next to the secret scan and the declared outputs.
// The test script is the repository's code, which the run may have rewritten,
// so it runs with a bare environment: no model keys, no board or git
// credentials. The command runner is injected so tests here use recorded
// output, never a live npm.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { WorkerCheckInput } from "@rosterdock/shared";
import { killTree } from "./kill.js";
import { tail } from "./text.js";
import type { Workspace } from "./workspace.js";

export interface ExecResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

export type Exec = (
  command: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number },
) => Promise<ExecResult>;

export const MAX_TEST_OUTPUT_CHARS = 20_000;

/** All a package manager needs: where programs live, a home, a temp directory, the locale. */
const TEST_ENV_KEYS = [
  "PATH",
  "Path",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "TZ",
];

/** The environment the repository's scripts see: the keys above from `env` and CI=1, nothing else. */
export function testEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of TEST_ENV_KEYS) {
    const v = env[key];
    if (v !== undefined) out[key] = v;
  }
  return { ...out, CI: "1" };
}

/**
 * Run a package-manager command, capturing interleaved stdout and stderr. Past the time limit it is ended:
 * on Windows with everything it started, since there it runs under cmd.exe, and npm would outlive cmd.
 */
export const execCommand: Exec = (command, args, opts) =>
  new Promise((resolve) => {
    const win = process.platform === "win32";
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...opts.env, CI: "1" },
      // npm, pnpm and yarn are .cmd shims on Windows; the arguments are fixed strings.
      shell: win,
      windowsHide: true,
    });
    let output = "";
    let timedOut = false;
    const keep = (chunk: string) => {
      output = (output + chunk).slice(-MAX_TEST_OUTPUT_CHARS * 2);
    };
    // Decoded as a stream, so a character split across two pipe chunks stays whole.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      timedOut = true;
      if (win) killTree(child);
      else child.kill();
    }, opts.timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, output: `${output}\n${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function detectPackageManager(dir: string): Promise<"pnpm" | "yarn" | "npm"> {
  if (await exists(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(path.join(dir, "yarn.lock"))) return "yarn";
  return "npm";
}

const INSTALL_ARGS: Record<"pnpm" | "yarn" | "npm", string[]> = {
  pnpm: ["install", "--frozen-lockfile", "--ignore-scripts"],
  yarn: ["install", "--frozen-lockfile", "--ignore-scripts"],
  npm: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
};

/** The end of the output, the leading … included, within the board's MAX_TEST_OUTPUT_CHARS. */
function tailOf(output: string): string {
  return tail(output, MAX_TEST_OUTPUT_CHARS, "…");
}

/**
 * The tests check for a workspace: null when there is no repository (nothing
 * to run); `ok: null` when the repository has no test script or its
 * dependencies cannot be installed; otherwise the exit status of `<pm> test`.
 * `env` is narrowed to testEnvironment whatever the caller passes.
 */
export async function runRepoTests(
  ws: Workspace,
  opts: { exec?: Exec; env: Record<string, string>; timeoutMs: number },
): Promise<WorkerCheckInput | null> {
  if (!ws.repo) return null;
  const exec = opts.exec ?? execCommand;
  const env = testEnvironment(opts.env);
  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(await readFile(path.join(ws.dir, "package.json"), "utf8")) as typeof pkg;
  } catch {
    return { kind: "tests", ok: null, title: "Tests not run: no package.json in the repository" };
  }
  if (!pkg.scripts?.test)
    return { kind: "tests", ok: null, title: "Tests not run: no test script in package.json" };
  const pm = await detectPackageManager(ws.dir);
  if (!(await exists(path.join(ws.dir, "node_modules")))) {
    const install = await exec(pm, INSTALL_ARGS[pm], {
      cwd: ws.dir,
      env,
      timeoutMs: opts.timeoutMs,
    });
    if (install.code !== 0) {
      return {
        kind: "tests",
        ok: null,
        title: install.timedOut
          ? `Tests not run: ${pm} install timed out`
          : `Tests not run: ${pm} install failed (exit ${install.code ?? "?"})`,
        detail: tailOf(install.output),
      };
    }
  }
  const res = await exec(pm, ["test"], { cwd: ws.dir, env, timeoutMs: opts.timeoutMs });
  if (res.timedOut) {
    return {
      kind: "tests",
      ok: false,
      title: `${pm} test timed out after ${Math.round(opts.timeoutMs / 1000)} s`,
      detail: tailOf(res.output),
    };
  }
  return {
    kind: "tests",
    ok: res.code === 0,
    title: res.code === 0 ? `${pm} test passed` : `${pm} test failed (exit ${res.code ?? "?"})`,
    detail: tailOf(res.output),
  };
}
