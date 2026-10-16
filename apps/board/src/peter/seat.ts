// Peter's seat. Peter is a teammate like any other: his actions on the board
// carry his (teammate, id) actor, his tokens are counted, and the same guard
// applies. He is seated when a company is created, from the global template,
// so he is present from the first minute. A department with a lead has that
// lead as its Peter: a project-manager instance scoped to the department.

import type { Queryable } from "../db/pool.js";
import type { MutationContext } from "../mutate.js";

export const PETER_TEMPLATE_ID = "00000000-0000-4000-8000-000000000001";

export interface Manager {
  id: string;
  name: string;
  handle: string;
  model: string;
  /** How hard the manager's model thinks when planning; null: the default. */
  effort: string | null;
  /** Null for the company Peter; the department a lead manages. */
  departmentId: string | null;
}

/** The company's project manager: handle `peter`, or the first teammate whose role says so. */
export async function companyManager(db: Queryable, companyId: string): Promise<Manager | null> {
  const res = await db.query<{
    id: string;
    name: string;
    handle: string;
    model: string;
    effort: string | null;
  }>(
    `SELECT id, name, handle, model, effort FROM teammates
     WHERE company_id = $1 AND (handle = 'peter' OR role ILIKE '%project manager%')
     ORDER BY (handle = 'peter') DESC, created_at LIMIT 1`,
    [companyId],
  );
  const row = res.rows[0];
  return row ? { ...row, departmentId: null } : null;
}

/**
 * Who manages work in a department: its lead when it has one, else the
 * company Peter. Department leads are Peter instances scoped to their
 * department; the company Peter routes goals to them.
 */
export async function managerFor(
  db: Queryable,
  companyId: string,
  departmentId: string | null | undefined,
): Promise<Manager | null> {
  if (departmentId) {
    const res = await db.query<{
      id: string;
      name: string;
      handle: string;
      model: string;
      effort: string | null;
    }>(
      `SELECT t.id, t.name, t.handle, t.model, t.effort FROM departments d JOIN teammates t ON t.id = d.lead_teammate_id
       WHERE d.id = $1 AND d.company_id = $2`,
      [departmentId, companyId],
    );
    const lead = res.rows[0];
    if (lead) return { ...lead, departmentId };
  }
  return companyManager(db, companyId);
}

/**
 * Who manages one task: the department's lead, unless the lead is the
 * assignee (nobody manages their own task), then the company Peter.
 */
export async function managerForTask(
  db: Queryable,
  companyId: string,
  task: { department_id: string | null; assignee_id: string | null },
): Promise<Manager | null> {
  const manager = await managerFor(db, companyId, task.department_id);
  if (manager && manager.departmentId && manager.id === task.assignee_id)
    return companyManager(db, companyId);
  return manager;
}

/** Seat Peter from the global template if the company has no project manager yet. */
export async function ensurePeter(ctx: MutationContext): Promise<Manager> {
  const existing = await companyManager(ctx.client, ctx.companyId);
  if (existing) return existing;
  const tpl = (
    await ctx.client.query<{
      name: string;
      role: string;
      persona_md: string;
      playbooks: unknown;
      engine: string;
      model: string;
      avatar: string | null;
    }>(
      "SELECT name, role, persona_md, playbooks, engine, model, avatar FROM teammate_templates WHERE id = $1",
      [PETER_TEMPLATE_ID],
    )
  ).rows[0];
  const t = tpl ?? {
    name: "Peter",
    role: "project manager",
    persona_md: "",
    playbooks: [],
    engine: "claude_code",
    model: "claude-opus-5",
    avatar: "P",
  };
  const inserted = await ctx.client.query<{
    id: string;
    name: string;
    handle: string;
    model: string;
    effort: string | null;
  }>(
    `INSERT INTO teammates (company_id, template_id, name, handle, role, persona_md, playbooks, engine, model, avatar)
     VALUES ($1, $2, $3, 'peter', $4, $5, $6, $7, $8, $9) RETURNING id, name, handle, model`,
    [
      ctx.companyId,
      tpl ? PETER_TEMPLATE_ID : null,
      t.name,
      t.role,
      t.persona_md,
      JSON.stringify(t.playbooks ?? []),
      t.engine,
      t.model,
      t.avatar ?? "P",
    ],
  );
  const row = inserted.rows[0]!;
  await ctx.emit(
    "teammate.created",
    { kind: "teammate", id: row.id },
    { name: row.name, role: t.role, engine: t.engine, model: t.model, seated: "with the company" },
  );
  return { ...row, departmentId: null };
}
