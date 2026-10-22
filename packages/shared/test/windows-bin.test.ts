// npm's Windows shims as npm 11.19 (cmd-shim 8.0.0) writes them for a global install, recorded in
// fixtures/npm-shims from each package's own bin file (npm view <package> bin): Claude Code 2.1.307
// (bin/claude.exe, a native program with no #! line), Claude Code 2.1.112 (cli.js, #!/usr/bin/env node) and
// Codex 0.163.0 (bin/codex.js, #!/usr/bin/env node).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { npmShimTarget, resolveWindowsBin, type WindowsBinFiles } from "../src/windows-bin.js";

const shims = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "npm-shims");
const shim = (name: string) => readFileSync(path.join(shims, `${name}.cmd`), "utf8");

/** A Windows file system of `files` (path to text): names in any case, Windows' path functions. */
function windows(files: Record<string, string>): WindowsBinFiles {
  const names = new Set(Object.keys(files).map((p) => p.toLowerCase()));
  return {
    isFile: (p) => names.has(p.toLowerCase()),
    read: (p) => files[p] ?? null,
    join: (...parts) => parts.join("\\").replace(/\\+/g, "\\"),
    dirname: (p) => p.slice(0, p.lastIndexOf("\\")),
  };
}

const NPM = "C:\\Users\\me\\AppData\\Roaming\\npm";
const NODE = "C:\\Program Files\\nodejs\\node.exe";
const CLAUDE_EXE = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;

describe("npm's Windows shims", () => {
  it("reads what each shim runs: a program as it is, a script with node", () => {
    expect(npmShimTarget(shim("claude-2.1.307"))).toEqual({
      path: ["node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"],
      node: false,
    });
    expect(npmShimTarget(shim("claude-2.1.112"))).toEqual({
      path: ["node_modules", "@anthropic-ai", "claude-code", "cli.js"],
      node: true,
    });
    expect(npmShimTarget(shim("codex-0.163.0"))).toEqual({
      path: ["node_modules", "@openai", "codex", "bin", "codex.js"],
      node: true,
    });
    // Any other batch file, or a shim for another interpreter, is none of npm's.
    expect(npmShimTarget('@echo off\r\nnode "%~dp0\\cli.js" %*\r\n')).toBeNull();
    expect(npmShimTarget(shim("codex-0.163.0").replace(/"_prog=node"/, '"_prog=python"'))).toBeNull();
  });

  it("finds today's Claude Code behind its shim, and runs a script one with the caller's Node", () => {
    const current = windows({ [`${NPM}\\claude.cmd`]: shim("claude-2.1.307"), [CLAUDE_EXE]: "" });
    expect(resolveWindowsBin("claude", [NPM], NODE, current)).toEqual({ bin: CLAUDE_EXE, prefix: [] });
    const cli = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
    const old = windows({ [`${NPM}\\claude.cmd`]: shim("claude-2.1.112"), [cli]: "" });
    expect(resolveWindowsBin("claude", [NPM], NODE, old)).toEqual({ bin: NODE, prefix: [cli] });
    const js = `${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`;
    const codex = windows({ [`${NPM}\\codex.cmd`]: shim("codex-0.163.0"), [js]: "" });
    expect(resolveWindowsBin("codex", ["", NPM], NODE, codex)).toEqual({ bin: NODE, prefix: [js] });
    // A shim named by its path, as a setting may name it.
    expect(resolveWindowsBin(`${NPM}\\claude.cmd`, [], NODE, current)).toEqual({
      bin: CLAUDE_EXE,
      prefix: [],
    });
  });

  it("takes the first folder on PATH that has the name, a program before a shim in it, as Windows does", () => {
    const native = "C:\\Users\\me\\.local\\bin";
    const both = windows({
      [`${native}\\claude.exe`]: "",
      [`${NPM}\\claude.cmd`]: shim("claude-2.1.112"),
      [`${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`]: "",
    });
    expect(resolveWindowsBin("claude", [native, NPM], NODE, both)).toEqual({
      bin: `${native}\\claude.exe`,
      prefix: [],
    });
    const oneFolder = windows({ [`${NPM}\\claude.exe`]: "", [`${NPM}\\claude.cmd`]: shim("claude-2.1.307") });
    expect(resolveWindowsBin("claude", [NPM], NODE, oneFolder)).toEqual({
      bin: `${NPM}\\claude.exe`,
      prefix: [],
    });
  });

  it("leaves a name found nowhere, or a batch file npm did not write, as it is", () => {
    expect(resolveWindowsBin("claude", [NPM], NODE, windows({}))).toEqual({ bin: "claude", prefix: [] });
    const other = windows({ [`${NPM}\\claude.cmd`]: "@echo off\r\nexit /b 1\r\n" });
    expect(resolveWindowsBin("claude", [NPM], NODE, other)).toEqual({ bin: "claude", prefix: [] });
    expect(resolveWindowsBin("C:\\tools\\claude.exe", [NPM], NODE, windows({}))).toEqual({
      bin: "C:\\tools\\claude.exe",
      prefix: [],
    });
  });
});
