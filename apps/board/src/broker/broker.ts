// The tool broker: the only path from a teammate to an external system. A run
// asks for (connection, tool, arguments); the broker resolves the effective
// mode for this teammate on this task, classifies the tool, and either runs a
// read now, refuses, or turns a write into an approval that a person decides.
// The same module executes approved writes, so the bytes a person approved are
// the bytes that leave. Every call and refusal is an event.

import { type ActorRef, readsByName, verdictFor } from "@rosterdock/shared";
import { proposeApproval, type ApprovalExecutor, type ApprovalRow } from "../approvals/service.js";
import type { Db } from "../db/pool.js";
import { HttpError } from "../http-error.js";
import { catalogEntry } from "../mcp/catalog.js";
import { standaloneSpan, type SpanSink } from "../observability/spans.js";
import { callConnectionTool } from "../mcp/call.js";
import type { McpClientDeps } from "../mcp/client.js";
import { connectionByName, loadConnection, type ConnectionRow } from "../mcp/connections.js";
import { mutate } from "../mutate.js";
import { loadTask } from "../tasks/service.js";
import { WEB_FETCH_TOOL } from "../web/read.js";
import {
  effectiveToolbox,
  narrowingReason,
  webNarrowingReason,
  webScope,
  type EffectiveConnection,
} from "./policy.js";

export class BrokerRefusal extends Error {}

export interface BrokerDeps {
  db: Db;
  mcp: McpClientDeps;
  /** Where a read outside a run posts its own trace; a run's reads are traced with the run. */
  tracer?: SpanSink | null;
}

export interface BrokerActor {
  companyId: string;
  teammateId: string;
  teammateName: string;
  runId: string | null;
  taskId: string;
}

export interface ToolCallInput {
  connection: string;
  tool: string;
  arguments: Record<string, unknown>;
  /** For a write: what it does, in plain words, and why. Required to propose. */
  title?: string;
  why?: string;
}

export type ToolCallResult =
  | { kind: "result"; connection: string; tool: string; result: unknown }
  | {
      kind: "proposed";
      connection: string;
      tool: string;
      approvalId: string;
      status: string;
      message: string;
    };

// Secret-shaped keys are scrubbed from anything a live system answers before it
// reaches a run, an approval row or an event.
const SECRET_KEY_RE = /(authorization|api[-_]?key|token|secret|password|credential|private[-_]?key)/i;

export function redactResult(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[depth]";
  if (Array.isArray(value)) return value.map((v) => redactResult(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = SECRET_KEY_RE.test(k) ? "[redacted]" : redactResult(v, depth + 1);
    return out;
  }
  return value;
}

/** Is this tool a write on this connection, and did a person switch it off? Discovered connections know their tools; others classify by name. */
export function classifyOn(
  connection: ConnectionRow,
  tool: string,
): { write: boolean; known: boolean; off: boolean } {
  const listed = (connection.tools ?? []).find((t) => t.name === tool);
  // The web connection's one tool reads, whatever its row says; it has no other.
  if (connection.kind === "web")
    return { write: false, known: tool === WEB_FETCH_TOOL, off: listed?.off === true };
  if (listed) return { write: listed.write, known: true, off: listed.off === true };
  if (connection.discovered_at) return { write: true, known: false, off: false };
  const entry = catalogEntry(connection.catalog_id);
  const write = entry?.reads.includes(tool)
    ? false
    : entry?.writes.includes(tool)
      ? true
      : !readsByName(tool);
  return { write, known: !!entry, off: false };
}

async function scopeOf(deps: BrokerDeps, actor: BrokerActor) {
  const task = await loadTask(deps.db, actor.companyId, actor.taskId);
  const [dept, project] = await Promise.all([
    task.department_id
      ? deps.db.query<{ name: string }>("SELECT name FROM departments WHERE id = $1", [task.department_id])
      : Promise.resolve(null),
    deps.db.query<{ client: string }>("SELECT client FROM projects WHERE id = $1", [task.project_id]),
  ]);
  return {
    task,
    departmentName: dept?.rows[0]?.name ?? null,
    clientName: project.rows[0]?.client ?? null,
  };
}

/** The teammate's connections on this task, with modes and tools, for board_list_tools and the pack. */
export async function listTools(deps: BrokerDeps, actor: BrokerActor) {
  const { task, departmentName, clientName } = await scopeOf(deps, actor);
  const effective = await effectiveToolbox(deps.db, {
    companyId: actor.companyId,
    teammateId: actor.teammateId,
    departmentId: task.department_id,
    projectId: task.project_id,
  });
  return Promise.all(
    effective.map(async (e) => {
      if (e.connection.kind !== "web") return describeConnection(e, departmentName, clientName);
      const web = await webScope(deps.db, e.connection, {
        departmentId: task.department_id,
        projectId: task.project_id,
      });
      return {
        ...describeConnection(e, departmentName, clientName),
        // The sites its fetch may read on this task; null for any public site.
        domains: web.domains,
        domainsNarrowed: webNarrowingReason(web, departmentName, clientName),
        ...(deps.mcp.web ? {} : { offline: "this board is kept off the web by its operator" }),
      };
    }),
  );
}

export function describeConnection(
  e: EffectiveConnection,
  departmentName: string | null,
  clientName: string | null,
) {
  return {
    connection: e.connection.name,
    kind: e.connection.kind,
    enabled: e.connection.enabled,
    mode: e.mode,
    granted: e.granted,
    narrowed: narrowingReason(e, departmentName, clientName),
    discovered: e.connection.discovered_at !== null,
    tools: e.tools.map((t) => ({
      name: t.name,
      description: t.description,
      write: t.write,
      off: t.off === true,
      verdict: e.connection.enabled && !t.off ? verdictFor(e.mode, t.write) : "refuse",
    })),
  };
}

/**
 * One tool call from a run. Reads run now and are recorded; writes become an
 * approval and the task waits; anything policy does not allow is refused with
 * the reason. Nothing reaches the connection before the decision.
 */
export async function callTool(
  deps: BrokerDeps,
  actor: BrokerActor,
  input: ToolCallInput,
): Promise<ToolCallResult> {
  const { task, departmentName, clientName } = await scopeOf(deps, actor);
  const connection = await connectionByName(deps.db, actor.companyId, input.connection);
  if (!connection)
    throw new BrokerRefusal(`there is no connection named ${input.connection} in this company`);
  const effective = (
    await effectiveToolbox(deps.db, {
      companyId: actor.companyId,
      teammateId: actor.teammateId,
      departmentId: task.department_id,
      projectId: task.project_id,
    })
  ).find((e) => e.connection.id === connection.id);
  if (!effective || effective.granted === "off")
    throw new BrokerRefusal(`${connection.name} is not in your toolbox; ask a person to grant it`);
  if (!connection.enabled) throw new BrokerRefusal(`${connection.name} is switched off by a person`);
  const { write, known, off } = classifyOn(connection, input.tool);
  if (!known && (connection.discovered_at || connection.kind === "web"))
    throw new BrokerRefusal(
      `${input.tool} is not a tool on ${connection.name}; board_list_tools has the list`,
    );
  if (off)
    throw new BrokerRefusal(
      `${input.tool} on ${connection.name} is switched off by a person; board_list_tools has what is on`,
    );
  if (effective.allowed && !effective.allowed.includes(input.tool))
    throw new BrokerRefusal(
      `${input.tool} on ${connection.name} is not in your toolbox; board_list_tools has what you may use`,
    );
  const verdict = verdictFor(effective.mode, write);
  const narrowed = narrowingReason(effective, departmentName, clientName);
  if (verdict === "refuse") {
    const why =
      effective.mode === "off"
        ? `${connection.name} is off for this task: ${narrowed ?? "policy"}`
        : `${input.tool} writes to ${connection.name} and your access here is read only${narrowed ? ` (${narrowed})` : ""}. Describe the change in your handover instead.`;
    throw new BrokerRefusal(why);
  }
  const teammate: ActorRef = { kind: "teammate", id: actor.teammateId };
  if (verdict === "propose") {
    if (!input.title?.trim() || !input.why?.trim())
      throw new BrokerRefusal(
        `${input.tool} writes to ${connection.name}: give a title (what it does, in plain words) and why, so a person can decide`,
      );
    const { approval, created } = await proposeApproval(deps.db, actor.companyId, {
      taskId: task.id,
      runId: actor.runId,
      teammateId: actor.teammateId,
      connectionId: connection.id,
      connection: connection.name,
      tool: input.tool,
      title: input.title.trim(),
      why: input.why.trim(),
      payload: input.arguments,
    });
    return {
      kind: "proposed",
      connection: connection.name,
      tool: input.tool,
      approvalId: approval.id,
      status: approval.status,
      message: created
        ? `Proposed for approval. A person decides; the task waits. Finish what you can without it, write your handover and stop; you are started again with the outcome.`
        : `This exact write is already proposed and waiting for a person. Do not propose it again; hand over and stop.`,
    };
  }
  // A read: call it now, record it. The web connection reads only the sites this task may.
  const web =
    connection.kind === "web"
      ? await webScope(deps.db, connection, { departmentId: task.department_id, projectId: task.project_id })
      : null;
  const startMs = Date.now();
  const outcome = await callConnectionTool(
    connection,
    deps.mcp,
    input.tool,
    input.arguments,
    web ? { webDomains: web.domains } : undefined,
  );
  const result = outcome.ok ? redactResult(outcome.result) : null;
  // Inside a run the read joins the run's trace when the run ends; outside one it is a trace of its own.
  if (!actor.runId && deps.tracer)
    void deps.tracer
      .post([
        standaloneSpan(
          `tool ${connection.name}.${input.tool}`,
          startMs,
          Date.now(),
          {
            "rosterdock.company_id": actor.companyId,
            "rosterdock.teammate_id": actor.teammateId,
            "rosterdock.teammate": actor.teammateName,
            "rosterdock.task_id": task.id,
            "rosterdock.task_number": task.number,
            "rosterdock.connection": connection.name,
            "rosterdock.tool": input.tool,
            "rosterdock.outside_run": true,
            "rosterdock.ok": outcome.ok,
            "rosterdock.error": outcome.ok ? null : outcome.error,
          },
          outcome.ok ? { code: 1 } : { code: 2, message: (outcome.error ?? "failed").slice(0, 500) },
          3,
        ),
      ])
      .catch(() => {});
  await mutate(deps.db, actor.companyId, teammate, async (ctx) => {
    await ctx.emit(
      "tool.called",
      { kind: "connection", id: connection.id },
      {
        connection: connection.name,
        tool: input.tool,
        taskId: task.id,
        number: task.number,
        runId: actor.runId,
        teammateId: actor.teammateId,
        teammateName: actor.teammateName,
        ok: outcome.ok,
        error: outcome.ok ? null : outcome.error,
        argumentKeys: Object.keys(input.arguments ?? {}),
        // The web connection's record of the page: where, what status, how much. Never what it says.
        ...(outcome.audit ?? {}),
      },
    );
  });
  if (!outcome.ok) throw new BrokerRefusal(`${connection.name} · ${input.tool} failed: ${outcome.error}`);
  return { kind: "result", connection: connection.name, tool: input.tool, result };
}

/** Executes an approved write: the connection by id (or by name if it was re-added), the bound payload as the arguments. */
export function brokerExecutor(deps: BrokerDeps): ApprovalExecutor {
  return async (approval: ApprovalRow & { connection_id?: string | null }) => {
    let connection: ConnectionRow | null = null;
    if (approval.connection_id) {
      try {
        connection = await loadConnection(deps.db, approval.company_id, approval.connection_id);
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
      }
    }
    connection ??= await connectionByName(deps.db, approval.company_id, approval.connection);
    if (!connection)
      return {
        ok: false,
        error: `no connection named ${approval.connection} exists any more; nothing was sent`,
      };
    if (!connection.enabled)
      return { ok: false, error: `${connection.name} is switched off; nothing was sent` };
    if (connection.kind === "web")
      return { ok: false, error: `${connection.name} only reads; there is nothing to send` };
    if (classifyOn(connection, approval.tool).off)
      return {
        ok: false,
        error: `${approval.tool} on ${connection.name} is switched off by a person; nothing was sent`,
      };
    const outcome = await callConnectionTool(connection, deps.mcp, approval.tool, approval.payload);
    return outcome.ok ? { ok: true, result: redactResult(outcome.result) } : outcome;
  };
}
