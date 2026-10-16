// Peter's model calls. One structured call per decision (a plan, a re-plan
// note, an org proposal) through the Anthropic SDK with an injected fetch, so
// tests replay recorded responses and never reach the network. Without a key
// there is no model and every caller falls back to its heuristic.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { standaloneSpan, type SpanSink } from "../observability/spans.js";

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ModelRequest<T extends z.ZodType> {
  model: string;
  /** The manager's effort: low, medium, high, xhigh, max; absent or null, the model's default. */
  effort?: string | null;
  system: string;
  user: string;
  schema: T;
  maxTokens?: number;
  /** What the call is for, so its trace says so: plan, replan, org; and whose. */
  trace?: { purpose: string; companyId: string; goalId?: string | null; taskId?: string | null };
}

export interface ModelResult<T> {
  /** Null when the model refused or returned nothing parseable; callers fall back. */
  output: T | null;
  /** Why an answer that came back did not fit the schema asked for, field by field; absent for a refusal. */
  problems?: string[];
  usage: ModelUsage;
  model: string;
}

export interface PeterModel {
  readonly available: boolean;
  /** Whether this company's planning calls reach a model; without it, `available` answers for every company. */
  availableFor?(companyId: string): Promise<boolean>;
  complete<T extends z.ZodType>(req: ModelRequest<T>): Promise<ModelResult<z.infer<T>>>;
}

export interface AnthropicModelOptions {
  apiKey: string;
  apiBase?: string | null;
  /** Injected in tests; never the real network there. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** No key configured: nothing is called, every caller uses its heuristic. */
export const noModel: PeterModel = {
  available: false,
  async complete() {
    throw new Error("no model is configured for Peter");
  },
};

export function anthropicModel(opts: AnthropicModelOptions): PeterModel {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    ...(opts.apiBase ? { baseURL: opts.apiBase } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    timeout: opts.timeoutMs ?? 120_000,
    maxRetries: 1,
  });
  return {
    available: true,
    async complete(req) {
      const response = await client.messages.parse({
        model: req.model,
        max_tokens: req.maxTokens ?? 16_000,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
        output_config: {
          format: zodOutputFormat(req.schema),
          ...(req.effort ? { effort: req.effort as "low" | "medium" | "high" | "xhigh" | "max" } : {}),
        },
      });
      const u = response.usage;
      const usage: ModelUsage = {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      };
      if (response.stop_reason === "refusal") return { output: null, usage, model: response.model };
      return {
        output: (response.parsed_output as z.infer<typeof req.schema> | null) ?? null,
        usage,
        model: response.model,
      };
    },
  };
}

/** What a schema says is wrong with an answer, a line per field, for the model to read on its second try. */
export function schemaProblems(error: z.ZodError): string[] {
  return error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "the answer"}: ${i.message}`);
}

export function addUsage(
  a: Partial<ModelUsage> | null | undefined,
  b: ModelUsage,
): ModelUsage & { calls: number } {
  const prev = (a ?? {}) as Partial<ModelUsage> & { calls?: number };
  return {
    inputTokens: (prev.inputTokens ?? 0) + b.inputTokens,
    outputTokens: (prev.outputTokens ?? 0) + b.outputTokens,
    cacheReadTokens: (prev.cacheReadTokens ?? 0) + b.cacheReadTokens,
    cacheWriteTokens: (prev.cacheWriteTokens ?? 0) + b.cacheWriteTokens,
    calls: (prev.calls ?? 0) + 1,
  };
}

/**
 * The same model with a span per call posted to the collector: the purpose,
 * the model, the tokens, how long it took and how it ended (output, refusal,
 * error). Prompts and outputs never travel; only their sizes.
 */
export function tracedModel(model: PeterModel, sink: SpanSink): PeterModel {
  return {
    available: model.available,
    ...(model.availableFor ? { availableFor: (companyId: string) => model.availableFor!(companyId) } : {}),
    async complete(req) {
      const startMs = Date.now();
      let outcome: "output" | "refusal" | "error" = "error";
      let usage: ModelUsage | null = null;
      let answered: string | null = null;
      let error: string | null = null;
      try {
        const result = await model.complete(req);
        usage = result.usage;
        answered = result.model;
        outcome = result.output ? "output" : "refusal";
        return result;
      } catch (err) {
        error = (err as Error).message.slice(0, 500);
        throw err;
      } finally {
        const endMs = Date.now();
        void sink
          .post([
            standaloneSpan(
              `peter.model ${req.trace?.purpose ?? "call"}`,
              startMs,
              endMs,
              {
                "rosterdock.company_id": req.trace?.companyId ?? null,
                "rosterdock.goal_id": req.trace?.goalId ?? null,
                "rosterdock.task_id": req.trace?.taskId ?? null,
                "rosterdock.purpose": req.trace?.purpose ?? null,
                "rosterdock.model": answered ?? req.model,
                "rosterdock.outcome": outcome,
                "rosterdock.prompt_chars": req.system.length + req.user.length,
                "rosterdock.tokens.input": usage?.inputTokens ?? 0,
                "rosterdock.tokens.output": usage?.outputTokens ?? 0,
                "rosterdock.tokens.cache_read": usage?.cacheReadTokens ?? 0,
                "rosterdock.tokens.cache_write": usage?.cacheWriteTokens ?? 0,
                "rosterdock.duration_ms": endMs - startMs,
              },
              error ? { code: 2, message: error } : { code: 1 },
              3,
            ),
          ])
          .catch(() => {});
      }
    },
  };
}
