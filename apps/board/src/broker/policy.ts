// What one teammate may do with each connection on one task: the toolbox as
// the ceiling, narrowed by the task's department write policy and the
// project's client policy. Read here, decided in @rosterdock/shared, enforced by the
// broker before any network call. No runs import: the pack builder uses this.

import {
  effectiveMode,
  toolGranted,
  type ClientPolicy,
  type ToolboxEntry,
  type ToolMode,
} from "@rosterdock/shared";
import type { Queryable } from "../db/pool.js";
import { listConnections, type ConnectionRow, type ConnectionTool } from "../mcp/connections.js";

export interface EffectiveConnection {
  connection: ConnectionRow;
  /** The mode the teammate was granted in their toolbox. */
  granted: ToolMode;
  /** After the department and the client narrowed it. */
  mode: ToolMode;
  narrowedBy: ("toolbox" | "department" | "client")[];
  /** The tools the toolbox line grants: every one on the connection, or only the ones it names. */
  tools: ConnectionTool[];
  /** The names the line picked, when it picked; null when the whole connection is granted. */
  allowed: string[] | null;
}

export interface ToolScope {
  companyId: string;
  teammateId: string;
  departmentId: string | null;
  projectId: string;
}

/** Every connection the teammate's toolbox names, with its effective mode on this task. */
export async function effectiveToolbox(db: Queryable, scope: ToolScope): Promise<EffectiveConnection[]> {
  const [teammate, department, project, connections] = await Promise.all([
    db.query<{ toolbox: ToolboxEntry[] }>("SELECT toolbox FROM teammates WHERE id = $1 AND company_id = $2", [
      scope.teammateId,
      scope.companyId,
    ]),
    scope.departmentId
      ? db.query<{ write_policy: string }>("SELECT write_policy FROM departments WHERE id = $1", [
          scope.departmentId,
        ])
      : Promise.resolve(null),
    db.query<{ client_policy: ClientPolicy | null }>("SELECT client_policy FROM projects WHERE id = $1", [
      scope.projectId,
    ]),
    listConnections(db, scope.companyId),
  ]);
  const toolbox = teammate.rows[0]?.toolbox ?? [];
  const writePolicy = department?.rows[0]?.write_policy ?? null;
  const clientPolicy = project.rows[0]?.client_policy ?? null;
  const out: EffectiveConnection[] = [];
  for (const entry of toolbox) {
    const connection = connections.find((c) => c.name === entry.connection);
    if (!connection) continue;
    const decision = effectiveMode({
      toolbox,
      departmentWritePolicy: writePolicy,
      clientPolicy,
      connection: connection.name,
    });
    out.push({
      connection,
      granted: entry.mode,
      mode: decision.mode,
      narrowedBy: decision.narrowedBy,
      tools: (connection.tools ?? []).filter((t) => toolGranted(entry, t.name)),
      allowed: entry.tools ?? null,
    });
  }
  return out;
}

/** One sentence on why a connection is narrower than the toolbox says, for the pack and refusals. */
export function narrowingReason(
  e: Pick<EffectiveConnection, "granted" | "mode" | "narrowedBy">,
  departmentName: string | null,
  clientName: string | null,
): string | null {
  if (e.mode === e.granted) return null;
  const parts: string[] = [];
  if (e.narrowedBy.includes("department"))
    parts.push(`the ${departmentName ?? "task's"} department is read only`);
  if (e.narrowedBy.includes("client"))
    parts.push(
      `${clientName ? `the client ${clientName}` : "the project's client policy"} allows ${e.mode === "off" ? "no use of it" : e.mode === "read" ? "reads only" : "asks"}`,
    );
  return parts.join(" and ");
}
