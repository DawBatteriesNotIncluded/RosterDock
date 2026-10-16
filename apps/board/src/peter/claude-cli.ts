// Peter's model calls through the Claude Code CLI on the board's own machine,
// for a board run locally without an API key: one `claude -p` per decision,
// with the structured output's JSON Schema (the same one the API call sends),
// the system prompt and no tools, and the user prompt on stdin. The CLI's own
// sign-in (`claude auth login`) pays for the call. It runs in an empty
// directory, so no project settings or CLAUDE.md reach Peter. Tests replay
// recorded CLI output through a fake binary; nothing here calls the network.

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

export { cliEnv } from "./cli.js";

export interface ClaudeCliModelOptions {
  /** The Claude Code binary (ROSTERDOCK_PETER_CLAUDE_BIN). */
  bin: string;
  /** Arguments before the CLI's own: tests run a recorded replayer through node here. */
  prefixArgs?: string[];
  /** Where the child's environment comes from. Default: the board's, narrowed by `cliEnv`. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** The CLI's arguments for one structured call. Exported for the recorder and the tests. */
export function claudeCliArgs(
  req: Pick<ModelRequest<z.ZodType>, "model" | "system" | "schema" | "effort">,
): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(zodOutputFormat(req.schema).schema),
    "--model",
    req.model,
    ...(req.effort ? ["--effort", req.effort] : []),
    "--system-prompt",
    req.system,
    "--tools",
    "",
    "--strict-mcp-config",
    "--setting-sources",
    "project",
    "--no-session-persistence",
    "--disable-slash-commands",
  ];
}

interface CliResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  stop_reason?: string | null;
  structured_output?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  modelUsage?: Record<string, { outputTokens?: number }>;
}

/**
 * One CLI answer (the JSON result on stdout) to a model result. An error
 * result (not signed in, an unknown model, a failed API call) throws with the
 * CLI's message, so the caller falls back and says why; a refusal, or an
 * output the schema does not accept, is no output, the latter with what the
 * schema said (the CLI's JSON Schema carries no lengths, so a title a few
 * characters over is the model's to fix on a second try).
 */
export function parseCliResult<T extends z.ZodType>(
  stdout: string,
  req: Pick<ModelRequest<T>, "model" | "schema">,
): ModelResult<z.infer<T>> {
  // One JSON line; anything the CLI printed before it (a warning) is not the result.
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .pop();
  if (!line) throw new Error("the Claude CLI printed no result");
  let result: CliResult;
  try {
    result = JSON.parse(line) as CliResult;
  } catch {
    throw new Error("the Claude CLI printed a result that is not JSON");
  }
  if (result.is_error)
    throw new Error(`the Claude CLI: ${(result.result ?? result.subtype ?? "error").slice(0, 300)}`);
  const u = result.usage ?? {};
  const usage: ModelUsage = {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
  const models = Object.entries(result.modelUsage ?? {});
  const answered = models.some(([m]) => m === req.model)
    ? req.model
    : (models.sort((a, b) => (b[1].outputTokens ?? 0) - (a[1].outputTokens ?? 0))[0]?.[0] ?? req.model);
  if (result.stop_reason === "refusal") return { output: null, usage, model: answered };
  const parsed = req.schema.safeParse(result.structured_output);
  if (!parsed.success)
    return { output: null, problems: schemaProblems(parsed.error), usage, model: answered };
  return { output: parsed.data as z.infer<T>, usage, model: answered };
}

export function claudeCliModel(opts: ClaudeCliModelOptions): PeterModel {
  return {
    available: true,
    async complete(req) {
      // A failed call still prints its JSON result, which says why.
      const { stdout } = await runCli({
        bin: opts.bin,
        ...(opts.prefixArgs ? { prefixArgs: opts.prefixArgs } : {}),
        args: claudeCliArgs(req),
        stdin: req.user,
        env: opts.env ?? process.env,
        timeoutMs: opts.timeoutMs ?? 300_000,
        name: "the Claude CLI",
      });
      return parseCliResult(stdout, req);
    },
  };
}
