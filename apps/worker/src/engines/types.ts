import type { RunEventInput, RunUsage } from "@rosterdock/shared";

export interface EngineContext {
  /** Absolute path of the run's ephemeral working directory. */
  workdir: string;
  /** Rendered run pack (markdown). The engine's full contract. */
  pack: string;
  model: string;
  /** How hard the model thinks (low, medium, high, xhigh, max); null: the engine's default. */
  effort?: string | null;
  /** Stop signal: the board asked for a stop or the worker is shutting down. */
  signal: AbortSignal;
  /** Emit a run event (buffered and shipped to the board by the caller). */
  emit(event: RunEventInput): void;
  /** Report usage as it becomes known. */
  onUsage(usage: Partial<RunUsage>): void;
  /** Environment for the child process: allowlisted names only, already narrowed by the department preset. */
  env: Record<string, string>;
  /** Tool allowlist for this run, or null for the engine default. */
  allowedTools: string[] | null;
  /** The board MCP server for this run, or null when the engine cannot use MCP. */
  mcp: { url: string; token: string } | null;
}

export interface EngineResult {
  ok: boolean;
  exitCode: number | null;
  usage: Partial<RunUsage>;
  /** The engine's final text, if any. */
  resultText: string | null;
  error?: string;
}

export interface EngineAdapter {
  readonly id: string;
  run(ctx: EngineContext): Promise<EngineResult>;
}
