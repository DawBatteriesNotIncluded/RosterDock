import { Plus } from "lucide-react";
import type { CompanyData, Department, Teammate } from "../api/types.ts";
import { Avatar, Button, Empty, Pill, Topbar } from "../components/ui.tsx";
import { cn } from "../lib/cn.ts";
import { isOpenTask, POLICY_LABEL } from "../lib/format.ts";

export type CellState = "none" | "member" | "lead";

export function cellState(d: Department, t: Teammate): CellState {
  if (d.leadTeammateId === t.id) return "lead";
  return d.members.some((m) => m.teammateId === t.id) ? "member" : "none";
}

/** Matrix cell cycle: none, member, lead, none. */
export function nextCellState(s: CellState): CellState {
  return s === "none" ? "member" : s === "member" ? "lead" : "none";
}

export interface DepartmentsViewProps {
  data: CompanyData;
  onNewDepartment(): void;
  onDissolve(id: string): Promise<void>;
  onOpenBoard(id: string): void;
  onCycleCell(departmentId: string, teammateId: string, from: CellState): Promise<void>;
  onHire(): void;
  onDesign(): void;
}

export function DepartmentsView(p: DepartmentsViewProps) {
  const { data } = p;
  return (
    <>
      <Topbar
        title="Departments"
        subtitle={`${data.company.name} · who sits where, and what each department may touch`}
        right={
          <>
            <Button variant="ghost" onClick={p.onDesign}>
              Ask Peter to design a team
            </Button>
            <Button variant="primary" onClick={p.onNewDepartment}>
              <Plus size={16} />
              <span>Create department</span>
            </Button>
          </>
        }
      />
      <div className="content">
        <div className="company scroll" style={{ gap: 24 }}>
          <div className="depts">
            {data.departments.map((d) => {
              const dt = data.tasks.filter((t) => t.departmentId === d.id);
              return (
                <div key={d.id} className="card dept" style={{ gap: 10 }}>
                  <div className="row">
                    <span className="text-[16px] font-semibold">{d.name}</span>
                    <Pill
                      tone={
                        d.writePolicy === "readonly" ? "muted" : d.writePolicy === "drafts" ? "ok" : "warn"
                      }
                    >
                      {POLICY_LABEL[d.writePolicy]}
                    </Pill>
                    {d.sandbox?.pool ? <Pill tone="info">{`Runs on ${d.sandbox.pool}`}</Pill> : null}
                  </div>
                  <div className="chips">
                    {d.members.map((m) => (
                      <span key={m.teammateId} className="chipmate">
                        <Avatar name={m.name} handle={m.handle} size="s" />
                        <span>
                          {m.name}
                          {m.isLead ? " · lead" : ""}
                        </span>
                      </span>
                    ))}
                    {d.members.length === 0 ? (
                      <span className="text-[12px] text-muted">No teammates yet. Use the matrix below.</span>
                    ) : null}
                  </div>
                  <div className="dept-foot">
                    <span className="text-muted">
                      {dt.filter((t) => isOpenTask(t.status)).length} open ·{" "}
                      {dt.filter((t) => t.status === "doing").length} running
                    </span>
                    <span className="flex gap-3">
                      <a onClick={() => p.onOpenBoard(d.id)}>Board</a>
                      <a style={{ color: "var(--bad)" }} onClick={() => void p.onDissolve(d.id)}>
                        Dissolve
                      </a>
                    </span>
                  </div>
                </div>
              );
            })}
            <button
              className="add-dept"
              style={{ minHeight: 120, alignSelf: "stretch", justifyContent: "center" }}
              onClick={p.onNewDepartment}
            >
              <Plus size={16} />
              <span>Create a department</span>
            </button>
          </div>
          <div className="flex flex-col gap-2.5">
            <div className="row">
              <span className="eyebrow">Who sits where</span>
              <Button size="sm" onClick={p.onHire}>
                <Plus size={14} />
                <span>Hire a teammate</span>
              </Button>
            </div>
            {data.teammates.length === 0 || data.departments.length === 0 ? (
              <Empty>
                Hire a teammate and create a department, then click a cell to seat them: member, then lead,
                then out.
              </Empty>
            ) : (
              <div className="card overflow-x-auto">
                <table className="matrix">
                  <thead>
                    <tr>
                      <th>Teammate</th>
                      {data.departments.map((d) => (
                        <th key={d.id} style={{ textAlign: "center" }}>
                          {d.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.teammates.map((t) => (
                      <tr key={t.id}>
                        <td>
                          <span className="flex items-center gap-2">
                            <Avatar name={t.name} handle={t.handle} size="s" />
                            <span className="font-semibold">{t.name}</span>
                            <span className="role">{t.role}</span>
                          </span>
                        </td>
                        {data.departments.map((d) => {
                          const s = cellState(d, t);
                          return (
                            <td key={d.id} className="cell">
                              <button
                                className={cn("cellbtn", s)}
                                onClick={() => void p.onCycleCell(d.id, t.id, s)}
                                title="Click to cycle: member, lead, out"
                              >
                                {s === "lead" ? "Lead" : s === "member" ? "Member" : "—"}
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <span className="hint">
              Policy only narrows: a department policy tightens its members' toolboxes, never widens them.
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
