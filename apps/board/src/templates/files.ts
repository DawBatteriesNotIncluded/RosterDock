// Templates as files. A company's shape (its teammate templates, teammates,
// departments, connections and the client policies of its projects) exports
// to one JSON document by name and imports into any company: what exists by
// name is left alone and reported, what is missing is created, memberships
// and leads are resolved by teammate name, toolbox grants by connection name
// (connections are created first, so a grant in the file finds its
// connection), a client policy by project name. The import runs as one
// mutation, so a file that fails half way changes nothing. The raw-secret
// guard already ran on the body; connections carry env var NAMES only, and a
// connection the board would not let a person add (a name that is the
// board's own, a command the operator does not list) is skipped with a note.

import {
  type Effort,
  handleFor,
  type ClientPolicy,
  type ConnectionToolInput,
  type TemplatesFile,
  type ToolboxEntry,
  TEMPLATES_FORMAT,
} from "@rosterdock/shared";
import type { Queryable } from "../db/pool.js";
import { HttpError } from "../http-error.js";
import type { MutationContext } from "../mutate.js";

export interface TemplateRow {
  id: string;
  company_id: string | null;
  name: string;
  role: string;
  persona_md: string;
  playbooks: string[];
  engine: string;
  model: string;
  avatar: string | null;
  effort: string | null;
}

export async function exportTemplates(db: Queryable, companyId: string): Promise<TemplatesFile> {
  const company = (
    await db.query<{ name: string; template: string | null }>(
      "SELECT name, template FROM companies WHERE id = $1",
      [companyId],
    )
  ).rows[0];
  if (!company) throw new HttpError(404, "company not found");
  const templates = await db.query<TemplateRow>(
    "SELECT * FROM teammate_templates WHERE company_id = $1 ORDER BY name",
    [companyId],
  );
  const globalNames = await db.query<{ id: string; name: string }>(
    "SELECT id, name FROM teammate_templates WHERE company_id IS NULL OR company_id = $1",
    [companyId],
  );
  const templateName = new Map(globalNames.rows.map((t) => [t.id, t.name]));
  const teammates = await db.query<{
    id: string;
    template_id: string | null;
    name: string;
    role: string;
    persona_md: string;
    playbooks: string[];
    engine: string;
    model: string;
    avatar: string | null;
    effort: string | null;
    toolbox: ToolboxEntry[];
  }>("SELECT * FROM teammates WHERE company_id = $1 ORDER BY created_at", [companyId]);
  const nameOf = new Map(teammates.rows.map((t) => [t.id, t.name]));
  const departments = await db.query<{
    id: string;
    slug: string;
    name: string;
    write_policy: "readonly" | "drafts" | "ask";
    sandbox: Record<string, unknown>;
    lead_teammate_id: string | null;
  }>("SELECT * FROM departments WHERE company_id = $1 ORDER BY created_at", [companyId]);
  const members = await db.query<{ department_id: string; teammate_id: string }>(
    "SELECT department_id, teammate_id FROM department_members WHERE company_id = $1 ORDER BY created_at",
    [companyId],
  );
  const connections = await db.query<{
    name: string;
    catalog_id: string | null;
    kind: "mcp" | "openapi";
    transport: "http" | "stdio";
    url: string | null;
    command: string | null;
    args: string[];
    auth_env_name: string | null;
    env_names: string[];
    enabled: boolean;
    tools: ConnectionToolInput[];
    manifest: Record<string, unknown> | null;
  }>("SELECT * FROM connections WHERE company_id = $1 ORDER BY created_at", [companyId]);
  const projects = await db.query<{ name: string; client_policy: ClientPolicy | null }>(
    "SELECT name, client_policy FROM projects WHERE company_id = $1 ORDER BY created_at",
    [companyId],
  );
  return {
    format: TEMPLATES_FORMAT,
    company: { name: company.name, template: company.template },
    teammateTemplates: templates.rows.map((t) => ({
      name: t.name,
      role: t.role,
      engine: t.engine as TemplatesFile["teammateTemplates"][number]["engine"],
      model: t.model,
      personaMd: t.persona_md,
      playbooks: t.playbooks,
      ...(t.avatar ? { avatar: t.avatar } : {}),
      ...(t.effort ? { effort: t.effort as Effort } : {}),
    })),
    teammates: teammates.rows.map((t) => ({
      name: t.name,
      role: t.role,
      template: t.template_id ? (templateName.get(t.template_id) ?? null) : null,
      engine: t.engine as TemplatesFile["teammates"][number]["engine"],
      model: t.model,
      personaMd: t.persona_md,
      playbooks: t.playbooks,
      ...(t.avatar ? { avatar: t.avatar } : {}),
      ...(t.effort ? { effort: t.effort as Effort } : {}),
      toolbox: t.toolbox ?? [],
    })),
    departments: departments.rows.map((d) => ({
      name: d.name,
      slug: d.slug,
      writePolicy: d.write_policy,
      sandbox: d.sandbox ?? {},
      lead: d.lead_teammate_id ? (nameOf.get(d.lead_teammate_id) ?? null) : null,
      members: members.rows
        .filter((m) => m.department_id === d.id)
        .map((m) => nameOf.get(m.teammate_id))
        .filter((n): n is string => !!n),
    })),
    connections: connections.rows.map((c) => ({
      name: c.name,
      catalogId: c.catalog_id,
      kind: c.kind,
      transport: c.transport,
      url: c.url,
      command: c.command,
      args: c.args ?? [],
      authEnvName: c.auth_env_name,
      envNames: c.env_names ?? [],
      enabled: c.enabled,
      tools: c.tools ?? [],
      manifest: c.manifest,
    })),
    // Only projects whose client narrows something; an empty policy says nothing worth carrying.
    clientPolicies: projects.rows
      .filter(
        (p) => p.client_policy && (p.client_policy.default || Object.keys(p.client_policy.caps ?? {}).length),
      )
      .map((p) => ({
        project: p.name,
        policy: { default: p.client_policy!.default ?? null, caps: p.client_policy!.caps ?? {} },
      })),
  };
}

export interface ImportReport {
  created: { teammateTemplates: string[]; teammates: string[]; departments: string[]; connections: string[] };
  /** Projects whose client policy the file set, by name. */
  clientPolicies: string[];
  /** Things the company already had, by name; left as they were. */
  skipped: string[];
  /** Things the file asked for that could not be honoured in this company. */
  notes: string[];
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface ImportOptions {
  /** Why the board would refuse this connection from a person (operator.ts), or null when it would not. */
  connectionRefusal?(c: TemplatesFile["connections"][number]): Promise<string | null>;
}

/** Import a templates file into the mutation's company. Emits the same events the routes would. */
export async function importTemplates(
  ctx: MutationContext,
  file: TemplatesFile,
  opts: ImportOptions = {},
): Promise<ImportReport> {
  const db = ctx.client;
  const companyId = ctx.companyId;
  const report: ImportReport = {
    created: { teammateTemplates: [], teammates: [], departments: [], connections: [] },
    clientPolicies: [],
    skipped: [],
    notes: [],
  };

  // 0. Connections, by name, before anything that grants them. Env var NAMES only; the value is where the board runs.
  for (const c of file.connections) {
    const dup = await db.query("SELECT 1 FROM connections WHERE company_id = $1 AND name = $2", [
      companyId,
      c.name,
    ]);
    if (dup.rowCount) {
      report.skipped.push(`connection ${c.name}`);
      continue;
    }
    if (c.kind === "openapi" ? !c.url : c.transport === "http" ? !c.url : !c.command) {
      report.notes.push(
        `connection ${c.name}: ${c.kind === "openapi" || c.transport === "http" ? "needs a URL" : "needs a command"}; skipped`,
      );
      continue;
    }
    const refusal = (await opts.connectionRefusal?.(c)) ?? null;
    if (refusal) {
      report.notes.push(`connection ${c.name}: ${refusal}; skipped`);
      continue;
    }
    const res = await db.query<{ id: string }>(
      `INSERT INTO connections (company_id, name, catalog_id, kind, transport, url, command, args, auth_env_name, env_names, enabled, tools, manifest)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [
        companyId,
        c.name,
        c.catalogId ?? null,
        c.kind,
        c.transport,
        c.url ?? null,
        c.command ?? null,
        JSON.stringify(c.args),
        c.authEnvName ?? null,
        JSON.stringify(c.envNames),
        c.enabled,
        JSON.stringify(c.tools),
        c.manifest ? JSON.stringify(c.manifest) : null,
      ],
    );
    await ctx.emit(
      "connection.created",
      { kind: "connection", id: res.rows[0]!.id },
      {
        name: c.name,
        kind: c.kind,
        transport: c.transport,
        catalogId: c.catalogId ?? null,
        authEnvName: c.authEnvName ?? null,
        tools: c.tools.length,
        fromFile: true,
      },
    );
    report.created.connections.push(c.name);
  }
  const engines = new Set(
    (await db.query<{ id: string }>("SELECT id FROM engines WHERE enabled")).rows.map((e) => e.id),
  );

  // 1. The company's own teammate templates, by name. Global ones are never touched.
  for (const t of file.teammateTemplates) {
    if (!engines.has(t.engine)) {
      report.notes.push(`template ${t.name}: engine ${t.engine} is not enabled here; skipped`);
      continue;
    }
    const existing = await db.query<{ id: string }>(
      "SELECT id FROM teammate_templates WHERE company_id = $1 AND lower(name) = lower($2)",
      [companyId, t.name],
    );
    if (existing.rows[0]) {
      report.skipped.push(`template ${t.name}`);
      continue;
    }
    await db.query(
      `INSERT INTO teammate_templates (company_id, name, role, persona_md, playbooks, engine, model, avatar, effort)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        companyId,
        t.name,
        t.role,
        t.personaMd,
        JSON.stringify(t.playbooks),
        t.engine,
        t.model,
        t.avatar ?? null,
        t.effort ?? null,
      ],
    );
    report.created.teammateTemplates.push(t.name);
  }

  // 2. Teammates, by handle. Persona, engine and model fall back to the named template.
  const templates = (
    await db.query<TemplateRow>(
      "SELECT * FROM teammate_templates WHERE company_id IS NULL OR company_id = $1 ORDER BY company_id NULLS FIRST",
      [companyId],
    )
  ).rows;
  const connections = new Set(
    (
      await db.query<{ name: string }>("SELECT name FROM connections WHERE company_id = $1", [companyId])
    ).rows.map((c) => c.name),
  );
  const teammateIds = new Map<string, string>();
  for (const row of (
    await db.query<{ id: string; handle: string }>("SELECT id, handle FROM teammates WHERE company_id = $1", [
      companyId,
    ])
  ).rows)
    teammateIds.set(row.handle, row.id);

  for (const t of file.teammates) {
    const handle = handleFor(t.name);
    if (!handle) {
      report.notes.push(`teammate "${t.name}": the name needs a letter or digit; skipped`);
      continue;
    }
    if (teammateIds.has(handle)) {
      report.skipped.push(`teammate ${t.name}`);
      continue;
    }
    // The company's own template wins over a global one of the same name.
    const tpl = t.template
      ? templates.filter((x) => x.name.toLowerCase() === t.template!.toLowerCase()).at(-1)
      : undefined;
    if (t.template && !tpl) {
      report.notes.push(`teammate ${t.name}: template "${t.template}" does not exist here; skipped`);
      continue;
    }
    const role = t.role ?? tpl?.role;
    const model = t.model ?? tpl?.model;
    const engine = t.engine ?? tpl?.engine ?? "claude_code";
    if (!role || !model) {
      report.notes.push(`teammate ${t.name}: needs a role and a model, or a template; skipped`);
      continue;
    }
    if (!engines.has(engine)) {
      report.notes.push(`teammate ${t.name}: engine ${engine} is not enabled here; skipped`);
      continue;
    }
    const toolbox: ToolboxEntry[] = [];
    for (const entry of t.toolbox) {
      if (connections.has(entry.connection)) toolbox.push(entry);
      else
        report.notes.push(`teammate ${t.name}: no connection named ${entry.connection} here; grant dropped`);
    }
    const res = await db.query<{ id: string }>(
      `INSERT INTO teammates (company_id, template_id, name, handle, role, persona_md, playbooks, engine, model, avatar, toolbox, effort)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [
        companyId,
        tpl?.id ?? null,
        t.name,
        handle,
        role,
        t.personaMd ?? tpl?.persona_md ?? "",
        JSON.stringify(t.playbooks ?? tpl?.playbooks ?? []),
        engine,
        model,
        t.avatar ?? tpl?.avatar ?? t.name.slice(0, 1).toUpperCase(),
        JSON.stringify(toolbox),
        t.effort !== undefined ? t.effort : (tpl?.effort ?? null),
      ],
    );
    const id = res.rows[0]!.id;
    teammateIds.set(handle, id);
    await ctx.emit(
      "teammate.created",
      { kind: "teammate", id },
      { name: t.name, role, engine, model, toolbox, fromFile: true },
    );
    report.created.teammates.push(t.name);
  }

  // 3. Departments, by slug, with members and a lead by teammate name.
  for (const d of file.departments) {
    const slug = d.slug ?? slugify(d.name);
    if (!slug) {
      report.notes.push(`department "${d.name}": the name needs a letter or digit; skipped`);
      continue;
    }
    const dup = await db.query("SELECT 1 FROM departments WHERE company_id = $1 AND slug = $2", [
      companyId,
      slug,
    ]);
    if (dup.rowCount) {
      report.skipped.push(`department ${d.name}`);
      continue;
    }
    const wanted = [...new Set([...(d.lead ? [d.lead] : []), ...d.members])];
    const memberIds: string[] = [];
    let leadId: string | null = null;
    for (const name of wanted) {
      const id = teammateIds.get(handleFor(name));
      if (!id) {
        report.notes.push(`department ${d.name}: no teammate named ${name} here; not added`);
        continue;
      }
      memberIds.push(id);
      if (d.lead && handleFor(d.lead) === handleFor(name)) leadId = id;
    }
    const res = await db.query<{ id: string }>(
      "INSERT INTO departments (company_id, slug, name, write_policy, sandbox, lead_teammate_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [companyId, slug, d.name, d.writePolicy, JSON.stringify(d.sandbox ?? {}), leadId],
    );
    const id = res.rows[0]!.id;
    for (const teammateId of memberIds) {
      await db.query(
        "INSERT INTO department_members (company_id, department_id, teammate_id, is_lead) VALUES ($1, $2, $3, $4)",
        [companyId, id, teammateId, teammateId === leadId],
      );
    }
    await ctx.emit(
      "department.created",
      { kind: "department", id },
      {
        name: d.name,
        writePolicy: d.writePolicy,
        leadTeammateId: leadId,
        leadName: leadId ? (d.lead ?? null) : null,
        memberCount: memberIds.length,
        fromFile: true,
      },
    );
    report.created.departments.push(d.name);
  }

  // 4. Client policies, by project name; a project the company does not have is noted.
  for (const cp of file.clientPolicies) {
    const project = (
      await db.query<{ id: string }>(
        "SELECT id FROM projects WHERE company_id = $1 AND lower(name) = lower($2)",
        [companyId, cp.project],
      )
    ).rows[0];
    if (!project) {
      report.notes.push(`client policy for ${cp.project}: no project by that name here; skipped`);
      continue;
    }
    await db.query("UPDATE projects SET client_policy = $2, updated_at = now() WHERE id = $1", [
      project.id,
      JSON.stringify(cp.policy),
    ]);
    await ctx.emit(
      "project.updated",
      { kind: "project", id: project.id },
      { name: cp.project, changes: ["clientPolicy"], clientPolicy: cp.policy, fromFile: true },
    );
    report.clientPolicies.push(cp.project);
  }

  // 5. The company's template name, when it has none yet.
  if (file.company?.template) {
    await db.query(
      "UPDATE companies SET template = COALESCE(template, $2), updated_at = now() WHERE id = $1",
      [companyId, file.company.template],
    );
  }
  await ctx.emit(
    "company.updated",
    { kind: "company", id: companyId },
    {
      changes: ["templates.imported"],
      file: file.company?.name ?? null,
      created: report.created,
      skipped: report.skipped.length,
      notes: report.notes.length,
    },
  );
  return report;
}
