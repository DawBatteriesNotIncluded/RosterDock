// Templates as files: export a company's shape, import one into a company.
import { TemplatesFileSchema } from "@rosterdock/shared";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/pool.js";
import { mutate } from "../mutate.js";
import { companyEnvNameRefusal, stdioRefusal, type OperatorPolicy } from "../operator.js";
import { exportTemplates, importTemplates } from "../templates/files.js";
import { parseBody } from "../validate.js";

export function registerTemplateRoutes(app: FastifyInstance, db: Db, operator: OperatorPolicy): void {
  app.get(
    "/api/companies/:companyId/templates/export",
    { config: { action: "company.read" } },
    async (req, reply) => {
      const file = await exportTemplates(db, req.companyId);
      const slug = (file.company?.name ?? "company").toLowerCase().replace(/[^a-z0-9]+/g, "-");
      reply.header("content-disposition", `attachment; filename="${slug}-templates.json"`);
      return file;
    },
  );

  // Owners and admins; the raw-secret guard runs on the whole file in parseBody, and a connection the
  // board would refuse from a person is skipped with a note.
  app.post(
    "/api/companies/:companyId/templates/import",
    { config: { action: "department.manage" } },
    async (req) => {
      const file = parseBody(TemplatesFileSchema, req.body);
      const { result } = await mutate(db, req.companyId, req.principal.actor, (ctx) =>
        importTemplates(ctx, file, {
          connectionRefusal: async (c) =>
            (c.kind === "mcp" && c.transport === "stdio"
              ? stdioRefusal(operator.stdioCommands, c.command, c.args)
              : null) ??
            (await companyEnvNameRefusal(operator, req.companyId, [c.authEnvName, ...c.envNames])),
        }),
      );
      return result;
    },
  );
}
