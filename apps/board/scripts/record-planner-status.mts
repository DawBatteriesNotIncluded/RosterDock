// Record what the model CLIs say about their sign-in, as the board asks them
// (`claude auth status`, `codex login status`), into test/fixtures/planners:
// signed in as the CLIs are here, and signed out (Claude without the user
// name it finds its sign-in by, Codex with an empty CODEX_HOME). Who is signed
// in, the organisation and the directories are normalised.
// Usage, from apps/board, with both CLIs signed in:
//   node --import tsx scripts/record-planner-status.mts
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cliEnv } from "../src/peter/cli.js";
import { CLAUDE_STATUS_ARGS, CODEX_STATUS_ARGS } from "../src/peter/planners.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", "test", "fixtures", "planners");
mkdirSync(out, { recursive: true });

function record(
  file: string,
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  normalise = (s: string) => s,
) {
  const r = spawnSync(bin, args, { env, encoding: "utf8" });
  const stdout = r.stdout.trim() ? normalise(r.stdout) : r.stdout;
  writeFileSync(path.join(out, file), JSON.stringify({ code: r.status, stdout, stderr: r.stderr }) + "\n");
  console.log(`${file}: exit ${r.status}`);
}

const claudeNormal = (s: string) => {
  const d = JSON.parse(s) as Record<string, unknown>;
  if ("email" in d) d.email = "owner@example.com";
  if ("orgId" in d) d.orgId = "00000000-0000-4000-8000-000000000000";
  if ("orgName" in d) d.orgName = "Example org";
  if ("configDirectory" in d) d.configDirectory = "/home/user/.claude";
  if ("projectsDirectory" in d) d.projectsDirectory = "/home/user/.claude/projects";
  return `${JSON.stringify(d, null, 2)}\n`;
};
const env = cliEnv(process.env);
record("claude-signed-in.json", "claude", CLAUDE_STATUS_ARGS, env, claudeNormal);
const { USER: _user, LOGNAME: _logname, ...noUser } = env;
record("claude-signed-out.json", "claude", CLAUDE_STATUS_ARGS, noUser, claudeNormal);
record("codex-signed-in.json", "codex", CODEX_STATUS_ARGS, env);
const empty = mkdtempSync(path.join(os.tmpdir(), "rosterdock-codex-home-"));
record("codex-signed-out.json", "codex", CODEX_STATUS_ARGS, { ...env, CODEX_HOME: empty });
rmSync(empty, { recursive: true, force: true });
