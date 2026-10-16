// Blocker taxonomy. One factory keeps the per-code defaults in a single file so
// emission sites stay one-liners. Prose is names-only: callers must never
// interpolate secret values into overrides.
//
// Ported from agent-board `src/gtm/blockers.ts`. The governance ladder codes
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
  /** True when re-dispatching the same work unchanged is safe. */
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
      "Decide the approval; do not re-dispatch, a duplicate run would re-propose the same write.",
  },
  missing_config: {
    what: "The engine is not configured.",
    why: "Required engine configuration is missing or disabled.",
    resolution: "Complete the engine configuration, then re-dispatch.",
    retrySafe: true,
  },
  missing_secret_ref: {
    what: "A referenced secret is not resolvable in the worker.",
    why: "The configured secret NAME has no value where the worker runs.",
    resolution:
      "Provide the secret by name in the cluster or environment (the value stays out of the board), then re-dispatch.",
    retrySafe: true,
  },
  transport_unreachable: {
    what: "The external endpoint could not be reached.",
    why: "The transport failed before any work happened (network, DNS, or the service is down).",
    resolution: "Check the service and its URL, then re-dispatch.",
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
    what: "Another run already holds this task.",
    why: "One active run per task: the lease serialises workers.",
    resolution: "Wait for the active run to finish, or stop it explicitly.",
    retrySafe: true,
  },
  token_budget_exhausted: {
    what: "The token budget is exhausted.",
    why: "Spend across this scope's runs meets or exceeds its budget.",
    resolution: "Raise or clear the budget if more spend is intended, then re-dispatch.",
    retrySafe: true,
  },
  worker_reported: {
    what: "The worker reported failure.",
    why: "The sandboxed command exited non-zero or the teammate declared the task blocked.",
    resolution: "Read the run log and handover, fix the underlying issue, then re-dispatch.",
    retrySafe: false,
  },
  retries_exhausted: {
    what: "Automatic retries are exhausted.",
    why: "The run failed again after every allowed retry.",
    resolution:
      "Read the run log and handover, fix the underlying issue, then re-dispatch or raise the retry budget.",
    retrySafe: false,
  },
  timeout: {
    what: "The run hit its time limit.",
    why: "The engine exceeded its configured maximum and was stopped.",
    resolution: "Raise the engine timeout or shrink the task, then re-dispatch.",
    retrySafe: true,
  },
  adapter_unavailable: {
    what: "No usable engine for this dispatch.",
    why: "The requested engine is not allowed for this teammate or has no live implementation.",
    resolution: "Pick an allowed engine for the teammate, or widen the engine allowlist deliberately.",
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
