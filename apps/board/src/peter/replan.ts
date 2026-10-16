// What Peter tells a teammate after a failed run. The model reads the failure
// and writes a short re-plan note, or says the failure needs a person (a
// missing credential, an unreachable system); the heuristic writes the note
// from the error itself. Pure: the caller records and dispatches.

import { z } from "zod";

/** After this many re-plans of one task Peter escalates instead of trying again. */
export const MAX_REPLANS = 2;
/** A review that has gone this many rounds with changes requested escalates. */
export const MAX_REVIEW_ROUNDS = 3;

export const ReplanSchema = z.object({
  /** One to three sentences the teammate reads at the top of their next run. */
  note: z.string().min(1).max(2000),
  /** True when no re-run can fix it: a person must act (credential, access, a decision). */
  needsPerson: z.boolean(),
  /** Why, in one sentence, for the person. */
  reason: z.string().max(500),
});
export type Replan = z.infer<typeof ReplanSchema>;

export interface FailureContext {
  taskNumber: number;
  taskTitle: string;
  brief: string;
  attemptsSoFar: number;
  error: string | null;
  summary: string | null;
  /** The teammate's handover or blocked note, if it wrote one. */
  handover: string | null;
  blockerCode: string;
  /** Who reads the note: their role and engine shape what the note can ask for. */
  teammate: { name: string; role: string; engine: string; model: string } | null;
}

/**
 * The model the note is written with: the teammate's own when Peter's client
 * can reach it (a Claude model), so the note is in the voice the teammate
 * works with; otherwise the manager's.
 */
export function replanModel(ctx: FailureContext, managerModel: string): string {
  const own = ctx.teammate?.model?.trim();
  return own && /^claude-/i.test(own) ? own : managerModel;
}

const NEEDS_PERSON_RE =
  /(credential|secret|api key|token|permission|access denied|unauthori[sz]ed|forbidden|401|403|not configured|missing_secret|no such env)/i;

/** The model-free re-plan: narrow, name what failed, and give up on failures no rerun can fix. */
export function heuristicReplan(ctx: FailureContext): Replan {
  const what = ctx.error ?? ctx.summary ?? "the run failed without a reason";
  if (ctx.blockerCode === "approval_required") {
    return {
      note: [
        `${what.slice(0, 400)}.`,
        "Do not propose that write again as it was. Finish the task without it, or propose a narrower write and say in its reason what changed.",
        "If the task cannot be done without it, set a blocker naming who decides instead of proposing it again.",
      ].join(" "),
      needsPerson: false,
      reason: "",
    };
  }
  const needsPerson =
    ctx.blockerCode === "missing_secret_ref" ||
    ctx.blockerCode === "missing_config" ||
    ctx.blockerCode === "token_budget_exhausted" ||
    NEEDS_PERSON_RE.test(`${what}\n${ctx.handover ?? ""}`);
  if (needsPerson) {
    return {
      note: `Attempt ${ctx.attemptsSoFar} failed: ${what}`,
      needsPerson: true,
      reason: `#${ctx.taskNumber} fails on something a rerun cannot fix: ${what.slice(0, 200)}`,
    };
  }
  return {
    note: [
      `Attempt ${ctx.attemptsSoFar} failed: ${what.slice(0, 300)}`,
      "Start from what already exists in the working directory rather than from zero.",
      "Do the smallest change that meets the acceptance criteria, then hand over.",
      "If you cannot finish, set a blocker naming who can unblock you instead of failing.",
    ].join(" "),
    needsPerson: false,
    reason: "",
  };
}

export function replanSystemPrompt(): string {
  return [
    "You are Peter, the project manager on the RosterDock board. A teammate's run on a task failed, or a write they proposed to a live system was rejected by a person (blocker approval_required).",
    "After a rejection the note must say not to propose the same write again, and what to do instead.",
    "Write the note they read at the top of their next run: what went wrong, what to do differently, what to leave alone. One to three sentences, concrete, no blame.",
    "Set needsPerson true only when no rerun can fix it: a missing credential or access, a system that is down, a decision only the owner can make. Then reason says what the person must do.",
    "Never include credential values; refer to credentials by name.",
  ].join("\n");
}

export function replanUserPrompt(ctx: FailureContext): string {
  return [
    `Task #${ctx.taskNumber} ${ctx.taskTitle}`,
    ctx.teammate
      ? `Teammate: ${ctx.teammate.name}, ${ctx.teammate.role}, working through ${ctx.teammate.engine}`
      : "Teammate: unknown",
    `Brief:\n${ctx.brief.slice(0, 3000)}`,
    `Attempts so far: ${ctx.attemptsSoFar}`,
    `Blocker: ${ctx.blockerCode}`,
    `Error: ${ctx.error ?? "none recorded"}`,
    `Summary: ${ctx.summary ?? "none"}`,
    ctx.handover ? `Handover or blocked note:\n${ctx.handover.slice(0, 3000)}` : "No handover was written.",
  ].join("\n\n");
}
