// A teammate's baseline: what their runs usually cost and take, how often their
// work comes back, and the departures standing against them right now.
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/pool.js";
import { teammateBaseline } from "../drift/drift.js";
import { notFound } from "../http-error.js";
import { uuidParam } from "../validate.js";

export function registerDriftRoutes(app: FastifyInstance, db: Db): void {
  app.get(
    "/api/companies/:companyId/teammates/:teammateId/baseline",
    { config: { action: "company.read" } },
    async (req) => {
      const id = uuidParam((req.params as { teammateId: string }).teammateId, "teammateId");
      const exists = await db.query("SELECT 1 FROM teammates WHERE id = $1 AND company_id = $2", [
        id,
        req.companyId,
      ]);
      if (!exists.rowCount) throw notFound("teammate");
      return teammateBaseline(db, req.companyId, id);
    },
  );
}
