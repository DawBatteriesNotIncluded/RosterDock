import {
  CreateTeammateSchema,
  type Effort,
  handleFor,
  MintTeammateTokenSchema,
  type ToolboxEntry,
  UpdateTeammateSchema,
} from "@rosterdock/shared";
import type { FastifyInstance } from "fastify";
import { mintApiToken } from "../auth/tokens.js";
import type { Db, Queryable } from "../db/pool.js";
import { HttpError, notFound } from "../http-error.js";
import { mutate } from "../mutate.js";
import { assertCodexEngine } from "../teammates/codex.js";
import { listInbox } from "../teammates/inbox.js";
import { parseBody, uuidParam } from "../validate.js";

export interface TeammateRow {
  id: string;
  company_id: string;
  template_id: string | null;
  name: string;
  handle: string;
  role: string;
  persona_md: string;
  playbooks: string[];
  engine: string;
  model: string;
  avatar: string | null;
  effort: string | null;
  toolbox: ToolboxEntry[];
  created_at: Date;
  updated_at: Date;
}

export function teammateToJson(
  row: TeammateRow,
  departments: { id: string; name: string; isLead: boolean }[] = [],
) {
  return {
    id: row.id,
    companyId: row.company_id,
    templateId: row.template_id,
    name: row.name,
    handle: row.handle,
    role: row.role,
    personaMd: row.persona_md,
    playbooks: row.playbooks,
    engine: row.engine,
    model: row.model,
    effort: row.effort,
    avatar: row.avatar,
    toolbox: row.toolbox ?? [],
    departments,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Every connection a toolbox names must exist in the company; a mode on a name nobody knows is a typo. A
 * line that picks tools must pick ones the connection knows, once it knows any (before discovery, names
 * are taken on trust and checked at call time).
 */
async function assertToolbox(db: Queryable, companyId: string, toolbox: ToolboxEntry[]): Promise<void> {
  if (!toolbox.length) return;
  const names = [...new Set(toolbox.map((t) => t.connection))];
  if (names.length !== toolbox.length) throw new HttpError(422, "a connection appears twice in the toolbox");
  const res = await db.query<{ name: string; tools: { name: string }[] | null }>(
    "SELECT name, tools FROM connections WHERE company_id = $1 AND name = ANY($2::text[])",
    [companyId, names],
  );
  const known = new Map(res.rows.map((r) => [r.name, new Set((r.tools ?? []).map((t) => t.name))]));
  for (const entry of toolbox) {
    const tools = known.get(entry.connection);
    if (!tools) throw new HttpError(422, `no connection named ${entry.connection} in this company`);
    if (!entry.tools) continue;
    if (new Set(entry.tools).size !== entry.tools.length)
      throw new HttpError(422, `a tool appears twice for ${entry.connection}`);
    if (tools.size)
      for (const t of entry.tools)
        if (!tools.has(t)) throw new HttpError(422, `no tool named ${t} on ${entry.connection}`);
  }
}

async function departmentsOf(db: Queryable, companyId: string) {
  const res = await db.query<{ teammate_id: string; id: string; name: string; is_lead: boolean }>(
    `SELECT dm.teammate_id, d.id, d.name, dm.is_lead FROM department_members dm JOIN departments d ON d.id = dm.department_id
     WHERE dm.company_id = $1 ORDER BY d.created_at`,
    [companyId],
  );
  const map = new Map<string, { id: string; name: string; isLead: boolean }[]>();
  for (const r of res.rows) {
    const list = map.get(r.teammate_id) ?? [];
    list.push({ id: r.id, name: r.name, isLead: r.is_lead });
    map.set(r.teammate_id, list);
  }
  return map;
}

type TemplateRow = Pick<
  TeammateRow,
  | "id"
  | "company_id"
  | "name"
  | "role"
  | "persona_md"
  | "playbooks"
  | "engine"
  | "model"
  | "avatar"
  | "effort"
>;

const TEMPLATE_SELECT =
  "SELECT id, company_id, name, role, persona_md, playbooks, engine, model, avatar, effort FROM teammate_templates";

function templateToJson(r: TemplateRow) {
  return {
    id: r.id,
    companyId: r.company_id,
    name: r.name,
    role: r.role,
    personaMd: r.persona_md,
    playbooks: r.playbooks,
    engine: r.engine,
    model: r.model,
    avatar: r.avatar,
  };
}

export function registerTeammateRoutes(app: FastifyInstance, db: Db): void {
  // The built-in templates, for anyone signed in. A company's own come only through the company below.
  app.get("/api/templates/teammates", { config: {} }, async () => {
    const res = await db.query<TemplateRow>(`${TEMPLATE_SELECT} WHERE company_id IS NULL ORDER BY name`);
    return res.rows.map(templateToJson);
  });

  // What the company hires from: the built-in templates, then the ones its files imported.
  app.get(
    "/api/companies/:companyId/templates/teammates",
    { config: { action: "company.read" } },
    async (req) => {
      const res = await db.query<TemplateRow>(
        `${TEMPLATE_SELECT} WHERE company_id IS NULL OR company_id = $1 ORDER BY company_id NULLS FIRST, name`,
        [req.companyId],
      );
      return res.rows.map(templateToJson);
    },
  );

  app.get("/api/companies/:companyId/teammates", { config: { action: "company.read" } }, async (req) => {
    const res = await db.query<TeammateRow>(
      "SELECT * FROM teammates WHERE company_id = $1 ORDER BY created_at",
      [req.companyId],
    );
    const depts = await departmentsOf(db, req.companyId);
    return res.rows.map((r) => teammateToJson(r, depts.get(r.id) ?? []));
  });

  app.post(
    "/api/companies/:companyId/teammates",
    { config: { action: "teammate.manage" } },
    async (req, reply) => {
      const body = parseBody(CreateTeammateSchema, req.body);
      const { result } = await mutate(db, req.companyId, req.principal.actor, async (ctx) => {
        let fields = { ...body };
        if (body.templateId) {
          const tpl = await ctx.client.query<TeammateRow>(
            "SELECT * FROM teammate_templates WHERE id = $1 AND (company_id IS NULL OR company_id = $2)",
            [body.templateId, req.companyId],
          );
          const t = tpl.rows[0];
          if (!t) throw new HttpError(422, "template not found");
          fields = {
            ...fields,
            role: body.role || t.role,
            engine: body.engine,
            model: body.model || t.model,
            effort: body.effort !== undefined ? body.effort : (t.effort as Effort | null),
            personaMd: body.personaMd || t.persona_md,
            playbooks: body.playbooks.length ? body.playbooks : t.playbooks,
            avatar: body.avatar ?? t.avatar ?? undefined,
          };
        }
        const handle = handleFor(fields.name);
        if (!handle) throw new HttpError(422, "name needs at least one letter or digit");
        const dup = await ctx.client.query("SELECT 1 FROM teammates WHERE company_id = $1 AND handle = $2", [
          req.companyId,
          handle,
        ]);
        if (dup.rowCount) throw new HttpError(409, `a teammate with the handle @${handle} already exists`);
        await assertToolbox(ctx.client, req.companyId, body.toolbox);
        const res = await ctx.client.query<TeammateRow>(
          `INSERT INTO teammates (company_id, template_id, name, handle, role, persona_md, playbooks, engine, model, avatar, toolbox, effort)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
          [
            req.companyId,
            body.templateId ?? null,
            fields.name,
            handle,
            fields.role,
            fields.personaMd,
            JSON.stringify(fields.playbooks),
            fields.engine,
            fields.model,
            fields.avatar ?? fields.name.slice(0, 1).toUpperCase(),
            JSON.stringify(body.toolbox),
            fields.effort ?? null,
          ],
        );
        const row = res.rows[0]!;
        await ctx.emit(
          "teammate.created",
          { kind: "teammate", id: row.id },
          { name: row.name, role: row.role, engine: row.engine, model: row.model, toolbox: row.toolbox },
        );
        return row;
      });
      reply.code(201);
      return teammateToJson(result);
    },
  );

  app.get(
    "/api/companies/:companyId/teammates/:teammateId",
    { config: { action: "company.read" } },
    async (req) => {
      const id = uuidParam((req.params as { teammateId: string }).teammateId, "teammateId");
      const res = await db.query<TeammateRow>("SELECT * FROM teammates WHERE id = $1 AND company_id = $2", [
        id,
        req.companyId,
      ]);
      const row = res.rows[0];
      if (!row) throw notFound("teammate");
      const depts = await departmentsOf(db, req.companyId);
      return teammateToJson(row, depts.get(row.id) ?? []);
    },
  );

  // What is addressed to the teammate, newest first; new since their last run started.
  app.get(
    "/api/companies/:companyId/teammates/:teammateId/inbox",
    { config: { action: "company.read" } },
    async (req) => {
      const id = uuidParam((req.params as { teammateId: string }).teammateId, "teammateId");
      const exists = await db.query("SELECT 1 FROM teammates WHERE id = $1 AND company_id = $2", [
        id,
        req.companyId,
      ]);
      if (!exists.rowCount) throw notFound("teammate");
      const q = req.query as { limit?: string };
      return listInbox(db, req.companyId, id, { limit: q.limit ? Number(q.limit) : undefined });
    },
  );

  app.patch(
    "/api/companies/:companyId/teammates/:teammateId",
    { config: { action: "teammate.manage" } },
    async (req) => {
      const id = uuidParam((req.params as { teammateId: string }).teammateId, "teammateId");
      const body = parseBody(UpdateTeammateSchema, req.body);
      const { result } = await mutate(db, req.companyId, req.principal.actor, async (ctx) => {
        const handle = body.name ? handleFor(body.name) : null;
        if (handle !== null) {
          const dup = await ctx.client.query(
            "SELECT 1 FROM teammates WHERE company_id = $1 AND handle = $2 AND id <> $3",
            [req.companyId, handle, id],
          );
          if (dup.rowCount) throw new HttpError(409, `a teammate with the handle @${handle} already exists`);
        }
        if (body.toolbox) await assertToolbox(ctx.client, req.companyId, body.toolbox);
        if (body.engine === "codex") await assertCodexEngine(ctx.client, req.companyId, id);
        const res = await ctx.client.query<TeammateRow>(
          `UPDATE teammates SET
           name = COALESCE($3, name), handle = COALESCE($4, handle), role = COALESCE($5, role),
           persona_md = COALESCE($6, persona_md), playbooks = COALESCE($7::jsonb, playbooks),
           engine = COALESCE($8, engine), model = COALESCE($9, model), avatar = COALESCE($10, avatar),
           toolbox = COALESCE($11::jsonb, toolbox),
           effort = CASE WHEN $12::boolean THEN $13 ELSE effort END, updated_at = now()
         WHERE id = $1 AND company_id = $2 RETURNING *`,
          [
            id,
            req.companyId,
            body.name ?? null,
            handle,
            body.role ?? null,
            body.personaMd ?? null,
            body.playbooks ? JSON.stringify(body.playbooks) : null,
            body.engine ?? null,
            body.model ?? null,
            body.avatar ?? null,
            body.toolbox ? JSON.stringify(body.toolbox) : null,
            body.effort !== undefined,
            body.effort ?? null,
          ],
        );
        const row = res.rows[0];
        if (!row) throw notFound("teammate");
        await ctx.emit(
          "teammate.updated",
          { kind: "teammate", id: row.id },
          { name: row.name, changes: Object.keys(body), ...(body.toolbox ? { toolbox: row.toolbox } : {}) },
        );
        return row;
      });
      const depts = await departmentsOf(db, req.companyId);
      return teammateToJson(result, depts.get(result.id) ?? []);
    },
  );

  app.delete(
    "/api/companies/:companyId/teammates/:teammateId",
    { config: { action: "teammate.manage" } },
    async (req) => {
      const id = uuidParam((req.params as { teammateId: string }).teammateId, "teammateId");
      await mutate(db, req.companyId, req.principal.actor, async (ctx) => {
        const open = await ctx.client.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM tasks WHERE company_id = $1 AND assignee_kind = 'teammate' AND assignee_id = $2 AND status NOT IN ('done', 'cancelled')",
          [req.companyId, id],
        );
        if ((open.rows[0]?.n ?? 0) > 0) throw new HttpError(409, "reassign this teammate's open tasks first");
        const res = await ctx.client.query<{ name: string }>(
          "DELETE FROM teammates WHERE id = $1 AND company_id = $2 RETURNING name",
          [id, req.companyId],
        );
        const row = res.rows[0];
        if (!row) throw notFound("teammate");
        await ctx.emit("teammate.deleted", { kind: "teammate", id }, { name: row.name });
      });
      return { ok: true };
    },
  );

  // A bearer token that lets this teammate act on the board as itself. Shown once.
  app.post(
    "/api/companies/:companyId/teammates/:teammateId/tokens",
    { config: { action: "teammate.token" } },
    async (req, reply) => {
      const id = uuidParam((req.params as { teammateId: string }).teammateId, "teammateId");
      const body = parseBody(MintTeammateTokenSchema, req.body);
      const { result } = await mutate(db, req.companyId, req.principal.actor, async (ctx) => {
        const t = await ctx.client.query<{ name: string }>(
          "SELECT name FROM teammates WHERE id = $1 AND company_id = $2",
          [id, req.companyId],
        );
        if (!t.rows[0]) throw notFound("teammate");
        const minted = await mintApiToken(ctx.client, {
          companyId: req.companyId,
          actor: { kind: "teammate", id },
          ttlSeconds: body.ttlSeconds,
          label: body.label,
          createdByUserId: req.principal.actor.kind === "user" ? req.principal.actor.id : undefined,
          scopes: body.scope === "manager" ? ["manager"] : [],
        });
        await ctx.emit(
          "teammate.token_minted",
          { kind: "teammate", id },
          {
            name: t.rows[0].name,
            tokenId: minted.id,
            expiresAt: minted.expiresAt,
            label: body.label ?? null,
            scope: body.scope,
          },
        );
        return minted;
      });
      reply.code(201);
      return result;
    },
  );
}
