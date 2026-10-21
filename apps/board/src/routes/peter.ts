// Peter's routes: goals a person hands him, his answers and his spend.
import {
  AnswerGoalSchema,
  CreateGoalSchema,
  ProposeOrgSchema,
  UpdateGoalCapsSchema,
} from "@rosterdock/shared";
import type { FastifyInstance } from "fastify";
import {
  answerGoal,
  createGoal,
  goalDetail,
  goalSpend,
  goalToJson,
  listGoals,
  planGoal,
  stopGoal,
  updateGoalCaps,
  type PeterDeps,
} from "../peter/goals.js";
import {
  acceptDraft,
  auditCompany,
  draftToJson,
  listDrafts,
  proposeOrg,
  rejectDraft,
} from "../peter/architect.js";
import { peterPass } from "../peter/loop.js";
import { goalResult, goalResultZip } from "../peter/result.js";
import { parseBody, uuidParam } from "../validate.js";
import type { PlannerRouter } from "../peter/planners.js";

export function registerPeterRoutes(app: FastifyInstance, deps: PeterDeps, planners: PlannerRouter): void {
  // How Peter thinks for this company: what it chose, what that comes to here, and every brain the board
  // offers with whether it works (the CLIs are asked; ?refresh=1 asks again now). Set it with a company PATCH.
  app.get("/api/companies/:companyId/planner", { config: { action: "company.read" } }, async (req) => {
    const refresh = (req.query as { refresh?: string }).refresh === "1";
    const options = await planners.statuses(refresh);
    const resolved = await planners.resolve(req.companyId);
    return {
      choice: resolved.choice,
      effective: resolved.kind,
      reason: resolved.reason,
      options: options.map((o) => ({
        kind: o.kind,
        label: o.label,
        available: o.available,
        detail: o.detail,
      })),
    };
  });

  // Run one pass of Peter's loop now (it also runs on events and on its timer).
  app.post("/api/companies/:companyId/peter/pass", { config: { action: "company.update" } }, async (req) => {
    return peterPass(deps, req.companyId, { chase: deps.chase });
  });

  app.get("/api/companies/:companyId/goals", { config: { action: "company.read" } }, async (req) => {
    const out = [];
    for (const g of await listGoals(deps.db, req.companyId))
      out.push({ ...goalToJson(g), spend: await goalSpend(deps.db, g) });
    return out;
  });

  // A person raises or lowers a goal's caps; the token cap is the goal's lifetime budget.
  app.patch(
    "/api/companies/:companyId/goals/:goalId/caps",
    { config: { action: "goal.caps" } },
    async (req) => {
      const id = uuidParam((req.params as { goalId: string }).goalId, "goalId");
      const body = parseBody(UpdateGoalCapsSchema, req.body);
      const goal = await updateGoalCaps(deps, req.companyId, req.principal.actor, id, body);
      return goalDetail(deps.db, req.companyId, goal.id);
    },
  );

  // Hand Peter a goal: a project opens at once and Peter plans it before answering.
  app.post(
    "/api/companies/:companyId/goals",
    { config: { action: "project.manage" } },
    async (req, reply) => {
      const body = parseBody(CreateGoalSchema, req.body);
      const goal = await createGoal(deps, req.companyId, req.principal.actor, body);
      const planned = await planGoal(deps, goal.id);
      reply.code(201);
      return goalDetail(deps.db, req.companyId, planned.id);
    },
  );

  app.get("/api/companies/:companyId/goals/:goalId", { config: { action: "company.read" } }, async (req) => {
    const id = uuidParam((req.params as { goalId: string }).goalId, "goalId");
    return goalDetail(deps.db, req.companyId, id);
  });

  // What the goal produced: the files it delivered and what its live writes left behind.
  app.get(
    "/api/companies/:companyId/goals/:goalId/result",
    { config: { action: "company.read" } },
    async (req) => {
      const id = uuidParam((req.params as { goalId: string }).goalId, "goalId");
      return goalResult(deps.db, req.companyId, id);
    },
  );

  // Every file it delivered, in one zip.
  app.get(
    "/api/companies/:companyId/goals/:goalId/result.zip",
    { config: { action: "company.read" } },
    async (req, reply) => {
      const id = uuidParam((req.params as { goalId: string }).goalId, "goalId");
      const zip = await goalResultZip(deps.db, deps.store ?? null, req.companyId, id);
      reply.header("content-type", "application/zip");
      reply.header("content-disposition", `attachment; filename="${zip.filename}"`);
      return reply.send(zip.bytes);
    },
  );

  // Answer Peter's questions; he plans again with the answers.
  app.post(
    "/api/companies/:companyId/goals/:goalId/answers",
    { config: { action: "project.manage" } },
    async (req) => {
      const id = uuidParam((req.params as { goalId: string }).goalId, "goalId");
      const body = parseBody(AnswerGoalSchema, req.body);
      const goal = await answerGoal(deps, req.companyId, req.principal.actor, id, body.answers);
      return goalDetail(deps.db, req.companyId, goal.id);
    },
  );

  // Peter as architect: drafts a person accepts. Nobody is granted a tool here.
  app.get("/api/companies/:companyId/drafts", { config: { action: "company.read" } }, async (req) => {
    return (await listDrafts(deps.db, req.companyId)).map(draftToJson);
  });
  app.post(
    "/api/companies/:companyId/drafts/org",
    { config: { action: "department.manage" } },
    async (req, reply) => {
      const body = parseBody(ProposeOrgSchema, req.body);
      reply.code(201);
      return draftToJson(await proposeOrg(deps, req.companyId, body.brief));
    },
  );
  app.post(
    "/api/companies/:companyId/drafts/audit",
    { config: { action: "department.manage" } },
    async (req, reply) => {
      reply.code(201);
      return draftToJson(await auditCompany(deps, req.companyId));
    },
  );
  app.post(
    "/api/companies/:companyId/drafts/:draftId/accept",
    { config: { action: "department.manage" } },
    async (req) => {
      const id = uuidParam((req.params as { draftId: string }).draftId, "draftId");
      return draftToJson(await acceptDraft(deps, req.companyId, req.principal.actor, id));
    },
  );
  app.post(
    "/api/companies/:companyId/drafts/:draftId/reject",
    { config: { action: "department.manage" } },
    async (req) => {
      const id = uuidParam((req.params as { draftId: string }).draftId, "draftId");
      return draftToJson(await rejectDraft(deps, req.companyId, req.principal.actor, id));
    },
  );

  app.post(
    "/api/companies/:companyId/goals/:goalId/stop",
    { config: { action: "project.manage" } },
    async (req) => {
      const id = uuidParam((req.params as { goalId: string }).goalId, "goalId");
      const goal = await stopGoal(deps, req.companyId, req.principal.actor, id);
      return goalDetail(deps.db, req.companyId, goal.id);
    },
  );
}
