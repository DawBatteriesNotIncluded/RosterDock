// Approvals: every proposed write to a live system, per company, as the
// prototype draws it. Each card is the exact action a teammate wants to take,
// bound to a sha256 so the approved bytes are the executed bytes. Approve sends
// them and the teammate continues; reject leaves a note and Peter re-plans.
// Pending cards first; decided ones fade with their outcome.
import { useState } from "react";
// The text helpers alone, not the package's index: that carries zod and node:crypto into the bundle.
import { asSentence } from "@rosterdock/shared/text";
import type { Approval, CompanyData } from "../api/types.ts";
import { Avatar, Button, Empty, Pill, Topbar } from "../components/ui.tsx";
import { cn } from "../lib/cn.ts";
import { relativeTime } from "../lib/format.ts";

export interface ApprovalsViewProps {
  data: CompanyData;
  /** Owners and admins decide. */
  canDecide: boolean;
  onApprove(id: string, note?: string): Promise<void>;
  onReject(id: string, note?: string): Promise<void>;
  onOpenTask(taskId: string): void;
}

export const APPROVAL_LABEL: Record<Approval["status"], string> = {
  pending: "Waiting on you",
  approved: "Approved · sending",
  executed: "Approved · executed",
  failed: "Approved · failed",
  rejected: "Rejected",
  superseded: "Replaced",
};

export function approvalTone(status: Approval["status"]): "warn" | "ok" | "bad" | "info" | "muted" {
  if (status === "superseded") return "muted";
  return status === "pending"
    ? "warn"
    : status === "executed"
      ? "ok"
      : status === "approved"
        ? "info"
        : "bad";
}

/** Pending first, then newest first. */
export function sortApprovals(list: Approval[]): Approval[] {
  return [...list].sort(
    (a, b) =>
      Number(b.status === "pending") - Number(a.status === "pending") ||
      b.createdAt.localeCompare(a.createdAt),
  );
}

export function ApprovalCard({
  a,
  data,
  canDecide,
  onApprove,
  onReject,
  onOpenTask,
}: { a: Approval } & Omit<ApprovalsViewProps, "data"> & { data: CompanyData }) {
  const [note, setNote] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const mate = a.teammate ? data.teammates.find((t) => t.id === a.teammate!.id) : null;
  const name = mate?.name ?? a.teammate?.name ?? "a teammate";
  const handle = mate?.handle ?? a.teammate?.handle ?? name;
  const dept = a.departmentId ? data.departments.find((d) => d.id === a.departmentId) : null;
  const project = a.projectId ? data.projects.find((p) => p.id === a.projectId) : null;
  const pending = a.status === "pending";
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cn("card approval", !pending && "decided")}>
      <div className="row">
        <div className="flex items-center gap-2.5">
          <Avatar name={name} handle={handle} size="l" />
          <div className="flex flex-col gap-0.5">
            <span className="text-[15px] font-semibold">{a.title}</span>
            <span className="text-[12px] text-muted">
              {name}
              {mate ? ` · ${mate.role}` : ""}
              {dept ? ` · ${dept.name}` : ""}
              {project ? ` · ${project.name}` : ""} · from{" "}
              <button className="link" onClick={() => onOpenTask(a.taskId)}>
                #{a.taskNumber} {a.taskTitle}
              </button>
              {" · "}
              {relativeTime(a.createdAt)}
            </span>
          </div>
        </div>
        <Pill tone={approvalTone(a.status)}>{APPROVAL_LABEL[a.status]}</Pill>
      </div>
      {a.why ? (
        <div className="why">
          <b className="font-semibold">Why:</b> {a.why}
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <span className="eyebrow">
          Exact action ·{" "}
          <span className="mono" style={{ textTransform: "none", letterSpacing: 0 }}>
            {a.connection} · {a.tool}
          </span>
        </span>
        <pre className="action-json">{JSON.stringify(a.payload, null, 2)}</pre>
        <span className="mono text-[11px] text-muted">
          sha256 {a.payloadSha256.slice(0, 12)}… · credentials by name only, never shown
        </span>
      </div>
      {pending && canDecide ? (
        <div className="flex flex-col gap-2">
          {rejecting ? (
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why not, in a sentence. The teammate reads this and re-plans."
              style={{ minHeight: 60 }}
            />
          ) : null}
          <div className="acts">
            {rejecting ? (
              <>
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => void act(() => onReject(a.id, note.trim() || undefined))}
                >
                  Reject with this note
                </Button>
                <Button disabled={busy} onClick={() => setRejecting(false)}>
                  Back
                </Button>
              </>
            ) : (
              <>
                <Button variant="accent" disabled={busy} onClick={() => void act(() => onApprove(a.id))}>
                  Approve and run
                </Button>
                <Button variant="danger" disabled={busy} onClick={() => setRejecting(true)}>
                  Reject
                </Button>
                <Button disabled={busy} onClick={() => onOpenTask(a.taskId)}>
                  Ask a question first
                </Button>
              </>
            )}
          </div>
        </div>
      ) : pending ? (
        <span className="text-[12px] text-muted">An owner or admin decides this.</span>
      ) : (
        <span className="text-[12px] text-muted">
          {a.status === "superseded"
            ? `Replaced by a newer proposal of the same write${a.target ? ` (${a.target})` : ""} before anyone decided it. Nothing was sent; decide the newer one.`
            : a.status === "rejected"
              ? `${asSentence(`Rejected${a.decidedAt ? ` ${relativeTime(a.decidedAt)}` : ""}${a.note ? `: ${a.note}` : ""}`)} Nothing was sent; Peter re-plans the task.`
              : a.status === "failed"
                ? asSentence(
                    `Approved${a.note ? ` (${a.note})` : ""}, but the send failed: ${a.error ?? "no reason recorded"}`,
                  )
                : a.status === "executed"
                  ? `Approved${a.note ? ` (${a.note})` : ""} and executed${a.executedAt ? ` ${relativeTime(a.executedAt)}` : ""}; ${name} continues with the answer in their pack.`
                  : "Approved; sending."}
        </span>
      )}
    </div>
  );
}

export function ApprovalsView(p: ApprovalsViewProps) {
  const list = sortApprovals(p.data.approvals);
  const pending = list.filter((a) => a.status === "pending").length;
  return (
    <>
      <Topbar
        title="Approvals"
        subtitle={`${p.data.company.name} · ${pending ? `${pending} waiting · ` : ""}actions that touch a live system wait here for you`}
      />
      <div className="content">
        <div className="approvals scroll">
          <p className="m-0 max-w-[64ch] text-[13px] leading-relaxed text-muted">
            Each card is the exact action a teammate wants to take, bound to a hash so the approved bytes are
            the executed bytes. Credentials are named, never shown. Reject sends the teammate back with your
            note; nothing reaches the live system.
          </p>
          {list.map((a) => (
            <ApprovalCard
              key={a.id}
              a={a}
              data={p.data}
              canDecide={p.canDecide}
              onApprove={p.onApprove}
              onReject={p.onReject}
              onOpenTask={p.onOpenTask}
            />
          ))}
          {list.length === 0 ? (
            <Empty>
              Nothing waits for you. A card appears here when a teammate proposes a write to a live system.
            </Empty>
          ) : null}
        </div>
      </div>
    </>
  );
}
