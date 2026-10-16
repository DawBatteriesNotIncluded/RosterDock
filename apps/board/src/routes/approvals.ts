// Approvals: the queue of proposed writes to live systems, per company, and the
// two decisions. Deciding is approval.decide: owners and admins, humans only.

import { APPROVAL_STATUSES, ApprovalDecisionSchema, type ApprovalStatus } from "@rosterdock/shared";
import type { FastifyInstance } from "fastify";
import {
  approvalsForTask,
  approvalToJson,
  approveApproval,
  listApprovals,
  loadApproval,
  rejectApproval,
  type ApprovalExecutor,
} from "../approvals/service.js";
import type { Db } from "../db/pool.js";
import { HttpError } from "../http-error.js";
import type { RunQueue } from "../queue.js";
import { parseBody, uuidParam } from "../validate.js";

export function registerApprovalRoutes(
  app: FastifyInstance,
  db: Db,
  queue: RunQueue,
  execute: ApprovalExecutor,
): void {
  app.get("/api/companies/:companyId/approvals", { config: { action: "company.read" } }, async (req) => {
    const q = req.query as { status?: string };
    const statuses = q.status
      ? q.status.split(",").map((s) => {
          const t = s.trim() as ApprovalStatus;
          if (!APPROVAL_STATUSES.includes(t)) throw new HttpError(400, `unknown approval status ${s}`);
          return t;
        })
      : null;
    return (await listApprovals(db, req.companyId, statuses)).map(approvalToJson);
  });

  app.get(
    "/api/companies/:companyId/approvals/:approvalId",
    { config: { action: "company.read" } },
    async (req) => {
      const id = uuidParam((req.params as { approvalId: string }).approvalId, "approvalId");
      return approvalToJson(await loadApproval(db, req.companyId, id));
    },
  );

  app.get(
    "/api/companies/:companyId/tasks/:taskId/approvals",
    { config: { action: "company.read" } },
    async (req) => {
      const taskId = uuidParam((req.params as { taskId: string }).taskId, "taskId");
      return (await approvalsForTask(db, req.companyId, taskId)).map(approvalToJson);
    },
  );

  // Approve: the hash is verified, the bound bytes are sent, the proposer continues.
  app.post(
    "/api/companies/:companyId/approvals/:approvalId/approve",
    { config: { action: "approval.decide" } },
    async (req) => {
      const id = uuidParam((req.params as { approvalId: string }).approvalId, "approvalId");
      const body = parseBody(ApprovalDecisionSchema, req.body);
      const decided = await approveApproval(
        db,
        queue,
        req.companyId,
        req.principal.actor,
        id,
        body.note,
        execute,
      );
      return {
        ...approvalToJson(decided.approval),
        restarted: { runId: decided.restartedRunId, reason: decided.restartReason },
      };
    },
  );

  // Reject: nothing is sent; the task stays blocked and Peter re-plans it.
  app.post(
    "/api/companies/:companyId/approvals/:approvalId/reject",
    { config: { action: "approval.decide" } },
    async (req) => {
      const id = uuidParam((req.params as { approvalId: string }).approvalId, "approvalId");
      const body = parseBody(ApprovalDecisionSchema, req.body);
      return approvalToJson(await rejectApproval(db, req.companyId, req.principal.actor, id, body.note));
    },
  );
}
