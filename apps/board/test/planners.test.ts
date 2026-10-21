// How Peter thinks, per company: what the model CLIs say about their sign-in
// (recorded), the Codex CLI's answers (recorded) and the arguments it gets, and
// a board where a company plans automatically, then with the Codex CLI, then
// with a brain the board cannot offer, then without a model. The CLIs are a
// replayer of recordings.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codexCliModel } from "../src/peter/codex-cli.js";
import { PlanSchema } from "../src/peter/plan.js";
import {
  parseClaudeStatus,
  parseCodexStatus,
  probePlanners,
  type PlannerStatus,
} from "../src/peter/planners.js";
import { addTeammate, seatedPeter, seedCompany, startTestBoard, type TestBoard } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const replay = path.join(here, "claude-cli-replay.mjs");
const fixtures = path.join(here, "fixtures");
const status = (name: string) => path.join(fixtures, "planners", `${name}.json`);
const CLAUDE_PLAN = path.join(fixtures, "claude-cli", "plan.json");
const CODEX_PLAN = path.join(fixtures, "codex-cli", "plan.jsonl");
const CODEX_ERROR = path.join(fixtures, "codex-cli", "error.jsonl");

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rosterdock-planners-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const answer = async (name: string) => JSON.parse(await readFile(status(name), "utf8"));
const recorded = async (file: string) => JSON.parse(await readFile(file, "utf8"));
const codexPlan = async () => {
  const lines = (await readFile(CODEX_PLAN, "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const message = lines.filter((e) => e.type === "item.completed" && e.item.type === "agent_message").pop();
  return {
    plan: PlanSchema.parse(JSON.parse(message.item.text)),
    usage: lines.find((e) => e.type === "turn.completed").usage,
  };
};

describe("what the model CLIs say about their sign-in", () => {
  it("reads Claude's JSON and Codex's line, signed in and signed out", async () => {
    expect(parseClaudeStatus(await answer("claude-signed-in"))).toEqual({
      available: true,
      detail: "signed in (claude.ai, max)",
    });
    expect(parseClaudeStatus(await answer("claude-signed-out"))).toEqual({
      available: false,
      detail: "installed, not signed in: run claude auth login where the board runs",
    });
    expect(parseCodexStatus(await answer("codex-signed-in"))).toEqual({
      available: true,
      detail: "signed in using ChatGPT",
    });
    expect(parseCodexStatus(await answer("codex-signed-out"))).toEqual({
      available: false,
      detail: "installed, not signed in: run codex login where the board runs",
    });
  });

  it("asks each CLI, and says so when one is not installed or turned off", async () => {
    const node = process.execPath;
    const signedIn = await probePlanners({
      claude: {
        bin: node,
        prefixArgs: [replay, status("claude-signed-in"), "answer", path.join(dir, "c1.json")],
      },
      codex: {
        bin: node,
        prefixArgs: [replay, status("codex-signed-out"), "answer", path.join(dir, "x1.json")],
      },
      apiKey: false,
    });
    expect(signedIn.map((s) => [s.kind, s.available, s.detail])).toEqual([
      ["claude_cli", true, "signed in (claude.ai, max)"],
      ["codex_cli", false, "installed, not signed in: run codex login where the board runs"],
      ["api", false, "no ANTHROPIC_API_KEY on the board"],
    ]);
    expect((await recorded(path.join(dir, "c1.json"))).args).toEqual(["auth", "status"]);
    expect((await recorded(path.join(dir, "x1.json"))).args).toEqual(["login", "status"]);
    const missing = await probePlanners({
      claude: null,
      codex: { bin: path.join(dir, "no-such-codex") },
      apiKey: true,
    });
    // In a pod the way in is a token in the board's secret, not a login.
    const pod = await probePlanners({
      claude: {
        bin: node,
        prefixArgs: [replay, status("claude-signed-out"), "answer", path.join(dir, "c2.json")],
      },
      codex: {
        bin: node,
        prefixArgs: [replay, status("codex-signed-out"), "answer", path.join(dir, "x2.json")],
      },
      apiKey: false,
      env: { PATH: process.env.PATH ?? "", KUBERNETES_SERVICE_HOST: "10.96.0.1" },
    });
    expect(pod.slice(0, 2).map((s) => s.detail)).toEqual([
      "installed, not signed in: put CLAUDE_CODE_OAUTH_TOKEN (from claude setup-token) in the board's planner secret",
      "installed, not signed in: put OPENAI_API_KEY in the board's planner secret",
    ]);
    expect(missing.map((s) => [s.kind, s.available, s.detail])).toEqual([
      ["claude_cli", false, "turned off on this board"],
      ["codex_cli", false, "not installed where the board runs"],
      ["api", true, "ANTHROPIC_API_KEY is set on the board"],
    ]);
  });
});

describe("the Codex CLI as Peter's model", () => {
  it("hands Codex the schema as a file and one prompt, and reads the last message and the turn's usage", async () => {
    const record = path.join(dir, "codex-call.json");
    const { plan, usage } = await codexPlan();
    const model = codexCliModel({ bin: process.execPath, prefixArgs: [replay, CODEX_PLAN, "0", record] });
    const result = await model.complete({
      model: "gpt-6-astra",
      effort: "xhigh",
      system: "You are Peter.",
      user: "Goal from the owner:\nA brief.",
      schema: PlanSchema,
    });
    expect(result.output).toEqual(plan);
    expect(result.model).toBe("gpt-6-astra");
    expect(result.usage).toEqual({
      inputTokens: usage.input_tokens - usage.cached_input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cached_input_tokens,
      cacheWriteTokens: usage.cache_write_input_tokens,
    });
    const call = await recorded(record);
    expect(call.args.slice(0, 4)).toEqual(["exec", "--json", "--output-schema", "answer-schema.json"]);
    expect(call.args).toEqual(
      expect.arrayContaining(["--sandbox", "read-only", "--ignore-user-config", "--ephemeral"]),
    );
    expect(call.args[call.args.indexOf("--model") + 1]).toBe("gpt-6-astra");
    expect(call.args[call.args.indexOf('model_reasoning_effort="xhigh"') - 1]).toBe("-c");
    expect(JSON.parse(call.schema).required).toContain("tasks");
    expect(call.stdin).toContain("You are Peter.");
    expect(call.stdin).toContain("Goal from the owner:\nA brief.");
    expect(call.env).not.toContain("DATABASE_URL");

    // The Claude model on a manager's row is not Codex's: Codex's own default then.
    await model.complete({ model: "claude-opus-5", system: "s", user: "u", schema: PlanSchema });
    expect((await recorded(record)).args).not.toContain("--model");
  });

  it("throws the API's own message when the turn fails", async () => {
    const model = codexCliModel({
      bin: process.execPath,
      prefixArgs: [replay, CODEX_ERROR, "1", path.join(dir, "codex-error.json")],
    });
    await expect(
      model.complete({ model: "no-such-model-xyz", system: "s", user: "u", schema: PlanSchema }),
    ).rejects.toThrow(
      "the Codex CLI: The 'no-such-model-xyz' model is not supported when using Codex with a ChatGPT account.",
    );
  });
});

describe("each company's planner", () => {
  let board: TestBoard;
  let statuses: PlannerStatus[] = [
    { kind: "claude_cli", label: "Claude Code CLI", available: true, detail: "signed in (claude.ai, max)" },
    { kind: "codex_cli", label: "Codex CLI", available: true, detail: "signed in using ChatGPT" },
    { kind: "api", label: "Anthropic API", available: false, detail: "no ANTHROPIC_API_KEY on the board" },
  ];
  const claudeRecord = () => path.join(dir, "board-claude.json");
  const codexRecord = () => path.join(dir, "board-codex.json");
  beforeAll(async () => {
    board = await startTestBoard(
      { peterClaudeBin: process.execPath, peterCodexBin: process.execPath },
      {
        peterCliPrefixArgs: [replay, CLAUDE_PLAN, "0", claudeRecord()],
        peterCodexPrefixArgs: [replay, CODEX_PLAN, "0", codexRecord()],
        plannerStatuses: async () => statuses,
      },
    );
  });
  afterAll(async () => {
    await board.destroy();
  });

  it("plans automatically with what works here, then with what the company chose, or without a model", async () => {
    const { api, base } = await seedCompany(board, "planner@example.com");
    await seatedPeter(api, base);
    for (const [name, role] of [
      ["Ricky", "researcher"],
      ["Brody", "requirements"],
      ["Cody", "n8n engineer"],
      ["Verifier", "reviewer"],
    ])
      await addTeammate(api, base, name!, role);
    const planner = async () => (await api.get(`${base}/planner?refresh=1`)).body;
    // The recorded Claude plan builds a page in a repository, so every goal here names one.
    const plannedBy = async (text: string) =>
      (await api.post(`${base}/goals`, { text, repoUrl: "https://github.com/acme/site" })).body
        .planner as string;
    const choose = async (choice: object) =>
      expect((await api.patch(base, { settings: { planner: choice } })).status).toBe(200);

    // Nothing chosen: the first brain that works here, the Claude CLI.
    const auto = await planner();
    expect(auto).toMatchObject({
      choice: { via: "auto" },
      effective: "claude_cli",
      reason: "automatic: the Claude Code CLI",
    });
    expect(auto.options.map((o: any) => [o.kind, o.available])).toEqual([
      ["claude_cli", true],
      ["codex_cli", true],
      ["api", false],
    ]);
    expect(await plannedBy("A brief, planned automatically.")).toBe("model:claude-opus-5");

    // The company chooses the Codex CLI, with a model of its own.
    await choose({ via: "codex_cli", model: "gpt-6-astra" });
    expect(await planner()).toMatchObject({ effective: "codex_cli", reason: "the Codex CLI" });
    expect(await plannedBy("A brief, planned by Codex.")).toBe("model:gpt-6-astra");
    const codexCall = await recorded(codexRecord());
    expect(codexCall.args[codexCall.args.indexOf("--model") + 1]).toBe("gpt-6-astra");
    expect(codexCall.stdin).toContain("@ricky (Ricky), researcher");

    // Codex signs out: the company still plans, by role, and the goal says why.
    statuses = statuses.map((s) =>
      s.kind === "codex_cli"
        ? { ...s, available: false, detail: "installed, not signed in: run codex login where the board runs" }
        : s,
    );
    expect(await planner()).toMatchObject({
      effective: null,
      reason:
        "the Codex CLI is not available on this board: installed, not signed in: run codex login where the board runs",
    });
    expect(await plannedBy("A brief while Codex is signed out.")).toMatch(
      /^heuristic \(the model call failed: the Codex CLI is not available on this board/,
    );

    // No model at all: Peter plans by role and says nothing is wrong.
    await choose({ via: "none" });
    expect(await planner()).toMatchObject({ effective: null, reason: "this company plans without a model" });
    expect(await plannedBy("A brief without a model.")).toBe("heuristic");
  });
});
