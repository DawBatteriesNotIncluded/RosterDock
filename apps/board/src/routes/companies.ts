import { CreateCompanySchema, GrantMembershipSchema, UpdateCompanySchema } from "@rosterdock/shared";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { Db } from "../db/pool.js";
import { withTransaction } from "../db/pool.js";
import { HttpError, notFound } from "../http-error.js";
import { mutate } from "../mutate.js";
import { notifySettings } from "../notify/notify.js";
import { assertCompanyEnvNames, companyCreationRefusal, type OperatorPolicy } from "../operator.js";
import { ensurePeter } from "../peter/seat.js";
import { parseBody, uuidParam } from "../validate.js";

interface CompanyRow {
  id: string;
  name: string;
  template: string | null;
  budget_tokens_week: number | null;
  settings: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export async function loadCompany(db: Db, companyId: string): Promise<CompanyRow> {
  const res = await db.query<CompanyRow>("SELECT * FROM companies WHERE id = $1", [companyId]);
  const row = res.rows[0];
  if (!row) throw notFound("company");
  return row;
}

export function companyToJson(row: CompanyRow) {
  return {
    id: row.id,
    name: row.name,
    template: row.template,
    budgetTokensWeek: row.budget_tokens_week,
    settings: row.settings,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// The company's owners, locked in one order, so two owners who demote or remove each other at once cannot
// both count the other and leave the company with none.
async function lockOwners(client: pg.PoolClient, companyId: string): Promise<string[]> {
  const res = await client.query<{ user_id: string }>(
    "SELECT user_id FROM memberships WHERE company_id = $1 AND role = 'owner' ORDER BY user_id FOR UPDATE",
    [companyId],
  );
  return res.rows.map((r) => r.user_id);
}

export function registerCompanyRoutes(app: FastifyInstance, db: Db, operator: OperatorPolicy): void {
  // Companies the caller belongs to. Teammates see only their own company.
  app.get("/api/companies", { config: {} }, async (req) => {
    const p = req.principal;
    if (p.kind === "teammate") {
      const res = await db.query<CompanyRow>("SELECT * FROM companies WHERE id = $1", [
        p.teammate.company_id,
      ]);
      return res.rows.map((r) => ({ ...companyToJson(r), role: "teammate" }));
    }
    const res = await db.query<CompanyRow & { role: string }>(
      `SELECT c.*, m.role FROM companies c JOIN memberships m ON m.company_id = c.id
       WHERE m.user_id = $1 ORDER BY c.created_at`,
      [p.actor.id],
    );
    return res.rows.map((r) => ({ ...companyToJson(r), role: r.role }));
  });

  // Only a person creates a company, one the operator allows (operator.ts); they become its owner. Peter
  // proposes companies and departments as drafts that a person accepts.
  app.post("/api/companies", { config: {} }, async (req, reply) => {
    const p = req.principal;
    if (p.kind !== "user") throw new HttpError(403, "only a person can create a company");
    const body = parseBody(CreateCompanySchema, req.body);
    // The counter row must exist before the first event; then the rest is a normal mutation.
    const company = await withTransaction(db, async (client) => {
      const refusal = await companyCreationRefusal(client, operator, p.user.email, true);
      if (refusal) throw new HttpError(403, refusal);
      const created = await client.query<CompanyRow>(
        "INSERT INTO companies (name, template, budget_tokens_week) VALUES ($1, $2, $3) RETURNING *",
        [body.name, body.template ?? null, body.budgetTokensWeek ?? null],
      );
      const row = created.rows[0]!;
      await client.query("INSERT INTO company_counters (company_id) VALUES ($1)", [row.id]);
      return row;
    });
    await mutate(db, company.id, p.actor, async (ctx) => {
      await ctx.client.query("INSERT INTO memberships (company_id, user_id, role) VALUES ($1, $2, 'owner')", [
        company.id,
        p.actor.id,
      ]);
      await ctx.emit(
        "company.created",
        { kind: "company", id: company.id },
        { name: company.name, template: company.template },
      );
      await ctx.emit(
        "membership.granted",
        { kind: "user", id: p.actor.id },
        { role: "owner", name: p.user.name },
      );
      // Peter is present from the first minute.
      await ensurePeter(ctx);
    });
    reply.code(201);
    return { ...companyToJson(company), role: "owner" };
  });

  app.get("/api/companies/:companyId", { config: { action: "company.read" } }, async (req) => {
    const res = await db.query<CompanyRow>("SELECT * FROM companies WHERE id = $1", [req.companyId]);
    const row = res.rows[0];
    if (!row) throw notFound("company");
    return { ...companyToJson(row), role: req.companyRole };
  });

  // The office pack (`settings.officePack`) is written by its own routes only; a PATCH keeps what is there.
  app.patch("/api/companies/:companyId", { config: { action: "company.update" } }, async (req) => {
    const body = parseBody(UpdateCompanySchema, req.body);
    // A notification name this change writes must be one the company can have; one already there stays.
    const notify = body.settings?.notify;
    if (notify) {
      const was = notifySettings((await loadCompany(db, req.companyId)).settings);
      await assertCompanyEnvNames(operator, req.companyId, [
        notify.webhookEnvName !== was.webhookEnvName ? notify.webhookEnvName : null,
        notify.email?.smtpUrlEnvName !== was.email?.smtpUrlEnvName ? notify.email?.smtpUrlEnvName : null,
      ]);
    }
    const { result } = await mutate(db, req.companyId, req.principal.actor, async (ctx) => {
      const res = await ctx.client.query<CompanyRow>(
        `UPDATE companies SET name = COALESCE($2, name),
           budget_tokens_week = CASE WHEN $3::boolean THEN $4 ELSE budget_tokens_week END,
           settings = CASE WHEN $5::jsonb IS NULL THEN settings
             ELSE ($5::jsonb - 'officePack') || CASE WHEN settings ? 'officePack'
               THEN jsonb_build_object('officePack', settings->'officePack') ELSE '{}'::jsonb END END,
           updated_at = now()
         WHERE id = $1 RETURNING *`,
        [
          req.companyId,
          body.name ?? null,
          body.budgetTokensWeek !== undefined,
          body.budgetTokensWeek ?? null,
          body.settings ? JSON.stringify(body.settings) : null,
        ],
      );
      const row = res.rows[0];
      if (!row) throw notFound("company");
      await ctx.emit("company.updated", { kind: "company", id: row.id }, { changes: Object.keys(body) });
      return row;
    });
    return { ...companyToJson(result), role: req.companyRole };
  });

  app.get("/api/companies/:companyId/members", { config: { action: "company.read" } }, async (req) => {
    const res = await db.query<{
      user_id: string;
      role: string;
      email: string;
      name: string;
      created_at: Date;
    }>(
      `SELECT m.user_id, m.role, u.email, u.name, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.company_id = $1 ORDER BY m.created_at`,
      [req.companyId],
    );
    return res.rows.map((r) => ({
      userId: r.user_id,
      role: r.role,
      email: r.email,
      name: r.name,
      since: r.created_at.toISOString(),
    }));
  });

  app.post(
    "/api/companies/:companyId/members",
    { config: { action: "membership.manage" } },
    async (req, reply) => {
      const body = parseBody(GrantMembershipSchema, req.body);
      if (body.role === "owner" && req.companyRole !== "owner")
        throw new HttpError(403, "only an owner can grant owner");
      const { result } = await mutate(db, req.companyId, req.principal.actor, async (ctx) => {
        const user = await ctx.client.query<{ id: string; name: string }>(
          `INSERT INTO users (email, name) VALUES ($1, $2)
         ON CONFLICT ((lower(email))) DO UPDATE SET updated_at = now() RETURNING id, name`,
          [body.email, body.email.split("@")[0] ?? body.email],
        );
        const u = user.rows[0]!;
        const owners = await lockOwners(ctx.client, req.companyId);
        if (owners.includes(u.id) && body.role !== "owner") {
          if (req.companyRole !== "owner")
            throw new HttpError(403, "only an owner can change an owner's role");
          if (owners.length <= 1) throw new HttpError(409, "a company keeps at least one owner");
        }
        await ctx.client.query(
          `INSERT INTO memberships (company_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (company_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
          [req.companyId, u.id, body.role],
        );
        await ctx.emit(
          "membership.granted",
          { kind: "user", id: u.id },
          { role: body.role, name: u.name, email: body.email },
        );
        return { userId: u.id, role: body.role, email: body.email, name: u.name };
      });
      reply.code(201);
      return result;
    },
  );

  app.delete(
    "/api/companies/:companyId/members/:userId",
    { config: { action: "membership.manage" } },
    async (req) => {
      const userId = uuidParam((req.params as { userId: string }).userId, "userId");
      await mutate(db, req.companyId, req.principal.actor, async (ctx) => {
        const existing = await ctx.client.query<{ role: string }>(
          "SELECT role FROM memberships WHERE company_id = $1 AND user_id = $2",
          [req.companyId, userId],
        );
        const role = existing.rows[0]?.role;
        if (!role) throw notFound("membership");
        if (role === "owner") {
          if (req.companyRole !== "owner") throw new HttpError(403, "only an owner can remove an owner");
          const owners = await lockOwners(ctx.client, req.companyId);
          if (owners.length <= 1) throw new HttpError(409, "a company keeps at least one owner");
        }
        await ctx.client.query("DELETE FROM memberships WHERE company_id = $1 AND user_id = $2", [
          req.companyId,
          userId,
        ]);
        await ctx.emit("membership.revoked", { kind: "user", id: userId }, { role });
      });
      return { ok: true };
    },
  );
}
