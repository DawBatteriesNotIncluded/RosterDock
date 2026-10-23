// Company model providers: what the operator offers, and the company's providers with where each credential
// name gets its value (never the value). Reading them is company.read; adding, changing, checking and removing
// them is model.manage: owners and admins.

import { ModelProviderSchema, UpdateModelProviderSchema } from "@rosterdock/shared";
import type { FastifyInstance } from "fastify";
import { checkProvider } from "../providers/check.js";
import {
  checkNewProvider,
  createProvider,
  credentialStates,
  deleteProvider,
  listProviders,
  loadProvider,
  parseProviderBody,
  providerToJson,
  updateProvider,
  type ProviderDeps,
  type ProviderRow,
} from "../providers/providers.js";
import { uuidParam } from "../validate.js";

export function registerProviderRoutes(app: FastifyInstance, deps: ProviderDeps): void {
  const { db, policy } = deps;
  const toJson = async (companyId: string, rows: ProviderRow[]) => {
    const states = await credentialStates(db, companyId, deps.operator.sharedEnvNames, rows);
    return rows.map((r) => providerToJson(r, states.get(r.id) ?? {}, policy));
  };
  const one = async (companyId: string, row: ProviderRow) => (await toJson(companyId, [row]))[0]!;
  const idParam = (req: { params: unknown }) =>
    uuidParam((req.params as { providerId: string }).providerId, "providerId");

  app.get(
    "/api/companies/:companyId/model-providers",
    { config: { action: "company.read" } },
    async (req) => ({
      // The kinds a company may add here, and whether its teammates may keep the board's own models.
      offered: { kinds: policy.kinds, board: policy.board },
      providers: await toJson(req.companyId, await listProviders(db, req.companyId)),
    }),
  );

  app.get(
    "/api/companies/:companyId/model-providers/:providerId",
    { config: { action: "company.read" } },
    async (req) => one(req.companyId, await loadProvider(db, req.companyId, idParam(req))),
  );

  app.post(
    "/api/companies/:companyId/model-providers",
    { config: { action: "model.manage" } },
    async (req, reply) => {
      const body = parseProviderBody(ModelProviderSchema, req.body);
      const row = await createProvider(deps, req.companyId, req.principal.actor, body);
      reply.code(201);
      return one(req.companyId, row);
    },
  );

  // Would this provider be added? The same checks as adding it, and nothing written: no row, no event.
  app.post(
    "/api/companies/:companyId/model-providers/check-new",
    { config: { action: "model.manage" } },
    async (req) => {
      const body = parseProviderBody(ModelProviderSchema, req.body);
      await checkNewProvider(deps, req.companyId, body);
      return { ok: true };
    },
  );

  // Does its key work, and which models does it reach? One free call to the provider that lists models; the
  // outcome lands on the provider's lastCheck, with an event.
  app.post(
    "/api/companies/:companyId/model-providers/:providerId/check",
    { config: { action: "model.manage" } },
    async (req) =>
      one(req.companyId, await checkProvider(deps, req.companyId, req.principal.actor, idParam(req))),
  );

  app.patch(
    "/api/companies/:companyId/model-providers/:providerId",
    { config: { action: "model.manage" } },
    async (req) => {
      const id = idParam(req);
      const body = parseProviderBody(UpdateModelProviderSchema, req.body);
      return one(req.companyId, await updateProvider(deps, req.companyId, req.principal.actor, id, body));
    },
  );

  app.delete(
    "/api/companies/:companyId/model-providers/:providerId",
    { config: { action: "model.manage" } },
    async (req) => {
      await deleteProvider(db, req.companyId, req.principal.actor, idParam(req));
      return { ok: true };
    },
  );
}
