// Peter through the Claude Code CLI: the arguments and stdin the CLI gets, a
// recorded answer parsed to a plan with its usage, a recorded error (not
// signed in) thrown with the CLI's message, a plan the schema refuses as no
// output, a silent CLI stopped at the timeout, the board's settings kept from
// the child, and a goal planned end to end on a board with
// a signed-in Claude CLI. The CLI is a replayer of recordings.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { claudeCliModel } from "../src/peter/claude-cli.js";
import { PlanSchema } from "../src/peter/plan.js";
import { addTeammate, seatedPeter, seedCompany, startTestBoard, type TestBoard } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const replay = path.join(here, "claude-cli-replay.mjs");
const fixtures = path.join(here, "fixtures", "claude-cli");
const PLAN = path.join(fixtures, "plan.json");
const ERROR = path.join(fixtures, "error.json");
/** The goal scripts/record-claude-cli.mts recorded plan.json with. */
const RECORDED_GOAL =
  "Write a one-page competitive brief on self-hosted AI agent platforms, with sources, then a landing page draft built from it.";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rosterdock-cli-test-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function recorded(
  file: string,
): Promise<{ args: string[]; stdin: string; cwd: string; env: string[] }> {
  return JSON.parse(await readFile(file, "utf8"));
}
function replayer(fixture: string, code: number, record: string, timeoutMs?: number) {
  return claudeCliModel({
    bin: process.execPath,
    prefixArgs: [replay, fixture, String(code), record],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: os.homedir(),
      DATABASE_URL: "postgres://board-only",
      CLAUDE_CONFIG_DIR: "/cfg",
    },
    ...(timeoutMs ? { timeoutMs } : {}),
  });
}

describe("Peter's model through the Claude CLI", () => {
  it("sends the schema, the model and the system prompt as arguments and the prompt on stdin, and reads the plan and usage", async () => {
    const record = path.join(dir, "plan-call.json");
    const fixture = JSON.parse(await readFile(PLAN, "utf8"));
    const result = await replayer(PLAN, 0, record).complete({
      model: "claude-opus-5",
      effort: "high",
      system: "You are Peter.",
      user: `Goal from the owner:\n${RECORDED_GOAL}`,
      schema: PlanSchema,
    });
    expect(result.output).toEqual(PlanSchema.parse(fixture.structured_output));
    expect(result.output!.tasks.length).toBeGreaterThan(0);
    expect(result.usage).toEqual({
      inputTokens: fixture.usage.input_tokens,
      outputTokens: fixture.usage.output_tokens,
      cacheReadTokens: fixture.usage.cache_read_input_tokens,
      cacheWriteTokens: fixture.usage.cache_creation_input_tokens,
    });
    expect(Object.keys(fixture.modelUsage)).toContain(result.model);
    const call = await recorded(record);
    const flag = (name: string) => call.args[call.args.indexOf(name) + 1];
    expect(call.args.slice(0, 3)).toEqual(["-p", "--output-format", "json"]);
    expect(flag("--model")).toBe("claude-opus-5");
    expect(flag("--effort")).toBe("high");
    expect(flag("--system-prompt")).toBe("You are Peter.");
    expect(flag("--tools")).toBe("");
    expect(JSON.parse(flag("--json-schema")).required).toContain("tasks");
    expect(call.args).toContain("--no-session-persistence");
    expect(call.stdin).toBe(`Goal from the owner:\n${RECORDED_GOAL}`);
    // An empty directory, not the board's; the board's own settings stay behind.
    expect(path.basename(call.cwd)).toMatch(/^rosterdock-peter-/);
    expect(call.env).toEqual(expect.arrayContaining(["PATH", "HOME", "CLAUDE_CONFIG_DIR"]));
    expect(call.env).not.toContain("DATABASE_URL");
  });

  it("throws the CLI's own message on an error answer (not signed in)", async () => {
    const call = replayer(ERROR, 1, path.join(dir, "error-call.json")).complete({
      model: "claude-opus-5",
      system: "s",
      user: "u",
      schema: PlanSchema,
    });
    await expect(call).rejects.toThrow(/the Claude CLI: Failed to authenticate/);
  });

  it("gives no output when the answer does not fit the schema asked for", async () => {
    const result = await replayer(PLAN, 0, path.join(dir, "shape-call.json")).complete({
      model: "claude-opus-5",
      system: "s",
      user: "u",
      schema: z.object({ colour: z.string() }),
    });
    expect(result.output).toBeNull();
    // What the schema said, for the caller to hand back to the model.
    expect(result.problems?.[0]).toMatch(/^colour: /);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });

  it("stops a CLI that never answers at the timeout", async () => {
    const call = replayer("hang", 0, path.join(dir, "hang-call.json"), 1500).complete({
      model: "m",
      system: "s",
      user: "u",
      schema: PlanSchema,
    });
    await expect(call).rejects.toThrow(/did not answer within 2 s/);
  });
});

describe("a board where the Claude CLI is signed in", () => {
  let board: TestBoard;
  const record = () => path.join(dir, "board-call.json");
  beforeAll(async () => {
    board = await startTestBoard(
      { peterClaudeBin: process.execPath },
      {
        peterCliPrefixArgs: [replay, PLAN, "0", record()],
        // Signed in, as the recorded status says (test/planners.test.ts parses the recording itself).
        plannerStatuses: async () => [
          {
            kind: "claude_cli",
            label: "Claude Code CLI",
            available: true,
            detail: "signed in (claude.ai, max)",
          },
          { kind: "codex_cli", label: "Codex CLI", available: false, detail: "turned off on this board" },
          {
            kind: "api",
            label: "Anthropic API",
            available: false,
            detail: "no ANTHROPIC_API_KEY on the board",
          },
        ],
      },
    );
  });
  afterAll(async () => {
    await board.destroy();
  });

  it("plans a goal through the CLI with the roster in the system prompt", async () => {
    const fixture = JSON.parse(await readFile(PLAN, "utf8"));
    const plan = PlanSchema.parse(fixture.structured_output);
    const { api, base } = await seedCompany(board, "cli@example.com");
    await seatedPeter(api, base);
    const team = {
      ricky: await addTeammate(api, base, "Ricky", "researcher"),
      brody: await addTeammate(api, base, "Brody", "requirements"),
      cody: await addTeammate(api, base, "Cody", "n8n engineer"),
      verifier: await addTeammate(api, base, "Verifier", "reviewer"),
    };
    // The recorded plan builds the page in a repository, so the goal names one.
    const res = await api.post(`${base}/goals`, {
      text: RECORDED_GOAL,
      repoUrl: "https://github.com/acme/site",
    });
    expect(res.status).toBe(201);
    expect(res.body.planner).toBe(`model:${Object.keys(fixture.modelUsage)[0]}`);
    expect(res.body.tasks.map((t: any) => [t.title, t.assignee.id])).toEqual(
      plan.tasks.map((t) => [
        t.title,
        team[t.assignee.replace(/^@/, "").toLowerCase() as keyof typeof team].id,
      ]),
    );
    const call = await recorded(record());
    const system = call.args[call.args.indexOf("--system-prompt") + 1];
    expect(system).toContain("@ricky (Ricky), researcher");
    expect(call.stdin).toContain(RECORDED_GOAL);
  });
});
