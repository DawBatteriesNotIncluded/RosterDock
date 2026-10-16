// Claude Code headless. Ported from agent-board scripts/claude-code-worker.mjs
// and moved to stream-json so the board shows what the teammate is doing
// while it runs. The run pack is the entire prompt; nothing from the
// operator's global Claude setup leaks in (--strict-mcp-config with no
// servers, project-only settings, no session persistence).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunEventInput, RunUsage } from "@rosterdock/shared";
import type { EngineAdapter, EngineContext, EngineResult } from "./types.js";

export const HEADER =
  "You are executing one governed run inside a disposable sandbox: the CURRENT WORKING DIRECTORY. The run pack below is your full contract. Create every expected output named in the pack as a file in the current working directory (exact flat filenames, no subdirectories). Do not read or write anything outside this directory. Do not attempt network writes or production changes. Stop when the outputs and the handover are written.";

export const DEFAULT_ALLOWED_TOOLS = "Read(./**),Write(./**),Edit(./**),Glob(./**),Grep(./**)";

export interface ClaudeCodeOptions {
  bin: string;
  allowedTools: string;
  permissionMode?: string;
  /** Extra leading argv (tests use it to load a stub script with the same Node). */
  prefixArgs?: string[];
}

// Windows npm exposes claude only as a .cmd shim, which spawn(shell:false)
// cannot execute. Resolve the shim's cli.js from PATH and run it with this Node.
export function resolveClaudeBin(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): { bin: string; prefix: string[] } {
  if (bin !== "claude" || platform !== "win32") return { bin, prefix: [] };
  const pathValue = env.Path || env.PATH || "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const js = path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    if (existsSync(js)) return { bin: process.execPath, prefix: [js] };
  }
  return { bin, prefix: [] };
}

/** Why an engine did not start, in the run's words. No binary is a worker image without that CLI: the
 * published image leaves Claude Code out. */
export function startFailure(engine: string, bin: string, err: NodeJS.ErrnoException): string {
  return err.code === "ENOENT"
    ? `${engine} is not installed on this worker (${bin} not found); docs/install.md says how to add it`
    : `failed to start ${engine}: ${err.message}`;
}

/** The board MCP server as Claude Code expects it in --mcp-config. */
export function mcpConfig(mcp: { url: string; token: string }): string {
  return JSON.stringify({
    mcpServers: {
      rosterdock: { type: "http", url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } },
    },
  });
}

export const MCP_TOOL_PATTERN = "mcp__rosterdock";

/** A tool list as Claude Code takes it: comma or space separated, never inside a rule's parentheses. */
export function splitToolList(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === "," || /\s/.test(ch))) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const toolName = (rule: string) => rule.replace(/\(.*$/s, "");

/**
 * The department's tool list narrows the worker's, never widens it. A rule the worker holds as written
 * stays; `Name(spec)` stays where the worker allows all of `Name`; a bare `Name` keeps the worker's own
 * rules for that tool. Anything else is dropped. Null: the worker's list as it is.
 */
export function narrowTools(
  workerList: string,
  department: string[] | null | undefined,
): { tools: string[]; dropped: string[] } {
  const allowed = splitToolList(workerList || DEFAULT_ALLOWED_TOOLS);
  if (!department?.length) return { tools: allowed, dropped: [] };
  const tools: string[] = [];
  const dropped: string[] = [];
  for (const rule of department.flatMap(splitToolList)) {
    // The board's own tools are always there; the board's broker governs them, not this list.
    if (toolName(rule).startsWith(MCP_TOOL_PATTERN)) continue;
    const name = toolName(rule);
    const kept =
      rule === name
        ? allowed.filter((a) => toolName(a) === name)
        : allowed.includes(rule) || allowed.includes(name)
          ? [rule]
          : [];
    if (kept.length) tools.push(...kept);
    else dropped.push(rule);
  }
  return { tools: [...new Set(tools)], dropped };
}

export function buildArgs(
  opts: ClaudeCodeOptions,
  model: string,
  allowedTools?: string[] | null,
  mcpConfigPath?: string | null,
  effort?: string | null,
): string[] {
  const { tools } = narrowTools(opts.allowedTools, allowedTools);
  if (mcpConfigPath && !tools.includes(MCP_TOOL_PATTERN)) tools.push(MCP_TOOL_PATTERN);
  return [
    ...(opts.prefixArgs ?? []),
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--strict-mcp-config",
    "--setting-sources",
    "project",
    "--no-session-persistence",
    "--permission-mode",
    opts.permissionMode ?? "acceptEdits",
    // Nothing left after the department narrowed it: no tool is allowed up front.
    ...(tools.length ? ["--allowedTools", tools.join(",")] : []),
    ...(mcpConfigPath ? ["--mcp-config", mcpConfigPath] : []),
    "--model",
    model,
    ...(effort ? ["--effort", effort] : []),
  ];
}

export interface ParsedStream {
  events: RunEventInput[];
  usage: Partial<RunUsage>;
  resultText: string | null;
  isError: boolean;
  subtype: string | null;
  durationMs: number | null;
}

function summariseInput(name: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>;
  const pick = obj.file_path ?? obj.path ?? obj.command ?? obj.pattern ?? obj.query ?? obj.url;
  if (typeof pick === "string") return pick.slice(0, 200);
  const text = JSON.stringify(obj);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** One stream-json line to zero or more run events. Exported for fixture tests. */
interface StreamMessage {
  type?: string;
  subtype?: string;
  model?: string;
  tools?: unknown[];
  message?: { content?: { type: string; text?: string; name?: string; input?: unknown }[] };
  usage?: Record<string, number>;
  result?: unknown;
  is_error?: boolean;
  duration_ms?: number;
  num_turns?: number;
}

export function parseStreamLine(line: string, acc: ParsedStream): void {
  let msg: StreamMessage;
  try {
    msg = JSON.parse(line) as StreamMessage;
  } catch {
    acc.events.push({ type: "stdout", payload: { text: line.slice(0, 500) } });
    return;
  }
  switch (msg.type) {
    case "system":
      if (msg.subtype === "init") {
        acc.events.push({
          type: "engine",
          payload: {
            text: "Claude Code session started",
            model: msg.model ?? null,
            tools: (msg.tools ?? []).length,
          },
        });
      }
      return;
    case "assistant": {
      const content = msg.message?.content ?? [];
      for (const block of content) {
        if (block.type === "text" && block.text?.trim()) {
          acc.events.push({ type: "assistant", payload: { text: block.text.trim().slice(0, 2000) } });
        } else if (block.type === "tool_use") {
          acc.events.push({
            type: "tool",
            payload: { name: block.name ?? "tool", input: summariseInput(block.name ?? "", block.input) },
          });
        }
      }
      return;
    }
    case "user":
      // tool results: recorded as a step only, content stays in the sandbox.
      return;
    case "result": {
      const u = (msg.usage ?? {}) as Record<string, number>;
      acc.usage = {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      };
      acc.resultText = typeof msg.result === "string" && msg.result.trim() ? msg.result.trim() : null;
      acc.isError = Boolean(msg.is_error);
      acc.subtype = typeof msg.subtype === "string" ? msg.subtype : null;
      acc.durationMs = typeof msg.duration_ms === "number" ? msg.duration_ms : null;
      acc.events.push({
        type: "result",
        payload: {
          subtype: acc.subtype,
          isError: acc.isError,
          durationMs: acc.durationMs,
          numTurns: msg.num_turns ?? null,
        },
      });
      return;
    }
    default:
      return;
  }
}

export function parseStream(text: string): ParsedStream {
  const acc: ParsedStream = {
    events: [],
    usage: {},
    resultText: null,
    isError: false,
    subtype: null,
    durationMs: null,
  };
  for (const line of text.split("\n")) {
    if (line.trim()) parseStreamLine(line, acc);
  }
  return acc;
}

export function createClaudeCodeEngine(opts: ClaudeCodeOptions): EngineAdapter {
  return {
    id: "claude_code",
    async run(ctx: EngineContext): Promise<EngineResult> {
      const resolved = resolveClaudeBin(opts.bin);
      // The MCP config (with the run token) lives outside the workdir so it is never harvested.
      let mcpDir: string | null = null;
      let mcpPath: string | null = null;
      if (ctx.mcp) {
        mcpDir = await mkdtemp(path.join(os.tmpdir(), "rosterdock-mcp-"));
        mcpPath = path.join(mcpDir, "mcp.json");
        await writeFile(mcpPath, mcpConfig(ctx.mcp), { encoding: "utf8", mode: 0o600 });
      }
      const cleanupMcp = () =>
        mcpDir ? rm(mcpDir, { recursive: true, force: true }).catch(() => {}) : Promise.resolve();
      const args = [...resolved.prefix, ...buildArgs(opts, ctx.model, ctx.allowedTools, mcpPath, ctx.effort)];
      const { dropped } = narrowTools(opts.allowedTools, ctx.allowedTools);
      if (dropped.length)
        ctx.emit({
          type: "stderr",
          payload: {
            text: `The department's sandbox names tools this worker does not allow, so the run goes without them: ${dropped.join(", ")}`.slice(
              0,
              500,
            ),
          },
        });
      const acc: ParsedStream = {
        events: [],
        usage: {},
        resultText: null,
        isError: false,
        subtype: null,
        durationMs: null,
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(resolved.bin, args, {
          cwd: ctx.workdir,
          env: { ...ctx.env, DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1" },
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (err) {
        await cleanupMcp();
        return {
          ok: false,
          exitCode: null,
          usage: {},
          resultText: null,
          error: startFailure("Claude Code", opts.bin, err as NodeJS.ErrnoException),
        };
      }
      const onAbort = () => {
        try {
          child.kill();
          setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              // gone
            }
          }, 2000).unref();
        } catch {
          // gone
        }
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      let stdoutBuf = "";
      let stderrTail = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString("utf8");
        let nl = stdoutBuf.indexOf("\n");
        while (nl >= 0) {
          const line = stdoutBuf.slice(0, nl);
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (line.trim()) {
            const before = acc.events.length;
            parseStreamLine(line, acc);
            for (const ev of acc.events.slice(before)) ctx.emit(ev);
            if (acc.events[acc.events.length - 1]?.type === "result") ctx.onUsage(acc.usage);
          }
          nl = stdoutBuf.indexOf("\n");
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderrTail = (stderrTail + text).slice(-4000);
        for (const line of text.split("\n"))
          if (line.trim()) ctx.emit({ type: "stderr", payload: { text: line.slice(0, 500) } });
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(`${HEADER}\n\n${ctx.pack}`, "utf8");
      const exit = await new Promise<{
        code: number | null;
        signal: string | null;
        error?: NodeJS.ErrnoException;
      }>((resolve) => {
        let settled = false;
        child.once("error", (err) => {
          if (settled) return;
          settled = true;
          resolve({ code: null, signal: null, error: err });
        });
        child.once("close", (code, sig) => {
          if (settled) return;
          settled = true;
          resolve({ code, signal: sig });
        });
      });
      ctx.signal.removeEventListener("abort", onAbort);
      await cleanupMcp();
      if (stdoutBuf.trim()) {
        const before = acc.events.length;
        parseStreamLine(stdoutBuf, acc);
        for (const ev of acc.events.slice(before)) ctx.emit(ev);
      }
      if (exit.error)
        return {
          ok: false,
          exitCode: null,
          usage: acc.usage,
          resultText: null,
          error: startFailure("Claude Code", opts.bin, exit.error),
        };
      if (ctx.signal.aborted)
        return {
          ok: false,
          exitCode: exit.code,
          usage: acc.usage,
          resultText: acc.resultText,
          error: "stopped",
        };
      const ok = exit.code === 0 && !acc.isError;
      return {
        ok,
        exitCode: exit.code,
        usage: acc.usage,
        resultText: acc.resultText,
        error: ok
          ? undefined
          : exit.signal
            ? `Claude Code was killed by ${exit.signal}`
            : acc.isError
              ? // Its own words: an error result's subtype can still be "success" (an unknown model).
                acc.resultText
                ? `Claude Code: ${acc.resultText.split("\n")[0]!.slice(0, 300)}`
                : `Claude Code reported ${acc.subtype ?? "an error"}`
              : `Claude Code exited with code ${exit.code}${stderrTail ? `: ${stderrTail.trim().split("\n").at(-1)}` : ""}`,
      };
    },
  };
}
