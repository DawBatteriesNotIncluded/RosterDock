// Record the Codex CLI's answer to one of Peter's planning calls, with the
// arguments, schema file and prompt the board sends, as
// test/fixtures/codex-cli/plan.jsonl; a failed turn goes to error.jsonl. The
// roster and the goal are planner-recording.mts's, which the tests replay.
// Usage, from apps/board (after `codex login`):
//   node --import tsx scripts/record-codex-cli.mts [model]     # no model: Codex's own default
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { cliEnv } from "../src/peter/cli.js";
import { codexCliArgs, codexPrompt, SCHEMA_FILE } from "../src/peter/codex-cli.js";
import { recordedRequest } from "./planner-recording.mts";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", "test", "fixtures", "codex-cli");
const req = recordedRequest(process.argv[2] ?? "");

const cwd = mkdtempSync(path.join(os.tmpdir(), "rosterdock-record-"));
writeFileSync(path.join(cwd, SCHEMA_FILE), JSON.stringify(zodOutputFormat(req.schema).schema), "utf8");
const child = spawn("codex", codexCliArgs(req), { cwd, env: cliEnv(process.env), shell: false });
let stdout = "";
child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
child.stderr.pipe(process.stderr);
child.stdin.end(codexPrompt(req));
child.on("close", (code) => {
  rmSync(cwd, { recursive: true, force: true });
  // Normalised: the thread id says nothing a test needs.
  const lines = stdout
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => l.replace(/"thread_id":"[^"]+"/, '"thread_id":"00000000-0000-7000-8000-000000000001"'));
  const file = lines.some((l) => l.includes('"type":"turn.failed"')) ? "error.jsonl" : "plan.jsonl";
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, file), `${lines.join("\n")}\n`);
  console.log(
    `exit ${code}: wrote ${file}; check it for anything that looks like a secret before committing`,
  );
});
