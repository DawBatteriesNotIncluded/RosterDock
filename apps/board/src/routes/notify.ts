// Notifications: one route, "send a test", so an owner knows the webhook NAME
// resolves where the board runs. The target itself is company settings
// (settings.notify.webhookEnvName) through the company update route.

import type { FastifyInstance } from "fastify";
import { sendTest, type NotifyDeps } from "../notify/notify.js";

export function registerNotifyRoutes(app: FastifyInstance, notify: NotifyDeps): void {
  app.post("/api/companies/:companyId/notify/test", { config: { action: "company.update" } }, async (req) => {
    return sendTest(notify, req.companyId, req.principal.actor);
  });
}
