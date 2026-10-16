// Codex headless (`codex exec --json`). Ported from agent-board
// scripts/hermes-codex-worker.mjs and moved to the JSONL event stream so the
// board shows what the teammate is doing while it runs. The run pack is the
// entire prompt; nothing from the operator's own Codex setup leaks in
// (--ignore-user-config, --ephemeral, approvals off, the sandbox from the
// worker's config; a department's tool list does not apply). Codex's final
// message is written as the handover, so the board always has one. The board
// MCP server is passed as config, the run token by env var NAME (never on the
// command line).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { RunEventInput, RunUsage } from "@rosterdock/shared";
import { HEADER, startFailure } from "./claude-code.js";
import type { EngineAdapter, EngineContext, EngineResult } from "./types.js";
import { clip, tail } from "../text.js";

export interface CodexOptions {
  bin: string;
  /** Codex sandbox mode for model-generated commands: workspace-write (default), read-only, danger-full-access. */
  sandbox: string;
  /** Extra leading argv (tests use it to load a stub script with the same Node). */
  prefixArgs?: string[];
}

export const RUN_TOKEN_ENV = "ROSTERDOCK_RUN_TOKEN";
export const HANDOVER_FILE = "handover-summary.md";

// Windows npm exposes codex only as a .cmd shim, which spawn(shell:false)
// cannot execute. Resolve the shim's codex.js from PATH and run it with this Node.
export function resolveCodexBin(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): { bin: string; prefix: string[] } {
  if (bin !== "codex" || platform !== "win32") return { bin, prefix: [] };
  const pathValue = env.Path || env.PATH || "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const js = path.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSync(js)) return { bin: process.execPath, prefix: [js] };
  }
  return { bin, prefix: [] };
}

export function buildArgs(
  opts: CodexOptions,
  model: string,
  mcp: { url: string } | null,
  workdir: string,
  effort?: string | null,
): string[] {
  return [
    ...(opts.prefixArgs ?? []),
    "exec",
    "--json",
    "--sandbox",
    opts.sandbox,
    "-c",
    'approval_policy="never"',
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--color",
    "never",
    ...(mcp
      ? [
          "-c",
          `mcp_servers.rosterdock.url=${JSON.stringify(mcp.url)}`,
          "-c",
          `mcp_servers.rosterdock.bearer_token_env_var=${JSON.stringify(RUN_TOKEN_ENV)}`,
        ]
      : []),
    "--model",
    model,
    ...(effort ? ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
    "--output-last-message",
    path.join(workdir, HANDOVER_FILE),
    "-",
  ];
}

export interface ParsedCodexStream {
  events: RunEventInput[];
  usage: Partial<RunUsage>;
  /** The last agent message. */
  resultText: string | null;
  isError: boolean;
  /** The failure Codex reported, when it did. */
  errorMessage: string | null;
  /** Item ids already announced from an item.started, so item.completed does not repeat them. */
  started: Set<string>;
}

export function emptyCodexStream(): ParsedCodexStream {
  return { events: [], usage: {}, resultText: null, isError: false, errorMessage: null, started: new Set() };
}

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  exit_code?: number | null;
  status?: string;
  message?: string;
  changes?: { path?: string; kind?: string }[];
  server?: string;
  tool?: string;
  query?: string;
}

interface CodexMessage {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: Record<string, number>;
  error?: { message?: string };
  message?: string;
}

/** At most n characters and the ellipsis. */
const clipped = (s: string, n: number) => clip(s, n + 1, "…");

/** The error message Codex wraps: often a JSON envelope from the API; the human line inside is what to show. */
export function errorText(raw: string | undefined): string {
  if (!raw) return "an error";
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string }; message?: string };
    const inner = parsed.error?.message ?? parsed.message;
    if (typeof inner === "string" && inner.trim()) return inner.trim();
  } catch {
    // plain text
  }
  return raw.trim();
}

/** One event of the item, as the board shows it, or null for kinds that stay in the sandbox (reasoning, todo lists). */
function itemEvent(item: CodexItem, phase: "started" | "completed"): RunEventInput | null {
  switch (item.type) {
    case "agent_message":
      return phase === "completed" && item.text?.trim()
        ? { type: "assistant", payload: { text: clipped(item.text.trim(), 2000) } }
        : null;
    case "command_execution":
      return { type: "tool", payload: { name: "shell", input: clipped(item.command ?? "", 200) } };
    case "file_change":
      return {
        type: "tool",
        payload: {
          name: "apply_patch",
          input: clipped(
            (item.changes ?? []).map((c) => `${c.kind ?? "edit"} ${c.path ?? ""}`).join(", "),
            200,
          ),
        },
      };
    case "mcp_tool_call":
      return { type: "tool", payload: { name: `${item.server ?? "mcp"}.${item.tool ?? "tool"}`, input: "" } };
    case "web_search":
      return { type: "tool", payload: { name: "web_search", input: clipped(item.query ?? "", 200) } };
    case "error":
      return phase === "completed"
        ? { type: "stderr", payload: { text: clipped(item.message ?? "error", 500) } }
        : null;
    default:
      return null;
  }
}

/** One JSONL line to zero or more run events. Exported for fixture tests. */
export function parseCodexLine(line: string, acc: ParsedCodexStream): void {
  let msg: CodexMessage;
  try {
    msg = JSON.parse(line) as CodexMessage;
  } catch {
    acc.events.push({ type: "stdout", payload: { text: clip(line, 500) } });
    return;
  }
  switch (msg.type) {
    case "thread.started":
      acc.events.push({ type: "engine", payload: { text: "Codex session started", model: null, tools: 0 } });
      return;
    case "item.started": {
      const item = msg.item ?? {};
      const ev = itemEvent(item, "started");
      if (ev) {
        if (item.id) acc.started.add(item.id);
        acc.events.push(ev);
      }
      return;
    }
    case "item.completed": {
      const item = msg.item ?? {};
      if (item.type === "agent_message" && item.text?.trim()) acc.resultText = item.text.trim();
      if (item.id && acc.started.has(item.id)) return;
      const ev = itemEvent(item, "completed");
      if (ev) acc.events.push(ev);
      return;
    }
    case "turn.completed": {
      const u = msg.usage ?? {};
      const cached = u.cached_input_tokens ?? 0;
      // Codex counts cached input inside input_tokens; the board prices them apart.
      acc.usage = {
        inputTokens: Math.max(0, (u.input_tokens ?? 0) - cached),
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
      };
      acc.events.push({ type: "result", payload: { subtype: "success", isError: false } });
      return;
    }
    case "turn.failed":
      acc.isError = true;
      acc.errorMessage = errorText(msg.error?.message);
      acc.events.push({ type: "result", payload: { subtype: "error", isError: true } });
      return;
    case "error":
      acc.isError = true;
      acc.errorMessage = errorText(msg.message);
      acc.events.push({ type: "stderr", payload: { text: clipped(acc.errorMessage, 500) } });
      return;
    default:
      return;
  }
}

export function parseCodexStream(text: string): ParsedCodexStream {
  const acc = emptyCodexStream();
  for (const line of text.split("\n")) if (line.trim()) parseCodexLine(line, acc);
  return acc;
}

export function createCodexEngine(opts: CodexOptions): EngineAdapter {
  return {
    id: "codex",
    async run(ctx: EngineContext): Promise<EngineResult> {
      const resolved = resolveCodexBin(opts.bin);
      const args = [...resolved.prefix, ...buildArgs(opts, ctx.model, ctx.mcp, ctx.workdir, ctx.effort)];
      const acc = emptyCodexStream();
      // Codex has no per-tool allowlist to narrow; its sandbox mode is the worker's.
      if (ctx.allowedTools?.length)
        ctx.emit({
          type: "stderr",
          payload: {
            text: `The department's tool list applies to Claude Code teammates; Codex runs in this worker's ${opts.sandbox} sandbox.`,
          },
        });
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(resolved.bin, args, {
          cwd: ctx.workdir,
          // The run token reaches Codex by name for the board MCP server; it is never an argument.
          env: { ...ctx.env, ...(ctx.mcp ? { [RUN_TOKEN_ENV]: ctx.mcp.token } : {}) },
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (err) {
        return {
          ok: false,
          exitCode: null,
          usage: {},
          resultText: null,
          error: startFailure("Codex", opts.bin, err as NodeJS.ErrnoException),
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
      const flushLine = (line: string) => {
        const before = acc.events.length;
        parseCodexLine(line, acc);
        for (const ev of acc.events.slice(before)) ctx.emit(ev);
        if (acc.events[acc.events.length - 1]?.type === "result" && !acc.isError) ctx.onUsage(acc.usage);
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString("utf8");
        let nl = stdoutBuf.indexOf("\n");
        while (nl >= 0) {
          const line = stdoutBuf.slice(0, nl);
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (line.trim()) flushLine(line);
          nl = stdoutBuf.indexOf("\n");
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderrTail = tail(stderrTail + text, 4000);
        for (const line of text.split("\n"))
          if (line.trim()) ctx.emit({ type: "stderr", payload: { text: clip(line, 500) } });
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
      if (stdoutBuf.trim()) flushLine(stdoutBuf);
      if (exit.error)
        return {
          ok: false,
          exitCode: null,
          usage: acc.usage,
          resultText: null,
          error: startFailure("Codex", opts.bin, exit.error),
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
            ? `Codex was killed by ${exit.signal}`
            : acc.isError
              ? `Codex reported an error: ${clipped(acc.errorMessage ?? "unknown", 300)}`
              : `Codex exited with code ${exit.code}${stderrTail ? `: ${stderrTail.trim().split("\n").at(-1)}` : ""}`,
      };
    },
  };
}
