// A model-free engine for tests and demos. Writes the declared outputs and a
// handover. Behaviour is steered by a marker in the pack:
//   [stub:fail]  exit non-zero
//   [stub:block] write blocked.md instead of finishing
//   [stub:hang]  wait until stopped (for stop and reaper tests)
//   [stub:tool <connection> <tool> {json}]  call board_tool_call through the run's
//     board MCP server: a read runs and its answer lands in the handover; a write is
//     proposed for approval, as any engine's would be. Demos the gate without a model.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { EngineAdapter, EngineContext, EngineResult } from "./types.js";

const HANDOVER = "handover-summary.md";
const BLOCKED = "blocked.md";
const TOOL_MARKER = /\[stub:tool\s+([a-z0-9-]+)\s+([A-Za-z0-9_.:-]+)\s*(\{[\s\S]*?\})?\s*\]/;

export function declaredOutputsFromPack(pack: string): string[] {
  const section = pack.split("## Expected outputs")[1]?.split("\n## ")[0] ?? "";
  return [...section.matchAll(/^- (.+)$/gm)].map((m) => m[1]!.trim());
}

/** The [stub:tool ...] marker, parsed: which connection and tool, with which arguments. */
export function toolMarkerFromPack(
  pack: string,
): { connection: string; tool: string; arguments: Record<string, unknown> } | null {
  const m = TOOL_MARKER.exec(pack);
  if (!m) return null;
  let args: Record<string, unknown> = {};
  if (m[3]) {
    try {
      const parsed = JSON.parse(m[3]) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        args = parsed as Record<string, unknown>;
    } catch {
      // A marker with broken JSON calls with no arguments; the board says what is missing.
    }
  }
  return { connection: m[1]!, tool: m[2]!, arguments: args };
}

interface RpcResult {
  isError: boolean;
  text: string;
}

function parseRpcBody(text: string): {
  result?: { content?: { type: string; text?: string }[]; isError?: boolean };
  error?: { message?: string };
} {
  const trimmed = text.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
    const last = trimmed
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean)
      .at(-1);
    return last ? JSON.parse(last) : {};
  }
  return JSON.parse(trimmed);
}

/**
 * One tool call on the run's board MCP server over plain JSON-RPC: initialize,
 * then tools/call. The run token is the bearer; nothing else is needed.
 */
export async function callBoardTool(
  mcp: { url: string; token: string },
  name: string,
  args: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<RpcResult> {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${mcp.token}`,
  };
  const post = async (body: Record<string, unknown>) => {
    const res = await fetchImpl(mcp.url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`the board MCP server answered HTTP ${res.status}`);
    return parseRpcBody(await res.text());
  };
  await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "rosterdock-stub", version: "0" },
    },
  });
  const reply = await post({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name, arguments: args },
  });
  if (reply.error) return { isError: true, text: reply.error.message ?? "the board refused the call" };
  const text = (reply.result?.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
  return { isError: !!reply.result?.isError, text };
}

export const stubEngine: EngineAdapter = {
  id: "stub",
  async run(ctx: EngineContext): Promise<EngineResult> {
    const marker = /\[stub:(fail|block|hang)\]/.exec(ctx.pack)?.[1];
    ctx.emit({ type: "engine", payload: { text: "stub engine started", model: ctx.model } });
    if (marker === "hang") {
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) return resolve();
        ctx.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { ok: false, exitCode: null, usage: { inputTokens: 10 }, resultText: null, error: "stopped" };
    }
    const outputs = declaredOutputsFromPack(ctx.pack);
    // A research pack asks for documents with sources; the stub obliges.
    const research = ctx.pack.includes("\n## Research\n");
    for (const name of outputs) {
      ctx.emit({ type: "tool", payload: { name: "Write", input: name } });
      const body = `# ${name}\n\nWritten by the stub engine.\n${research ? "\n## Sources\n- https://example.invalid/stub-source\n" : ""}`;
      await writeFile(path.join(ctx.workdir, name), body, "utf8");
    }
    // A tool marker: one governed call through the board, like any engine would make.
    let toolLine = "";
    const tool = toolMarkerFromPack(ctx.pack);
    if (tool && ctx.mcp) {
      ctx.emit({
        type: "tool",
        payload: { name: "board_tool_call", input: { connection: tool.connection, tool: tool.tool } },
      });
      try {
        const outcome = await callBoardTool(ctx.mcp, "board_tool_call", {
          ...tool,
          title: `Stub write: ${tool.tool} on ${tool.connection}`,
          why: "The stub engine proposed this from a [stub:tool] marker in the brief; a demo of the gate.",
        });
        ctx.emit({
          type: "tool_result",
          payload: { name: "board_tool_call", isError: outcome.isError, text: outcome.text.slice(0, 2000) },
        });
        toolLine = outcome.isError
          ? `The board refused ${tool.connection} · ${tool.tool}: ${outcome.text.slice(0, 300)}`
          : outcome.text.includes('"proposed"')
            ? `Proposed ${tool.connection} · ${tool.tool} for approval; waiting on a person.`
            : `Called ${tool.connection} · ${tool.tool}; answer: ${outcome.text.slice(0, 300)}`;
      } catch (err) {
        toolLine = `Could not reach the board for ${tool.connection} · ${tool.tool}: ${(err as Error).message}`;
        ctx.emit({ type: "stderr", payload: { text: toolLine } });
      }
    }
    ctx.onUsage({ inputTokens: 1200, outputTokens: 300 });
    if (marker === "fail") {
      ctx.emit({ type: "stderr", payload: { text: "stub: simulated failure" } });
      return {
        ok: false,
        exitCode: 1,
        usage: { inputTokens: 1200, outputTokens: 300 },
        resultText: null,
        error: "stub engine exited with code 1",
      };
    }
    if (marker === "block") {
      await writeFile(
        path.join(ctx.workdir, BLOCKED),
        "Waiting on @brody for the comparison criteria.\n",
        "utf8",
      );
      return {
        ok: true,
        exitCode: 0,
        usage: { inputTokens: 1200, outputTokens: 300 },
        resultText: "blocked",
      };
    }
    const summary = `Wrote ${outputs.length ? outputs.join(", ") : "nothing declared"}. ${toolLine ? `${toolLine} ` : ""}Stub run, no model was called.`;
    await writeFile(path.join(ctx.workdir, HANDOVER), `${summary}\n`, "utf8");
    ctx.emit({ type: "assistant", payload: { text: summary } });
    return { ok: true, exitCode: 0, usage: { inputTokens: 1200, outputTokens: 300 }, resultText: summary };
  },
};
