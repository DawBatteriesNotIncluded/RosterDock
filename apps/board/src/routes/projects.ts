import { CreateProjectSchema, UpdateProjectSchema, type ClientPolicy } from "@rosterdock/shared";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/pool.js";
import { notFound } from "../http-error.js";
import { mutate } from "../mutate.js";
import { parseBody, uuidParam } from "../validate.js";

interface ProjectRow {
  id: string;
  company_id: string;
  name: string;
  client: string;
  goal: string;
  status: string;
  repo_url: string | null;
  default_branch: string;
  client_policy: ClientPolicy;
  chargeback_tag: string | null;
  created_at: Date;
  updated_at: Date;
}

interface Counts {
  open: number;
  running: number;
  blocked: number;
  review: number;
  done: number;
}

function toJson(row: ProjectRow, counts?: Counts) {
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    client: row.client,
    goal: row.goal,
    status: row.status,
    repoUrl: row.repo_url,
    defaultBranch: row.default_branch,
    clientPolicy: {
      default: row.client_policy?.default ?? null,
      caps: row.client_policy?.caps ?? {},
      // The web sites the client lets the web connection read, when it names some.
      ...(row.client_policy?.webDomains?.length ? { webDomains: row.client_policy.webDomains } : {}),
    },
    chargebackTag: row.chargeback_tag,
    counts: counts ?? { open: 0, running: 0, blocked: 0, review: 0, done: 0 },
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// Where a project's work goes and what its client allows: a teammate opens and renames projects, and a
// request of its that names one of these is refused whole.
const SETTINGS = {
  repoUrl: "project.configure",
  defaultBranch: "project.configure",
  clientPolicy: "project.configure",
} as const;

export function registerProjectRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/companies/:companyId/projects", { config: { action: "company.read" } }, async (req) => {
    const res = await db.query<ProjectRow & Counts>(
      `SELECT p.*,
         count(t.id) FILTER (WHERE t.status NOT IN ('done', 'cancelled'))::int AS open,
         count(t.id) FILTER (WHERE t.status = 'doing')::int AS running,
         count(t.id) FILTER (WHERE t.status = 'blocked')::int AS blocked,
         count(t.id) FILTER (WHERE t.status = 'review')::int AS review,
         count(t.id) FILTER (WHERE t.status = 'done')::int AS done
       FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
       WHERE p.company_id = $1 GROUP BY p.id ORDER BY p.created_at`,
      [req.companyId],
    );
    return res.rows.map((r) =>
      toJson(r, { open: r.open, running: r.running, blocked: r.blocked, review: r.review, done: r.done }),
    );
  });

  app.post(
    "/api/companies/:companyId/projects",
    { config: { action: "project.manage", fieldActions: SETTINGS } },
    async (req, reply) => {
      const body = parseBody(CreateProjectSchema, req.body);
      const { result } = await mutate(db, req.companyId, req.principal.actor, async (ctx) => {
        const res = await ctx.client.query<ProjectRow>(
          "INSERT INTO projects (company_id, name, client, goal, repo_url, default_branch, client_policy, chargeback_tag) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *",
          [
            req.companyId,
            body.name,
            body.client,
            body.goal,
            body.repoUrl ?? null,
            body.defaultBranch,
            JSON.stringify(body.clientPolicy ?? {}),
            body.chargebackTag?.trim() || null,
          ],
        );
        const row = res.rows[0]!;
        await ctx.emit(
          "project.created",
          { kind: "project", id: row.id },
          { name: row.name, client: row.client },
        );
        return row;
      });
      reply.code(201);
      return toJson(result);
    },
  );

  app.get(
    "/api/companies/:companyId/projects/:projectId",
    { config: { action: "company.read" } },
    async (req) => {
      const id = uuidParam((req.params as { projectId: string }).projectId, "projectId");
      const res = await db.query<ProjectRow>("SELECT * FROM projects WHERE id = $1 AND company_id = $2", [
        id,
        req.companyId,
      ]);
      const row = res.rows[0];
      if (!row) throw notFound("project");
      return toJson(row);
    },
  );

  app.patch(
    "/api/companies/:companyId/projects/:projectId",
    { config: { action: "project.manage", fieldActions: SETTINGS } },
    async (req) => {
      const id = uuidParam((req.params as { projectId: string }).projectId, "projectId");
      const body = parseBody(UpdateProjectSchema, req.body);
      const { result } = await mutate(db, req.companyId, req.principal.actor, async (ctx) => {
        const res = await ctx.client.query<ProjectRow>(
          `UPDATE projects SET name = COALESCE($3, name), client = COALESCE($4, client), goal = COALESCE($5, goal),
             repo_url = CASE WHEN $6::boolean THEN $7 ELSE repo_url END, default_branch = COALESCE($8, default_branch),
             client_policy = COALESCE($9::jsonb, client_policy),
             chargeback_tag = CASE WHEN $10::boolean THEN $11 ELSE chargeback_tag END, updated_at = now()
         WHERE id = $1 AND company_id = $2 RETURNING *`,
          [
            id,
            req.companyId,
            body.name ?? null,
            body.client ?? null,
            body.goal ?? null,
            body.repoUrl !== undefined,
            body.repoUrl ?? null,
            body.defaultBranch ?? null,
            body.clientPolicy ? JSON.stringify(body.clientPolicy) : null,
            body.chargebackTag !== undefined,
            body.chargebackTag?.trim() || null,
          ],
        );
        const row = res.rows[0];
        if (!row) throw notFound("project");
        await ctx.emit(
          "project.updated",
          { kind: "project", id },
          {
            name: row.name,
            changes: Object.keys(body),
            ...(body.clientPolicy ? { clientPolicy: row.client_policy } : {}),
          },
        );
        return row;
      });
      return toJson(result);
    },
  );
}
