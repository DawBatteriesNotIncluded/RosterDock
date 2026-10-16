// Record a real Claude Code stream-json run as the success fixture, or with
// --unknown-model the answer to a model id Claude Code does not know (the
// error result a teammate with a mistyped model gets) as the model-error fixture.
// Usage: node apps/worker/scripts/record-claude-fixture.mjs [model]
//        node apps/worker/scripts/record-claude-fixture.mjs --unknown-model claude-opus-5.5
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const unknown = process.argv[2] === "--unknown-model";
const model = (unknown ? process.argv[3] : process.argv[2]) ?? (unknown ? "claude-opus-5.5" : "haiku");
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(
  here,
  "..",
  "test",
  "fixtures",
  unknown ? "claude-code-model-error.ndjson" : "claude-code-success.ndjson",
);

function resolveBin() {
  if (process.platform !== "win32") return { bin: "claude", prefix: [] };
  for (const dir of (process.env.Path || process.env.PATH || "").split(path.delimiter)) {
    const js = path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    if (dir && existsSync(js)) return { bin: process.execPath, prefix: [js] };
  }
  return { bin: "claude", prefix: [] };
}

const dir = await mkdtemp(path.join(os.tmpdir(), "rosterdock-fixture-"));
const { bin, prefix } = resolveBin();
const args = [
  ...prefix,
  "-p",
  "--output-format",
  "stream-json",
  "--verbose",
  "--strict-mcp-config",
  "--setting-sources",
  "",
  "--no-session-persistence",
  "--permission-mode",
  "acceptEdits",
  "--tools",
  "Write,Edit",
  "--allowedTools",
  "Write(./**),Edit(./**)",
  "--model",
  model,
  "--max-turns",
  "4",
];
const child = spawn(bin, args, {
  cwd: dir,
  env: { ...process.env, DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1" },
  shell: false,
  windowsHide: true,
});
let stdout = "";
child.stdout.on("data", (c) => (stdout += c));
child.stderr.pipe(process.stderr);
child.stdin.end(
  "Write a file named vms-architecture.md containing a one-line heading, then a file named handover-summary.md with one sentence saying what you wrote. Then stop.",
);
const code = await new Promise((resolve) => child.on("close", resolve));
const lines = stdout
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    try {
      const j = JSON.parse(l);
      delete j.session_id;
      if (j.cwd) j.cwd = "/tmp/rosterdock-runs/run-1";
      // The recording machine's own paths and installed commands, agents, skills and plugins say nothing
      // the parser reads, and are the owner's: out.
      if (j.memory_paths) j.memory_paths = { auto: "/home/node/.claude/projects/run-1/memory/" };
      if (j.scratchpad_path) j.scratchpad_path = "/tmp/claude/scratchpad";
      for (const k of ["slash_commands", "commands", "agents", "skills", "plugins"])
        if (Array.isArray(j[k])) j[k] = [];
      return JSON.stringify(j);
    } catch {
      return null;
    }
  })
  .filter(Boolean);
await rm(dir, { recursive: true, force: true });
const expected = unknown ? '"is_error":true' : '"is_error":false';
if ((!unknown && code !== 0) || !lines.some((l) => l.includes('"type":"result"') && l.includes(expected))) {
  console.error(`claude exited ${code}; not writing the fixture. Output:\n${stdout.slice(0, 2000)}`);
  process.exit(1);
}
await writeFile(out, lines.join("\n") + "\n", "utf8");
console.log(`wrote ${lines.length} lines to ${out}`);
