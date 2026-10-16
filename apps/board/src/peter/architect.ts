// Peter as company architect. From a goal or a gap ("I need a finance
// function that reconciles Xero weekly") he proposes departments, teammate
// templates with personas, the toolbox each needs and the write policy, as a
// draft; a person accepts it and the org is created. He can also audit the
// company as it stands: idle teammates, departments without a reviewer or a
// lead, unseated teammates, sandboxes wider than the department's policy.
// Proposals are always drafts; toolboxes are names Peter recommends, and
// nobody is granted a tool here (M5 binds toolboxes).

import { z } from "zod";
import { DEFAULT_MODEL, handleFor, WRITE_POLICIES, type ActorRef } from "@rosterdock/shared";
import type { Queryable } from "../db/pool.js";
import { HttpError, notFound } from "../http-error.js";
import { mutate } from "../mutate.js";
import type { PeterDeps } from "./goals.js";
import { addUsage, type ModelUsage } from "./model.js";
import { isManager, isReviewer } from "./plan.js";
import { companyManager, type Manager } from "./seat.js";
import { modelAvailable } from "./planners.js";

export const MAX_DRAFT_DEPARTMENTS = 6;
export const MAX_DRAFT_TEAMMATES = 8;

export const ProposedTeammateSchema = z.object({
  name: z.string().min(1).max(120),
  role: z.string().min(1).max(80),
  /** Global template to take persona, engine and model from, by name; null for a fresh persona. */
  template: z.string().max(120).nullable(),
  /** Persona when no template fits (a few sentences, second person). */
  personaMd: z.string().max(4000),
  /** True for the department's lead: its Peter instance. */
  lead: z.boolean(),
});

export const ProposedDepartmentSchema = z.object({
  name: z.string().min(1).max(120),
  writePolicy: z.enum(WRITE_POLICIES),
  /** One sentence: what the policy allows and forbids for this department. */
  policy: z.string().max(500),
  /** MCP servers the department's teammates need, by name (hubspot, slack, xero, github...). Recommendations only. */
  toolbox: z.array(z.string().min(1).max(64)).max(12),
  teammates: z.array(ProposedTeammateSchema).min(1).max(MAX_DRAFT_TEAMMATES),
});

export const OrgProposalSchema = z.object({
  summary: z.string().min(1).max(2000),
  departments: z.array(ProposedDepartmentSchema).min(1).max(MAX_DRAFT_DEPARTMENTS),
});
export type OrgProposal = z.infer<typeof OrgProposalSchema>;

export interface AuditFinding {
  kind:
    | "no_manager"
    | "idle_teammate"
    | "no_reviewer"
    | "no_lead"
    | "unseated"
    | "wide_sandbox"
    | "no_department";
  subject: { kind: "teammate" | "department" | "company"; id: string; name: string } | null;
  text: string;
  suggestion: string;
}
export interface AuditReport {
  summary: string;
  findings: AuditFinding[];
}

export interface DraftRow {
  id: string;
  company_id: string;
  kind: "org" | "audit";
  status: "proposed" | "accepted" | "rejected";
  brief: string;
  proposal: OrgProposal | AuditReport;
  planner: string | null;
  usage: Partial<ModelUsage> & { calls?: number };
  created_by_kind: "user" | "teammate";
  created_by_id: string;
  decided_by_kind: "user" | "teammate" | null;
  decided_by_id: string | null;
  decided_at: Date | null;
  outcome: { departments: { id: string; name: string }[]; teammates: { id: string; name: string }[] } | null;
  created_at: Date;
  updated_at: Date;
}

export function draftToJson(row: DraftRow) {
  return {
    id: row.id,
    companyId: row.company_id,
    kind: row.kind,
    status: row.status,
    brief: row.brief,
    proposal: row.proposal,
    planner: row.planner,
    usage: {
      inputTokens: row.usage?.inputTokens ?? 0,
      outputTokens: row.usage?.outputTokens ?? 0,
      calls: row.usage?.calls ?? 0,
    },
    createdBy: { kind: row.created_by_kind, id: row.created_by_id },
    decidedBy:
      row.decided_by_kind && row.decided_by_id ? { kind: row.decided_by_kind, id: row.decided_by_id } : null,
    decidedAt: row.decided_at?.toISOString() ?? null,
    outcome: row.outcome,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listDrafts(db: Queryable, companyId: string): Promise<DraftRow[]> {
  return (
    await db.query<DraftRow>("SELECT * FROM drafts WHERE company_id = $1 ORDER BY created_at DESC", [
      companyId,
    ])
  ).rows;
}

export async function loadDraft(
  db: Queryable,
  companyId: string,
  id: string,
  forUpdate = false,
): Promise<DraftRow> {
  const res = await db.query<DraftRow>(
    `SELECT * FROM drafts WHERE id = $1 AND company_id = $2${forUpdate ? " FOR UPDATE" : ""}`,
    [id, companyId],
  );
  if (!res.rows[0]) throw notFound("draft");
  return res.rows[0];
}

// --- The company as it stands ----------------------------------------------------

interface Template {
  name: string;
  role: string;
  persona_md: string;
  engine: string;
  model: string;
  avatar: string | null;
}

interface OrgSnapshot {
  departments: {
    id: string;
    name: string;
    write_policy: string;
    lead_teammate_id: string | null;
    sandbox: { allowedTools?: string[] };
  }[];
  teammates: { id: string; name: string; handle: string; role: string; engine: string }[];
  members: { department_id: string; teammate_id: string }[];
  templates: Template[];
  enabledEngines: string[];
}

async function snapshot(db: Queryable, companyId: string): Promise<OrgSnapshot> {
  const [departments, teammates, members, templates, engines] = await Promise.all([
    db.query<OrgSnapshot["departments"][number]>(
      "SELECT id, name, write_policy, lead_teammate_id, sandbox FROM departments WHERE company_id = $1 ORDER BY created_at",
      [companyId],
    ),
    db.query<OrgSnapshot["teammates"][number]>(
      "SELECT id, name, handle, role, engine FROM teammates WHERE company_id = $1 ORDER BY created_at",
      [companyId],
    ),
    db.query<OrgSnapshot["members"][number]>(
      "SELECT department_id, teammate_id FROM department_members WHERE company_id = $1",
      [companyId],
    ),
    db.query<Template>(
      "SELECT name, role, persona_md, engine, model, avatar FROM teammate_templates WHERE company_id IS NULL OR company_id = $1 ORDER BY company_id NULLS FIRST, name",
      [companyId],
    ),
    db.query<{ id: string }>("SELECT id FROM engines WHERE enabled"),
  ]);
  return {
    departments: departments.rows,
    teammates: teammates.rows,
    members: members.rows,
    templates: templates.rows,
    enabledEngines: engines.rows.map((e) => e.id),
  };
}

// --- The heuristic proposal: department templates by keyword -----------------------

interface DeptTemplate {
  name: string;
  match: RegExp;
  writePolicy: "readonly" | "drafts" | "ask";
  policy: string;
  toolbox: string[];
  /** [template name, role, lead?] */
  staff: [string, string, boolean?][];
}

/** The same shapes the web's "Add a department from a template" offers, chosen by what the brief says. */
export const DEPARTMENT_TEMPLATES: DeptTemplate[] = [
  {
    name: "Finance",
    match: /(financ|xero|quickbooks|reconcil|invoice|ledger|account(ing|s)|payroll|expense)/i,
    writePolicy: "ask",
    policy:
      "Reads are free; every posting, payment or record change in the accounting system is proposed for approval.",
    toolbox: ["xero"],
    staff: [
      ["Finn", "finance analyst", true],
      ["Verifier", "reviewer"],
    ],
  },
  {
    name: "Research",
    match: /(research|agency|map |mapping|investigat|analys|discover|landscape|competit)/i,
    writePolicy: "readonly",
    policy:
      "Read only. Findings, requirements and designs are written up; nothing is applied to a live system.",
    toolbox: ["web"],
    staff: [
      ["Ricky", "researcher", true],
      ["Brody", "requirements"],
      ["Archy", "architect"],
    ],
  },
  {
    name: "Marketing ops",
    match: /(marketing|hubspot|crm|digest|slack|gong|campaign|newsletter|contact|lead )/i,
    writePolicy: "ask",
    policy:
      "Drafts are fine; every write to the CRM or a channel is proposed with the exact records for approval.",
    toolbox: ["hubspot", "slack", "gong"],
    staff: [
      ["Reporter", "reporting", true],
      ["Cody 3", "HubSpot analyst"],
    ],
  },
  {
    name: "Engineering",
    match: /(engineer|build|n8n|workflow|automat|code|integrat|api|pipeline|deploy|develop)/i,
    writePolicy: "drafts",
    policy:
      "Workflows and code are built as drafts and reviewed; activation and merges are approved by a person.",
    toolbox: ["n8n", "github"],
    staff: [
      ["Archy", "architect", true],
      ["Cody", "n8n engineer"],
      ["Verifier", "reviewer"],
    ],
  },
  {
    name: "Docs",
    match: /(docs|documentation|runbook|manual|handbook|writing)/i,
    writePolicy: "readonly",
    policy: "Read only. Documents are written and reviewed; publishing is a person's call.",
    toolbox: ["web"],
    staff: [
      ["Brody", "requirements", true],
      ["Reporter", "reporting"],
    ],
  },
];

/** A name not yet used by a teammate: Cody, Cody 2, Cody 3. */
function freeName(base: string, taken: Set<string>): string {
  if (!taken.has(handleFor(base))) {
    taken.add(handleFor(base));
    return base;
  }
  for (let i = 2; i < 50; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(handleFor(candidate))) {
      taken.add(handleFor(candidate));
      return candidate;
    }
  }
  return `${base} ${Date.now()}`;
}

export function heuristicOrg(brief: string, org: OrgSnapshot): OrgProposal {
  const existing = new Set(org.departments.map((d) => d.name.toLowerCase()));
  const taken = new Set(org.teammates.map((t) => t.handle));
  let picks = DEPARTMENT_TEMPLATES.filter((t) => t.match.test(brief));
  if (!picks.length)
    picks = DEPARTMENT_TEMPLATES.filter((t) => t.name === "Engineering" || t.name === "Research");
  const departments: OrgProposal["departments"] = [];
  for (const t of picks) {
    if (existing.has(t.name.toLowerCase())) continue;
    departments.push({
      name: t.name,
      writePolicy: t.writePolicy,
      policy: t.policy,
      toolbox: t.toolbox,
      teammates: t.staff.map(([template, role, lead]) => {
        const tpl = org.templates.find((x) => x.name === template);
        return {
          name: freeName(template, taken),
          role,
          template: tpl ? tpl.name : null,
          personaMd: tpl
            ? ""
            : `You are the ${role}. You work from written briefs, cite your sources and propose every change to a live system for approval.`,
          lead: lead ?? false,
        };
      }),
    });
  }
  const names = departments.map((d) => `${d.name} (${d.teammates.length})`).join(", ");
  return {
    summary: departments.length
      ? `From "${brief.slice(0, 120)}": ${names}. Toolboxes are recommendations; nothing is granted until M5's approvals.`
      : `Every department the brief calls for already exists: ${[...existing].join(", ")}. Nothing to add.`,
    departments,
  };
}

/** Names must be free, templates must exist, one lead at most per department, engines usable. */
export function validateOrg(proposal: OrgProposal, org: OrgSnapshot): string[] {
  const errors: string[] = [];
  const taken = new Set(org.teammates.map((t) => t.handle));
  const seen = new Set<string>();
  for (const d of proposal.departments) {
    if (org.departments.some((x) => x.name.toLowerCase() === d.name.toLowerCase()))
      errors.push(`department "${d.name}" already exists`);
    if (d.teammates.filter((t) => t.lead).length > 1) errors.push(`"${d.name}" names more than one lead`);
    for (const t of d.teammates) {
      const h = handleFor(t.name);
      if (!h) errors.push(`teammate "${t.name}" has no usable name`);
      else if (taken.has(h) || seen.has(h)) errors.push(`teammate name "${t.name}" is already taken`);
      seen.add(h);
      if (t.template && !org.templates.some((x) => x.name === t.template))
        errors.push(`template "${t.template}" does not exist`);
      if (!t.template && !t.personaMd.trim())
        errors.push(`teammate "${t.name}" has neither a template nor a persona`);
    }
  }
  return errors;
}

export function architectSystemPrompt(org: OrgSnapshot): string {
  const templates = org.templates.map((t) => `- ${t.name}: ${t.role} (${t.engine}, ${t.model})`).join("\n");
  const existing = org.departments.length
    ? org.departments
        .map(
          (d) =>
            `- ${d.name} (write policy ${d.write_policy}): ${org.members
              .filter((m) => m.department_id === d.id)
              .map((m) => org.teammates.find((t) => t.id === m.teammate_id)?.name ?? "?")
              .join(", ")}`,
        )
        .join("\n")
    : "- none yet";
  const roster =
    org.teammates.map((t) => `- ${t.name} (@${t.handle}), ${t.role}`).join("\n") || "- nobody yet";
  return [
    "You are Peter, the project manager of an AI company on the RosterDock board, acting as its architect.",
    "From what the owner asks for, propose the departments to add: each with a write policy (readonly: nothing touches a live system; drafts: drafts are made, live writes ask; ask: every write asks), a one-sentence policy, the MCP toolbox its teammates need by name (hubspot, slack, xero, github, n8n, gong, web...), and its teammates.",
    "Reuse the global templates by name where a role fits; otherwise write a short second-person persona. Mark one teammate per department as lead. Every department that does live work needs a reviewer.",
    "Never propose a department that already exists, never reuse a taken teammate name (add a number: Cody 2), never include credential values.",
    "This is a draft the owner accepts; nothing you propose is granted by itself.",
    "",
    "Global templates:",
    templates,
    "",
    "Departments that exist:",
    existing,
    "",
    "Teammates that exist:",
    roster,
  ].join("\n");
}

// --- Proposing --------------------------------------------------------------------

export async function proposeOrg(deps: PeterDeps, companyId: string, brief: string): Promise<DraftRow> {
  const manager = await companyManager(deps.db, companyId);
  if (!manager) throw new HttpError(409, "this company has no project manager teammate");
  const org = await snapshot(deps.db, companyId);
  let proposal: OrgProposal | null = null;
  let planner = "heuristic";
  let usage: ModelUsage | null = null;
  if (await modelAvailable(deps.model, companyId)) {
    try {
      const result = await deps.model.complete({
        model: manager.model,
        effort: manager.effort,
        system: architectSystemPrompt(org),
        user: `The owner asks:\n${brief}\n\nPropose the departments to add, at most ${MAX_DRAFT_DEPARTMENTS}.`,
        schema: OrgProposalSchema,
        trace: { purpose: "org", companyId },
      });
      usage = result.usage;
      if (result.output) {
        const problems = validateOrg(result.output, org);
        if (!problems.length) {
          proposal = result.output;
          planner = `model:${result.model}`;
        } else planner = `heuristic (the model's proposal was refused: ${problems.slice(0, 3).join("; ")})`;
      } else planner = "heuristic (the model returned no proposal)";
    } catch (err) {
      deps.log?.warn(`Peter's architect call failed: ${(err as Error).message}`);
      planner = `heuristic (the model call failed: ${(err as Error).message.slice(0, 120)})`;
    }
  }
  if (!proposal) proposal = heuristicOrg(brief, org);
  return recordDraft(deps, companyId, manager, "org", brief, proposal, planner, usage);
}

async function recordDraft(
  deps: PeterDeps,
  companyId: string,
  manager: Manager,
  kind: DraftRow["kind"],
  brief: string,
  proposal: OrgProposal | AuditReport,
  planner: string,
  usage: ModelUsage | null,
): Promise<DraftRow> {
  const { result } = await mutate(deps.db, companyId, { kind: "teammate", id: manager.id }, async (ctx) => {
    const row = (
      await ctx.client.query<DraftRow>(
        `INSERT INTO drafts (company_id, kind, brief, proposal, planner, usage, created_by_kind, created_by_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'teammate', $7) RETURNING *`,
        [
          companyId,
          kind,
          brief,
          JSON.stringify(proposal),
          planner,
          JSON.stringify(usage ? addUsage(null, usage) : {}),
          manager.id,
        ],
      )
    ).rows[0]!;
    const payload =
      kind === "org"
        ? {
            kind,
            summary: (proposal as OrgProposal).summary,
            departments: (proposal as OrgProposal).departments.map((d) => ({
              name: d.name,
              teammates: d.teammates.length,
            })),
            managerName: manager.name,
          }
        : {
            kind,
            summary: (proposal as AuditReport).summary,
            findings: (proposal as AuditReport).findings.length,
            managerName: manager.name,
          };
    await ctx.emit("draft.proposed", { kind: "draft", id: row.id }, payload);
    return row;
  });
  return result;
}

// --- Auditing ---------------------------------------------------------------------

export const IDLE_AFTER_DAYS = 14;

export async function auditCompany(deps: PeterDeps, companyId: string): Promise<DraftRow> {
  const manager = await companyManager(deps.db, companyId);
  if (!manager) throw new HttpError(409, "this company has no project manager teammate");
  const org = await snapshot(deps.db, companyId);
  const findings: AuditFinding[] = [];
  const active = await deps.db.query<{ teammate_id: string }>(
    `SELECT DISTINCT teammate_id FROM (
       SELECT assignee_id AS teammate_id FROM tasks WHERE company_id = $1 AND assignee_kind = 'teammate' AND status NOT IN ('done', 'cancelled')
       UNION SELECT teammate_id FROM runs WHERE company_id = $1 AND created_at > now() - ($2 || ' days')::interval
     ) a`,
    [companyId, String(IDLE_AFTER_DAYS)],
  );
  const busy = new Set(active.rows.map((r) => r.teammate_id));
  for (const t of org.teammates) {
    if (t.id === manager.id) continue;
    const seated = org.members.some((m) => m.teammate_id === t.id);
    if (!busy.has(t.id)) {
      findings.push({
        kind: "idle_teammate",
        subject: { kind: "teammate", id: t.id, name: t.name },
        text: `${t.name} (${t.role}) has no open task and no run in ${IDLE_AFTER_DAYS} days.`,
        suggestion:
          "Hand a goal that needs this role to Peter, or let the teammate go; a seat costs the same idle.",
      });
    }
    if (!seated && org.departments.length) {
      findings.push({
        kind: "unseated",
        subject: { kind: "teammate", id: t.id, name: t.name },
        text: `${t.name} is in no department, so no department policy narrows what they may do.`,
        suggestion: "Seat them in a department from the Departments matrix.",
      });
    }
  }
  for (const d of org.departments) {
    const members = org.members
      .filter((m) => m.department_id === d.id)
      .map((m) => org.teammates.find((t) => t.id === m.teammate_id))
      .filter((t): t is OrgSnapshot["teammates"][number] => !!t);
    if (!d.lead_teammate_id)
      findings.push({
        kind: "no_lead",
        subject: { kind: "department", id: d.id, name: d.name },
        text: `${d.name} has no lead; the company Peter manages its work.`,
        suggestion: "Pick a lead in Departments so the department has its own manager.",
      });
    const workers = members.filter((t) => !isReviewer(t.role) && !isManager(t.role));
    if (workers.length && !members.some((t) => isReviewer(t.role)))
      findings.push({
        kind: "no_reviewer",
        subject: { kind: "department", id: d.id, name: d.name },
        text: `${d.name} has ${workers.length} teammate${workers.length === 1 ? "" : "s"} doing work and nobody whose role reviews it; every review waits for a person.`,
        suggestion: "Hire a reviewer (the Verifier template) into the department.",
      });
    // Files in the working directory are always fine; a shell or the network can reach a live system.
    const tools = d.sandbox?.allowedTools ?? [];
    const reach = tools.filter((t) => /^(Bash|WebFetch|WebSearch|mcp__)/.test(t));
    if (d.write_policy === "readonly" && reach.length)
      findings.push({
        kind: "wide_sandbox",
        subject: { kind: "department", id: d.id, name: d.name },
        text: `${d.name} is read only but its sandbox allows ${reach.join(", ")}, which can reach live systems.`,
        suggestion: "Narrow the sandbox to files in the working directory, or change the policy on purpose.",
      });
  }
  if (!org.departments.length && org.teammates.length > 1)
    findings.push({
      kind: "no_department",
      subject: { kind: "company", id: companyId, name: "the company" },
      text: "There are no departments, so no write policy narrows any teammate.",
      suggestion: "Ask Peter to design the company from a brief, or add a department from a template.",
    });
  const report: AuditReport = {
    summary: findings.length
      ? `${findings.length} thing${findings.length === 1 ? "" : "s"} to look at: ${[...new Set(findings.map((f) => f.kind.replace("_", " ")))].join(", ")}.`
      : "Nothing idle, nothing unreviewed, nothing wider than its policy.",
    findings,
  };
  return recordDraft(deps, companyId, manager, "audit", "", report, "audit", null);
}

// --- Deciding ---------------------------------------------------------------------

/** A person accepts an org draft: the departments and teammates are created. An audit is acknowledged. */
export async function acceptDraft(
  deps: PeterDeps,
  companyId: string,
  actor: ActorRef,
  draftId: string,
): Promise<DraftRow> {
  if (actor.kind !== "user") throw new HttpError(403, "only a person accepts a draft");
  const { result } = await mutate(deps.db, companyId, actor, async (ctx) => {
    const draft = await loadDraft(ctx.client, companyId, draftId, true);
    if (draft.status !== "proposed") throw new HttpError(409, `this draft is already ${draft.status}`);
    const outcome: NonNullable<DraftRow["outcome"]> = { departments: [], teammates: [] };
    if (draft.kind === "org") {
      const proposal = OrgProposalSchema.parse(draft.proposal);
      const org = await snapshot(ctx.client, companyId);
      const problems = validateOrg(proposal, org);
      if (problems.length)
        throw new HttpError(409, `the draft no longer fits the company: ${problems.join("; ")}`);
      for (const d of proposal.departments) {
        const created: { id: string; name: string; lead: boolean }[] = [];
        for (const t of d.teammates) {
          const tpl = t.template ? org.templates.find((x) => x.name === t.template) : undefined;
          const engine = tpl && org.enabledEngines.includes(tpl.engine) ? tpl.engine : "claude_code";
          const model = tpl?.model ?? DEFAULT_MODEL;
          const row = (
            await ctx.client.query<{ id: string; name: string }>(
              `INSERT INTO teammates (company_id, name, handle, role, persona_md, playbooks, engine, model, avatar)
               VALUES ($1, $2, $3, $4, $5, '[]', $6, $7, $8) RETURNING id, name`,
              [
                companyId,
                t.name,
                handleFor(t.name),
                t.role,
                tpl?.persona_md ?? t.personaMd,
                engine,
                model,
                tpl?.avatar ?? t.name.slice(0, 1).toUpperCase(),
              ],
            )
          ).rows[0]!;
          await ctx.emit(
            "teammate.created",
            { kind: "teammate", id: row.id },
            { name: row.name, role: t.role, engine, model, fromDraft: draft.id },
          );
          created.push({ ...row, lead: t.lead });
          outcome.teammates.push(row);
        }
        const slug =
          d.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || `dept-${Date.now()}`;
        const lead = created.find((c) => c.lead) ?? null;
        const dept = (
          await ctx.client.query<{ id: string; name: string }>(
            `INSERT INTO departments (company_id, slug, name, write_policy, lead_teammate_id, sandbox)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name`,
            [companyId, slug, d.name, d.writePolicy, lead?.id ?? null, "{}"],
          )
        ).rows[0]!;
        for (const c of created) {
          await ctx.client.query(
            "INSERT INTO department_members (company_id, department_id, teammate_id, is_lead) VALUES ($1, $2, $3, $4)",
            [companyId, dept.id, c.id, c.lead],
          );
        }
        await ctx.emit(
          "department.created",
          { kind: "department", id: dept.id },
          {
            name: dept.name,
            writePolicy: d.writePolicy,
            leadTeammateId: lead?.id ?? null,
            leadName: lead?.name ?? null,
            memberCount: created.length,
            toolbox: d.toolbox,
            fromDraft: draft.id,
          },
        );
        outcome.departments.push(dept);
      }
    }
    const row = (
      await ctx.client.query<DraftRow>(
        `UPDATE drafts SET status = 'accepted', decided_by_kind = $2, decided_by_id = $3, decided_at = now(), outcome = $4, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [draft.id, actor.kind, actor.id, JSON.stringify(outcome)],
      )
    ).rows[0]!;
    await ctx.emit(
      "draft.accepted",
      { kind: "draft", id: draft.id },
      { kind: draft.kind, departments: outcome.departments.length, teammates: outcome.teammates.length },
    );
    return row;
  });
  return result;
}

export async function rejectDraft(
  deps: PeterDeps,
  companyId: string,
  actor: ActorRef,
  draftId: string,
): Promise<DraftRow> {
  const { result } = await mutate(deps.db, companyId, actor, async (ctx) => {
    const draft = await loadDraft(ctx.client, companyId, draftId, true);
    if (draft.status !== "proposed") throw new HttpError(409, `this draft is already ${draft.status}`);
    const row = (
      await ctx.client.query<DraftRow>(
        "UPDATE drafts SET status = 'rejected', decided_by_kind = $2, decided_by_id = $3, decided_at = now(), updated_at = now() WHERE id = $1 RETURNING *",
        [draft.id, actor.kind, actor.id],
      )
    ).rows[0]!;
    await ctx.emit("draft.rejected", { kind: "draft", id: draft.id }, { kind: draft.kind });
    return row;
  });
  return result;
}
