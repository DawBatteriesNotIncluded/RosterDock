// Peter's CLIs as npm installs them. On Windows npm writes a .cmd shim, which a spawn without a shell cannot
// start, so the board starts what the shim runs: the shims are the ones recorded in @rosterdock/shared's
// fixtures (npm 11.19), the files they run where `npm view <package> bin` puts them. Elsewhere a link to the
// CLI is on PATH. No model and no database: what runs answers by itself.
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveCliBin, runCli } from "../src/peter/cli.js";

const shims = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/shared/test/fixtures/npm-shims",
);
/** Claude Code since 2.1.113: bin/claude.exe, a native program the shim runs as it is. */
const CLAUDE = {
  shim: "claude-2.1.307",
  name: "claude",
  file: ["@anthropic-ai", "claude-code", "bin", "claude.exe"],
};
/** Claude Code up to 2.1.112: cli.js, which the shim runs with node. */
const CLAUDE_JS = {
  shim: "claude-2.1.112",
  name: "claude",
  file: ["@anthropic-ai", "claude-code", "cli.js"],
};
const CODEX = { shim: "codex-0.163.0", name: "codex", file: ["@openai", "codex", "bin", "codex.js"] };

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rosterdock-npm-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A CLI that answers with what it was asked on stdin. */
const ANSWER = (name: string) =>
  [
    'let asked = "";',
    'process.stdin.on("data", (c) => (asked += c));',
    `process.stdin.on("end", () => process.stdout.write(${JSON.stringify(`${name} from npm: `)} + asked));`,
    "",
  ].join("\n");

/** A global npm folder with one CLI in it, laid out as npm lays it out on Windows. Returns the file the shim runs. */
async function npmInstall(prefix: string, cli: typeof CLAUDE, contents = ""): Promise<string> {
  const file = path.join(prefix, "node_modules", ...cli.file);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, "utf8");
  await copyFile(path.join(shims, `${cli.shim}.cmd`), path.join(prefix, `${cli.name}.cmd`));
  return file;
}

describe("Peter's CLI as npm installs it", () => {
  it("starts what npm's Windows shim runs, for today's claude, an older one and codex, on Windows only", async () => {
    const claude = await npmInstall(path.join(dir, "resolve"), CLAUDE);
    const codex = await npmInstall(path.join(dir, "resolve"), CODEX);
    const prefix = path.join(dir, "resolve");
    expect(resolveCliBin("claude", { PATH: prefix }, "win32")).toEqual({ bin: claude, prefix: [] });
    expect(resolveCliBin("codex", { Path: prefix }, "win32")).toEqual({
      bin: process.execPath,
      prefix: [codex],
    });
    const old = path.join(dir, "old");
    const cli = await npmInstall(old, CLAUDE_JS);
    expect(resolveCliBin("claude", { PATH: old }, "win32")).toEqual({ bin: process.execPath, prefix: [cli] });
    // ROSTERDOCK_PETER_CLAUDE_BIN may name the shim itself.
    expect(resolveCliBin(path.join(prefix, "claude.cmd"), {}, "win32")).toEqual({ bin: claude, prefix: [] });
    // Anywhere else, a program named, or a name on no folder: as it is.
    expect(resolveCliBin("claude", { PATH: prefix }, "linux")).toEqual({ bin: "claude", prefix: [] });
    expect(resolveCliBin("C:\\tools\\claude.exe", { PATH: prefix }, "win32")).toEqual({
      bin: "C:\\tools\\claude.exe",
      prefix: [],
    });
    expect(resolveCliBin("claude", { PATH: path.join(dir, "empty") }, "win32")).toEqual({
      bin: "claude",
      prefix: [],
    });
  });

  it("takes the first folder on PATH that has the CLI, as Windows does: a native claude.exe before an old npm one", async () => {
    const native = path.join(dir, "native");
    await mkdir(native, { recursive: true });
    await writeFile(path.join(native, "claude.exe"), "", "utf8");
    const npm = path.join(dir, "behind");
    await npmInstall(npm, CLAUDE_JS);
    expect(resolveCliBin("claude", { PATH: [native, npm].join(path.delimiter) }, "win32")).toEqual({
      bin: path.join(native, "claude.exe"),
      prefix: [],
    });
  });

  it("starts the claude npm installed and reads its answer", async () => {
    const prefix = path.join(dir, "global");
    if (process.platform === "win32") {
      // Today's layout, its claude.exe a copy of this Node that runs the answering script it is given.
      const exe = await npmInstall(prefix, CLAUDE);
      await copyFile(process.execPath, exe);
      await writeFile(path.join(prefix, "answer.js"), ANSWER("claude"), "utf8");
    } else {
      const js = await npmInstall(prefix, CLAUDE_JS, `#!/usr/bin/env node\n${ANSWER("claude")}`);
      await chmod(js, 0o755);
      await symlink(path.relative(prefix, js), path.join(prefix, "claude"));
    }
    const env = {
      PATH: [prefix, path.dirname(process.execPath)].join(path.delimiter),
      SystemRoot: process.env.SystemRoot,
    };
    if (process.platform === "win32")
      // The shim is no program: a spawn without a shell does not find it, which is why the board resolves it.
      expect(spawnSync("claude", [], { env, shell: false }).error).toMatchObject({ code: "ENOENT" });
    const res = await runCli({
      bin: "claude",
      // On Windows the copy of Node is given the script to run; elsewhere the script is the CLI.
      prefixArgs: process.platform === "win32" ? [path.join(prefix, "answer.js")] : [],
      args: ["-p"],
      stdin: "plan this",
      env,
      timeoutMs: 15_000,
      name: "the Claude CLI",
    });
    expect(res).toMatchObject({ code: 0, stdout: "claude from npm: plan this" });
  });
});
