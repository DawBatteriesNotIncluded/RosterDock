// Connections: the catalog, and the company's connections to external systems.
// Managing them is connection.manage: owners and admins. A name a connection
// takes must be one the company can have: never the board's own (operator.ts).

import {
  can,
  CreateConnectionSchema,
  CreateOpenApiConnectionSchema,
  OpenApiPreviewSchema,
  UpdateConnectionSchema,
} from "@rosterdock/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { roleInCompany } from "../auth/guard.js";
import { safeReturnTo } from "../auth/oidc.js";
import type { Db } from "../db/pool.js";
import { finishAuthorization, startAuthorization, type AuthorizeDeps } from "../mcp/authorize.js";
import { CONNECTOR_CATALOG } from "../mcp/catalog.js";
import type { McpClientDeps } from "../mcp/client.js";
import { OAuthError } from "../mcp/oauth.js";
import {
  connectionToJson,
  createConnection,
  createOpenApiConnection,
  deleteConnection,
  checkConnection,
  discoverConnectionTools,
  listConnections,
  loadConnection,
  updateConnection,
} from "../mcp/connections.js";
import { HttpError } from "../http-error.js";
import { scanOpenApi, specObject } from "../mcp/openapi.js";
import { assertCompanyEnvNames, type OperatorPolicy } from "../operator.js";
import { parseBody, uuidParam } from "../validate.js";

const StartOAuthSchema = z.object({ returnTo: z.string().max(500).optional() });

export function registerConnectionRoutes(
  app: FastifyInstance,
  db: Db,
  mcp: McpClientDeps,
  oauth: AuthorizeDeps & { publicUrl: string | null; operator: OperatorPolicy },
): void {
  const operator = oauth.operator;
  const publicBase = (req: FastifyRequest): string => oauth.publicUrl ?? `${req.protocol}://${req.host}`;
  const store = oauth.store;
  // The menu of known connectors. Definitions only; nothing here is a value.
  app.get("/api/catalog/connectors", { config: {} }, async () => CONNECTOR_CATALOG);

  app.get("/api/companies/:companyId/connections", { config: { action: "company.read" } }, async (req) => {
    return (await listConnections(db, req.companyId)).map(connectionToJson);
  });

  app.post(
    "/api/companies/:companyId/connections",
    { config: { action: "connection.manage" } },
    async (req, reply) => {
      const body = parseBody(CreateConnectionSchema, req.body);
      await assertCompanyEnvNames(operator, req.companyId, [
        body.authEnvName,
        ...body.envNames,
        body.oauth?.clientSecretEnvName,
      ]);
      const row = await createConnection(
        db,
        req.companyId,
        req.principal.actor,
        body,
        operator.stdioCommands,
      );
      reply.code(201);
      return connectionToJson(row);
    },
  );

  // OpenAPI: what a spec offers (no side effects), and a connection from it with an allowlist.
  app.post(
    "/api/companies/:companyId/connections/openapi/preview",
    { config: { action: "connection.manage" } },
    async (req) => {
      const body = parseBody(OpenApiPreviewSchema, req.body);
      const parsed = specObject(body.spec);
      if (!parsed.spec) throw new HttpError(422, parsed.error ?? "the spec cannot be read");
      const scan = scanOpenApi(parsed.spec);
      if (!scan.operations.length) throw new HttpError(422, scan.errors.join("; "));
      return scan;
    },
  );
  app.post(
    "/api/companies/:companyId/connections/openapi",
    { config: { action: "connection.manage" } },
    async (req, reply) => {
      const body = parseBody(CreateOpenApiConnectionSchema, req.body);
      await assertCompanyEnvNames(operator, req.companyId, [body.authEnvName]);
      const parsed = specObject(body.spec);
      if (!parsed.spec) throw new HttpError(422, parsed.error ?? "the spec cannot be read");
      const row = await createOpenApiConnection(db, req.companyId, req.principal.actor, {
        ...body,
        spec: parsed.spec,
      });
      reply.code(201);
      return connectionToJson(row);
    },
  );

  app.get(
    "/api/companies/:companyId/connections/:connectionId",
    { config: { action: "company.read" } },
    async (req) => {
      const id = uuidParam((req.params as { connectionId: string }).connectionId, "connectionId");
      return connectionToJson(await loadConnection(db, req.companyId, id));
    },
  );

  app.patch(
    "/api/companies/:companyId/connections/:connectionId",
    { config: { action: "connection.manage" } },
    async (req) => {
      const id = uuidParam((req.params as { connectionId: string }).connectionId, "connectionId");
      const body = parseBody(UpdateConnectionSchema, req.body);
      // The names this change writes; one the row already carries stays as it is (it resolves or it does not).
      const row = await loadConnection(db, req.companyId, id);
      const had = new Set([row.auth_env_name, ...(row.env_names ?? []), row.oauth?.clientSecretEnvName]);
      await assertCompanyEnvNames(
        operator,
        req.companyId,
        [body.authEnvName, ...(body.envNames ?? []), body.oauth?.clientSecretEnvName].filter(
          (n) => !had.has(n),
        ),
      );
      return connectionToJson(
        await updateConnection(
          db,
          req.companyId,
          req.principal.actor,
          id,
          body,
          store,
          operator.stdioCommands,
        ),
      );
    },
  );

  app.delete(
    "/api/companies/:companyId/connections/:connectionId",
    { config: { action: "connection.manage" } },
    async (req) => {
      const id = uuidParam((req.params as { connectionId: string }).connectionId, "connectionId");
      await deleteConnection(db, req.companyId, req.principal.actor, id, store);
      return { ok: true };
    },
  );

  // OAuth: where to send the browser. The board discovers the authorization server, registers itself
  // when the connection has no client id, records the attempt, and answers with the consent URL.
  app.post(
    "/api/companies/:companyId/connections/:connectionId/oauth/start",
    { config: { action: "connection.manage" } },
    async (req) => {
      const id = uuidParam((req.params as { connectionId: string }).connectionId, "connectionId");
      const body = parseBody(StartOAuthSchema, req.body);
      if (req.principal.kind !== "user") throw new HttpError(403, "a person authorises a connection");
      return startAuthorization(db, oauth, {
        companyId: req.companyId,
        connectionId: id,
        actor: req.principal.actor,
        userId: req.principal.user.id,
        redirectUri: `${publicBase(req)}/api/oauth/callback`,
        returnTo: safeReturnTo(body.returnTo),
      });
    },
  );

  // The authorization server sends the browser back here, signed in as the person who started it.
  app.get("/api/oauth/callback", { config: {} }, async (req, reply) => {
    const base = publicBase(req);
    const q = req.query as { code?: string; state?: string; error?: string };
    // The code says what went wrong in our terms; the detail is the server's own error code, when it gave one.
    const fail = (code: string, detail: string | null = null) =>
      reply.redirect(
        `${base}/?oauth_error=${encodeURIComponent(code)}${detail ? `&oauth_detail=${encodeURIComponent(detail)}` : ""}`,
        302,
      );
    if (q.error) return fail(q.error === "access_denied" ? "denied" : "provider", q.error);
    if (!q.code || !q.state) return fail("state");
    if (req.principal.kind !== "user") throw new HttpError(403, "a person authorises a connection");
    const principal = req.principal;
    try {
      const done = await finishAuthorization(db, oauth, {
        code: q.code,
        state: q.state,
        userId: principal.user.id,
        actor: principal.actor,
        canManage: async (companyId) => {
          const role = await roleInCompany(db, principal, companyId);
          return !!role && can(role, "connection.manage");
        },
      });
      const to = new URL(done.returnTo, base);
      to.searchParams.set("oauth", done.name);
      return reply.redirect(to.toString(), 302);
    } catch (err) {
      if (err instanceof OAuthError) {
        app.log.warn(`oauth authorisation refused (${err.code}): ${err.message}`);
        return fail(err.code, err.detail);
      }
      throw err;
    }
  });

  // tools/list against the live server; classifies each tool as a read or a write.
  app.post(
    "/api/companies/:companyId/connections/:connectionId/discover",
    { config: { action: "connection.manage" } },
    async (req) => {
      const id = uuidParam((req.params as { connectionId: string }).connectionId, "connectionId");
      return connectionToJson(await discoverConnectionTools(db, req.companyId, req.principal.actor, id, mcp));
    },
  );

  // A health check: does the system answer with this credential, and does it still list what we know?
  app.post(
    "/api/companies/:companyId/connections/:connectionId/check",
    { config: { action: "connection.manage" } },
    async (req) => {
      const id = uuidParam((req.params as { connectionId: string }).connectionId, "connectionId");
      return connectionToJson(await checkConnection(db, req.companyId, req.principal.actor, id, mcp));
    },
  );
}
