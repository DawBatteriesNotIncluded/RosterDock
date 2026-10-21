// Goals and Peter's drafts on the Company view. A goal card says where the
// goal stands in manager language (Peter is reading it, needs you, live,
// done), answers Peter's questions in place, shows what it cost in tokens and
// money, and lets an owner or admin raise or lower its caps. A draft
// card shows what Peter proposes (departments, teammates, toolboxes as
// recommendations) or found (an audit), with Accept and Not now.
import type { UpdateGoalCapsInput } from "@rosterdock/shared";
import { useEffect, useState } from "react";
import type {
  Artifact,
  AuditReport,
  CompanyData,
  Draft,
  Goal,
  GoalFile,
  GoalResult,
  OrgProposal,
  Task,
} from "../api/types.ts";
import { Avatar, Button, Empty, Pill, Thinking } from "../components/ui.tsx";
import { relativeTime } from "../lib/format.ts";
import { money } from "./CostsView.tsx";
import { fmtTokens } from "./RunPanel.tsx";

export const GOAL_LABEL: Record<Goal["status"], string> = {
  planning: "Peter is reading it",
  needs_you: "Needs you",
  active: "In progress",
  done: "Done",
  stopped: "Stopped",
};

export function goalTone(goal: Goal, tasks: Task[]): "ok" | "warn" | "info" | "bad" | "muted" {
  if (goal.status === "needs_you") return "warn";
  if (goal.status === "active") return tasks.some((t) => t.status === "doing") ? "ok" : "info";
  return "muted";
}

/** The goal's tasks: done, open, whether one is blocked, and what was cancelled (not in the total). */
export function goalProgress(goal: Goal, tasks: Task[]) {
  const mine = tasks.filter((t) => t.goalId === goal.id);
  const cancelled = mine.filter((t) => t.status === "cancelled").length;
  return {
    total: mine.length - cancelled,
    cancelled,
    done: mine.filter((t) => t.status === "done").length,
    working: mine.filter((t) => t.status === "doing").length,
    blocked: mine.filter((t) => t.status === "blocked").length,
    tasks: mine,
  };
}

/** The spend line: tokens so far, money when the price table knows the models, the cap. */
export function goalSpendLine(goal: Goal): string {
  const s = goal.spend;
  const parts = [`${fmtTokens(s.totalTokens)} tokens`];
  if (s.costMinorUnits !== null && s.currency) parts.push(money(s.costMinorUnits, s.currency));
  if (s.tokensCap) parts.push(`cap ${fmtTokens(s.tokensCap)}`);
  return parts.join(" · ");
}

const digits = (v: string) => v.replace(/[^0-9]/g, "");

/** How the goal card reaches a goal's result and the links to save it. */
export interface GoalResultAccess {
  load(goalId: string): Promise<GoalResult>;
  loadArtifact(runId: string, artifactId: string): Promise<Artifact>;
  zipUrl(goalId: string): string;
  downloadUrl(runId: string, artifactId: string): string;
}

const size = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : bytes >= 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${bytes} bytes`;

/** Whether a live copy is what review approved, in a word and a sentence. */
export function publishedVerdict(
  w: GoalResult["published"][number],
): { tone: "ok" | "bad"; label: string; hint: string } | null {
  const m = w.matchesDelivered;
  if (!m) return null;
  return m.same
    ? {
        tone: "ok",
        label: "The approved file",
        hint: `It is #${m.number}'s ${m.path}, as review approved it.`,
      }
    : {
        tone: "bad",
        label: "Not the approved file",
        hint: `It differs from #${m.number}'s ${m.path}, the file review approved.`,
      };
}

function FileRow({ f, access }: { f: GoalFile; access: GoalResultAccess }) {
  const [open, setOpen] = useState<Artifact | null>(null);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="outfile">
        <span className="flex min-w-0 flex-col">
          <span className="mono truncate text-[12px]">{f.path}</span>
          <span className="text-[11px] text-muted">{size(f.bytes)}</span>
        </span>
        <span className="flex items-center gap-3 text-[12px]">
          {f.binary ? null : (
            <button
              onClick={() =>
                open ? setOpen(null) : void access.loadArtifact(f.runId, f.artifactId).then(setOpen)
              }
            >
              <span className="text-accent">{open ? "Close" : "Open"}</span>
            </button>
          )}
          <a className="text-accent" href={access.downloadUrl(f.runId, f.artifactId)} download>
            Download
          </a>
        </span>
      </div>
      {open ? (
        <pre className="action-json" style={{ whiteSpace: "pre-wrap", maxHeight: 420 }}>
          {open.content ?? "(stored in object storage; download it to read it)"}
        </pre>
      ) : null}
    </div>
  );
}

/** A goal's result on its card: what it delivered, what it published, the rest, and all of it at once. */
export function GoalResultPanel({
  goalId,
  access,
  initial,
}: {
  goalId: string;
  access: GoalResultAccess;
  initial?: GoalResult;
}) {
  const [result, setResult] = useState<GoalResult | null>(initial ?? null);
  const [showSupporting, setShowSupporting] = useState(false);
  useEffect(() => {
    if (!initial) void access.load(goalId).then(setResult);
  }, [goalId]);
  if (!result) return <span className="hint">Loading the result…</span>;
  const files = [...result.delivered, ...result.supporting].reduce((n, t) => n + t.files.length, 0);
  return (
    <div className="flex flex-col gap-2.5 border-t border-[var(--border-soft)] pt-2.5">
      <span className="eyebrow">What it delivered</span>
      {result.delivered.length === 0 ? <span className="hint">No task of this goal is Done yet.</span> : null}
      {result.delivered.map((t) => (
        <div key={t.taskId} className="flex flex-col gap-1.5">
          <span className="text-[12px] font-semibold">
            #{t.number} {t.title}
          </span>
          {t.files.length ? (
            t.files.map((f) => <FileRow key={f.artifactId} f={f} access={access} />)
          ) : (
            <span className="hint">It kept no file; its conversation and review say what it did.</span>
          )}
        </div>
      ))}
      {result.published.length ? (
        <>
          <span className="eyebrow">Published</span>
          {result.published.map((w) => {
            const verdict = publishedVerdict(w);
            return (
              <div key={w.approvalId} className="flex flex-col gap-1">
                <div className="row">
                  <span className="mono text-[12px]">
                    {w.connection} · {w.target ?? w.tool}
                  </span>
                  {verdict ? <Pill tone={verdict.tone}>{verdict.label}</Pill> : null}
                </div>
                <span className="hint">
                  Written for #{w.number} {relativeTime(w.executedAt)}
                  {w.now
                    ? `, then by #${w.now.number} (${w.now.title}) ${relativeTime(w.now.executedAt)}`
                    : ""}
                  .{verdict ? ` ${verdict.hint}` : ""}
                </span>
              </div>
            );
          })}
        </>
      ) : null}
      {result.supporting.length ? (
        <>
          <button className="self-start" onClick={() => setShowSupporting(!showSupporting)}>
            <span className="text-[12px] text-accent">
              {showSupporting ? "Hide" : "Show"} the work on the way ({result.supporting.length}{" "}
              {result.supporting.length === 1 ? "task" : "tasks"})
            </span>
          </button>
          {showSupporting
            ? result.supporting.map((t) => (
                <div key={t.taskId} className="flex flex-col gap-1.5">
                  <span className="text-[12px] font-semibold">
                    #{t.number} {t.title}
                  </span>
                  {t.files.map((f) => (
                    <FileRow key={f.artifactId} f={f} access={access} />
                  ))}
                </div>
              ))
            : null}
        </>
      ) : null}
      {files ? (
        <a className="btn sm self-start" href={access.zipUrl(goalId)} download>
          Download all ({files} {files === 1 ? "file" : "files"})
        </a>
      ) : null}
    </div>
  );
}

/** Raise or lower a goal's caps in place. Blank tokens means no cap. */
function CapsEditor({
  goal,
  onSave,
  onClose,
}: {
  goal: Goal;
  onSave(caps: UpdateGoalCapsInput): Promise<void>;
  onClose(): void;
}) {
  const [maxTasks, setMaxTasks] = useState(String(goal.caps.maxTasks));
  const [maxDepth, setMaxDepth] = useState(String(goal.caps.maxDepth));
  const [tokens, setTokens] = useState(goal.caps.tokens ? String(goal.caps.tokens) : "");
  const [busy, setBusy] = useState(false);
  const patch: UpdateGoalCapsInput = {};
  if (maxTasks && Number(maxTasks) !== goal.caps.maxTasks) patch.maxTasks = Number(maxTasks);
  if (maxDepth && Number(maxDepth) !== goal.caps.maxDepth) patch.maxDepth = Number(maxDepth);
  const tokensValue = tokens ? Number(tokens) : null;
  if (tokensValue !== goal.caps.tokens) patch.tokens = tokensValue;
  const changed = Object.keys(patch).length > 0;
  return (
    <form
      className="caps-editor"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await onSave(patch);
          onClose();
        } finally {
          setBusy(false);
        }
      }}
    >
      <span className="text-[12px] font-semibold">Caps</span>
      <div className="caps-grid">
        <label className="field">
          <span className="text-[12px] text-muted">Tasks at most</span>
          <input className="mono" value={maxTasks} onChange={(e) => setMaxTasks(digits(e.target.value))} />
        </label>
        <label className="field">
          <span className="text-[12px] text-muted">Follow-ups deep</span>
          <input className="mono" value={maxDepth} onChange={(e) => setMaxDepth(digits(e.target.value))} />
        </label>
        <label className="field">
          <span className="text-[12px] text-muted">Token cap</span>
          <input
            className="mono"
            value={tokens}
            placeholder="none"
            onChange={(e) => setTokens(digits(e.target.value))}
          />
        </label>
      </div>
      <span className="text-[12px] text-muted">
        Teammates cannot file tasks past these; the token cap is the project's lifetime budget.
      </span>
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={busy || !changed}>
          Save caps
        </Button>
      </div>
    </form>
  );
}

function GoalCard({
  goal,
  data,
  canDecide,
  onOpen,
  onAnswer,
  onStop,
  onUpdateCaps,
  results,
}: {
  goal: Goal;
  data: CompanyData;
  canDecide: boolean;
  onOpen(projectId: string): void;
  onAnswer(goalId: string, answers: string[]): Promise<void>;
  onStop(goalId: string): Promise<void>;
  onUpdateCaps(goalId: string, caps: UpdateGoalCapsInput): Promise<void>;
  results?: GoalResultAccess;
}) {
  const progress = goalProgress(goal, data.tasks);
  const [showResult, setShowResult] = useState(false);
  const open = goal.questions.filter((q) => q.answer === null);
  const [answers, setAnswers] = useState<string[]>(() => open.map(() => ""));
  const [busy, setBusy] = useState(false);
  const [editingCaps, setEditingCaps] = useState(false);
  const capsEditable = canDecide && goal.status !== "done" && goal.status !== "stopped";
  const assignees = [
    ...new Set(
      progress.tasks
        .map((t) =>
          t.assignee?.kind === "teammate" ? data.teammates.find((x) => x.id === t.assignee!.id) : null,
        )
        .filter((t): t is NonNullable<typeof t> => !!t),
    ),
  ];
  const dept = goal.departmentId ? data.departments.find((d) => d.id === goal.departmentId) : null;
  // A goal that went into a project that existed says which; one that opened its project is named after it.
  const joined = goal.openedProject ? null : data.projects.find((p) => p.id === goal.projectId);
  const tone = goalTone(goal, progress.tasks);
  return (
    <div className="card goal-card">
      <div className="row">
        <button className="goal-title" onClick={() => onOpen(goal.projectId)}>
          {goal.title}
        </button>
        <Pill tone={tone}>{tone === "ok" ? "Live" : GOAL_LABEL[goal.status]}</Pill>
      </div>
      <span className="text-[12px] text-muted">
        {joined ? `In ${joined.name} · ` : ""}
        {dept ? `${dept.name} · ` : ""}
        {progress.total
          ? `${progress.done} of ${progress.total} tasks done${progress.working ? ` · ${progress.working} working` : ""}${progress.blocked ? ` · ${progress.blocked} blocked` : ""}${progress.cancelled ? ` · ${progress.cancelled} cancelled` : ""}`
          : progress.cancelled
            ? `${progress.cancelled} ${progress.cancelled === 1 ? "task" : "tasks"} cancelled`
            : goal.status === "planning"
              ? "Peter is splitting it into tasks"
              : "No tasks yet"}
      </span>
      {assignees.length ? (
        <div className="flex items-center gap-1.5">
          {assignees.map((t) => (
            <Avatar key={t.id} name={t.name} handle={t.handle} size="s" />
          ))}
          <span className="text-[12px] text-muted">{assignees.map((t) => t.name).join(", ")}</span>
        </div>
      ) : null}
      {goal.status === "needs_you" && open.length ? (
        <form
          className="qa"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await onAnswer(goal.id, answers);
            } finally {
              setBusy(false);
            }
          }}
        >
          <span className="text-[12px] font-semibold">Peter asks</span>
          {open.map((q, i) => (
            <label key={i} className="field">
              <span className="text-[13px]">{q.text}</span>
              <textarea
                value={answers[i] ?? ""}
                onChange={(e) => setAnswers(answers.map((a, j) => (j === i ? e.target.value : a)))}
                rows={2}
              />
            </label>
          ))}
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" onClick={() => void onStop(goal.id)}>
              Drop the goal
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={busy || answers.some((a) => !a.trim())}
            >
              Answer
            </Button>
          </div>
        </form>
      ) : goal.status === "needs_you" && goal.attention ? (
        <div className="attention-note">
          <span>{goal.attention}</span>
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={() => void onStop(goal.id)}>
              Drop the goal
            </Button>
            <Button size="sm" variant="primary" onClick={() => onOpen(goal.projectId)}>
              Open the board
            </Button>
          </div>
        </div>
      ) : null}
      {editingCaps ? (
        <CapsEditor
          goal={goal}
          onSave={(caps) => onUpdateCaps(goal.id, caps)}
          onClose={() => setEditingCaps(false)}
        />
      ) : null}
      <div className="row">
        <span className="text-[12px] text-muted">
          {goal.status === "done" ? "Cost" : "So far"}: {goalSpendLine(goal)}
          {goal.planner
            ? ` · planned by ${goal.planner.startsWith("model") ? "Peter's model" : "Peter's rules"}`
            : ""}
        </span>
        {capsEditable && !editingCaps ? (
          <button className="link text-[12px]" onClick={() => setEditingCaps(true)}>
            Caps
          </button>
        ) : null}
      </div>
      {results && progress.done ? (
        <button className="self-start" onClick={() => setShowResult(!showResult)}>
          <span className="text-[12px] text-accent">
            {showResult
              ? "Hide the result"
              : goal.status === "done"
                ? "See the result"
                : "What it has delivered"}
          </span>
        </button>
      ) : null}
      {results && showResult ? <GoalResultPanel goalId={goal.id} access={results} /> : null}
    </div>
  );
}

export function GoalsSection({
  data,
  canDecide,
  onNewGoal,
  onOpen,
  onAnswer,
  onStop,
  onUpdateCaps,
  results,
}: {
  data: CompanyData;
  canDecide: boolean;
  onNewGoal(): void;
  onOpen(projectId: string): void;
  onAnswer(goalId: string, answers: string[]): Promise<void>;
  onStop(goalId: string): Promise<void>;
  onUpdateCaps(goalId: string, caps: UpdateGoalCapsInput): Promise<void>;
  results?: GoalResultAccess;
}) {
  const order: Goal["status"][] = ["needs_you", "planning", "active", "done", "stopped"];
  const goals = [...data.goals].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  const shown = goals.filter((g) => g.status !== "stopped");
  return (
    <>
      <div className="row">
        <span className="eyebrow">Goals</span>
        <span className="text-[12px] text-muted">
          {data.goals.filter((g) => g.status === "needs_you").length
            ? `${data.goals.filter((g) => g.status === "needs_you").length} need you`
            : `${data.goals.filter((g) => g.status === "active").length} in progress`}
        </span>
      </div>
      <div className="goals">
        {shown.map((g) => (
          <GoalCard
            key={g.id}
            goal={g}
            data={data}
            canDecide={canDecide}
            onOpen={onOpen}
            onAnswer={onAnswer}
            onStop={onStop}
            onUpdateCaps={onUpdateCaps}
            {...(results ? { results } : {})}
          />
        ))}
        {shown.length === 0 ? (
          <Empty>
            <button className="btn primary" onClick={onNewGoal}>
              Hand Peter a goal
            </button>
          </Empty>
        ) : null}
      </div>
    </>
  );
}

function OrgDraft({ proposal }: { proposal: OrgProposal }) {
  return (
    <>
      <span className="text-[13px] text-ink-2">{proposal.summary}</span>
      {proposal.departments.map((d) => (
        <div key={d.name} className="draft-dept">
          <div className="row">
            <span className="font-semibold">{d.name}</span>
            <Pill tone="muted">
              {d.writePolicy === "readonly"
                ? "Read only"
                : d.writePolicy === "drafts"
                  ? "Drafts auto, live writes ask"
                  : "Every write asks"}
            </Pill>
          </div>
          <span className="text-[12px] text-muted">{d.policy}</span>
          <div className="flex flex-wrap gap-1.5">
            {d.teammates.map((t) => (
              <span key={t.name} className="tag">
                {t.name} · {t.role}
                {t.lead ? " · lead" : ""}
              </span>
            ))}
          </div>
          {d.toolbox.length ? (
            <span className="text-[12px] text-muted">
              Toolbox recommended: {d.toolbox.join(", ")}. Nothing is granted until you approve it.
            </span>
          ) : null}
        </div>
      ))}
    </>
  );
}

function AuditDraft({ report }: { report: AuditReport }) {
  return (
    <>
      <span className="text-[13px] text-ink-2">{report.summary}</span>
      {report.findings.map((f, i) => (
        <div key={i} className="finding">
          <span className="text-[13px]">{f.text}</span>
          <span className="text-[12px] text-muted">{f.suggestion}</span>
        </div>
      ))}
      {report.findings.length === 0 ? <span className="text-[12px] text-muted">Nothing to do.</span> : null}
    </>
  );
}

export function DraftsSection({
  data,
  canDecide,
  onDesign,
  onAudit,
  onAccept,
  onReject,
}: {
  data: CompanyData;
  canDecide: boolean;
  onDesign(): void;
  onAudit(): Promise<void>;
  onAccept(draft: Draft): Promise<void>;
  onReject(draft: Draft): Promise<void>;
}) {
  const proposed = data.drafts.filter((d) => d.status === "proposed");
  // An audit is a model call over the whole company: minutes, not seconds. Say so while it runs.
  const [auditing, setAuditing] = useState(false);
  const audit = async () => {
    setAuditing(true);
    try {
      await onAudit();
    } catch {
      // The error is a toast.
    } finally {
      setAuditing(false);
    }
  };
  return (
    <>
      <div className="row mt-1.5">
        <span className="eyebrow">Peter proposes</span>
        {canDecide ? (
          <div className="flex gap-2">
            <Button size="sm" disabled={auditing} onClick={() => void audit()}>
              Audit the company
            </Button>
            <Button size="sm" onClick={onDesign}>
              Design from a brief
            </Button>
          </div>
        ) : null}
      </div>
      {auditing ? <Thinking>Peter is auditing the company; his findings appear here…</Thinking> : null}
      <div className="flex flex-col gap-2.5">
        {proposed.map((d) => (
          <div key={d.id} className="card draft">
            <div className="row">
              <span className="font-semibold">{d.kind === "org" ? `From "${d.brief}"` : "Audit"}</span>
              <Pill tone={d.kind === "audit" ? "info" : "warn"}>
                {d.kind === "org" ? "Draft" : "Findings"}
              </Pill>
            </div>
            {d.kind === "org" ? (
              <OrgDraft proposal={d.proposal as OrgProposal} />
            ) : (
              <AuditDraft report={d.proposal as AuditReport} />
            )}
            {canDecide ? (
              <div className="flex justify-end gap-2">
                <Button size="sm" onClick={() => void onReject(d)}>
                  Not now
                </Button>
                <Button size="sm" variant="primary" onClick={() => void onAccept(d)}>
                  {d.kind === "org" ? "Accept and create" : "Noted"}
                </Button>
              </div>
            ) : null}
          </div>
        ))}
        {proposed.length === 0 ? (
          <span className="text-[12px] text-muted">
            Nothing waiting. Ask Peter to design a department from a brief, or to audit the company as it
            stands.
          </span>
        ) : null}
      </div>
    </>
  );
}
