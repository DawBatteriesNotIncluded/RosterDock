// The single role guard. Every route under /api/companies/:companyId declares
// `config.action`; this hook resolves the caller's role in that company and
// consults the shared permission matrix. A mutating company route without an
// action is a programming error and fails closed with 500.

import { can, type Action, type Role } from "@rosterdock/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/pool.js";
import { HttpError } from "../http-error.js";
import type { Principal } from "./tokens.js";

declare module "fastify" {
  interface FastifyContextConfig {
    /** Permission required in the route's company. */
    action?: Action;
    /** No authentication needed. */
    public?: boolean;
  }
  interface FastifyRequest {
    principal: Principal;
    /** Set by the guard on company routes: the caller's role in that company. */
    companyRole: Role;
    companyId: string;
  }
}

export async function roleInCompany(db: Db, principal: Principal, companyId: string): Promise<Role | null> {
  if (principal.kind === "teammate") {
    return principal.teammate.company_id === companyId && principal.tokenCompanyId === companyId
      ? "teammate"
      : null;
  }
  const res = await db.query<{ role: Role }>(
    "SELECT role FROM memberships WHERE company_id = $1 AND user_id = $2",
    [companyId, principal.actor.id],
  );
  return res.rows[0]?.role ?? null;
}

export function registerGuard(app: FastifyInstance, db: Db): void {
  app.addHook("preHandler", async (req: FastifyRequest, _reply: FastifyReply) => {
    const config = req.routeOptions.config;
    const params = req.params as { companyId?: string } | undefined;
    const companyId = params?.companyId;
    if (!companyId) return; // not a company route; auth already ran
    if (!config.action) {
      if (req.method === "GET" || req.method === "HEAD") {
        throw new HttpError(500, "route is missing a permission action");
      }
      throw new HttpError(500, "mutating route is missing a permission action");
    }
    const role = await roleInCompany(db, req.principal, companyId);
    if (!role) throw new HttpError(403, "not a member of this company");
    if (!can(role, config.action)) throw new HttpError(403, `role ${role} may not ${config.action}`);
    req.companyRole = role;
    req.companyId = companyId;
  });
}
