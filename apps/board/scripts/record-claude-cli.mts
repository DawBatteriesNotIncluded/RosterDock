// Record the Claude Code CLI's answer to one of Peter's planning calls, with
// the arguments the board sends, as test/fixtures/claude-cli/plan.json; an
// error answer (not signed in, an unknown model) goes to error.json instead.
// The roster and the goal are planner-recording.mts's, which the tests replay.
// Usage, from apps/board (after `claude auth login` for a plan):
//   node --import tsx scripts/record-claude-cli.mts [model]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeCliArgs, cliEnv } from "../src/peter/claude-cli.js";
import { recordedRequest } from "./planner-recording.mts";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", "test", "fixtures", "claude-cli");
const model = process.argv[2] ?? "claude-opus-5";

const req = recordedRequest(model);

const cwd = mkdtempSync(path.join(os.tmpdir(), "rosterdock-record-"));
const child = spawn("claude", claudeCliArgs(req), { cwd, env: cliEnv(process.env), shell: false });
let stdout = "";
child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
child.stderr.pipe(process.stderr);
child.stdin.end(req.user);
child.on("close", (code) => {
  rmSync(cwd, { recursive: true, force: true });
  const line = stdout.trim().split(/\r?\n/).pop() ?? "";
  const result = JSON.parse(line) as Record<string, unknown>;
  // Normalised: the session and message ids say nothing a test needs.
  for (const key of ["session_id", "uuid"]) if (key in result) result[key] = "normalised";
  const file = result.is_error ? "error.json" : "plan.json";
  mkdirSync(out, { recursive: true });
  // One line, as the CLI prints it.
  writeFileSync(path.join(out, file), `${JSON.stringify(result)}\n`);
  console.log(
    `exit ${code}: wrote ${file}; check it for anything that looks like a secret before committing`,
  );
});
