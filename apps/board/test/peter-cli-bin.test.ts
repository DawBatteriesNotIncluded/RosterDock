// Peter's CLIs as npm installs them. On Windows npm writes a .cmd shim, which a spawn without a shell cannot
// start, so the board runs the script the shim runs; elsewhere a link to that script is on PATH. No model and
// no database: the script answers by itself.
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveCliBin, runCli } from "../src/peter/cli.js";

const CLAUDE = ["@anthropic-ai", "claude-code", "cli.js"];
const CODEX = ["@openai", "codex", "bin", "codex.js"];

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rosterdock-npm-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A global npm folder with one CLI in it, laid out as npm lays it out on this platform. Returns the script. */
async function npmInstall(prefix: string, name: string, script: string[]): Promise<string> {
  const js = path.join(prefix, "node_modules", ...script);
  await mkdir(path.dirname(js), { recursive: true });
  // The CLI answers with what it was asked on stdin.
  await writeFile(
    js,
    [
      "#!/usr/bin/env node",
      'let asked = "";',
      'process.stdin.on("data", (c) => (asked += c));',
      `process.stdin.on("end", () => process.stdout.write(${JSON.stringify(`${name} from npm: `)} + asked));`,
      "",
    ].join("\n"),
    "utf8",
  );
  if (process.platform === "win32") {
    // npm's shim: cmd.exe runs the script with node.
    await writeFile(
      path.join(prefix, `${name}.cmd`),
      `@node "%~dp0\\node_modules\\${script.join("\\")}" %*\r\n`,
    );
  } else {
    await chmod(js, 0o755);
    await symlink(path.relative(prefix, js), path.join(prefix, name));
  }
  return js;
}

describe("Peter's CLI as npm installs it", () => {
  it("finds the script npm's Windows shim runs, for claude and codex, on Windows only", async () => {
    const prefix = path.join(dir, "resolve");
    const claude = await npmInstall(prefix, "claude", CLAUDE);
    const codex = await npmInstall(prefix, "codex", CODEX);
    expect(resolveCliBin("claude", { PATH: prefix }, "win32")).toEqual({
      bin: process.execPath,
      prefix: [claude],
    });
    expect(resolveCliBin("codex", { Path: prefix }, "win32")).toEqual({
      bin: process.execPath,
      prefix: [codex],
    });
    // Anywhere else, another binary, or a name that is no CLI of Peter's: as it is.
    expect(resolveCliBin("claude", { PATH: prefix }, "linux")).toEqual({ bin: "claude", prefix: [] });
    expect(resolveCliBin("C:\\tools\\claude.exe", { PATH: prefix }, "win32")).toEqual({
      bin: "C:\\tools\\claude.exe",
      prefix: [],
    });
    expect(resolveCliBin("constructor", { PATH: prefix }, "win32")).toEqual({
      bin: "constructor",
      prefix: [],
    });
    expect(resolveCliBin("claude", { PATH: path.join(dir, "empty") }, "win32")).toEqual({
      bin: "claude",
      prefix: [],
    });
  });

  it("starts the claude npm installed and reads its answer", async () => {
    const prefix = path.join(dir, "global");
    await npmInstall(prefix, "claude", CLAUDE);
    const env = {
      PATH: [prefix, path.dirname(process.execPath)].join(path.delimiter),
      SystemRoot: process.env.SystemRoot,
    };
    if (process.platform === "win32")
      // The shim is no program: a spawn without a shell does not find it, which is why the board resolves it.
      expect(spawnSync("claude", [], { env, shell: false }).error).toMatchObject({ code: "ENOENT" });
    const res = await runCli({
      bin: "claude",
      args: ["-p"],
      stdin: "plan this",
      env,
      timeoutMs: 15_000,
      name: "the Claude CLI",
    });
    expect(res).toMatchObject({ code: 0, stdout: "claude from npm: plan this" });
  });
});
