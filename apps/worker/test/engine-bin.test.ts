// The engines' CLIs as npm installs them on Windows: the shims recorded in @rosterdock/shared's fixtures, and
// the files they run where `npm view <package> bin` puts them. No CLI runs here.
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { resolveEngineBin } from "../src/engines/bin.js";

const shims = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/shared/test/fixtures/npm-shims",
);

let prefix: string;
beforeAll(async () => {
  prefix = await mkdtemp(path.join(os.tmpdir(), "rosterdock-npm-"));
});
afterAll(async () => {
  await rm(prefix, { recursive: true, force: true });
});

/** A global npm folder's shim, as recorded, and the file it runs. Returns that file. */
async function install(shim: string, name: string, file: string[]): Promise<string> {
  await copyFile(path.join(shims, `${shim}.cmd`), path.join(prefix, `${name}.cmd`));
  const target = path.join(prefix, "node_modules", ...file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "", "utf8");
  return target;
}

it("starts today's Claude Code by its claude.exe and Codex's script with this Node, on Windows only", async () => {
  const exe = await install("claude-2.1.307", "claude", [
    "@anthropic-ai",
    "claude-code",
    "bin",
    "claude.exe",
  ]);
  const js = await install("codex-0.163.0", "codex", ["@openai", "codex", "bin", "codex.js"]);
  expect(resolveEngineBin("claude", { PATH: prefix }, "win32")).toEqual({ bin: exe, prefix: [] });
  expect(resolveEngineBin("codex", { Path: prefix }, "win32")).toEqual({
    bin: process.execPath,
    prefix: [js],
  });
  // ROSTERDOCK_CLAUDE_BIN may name the shim itself.
  expect(resolveEngineBin(path.join(prefix, "claude.cmd"), {}, "win32")).toEqual({ bin: exe, prefix: [] });
  // Elsewhere, or a name found nowhere: as it is.
  expect(resolveEngineBin("claude", { PATH: prefix }, "linux")).toEqual({ bin: "claude", prefix: [] });
  expect(resolveEngineBin("opencode", { PATH: prefix }, "win32")).toEqual({ bin: "opencode", prefix: [] });
});
