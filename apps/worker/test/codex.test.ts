import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RunEventInput } from "@rosterdock/shared";
import { codexReach, type CodexReach } from "@rosterdock/shared";
import {
  buildArgs,
  codexControls,
  codexWebNote,
  createCodexEngine,
  errorText,
  parseCodexStream,
  resolveCodexBin,
} from "../src/engines/codex.js";

/** What the department's list leaves Codex; the list must be one Codex keeps to. */
function reachOf(list: string[]): CodexReach {
  const reach = codexReach(list);
  if (!reach.ok) throw new Error(reach.reason);
  return reach;
}

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
      // No MCP server but the board's: ChatGPT sign-ins otherwise bring their apps, and plugins their servers.
      "-c",
      "features.apps=false",
      "-c",
      "features.plugins=false",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
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

  it("holds Codex to a department's tool list with its own controls, never wider than the worker's sandbox", () => {
    const workspace = ["Read(./**)", "Write(./**)", "Edit(./**)", "Glob(./**)", "Grep(./**)"];
    // No write tool: read-only. No WebFetch: no network for its commands. No WebSearch: no web search.
    expect(codexControls("workspace-write", reachOf(["Bash", "Read(./**)", "Grep(./**)"]))).toEqual({
      sandbox: "read-only",
      config: [
        "features.apps=false",
        "features.plugins=false",
        "sandbox_workspace_write.network_access=false",
        'web_search="disabled"',
      ],
    });
    // A worker that runs Codex without its sandbox brings it back to workspace-write for a list without WebFetch.
    expect(codexControls("danger-full-access", reachOf([...workspace, "Bash"])).sandbox).toBe(
      "workspace-write",
    );
    // WebFetch on its own keeps the worker's network, WebSearch the search.
    expect(
      codexControls("danger-full-access", reachOf([...workspace, "Bash", "WebFetch", "WebSearch"])),
    ).toEqual({ sandbox: "danger-full-access", config: ["features.apps=false", "features.plugins=false"] });
    // Never wider than the worker's: a read-only worker stays so, and workspace-write gains no network.
    expect(codexControls("read-only", reachOf([...workspace, "Bash", "WebFetch"])).sandbox).toBe("read-only");
    expect(codexControls("workspace-write", reachOf([...workspace, "Bash", "WebFetch"]))).toEqual({
      sandbox: "workspace-write",
      config: ["features.apps=false", "features.plugins=false", 'web_search="disabled"'],
    });
    // On the command line, after approvals.
    const args = buildArgs(
      { bin: "codex", sandbox: "workspace-write" },
      "m",
      null,
      "/w",
      null,
      reachOf(["Bash", "Read"]),
    );
    expect(args.slice(0, 14)).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "-c",
      'approval_policy="never"',
      "-c",
      "features.apps=false",
      "-c",
      "features.plugins=false",
      "-c",
      "sandbox_workspace_write.network_access=false",
      "-c",
      'web_search="disabled"',
    ]);
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
const must = ["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--model", "gpt-5-codex", "--output-last-message", "-"];
const cfg = args.filter((a, i) => args[i - 1] === "-c");
if (!cfg.includes('mcp_servers.rosterdock.url="http://board.test/api/mcp"') || !cfg.includes('mcp_servers.rosterdock.bearer_token_env_var="ROSTERDOCK_RUN_TOKEN"') || process.env.ROSTERDOCK_RUN_TOKEN !== "run-token") { process.stderr.write("stub: mcp not wired"); process.exit(8); }
if (!cfg.includes("features.apps=false") || !cfg.includes("features.plugins=false")) { process.stderr.write("stub: an MCP server besides the board's"); process.exit(7); }
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

  it("tells the teammate when Codex keeps its own web search or network, which do not go through the board", async () => {
    const open = { write: true, network: true, webSearch: true };
    expect(codexWebNote("workspace-write", open)).toContain(
      "This worker also leaves Codex its own web search, from a cached index. They reach the web outside the board",
    );
    expect(codexWebNote("danger-full-access", open)).toContain(
      "leaves Codex its own web search and commands that reach the network.",
    );
    expect(codexWebNote("danger-full-access", { ...open, network: false })).toContain(
      "its own web search, from a cached index.",
    );
    expect(codexWebNote("workspace-write", { ...open, webSearch: false })).toBeNull();
    expect(codexWebNote("read-only", { write: false, network: true, webSearch: false })).toBeNull();
    // The brief Codex reads carries it.
    const dir = await mkdtemp(path.join(os.tmpdir(), "rosterdock-codex-web-"));
    const replay = path.join(dir, "replay.mjs");
    await writeFile(
      replay,
      `import { readFile, writeFile } from "node:fs/promises";
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
await writeFile(process.env.PROMPT_PATH, Buffer.concat(chunks));
process.stdout.write(await readFile(process.env.FIXTURE_PATH, "utf8"));`,
      "utf8",
    );
    const prompt = async (allowedTools: string[] | null) => {
      await createCodexEngine({
        bin: process.execPath,
        sandbox: "workspace-write",
        prefixArgs: [replay],
      }).run({
        workdir: dir,
        pack: "# Research task",
        model: "m",
        signal: new AbortController().signal,
        emit: () => {},
        onUsage: () => {},
        env: {
          PROMPT_PATH: path.join(dir, "prompt.txt"),
          FIXTURE_PATH: path.join(fixtures, "codex-success.jsonl"),
        },
        allowedTools,
        mcp: null,
      });
      return readFile(path.join(dir, "prompt.txt"), "utf8");
    };
    try {
      expect(await prompt(null)).toContain("# Research task\n\n## Your engine's own web tools");
      expect(await prompt(["Bash", "Read(./**)", "Write(./**)"])).not.toContain("own web tools");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runs Codex as the department's tool list narrows it, and says how in the run log", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "rosterdock-codex-"));
    const replay = path.join(dir, "replay.mjs");
    await writeFile(
      replay,
      `import { readFile, writeFile } from "node:fs/promises";
for await (const c of process.stdin) {}
await writeFile(process.env.ARGV_PATH, JSON.stringify(process.argv.slice(2)), "utf8");
process.stdout.write(await readFile(process.env.FIXTURE_PATH, "utf8"));`,
      "utf8",
    );
    const events: RunEventInput[] = [];
    try {
      const result = await createCodexEngine({
        bin: process.execPath,
        sandbox: "danger-full-access",
        prefixArgs: [replay],
      }).run({
        workdir: dir,
        pack: "x",
        model: "m",
        signal: new AbortController().signal,
        emit: (e) => events.push(e),
        onUsage: () => {},
        env: {
          ARGV_PATH: path.join(dir, "argv.json"),
          FIXTURE_PATH: path.join(fixtures, "codex-success.jsonl"),
        },
        allowedTools: ["Bash", "Read(./**)", "Grep(./**)", "WebSearch"],
        mcp: null,
      });
      expect(result.ok).toBe(true);
      const argv = JSON.parse(await readFile(path.join(dir, "argv.json"), "utf8")) as string[];
      expect(argv[argv.indexOf("--sandbox") + 1]).toBe("read-only");
      const cfg = argv.filter((_, i) => argv[i - 1] === "-c");
      expect(cfg).toContain("sandbox_workspace_write.network_access=false");
      expect(cfg).not.toContain('web_search="disabled"');
      expect(events[0]).toEqual({
        type: "stderr",
        payload: {
          text: "The department's tool list runs Codex in the read-only sandbox (this worker's is danger-full-access): no network for its commands, web search on.",
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a tool list it cannot keep to and starts nothing, naming the department and the way out", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "rosterdock-codex-"));
    const started = path.join(dir, "started");
    const mark = path.join(dir, "mark.mjs");
    await writeFile(
      mark,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(started)}, "yes");`,
      "utf8",
    );
    const engine = createCodexEngine({
      bin: process.execPath,
      sandbox: "workspace-write",
      prefixArgs: [mark],
    });
    const workspace = ["Read(./**)", "Write(./**)", "Edit(./**)", "Glob(./**)", "Grep(./**)"];
    try {
      expect(engine.refuse?.(workspace, "Research")).toEqual({
        what: "Codex cannot keep to Research's tool list.",
        why: "It reads files and runs commands only through its shell, and the list leaves out Bash.",
        fix: "Name Bash on its own in the list, or pick another engine in the teammate's editor.",
      });
      expect(engine.refuse?.([...workspace, "Bash(npm test:*)"], null)).toMatchObject({
        what: "Codex cannot keep to the department's tool list.",
        why: "It cannot hold its shell to some commands, and the list allows only Bash(npm test:*).",
      });
      expect(engine.refuse?.([...workspace, "Bash"], "Research")).toBeNull();
      expect(engine.refuse?.(null, "Research")).toBeNull();
      // Run anyway, it still starts nothing.
      const result = await engine.run({
        workdir: dir,
        pack: "x",
        model: "m",
        signal: new AbortController().signal,
        emit: () => {},
        onUsage: () => {},
        env: {},
        allowedTools: workspace,
        mcp: null,
      });
      expect(result).toEqual({
        ok: false,
        exitCode: null,
        usage: {},
        resultText: null,
        error:
          "Codex cannot keep to the department's tool list. It reads files and runs commands only through its shell, and the list leaves out Bash. Name Bash on its own in the list, or pick another engine in the teammate's editor.",
      });
      expect(existsSync(started)).toBe(false);
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
