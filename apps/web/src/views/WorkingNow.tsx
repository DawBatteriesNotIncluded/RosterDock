// The live process panel: every teammate running right now, what they are
// doing, for how long, and the tokens so far. Polled while anything is live;
// otherwise refreshed when a run event lands.
import { useEffect, useState } from "react";
import type { CompanyData, Run } from "../api/types.ts";
import { Avatar, Dot } from "../components/ui.tsx";
import { fmtBytes, fmtCpu, fmtDuration, fmtTokens } from "./RunPanel.tsx";

const LIVE: Run["status"][] = ["queued", "running", "interrupted"];

export function useLiveRuns(load: (() => Promise<Run[]>) | null, trigger: number): Run[] {
  const [runs, setRuns] = useState<Run[]>([]);
  useEffect(() => {
    if (!load) return;
    let alive = true;
    let timer: number | null = null;
    const tick = () =>
      void load()
        .then((r) => {
          if (!alive) return;
          setRuns(r);
          if (r.some((x) => x.status === "running") && timer === null) timer = window.setInterval(tick, 3000);
          if (!r.some((x) => x.status === "running") && timer !== null) {
            window.clearInterval(timer);
            timer = null;
          }
        })
        .catch(() => {});
    tick();
    return () => {
      alive = false;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [load, trigger]);
  return runs;
}

export function WorkingNow({
  runs,
  data,
  now = Date.now(),
  onOpenTask,
}: {
  runs: Run[];
  data: CompanyData;
  now?: number;
  onOpenTask(id: string): void;
}) {
  const live = runs.filter((r) => LIVE.includes(r.status));
  if (!live.length) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="row">
        <span className="eyebrow">Working now</span>
        <span className="text-[12px] text-muted">
          {live.length} run{live.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {live.map((r) => {
          const mate = data.teammates.find((t) => t.id === r.teammateId);
          const task = data.tasks.find((t) => t.id === r.taskId);
          const since = r.startedAt ? now - new Date(r.startedAt).getTime() : null;
          const what =
            r.status === "queued"
              ? "Waiting for a worker"
              : r.status === "interrupted"
                ? "Picking up where it stopped"
                : (r.currentStep ?? (r.kind === "turn" ? "Answering" : "Working"));
          return (
            <button key={r.id} className="feed-item" onClick={() => onOpenTask(r.taskId)}>
              <Avatar name={mate?.name ?? "?"} handle={mate?.handle} />
              <div className="min-w-0">
                <div className="txt">
                  <b>{mate?.name ?? "A teammate"}</b>
                  {r.kind === "turn" ? " answering on " : " on "}
                  {task ? `#${task.number} ${task.title}` : "a task"}
                </div>
                <div className="meta flex items-center gap-1.5">
                  <Dot tone={r.status === "running" ? "ok" : r.status === "queued" ? "idle" : "warn"} />
                  {what}
                  {since !== null ? ` · ${fmtDuration(since)}` : ""}
                  {r.totalTokens ? ` · ${fmtTokens(r.totalTokens)} tokens` : ""}
                  {r.status === "running" && r.resources
                    ? ` · ${fmtCpu(r.resources.cpuMillis)} · ${fmtBytes(r.resources.memoryBytes)}`
                    : ""}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
