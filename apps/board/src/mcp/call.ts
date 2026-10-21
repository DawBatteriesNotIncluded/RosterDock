// One door for the broker: call a tool on a connection whatever its kind. MCP
// connections go through the SDK client; OpenAPI connections through the
// runtime; the web connection through the board's own guarded fetch. The broker
// has already decided the call may happen.

import { callMcpTool, type McpCallOutcome, type McpClientDeps } from "./client.js";
import { withCompanyEnv } from "../secrets/company.js";
import { targetFor, type ConnectionRow } from "./connections.js";
import { callOpenApiOperation, type OpenApiManifest } from "./openapi.js";
import { readWebPage, WEB_FETCH_TOOL, type WebAudit } from "../web/read.js";

/** A call's outcome, and for the web connection what its record keeps (the URL, the status, the size). */
export type ConnectionCallOutcome = McpCallOutcome & { audit?: WebAudit };

export async function callConnectionTool(
  connection: ConnectionRow,
  boardDeps: McpClientDeps,
  name: string,
  args: Record<string, unknown>,
  /** For the web connection: the sites the task may read (null for any public site). Without it, nothing is read. */
  task?: { webDomains: string[] | null },
): Promise<ConnectionCallOutcome> {
  if (connection.kind === "web") {
    if (name !== WEB_FETCH_TOOL) return { ok: false, error: `${name} is not a tool on ${connection.name}` };
    if (!task)
      return { ok: false, error: `${connection.name} reads a page only for a task; nothing was read` };
    return readWebPage(boardDeps.web ?? null, args, task.webDomains);
  }
  // Names resolve for the connection's company: what a person set in Settings, then the names the board shares.
  const deps = await withCompanyEnv(boardDeps, connection.company_id);
  if (connection.kind === "openapi") {
    if (!connection.url || !connection.manifest)
      return { ok: false, error: `${connection.name} has no OpenAPI manifest; nothing was called` };
    return callOpenApiOperation(
      { url: connection.url, authEnvName: connection.auth_env_name },
      connection.manifest as unknown as OpenApiManifest,
      { ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.env ? { env: deps.env } : {}) },
      name,
      args,
    );
  }
  return callMcpTool(targetFor(connection), deps, name, args);
}
