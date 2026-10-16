// POST /api/mcp: the board MCP server for teammates, authenticated with the
// run-scoped bearer token, or with a teammate token minted with the manager
// scope (an agent acting as the teammate outside a run, naming the task in
// each call). Stateless: a fresh server and transport per request.

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/pool.js";
import type { GitHosts } from "../git/hosts.js";
import type { SpanSink } from "../observability/spans.js";
import type { ObjectStore } from "../storage/s3.js";
import { HttpError } from "../http-error.js";
import type { McpClientDeps } from "../mcp/client.js";
import { createBoardMcpServer } from "../mcp/server.js";
import type { ToolActor } from "../mcp/tools.js";
import type { RunQueue } from "../queue.js";
import { loadRun } from "../runs/service.js";

export function registerMcpRoutes(
  app: FastifyInstance,
  db: Db,
  queue: RunQueue,
  hosts: GitHosts,
  mcp: McpClientDeps,
  store: ObjectStore | null = null,
  tracer: SpanSink | null = null,
): void {
  // Fastify parses JSON bodies; the transport wants the parsed body.
  app.post("/api/mcp", { config: {} }, async (req, reply) => {
    const p = req.principal;
    if (p.kind !== "teammate" || (!p.runId && !p.scopes.includes("manager")))
      throw new HttpError(
        403,
        "the board MCP server is for run-scoped teammate tokens, or a teammate token minted with the manager scope",
      );
    const run = p.runId ? await loadRun(db, p.runId) : null;
    const actor: ToolActor = {
      companyId: run?.company_id ?? p.tokenCompanyId,
      teammateId: p.teammate.id,
      teammateName: p.teammate.name,
      handle: p.teammate.handle,
      runId: run?.id ?? null,
      taskId: run?.task_id ?? null,
    };
    const server = createBoardMcpServer({ db, queue, hosts, mcp, store, tracer }, actor);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } finally {
      reply.raw.on("close", () => {
        void transport.close().catch(() => {});
        void server.close().catch(() => {});
      });
    }
  });

  // Stateless server: no standalone SSE stream and nothing to delete.
  app.get("/api/mcp", { config: {} }, async (_req, reply) => {
    reply.code(405);
    return { error: "this MCP server is stateless; POST JSON-RPC requests" };
  });
  app.delete("/api/mcp", { config: {} }, async (_req, reply) => {
    reply.code(405);
    return { error: "this MCP server is stateless" };
  });
}
