// Peter's model calls through the Codex CLI on the board's own machine: one
// `codex exec --json` per decision, with the request's JSON Schema as the
// final answer's shape, a read-only sandbox, no approvals, nothing kept and
// the user's config left out; the system and user prompts on stdin, since
// Codex takes one prompt. The CLI's own sign-in (`codex login`) pays for the
// call. The last agent message is the answer and the turn's usage is the
// call's. Tests replay recorded JSONL through a fake binary.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { runCli } from "./cli.js";
import {
  schemaProblems,
  type ModelRequest,
  type ModelResult,
  type ModelUsage,
  type PeterModel,
} from "./model.js";

export interface CodexCliModelOptions {
  /** The Codex binary (ROSTERDOCK_PETER_CODEX_BIN). */
  bin: string;
  /** Arguments before the CLI's own: tests run a recorded replayer through node here. */
  prefixArgs?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export const SCHEMA_FILE = "answer-schema.json";

/** A model name Codex can take: a Claude name on the manager's row means Codex's own default. */
export function codexModel(model: string): string | null {
  return model && !/^claude/i.test(model) ? model : null;
}

/** The CLI's arguments for one structured call; the schema file sits in the call's directory. */
export function codexCliArgs(req: Pick<ModelRequest<z.ZodType>, "model" | "effort">): string[] {
  const model = codexModel(req.model);
  return [
    "exec",
    "--json",
    "--output-schema",
    SCHEMA_FILE,
    "--sandbox",
    "read-only",
    "-c",
    'approval_policy="never"',
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--color",
    "never",
    ...(model ? ["--model", model] : []),
    ...(req.effort ? ["-c", `model_reasoning_effort=${JSON.stringify(req.effort)}`] : []),
    "-",
  ];
}

export function codexPrompt(req: Pick<ModelRequest<z.ZodType>, "system" | "user">): string {
  return `${req.system}\n\n---\n\n${req.user}\n\nAnswer with the JSON object only.`;
}

interface CodexEvent {
  type?: string;
  item?: { type?: string; text?: string };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    cache_write_input_tokens?: number;
    output_tokens?: number;
  };
  error?: { message?: string };
  message?: string;
}

/** The message inside Codex's error envelope, when it wraps the API's JSON. */
function innerMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string }; message?: string };
    return parsed.error?.message ?? parsed.message ?? raw;
  } catch {
    return raw;
  }
}

/**
 * One Codex answer (JSONL on stdout) to a model result. A failed turn throws
 * with the API's message, so the caller falls back and says why; an answer the
 * schema does not accept is no output.
 */
export function parseCodexResult<T extends z.ZodType>(
  stdout: string,
  req: Pick<ModelRequest<T>, "model" | "schema">,
): ModelResult<z.infer<T>> {
  let answer: string | null = null;
  let usage: ModelUsage | null = null;
  let failed: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    let ev: CodexEvent;
    try {
      ev = JSON.parse(line) as CodexEvent;
    } catch {
      continue;
    }
    if (ev.type === "item.completed" && ev.item?.type === "agent_message" && ev.item.text)
      answer = ev.item.text;
    if (ev.type === "turn.completed" && ev.usage) {
      const cached = ev.usage.cached_input_tokens ?? 0;
      usage = {
        inputTokens: Math.max(0, (ev.usage.input_tokens ?? 0) - cached),
        outputTokens: ev.usage.output_tokens ?? 0,
        cacheReadTokens: cached,
        cacheWriteTokens: ev.usage.cache_write_input_tokens ?? 0,
      };
    }
    if (ev.type === "turn.failed") failed = innerMessage(ev.error?.message ?? "the turn failed");
  }
  if (failed) throw new Error(`the Codex CLI: ${failed.slice(0, 300)}`);
  if (answer === null) throw new Error("the Codex CLI printed no answer");
  const model = codexModel(req.model) ?? "codex";
  const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let json: unknown;
  try {
    json = JSON.parse(answer);
  } catch {
    return { output: null, usage: usage ?? zero, model };
  }
  const parsed = req.schema.safeParse(json);
  if (!parsed.success)
    return { output: null, problems: schemaProblems(parsed.error), usage: usage ?? zero, model };
  return { output: parsed.data as z.infer<T>, usage: usage ?? zero, model };
}

export function codexCliModel(opts: CodexCliModelOptions): PeterModel {
  return {
    available: true,
    async complete(req) {
      const { stdout } = await runCli({
        bin: opts.bin,
        ...(opts.prefixArgs ? { prefixArgs: opts.prefixArgs } : {}),
        args: codexCliArgs(req),
        stdin: codexPrompt(req),
        env: opts.env ?? process.env,
        timeoutMs: opts.timeoutMs ?? 300_000,
        name: "the Codex CLI",
        prepare: (dir) =>
          writeFile(path.join(dir, SCHEMA_FILE), JSON.stringify(zodOutputFormat(req.schema).schema), "utf8"),
      });
      return parseCodexResult(stdout, req);
    },
  };
}
