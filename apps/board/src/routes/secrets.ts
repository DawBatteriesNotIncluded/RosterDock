// Company secrets: the names a person has set values for, from Settings. The
// PUT is the one route on the board whose body carries a value; it is parsed
// with its schema alone (the raw-secret guard would refuse it, by design) and
// goes straight to the secret store. Nothing here ever answers with a value.
// Managing them is connection.manage: owners and admins.

import { SecretNameSchema, SetSecretSchema } from "@rosterdock/shared";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/pool.js";
import { HttpError } from "../http-error.js";
import {
  deleteCompanySecret,
  listCompanySecrets,
  secretToJson,
  setCompanySecret,
} from "../secrets/company.js";
import type { SecretStore } from "../secrets/store.js";

function nameParam(value: unknown): string {
  const parsed = SecretNameSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, "name must be an env var NAME");
  return parsed.data;
}

export function registerSecretRoutes(
  app: FastifyInstance,
  db: Db,
  store: SecretStore | null,
  /** ROSTERDOCK_SHARED_ENV_NAMES: a key is never set new under one of these (If-None-Match: *). */
  sharedEnvNames: readonly string[] = [],
): void {
  app.get("/api/companies/:companyId/secrets", { config: { action: "connection.manage" } }, async (req) => {
    return (await listCompanySecrets(db, req.companyId)).map(secretToJson);
  });

  app.put(
    "/api/companies/:companyId/secrets/:name",
    { config: { action: "connection.manage" } },
    async (req) => {
      const name = nameParam((req.params as { name: string }).name);
      const parsed = SetSecretSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw new HttpError(400, "invalid request body", parsed.error.issues);
      // If-None-Match: * sets a new name only, never over a value already there (the Models form's key).
      const createOnly = req.headers["if-none-match"] === "*";
      return secretToJson(
        await setCompanySecret(db, store, req.companyId, req.principal.actor, name, parsed.data.value, {
          createOnly,
          sharedEnvNames,
        }),
      );
    },
  );

  app.delete(
    "/api/companies/:companyId/secrets/:name",
    { config: { action: "connection.manage" } },
    async (req) => {
      const name = nameParam((req.params as { name: string }).name);
      await deleteCompanySecret(db, store, req.companyId, req.principal.actor, name);
      return { ok: true };
    },
  );
}
