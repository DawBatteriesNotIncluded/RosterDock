// Pure helpers: names, avatars, relative time, and event sentences. No React.
import type { ActorRef, EventRecord } from "@rosterdock/shared";
import { domainsPhrase } from "@rosterdock/shared/web";
import type { CompanyData, Task, Teammate } from "../api/types.ts";

export function relativeTime(iso: string, now: number = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const s = Math.round(diff / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Avatar tone from a stable hash of the handle, matching the prototype's palette. */
export function avatarTone(handle: string): string {
  const tones = ["p", "r", "b", "a", "c", "v", "rp"];
  let h = 0;
  for (const ch of handle) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return tones[h % tones.length]!;
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "?";
  const second = parts.length > 1 ? (parts[1]?.[0] ?? "") : "";
  return (first + second).toUpperCase();
}

export interface ActorInfo {
  ref: ActorRef;
  name: string;
  handle: string;
  role: string;
  isYou: boolean;
}

export function actorInfo(
  data: Pick<CompanyData, "teammates" | "members">,
  ref: ActorRef | null,
  meId?: string,
): ActorInfo | null {
  if (!ref) return null;
  if (ref.kind === "teammate") {
    const t = data.teammates.find((x) => x.id === ref.id);
    return {
      ref,
      name: t?.name ?? "teammate",
      handle: t?.handle ?? "teammate",
      role: t?.role ?? "",
      isYou: false,
    };
  }
  const m = data.members.find((x) => x.userId === ref.id);
  return {
    ref,
    name: ref.id === meId ? "You" : (m?.name ?? "someone"),
    handle: m?.email ?? "user",
    role: m?.role ?? "",
    isYou: ref.id === meId,
  };
}

/** Done and Cancelled are closed; every other status is open (work someone still owes). */
export const isOpenTask = (status: Task["status"]): boolean => status !== "done" && status !== "cancelled";

export const STATUS_LABEL: Record<Task["status"], string> = {
  todo: "To do",
  doing: "In progress",
  blocked: "Blocked",
  review: "In review",
  done: "Done",
  cancelled: "Cancelled",
};

export const POLICY_LABEL: Record<string, string> = {
  readonly: "Read only",
  drafts: "Drafts auto, live writes ask",
  ask: "Every write asks",
};

/** The model a hire starts on when its template names none: DEFAULT_MODEL in @rosterdock/shared, which the web
 * takes types from only. */
export const DEFAULT_MODEL = "claude-sonnet-5-5";

export const ENGINE_LABEL: Record<string, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  stub: "Stub (no model)",
};

/** Engines a person can pick. OpenCode has no worker yet (docs/backlog.md): its label stays for display only. */
export const PICKABLE_ENGINES = ["claude_code", "codex", "stub"];

/** An engine picker's choices: the pickable engines, and a teammate's own when it runs on another. */
export function engineChoices(current: string): [string, string][] {
  const ids = PICKABLE_ENGINES.includes(current) ? PICKABLE_ENGINES : [...PICKABLE_ENGINES, current];
  return ids.map((id) => [
    id,
    PICKABLE_ENGINES.includes(id) ? (ENGINE_LABEL[id] ?? id) : `${ENGINE_LABEL[id] ?? id} (not available)`,
  ]);
}

/** What a teammate is doing right now, derived from the board. */
export function teammateStatus(
  t: Teammate,
  tasks: Task[],
): { tone: "ok" | "warn" | "bad" | "info" | "idle"; text: string } {
  const mine = tasks.filter(
    (x) => x.assignee?.kind === "teammate" && x.assignee.id === t.id && isOpenTask(x.status),
  );
  const doing = mine.find((x) => x.status === "doing");
  if (doing)
    return { tone: "ok", text: `${/review/i.test(t.role) ? "Reviewing" : "Building"} · ${doing.title}` };
  const blocked = mine.find((x) => x.status === "blocked");
  if (blocked) return { tone: "bad", text: `Blocked · ${blocked.title}` };
  const review = mine.find((x) => x.status === "review");
  if (review) return { tone: "info", text: `In review · ${review.title}` };
  const queued = mine.find((x) => x.status === "todo");
  if (queued) return { tone: "idle", text: `Queued · ${queued.title}` };
  return { tone: "idle", text: "Idle · available" };
}

/** The drift sentence: what departed from the teammate's own baseline, and by how much. */
export function driftLine(p: Record<string, unknown>): string {
  const who = String(p.teammateName ?? "A teammate");
  const n = p.number !== undefined && p.number !== null ? ` on #${p.number}` : "";
  const ratio = Number(p.ratio);
  const times = Number.isFinite(ratio) ? `${ratio.toFixed(1)}×` : "well above";
  const tokens = (v: unknown) => `${Math.round(Number(v) / 1000)}k tokens`;
  const minutes = (v: unknown) => `${Math.round(Number(v) / 60_000)} min`;
  const pct = (v: unknown) => `${Math.round(Number(v) * 100)}%`;
  switch (p.metric) {
    case "cost":
      return `${who}'s runs cost ${times} their usual (${tokens(p.value)} against ${tokens(p.baseline)}${n})`;
    case "duration":
      return `${who}'s runs take ${times} their usual (${minutes(p.value)} against ${minutes(p.baseline)}${n})`;
    case "rejection":
      return `${who}'s work is coming back: ${pct(p.value)} of recent reviews sent it back, against ${pct(p.baseline)} before${n}`;
    default:
      return `${who} departed from their baseline`;
  }
}

/** The departures standing against a teammate: drift events on them within the last day. */
export function standingDrift(t: Teammate, events: EventRecord[], now: number = Date.now()): EventRecord[] {
  const seen = new Set<string>();
  return events.filter((e) => {
    if (e.type !== "teammate.drift" || e.subject?.id !== t.id) return false;
    if (now - new Date(e.createdAt).getTime() > 24 * 3600_000) return false;
    const metric = String((e.payload as { metric?: unknown }).metric);
    if (seen.has(metric)) return false;
    seen.add(metric);
    return true;
  });
}

/** A blocker only a person can end: a write to approve, or a wait on a person. Amber, never red. */
export function blockerNeedsYou(b: Pick<NonNullable<Task["blocker"]>, "code"> | null | undefined): boolean {
  return b?.code === "approval_required" || b?.code === "waiting_on_person";
}

/** Blocked card line, in manager language. */
export function blockerLine(task: Task): string {
  const b = task.blocker;
  if (!b) return "Blocked";
  if (b.code === "approval_required") return "Needs your approval";
  if (b.code === "waiting_on_person") return "Needs you";
  if (b.waitingOn?.name) return `Waiting on ${b.waitingOn.kind === "teammate" ? "@" : ""}${b.waitingOn.name}`;
  return b.what;
}

export interface Sentence {
  text: string;
  attention?: boolean;
  go?: {
    view: "board" | "org" | "team" | "activity" | "reviews" | "company" | "approvals";
    taskId?: string;
    projectId?: string;
    departmentId?: string;
    teammateId?: string;
    reviewId?: string;
    approvalId?: string;
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const p = (ev: EventRecord) => ev.payload as Record<string, any>;

/** One human sentence per event, for Activity and the Happening-now rail. */
export function describeEvent(
  ev: EventRecord,
  data: Pick<CompanyData, "teammates" | "members">,
  meId?: string,
): Sentence {
  const actor = actorInfo(data, ev.actor, meId);
  const who = actor?.name ?? "RosterDock";
  const n = p(ev).number !== undefined ? `#${p(ev).number}` : "";
  const title = p(ev).title ? ` ${p(ev).title}` : "";
  const taskId = ev.subject?.kind === "task" ? ev.subject.id : undefined;
  switch (ev.type) {
    case "company.created":
      return { text: `${who} created the company ${p(ev).name}` };
    case "company.updated":
      return { text: `${who} updated company settings` };
    case "membership.granted":
      return { text: `${who} added ${p(ev).name ?? p(ev).email ?? "a person"} as ${p(ev).role}` };
    case "membership.revoked":
      return { text: `${who} removed a ${p(ev).role}` };
    case "department.created":
      return {
        text: `${who} created the ${p(ev).name} department${p(ev).leadName ? `, led by ${p(ev).leadName}` : ""}`,
        go: { view: "org" },
      };
    case "department.updated":
      return { text: `${who} updated ${p(ev).name}`, go: { view: "org" } };
    case "department.deleted":
      return { text: `${who} dissolved ${p(ev).name}`, go: { view: "org" } };
    case "department.member_added":
      return { text: `${who} added ${p(ev).teammateName} to ${p(ev).name}`, go: { view: "org" } };
    case "department.member_removed":
      return { text: `${who} removed ${p(ev).teammateName} from ${p(ev).name}`, go: { view: "org" } };
    case "department.lead_changed":
      return {
        text: p(ev).leadName ? `${p(ev).leadName} now leads ${p(ev).name}` : `${p(ev).name} has no lead`,
        go: { view: "org" },
      };
    case "teammate.created":
      return {
        text: `${who} hired ${p(ev).name} as ${p(ev).role}`,
        go: { view: "team", teammateId: ev.subject?.id },
      };
    case "teammate.updated":
      return { text: `${who} updated ${p(ev).name}`, go: { view: "team", teammateId: ev.subject?.id } };
    case "teammate.deleted":
      return { text: `${who} let ${p(ev).name} go` };
    case "teammate.token_minted":
      return { text: `${who} issued a board token to ${p(ev).name}` };
    case "project.created":
      return { text: `${who} opened project ${p(ev).name}`, go: { view: "board" } };
    case "project.updated":
      return { text: `${who} updated project ${p(ev).name}` };
    case "task.created": {
      const forWhom = p(ev).assignee?.name ? ` for ${p(ev).assignee.name}` : "";
      return { text: `${who} created ${n}${title}${forWhom}`, go: { view: "board", taskId } };
    }
    case "task.updated":
      return { text: `${who} edited ${n}${title}`, go: { view: "board", taskId } };
    case "task.moved":
      if (p(ev).to === "cancelled")
        return {
          text: `${who} cancelled ${n}${p(ev).note ? `: ${p(ev).note}` : ""}`,
          go: { view: "board", taskId },
        };
      if (p(ev).from === "cancelled") return { text: `${who} reopened ${n}`, go: { view: "board", taskId } };
      return { text: `${who} moved ${n} to ${p(ev).toLabel ?? p(ev).to}`, go: { view: "board", taskId } };
    case "task.assigned":
      return {
        text: p(ev).assignee ? `${who} assigned ${n} to ${p(ev).assignee.name}` : `${who} unassigned ${n}`,
        go: { view: "board", taskId },
      };
    case "task.blocked": {
      const b = p(ev).blocker as { code?: string; what?: string } | undefined;
      const attention = b?.code === "approval_required" || b?.code === "waiting_on_person";
      return {
        text: `${n} is blocked: ${b?.what ?? "no reason given"}`,
        attention,
        go: { view: "board", taskId },
      };
    }
    case "task.unblocked":
      return { text: `${n} is unblocked`, go: { view: "board", taskId } };
    case "task.dependency_added":
      return { text: `${who} made ${n} wait on #${p(ev).dependsOn?.number}`, go: { view: "board", taskId } };
    case "task.dependency_removed":
      return { text: `${who} removed a dependency from ${n}`, go: { view: "board", taskId } };
    case "message.posted": {
      const mentions = (p(ev).mentions as { name: string }[] | undefined) ?? [];
      const routed = mentions.length ? ` and mentioned ${mentions.map((m) => m.name).join(", ")}` : "";
      return { text: `${who} wrote on ${n}${routed}`, go: { view: "board", taskId } };
    }
    case "decision.logged": {
      const sure =
        typeof p(ev).confidence === "number" ? ` (${Math.round(p(ev).confidence * 100)}% sure)` : "";
      return { text: `${who} decided on ${n}: ${p(ev).decision}${sure}`, go: { view: "board", taskId } };
    }
    case "task.chased":
      return {
        text: `${who} chased ${p(ev).teammateName ?? "a teammate"} about ${n}`,
        go: { view: "board", taskId },
      };
    case "run.queued":
      if (p(ev).kind === "review")
        return {
          text: `${p(ev).teammateName ?? "A teammate"} is up to review ${n}${title}${p(ev).round > 1 ? ` (round ${p(ev).round})` : ""}`,
          go: { view: "reviews", reviewId: p(ev).reviewId, taskId: p(ev).taskId },
        };
      if (p(ev).kind === "turn")
        return {
          text: `${p(ev).teammateName ?? "A teammate"} got a turn on ${n} to answer ${who}`,
          go: { view: "board", taskId: p(ev).taskId },
        };
      return {
        text: `${who} started ${p(ev).teammateName ?? "a teammate"} on ${n}${title}`,
        go: { view: "board", taskId: p(ev).taskId },
      };
    case "run.started":
      return {
        text: `${p(ev).teammateName ?? "A teammate"} is ${p(ev).kind === "turn" ? "answering" : p(ev).kind === "review" ? "reviewing" : "working"} on ${n}${p(ev).attempt > 1 ? ` (attempt ${p(ev).attempt})` : ""}`,
        go: { view: "board", taskId: p(ev).taskId },
      };
    case "run.interrupted":
      return {
        text: `The worker on ${n} stopped responding; the run will be picked up again`,
        go: { view: "board", taskId: p(ev).taskId },
      };
    case "run.completed":
      if (p(ev).kind === "turn")
        return { text: `${who} answered on ${n}`, go: { view: "board", taskId: p(ev).taskId } };
      if (p(ev).kind === "review")
        return { text: `${who} finished reviewing ${n}`, go: { view: "board", taskId: p(ev).taskId } };
      return {
        text: `${who} finished ${n}${title} · ${Number(p(ev).totalTokens ?? 0).toLocaleString()} tokens`,
        go: { view: "board", taskId: p(ev).taskId },
      };
    case "run.failed":
      return {
        text: `${who} failed on ${n}: ${p(ev).error ?? "no reason given"}`,
        attention: true,
        go: { view: "board", taskId: p(ev).taskId },
      };
    case "run.blocked":
      return {
        text: `${who} is blocked on ${n}: ${p(ev).summary ?? ""}`,
        go: { view: "board", taskId: p(ev).taskId },
      };
    case "run.stopped":
      return { text: `The run on ${n} stopped`, go: { view: "board", taskId: p(ev).taskId } };
    case "run.stop_requested":
      return { text: `${who} asked the run on ${n} to stop`, go: { view: "board", taskId: p(ev).taskId } };
    case "artifact.created":
      return { text: `${who} wrote ${p(ev).path}`, go: { view: "board", taskId: p(ev).taskId } };
    case "review.opened": {
      const reviewId = ev.subject?.id;
      const reviewer = p(ev).reviewer?.name;
      const round = p(ev).round > 1 ? ` (round ${p(ev).round})` : "";
      return {
        text: reviewer
          ? `${p(ev).authorName ?? who} handed ${n}${title} to ${reviewer} for review${round}`
          : `${n}${title} is waiting for your review${round}`,
        attention: !reviewer,
        go: { view: "reviews", reviewId, taskId: p(ev).taskId },
      };
    }
    case "review.reassigned": {
      const to = p(ev).reviewer as { kind: string; id: string; name: string | null } | null;
      const mine = to?.kind === "user" && to.id === meId;
      return {
        text: to
          ? `${who} made ${n}${title} ${mine ? "yours" : `${to.name ?? "someone"}'s`} to review`
          : `${who} cleared the reviewer on ${n}${title}; people decide`,
        attention: mine,
        go: { view: "reviews", reviewId: ev.subject?.id, taskId: p(ev).taskId },
      };
    }
    case "review.needs_person": {
      const files = (p(ev).files as string[] | undefined) ?? [];
      return {
        text:
          p(ev).reason === "unscanned"
            ? `${n}${title} has binary files the secrets check did not read (${files.slice(0, 3).join(", ")}${files.length > 3 ? ", …" : ""}): it waits for a person's approval`
            : `${n}${title} carries binary files a review cannot show (${files.slice(0, 3).join(", ")}${files.length > 3 ? ", …" : ""}): its pull request waits for a person's approval`,
        attention: true,
        go: { view: "reviews", reviewId: ev.subject?.id, taskId: p(ev).taskId },
      };
    }
    case "review.commented":
      return {
        text:
          p(ev).action === "resolved"
            ? `${who} resolved a comment on ${n}`
            : `${who} commented on ${p(ev).file ?? "the diff"} in ${n}: ${p(ev).preview ?? ""}`,
        go: { view: "reviews", reviewId: ev.subject?.id, taskId: p(ev).taskId },
      };
    case "review.scored":
      return {
        text: `${who} scored ${n} at ${Math.round(Number(p(ev).score ?? 0) * 100)}% of its criteria`,
        go: { view: "reviews", reviewId: ev.subject?.id, taskId: p(ev).taskId },
      };
    case "review.changes_requested":
      return {
        text: `${who} requested changes on ${n}${title}${p(ev).openComments ? ` · ${p(ev).openComments} open ${p(ev).openComments === 1 ? "comment" : "comments"}` : ""}`,
        go: { view: "reviews", reviewId: ev.subject?.id, taskId: p(ev).taskId },
      };
    case "review.approved": {
      const overrode = (p(ev).overrodeChecks as { title: string }[] | undefined) ?? [];
      return {
        text: `${who} approved ${n}${title}${overrode.length ? ` over a failed check: ${overrode.map((c) => c.title).join("; ")}` : ""}`,
        go: { view: "reviews", reviewId: ev.subject?.id, taskId: p(ev).taskId },
      };
    }
    case "review.vetoed":
      return {
        text: `${who} vetoed the approval of ${n}: ${p(ev).note ?? ""}`,
        attention: true,
        go: { view: "reviews", reviewId: ev.subject?.id, taskId: p(ev).taskId },
      };
    case "task.done":
      return { text: `${n}${title} is Done`, go: { view: "board", taskId: p(ev).taskId } };
    case "pr.proposed":
      return {
        text: `A ${p(ev).provider === "gitlab" ? "merge request" : "pull request"} for ${n} is proposed to ${p(ev).repo}`,
        go: { view: "reviews", reviewId: p(ev).reviewId, taskId: p(ev).taskId },
      };
    case "pr.opened":
      return {
        text: `${p(ev).provider === "gitlab" ? "Merge request !" : "Pull request #"}${p(ev).prNumber} opened for ${n} on ${p(ev).repo} · merging needs you`,
        attention: true,
        go: { view: "reviews", reviewId: p(ev).reviewId, taskId: p(ev).taskId },
      };
    case "pr.failed":
      return {
        text: `The ${p(ev).provider === "gitlab" ? "merge request" : "pull request"} for ${n} could not be opened: ${p(ev).error ?? "unknown error"}`,
        attention: true,
        go: { view: "reviews", reviewId: p(ev).reviewId, taskId: p(ev).taskId },
      };
    case "pr.closed":
      return {
        text: p(ev).ok
          ? `${p(ev).provider === "gitlab" ? "Merge request !" : "Pull request #"}${p(ev).prNumber} for ${n} was closed after the veto`
          : `${p(ev).provider === "gitlab" ? "Merge request !" : "Pull request #"}${p(ev).prNumber} for ${n} could not be closed: ${p(ev).error ?? "unknown error"}`,
        attention: !p(ev).ok,
        go: { view: "reviews", reviewId: p(ev).reviewId, taskId: p(ev).taskId },
      };
    case "budget.alert":
      return {
        text: `Budget alert: ${p(ev).scopeKind} ${p(ev).scopeName ?? ""} is at ${p(ev).percent}% of ${Number(p(ev).limit ?? 0).toLocaleString()} tokens`,
        attention: true,
      };
    case "teammate.drift":
      return { text: driftLine(p(ev)), attention: true };
    case "user.logged_in":
      return { text: `${who} signed in` };
    // Peter (M4)
    case "goal.created":
      return {
        text: `${who} handed Peter a goal${p(ev).projectName ? ` for ${p(ev).projectName}` : ""}: ${p(ev).title}`,
        go: { view: "company" },
      };
    case "goal.questions": {
      const qs = (p(ev).questions as string[] | undefined)?.length ?? 0;
      return {
        text: `${who} has ${qs} question${qs === 1 ? "" : "s"} before planning ${p(ev).title}`,
        attention: true,
        go: { view: "company" },
      };
    }
    case "goal.answered":
      return { text: `${who} answered Peter's questions on ${p(ev).title}`, go: { view: "company" } };
    case "goal.planned": {
      const tasks = (p(ev).tasks as unknown[] | undefined)?.length ?? 0;
      const names = (p(ev).assignees as string[] | undefined) ?? [];
      return {
        text: `${who} split ${p(ev).title} into ${tasks} task${tasks === 1 ? "" : "s"}${names.length ? ` for ${names.join(", ")}` : ""}`,
        go: { view: "board", projectId: p(ev).projectId },
      };
    }
    case "goal.escalated":
      return {
        text: `${who} needs you on ${p(ev).title}: ${p(ev).reason ?? ""}`,
        attention: true,
        go: { view: "company" },
      };
    case "goal.resumed":
      return {
        text: `${who} carried on with ${p(ev).title}`,
        go: { view: "board", projectId: p(ev).projectId },
      };
    case "goal.done":
      return {
        text: `${p(ev).title} is done · ${Number(p(ev).spend?.totalTokens ?? 0).toLocaleString()} tokens`,
        go: { view: "board", projectId: p(ev).projectId },
      };
    case "goal.stopped": {
      const stopped = ((p(ev).runsStopped ?? []) as number[]).length;
      const asked = ((p(ev).runsAsked ?? []) as number[]).length;
      const tail = [
        stopped ? `${stopped} waiting run${stopped === 1 ? "" : "s"} stopped` : "",
        asked ? `${asked} live run${asked === 1 ? "" : "s"} asked to stop` : "",
      ]
        .filter(Boolean)
        .join(", ");
      return {
        text: `${who} dropped the goal ${p(ev).title}${tail ? ` · ${tail}` : ""}`,
        go: { view: "company" },
      };
    }
    case "goal.caps_changed": {
      const after = (p(ev).after ?? {}) as { maxTasks?: number; maxDepth?: number; tokens?: number | null };
      const changed = ((p(ev).changed ?? []) as string[]).map((k) =>
        k === "maxTasks"
          ? `${after.maxTasks} tasks`
          : k === "maxDepth"
            ? `follow-ups ${after.maxDepth} deep`
            : after.tokens
              ? `${Number(after.tokens).toLocaleString()} tokens`
              : "no token cap",
      );
      return {
        text: `${who} set the caps on ${p(ev).title}: ${changed.join(", ")}`,
        go: { view: "company" },
      };
    }
    case "task.replanned":
      return {
        text: `${who} re-planned ${n} after a failed run (attempt ${Number(p(ev).replans ?? 0) + 1})`,
        go: { view: "board", taskId },
      };
    case "draft.proposed":
      return p(ev).kind === "audit"
        ? {
            text: `${who} audited the company: ${p(ev).summary ?? ""}`,
            attention: true,
            go: { view: "company" },
          }
        : {
            text: `${who} proposes ${((p(ev).departments as { name: string }[] | undefined) ?? []).map((d) => d.name).join(", ") || "an org change"}; accept it on the Company page`,
            attention: true,
            go: { view: "company" },
          };
    case "draft.accepted":
      return p(ev).kind === "audit"
        ? { text: `${who} noted Peter's audit`, go: { view: "company" } }
        : {
            text: `${who} accepted Peter's draft: ${p(ev).departments} department${p(ev).departments === 1 ? "" : "s"}, ${p(ev).teammates} teammate${p(ev).teammates === 1 ? "" : "s"}`,
            go: { view: "org" },
          };
    case "draft.rejected":
      return {
        text: `${who} declined Peter's ${p(ev).kind === "audit" ? "audit" : "draft"}`,
        go: { view: "company" },
      };
    // Governed tools (M5)
    case "approval.proposed":
      return {
        text: `${who} asks approval to ${lowerFirst(String(p(ev).title ?? "write to a live system"))} (${p(ev).connection} · ${p(ev).tool}) for ${n}`,
        attention: true,
        go: { view: "approvals", approvalId: ev.subject?.id, taskId },
      };
    case "approval.approved":
      return {
        text: `${who} approved ${lowerFirst(String(p(ev).title ?? "the write"))} on ${n}`,
        go: { view: "approvals", approvalId: ev.subject?.id, taskId },
      };
    case "approval.executed":
      return {
        text: `${p(ev).connection} · ${p(ev).tool} executed for ${n}: ${p(ev).title ?? ""}`,
        go: { view: "approvals", approvalId: ev.subject?.id, taskId },
      };
    case "approval.failed":
      return {
        text: `The approved write on ${n} could not be sent: ${p(ev).error ?? "unknown error"}`,
        attention: true,
        go: { view: "approvals", approvalId: ev.subject?.id, taskId },
      };
    case "approval.superseded":
      return {
        text: `${p(ev).teammateName ?? "A teammate"} replaced ${lowerFirst(String(p(ev).title ?? "a proposal"))} on ${n} with a newer proposal${p(ev).byTitle ? `: ${p(ev).byTitle}` : ""}`,
        go: { view: "approvals", approvalId: p(ev).by ?? ev.subject?.id, taskId },
      };
    case "approval.rejected":
      return {
        text: `${who} rejected ${lowerFirst(String(p(ev).title ?? "the write"))} on ${n}${p(ev).note ? `: ${p(ev).note}` : ""}`,
        go: { view: "approvals", approvalId: ev.subject?.id, taskId },
      };
    case "connection.created":
      return {
        text:
          p(ev).kind === "web"
            ? `${who} added the web connection ${p(ev).name}: the board reads the web for the teammates granted it`
            : `${who} connected ${p(ev).name} (${p(ev).kind === "openapi" ? "OpenAPI" : "MCP"})`,
      };
    case "connection.updated": {
      const n = p(ev).discovered as number | undefined;
      const flipped = (p(ev).reclassified as string[] | undefined) ?? [];
      // Tools only the server calls read-only: held as writes at discovery, and a person's word that they read.
      const held = ((p(ev).unconfirmed as string[] | undefined) ?? []).length;
      const confirmed = (p(ev).confirmed as string[] | undefined) ?? [];
      // The web connection's list of sites changed: say what it reads now.
      if ("domains" in p(ev))
        return {
          text: `${who} set the sites ${p(ev).name} reads: ${domainsPhrase((p(ev).domains as string[] | null) ?? null)}`,
        };
      return {
        text:
          n !== undefined
            ? `${who} discovered ${n} tool${n === 1 ? "" : "s"} on ${p(ev).name} · ${((p(ev).writes as string[]) ?? []).length} write${held ? ` · ${held} to confirm as read${held === 1 ? "" : "s"}` : ""}`
            : confirmed.length && confirmed.length === flipped.length
              ? `${who} confirmed ${confirmed.join(", ")} on ${p(ev).name} as ${confirmed.length === 1 ? "a read" : "reads"}`
              : flipped.length
                ? `${who} reclassified ${flipped.join(", ")} on ${p(ev).name}`
                : `${who} changed the connection ${p(ev).name}${p(ev).enabled === false ? " · switched off" : ""}`,
      };
    }
    case "connection.deleted":
      return { text: `${who} removed the connection ${p(ev).name}` };
    case "secret.set":
      return { text: `${who} ${p(ev).replaced ? "replaced" : "set"} the value of ${p(ev).name}` };
    case "secret.deleted":
      return { text: `${who} removed the value of ${p(ev).name}` };
    case "model_provider.created":
      return { text: `${who} added the model provider ${p(ev).label ?? p(ev).name}` };
    case "model_provider.updated": {
      const changes = (p(ev).changes as string[] | undefined) ?? [];
      const what = p(ev).label ?? p(ev).name;
      if (changes.includes("archived") && p(ev).archived === false)
        return { text: `${who} brought back the model provider ${what}` };
      if (changes.length === 1 && changes[0] === "enabled")
        return { text: `${who} switched the model provider ${what} ${p(ev).enabled ? "on" : "off"}` };
      return { text: `${who} changed the model provider ${what}` };
    }
    case "model_provider.archived":
      return { text: `${who} archived the model provider ${p(ev).label ?? p(ev).name}` };
    case "model_provider.deleted":
      return { text: `${who} removed the model provider ${p(ev).label ?? p(ev).name}` };
    case "connection.checked": {
      const extra = ((p(ev).extra as string[] | undefined) ?? []).length;
      const missing = ((p(ev).missing as string[] | undefined) ?? []).length;
      const drift = [extra ? `${extra} new` : "", missing ? `${missing} gone` : ""]
        .filter(Boolean)
        .join(", ");
      return {
        text: p(ev).ok
          ? p(ev).kind === "web"
            ? `${who} checked ${p(ev).name}: the board reads the web`
            : `${who} checked ${p(ev).name}: answered in ${p(ev).latencyMs} ms${drift ? ` · ${drift}` : ""}`
          : `${who} checked ${p(ev).name}: ${p(ev).error ?? "no answer"}`,
        attention: !p(ev).ok,
      };
    }
    case "notify.sent":
      return {
        text:
          p(ev).type === "notify.test"
            ? `${who} sent a test notification through ${p(ev).target}`
            : `A needs-you notification went out through ${p(ev).target}`,
      };
    case "tool.called":
      // The web connection's record names the page: where, the status and the size, never what it says.
      if (typeof p(ev).url === "string")
        return {
          text:
            p(ev).ok === false
              ? `${who} could not read ${p(ev).url} for ${n}: ${p(ev).note ?? p(ev).error ?? "no answer"}`
              : `${who} read ${p(ev).url} for ${n} · ${p(ev).status} · ${byteSize(Number(p(ev).bytes ?? 0))}`,
          go: { view: "board", taskId: p(ev).taskId },
        };
      return {
        text: `${who} read ${p(ev).connection} · ${p(ev).tool} for ${n}${p(ev).ok === false ? ` · failed: ${p(ev).error ?? ""}` : ""}`,
        go: { view: "board", taskId: p(ev).taskId },
      };
    default:
      return { text: `${who}: ${ev.type}` };
  }
}

/** "3.00" → 300 minor units; blank → null. */
export function toMinor(major: string): number | null {
  const t = major.trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** A size in bytes as people read it: 812 B, 34 KB, 1.2 MB. */
export function byteSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function lowerFirst(s: string): string {
  return s ? s[0]!.toLowerCase() + s.slice(1) : s;
}
