// How Peter thinks, per company. The board can offer three brains for his
// planning calls: the Claude Code CLI and the Codex CLI on its own machine,
// each on its own sign-in, and the Anthropic API with the board's key. A
// company picks one in Settings (`settings.planner`), or none; `auto`, the
// default, takes the first that works here in that order, so a board started
// where a CLI is signed in plans with it and nothing has to be set. Whether a
// CLI works is asked of the CLI itself (`claude auth status`, `codex login
// status`), at most once a minute. A company whose choice does not work here
// still plans: the call fails with the reason and Peter plans by role.

import {
  PLANNER_KINDS,
  PlannerSettingsSchema,
  type PlannerKind,
  type PlannerSettings,
} from "@rosterdock/shared";
import type { Queryable } from "../db/pool.js";
import { runCli } from "./cli.js";
import type { PeterModel } from "./model.js";

export const CLAUDE_STATUS_ARGS = ["auth", "status"];
export const CODEX_STATUS_ARGS = ["login", "status"];

export const PLANNER_LABELS: Record<PlannerKind, string> = {
  claude_cli: "Claude Code CLI",
  codex_cli: "Codex CLI",
  api: "Anthropic API",
};

export interface PlannerStatus {
  kind: PlannerKind;
  label: string;
  available: boolean;
  /** In a person's words: signed in and how, not installed, not signed in and what to run. */
  detail: string;
}

export interface StatusAnswer {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** `claude auth status` prints JSON: loggedIn, and how. Exported for the fixture tests. */
export function parseClaudeStatus(r: StatusAnswer): {
  available: boolean;
  detail: string;
} {
  try {
    const d = JSON.parse(r.stdout) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
    if (d.loggedIn)
      return {
        available: true,
        detail: `signed in (${[d.authMethod, d.subscriptionType].filter(Boolean).join(", ")})`,
      };
    return {
      available: false,
      detail: "installed, not signed in: run claude auth login where the board runs",
    };
  } catch {
    return { available: false, detail: "installed, but it did not say whether it is signed in" };
  }
}

/** `codex login status` prints one line (on stderr) and exits 0 when signed in. Exported for the fixture tests. */
export function parseCodexStatus(r: StatusAnswer): {
  available: boolean;
  detail: string;
} {
  const text = (r.stdout.trim() || r.stderr.trim()).split(/\r?\n/).pop() ?? "";
  if (r.code === 0 && /^logged in/i.test(text))
    return { available: true, detail: text.replace(/^logged in/i, "signed in") };
  return { available: false, detail: "installed, not signed in: run codex login where the board runs" };
}

export interface CliTarget {
  bin: string;
  prefixArgs?: string[];
}

export interface PlannerProbeOptions {
  /** Null: the board looks for no Claude CLI (ROSTERDOCK_PETER_CLIS=0). */
  claude: CliTarget | null;
  codex: CliTarget | null;
  apiKey: boolean;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

async function askCli(
  target: CliTarget | null,
  args: string[],
  parse: (r: StatusAnswer) => { available: boolean; detail: string },
  name: string,
  o: PlannerProbeOptions,
): Promise<{ available: boolean; detail: string }> {
  if (!target) return { available: false, detail: "turned off on this board" };
  try {
    const r = await runCli({
      bin: target.bin,
      ...(target.prefixArgs ? { prefixArgs: target.prefixArgs } : {}),
      args,
      stdin: "",
      env: o.env ?? process.env,
      timeoutMs: o.timeoutMs ?? 15_000,
      name,
      anyExit: true,
    });
    return parse(r);
  } catch (err) {
    const message = (err as Error).message;
    if (/did not start/.test(message))
      return { available: false, detail: "not installed where the board runs" };
    return { available: false, detail: message.slice(0, 200) };
  }
}

/** In a pod nobody runs a login: the sign-in is a token in the board's planner secret (board.plannerEnvNames). */
const IN_CLUSTER_HINT: Record<"claude_cli" | "codex_cli", [RegExp, string]> = {
  claude_cli: [
    /run claude auth login where the board runs/,
    "put CLAUDE_CODE_OAUTH_TOKEN (from claude setup-token) in the board's planner secret",
  ],
  codex_cli: [/run codex login where the board runs/, "put OPENAI_API_KEY in the board's planner secret"],
};

/** Ask each CLI whether it is there and signed in, and whether the board has a key. */
export async function probePlanners(o: PlannerProbeOptions): Promise<PlannerStatus[]> {
  const inCluster = !!(o.env ?? process.env).KUBERNETES_SERVICE_HOST;
  const hint = (kind: "claude_cli" | "codex_cli", s: { available: boolean; detail: string }) =>
    inCluster ? { ...s, detail: s.detail.replace(...IN_CLUSTER_HINT[kind]) } : s;
  const [claude, codex] = await Promise.all([
    askCli(o.claude, CLAUDE_STATUS_ARGS, parseClaudeStatus, "the Claude CLI", o).then((s) =>
      hint("claude_cli", s),
    ),
    askCli(o.codex, CODEX_STATUS_ARGS, parseCodexStatus, "the Codex CLI", o).then((s) =>
      hint("codex_cli", s),
    ),
  ]);
  return [
    { kind: "claude_cli", label: PLANNER_LABELS.claude_cli, ...claude },
    { kind: "codex_cli", label: PLANNER_LABELS.codex_cli, ...codex },
    {
      kind: "api",
      label: PLANNER_LABELS.api,
      available: o.apiKey,
      detail: o.apiKey ? "ANTHROPIC_API_KEY is set on the board" : "no ANTHROPIC_API_KEY on the board",
    },
  ];
}

export interface ResolvedPlanner {
  choice: PlannerSettings;
  /** The brain this company's calls go to; null: none, and `reason` says why. */
  kind: PlannerKind | null;
  reason: string;
}

export interface PlannerRouter extends PeterModel {
  statuses(refresh?: boolean): Promise<PlannerStatus[]>;
  resolve(companyId: string): Promise<ResolvedPlanner>;
}

/** One PeterModel over every brain the board has, sending each call to its company's choice. */
export function plannerRouter(opts: {
  db: Queryable;
  models: Partial<Record<PlannerKind, PeterModel>>;
  probe: () => Promise<PlannerStatus[]>;
  cacheMs?: number;
}): PlannerRouter {
  const cacheMs = opts.cacheMs ?? 60_000;
  let cached: { at: number; statuses: Promise<PlannerStatus[]> } | null = null;
  const statuses = (refresh = false): Promise<PlannerStatus[]> => {
    if (refresh || !cached || Date.now() - cached.at > cacheMs)
      cached = { at: Date.now(), statuses: opts.probe() };
    return cached.statuses;
  };
  const resolve = async (companyId: string): Promise<ResolvedPlanner> => {
    const row = (
      await opts.db.query<{ planner: unknown }>(
        "SELECT settings->'planner' AS planner FROM companies WHERE id = $1",
        [companyId],
      )
    ).rows[0];
    const choice = PlannerSettingsSchema.safeParse(row?.planner ?? {}).data ?? { via: "auto" };
    if (choice.via === "none") return { choice, kind: null, reason: "this company plans without a model" };
    const all = await statuses();
    const usable = (k: PlannerKind) => !!opts.models[k] && !!all.find((s) => s.kind === k)?.available;
    if (choice.via === "auto") {
      const kind = PLANNER_KINDS.find(usable) ?? null;
      return {
        choice,
        kind,
        reason: kind
          ? `automatic: the ${PLANNER_LABELS[kind]}`
          : "automatic: no model CLI is signed in and no key is set on this board",
      };
    }
    const label = PLANNER_LABELS[choice.via];
    if (usable(choice.via)) return { choice, kind: choice.via, reason: `the ${label}` };
    const detail = all.find((s) => s.kind === choice.via)?.detail ?? "turned off on this board";
    return { choice, kind: null, reason: `the ${label} is not available on this board: ${detail}` };
  };
  return {
    available: PLANNER_KINDS.some((k) => !!opts.models[k]),
    statuses,
    resolve,
    // A company that chose a brain the board lacks still calls, so the failure says why in the goal.
    async availableFor(companyId) {
      const r = await resolve(companyId);
      return r.kind !== null || (r.choice.via !== "auto" && r.choice.via !== "none");
    },
    async complete(req) {
      const companyId = req.trace?.companyId;
      if (!companyId) throw new Error("a planning call must name its company");
      const r = await resolve(companyId);
      if (!r.kind) throw new Error(r.reason);
      // Codex cannot take the Claude model on the manager's row: the company's Codex model, or Codex's own.
      const model = r.kind === "codex_cli" ? (r.choice.model ?? "") : req.model;
      return opts.models[r.kind]!.complete({ ...req, model });
    },
  };
}

/** Whether this company's planning reaches a model. */
export async function modelAvailable(model: PeterModel, companyId: string): Promise<boolean> {
  return model.availableFor ? model.availableFor(companyId) : model.available;
}
