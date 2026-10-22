// Running a model CLI (Claude Code, Codex) from the board: one child per call,
// in a fresh empty directory, with only the environment a CLI needs to find
// itself, its sign-in and a proxy, the prompt on stdin, stopped at a timeout.

import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveWindowsBin } from "@rosterdock/shared";

const PASS_ENV =
  /^(PATH|Path|PATHEXT|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|USER|USERNAME|LOGNAME|SHELL|TMPDIR|TEMP|TMP|LANG|LC_[A-Z_]+|APPDATA|LOCALAPPDATA|SystemRoot|ComSpec|XDG_[A-Z_]+|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|CLAUDE_[A-Z0-9_]+|ANTHROPIC_[A-Z0-9_]+|CODEX_[A-Z0-9_]+|OPENAI_[A-Z0-9_]+)$/;

/** What a CLI needs to find its binary, its sign-in and a proxy; none of the board's own settings. */
export function cliEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && PASS_ENV.test(k)));
}

/**
 * On Windows npm installs claude and codex as .cmd shims, which a spawn without a shell cannot start: a CLI
 * is started as the shim would start it, Claude Code's claude.exe as it is and a script with this Node (as the
 * worker runs its engines). A program named, or found first on PATH, as it is; any other platform, as it is.
 */
export function resolveCliBin(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): { bin: string; prefix: string[] } {
  if (platform !== "win32") return { bin, prefix: [] };
  return resolveWindowsBin(bin, (env.Path || env.PATH || "").split(path.delimiter), process.execPath, {
    isFile: (p) => {
      // Not only not-found: a folder this account cannot read, a share that is gone, a drive not ready.
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    },
    read: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    join: path.join,
    dirname: path.dirname,
  });
}

export interface CliCall {
  bin: string;
  /** Arguments before the CLI's own: tests run a recorded replayer through node here. */
  prefixArgs?: string[];
  args: string[];
  stdin: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** What to call the CLI in an error: "the Claude CLI". */
  name: string;
  /** Called with the fresh directory before the child starts, for files the arguments name. */
  prepare?: (dir: string) => Promise<void>;
  /** A non-zero exit is an answer too (a status command saying no), not a failure. */
  anyExit?: boolean;
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the CLI once. A CLI that cannot start, or says nothing and exits non-zero, throws; the rest is the caller's to read. */
export async function runCli(call: CliCall): Promise<CliResult> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "rosterdock-peter-"));
  try {
    await call.prepare?.(cwd);
    return await new Promise<CliResult>((resolve, reject) => {
      const cli = resolveCliBin(call.bin, call.env);
      const child = spawn(cli.bin, [...cli.prefix, ...(call.prefixArgs ?? []), ...call.args], {
        cwd,
        env: cliEnv(call.env),
        shell: false,
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`${call.name} did not answer within ${Math.round(call.timeoutMs / 1000)} s`));
      }, call.timeoutMs);
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`${call.name} did not start: ${e.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0 && !stdout.trim() && !call.anyExit)
          reject(new Error(`${call.name} exited ${code}: ${stderr.trim().slice(0, 300)}`));
        else resolve({ code, stdout, stderr });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(call.stdin);
    });
  } finally {
    // A CLI killed at the timeout holds its directory a moment longer on Windows (EBUSY): retry, and never
    // let the cleanup stand in for the call's own answer or error.
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
}
