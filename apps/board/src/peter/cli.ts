// Running a model CLI (Claude Code, Codex) from the board: one child per call,
// in a fresh empty directory, with only the environment a CLI needs to find
// itself, its sign-in and a proxy, the prompt on stdin, stopped at a timeout.

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PASS_ENV =
  /^(PATH|Path|PATHEXT|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|USER|USERNAME|LOGNAME|SHELL|TMPDIR|TEMP|TMP|LANG|LC_[A-Z_]+|APPDATA|LOCALAPPDATA|SystemRoot|ComSpec|XDG_[A-Z_]+|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|CLAUDE_[A-Z0-9_]+|ANTHROPIC_[A-Z0-9_]+|CODEX_[A-Z0-9_]+|OPENAI_[A-Z0-9_]+)$/;

/** What a CLI needs to find its binary, its sign-in and a proxy; none of the board's own settings. */
export function cliEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && PASS_ENV.test(k)));
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
      const child = spawn(call.bin, [...(call.prefixArgs ?? []), ...call.args], {
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
    await rm(cwd, { recursive: true, force: true });
  }
}
