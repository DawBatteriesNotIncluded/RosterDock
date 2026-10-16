// The office's images: put one, forget one, fetch one. Owners and admins write;
// anyone in the company reads. The bytes come from the object store and are
// content-addressed, so the web asks with the hash in the query and the reply
// may be cached for good.
import { PutOfficeImageSchema } from "@rosterdock/shared";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/pool.js";
import { deleteOfficeImage, officeImageBytes, officeImageName, putOfficeImage } from "../office/pack.js";
import type { ObjectStore } from "../storage/s3.js";
import { parseBody } from "../validate.js";
import { companyToJson, loadCompany } from "./companies.js";

export function registerOfficeRoutes(app: FastifyInstance, db: Db, store: ObjectStore | null): void {
  const nameOf = (req: { params: unknown }) => officeImageName((req.params as { name: unknown }).name);

  // A PNG is OFFICE_IMAGE_MAX_BYTES at most; base64 and JSON on top.
  app.put(
    "/api/companies/:companyId/office/images/:name",
    { config: { action: "company.update" }, bodyLimit: 2 * 1024 * 1024 },
    async (req) => {
      const name = nameOf(req);
      const body = parseBody(PutOfficeImageSchema, req.body);
      await putOfficeImage(db, req.companyId, req.principal.actor, name, body.content, store);
      return { ...companyToJson(await loadCompany(db, req.companyId)), role: req.companyRole };
    },
  );

  app.delete(
    "/api/companies/:companyId/office/images/:name",
    { config: { action: "company.update" } },
    async (req) => {
      await deleteOfficeImage(db, req.companyId, req.principal.actor, nameOf(req));
      return { ...companyToJson(await loadCompany(db, req.companyId)), role: req.companyRole };
    },
  );

  app.get(
    "/api/companies/:companyId/office/images/:name",
    { config: { action: "company.read" } },
    async (req, reply) => {
      const { image, bytes } = await officeImageBytes(db, req.companyId, nameOf(req), store);
      reply.header("content-type", "image/png");
      reply.header("etag", `"${image.sha256}"`);
      reply.header("cache-control", "private, max-age=31536000, immutable");
      return bytes;
    },
  );
}
