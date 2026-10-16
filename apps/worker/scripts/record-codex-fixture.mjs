// Record a real Codex `exec --json` run as the success fixture.
// Usage: node apps/worker/scripts/record-codex-fixture.mjs [model]
// Needs `codex login`. The prompt asks for one shell command and a file read, so
// the recording carries a command_execution item as well as the messages.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const model = process.argv[2] ?? null;
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", "test", "fixtures", "codex-success.jsonl");

function resolveBin() {
  if (process.platform !== "win32") return { bin: "codex", prefix: [] };
  for (const dir of (process.env.Path || process.env.PATH || "").split(path.delimiter)) {
    const js = path.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (dir && existsSync(js)) return { bin: process.execPath, prefix: [js] };
  }
  return { bin: "codex", prefix: [] };
}

const dir = await mkdtemp(path.join(os.tmpdir(), "rosterdock-fixture-"));
await writeFile(path.join(dir, "notes.txt"), "The kickoff was on Tuesday.\n", "utf8");
const { bin, prefix } = resolveBin();
const args = [
  ...prefix,
  "exec",
  "--json",
  "--sandbox",
  "workspace-write",
  "-c",
  'approval_policy="never"',
  "--skip-git-repo-check",
  "--ephemeral",
  "--ignore-user-config",
  "--color",
  "never",
  ...(model ? ["--model", model] : []),
  "--output-last-message",
  path.join(dir, "handover-summary.md"),
  "-",
];
const child = spawn(bin, args, { cwd: dir, env: process.env, shell: false, windowsHide: true });
let stdout = "";
child.stdout.on("data", (c) => (stdout += c));
child.stderr.pipe(process.stderr);
child.stdin.end(
  "Run one shell command that lists the files in the current working directory. Then read notes.txt and reply with one sentence that repeats what it says.",
);
const code = await new Promise((resolve) => child.on("close", resolve));
const lines = stdout
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    try {
      const j = JSON.parse(l);
      if (j.thread_id) j.thread_id = "00000000-0000-7000-8000-000000000001";
      return JSON.stringify(j);
    } catch {
      return null;
    }
  })
  .filter(Boolean);
await rm(dir, { recursive: true, force: true });
if (code !== 0 || !lines.some((l) => l.includes('"type":"turn.completed"'))) {
  console.error(`codex exited ${code}; not writing the fixture. Output:\n${stdout.slice(0, 2000)}`);
  process.exit(1);
}
await writeFile(out, lines.join("\n") + "\n", "utf8");
console.log(`wrote ${lines.length} lines to ${out}`);
