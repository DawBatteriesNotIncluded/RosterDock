// What tokens were spent on: a teammate's run (run_usage, recorded when the
// run reports) or a manager's own model call (planning_usage, recorded here as
// the call returns): Peter, or a department's lead, planning a goal, writing a
// re-plan note or proposing an org. Costs, the monthly report, the CSV and the
// budgets read both alike; a call is priced like a run of the model that
// answered, and its tokens count against the budgets of whatever it served.

import type { RunUsage } from "@rosterdock/shared";
import type { Db } from "../db/pool.js";
import { mutate } from "../mutate.js";
import { totalTokens } from "./cost.js";
import { budgetCrossings, emitBudgetAlert } from "./service.js";

/** What a manager's call was for: a goal's plan, a re-plan note on a task, an org proposal. */
export type PlanningPurpose = "plan" | "replan" | "org";

export interface PlanningCall {
  companyId: string;
  /** The manager who made the call: Peter, or a department's lead. */
  teammateId: string;
  purpose: PlanningPurpose;
  /** The goal it planned, or the goal of the task it re-planned. */
  goalId?: string | null;
  /** The task it re-planned. */
  taskId?: string | null;
  /** The goal's or the task's project and department when the call was made; none for an org proposal. */
  projectId?: string | null;
  departmentId?: string | null;
  /** The model that answered. */
  model: string;
  usage: RunUsage;
}

/**
 * Every usage row, a run's or a manager's call, in one shape: `kind` is "run" or the call's purpose,
 * `runs` and `calls` count them apart. A filter on the outer query reaches both tables.
 */
export const USAGE_ROWS = `(
  SELECT company_id, created_at, 'run' AS kind, run_id, task_id, NULL::uuid AS goal_id, teammate_id, project_id,
         department_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         1 AS runs, 0 AS calls
  FROM run_usage
  UNION ALL
  SELECT company_id, created_at, purpose, NULL::uuid, task_id, goal_id, teammate_id, project_id,
         department_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         0, calls
  FROM planning_usage
)`;

/**
 * Record one call's tokens, then alert on every budget they took past 80% or 100%, as a run's usage does.
 * A call is not refused for a spent budget: the runs it plans are, at dispatch.
 */
export async function recordPlanningUsage(db: Db, call: PlanningCall): Promise<void> {
  const u = call.usage;
  await db.query(
    `INSERT INTO planning_usage (company_id, teammate_id, purpose, goal_id, task_id, project_id, department_id, model,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      call.companyId,
      call.teammateId,
      call.purpose,
      call.goalId ?? null,
      call.taskId ?? null,
      call.projectId ?? null,
      call.departmentId ?? null,
      call.model,
      u.inputTokens,
      u.outputTokens,
      u.cacheReadTokens,
      u.cacheWriteTokens,
    ],
  );
  const crossed = await budgetCrossings(
    db,
    {
      companyId: call.companyId,
      departmentId: call.departmentId ?? null,
      projectId: call.projectId ?? null,
      teammateId: call.teammateId,
      goalId: call.goalId ?? null,
    },
    totalTokens(u),
  );
  if (!crossed.length) return;
  await mutate(db, call.companyId, { kind: "teammate", id: call.teammateId }, async (ctx) => {
    for (const c of crossed) await emitBudgetAlert(ctx, c);
  });
}
