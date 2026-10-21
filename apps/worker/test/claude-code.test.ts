import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RunEventInput } from "@rosterdock/shared";
import {
  buildArgs,
  createClaudeCodeEngine,
  DEFAULT_ALLOWED_TOOLS,
  narrowTools,
  parseStream,
  resolveClaudeBin,
} from "../src/engines/claude-code.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("stream-json parsing", () => {
  it("turns a recorded successful run into events and usage, ignoring thinking and rate-limit frames", async () => {
    const raw = await readFile(path.join(fixtures, "claude-code-success.ndjson"), "utf8");
    const parsed = parseStream(raw);
    expect(parsed.isError).toBe(false);
    expect(parsed.subtype).toBe("success");
    // Every Claude Code run carries the CLI system prompt as cache-written input: tens of thousands of tokens.
    expect(parsed.usage.cacheWriteTokens).toBeGreaterThan(20_000);
    expect(parsed.usage.outputTokens).toBeGreaterThan(0);
    expect(typeof parsed.resultText).toBe("string");
    expect(parsed.durationMs).toBeGreaterThan(0);
    const types = parsed.events.map((e) => e.type);
    expect(types[0]).toBe("engine");
    expect(types.at(-1)).toBe("result");
    const tools = parsed.events.filter((e) => e.type === "tool");
    expect(tools.map((e) => e.payload?.name)).toEqual(["Write", "Write"]);
    expect(String(tools[0]?.payload?.input)).toMatch(/vms-architecture.md$/);
    // Thinking blocks, their signatures, tool results and file contents never become events.
    const dumped = JSON.stringify(parsed.events);
    expect(dumped).not.toContain("signature");
    expect(dumped).not.toContain("File created successfully");
    expect(raw).toContain("rate_limit_event");
    expect(types).not.toContain("stdout");
  });

  it("counts what the recorded messages cost when the run ends before its result", async () => {
    const raw = await readFile(path.join(fixtures, "claude-code-success.ndjson"), "utf8");
    const cut = raw
      .split("\n")
      .filter((l) => l && JSON.parse(l).type !== "result")
      .join("\n");
    // Two messages: input and cache tokens in full, output as far as the stream had counted it.
    expect(parseStream(cut).usage).toEqual({
      inputTokens: 18,
      outputTokens: 4,
      cacheReadTokens: 37471,
      cacheWriteTokens: 38068,
    });
    // The result's own count replaces the running sum.
    expect(parseStream(raw).usage).toEqual({
      inputTokens: 18,
      outputTokens: 489,
      cacheReadTokens: 37471,
      cacheWriteTokens: 38068,
    });
  });

  it("recognises the recorded auth failure as an error result with no usage", async () => {
    const parsed = parseStream(await readFile(path.join(fixtures, "claude-code-auth-error.ndjson"), "utf8"));
    expect(parsed.isError).toBe(true);
    expect(parsed.resultText).toMatch(/Failed to authenticate/);
    expect(parsed.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(parsed.events.map((e) => e.type)).toEqual(["engine", "assistant", "result"]);
  });

  it("cuts long assistant text without splitting an emoji", () => {
    const text = `x${"😀".repeat(1500)}`;
    const parsed = parseStream(
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } })}\n`,
    );
    const out = String(parsed.events[0]?.payload?.text);
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out.isWellFormed()).toBe(true);
  });

  it("keeps non-JSON lines as stdout events", () => {
    const parsed = parseStream("not json\n");
    expect(parsed.events).toEqual([{ type: "stdout", payload: { text: "not json" } }]);
  });
});

describe("invocation", () => {
  it("passes the teammate's effort as --effort, and nothing when it is the engine's default", () => {
    const opts = { bin: "claude", allowedTools: "Write(./**)" };
    const args = buildArgs(opts, "claude-opus-5-5", null, null, "xhigh");
    expect(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2)).toEqual(["--effort", "xhigh"]);
    expect(buildArgs(opts, "claude-opus-5-5", null, null, null)).not.toContain("--effort");
  });

  it("builds the headless argv with the token-hygiene flags", () => {
    const args = buildArgs({ bin: "claude", allowedTools: "Write(./**)" }, "claude-sonnet-5");
    expect(args).toEqual([
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
      "Write",
      "--allowedTools",
      "Write(./**)",
      "--model",
      "claude-sonnet-5",
    ]);
  });

  it("narrows the worker's allowlist with the department's list and never widens it", () => {
    // The Lighthouse template's Research department, against the worker's default list.
    const research = [
      "Read(./**)",
      "Write(./**)",
      "Edit(./**)",
      "Glob(./**)",
      "Grep(./**)",
      "WebSearch",
      "WebFetch",
    ];
    expect(narrowTools(DEFAULT_ALLOWED_TOOLS, research)).toEqual({
      tools: ["Read(./**)", "Write(./**)", "Edit(./**)", "Glob(./**)", "Grep(./**)"],
      dropped: ["WebSearch", "WebFetch"],
    });
    // A worker that allows the web tools hands them on.
    expect(narrowTools(`${DEFAULT_ALLOWED_TOOLS},WebSearch,WebFetch`, research).dropped).toEqual([]);
    // A department cannot add Bash, and can keep less than the worker allows.
    expect(narrowTools(DEFAULT_ALLOWED_TOOLS, ["Read(./**)", "Bash", "Bash(npm test:*)"])).toEqual({
      tools: ["Read(./**)"],
      dropped: ["Bash", "Bash(npm test:*)"],
    });
    // A bare name keeps the worker's own rules for that tool; a rule under a tool the worker allows whole stays.
    expect(narrowTools(DEFAULT_ALLOWED_TOOLS, ["Read", "Write"]).tools).toEqual([
      "Read(./**)",
      "Write(./**)",
    ]);
    expect(narrowTools("Read,Bash", ["Read(./src/**)", "Bash(git diff:*)"]).tools).toEqual([
      "Read(./src/**)",
      "Bash(git diff:*)",
    ]);
    // The board's own tools are always there and never reported as dropped.
    expect(narrowTools(DEFAULT_ALLOWED_TOOLS, ["mcp__rosterdock", "Read(./**)"])).toEqual({
      tools: ["Read(./**)"],
      dropped: [],
    });
    // No department list: the worker's list as it is.
    expect(narrowTools("Read,Write", null).tools).toEqual(["Read", "Write"]);
  });

  it("gives Claude Code only the list's built-in tools, so a list without Bash leaves it no shell", () => {
    // --allowedTools alone only pre-approves: in acceptEdits mode Claude Code still ran read-only Bash
    // (wc, git status, grep, sed) for teammates whose list had no Bash. --tools is what exists.
    const opts = { bin: "claude", allowedTools: DEFAULT_ALLOWED_TOOLS };
    const available = (args: string[]) => args[args.indexOf("--tools") + 1];
    expect(available(buildArgs(opts, "m", null, "/tmp/mcp.json"))).toBe("Read,Write,Edit,Glob,Grep");
    expect(available(buildArgs(opts, "m", ["Read(./**)", "Bash"], null))).toBe("Read");
    expect(available(buildArgs(opts, "m", ["WebFetch"], "/tmp/mcp.json"))).toBe("");
    expect(
      available(buildArgs({ bin: "claude", allowedTools: "Read,Bash(npm test:*),mcp__rosterdock" }, "m")),
    ).toBe("Read,Bash");
  });

  it("passes only the narrowed list, the board's tools added, and no list at all when nothing is left", () => {
    const opts = { bin: "claude", allowedTools: DEFAULT_ALLOWED_TOOLS };
    const tools = (args: string[]) =>
      args.includes("--allowedTools") ? args[args.indexOf("--allowedTools") + 1] : null;
    expect(tools(buildArgs(opts, "m", ["Read(./**)", "Bash"], "/tmp/mcp.json"))).toBe(
      "Read(./**),mcp__rosterdock",
    );
    expect(tools(buildArgs(opts, "m", null, null))).toBe(DEFAULT_ALLOWED_TOOLS);
    expect(tools(buildArgs(opts, "m", ["WebFetch"], "/tmp/mcp.json"))).toBe("mcp__rosterdock");
    expect(tools(buildArgs(opts, "m", ["WebFetch"], null))).toBeNull();
  });

  it("tells the run log which of the department's tools the worker left out", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "rosterdock-cc-"));
    const stub = path.join(dir, "args.mjs");
    await writeFile(
      stub,
      `for await (const _ of process.stdin);
const a = process.argv.slice(2);
process.stderr.write("tools=" + a[a.indexOf("--allowedTools") + 1] + "\\n");
process.stderr.write("available=" + a[a.indexOf("--tools") + 1] + "\\n");`,
      "utf8",
    );
    const events: RunEventInput[] = [];
    try {
      await createClaudeCodeEngine({
        bin: process.execPath,
        allowedTools: DEFAULT_ALLOWED_TOOLS,
        prefixArgs: [stub],
      }).run({
        workdir: dir,
        pack: "x",
        model: "m",
        signal: new AbortController().signal,
        emit: (e) => events.push(e),
        onUsage: () => {},
        env: {},
        allowedTools: ["Write(./**)", "WebSearch", "WebFetch"],
        mcp: null,
      });
      const texts = events.filter((e) => e.type === "stderr").map((e) => String(e.payload?.text));
      expect(texts).toContain(
        "The department's sandbox names tools this worker does not allow, so the run goes without them: WebSearch, WebFetch",
      );
      expect(texts).toContain("tools=Write(./**)");
      expect(texts).toContain("available=Write");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves the Windows npm shim to cli.js run by this Node", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "rosterdock-shim-"));
    try {
      const js = path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
      await (await import("node:fs/promises")).mkdir(path.dirname(js), { recursive: true });
      await writeFile(js, "", "utf8");
      const resolved = resolveClaudeBin("claude", { PATH: dir }, "win32");
      expect(resolved).toEqual({ bin: process.execPath, prefix: [js] });
      expect(resolveClaudeBin("claude", { PATH: dir }, "linux")).toEqual({ bin: "claude", prefix: [] });
      expect(resolveClaudeBin("/opt/claude", { PATH: dir }, "win32")).toEqual({
        bin: "/opt/claude",
        prefix: [],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runs a stub binary the way it would run Claude Code: prompt on stdin, stream on stdout, files in the workdir", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "rosterdock-cc-"));
    const stub = path.join(dir, "claude-stub.mjs");
    await writeFile(
      stub,
      `
import { writeFile, readFile } from "node:fs/promises";
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const prompt = Buffer.concat(chunks).toString("utf8");
const args = process.argv.slice(2);
const must = ["-p", "--output-format", "stream-json", "--strict-mcp-config", "--no-session-persistence", "--tools", "--allowedTools", "--mcp-config", "--model", "claude-sonnet-5"];
const tools = args[args.indexOf("--allowedTools") + 1];
// No settings file is read, the cloned repository's included.
if (args[args.indexOf("--setting-sources") + 1] !== "") { process.stderr.write("stub: settings loaded"); process.exit(7); }
const cfg = await readFile(args[args.indexOf("--mcp-config") + 1], "utf8");
if (!tools.includes("mcp__rosterdock") || !cfg.includes("Bearer run-token") || !cfg.includes("http://board.test/api/mcp")) { process.stderr.write("stub: mcp not wired"); process.exit(8); }
if (must.some((a) => !args.includes(a)) || !prompt.includes("# Fixture task") || process.env.DISABLE_NON_ESSENTIAL_MODEL_CALLS !== "1" || process.env.LEAKED_SECRET) {
  process.stderr.write("stub: bad invocation\\n");
  process.exit(9);
}
await writeFile("vms-architecture.md", "# arch\\n", "utf8");
const lines = (await readFile(process.env.FIXTURE_PATH, "utf8")).split("\\n").filter(Boolean);
for (const l of lines) process.stdout.write(l + "\\n");
`,
      "utf8",
    );
    const events: RunEventInput[] = [];
    let usage = {};
    const engine = createClaudeCodeEngine({
      bin: process.execPath,
      allowedTools: "Write(./**)",
      prefixArgs: [stub],
    });
    const result = await engine.run({
      workdir: dir,
      pack: "# Fixture task\n\nWrite the file.",
      model: "claude-sonnet-5",
      signal: new AbortController().signal,
      emit: (e) => events.push(e),
      onUsage: (u) => (usage = u),
      env: {
        PATH: process.env.PATH ?? "",
        Path: process.env.Path ?? "",
        FIXTURE_PATH: path.join(fixtures, "claude-code-success.ndjson"),
      },
      allowedTools: null,
      mcp: { url: "http://board.test/api/mcp", token: "run-token" },
    });
    try {
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.usage.outputTokens).toBe(489);
      expect(usage).toEqual(result.usage);
      expect(events.map((e) => e.type)).toContain("tool");
      expect(await readFile(path.join(dir, "vms-architecture.md"), "utf8")).toBe("# arch\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails a run on a model Claude Code does not know, in Claude Code's own words", async () => {
    // Recorded: an error result whose subtype is "success" (claude-opus-5.5, a mistyped claude-opus-5-5).
    const dir = await mkdtemp(path.join(os.tmpdir(), "rosterdock-cc-"));
    const stub = path.join(dir, "claude-stub.mjs");
    await writeFile(
      stub,
      `import { readFile } from "node:fs/promises";
for await (const _ of process.stdin);
for (const l of (await readFile(process.env.FIXTURE_PATH, "utf8")).split("\\n").filter(Boolean)) process.stdout.write(l + "\\n");
process.exit(1);
`,
      "utf8",
    );
    const engine = createClaudeCodeEngine({
      bin: process.execPath,
      allowedTools: "Write(./**)",
      prefixArgs: [stub],
    });
    try {
      const result = await engine.run({
        workdir: dir,
        pack: "x",
        model: "claude-opus-5.5",
        signal: new AbortController().signal,
        emit: () => {},
        onUsage: () => {},
        env: { FIXTURE_PATH: path.join(fixtures, "claude-code-model-error.ndjson") },
        allowedTools: null,
        mcp: null,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toBe(
        "Claude Code: There's an issue with the selected model (claude-opus-5.5). It may not exist or you may not have access to it. Run --model to pick a different model.",
      );
      expect(result.usage.outputTokens).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports a non-zero exit as a failure and a stop as stopped", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "rosterdock-cc-"));
    const failing = path.join(dir, "fail.mjs");
    await writeFile(failing, 'process.stderr.write("boom\\n"); process.exit(3);', "utf8");
    const engine = createClaudeCodeEngine({
      bin: process.execPath,
      allowedTools: "Write(./**)",
      prefixArgs: [failing],
    });
    const events: RunEventInput[] = [];
    const result = await engine.run({
      workdir: dir,
      pack: "x",
      model: "m",
      signal: new AbortController().signal,
      emit: (e) => events.push(e),
      onUsage: () => {},
      env: {},
      allowedTools: null,
      mcp: null,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exited with code 3: boom/);
    expect(events.some((e) => e.type === "stderr")).toBe(true);

    const hanging = path.join(dir, "hang.mjs");
    await writeFile(hanging, "setInterval(() => {}, 1000);", "utf8");
    const ac = new AbortController();
    const slow = createClaudeCodeEngine({
      bin: process.execPath,
      allowedTools: "Write(./**)",
      prefixArgs: [hanging],
    });
    const p = slow.run({
      workdir: dir,
      pack: "x",
      model: "m",
      signal: ac.signal,
      emit: () => {},
      onUsage: () => {},
      env: {},
      allowedTools: null,
      mcp: null,
    });
    setTimeout(() => ac.abort(), 300);
    const stopped = await p;
    expect(stopped.ok).toBe(false);
    expect(stopped.error).toBe("stopped");
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps a stopped run's usage, reported as the recorded messages arrive", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "rosterdock-cc-"));
    const stub = path.join(dir, "replay-then-hang.mjs");
    await writeFile(
      stub,
      `import { readFile } from "node:fs/promises";
for await (const _ of process.stdin);
for (const l of (await readFile(process.env.FIXTURE_PATH, "utf8")).split("\\n").filter(Boolean))
  if (JSON.parse(l).type !== "result") process.stdout.write(l + "\\n");
setInterval(() => {}, 1000);
`,
      "utf8",
    );
    const ac = new AbortController();
    const reported: Record<string, unknown>[] = [];
    try {
      const result = await createClaudeCodeEngine({
        bin: process.execPath,
        allowedTools: "Write(./**)",
        prefixArgs: [stub],
      }).run({
        workdir: dir,
        pack: "x",
        model: "m",
        signal: ac.signal,
        emit: () => {},
        // Stopped once the second message is in, as the board's Stop or the time limit would.
        onUsage: (u) => {
          reported.push(u);
          if (u.cacheReadTokens) ac.abort();
        },
        env: { FIXTURE_PATH: path.join(fixtures, "claude-code-success.ndjson") },
        allowedTools: null,
        mcp: null,
      });
      expect(result.error).toBe("stopped");
      expect(result.usage).toEqual({
        inputTokens: 18,
        outputTokens: 4,
        cacheReadTokens: 37471,
        cacheWriteTokens: 38068,
      });
      expect(reported[0]).toEqual({
        inputTokens: 10,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 37471,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("says Claude Code is not installed when the worker has no binary, as the published image has none", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "rosterdock-cc-"));
    const bin = path.join(dir, "claude");
    try {
      const result = await createClaudeCodeEngine({ bin, allowedTools: "Write(./**)" }).run({
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
        `Claude Code is not installed on this worker (${bin} not found); docs/install.md says how to add it`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
