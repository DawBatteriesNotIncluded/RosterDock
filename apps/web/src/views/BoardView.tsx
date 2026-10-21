import type { MoveTaskInput } from "@rosterdock/shared";
import { MessageSquare, Plus, Send, X } from "lucide-react";
import { useEffect, useState, type DragEvent, type FormEvent } from "react";
import type {
  ActorRef,
  Artifact,
  CompanyData,
  Message,
  Run,
  RunDetail,
  Task,
  TaskDeliverable,
  TaskStatus,
} from "../api/types.ts";
import { Avatar, Button, Dot, Segs, Topbar } from "../components/ui.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.tsx";
import { cn } from "../lib/cn.ts";
import { actorInfo, blockerLine, isOpenTask, relativeTime, STATUS_LABEL } from "../lib/format.ts";
import { ApprovalCard, sortApprovals } from "./ApprovalsView.tsx";
import { OutputsPanel, RunPanel } from "./RunPanel.tsx";

export interface BoardViewProps {
  data: CompanyData;
  meId?: string;
  projectId: string | "all";
  departmentId: string | "all";
  selectedTaskId: string | null;
  onFilterProject(id: string | "all"): void;
  onFilterDepartment(id: string | "all"): void;
  onSelectTask(id: string | null): void;
  onNewTask(): void;
  onMove(taskId: string, input: MoveTaskInput): Promise<void>;
  onRefuseDone(taskId: string): void;
  onOpenReview(taskId: string): void;
  onAssign(taskId: string, assignee: ActorRef | null): Promise<void>;
  onSetDepartment(taskId: string, departmentId: string | null): Promise<void>;
  loadMessages(taskId: string): Promise<Message[]>;
  onPostMessage(taskId: string, body: string): Promise<void>;
  loadRuns(taskId: string): Promise<Run[]>;
  loadRun(runId: string): Promise<RunDetail>;
  loadArtifacts(taskId: string): Promise<Artifact[]>;
  loadArtifact(runId: string, artifactId: string): Promise<Artifact>;
  /** The ticket's deliverable, and a link to save any file. */
  loadDeliverable?(taskId: string): Promise<TaskDeliverable>;
  downloadUrl?(runId: string, artifactId: string): string;
  onStartRun(taskId: string): Promise<void>;
  onStopRun(runId: string): Promise<void>;
  /** Owners and admins decide the task's proposed writes from the drawer; everyone sees them. */
  canDecide?: boolean;
  onApprove?(approvalId: string, note?: string): Promise<void>;
  onReject?(approvalId: string, note?: string): Promise<void>;
  /** Owners and admins close a task that will not be done, and reopen it. */
  canCancel?: boolean;
  onCancel?(taskId: string, note?: string): Promise<void>;
  onReopen?(taskId: string): Promise<void>;
}

const COLUMNS: [TaskStatus, string][] = [
  ["todo", "To do"],
  ["doing", "In progress"],
  ["blocked", "Blocked"],
  ["review", "In review"],
  ["done", "Done"],
];

const CANCEL_HINT =
  "It closes without being Done: a run on it stops and nobody picks it up. You can reopen it.";

function StatusLine({ t, data }: { t: Task; data: CompanyData }) {
  const review = data.reviews?.find((r) => r.taskId === t.id);
  if (t.status === "doing" && review?.status === "changes_requested")
    return (
      <span className="status warn">
        <Dot tone="warn" />
        Reworking after review
      </span>
    );
  if (t.status === "doing")
    return (
      <span className="status">
        <Dot tone="ok" />
        Running
      </span>
    );
  if (t.status === "blocked")
    return (
      <span className={cn("status", t.blocker?.code === "approval_required" ? "warn" : "bad")}>
        <Dot tone={t.blocker?.code === "approval_required" ? "warn" : "bad"} />
        {blockerLine(t)}
      </span>
    );
  if (t.status === "review") {
    if (review?.status === "changes_requested")
      return (
        <span className="status warn">
          <Dot tone="warn" />
          Changes requested
        </span>
      );
    const reviewer = review?.reviewer?.name;
    return (
      <span className="status info">
        <Dot tone="info" />
        {reviewer ? `${reviewer} reviewing` : review ? "Needs your review" : "Awaiting review"}
      </span>
    );
  }
  return null;
}

function TaskCard({
  t,
  data,
  selected,
  meId,
  onSelect,
  onDragStart,
}: {
  t: Task;
  data: CompanyData;
  selected: boolean;
  meId?: string;
  onSelect(): void;
  onDragStart(e: DragEvent): void;
}) {
  const done = t.status === "done";
  const assignee = actorInfo(data, t.assignee, meId);
  const creator = actorInfo(data, t.createdBy, meId);
  return (
    <button
      className={cn("tcard", done && "done", t.status === "blocked" && "blocked", selected && "selected")}
      draggable={!done}
      onDragStart={onDragStart}
      onClick={onSelect}
      data-task={t.id}
    >
      <span className="t">{t.title}</span>
      {!done && assignee ? (
        <span className="who">
          <Avatar name={assignee.name} handle={assignee.handle} size="s" you={assignee.isYou} />
          <span>
            {assignee.name}
            {assignee.role ? ` · ${assignee.role}` : ""}
          </span>
        </span>
      ) : null}
      {!done && !assignee ? <span className="who text-muted">Unassigned</span> : null}
      <StatusLine t={t} data={data} />
      <span className="foot">
        <span>
          {done ? (
            "Done"
          ) : t.messageCount ? (
            <span className="inline-flex items-center gap-1">
              <MessageSquare size={12} />
              {t.messageCount}
            </span>
          ) : (
            `Created by ${creator?.name ?? "someone"}`
          )}
        </span>
        <span className="mono">#{t.number}</span>
      </span>
    </button>
  );
}

function renderBody(body: string) {
  const parts = body.split(/(@[a-z0-9_-]+)/gi);
  return parts.map((part, i) =>
    /^@[a-z0-9_-]+$/i.test(part) ? (
      <span key={i} className="mention">
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function Drawer({
  t,
  data,
  meId,
  onClose,
  onMove,
  onRefuseDone,
  onOpenReview,
  onAssign,
  onSetDepartment,
  loadMessages,
  onPostMessage,
  loadRuns,
  loadRun,
  loadArtifacts,
  loadArtifact,
  loadDeliverable,
  downloadUrl,
  onStartRun,
  onStopRun,
  canDecide,
  onApprove,
  onReject,
  canCancel,
  onCancel,
  onReopen,
}: { t: Task } & Pick<
  BoardViewProps,
  | "data"
  | "meId"
  | "onMove"
  | "onRefuseDone"
  | "onOpenReview"
  | "onAssign"
  | "onSetDepartment"
  | "loadMessages"
  | "onPostMessage"
  | "loadRuns"
  | "loadRun"
  | "loadArtifacts"
  | "loadArtifact"
  | "loadDeliverable"
  | "downloadUrl"
  | "onStartRun"
  | "onStopRun"
  | "canDecide"
  | "onApprove"
  | "onReject"
  | "canCancel"
  | "onCancel"
  | "onReopen"
> & { onClose(): void }) {
  const [tab, setTab] = useState<DrawerTab>(t.activeRunId ? "run" : "conv");
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [blockReason, setBlockReason] = useState("");
  const [cancelNote, setCancelNote] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void loadMessages(t.id).then((m) => alive && setMessages(m));
    return () => {
      alive = false;
    };
  }, [t.id, t.messageCount, loadMessages]);

  const project = data.projects.find((p) => p.id === t.projectId);
  const dept = data.departments.find((d) => d.id === t.departmentId);
  const assignee = actorInfo(data, t.assignee, meId);
  const creator = actorInfo(data, t.createdBy, meId);
  const deps = t.dependsOn.map((id) => data.tasks.find((x) => x.id === id)).filter((x): x is Task => !!x);
  // The task's proposed writes: every pending one, and the last few decided.
  const allApprovals = sortApprovals((data.approvals ?? []).filter((a) => a.taskId === t.id));
  const pendingApprovals = allApprovals.filter((a) => a.status === "pending");
  const approvals = [...pendingApprovals, ...allApprovals.filter((a) => a.status !== "pending").slice(0, 3)];

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    try {
      await onPostMessage(t.id, body);
      setDraft("");
      setMessages(await loadMessages(t.id));
    } finally {
      setBusy(false);
    }
  };

  const assigneeValue = t.assignee ? `${t.assignee.kind}:${t.assignee.id}` : "";
  const cancellable =
    !!canCancel && !!onCancel && (t.status === "todo" || t.status === "doing" || t.status === "blocked");
  return (
    <aside className="drawer">
      <div className="drawer-h">
        <div className="row">
          <span className="mono text-[12px] text-muted">
            #{t.number} · {project?.name ?? "project"}
            {dept ? ` · ${dept.name}` : ""}
          </span>
          <button className="text-muted hover:text-ink" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="drawer-title">{t.title}</div>
        <div className="flex flex-wrap items-center gap-2">
          {/* A cancelled task says so here and is reopened from Details, not moved. Owners and admins
              cancel from here too: a task nobody will finish need not sit Blocked. */}
          <select
            className="select"
            value={t.status}
            disabled={t.status === "cancelled"}
            onChange={(e) => {
              const next = e.target.value as TaskStatus;
              if (next === "cancelled") {
                if (cancellable && window.confirm(`Cancel #${t.number}? ${CANCEL_HINT}`)) void onCancel(t.id);
                return;
              }
              if (next === "done") return onRefuseDone(t.id);
              void onMove(t.id, { status: next as MoveTaskInput["status"] });
            }}
          >
            {t.status === "cancelled" ? <option value="cancelled">{STATUS_LABEL.cancelled}</option> : null}
            {COLUMNS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
            {cancellable ? <option value="cancelled">{STATUS_LABEL.cancelled}</option> : null}
          </select>
          <select
            className="select"
            value={assigneeValue}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) return void onAssign(t.id, null);
              const [kind, id] = v.split(":") as ["user" | "teammate", string];
              void onAssign(t.id, { kind, id });
            }}
          >
            <option value="">Unassigned</option>
            <optgroup label="Teammates">
              {data.teammates.map((m) => (
                <option key={m.id} value={`teammate:${m.id}`}>
                  {m.name} · {m.role}
                </option>
              ))}
            </optgroup>
            <optgroup label="People">
              {data.members.map((m) => (
                <option key={m.userId} value={`user:${m.userId}`}>
                  {m.name}
                </option>
              ))}
            </optgroup>
          </select>
          <select
            className="select"
            value={t.departmentId ?? ""}
            onChange={(e) => void onSetDepartment(t.id, e.target.value || null)}
          >
            <option value="">No department</option>
            {data.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
        {t.status === "blocked" && t.blocker ? (
          <div className="blockbox">
            <b>{t.blocker.what}</b>
            <span>{t.blocker.why}</span>
            {t.blocker.resolution ? <span className="text-[12px]">{t.blocker.resolution}</span> : null}
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void onMove(t.id, { status: "todo" })}>
                Unblock
              </Button>
            </div>
          </div>
        ) : null}
        {approvals.length ? (
          <div className="flex flex-col gap-2">
            <span className="eyebrow">
              Approvals ·{" "}
              {pendingApprovals.length
                ? `${pendingApprovals.length} waiting for ${canDecide ? "you" : "an owner"}`
                : `${approvals.length} decided`}
            </span>
            {approvals.map((a) => (
              <ApprovalCard
                key={a.id}
                a={a}
                data={data}
                canDecide={!!canDecide && !!onApprove && !!onReject}
                onApprove={onApprove ?? (async () => {})}
                onReject={onReject ?? (async () => {})}
                onOpenTask={() => setTab("conv")}
              />
            ))}
          </div>
        ) : null}
      </div>
      <Tabs
        className="contents"
        value={tab}
        onValueChange={(v) => {
          if (v === "review") onOpenReview(t.id);
          else setTab(v as DrawerTab);
        }}
      >
        <TabsList>
          <TabsTrigger value="conv">Conversation{messages.length ? ` · ${messages.length}` : ""}</TabsTrigger>
          <TabsTrigger value="run">Run{t.activeRunId ? " · live" : ""}</TabsTrigger>
          <TabsTrigger value="outputs">Outputs</TabsTrigger>
          {data.reviews?.some((r) => r.taskId === t.id) ? (
            <TabsTrigger value="review">Review ↗</TabsTrigger>
          ) : null}
          <TabsTrigger value="details">Details</TabsTrigger>
        </TabsList>
        <TabsContent value={tab}>
          {tab === "run" ? (
            <RunPanel
              task={t}
              assigneeIsTeammate={t.assignee?.kind === "teammate"}
              assigneeName={assignee?.name ?? null}
              teammateName={(id) => data.teammates.find((m) => m.id === id)?.name ?? null}
              loadRuns={loadRuns}
              loadRun={loadRun}
              onStart={onStartRun}
              onStop={onStopRun}
            />
          ) : tab === "outputs" ? (
            <OutputsPanel
              task={t}
              loadArtifacts={loadArtifacts}
              loadArtifact={loadArtifact}
              {...(loadDeliverable ? { loadDeliverable } : {})}
              {...(downloadUrl ? { downloadUrl } : {})}
            />
          ) : tab === "conv" ? (
            <>
              <div className="thread">
                {messages.map((m) => {
                  const a = actorInfo(data, m.author, meId);
                  return (
                    <div key={m.id} className="msg">
                      <Avatar
                        name={a?.name ?? m.author.name ?? "?"}
                        handle={a?.handle}
                        size="m"
                        you={a?.isYou}
                      />
                      <div className="body">
                        <div className="hd">
                          <b>{a?.name ?? m.author.name ?? "someone"}</b>
                          <span>{relativeTime(m.createdAt)}</span>
                        </div>
                        <p>{renderBody(m.body)}</p>
                        {m.mentions.length ? (
                          <div className="event">
                            Routed to <b>{m.mentions.map((x) => x.name).join(", ")}</b>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
                {messages.length === 0 ? (
                  <div className="hint">
                    No messages yet. Write to the assignee, or @mention a teammate to route it to them.
                  </div>
                ) : null}
              </div>
              <form className="composer" onSubmit={send}>
                <div className="composer-box">
                  <input
                    id="msgInput"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="Write to the team. @name routes it."
                    disabled={busy}
                  />
                  <button type="submit" className="send" aria-label="Send" disabled={busy}>
                    <Send size={14} />
                  </button>
                </div>
                <span className="hint">
                  @mention a teammate by handle:{" "}
                  {data.teammates
                    .slice(0, 4)
                    .map((m) => `@${m.handle}`)
                    .join(" ")}
                  {data.teammates.length > 4 ? " …" : ""}
                </span>
              </form>
            </>
          ) : (
            <div className="thread">
              <dl className="kv">
                <dt>Created by</dt>
                <dd>{creator?.name ?? "someone"}</dd>
                <dt>Assignee</dt>
                <dd>{assignee?.name ?? "Unassigned"}</dd>
                <dt>Project</dt>
                <dd>{project?.name ?? "—"}</dd>
                <dt>Department</dt>
                <dd>{dept?.name ?? "None"}</dd>
                <dt>Status</dt>
                <dd>{STATUS_LABEL[t.status]}</dd>
                <dt>Created</dt>
                <dd>{relativeTime(t.createdAt)}</dd>
                <dt>Depends on</dt>
                <dd>{deps.length ? deps.map((d) => `#${d.number} ${d.title}`).join(", ") : "Nothing"}</dd>
              </dl>
              {t.description ? (
                <p className="text-[13px] leading-relaxed whitespace-pre-wrap">{t.description}</p>
              ) : null}
              {t.status !== "blocked" && isOpenTask(t.status) ? (
                <div className="flex flex-col gap-2">
                  <span className="eyebrow">Block this task</span>
                  <input
                    className="select"
                    value={blockReason}
                    onChange={(e) => setBlockReason(e.target.value)}
                    placeholder="What is it waiting on?"
                  />
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() =>
                      // A person's own reason, not a teammate's question. With none, the board says who.
                      void onMove(t.id, {
                        status: "blocked",
                        ...(blockReason.trim()
                          ? {
                              blocker: {
                                code: "unknown",
                                what: blockReason.trim(),
                                why: "A person marked it blocked; no run stopped it.",
                              },
                            }
                          : {}),
                      })
                    }
                  >
                    Mark blocked
                  </Button>
                </div>
              ) : null}
              {cancellable && onCancel ? (
                <div className="flex flex-col gap-2">
                  <span className="eyebrow">Cancel this task</span>
                  <input
                    className="select"
                    value={cancelNote}
                    onChange={(e) => setCancelNote(e.target.value)}
                    placeholder="Why it will not be done (optional)"
                  />
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => void onCancel(t.id, cancelNote.trim() || undefined)}
                  >
                    Cancel task
                  </Button>
                  <span className="hint">{CANCEL_HINT}</span>
                </div>
              ) : null}
              {canCancel && onReopen && t.status === "cancelled" ? (
                <div className="flex flex-col gap-2">
                  <span className="eyebrow">Cancelled</span>
                  <span className="hint">Nobody works on it. Reopen it to put it back in To do.</span>
                  <Button size="sm" onClick={() => void onReopen(t.id)}>
                    Reopen
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </aside>
  );
}

type DrawerTab = "conv" | "run" | "outputs" | "details";

export function BoardView(p: BoardViewProps) {
  const { data } = p;
  const [over, setOver] = useState<TaskStatus | null>(null);
  const vis = data.tasks.filter(
    (t) =>
      (p.departmentId === "all" || t.departmentId === p.departmentId) &&
      (p.projectId === "all" || t.projectId === p.projectId),
  );
  const selected = p.selectedTaskId ? data.tasks.find((t) => t.id === p.selectedTaskId) : undefined;

  const drop = (status: TaskStatus) => (e: DragEvent) => {
    e.preventDefault();
    setOver(null);
    const id = e.dataTransfer.getData("text/plain");
    const t = data.tasks.find((x) => x.id === id);
    if (!t || t.status === status || status === "cancelled") return;
    if (status === "done") return p.onRefuseDone(id);
    void p.onMove(id, { status });
  };

  return (
    <>
      <Topbar
        title="Board"
        left={
          <>
            <select
              className="select"
              value={p.projectId}
              onChange={(e) => p.onFilterProject(e.target.value)}
            >
              <option value="all">All projects</option>
              {data.projects.map((pr) => (
                <option key={pr.id} value={pr.id}>
                  {pr.name}
                </option>
              ))}
            </select>
            {/* A button per department reads well for a few; past three names they no longer fit the bar. */}
            {data.departments.length > 3 ? (
              <select
                className="select"
                aria-label="Department"
                value={p.departmentId}
                onChange={(e) => p.onFilterDepartment(e.target.value)}
              >
                <option value="all">All departments</option>
                {data.departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            ) : (
              <Segs
                label="Department"
                value={p.departmentId}
                onChange={p.onFilterDepartment}
                options={[
                  { value: "all", label: "All" },
                  ...data.departments.map((d) => ({ value: d.id, label: d.name })),
                ]}
              />
            )}
          </>
        }
        right={
          <Button variant="primary" onClick={p.onNewTask}>
            <Plus size={16} />
            <span>New task</span>
          </Button>
        }
      />
      <div className="content">
        <div className="board" id="board">
          {COLUMNS.map(([k, l]) => {
            const list = vis.filter((t) => t.status === k).sort((a, b) => b.number - a.number);
            return (
              <div
                key={k}
                className={cn("col", over === k && "over")}
                data-col={k}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (over !== k) setOver(k);
                }}
                onDragLeave={() => setOver(null)}
                onDrop={drop(k)}
              >
                <div className={cn("col-h", k === "blocked" && "blocked")}>
                  <span>{l}</span>
                  <span className="mono font-normal">{list.length}</span>
                </div>
                {list.map((t) => (
                  <TaskCard
                    key={t.id}
                    t={t}
                    data={data}
                    meId={p.meId}
                    selected={selected?.id === t.id}
                    onSelect={() => p.onSelectTask(selected?.id === t.id ? null : t.id)}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", t.id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                  />
                ))}
                {list.length === 0 ? (
                  <div className="col-empty">{k === "blocked" ? "Nothing blocked" : "Empty"}</div>
                ) : null}
              </div>
            );
          })}
        </div>
        {selected ? (
          <Drawer
            t={selected}
            data={data}
            meId={p.meId}
            onClose={() => p.onSelectTask(null)}
            onMove={p.onMove}
            onRefuseDone={p.onRefuseDone}
            onOpenReview={p.onOpenReview}
            onAssign={p.onAssign}
            onSetDepartment={p.onSetDepartment}
            loadMessages={p.loadMessages}
            onPostMessage={p.onPostMessage}
            loadRuns={p.loadRuns}
            loadRun={p.loadRun}
            loadArtifacts={p.loadArtifacts}
            loadArtifact={p.loadArtifact}
            loadDeliverable={p.loadDeliverable}
            downloadUrl={p.downloadUrl}
            onStartRun={p.onStartRun}
            onStopRun={p.onStopRun}
            canDecide={p.canDecide}
            onApprove={p.onApprove}
            onReject={p.onReject}
            canCancel={p.canCancel}
            onCancel={p.onCancel}
            onReopen={p.onReopen}
          />
        ) : null}
      </div>
    </>
  );
}
