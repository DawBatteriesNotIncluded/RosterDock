// Blocker taxonomy. One factory keeps the per-code defaults in a single file so
// emission sites stay one-liners. Prose is names-only: callers must never
// interpolate secret values into overrides.
//
// Carried over from the v1 prototype. The governance ladder codes
// (kill_switch, governance_level) are gone with the ladder. `waiting_on_teammate`
// is new: the Blocked column's three reasons are dependency, waiting on a
// teammate, and waiting on an approval.

export const BLOCKER_CODES = [
  "dependencies_unresolved",
  "waiting_on_teammate",
  "approval_required",
  "missing_config",
  "missing_secret_ref",
  "transport_unreachable",
  "evidence_failed",
  "lease_conflict",
  "token_budget_exhausted",
  "worker_reported",
  "retries_exhausted",
  "timeout",
  "adapter_unavailable",
  "unknown",
] as const;
export type BlockerCode = (typeof BLOCKER_CODES)[number];

/** What the board shows: the manager-facing grouping of a blocker. */
export type BlockerKind = "dependency" | "teammate" | "approval" | "run";

export interface BlockerRecord {
  code: BlockerCode;
  /** What happened, one sentence. */
  what: string;
  /** Why it happened. */
  why: string;
  /** What the manager can do about it. */
  resolution?: string;
  /** True when starting the same work again unchanged is safe. */
  retrySafe: boolean;
  /** How to resume, when plain retry is not the answer. */
  resumeInstructions?: string;
  /** Names only. The teammate, task or approval this blocker waits on, when there is one. */
  waitingOn?: { kind: "teammate" | "task" | "approval"; id: string; name?: string };
}

const DEFAULTS: Record<BlockerCode, Omit<BlockerRecord, "code">> = {
  dependencies_unresolved: {
    what: "The task has unfinished dependency tasks.",
    why: "Tasks this one depends on are not done yet; dependent work must not start before they finish.",
    resolution: "Finish (or unlink) the dependency tasks.",
    retrySafe: true,
  },
  waiting_on_teammate: {
    what: "The task is waiting on another teammate.",
    why: "The assignee asked a teammate a question or needs their output before continuing.",
    resolution: "Answer on the task, or ask the named teammate to.",
    retrySafe: true,
  },
  approval_required: {
    what: "The run stopped at an approval gate.",
    why: "An external write was proposed and needs a decision.",
    resolution: "Approve or reject the pending approval; approval executes the bound action.",
    retrySafe: false,
    resumeInstructions:
      "Decide the approval; do not start the task again, a second run would propose the same write again.",
  },
  missing_config: {
    what: "The engine is not set up.",
    why: "Something the engine needs is missing or switched off.",
    resolution: "Finish setting the engine up, then start the task again.",
    retrySafe: true,
  },
  missing_secret_ref: {
    what: "A credential the run needs has no value.",
    why: "The credential is named, and that name has no value where the teammate works.",
    resolution:
      "Give the name a value (in Settings, or ask whoever runs the board; the value never shows here), then start the task again.",
    retrySafe: true,
  },
  transport_unreachable: {
    what: "The service could not be reached.",
    why: "The connection failed before any work happened (network, DNS, or the service is down).",
    resolution: "Check the service and its address, then start the task again.",
    retrySafe: true,
  },
  evidence_failed: {
    what: "The review checks rejected the output.",
    why: "A required output is missing, a check failed, or the verification report does not pass.",
    resolution: "Fix the output and resubmit for review.",
    retrySafe: false,
    resumeInstructions: "Address the failing checks, then request review again.",
  },
  lease_conflict: {
    what: "Another run is already working on this task.",
    why: "Only one run works on a task at a time.",
    resolution: "Wait for that run to finish, or stop it.",
    retrySafe: true,
  },
  token_budget_exhausted: {
    what: "The token budget is exhausted.",
    why: "Spend across this scope's runs meets or exceeds its budget.",
    resolution: "Raise or clear the budget if more spend is intended, then start the task again.",
    retrySafe: true,
  },
  worker_reported: {
    what: "The run failed.",
    why: "A command in the run failed, or the teammate said the task is blocked.",
    resolution: "Read the run log and handover, fix what went wrong, then start the task again.",
    retrySafe: false,
  },
  retries_exhausted: {
    what: "Automatic retries are exhausted.",
    why: "The run failed again after every allowed retry.",
    resolution: "Read the run log and handover, fix what went wrong, then start the task again.",
    retrySafe: false,
  },
  timeout: {
    what: "The run hit its time limit.",
    why: "The run went past its time limit and was stopped.",
    resolution:
      "Split the task into smaller ones, or raise the department's time limit, then start it again.",
    retrySafe: true,
  },
  adapter_unavailable: {
    what: "No engine can run this teammate's work.",
    why: "The teammate's engine is switched off on this board, or no worker has it.",
    resolution: "Pick another engine in the teammate's editor.",
    retrySafe: true,
  },
  unknown: {
    what: "The task is blocked.",
    why: "No structured reason was recorded.",
    resolution: "Read the latest run summary and conversation, then restart or reassign.",
    retrySafe: false,
  },
};

export function blockerFor(
  code: BlockerCode,
  overrides: Partial<Omit<BlockerRecord, "code">> = {},
): BlockerRecord {
  return { code, ...DEFAULTS[code], ...overrides };
}

export function isBlockerCode(value: unknown): value is BlockerCode {
  return typeof value === "string" && (BLOCKER_CODES as readonly string[]).includes(value);
}

/** The Blocked column groups blockers into three manager-facing reasons plus "run". */
export function blockerKind(code: BlockerCode): BlockerKind {
  switch (code) {
    case "dependencies_unresolved":
      return "dependency";
    case "waiting_on_teammate":
      return "teammate";
    case "approval_required":
      return "approval";
    default:
      return "run";
  }
}
