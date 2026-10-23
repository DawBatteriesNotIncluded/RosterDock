import type { UpdateGoalCapsInput } from "@rosterdock/shared";
import { Plus } from "lucide-react";
import type { CompanyData, Department, Draft, Run, Task } from "../api/types.ts";
import { Avatar, Button, Dot, Empty, Pill, Topbar } from "../components/ui.tsx";
import { cn } from "../lib/cn.ts";
import { blockerNeedsYou, describeEvent, isOpenTask, relativeTime, teammateStatus } from "../lib/format.ts";
import { DraftsSection, GoalsSection, type GoalResultAccess } from "./GoalsPanel.tsx";
import { WorkingNow } from "./WorkingNow.tsx";

export interface CompanyViewProps {
  data: CompanyData;
  meId?: string;
  /** Runs that are queued, running or interrupted right now. */
  liveRuns?: Run[];
  onNewProject(): void;
  onNewTask(): void;
  onNewDepartment(): void;
  // Peter (M4)
  onNewGoal(): void;
  onAnswerGoal(goalId: string, answers: string[]): Promise<void>;
  onStopGoal(goalId: string): Promise<void>;
  onUpdateGoalCaps(goalId: string, caps: UpdateGoalCapsInput): Promise<void>;
  /** A goal's result: what it delivered and published, and the links to save it. */
  goalResults?: GoalResultAccess;
  /** Owners and admins accept Peter's drafts and change a goal's caps. */
  canDecide: boolean;
  onDesign(): void;
  onAudit(): Promise<void>;
  onAcceptDraft(draft: Draft): Promise<void>;
  onRejectDraft(draft: Draft): Promise<void>;
  onOpenProject(id: string): void;
  onOpenDepartmentBoard(id: string): void;
  onOpenTask(id: string): void;
  onOpenReview(id: string): void;
  onOpenTeammate(id: string): void;
  onGoActivity(): void;
}

function DeptCard({
  d,
  tasks,
  data,
  onOpenBoard,
  onOpenTask,
  onOpenTeammate,
}: { d: Department; tasks: Task[]; data: CompanyData } & Pick<
  CompanyViewProps,
  "onOpenTask" | "onOpenTeammate"
> & { onOpenBoard(): void }) {
  const dt = tasks.filter((t) => t.departmentId === d.id);
  const open = dt.filter((t) => isOpenTask(t.status)).length;
  const working = dt.filter((t) => t.status === "doing").length;
  const needs = dt.some((t) => blockerNeedsYou(t.blocker));
  const lead = data.teammates.find((t) => t.id === d.leadTeammateId);
  const members = d.members.filter((m) => !m.isLead);
  const leadTask = lead ? dt.find((t) => t.assignee?.id === lead.id && isOpenTask(t.status)) : undefined;
  return (
    <div className="card dept">
      <div className="row">
        <div className="flex flex-col gap-0.5">
          <span className="text-[16px] font-semibold">{d.name}</span>
          <span className="text-[12px] text-muted">
            {d.members.length} teammate{d.members.length === 1 ? "" : "s"} · {working} working
            {needs ? " · waiting on you" : ""}
          </span>
        </div>
        {needs ? (
          <Pill tone="warn">Needs you</Pill>
        ) : working ? (
          <Pill tone="ok">Live</Pill>
        ) : (
          <Pill tone="muted">Quiet</Pill>
        )}
      </div>
      {lead ? (
        <button className="lead" onClick={() => onOpenTeammate(lead.id)}>
          <Avatar name={lead.name} handle={lead.handle} size="l" />
          <div className="flex min-w-0 flex-col text-left">
            <span className="text-[13px] font-semibold">{lead.name} · Lead</span>
            <span className="truncate text-[12px] text-muted">
              {leadTask ? leadTask.title : "Coordinating"}
            </span>
          </div>
        </button>
      ) : (
        <div className="lead text-[12px] text-muted">No lead yet. Pick one in Departments.</div>
      )}
      <div className="flex flex-col gap-2.5">
        {members.map((m) => {
          const t = data.teammates.find((x) => x.id === m.teammateId);
          if (!t) return null;
          const st = teammateStatus(t, dt);
          const target = dt.find((x) => x.assignee?.id === t.id && isOpenTask(x.status));
          return (
            <button
              key={m.teammateId}
              className="member"
              onClick={() => (target ? onOpenTask(target.id) : onOpenTeammate(t.id))}
            >
              <Avatar name={t.name} handle={t.handle} size="l" />
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="name">{t.name}</span>
                  <span className="role">{t.role}</span>
                </div>
                <span
                  className={cn(
                    "status",
                    st.tone === "warn" && "warn",
                    st.tone === "bad" && "bad",
                    st.tone === "info" && "info",
                  )}
                >
                  <Dot tone={st.tone} />
                  {st.text}
                </span>
              </div>
            </button>
          );
        })}
        {members.length === 0 ? <span className="text-[12px] text-muted">No other members yet.</span> : null}
      </div>
      <div className="dept-foot">
        <span className="text-muted">{open} open tasks</span>
        <a onClick={onOpenBoard}>Open board</a>
      </div>
    </div>
  );
}

export function CompanyView(p: CompanyViewProps) {
  const { data } = p;
  const working = data.tasks.filter((t) => t.status === "doing").length;
  const feed = data.events.slice(0, 8);
  return (
    <>
      <Topbar
        title={data.company.name}
        subtitle={`${data.departments.length} departments · ${data.teammates.length} teammates · ${working} working now`}
        right={
          <>
            <Button variant="ghost" onClick={p.onNewTask}>
              New task
            </Button>
            <Button variant="primary" onClick={p.onNewGoal}>
              <Plus size={16} />
              <span>New goal</span>
            </Button>
          </>
        }
      />
      <div className="content">
        <div className="company scroll">
          <GoalsSection
            data={data}
            onNewGoal={p.onNewGoal}
            onOpen={p.onOpenProject}
            onAnswer={p.onAnswerGoal}
            onStop={p.onStopGoal}
            onUpdateCaps={p.onUpdateGoalCaps}
            canDecide={p.canDecide}
            {...(p.goalResults ? { results: p.goalResults } : {})}
          />
          <div className="row mt-1.5">
            <span className="eyebrow">Projects</span>
            <Button size="sm" onClick={p.onNewProject}>
              <Plus size={14} />
              <span>New project</span>
            </Button>
          </div>
          <div className="flex flex-wrap gap-2.5">
            {data.projects.map((pr) => (
              <button key={pr.id} className="card project-card" onClick={() => p.onOpenProject(pr.id)}>
                <span className="font-semibold">{pr.name}</span>
                <span className="text-[12px] text-muted">
                  {pr.client} · {pr.counts.open} open
                  {pr.counts.running ? (
                    <span className="text-accent"> · {pr.counts.running} running</span>
                  ) : null}
                  {pr.counts.blocked ? (
                    <span className="text-bad"> · {pr.counts.blocked} blocked</span>
                  ) : null}
                </span>
              </button>
            ))}
            {data.projects.length === 0 ? (
              <Empty>No projects yet. Hand Peter a goal and he opens one, or open one yourself.</Empty>
            ) : null}
          </div>
          <div className="row mt-1.5">
            <span className="eyebrow">Departments</span>
            {data.company.budgetTokensWeek ? (
              <div className="flex items-center gap-3 text-[13px] text-muted">
                <span>This week</span>
                <div className="meter">
                  <div style={{ width: "0%" }} />
                </div>
                <span className="mono text-[12px] text-ink">
                  0 / {data.company.budgetTokensWeek.toLocaleString()} tokens
                </span>
              </div>
            ) : null}
          </div>
          <div className="depts">
            {data.departments.map((d) => (
              <DeptCard
                key={d.id}
                d={d}
                tasks={data.tasks}
                data={data}
                onOpenBoard={() => p.onOpenDepartmentBoard(d.id)}
                onOpenTask={p.onOpenTask}
                onOpenTeammate={p.onOpenTeammate}
              />
            ))}
          </div>
          <button className="add-dept" onClick={p.onNewDepartment}>
            <Plus size={16} />
            <span>Add a department from a template</span>
          </button>
          <DraftsSection
            data={data}
            canDecide={p.canDecide}
            onDesign={p.onDesign}
            onAudit={p.onAudit}
            onAccept={p.onAcceptDraft}
            onReject={p.onRejectDraft}
          />
        </div>
        <aside className="rail">
          {p.liveRuns?.length ? <WorkingNow runs={p.liveRuns} data={data} onOpenTask={p.onOpenTask} /> : null}
          <div className="row">
            <span className="eyebrow">Happening now</span>
            <span className="flex items-center gap-1.5 text-[12px] text-accent">
              <Dot tone="ok" />
              Live
            </span>
          </div>
          <div className="feed">
            {feed.map((ev) => {
              const s = describeEvent(ev, data, p.meId);
              const actor = ev.actor;
              const name =
                actor?.kind === "teammate"
                  ? (data.teammates.find((t) => t.id === actor.id)?.name ?? "T")
                  : (data.members.find((m) => m.userId === actor?.id)?.name ?? "You");
              return (
                <button
                  key={ev.id}
                  className={cn("feed-item", s.attention && "attention")}
                  onClick={() => {
                    if (s.go?.reviewId) p.onOpenReview(s.go.reviewId);
                    else if (s.go?.taskId) p.onOpenTask(s.go.taskId);
                    else p.onGoActivity();
                  }}
                >
                  <Avatar
                    name={name}
                    handle={actor?.kind === "teammate" ? name : undefined}
                    you={actor?.kind === "user" && actor.id === p.meId}
                  />
                  <div>
                    <div className="txt">{s.text}</div>
                    <div className="meta">{relativeTime(ev.createdAt)}</div>
                  </div>
                </button>
              );
            })}
            {feed.length === 0 ? <Empty>Quiet so far. Hand Peter a goal.</Empty> : null}
          </div>
        </aside>
      </div>
    </>
  );
}
