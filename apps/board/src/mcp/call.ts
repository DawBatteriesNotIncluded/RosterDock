// One door for the broker: call a tool on a connection whatever its kind. MCP
// connections go through the SDK client; OpenAPI connections through the
// runtime. The broker has already decided the call may happen.

import { callMcpTool, type McpCallOutcome, type McpClientDeps } from "./client.js";
import { withCompanyEnv } from "../secrets/company.js";
import { targetFor, type ConnectionRow } from "./connections.js";
import { callOpenApiOperation, type OpenApiManifest } from "./openapi.js";

export async function callConnectionTool(
  connection: ConnectionRow,
  boardDeps: McpClientDeps,
  name: string,
  args: Record<string, unknown>,
): Promise<McpCallOutcome> {
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
