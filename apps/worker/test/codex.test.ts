import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RunEventInput } from "@rosterdock/shared";
import {
  buildArgs,
  createCodexEngine,
  errorText,
  parseCodexStream,
  resolveCodexBin,
} from "../src/engines/codex.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("codex JSONL parsing", () => {
  it("turns a recorded run into events and usage: a shell command once, the messages, cached input apart", async () => {
    const raw = await readFile(path.join(fixtures, "codex-success.jsonl"), "utf8");
    const parsed = parseCodexStream(raw);
    expect(parsed.isError).toBe(false);
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.resultText).toBe("The kickoff was on Tuesday.");
    // Codex reports cached input inside input_tokens; the board prices cache reads apart.
    expect(parsed.usage).toEqual({
      inputTokens: 26_863 - 22_912,
      outputTokens: 306,
      cacheReadTokens: 22_912,
      cacheWriteTokens: 0,
    });
    expect(parsed.events.map((e) => e.type)).toEqual(["engine", "assistant", "tool", "assistant", "result"]);
    const tool = parsed.events.find((e) => e.type === "tool")!;
    expect(tool.payload?.name).toBe("shell");
    expect(String(tool.payload?.input)).toContain("Get-ChildItem");
    // The command's output stays in the sandbox.
    expect(JSON.stringify(parsed.events)).not.toContain("aggregated_output");
    expect(JSON.stringify(parsed.events)).not.toContain("kickoff was on Tuesday.\\r");
  });

  it("recognises the recorded model failure: an error item, the API error and a failed turn, no usage", async () => {
    const parsed = parseCodexStream(await readFile(path.join(fixtures, "codex-error.jsonl"), "utf8"));
    expect(parsed.isError).toBe(true);
    expect(parsed.errorMessage).toBe(
      "The 'no-such-model-xyz' model is not supported when using Codex with a ChatGPT account.",
    );
    expect(parsed.usage).toEqual({});
    expect(parsed.resultText).toBeNull();
    expect(parsed.events.map((e) => e.type)).toEqual(["engine", "stderr", "stderr", "result"]);
    expect(parsed.events[1]?.payload?.text).toMatch(/Model metadata for `no-such-model-xyz` not found/);
    expect(parsed.events.at(-1)?.payload).toEqual({ subtype: "error", isError: true });
  });

  it("unwraps the API envelope Codex puts in error messages, and keeps plain text as is", () => {
    expect(errorText('{"type":"error","error":{"message":"quota exceeded"}}')).toBe("quota exceeded");
    expect(errorText("stream disconnected")).toBe("stream disconnected");
    expect(errorText(undefined)).toBe("an error");
  });

  it("keeps non-JSON lines as stdout events", () => {
    expect(parseCodexStream("not json\n").events).toEqual([
      { type: "stdout", payload: { text: "not json" } },
    ]);
  });

  it("cuts a long agent message without splitting an emoji", () => {
    const text = `x${"😀".repeat(1500)}`;
    const parsed = parseCodexStream(
      `${JSON.stringify({ type: "item.completed", item: { id: "i", type: "agent_message", text } })}\n`,
    );
    const out = String(parsed.events[0]?.payload?.text);
    expect(out.isWellFormed()).toBe(true);
    expect(out.endsWith("…")).toBe(true);
    expect(parsed.resultText).toBe(text);
  });
});

describe("invocation", () => {
  it("builds the headless argv: approvals off, the operator's config ignored, the board MCP server by config and the token by env var name", () => {
    const args = buildArgs(
      { bin: "codex", sandbox: "workspace-write" },
      "gpt-5-codex",
      { url: "http://board.test/api/mcp" },
      "/work/run-1",
    );
    expect(args).toEqual([
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
      "-c",
      'mcp_servers.rosterdock.url="http://board.test/api/mcp"',
      "-c",
      'mcp_servers.rosterdock.bearer_token_env_var="ROSTERDOCK_RUN_TOKEN"',
      "--model",
      "gpt-5-codex",
      "--output-last-message",
      path.join("/work/run-1", "handover-summary.md"),
      "-",
    ]);
    expect(JSON.stringify(args)).not.toContain("run-token");
    expect(buildArgs({ bin: "codex", sandbox: "read-only" }, "m", null, "/w")).not.toContain("-c mcp");
  });

  it("passes the teammate's effort as model_reasoning_effort, and nothing when it is the default", () => {
    const opts = { bin: "codex", sandbox: "workspace-write" as const };
    const args = buildArgs(opts, "gpt-6-astra", null, "/w", "high");
    expect(
      args.slice(
        args.indexOf('model_reasoning_effort="high"') - 1,
        args.indexOf('model_reasoning_effort="high"') + 1,
      ),
    ).toEqual(["-c", 'model_reasoning_effort="high"']);
    expect(buildArgs(opts, "gpt-6-astra", null, "/w", null).join(" ")).not.toContain(
      "model_reasoning_effort",
    );
  });

  it("resolves the Windows npm shim to codex.js run by this Node", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "rosterdock-codex-shim-"));
    try {
      const js = path.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
      await (await import("node:fs/promises")).mkdir(path.dirname(js), { recursive: true });
      await writeFile(js, "", "utf8");
      expect(resolveCodexBin("codex", { PATH: dir }, "win32")).toEqual({
        bin: process.execPath,
        prefix: [js],
      });
      expect(resolveCodexBin("codex", { PATH: dir }, "linux")).toEqual({ bin: "codex", prefix: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runs a stub binary the way it would run Codex: prompt on stdin, JSONL on stdout, the token in the environment only", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "rosterdock-codex-"));
    const stub = path.join(dir, "codex-stub.mjs");
    await writeFile(
      stub,
      `
import { writeFile, readFile } from "node:fs/promises";
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const prompt = Buffer.concat(chunks).toString("utf8");
const args = process.argv.slice(2);
const must = ["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--model", "gpt-5-codex", "--output-last-message", "-"];
const cfg = args.filter((a, i) => args[i - 1] === "-c");
if (!cfg.includes('mcp_servers.rosterdock.url="http://board.test/api/mcp"') || !cfg.includes('mcp_servers.rosterdock.bearer_token_env_var="ROSTERDOCK_RUN_TOKEN"') || process.env.ROSTERDOCK_RUN_TOKEN !== "run-token") { process.stderr.write("stub: mcp not wired"); process.exit(8); }
if (must.some((a) => !args.includes(a)) || args.at(-1) !== "-" || !prompt.includes("# Fixture task") || process.env.LEAKED_SECRET || args.some((a) => a.includes("run-token"))) {
  process.stderr.write("stub: bad invocation\\n");
  process.exit(9);
}
await writeFile("notes.txt", "The kickoff was on Tuesday.\\n", "utf8");
await writeFile(args[args.indexOf("--output-last-message") + 1], "The kickoff was on Tuesday.", "utf8");
const lines = (await readFile(process.env.FIXTURE_PATH, "utf8")).split("\\n").filter(Boolean);
for (const l of lines) process.stdout.write(l + "\\n");
`,
      "utf8",
    );
    const events: RunEventInput[] = [];
    let usage = {};
    const engine = createCodexEngine({
      bin: process.execPath,
      sandbox: "workspace-write",
      prefixArgs: [stub],
    });
    const result = await engine.run({
      workdir: dir,
      pack: "# Fixture task\n\nRead the notes.",
      model: "gpt-5-codex",
      signal: new AbortController().signal,
      emit: (e) => events.push(e),
      onUsage: (u) => (usage = u),
      env: {
        PATH: process.env.PATH ?? "",
        Path: process.env.Path ?? "",
        FIXTURE_PATH: path.join(fixtures, "codex-success.jsonl"),
      },
      allowedTools: null,
      mcp: { url: "http://board.test/api/mcp", token: "run-token" },
    });
    try {
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.usage.outputTokens).toBe(306);
      expect(usage).toEqual(result.usage);
      expect(result.resultText).toBe("The kickoff was on Tuesday.");
      expect(events.map((e) => e.type)).toContain("tool");
      // Codex's last message is the handover the worker harvests.
      expect(await readFile(path.join(dir, "handover-summary.md"), "utf8")).toBe(
        "The kickoff was on Tuesday.",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports a failed turn with Codex's reason, a non-zero exit as a failure, and a stop as stopped", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "rosterdock-codex-"));
    const replay = path.join(dir, "replay.mjs");
    await writeFile(
      replay,
      `import { readFile } from "node:fs/promises";
for await (const c of process.stdin) {}
process.stdout.write(await readFile(process.env.FIXTURE_PATH, "utf8"));
process.exit(1);`,
      "utf8",
    );
    const run = (script: string, env: Record<string, string>, signal = new AbortController().signal) =>
      createCodexEngine({ bin: process.execPath, sandbox: "workspace-write", prefixArgs: [script] }).run({
        workdir: dir,
        pack: "x",
        model: "m",
        signal,
        emit: (e) => events.push(e),
        onUsage: () => {},
        env,
        allowedTools: null,
        mcp: null,
      });
    const events: RunEventInput[] = [];
    const failed = await run(replay, { FIXTURE_PATH: path.join(fixtures, "codex-error.jsonl") });
    expect(failed.ok).toBe(false);
    expect(failed.error).toBe(
      "Codex reported an error: The 'no-such-model-xyz' model is not supported when using Codex with a ChatGPT account.",
    );

    const failing = path.join(dir, "fail.mjs");
    await writeFile(failing, 'process.stderr.write("boom\\n"); process.exit(3);', "utf8");
    const crashed = await run(failing, {});
    expect(crashed.ok).toBe(false);
    expect(crashed.error).toMatch(/exited with code 3: boom/);
    expect(events.some((e) => e.type === "stderr" && e.payload?.text === "boom")).toBe(true);

    const hanging = path.join(dir, "hang.mjs");
    await writeFile(hanging, "setInterval(() => {}, 1000);", "utf8");
    const ac = new AbortController();
    const p = run(hanging, {}, ac.signal);
    setTimeout(() => ac.abort(), 300);
    const stopped = await p;
    expect(stopped.ok).toBe(false);
    expect(stopped.error).toBe("stopped");
    // Codex counts tokens only when its turn completes: the run log says this one counted none.
    expect(events.at(-1)).toEqual({
      type: "stderr",
      payload: {
        text: "Codex stopped before it reported its token use, so this run's tokens are not counted.",
      },
    });
    await rm(dir, { recursive: true, force: true });
  });

  it("says in the run log that a department's tool list does not narrow Codex", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "rosterdock-codex-"));
    const quiet = path.join(dir, "quiet.mjs");
    await writeFile(quiet, "for await (const c of process.stdin) {}", "utf8");
    const events: RunEventInput[] = [];
    try {
      await createCodexEngine({ bin: process.execPath, sandbox: "read-only", prefixArgs: [quiet] }).run({
        workdir: dir,
        pack: "x",
        model: "m",
        signal: new AbortController().signal,
        emit: (e) => events.push(e),
        onUsage: () => {},
        env: {},
        allowedTools: ["Read(./**)"],
        mcp: null,
      });
      expect(events).toContainEqual({
        type: "stderr",
        payload: {
          text: "The department's tool list applies to Claude Code teammates; Codex runs in this worker's read-only sandbox.",
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("says Codex is not installed when the worker has no binary", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "rosterdock-codex-"));
    const bin = path.join(dir, "codex");
    try {
      const result = await createCodexEngine({ bin, sandbox: "workspace-write" }).run({
        workdir: dir,
        pack: "x",
        model: "m",
        signal: new AbortController().signal,
        emit: () => {},
        onUsage: () => {},
        env: {},
        allowedTools: null,
        mcp: null,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toBe(
        `Codex is not installed on this worker (${bin} not found); docs/install.md says how to add it`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
