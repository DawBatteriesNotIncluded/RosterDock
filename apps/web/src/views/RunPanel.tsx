// The live run inside the task drawer: what the teammate is doing now, the
// log, tokens and elapsed time, and the outputs it produced.
import { Play, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Artifact, Run, RunDetail, RunEvent, Task, TaskDeliverable } from "../api/types.ts";
import { Button, Dot, Empty, Pill } from "../components/ui.tsx";
import { cn } from "../lib/cn.ts";
import { ENGINE_LABEL, isOpenTask, relativeTime } from "../lib/format.ts";

export interface RunPanelProps {
  task: Task;
  assigneeIsTeammate: boolean;
  assigneeName: string | null;
  /** Name a teammate by id, for turns other teammates took on this task. */
  teammateName(id: string): string | null;
  loadRuns(taskId: string): Promise<Run[]>;
  loadRun(runId: string): Promise<RunDetail>;
  onStart(taskId: string): Promise<void>;
  onStop(runId: string): Promise<void>;
}

const LIVE: Run["status"][] = ["queued", "running", "interrupted"];

export function runTone(status: Run["status"]): "ok" | "warn" | "bad" | "info" | "muted" {
  switch (status) {
    case "running":
      return "ok";
    case "queued":
    case "interrupted":
      return "warn";
    case "failed":
    case "blocked":
      return "bad";
    case "completed":
      return "info";
    default:
      return "muted";
  }
}

export function runLabel(status: Run["status"]): string {
  return {
    queued: "Queued",
    running: "Running",
    interrupted: "Interrupted",
    completed: "Finished",
    failed: "Failed",
    stopped: "Stopped",
    blocked: "Blocked",
  }[status];
}

export function fmtTokens(n: number): string {
  return n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(2)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(1)}k`
      : String(n);
}

/** Millicores as a person reads them: 320m, 1.5 cores. */
export function fmtCpu(millis: number): string {
  return millis >= 1000 ? `${(millis / 1000).toFixed(1)} cores` : `${millis}m CPU`;
}

export function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} kB`;
}

export function fmtDuration(ms: number | null): string {
  if (ms === null) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${s % 60} s`;
}

export function eventLine(ev: RunEvent): { text: string; tone: "muted" | "ink" | "bad" } {
  const p = ev.payload as Record<string, unknown>;
  const text = typeof p.text === "string" ? p.text : "";
  switch (ev.type) {
    case "run.claimed":
      return {
        text: `Picked up (attempt ${String(p.attempt ?? 1)})`,
        tone: "muted",
      };
    case "step":
      return { text, tone: "muted" };
    case "engine":
      return { text: `${text}${p.model ? ` · ${String(p.model)}` : ""}`, tone: "muted" };
    case "tool":
      return { text: `${String(p.name ?? "tool")} ${String(p.input ?? "")}`.trim(), tone: "ink" };
    case "assistant":
      return { text, tone: "ink" };
    case "artifact":
      return { text: `Wrote ${String(p.path ?? "a file")} (${String(p.bytes ?? "?")} bytes)`, tone: "ink" };
    case "check":
      return {
        text: `Check: ${text}`,
        tone: p.ok === false ? "bad" : "ink",
      };
    case "stderr":
      return { text, tone: "bad" };
    case "stdout":
      return { text, tone: "muted" };
    case "result":
      return {
        text: p.isError
          ? `Engine reported an error (${String(p.subtype ?? "")})`
          : `Engine finished in ${fmtDuration(typeof p.durationMs === "number" ? p.durationMs : null)}`,
        tone: "muted",
      };
    case "run.finished":
      return {
        text: `Run ${String(p.status ?? "finished")} · ${fmtTokens(Number(p.totalTokens ?? 0))} tokens`,
        tone: "muted",
      };
    default:
      return { text: `${ev.type} ${text}`.trim(), tone: "muted" };
  }
}

export function RunPanel(p: RunPanelProps) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  // The assignee's work leads; turns other teammates took to answer are listed after it.
  const latest = runs.find((r) => r.kind === "task") ?? runs[0] ?? null;
  const earlier = runs.filter((r) => r !== latest);
  const live = latest ? LIVE.includes(latest.status) : false;

  // Load the run list whenever the task changes shape (SSE refreshes bump updatedAt).
  useEffect(() => {
    let alive = true;
    void p.loadRuns(p.task.id).then((r) => alive && setRuns(r));
    return () => {
      alive = false;
    };
  }, [p.task.id, p.task.updatedAt, p.task.activeRunId, p.loadRuns]);

  // Poll the latest run while it is live; otherwise load it once.
  useEffect(() => {
    if (!latest) {
      setDetail(null);
      return;
    }
    let alive = true;
    const tick = () => void p.loadRun(latest.id).then((d) => alive && setDetail(d));
    tick();
    const timer = live ? window.setInterval(tick, 2000) : null;
    return () => {
      alive = false;
      if (timer) window.clearInterval(timer);
    };
  }, [latest?.id, latest?.status, live, p.loadRun, latest]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [detail?.events.length]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      setRuns(await p.loadRuns(p.task.id));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="thread" style={{ gap: 14 }}>
      <div className="row">
        <div className="flex items-center gap-2">
          {latest ? (
            <Pill tone={runTone(latest.status)}>{runLabel(latest.status)}</Pill>
          ) : (
            <span className="text-[13px] text-muted">Not started</span>
          )}
          {latest ? (
            <span className="text-[12px] text-muted">
              attempt {latest.attempt} · {ENGINE_LABEL[latest.engine] ?? latest.engine} ·{" "}
              <span className="mono">{latest.model}</span>
            </span>
          ) : null}
        </div>
        <div className="flex gap-2">
          {live && latest ? (
            <Button
              size="sm"
              variant="danger"
              disabled={busy || latest.stopRequested}
              onClick={() => void act(() => p.onStop(latest.id))}
            >
              <Square size={12} />
              <span>{latest.stopRequested ? "Stopping…" : "Stop"}</span>
            </Button>
          ) : p.assigneeIsTeammate && isOpenTask(p.task.status) ? (
            <Button
              size="sm"
              variant="accent"
              disabled={busy}
              onClick={() => void act(() => p.onStart(p.task.id))}
            >
              <Play size={12} />
              <span>{latest ? "Run again" : `Start ${p.assigneeName ?? "teammate"}`}</span>
            </Button>
          ) : null}
        </div>
      </div>
      {!p.assigneeIsTeammate && !latest ? <Empty>Assign a teammate to run this task.</Empty> : null}
      {latest ? (
        <dl className="kv">
          <dt>Now</dt>
          <dd className="flex items-center gap-2">
            {live ? <Dot tone={latest.status === "running" ? "ok" : "warn"} /> : null}
            <span>
              {latest.currentStep ??
                (latest.status === "queued"
                  ? "Waiting for a worker"
                  : latest.status === "interrupted"
                    ? "Worker stopped responding; waiting for a retry"
                    : (latest.error ??
                      `${runLabel(latest.status)} ${relativeTime(latest.finishedAt ?? latest.createdAt)}`))}
            </span>
          </dd>
          <dt>Tokens</dt>
          <dd className="mono">
            {fmtTokens((detail ?? latest).totalTokens)}
            {(detail ?? latest).costMinorUnits !== null
              ? ` · ${(((detail ?? latest).costMinorUnits ?? 0) / 100).toFixed(2)}`
              : ""}
          </dd>
          <dt>Time</dt>
          <dd className="mono">
            {latest.durationMs !== null
              ? fmtDuration(latest.durationMs)
              : latest.startedAt
                ? `${fmtDuration(Date.now() - new Date(latest.startedAt).getTime())} so far`
                : "queued " + relativeTime(latest.queuedAt)}
          </dd>
          {latest.workerId ? (
            <>
              <dt>Worker</dt>
              <dd className="mono text-[12px]">{latest.workerId}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {latest?.status === "blocked" || latest?.status === "failed" ? (
        <div className="blockbox">
          <b>{latest.blocker?.what ?? latest.error ?? "The run did not finish."}</b>
          {latest.blocker?.why ? <span>{latest.blocker.why}</span> : null}
        </div>
      ) : null}
      {latest?.summary && latest.status === "completed" ? <div className="note">{latest.summary}</div> : null}
      {detail ? (
        <>
          <span className="eyebrow">Log</span>
          <div
            ref={logRef}
            className="card p-3 text-[12px] leading-relaxed"
            style={{ maxHeight: 260, overflow: "auto", background: "var(--ground)" }}
          >
            {detail.events.length === 0 ? <span className="text-muted">Nothing yet.</span> : null}
            {detail.events.map((ev) => {
              const line = eventLine(ev);
              return (
                <div
                  key={ev.seq}
                  className={cn(
                    "flex gap-2",
                    line.tone === "muted" && "text-muted",
                    line.tone === "bad" && "text-bad",
                  )}
                >
                  <span className="mono shrink-0 text-faint">{ev.at.slice(11, 19)}</span>
                  <span className="min-w-0 break-words">{line.text}</span>
                </div>
              );
            })}
          </div>
        </>
      ) : null}
      {earlier.length ? (
        <>
          <span className="eyebrow">Earlier runs and answers</span>
          <div className="flex flex-col gap-1.5 text-[12px]">
            {earlier.map((r) => (
              <div key={r.id} className="flex items-center gap-2">
                <Pill tone={runTone(r.status)}>{runLabel(r.status)}</Pill>
                <span className="text-muted">
                  {r.kind === "turn"
                    ? `${p.teammateName(r.teammateId) ?? "a teammate"} answered`
                    : `attempt ${r.attempt}`}{" "}
                  · {fmtTokens(r.totalTokens)} tokens · {relativeTime(r.createdAt)}
                </span>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/** Where a ticket's deliverable stands, in a word and a tone. */
export const DELIVERABLE_LABEL: Record<
  TaskDeliverable["state"],
  { label: string; tone: "ok" | "info" | "warn" | "muted" }
> = {
  approved: { label: "Approved in review", tone: "ok" },
  in_review: { label: "In review", tone: "info" },
  changes_requested: { label: "Changes requested", tone: "warn" },
  unreviewed: { label: "Not reviewed yet", tone: "muted" },
  none: { label: "Nothing yet", tone: "muted" },
};

/**
 * The task's other files, newest version of each, with how many versions there were: not the
 * deliverable's own files or their older versions, not diffs (the review shows those) or logs.
 */
export function otherFiles(all: Artifact[], deliverable: Artifact[]): { file: Artifact; versions: number }[] {
  const mine = new Set(deliverable.map((f) => f.path));
  const byPath = new Map<string, { file: Artifact; versions: number }>();
  for (const a of all) {
    if (mine.has(a.path) || a.kind === "diff" || a.kind === "log") continue;
    const seen = byPath.get(a.path);
    if (!seen) byPath.set(a.path, { file: a, versions: 1 });
    else {
      seen.versions += 1;
      if (a.createdAt > seen.file.createdAt) seen.file = a;
    }
  }
  return [...byPath.values()].sort((x, y) => (x.file.createdAt < y.file.createdAt ? 1 : -1));
}

export function OutputsPanel({
  task,
  loadArtifacts,
  loadArtifact,
  loadDeliverable,
  downloadUrl,
}: {
  task: Task;
  loadArtifacts(taskId: string): Promise<Artifact[]>;
  loadArtifact(runId: string, id: string): Promise<Artifact>;
  loadDeliverable?(taskId: string): Promise<TaskDeliverable>;
  downloadUrl?(runId: string, artifactId: string): string;
}) {
  const [list, setList] = useState<Artifact[]>([]);
  const [deliverable, setDeliverable] = useState<TaskDeliverable | null>(null);
  const [open, setOpen] = useState<Artifact | null>(null);
  const [everything, setEverything] = useState(false);
  useEffect(() => {
    let alive = true;
    void loadArtifacts(task.id).then((a) => alive && setList(a));
    if (loadDeliverable) void loadDeliverable(task.id).then((d) => alive && setDeliverable(d));
    return () => {
      alive = false;
    };
  }, [task.id, task.updatedAt, task.activeRunId, loadArtifacts, loadDeliverable]);
  const delivered = deliverable?.files ?? [];
  const versionsOf = (path: string) => list.filter((a) => a.path === path).length;
  const others = otherFiles(list, delivered);
  const row = (a: Artifact, note?: string) => (
    <div key={a.id} className={cn("outfile", open?.id === a.id && "selected")}>
      <span className="flex min-w-0 flex-col text-left">
        <span className="mono truncate text-[12px]">{a.path}</span>
        <span className="text-[11px] text-muted">
          {a.bytes.toLocaleString()} bytes · {relativeTime(a.createdAt)}
          {note ? ` · ${note}` : ""}
        </span>
      </span>
      <span className="flex items-center gap-3 text-[12px]">
        <button
          onClick={() => (open?.id === a.id ? setOpen(null) : void loadArtifact(a.runId, a.id).then(setOpen))}
        >
          <span className="text-accent">{open?.id === a.id ? "Close" : "Open"}</span>
        </button>
        {downloadUrl ? (
          <a className="text-accent" href={downloadUrl(a.runId, a.id)} download>
            Download
          </a>
        ) : null}
      </span>
    </div>
  );
  const state = deliverable ? DELIVERABLE_LABEL[deliverable.state] : null;
  return (
    <div className="thread" style={{ gap: 10 }}>
      {loadDeliverable ? (
        <div className="flex flex-col gap-2">
          <div className="row">
            <span className="eyebrow">Deliverable</span>
            {state ? (
              <Pill tone={state.tone}>
                {state.label}
                {deliverable?.round && deliverable.state !== "unreviewed"
                  ? ` · round ${deliverable.round}`
                  : ""}
              </Pill>
            ) : null}
          </div>
          {deliverable === null ? <span className="hint">Loading…</span> : null}
          {delivered.map((a) => {
            const earlier = versionsOf(a.path) - 1;
            return row(a, earlier > 0 ? `${earlier} earlier version${earlier === 1 ? "" : "s"}` : undefined);
          })}
          {deliverable && deliverable.state === "none" ? (
            <span className="hint">
              {task.declaredOutputs.length
                ? `Expected: ${task.declaredOutputs.join(", ")}. It appears here when a run finishes.`
                : "Nothing delivered yet. It appears here when a run finishes."}
            </span>
          ) : null}
          {deliverable && deliverable.state !== "none" && deliverable.missing.length ? (
            <span className="hint">Declared but not delivered: {deliverable.missing.join(", ")}.</span>
          ) : null}
        </div>
      ) : null}
      {others.length ? (
        <div className="flex flex-col gap-2">
          <span className="eyebrow">{loadDeliverable ? "Other files" : "Files"}</span>
          {others.map(({ file, versions }) =>
            row(file, versions > 1 ? `newest of ${versions} versions` : undefined),
          )}
        </div>
      ) : null}
      {list.length === 0 && !loadDeliverable ? (
        <Empty>No outputs yet. They appear here when a run finishes.</Empty>
      ) : null}
      {list.length > delivered.length + others.length ? (
        <button className="self-start" onClick={() => setEverything(!everything)}>
          <span className="text-[12px] text-accent">
            {everything ? "Hide" : "Show"} every version from every run ({list.length})
          </span>
        </button>
      ) : null}
      {everything ? <div className="flex flex-col gap-2">{list.map((a) => row(a, a.kind))}</div> : null}
      {open ? (
        <div className="flex flex-col gap-1.5">
          <div className="row">
            <span className="mono text-[12px]">{open.path}</span>
            <button className="text-[12px] text-muted" onClick={() => setOpen(null)}>
              Close
            </button>
          </div>
          <pre className="action-json" style={{ whiteSpace: "pre-wrap", maxHeight: 360 }}>
            {open.encoding === "base64"
              ? `(binary · ${open.bytes.toLocaleString()} bytes)`
              : (open.content ?? "(stored in object storage; not inline)")}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
