import {
  CreateDepartmentSchema,
  DepartmentMemberSchema,
  UpdateDepartmentSchema,
  type SandboxPreset,
} from "@rosterdock/shared";
import type { FastifyInstance } from "fastify";
import type { Db, Queryable } from "../db/pool.js";
import { HttpError, notFound } from "../http-error.js";
import type { MutationContext } from "../mutate.js";
import { mutate } from "../mutate.js";
import { assertCodexSeats, codexMembers, codexMisfit, codexRefused } from "../teammates/codex.js";
import { parseBody, uuidParam } from "../validate.js";

interface DepartmentRow {
  id: string;
  company_id: string;
  slug: string;
  name: string;
  write_policy: string;
  lead_teammate_id: string | null;
  sandbox: SandboxPreset;
  created_at: Date;
  updated_at: Date;
}

interface MemberRow {
  department_id: string;
  teammate_id: string;
  is_lead: boolean;
  name: string;
  handle: string;
  role: string;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function membersOf(
  db: Queryable,
  companyId: string,
  departmentId?: string,
): Promise<Map<string, MemberRow[]>> {
  const res = await db.query<MemberRow>(
    `SELECT dm.department_id, dm.teammate_id, dm.is_lead, t.name, t.handle, t.role
     FROM department_members dm JOIN teammates t ON t.id = dm.teammate_id
     WHERE dm.company_id = $1 AND ($2::uuid IS NULL OR dm.department_id = $2)
     ORDER BY dm.is_lead DESC, dm.created_at`,
    [companyId, departmentId ?? null],
  );
  const map = new Map<string, MemberRow[]>();
  for (const r of res.rows) {
    const list = map.get(r.department_id) ?? [];
    list.push(r);
    map.set(r.department_id, list);
  }
  return map;
}

function toJson(row: DepartmentRow, members: MemberRow[]) {
  return {
    id: row.id,
    companyId: row.company_id,
    slug: row.slug,
    name: row.name,
    writePolicy: row.write_policy,
    sandbox: row.sandbox ?? {},
    leadTeammateId: row.lead_teammate_id,
    members: members.map((m) => ({
      teammateId: m.teammate_id,
      isLead: m.is_lead,
      name: m.name,
      handle: m.handle,
      role: m.role,
    })),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function loadDepartment(db: Queryable, companyId: string, id: string): Promise<DepartmentRow> {
  const res = await db.query<DepartmentRow>("SELECT * FROM departments WHERE id = $1 AND company_id = $2", [
    id,
    companyId,
  ]);
  const row = res.rows[0];
  if (!row) throw notFound("department");
  return row;
}

async function assertTeammates(
  db: Queryable,
  companyId: string,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const res = await db.query<{ id: string; name: string }>(
    "SELECT id, name FROM teammates WHERE company_id = $1 AND id = ANY($2::uuid[])",
    [companyId, ids],
  );
  const found = new Map(res.rows.map((r) => [r.id, r.name]));
  for (const id of ids) if (!found.has(id)) throw new HttpError(422, `teammate ${id} is not in this company`);
  return found;
}

/** Set (or clear) the lead, demoting the previous lead to member. Emits department.lead_changed. */
async function setLead(
  ctx: MutationContext,
  dept: DepartmentRow,
  teammateId: string | null,
  names: Map<string, string>,
) {
  if (dept.lead_teammate_id === teammateId) return;
  await ctx.client.query("UPDATE department_members SET is_lead = false WHERE department_id = $1", [dept.id]);
  if (teammateId) {
    await ctx.client.query(
      `INSERT INTO department_members (company_id, department_id, teammate_id, is_lead) VALUES ($1, $2, $3, true)
       ON CONFLICT (department_id, teammate_id) DO UPDATE SET is_lead = true`,
      [ctx.companyId, dept.id, teammateId],
    );
  }
  await ctx.client.query("UPDATE departments SET lead_teammate_id = $2, updated_at = now() WHERE id = $1", [
    dept.id,
    teammateId,
  ]);
  await ctx.emit(
    "department.lead_changed",
    { kind: "department", id: dept.id },
    {
      name: dept.name,
      leadTeammateId: teammateId,
      leadName: teammateId ? (names.get(teammateId) ?? null) : null,
      previousLeadTeammateId: dept.lead_teammate_id,
    },
  );
  dept.lead_teammate_id = teammateId;
}

export function registerDepartmentRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/companies/:companyId/departments", { config: { action: "company.read" } }, async (req) => {
    const res = await db.query<DepartmentRow>(
      "SELECT * FROM departments WHERE company_id = $1 ORDER BY created_at",
      [req.companyId],
    );
    const members = await membersOf(db, req.companyId);
    return res.rows.map((r) => toJson(r, members.get(r.id) ?? []));
  });

  app.post(
    "/api/companies/:companyId/departments",
    { config: { action: "department.manage" } },
    async (req, reply) => {
      const body = parseBody(CreateDepartmentSchema, req.body);
      const { result } = await mutate(db, req.companyId, req.principal.actor, async (ctx) => {
        const slug = body.slug ?? slugify(body.name);
        if (!slug) throw new HttpError(422, "name needs at least one letter or digit");
        const dup = await ctx.client.query("SELECT 1 FROM departments WHERE company_id = $1 AND slug = $2", [
          req.companyId,
          slug,
        ]);
        if (dup.rowCount) throw new HttpError(409, `a department with the slug ${slug} already exists`);
        const ids = [
          ...new Set([...(body.leadTeammateId ? [body.leadTeammateId] : []), ...body.memberTeammateIds]),
        ];
        const names = await assertTeammates(ctx.client, req.companyId, ids);
        await assertCodexSeats(
          ctx.client,
          req.companyId,
          { id: null, name: body.name, sandbox: body.sandbox ?? null },
          ids,
        );
        const res = await ctx.client.query<DepartmentRow>(
          "INSERT INTO departments (company_id, slug, name, write_policy, sandbox) VALUES ($1, $2, $3, $4, $5) RETURNING *",
          [req.companyId, slug, body.name, body.writePolicy, JSON.stringify(body.sandbox ?? {})],
        );
        const dept = res.rows[0]!;
        for (const id of ids) {
          await ctx.client.query(
            "INSERT INTO department_members (company_id, department_id, teammate_id, is_lead) VALUES ($1, $2, $3, $4)",
            [req.companyId, dept.id, id, id === body.leadTeammateId],
          );
        }
        if (body.leadTeammateId) {
          await ctx.client.query("UPDATE departments SET lead_teammate_id = $2 WHERE id = $1", [
            dept.id,
            body.leadTeammateId,
          ]);
          dept.lead_teammate_id = body.leadTeammateId;
        }
        await ctx.emit(
          "department.created",
          { kind: "department", id: dept.id },
          {
            name: dept.name,
            writePolicy: dept.write_policy,
            leadTeammateId: dept.lead_teammate_id,
            leadName: dept.lead_teammate_id ? (names.get(dept.lead_teammate_id) ?? null) : null,
            memberCount: ids.length,
          },
        );
        return dept;
      });
      reply.code(201);
      const members = await membersOf(db, req.companyId, result.id);
      return toJson(result, members.get(result.id) ?? []);
    },
  );

  app.get(
    "/api/companies/:companyId/departments/:departmentId",
    { config: { action: "company.read" } },
    async (req) => {
      const id = uuidParam((req.params as { departmentId: string }).departmentId, "departmentId");
      const dept = await loadDepartment(db, req.companyId, id);
      const members = await membersOf(db, req.companyId, id);
      return toJson(dept, members.get(id) ?? []);
    },
  );

  app.patch(
    "/api/companies/:companyId/departments/:departmentId",
    { config: { action: "department.manage" } },
    async (req) => {
      const id = uuidParam((req.params as { departmentId: string }).departmentId, "departmentId");
      const body = parseBody(UpdateDepartmentSchema, req.body);
      const { result } = await mutate(db, req.companyId, req.principal.actor, async (ctx) => {
        const dept = await loadDepartment(ctx.client, req.companyId, id);
        // A tool list Codex cannot keep to would stop the Codex teammates who sit here: refused, unless it already did.
        const misfit = body.sandbox ? codexMisfit(body.sandbox) : null;
        if (misfit && !codexMisfit(dept.sandbox)) {
          const codex = await codexMembers(ctx.client, req.companyId, id);
          if (codex.length) throw codexRefused(codex, body.name ?? dept.name, misfit);
        }
        if (body.name !== undefined || body.writePolicy !== undefined || body.sandbox !== undefined) {
          const res = await ctx.client.query<DepartmentRow>(
            "UPDATE departments SET name = COALESCE($3, name), write_policy = COALESCE($4, write_policy), sandbox = COALESCE($5::jsonb, sandbox), updated_at = now() WHERE id = $1 AND company_id = $2 RETURNING *",
            [
              id,
              req.companyId,
              body.name ?? null,
              body.writePolicy ?? null,
              body.sandbox ? JSON.stringify(body.sandbox) : null,
            ],
          );
          Object.assign(dept, res.rows[0]);
          await ctx.emit(
            "department.updated",
            { kind: "department", id },
            {
              name: dept.name,
              writePolicy: dept.write_policy,
              changes: Object.keys(body),
              // The web sites its runs may read, when the change sets the sandbox.
              ...(body.sandbox ? { webDomains: body.sandbox.webDomains ?? null } : {}),
            },
          );
        }
        if (body.leadTeammateId !== undefined) {
          const ids = body.leadTeammateId ? [body.leadTeammateId] : [];
          const names = await assertTeammates(ctx.client, req.companyId, ids);
          await assertCodexSeats(ctx.client, req.companyId, dept, ids);
          await setLead(ctx, dept, body.leadTeammateId, names);
        }
        if (ctx.events.length === 0) {
          await ctx.emit("department.updated", { kind: "department", id }, { name: dept.name, changes: [] });
        }
        return dept;
      });
      const members = await membersOf(db, req.companyId, id);
      return toJson(result, members.get(id) ?? []);
    },
  );

  // Dissolving a department with open tasks is refused; teammates keep their toolboxes.
  app.delete(
    "/api/companies/:companyId/departments/:departmentId",
    { config: { action: "department.manage" } },
    async (req) => {
      const id = uuidParam((req.params as { departmentId: string }).departmentId, "departmentId");
      await mutate(db, req.companyId, req.principal.actor, async (ctx) => {
        const dept = await loadDepartment(ctx.client, req.companyId, id);
        const open = await ctx.client.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM tasks WHERE company_id = $1 AND department_id = $2 AND status NOT IN ('done', 'cancelled')",
          [req.companyId, id],
        );
        const n = open.rows[0]?.n ?? 0;
        if (n > 0)
          throw new HttpError(
            409,
            `${dept.name} still has ${n} open task${n === 1 ? "" : "s"}. Move or finish them first.`,
          );
        await ctx.client.query("DELETE FROM departments WHERE id = $1 AND company_id = $2", [
          id,
          req.companyId,
        ]);
        await ctx.emit("department.deleted", { kind: "department", id }, { name: dept.name });
      });
      return { ok: true };
    },
  );

  // Matrix cell: add as member, or promote to lead with isLead=true.
  app.put(
    "/api/companies/:companyId/departments/:departmentId/members/:teammateId",
    { config: { action: "department.manage" } },
    async (req) => {
      const params = req.params as { departmentId: string; teammateId: string };
      const departmentId = uuidParam(params.departmentId, "departmentId");
      const teammateId = uuidParam(params.teammateId, "teammateId");
      const body = parseBody(DepartmentMemberSchema.omit({ teammateId: true }), req.body);
      const { result } = await mutate(db, req.companyId, req.principal.actor, async (ctx) => {
        const dept = await loadDepartment(ctx.client, req.companyId, departmentId);
        const names = await assertTeammates(ctx.client, req.companyId, [teammateId]);
        await assertCodexSeats(ctx.client, req.companyId, dept, [teammateId]);
        const existing = await ctx.client.query(
          "SELECT 1 FROM department_members WHERE department_id = $1 AND teammate_id = $2",
          [departmentId, teammateId],
        );
        if (!existing.rowCount) {
          await ctx.client.query(
            "INSERT INTO department_members (company_id, department_id, teammate_id, is_lead) VALUES ($1, $2, $3, false)",
            [req.companyId, departmentId, teammateId],
          );
          await ctx.emit(
            "department.member_added",
            { kind: "department", id: departmentId },
            { name: dept.name, teammateId, teammateName: names.get(teammateId) },
          );
        }
        if (body.isLead) await setLead(ctx, dept, teammateId, names);
        else if (dept.lead_teammate_id === teammateId) await setLead(ctx, dept, null, names);
        if (ctx.events.length === 0) {
          await ctx.emit(
            "department.updated",
            { kind: "department", id: departmentId },
            { name: dept.name, changes: [] },
          );
        }
        return dept;
      });
      const members = await membersOf(db, req.companyId, departmentId);
      return toJson(result, members.get(departmentId) ?? []);
    },
  );

  app.delete(
    "/api/companies/:companyId/departments/:departmentId/members/:teammateId",
    { config: { action: "department.manage" } },
    async (req) => {
      const params = req.params as { departmentId: string; teammateId: string };
      const departmentId = uuidParam(params.departmentId, "departmentId");
      const teammateId = uuidParam(params.teammateId, "teammateId");
      const { result } = await mutate(db, req.companyId, req.principal.actor, async (ctx) => {
        const dept = await loadDepartment(ctx.client, req.companyId, departmentId);
        const names = await assertTeammates(ctx.client, req.companyId, [teammateId]);
        if (dept.lead_teammate_id === teammateId) await setLead(ctx, dept, null, names);
        const res = await ctx.client.query(
          "DELETE FROM department_members WHERE department_id = $1 AND teammate_id = $2",
          [departmentId, teammateId],
        );
        if (!res.rowCount) throw notFound("membership");
        await ctx.emit(
          "department.member_removed",
          { kind: "department", id: departmentId },
          { name: dept.name, teammateId, teammateName: names.get(teammateId) },
        );
        return dept;
      });
      const members = await membersOf(db, req.companyId, departmentId);
      return toJson(result, members.get(departmentId) ?? []);
    },
  );
}
