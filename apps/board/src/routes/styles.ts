// Style packs in Settings: list every pack with whether it is on here, and
// switch one on or off or change its level (owners and admins).
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { STYLE_LEVELS } from "../styles/catalog.js";
import { listStyles, setStyle, type StyleDeps } from "../styles/service.js";
import { parseBody } from "../validate.js";

const SetStyleSchema = z.object({
  enabled: z.boolean(),
  level: z.enum(STYLE_LEVELS).optional(),
});

export function registerStyleRoutes(app: FastifyInstance, deps: StyleDeps): void {
  app.get("/api/companies/:companyId/styles", { config: { action: "company.read" } }, async (req) =>
    listStyles(deps, req.companyId),
  );

  app.put("/api/companies/:companyId/styles/:pack", { config: { action: "company.update" } }, async (req) => {
    const body = parseBody(SetStyleSchema, req.body);
    await setStyle(deps, req.companyId, req.principal.actor, (req.params as { pack: string }).pack, body);
    return listStyles(deps, req.companyId);
  });
}
