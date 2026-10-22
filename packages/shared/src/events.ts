// The one event stream. Types shared by the board (which appends to the
// `events` table) and the web (which projects Activity, Office and Map from
// it), plus the pure fan-out and replay-then-live helpers carried over from
// the v1 prototype's audit log and its SSE route.

import type { ActorRef } from "./roles.js";

export const EVENT_TYPES = [
  "company.created",
  "company.updated",
  "membership.granted",
  "membership.revoked",
  "department.created",
  "department.updated",
  "department.deleted",
  "department.member_added",
  "department.member_removed",
  "department.lead_changed",
  "teammate.created",
  "teammate.updated",
  "teammate.deleted",
  "teammate.token_minted",
  "project.created",
  "project.updated",
  "task.created",
  "task.updated",
  "task.moved",
  "task.assigned",
  "task.blocked",
  "task.unblocked",
  "task.dependency_added",
  "task.dependency_removed",
  "task.chased",
  "message.posted",
  "user.logged_in",
  "run.queued",
  "run.started",
  "run.interrupted",
  "run.completed",
  "run.failed",
  "run.stopped",
  "run.blocked",
  "run.stop_requested",
  "artifact.created",
  "budget.alert",
  "decision.logged",
  "review.opened",
  "review.commented",
  "review.scored",
  "review.changes_requested",
  "review.approved",
  "review.vetoed",
  "review.reassigned",
  "task.done",
  "pr.proposed",
  "pr.opened",
  "pr.failed",
  "pr.closed",
  // Peter (M4)
  "goal.created",
  "goal.questions",
  "goal.answered",
  "goal.planned",
  "goal.escalated",
  "goal.resumed",
  "goal.done",
  "goal.stopped",
  "goal.caps_changed",
  "task.replanned",
  "draft.proposed",
  "draft.accepted",
  "draft.rejected",
  // Governed tools (M5)
  "approval.proposed",
  "approval.approved",
  "approval.rejected",
  "approval.executed",
  "approval.failed",
  "approval.superseded",
  "connection.created",
  "connection.updated",
  "connection.deleted",
  "connection.checked",
  // Company secrets: a value set from Settings into the board's secret store; the payload carries the name only.
  "secret.set",
  "secret.deleted",
  "tool.called",
  "notify.sent",
  // Deployable (M6)
  "teammate.drift",
  // Company model providers: the payload carries names only, never a value.
  "model_provider.created",
  "model_provider.updated",
  "model_provider.archived",
  "model_provider.deleted",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface SubjectRef {
  kind:
    | "company"
    | "department"
    | "teammate"
    | "project"
    | "task"
    | "message"
    | "user"
    | "membership"
    | "run"
    | "artifact"
    | "budget"
    | "review"
    | "pull_request"
    | "goal"
    | "draft"
    | "approval"
    | "connection"
    | "model_provider";
  id: string;
}

export interface EventRecord {
  id: string;
  companyId: string;
  /** Per-company monotonic sequence. SSE clients resume with Last-Event-ID = seq. */
  seq: number;
  type: EventType;
  actor: ActorRef | null;
  subject: SubjectRef | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && (EVENT_TYPES as readonly string[]).includes(value);
}

type Listener<T> = (event: T) => void;

export interface Fanout<T> {
  subscribe(listener: Listener<T>): () => void;
  publish(event: T): void;
  readonly size: number;
}

/**
 * In-process fan-out for live tails. Listeners are isolated: a throwing
 * subscriber never breaks publication to the others, and never breaks the
 * caller (the append that already happened stays durable).
 */
export function createFanout<T>(): Fanout<T> {
  const listeners = new Set<Listener<T>>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(event) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // Subscriber errors are the subscriber's problem.
        }
      }
    },
    get size() {
      return listeners.size;
    },
  };
}

export interface TailOptions<T extends { seq: number }> {
  fanout: Fanout<T>;
  /** Oldest-first backlog to replay before going live. */
  readBacklog: () => Promise<T[]>;
  /** Return false to signal backpressure; the tail stops and calls onStall. */
  write: (event: T) => boolean | void;
  filter?: (event: T) => boolean;
  onStall?: () => void;
}

/**
 * Replay a backlog, then go live, with no gap and no duplicate.
 *
 * Subscribes BEFORE the backlog read and buffers live rows until the backlog
 * is flushed; otherwise rows appended during the await would slip between
 * replay and the live tail. Seq dedupes the overlap. Returns the unsubscribe.
 */
export async function tailFrom<T extends { seq: number }>(opts: TailOptions<T>): Promise<() => void> {
  const matches = opts.filter ?? (() => true);
  let lastWritten = -Infinity;
  let stalled = false;

  const emit = (event: T): void => {
    if (stalled) return;
    if (event.seq <= lastWritten) return;
    lastWritten = event.seq;
    const ok = opts.write(event);
    if (ok === false) {
      stalled = true;
      unsubscribe();
      opts.onStall?.();
    }
  };

  const buffered: T[] = [];
  let backlogDone = false;
  const unsubscribe = opts.fanout.subscribe((event) => {
    if (!matches(event)) return;
    if (!backlogDone) {
      buffered.push(event);
      return;
    }
    emit(event);
  });

  const backlog = await opts.readBacklog();
  for (const event of backlog) {
    if (matches(event)) emit(event);
  }
  for (const event of buffered) emit(event);
  backlogDone = true;
  return unsubscribe;
}
