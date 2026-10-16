// Peter's intake: a goal opens a project, is planned (by heuristic, or by the
// model against recorded responses), asks at most one round of questions,
// hands off tasks with criteria, outputs, dependencies and assignees, starts
// the first ones, and stays within its caps. No model, no network.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGoal, planGoal, type PeterDeps } from "../src/peter/goals.js";
import type { PeterModel } from "../src/peter/model.js";
import { fakeAnthropic } from "./anthropic-fake.js";
import {
  addProject,
  addTeammate,
  seatedPeter,
  seedCompany,
  startTestBoard,
  workerClaim,
  type Api,
  type TestBoard,
} from "./helpers.js";

let board: TestBoard;
let modelBoard: TestBoard;
const anthropic = fakeAnthropic();

beforeAll(async () => {
  board = await startTestBoard();
  modelBoard = await startTestBoard({ anthropicApiKey: "test-key-by-name" }, { modelFetch: anthropic.fetch });
});
afterAll(async () => {
  await board.destroy();
  await modelBoard.destroy();
});

async function team(api: Api, base: string) {
  const ricky = await addTeammate(api, base, "Ricky", "researcher");
  const brody = await addTeammate(api, base, "Brody", "requirements");
  const cody = await addTeammate(api, base, "Cody", "n8n engineer");
  const verifier = await addTeammate(api, base, "Verifier", "reviewer");
  return { ricky, brody, cody, verifier };
}

describe("goals by heuristic (no model configured)", () => {
  it("seats Peter with the company, plans a goal into a research → requirements → build chain and starts the first task", async () => {
    const { api, base } = await seedCompany(board, "g1@example.com");
    const peter = await seatedPeter(api, base);
    expect(peter.name).toBe("Peter");
    const { ricky, brody, cody } = await team(api, base);
    const res = await api.post(`${base}/goals`, {
      text: "Send a weekly digest of Gong calls with next steps to #sales every Friday.",
    });
    expect(res.status).toBe(201);
    const goal = res.body;
    expect(goal.status).toBe("active");
    expect(goal.planner).toBe("heuristic");
    expect(goal.title).toBe("Send a weekly digest of Gong calls with next steps to #sales every Friday");
    expect(
      goal.tasks.map((t: any) => [t.title.split(":")[0], t.assignee.id, t.workKind, t.declaredOutputs]),
    ).toEqual([
      ["Research", ricky.id, "research", ["research.md"]],
      ["Requirements", brody.id, "research", ["requirements.md"]],
      ["Build", cody.id, "build", ["deliverable.md"]],
    ]);
    // Dependencies chain, criteria are weighted, Peter is the creator.
    expect(goal.tasks[1].dependsOn).toEqual([goal.tasks[0].id]);
    expect(goal.tasks[2].dependsOn).toEqual([goal.tasks[1].id]);
    expect(goal.tasks[2].criteria[0]).toEqual({ text: "The goal's outcome is met", weight: 3 });
    expect(goal.tasks[0].createdBy).toEqual({ kind: "teammate", id: peter.id });
    // The first task started; the others wait on it.
    expect(goal.tasks.map((t: any) => t.status)).toEqual(["doing", "todo", "todo"]);
    const runs = (await api.get(`${base}/tasks/${goal.tasks[0].id}/runs`)).body;
    expect(runs).toHaveLength(1);
    expect(runs[0].createdBy).toEqual({ kind: "teammate", id: peter.id });
    // The project carries the goal.
    const project = (await api.get(`${base}/projects/${goal.projectId}`)).body;
    expect(project.goal).toContain("Done when:");
    // Spend is reported per goal.
    expect(goal.spend).toMatchObject({
      runs: 0,
      runTokens: 0,
      planningTokens: 0,
      totalTokens: 0,
      tokensCap: null,
    });
    const events = (await api.get(`${base}/events`)).body.map((e: any) => e.type);
    expect(events).toContain("goal.created");
    expect(events).toContain("goal.planned");
    const planned = (await api.get(`${base}/events`)).body.find((e: any) => e.type === "goal.planned");
    expect(planned.actor).toEqual({ kind: "teammate", id: peter.id });
    expect(planned.payload.assignees).toEqual(["Ricky", "Brody", "Cody"]);
    expect((await api.get(`${base}/goals`)).body).toHaveLength(1);
  });

  it("with nobody to do the work the goal needs you, and a stopped goal stays stopped", async () => {
    const { api, base } = await seedCompany(board, "g2@example.com");
    await addTeammate(api, base, "Verifier", "reviewer");
    const res = await api.post(`${base}/goals`, { text: "Reconcile Xero weekly." });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("needs_you");
    expect(res.body.attention).toMatch(/Hire a teammate/);
    expect(res.body.tasks).toEqual([]);
    const events = (await api.get(`${base}/events`)).body.map((e: any) => e.type);
    expect(events).toContain("goal.escalated");
    // An escalation is not a question: answers are refused.
    const answer = await api.post(`${base}/goals/${res.body.id}/answers`, { answers: ["ok"] });
    expect(answer.status).toBe(409);
    const stopped = await api.post(`${base}/goals/${res.body.id}/stop`, {});
    expect(stopped.body.status).toBe("stopped");
    expect((await api.post(`${base}/goals/${res.body.id}/stop`, {})).status).toBe(409);
  });

  it("caps what teammates can add to a goal: tasks per goal and depth", async () => {
    const { api, base } = await seedCompany(board, "g3@example.com");
    const { cody } = await team(api, base);
    const res = await api.post(`${base}/goals`, {
      text: "Build the thing.",
      caps: { maxTasks: 4, maxDepth: 1 },
    });
    expect(res.status).toBe(201);
    const goal = res.body;
    expect(goal.tasks).toHaveLength(3);
    // The research task is running; its run token files one follow-up (depth 1), which cannot file another (depth 2).
    const running = goal.tasks[0];
    const run = (await api.get(`${base}/tasks/${running.id}/runs`)).body[0];
    const job = (await board.db.query<{ job_id: string }>("SELECT job_id FROM runs WHERE id = $1", [run.id]))
      .rows[0]!;
    const claim = await board.app.inject({
      method: "POST",
      url: "/api/worker/claim",
      headers: { "x-rosterdock-worker-token": "test-worker-token" },
      payload: { runId: run.id, jobId: job.job_id, workerId: "w" },
    });
    const asRun = board.api(JSON.parse(claim.body).token);
    const { createTaskTool } = await import("../src/mcp/tools.js");
    const actor = {
      companyId: goal.companyId,
      teammateId: run.teammateId,
      teammateName: "Ricky",
      handle: "ricky",
      runId: run.id,
      taskId: running.id,
    };
    const deps = {
      db: board.db,
      queue: board.queue,
      hosts: { github: { fetch, token: null, apiBase: "" }, gitlab: null },
    };
    const child = await createTaskTool(deps, actor, { title: "Follow-up", assigneeHandle: "cody" });
    expect(child.parentTaskId).toBe(running.id);
    // A fifth task is over the goal's cap of 4.
    await expect(createTaskTool(deps, actor, { title: "One too many" })).rejects.toThrow(/capped at 4 tasks/);
    void asRun;
    void cody;
    // With the cap raised, depth still limits: a task filed from the follow-up would be 2 deep.
    await board.db.query("UPDATE goals SET caps = caps || '{\"maxTasks\": 10}' WHERE id = $1", [goal.id]);
    await expect(createTaskTool(deps, { ...actor, taskId: child.id }, { title: "Too deep" })).rejects.toThrow(
      /1 deep/,
    );
    // A person is not capped.
    const byHand = await api.post(`${base}/tasks`, { projectId: goal.projectId, title: "By hand" });
    expect(byHand.status).toBe(201);
  });

  it("a goal's token cap becomes a lifetime budget on its project that dispatch respects", async () => {
    const { api, base } = await seedCompany(board, "g4@example.com");
    await team(api, base);
    const res = await api.post(`${base}/goals`, { text: "Do it cheaply.", caps: { tokens: 1000 } });
    expect(res.body.spend.tokensCap).toBe(1000);
    const budgets = (await api.get(`${base}/budgets`)).body;
    expect(budgets).toEqual([
      expect.objectContaining({
        scopeKind: "project",
        scopeId: res.body.projectId,
        tokensLimit: 1000,
        window: "goal",
      }),
    ]);
    // Spend past the cap: the next task cannot start.
    const first = res.body.tasks[0];
    const run = (await api.get(`${base}/tasks/${first.id}/runs`)).body[0];
    await board.db.query(
      `INSERT INTO run_usage (company_id, run_id, task_id, teammate_id, project_id, model, input_tokens, output_tokens)
       VALUES ($1, $2, $3, $4, $5, 'claude-sonnet-5', 900, 200)`,
      [res.body.companyId, run.id, first.id, run.teammateId, res.body.projectId],
    );
    await api.post(`${base}/runs/${run.id}/stop`, {});
    const start = await api.post(`${base}/tasks/${first.id}/runs`, {});
    expect(start.status).toBe(409);
    expect(start.body.error).toMatch(/project budget/);
    // Another project is not affected.
    const other = await addProject(api, base, "Unrelated");
    const free = (
      await api.post(`${base}/tasks`, {
        projectId: other.id,
        title: "Elsewhere",
        assignee: { kind: "teammate", id: run.teammateId },
      })
    ).body;
    expect((await api.post(`${base}/tasks/${free.id}/runs`, {})).status).toBe(201);
  });

  it("a person changes a goal's caps after creation; the token cap moves the budget with it", async () => {
    const { api, base } = await seedCompany(board, "g6@example.com");
    const { ricky } = await team(api, base);
    const goal = (await api.post(`${base}/goals`, { text: "Change my caps.", caps: { tokens: 1000 } })).body;
    expect(goal.caps).toEqual({ maxTasks: 12, maxDepth: 2, tokens: 1000 });
    // The list carries the spend so the card can show money without a second request.
    const listed = (await api.get(`${base}/goals`)).body;
    expect(listed[0].spend).toMatchObject({ tokensCap: 1000, totalTokens: 0 });
    // Raise the task cap and the token cap: the project's lifetime budget follows.
    const raised = await api.patch(`${base}/goals/${goal.id}/caps`, { maxTasks: 20, tokens: 5000 });
    expect(raised.status).toBe(200);
    expect(raised.body.caps).toEqual({ maxTasks: 20, maxDepth: 2, tokens: 5000 });
    expect(raised.body.spend.tokensCap).toBe(5000);
    let budgets = (await api.get(`${base}/budgets`)).body;
    expect(budgets).toEqual([
      expect.objectContaining({ scopeId: goal.projectId, tokensLimit: 5000, window: "goal" }),
    ]);
    // Remove the token cap: the budget goes with it. Other caps stay.
    const freed = await api.patch(`${base}/goals/${goal.id}/caps`, { tokens: null });
    expect(freed.body.caps).toEqual({ maxTasks: 20, maxDepth: 2, tokens: null });
    budgets = (await api.get(`${base}/budgets`)).body;
    expect(budgets).toEqual([]);
    // Nothing to change, an empty body, and a number past the schema are refused.
    expect((await api.patch(`${base}/goals/${goal.id}/caps`, { maxTasks: 20 })).status).toBe(409);
    expect((await api.patch(`${base}/goals/${goal.id}/caps`, {})).status).toBe(400);
    expect((await api.patch(`${base}/goals/${goal.id}/caps`, { maxTasks: 500 })).status).toBe(400);
    // A teammate never widens a cap.
    const token = (await api.post(`${base}/teammates/${ricky.id}/tokens`, {})).body.token;
    expect((await board.api(token).patch(`${base}/goals/${goal.id}/caps`, { maxTasks: 30 })).status).toBe(
      403,
    );
    // The event says what moved.
    const events = (await api.get(`${base}/events`)).body.filter((e: any) => e.type === "goal.caps_changed");
    expect(events).toHaveLength(2);
    expect(events[0].payload).toMatchObject({ changed: ["tokens"], after: { tokens: null } });
    // A stopped goal keeps its caps.
    await api.post(`${base}/goals/${goal.id}/stop`, {});
    expect((await api.patch(`${base}/goals/${goal.id}/caps`, { maxTasks: 3 })).status).toBe(409);
  });

  it("dropping a goal stops the runs waiting for a worker and asks the live one to stop", async () => {
    const { api, base } = await seedCompany(board, "g7@example.com");
    const { cody } = await team(api, base);
    const goal = (await api.post(`${base}/goals`, { text: "Drop me." })).body;
    const first = goal.tasks[0];
    const queued = (await api.get(`${base}/tasks/${first.id}/runs`)).body[0];
    expect(queued.status).toBe("queued");
    // A worker claims it: that run is live. A hand-made task on the project waits for a worker.
    await workerClaim(board, queued.id);
    const byHand = (
      await api.post(`${base}/tasks`, {
        projectId: goal.projectId,
        title: "By hand",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    const waiting = (await api.post(`${base}/tasks/${byHand.id}/runs`, {})).body;
    expect(waiting.status).toBe("queued");
    const dropped = await api.post(`${base}/goals/${goal.id}/stop`, {});
    expect(dropped.body.status).toBe("stopped");
    // The waiting run is stopped; the live one is asked to stop. What the goal left is cancelled, not
    // put back on the board, and a run that ends on a cancelled task leaves it cancelled.
    expect((await api.get(`${base}/runs/${waiting.id}`)).body.status).toBe("stopped");
    expect((await api.get(`${base}/runs/${queued.id}`)).body).toMatchObject({
      status: "running",
      stopRequested: true,
    });
    const tasks = (await api.get(`${base}/tasks?projectId=${goal.projectId}`)).body as any[];
    expect(tasks.map((t) => t.status)).toEqual(["cancelled", "cancelled", "cancelled", "cancelled"]);
    const stopped = (await api.get(`${base}/events`)).body.find((e: any) => e.type === "goal.stopped");
    expect(stopped.payload).toMatchObject({
      runsStopped: [byHand.number],
      runsAsked: [first.number],
      tasksCancelled: [...goal.tasks.map((t: any) => t.number), byHand.number],
    });
    // A pass starts nothing on a stopped goal.
    const pass = (await api.post(`${base}/peter/pass`, {})).body;
    expect(pass.started).toEqual([]);
  });
});

describe("goals by model (recorded responses)", () => {
  it("asks one round of questions, plans after the answers, and never asks twice", async () => {
    const { api, base } = await seedCompany(modelBoard, "g5@example.com");
    const peter = await seatedPeter(api, base);
    const { ricky, brody, cody } = await team(api, base);
    await api.post(`${base}/departments`, {
      name: "Engineering",
      leadTeammateId: peter.id,
      memberTeammateIds: [cody.id],
    });
    anthropic.queue.push("plan-questions.json");
    const res = await api.post(`${base}/goals`, {
      text: "Send a weekly digest of Gong calls with next steps to #sales every Friday.",
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("needs_you");
    expect(res.body.questions.map((q: any) => q.answer)).toEqual([null, null]);
    expect(res.body.attention).toBe("Peter has 2 questions before planning.");
    expect(res.body.planningUsage).toEqual({ inputTokens: 1420, outputTokens: 310, calls: 1 });
    // The request: Peter's model, the roster in the system prompt, a structured output, no thinking budget.
    const req = anthropic.requests.at(-1)!;
    expect(req.path).toBe("/v1/messages");
    expect(req.headers["x-api-key"]).toBe("test-key-by-name");
    expect(req.body.model).toBe("claude-opus-5");
    expect(req.body.system).toContain("@cody (Cody), n8n engineer");
    expect(req.body.system).toContain("@ricky (Ricky), researcher");
    expect(req.body.system).not.toContain("@peter");
    expect(req.body.output_config?.format?.type).toBe("json_schema");
    expect(req.body.messages[0]!.content).toContain("If something essential is missing, ask now");

    // Too few answers is refused; the right number re-plans with the answers in the prompt.
    expect(
      (await api.post(`${base}/goals/${res.body.id}/answers`, { answers: ["#sales at 16:00"] })).status,
    ).toBe(422);
    anthropic.queue.push("plan-tasks.json");
    const answered = await api.post(`${base}/goals/${res.body.id}/answers`, {
      answers: ["#sales at 16:00", "All deals."],
    });
    expect(answered.status).toBe(200);
    expect(answered.body.status).toBe("active");
    expect(answered.body.planner).toBe("model:claude-opus-5");
    expect(answered.body.title).toBe("Weekly Gong digest to #sales");
    expect(anthropic.requests.at(-1)!.body.messages[0]!.content).toContain("A: #sales at 16:00");
    expect(anthropic.requests.at(-1)!.body.messages[0]!.content).toContain("questions must be empty");
    expect(answered.body.tasks.map((t: any) => [t.assignee.id, t.workKind, t.status])).toEqual([
      [ricky.id, "research", "doing"],
      [brody.id, "research", "todo"],
      [cody.id, "build", "todo"],
    ]);
    expect(answered.body.tasks[2].dependsOn).toEqual([answered.body.tasks[1].id]);
    expect(answered.body.tasks[2].declaredOutputs).toEqual(["gong-digest.workflow.json"]);
    expect(answered.body.planningUsage.calls).toBe(2);
    expect(answered.body.spend.planningTokens).toBe(1420 + 310 + 1690 + 940);
    // Routed to the department the model named.
    const depts = (await api.get(`${base}/departments`)).body;
    expect(answered.body.departmentId).toBe(depts[0].id);
    const events = (await api.get(`${base}/events`)).body.map((e: any) => e.type);
    expect(events).toContain("goal.questions");
    expect(events).toContain("goal.answered");
    expect(events).toContain("goal.planned");
  });

  it("a plan the board cannot accept, or a refusal, falls back to the heuristic and says so", async () => {
    const { api, base } = await seedCompany(modelBoard, "g6@example.com");
    await team(api, base);
    // Refused twice: the model had the board's reasons for its second try.
    anthropic.queue.push("plan-invalid.json", "plan-invalid.json");
    const bad = await api.post(`${base}/goals`, { text: "Build the digest." });
    expect(bad.body.status).toBe("active");
    expect(bad.body.planner).toMatch(/^heuristic \(the model's plan was refused: task 1 names @nobody/);
    expect(bad.body.tasks).toHaveLength(3);
    expect(bad.body.planningUsage.calls).toBe(2);
    anthropic.queue.push("refusal.json");
    const refused = await api.post(`${base}/goals`, { text: "Another one." });
    expect(refused.body.planner).toBe("heuristic (the model returned no plan)");
    // A refusal names nothing to put right, so it is not asked again.
    expect(refused.body.planningUsage.calls).toBe(1);
    // A failed call (nothing queued: the fake answers 500) also falls back.
    const failed = await api.post(`${base}/goals`, { text: "And a third." });
    expect(failed.body.status).toBe("active");
    expect(failed.body.planner).toMatch(/^heuristic \(the model call failed/);
  });

  it("a plan the board cannot accept goes back to the model once, with the reasons", async () => {
    const { api, base } = await seedCompany(modelBoard, "g6b@example.com");
    const { cody } = await team(api, base);
    // The recorded plan names this department.
    await api.post(`${base}/departments`, { name: "Engineering", memberTeammateIds: [cody.id] });
    const before = anthropic.requests.length;
    anthropic.queue.push("plan-invalid.json", "plan-tasks.json");
    const goal = await api.post(`${base}/goals`, { text: "Build the digest." });
    expect(goal.body.status).toBe("active");
    expect(goal.body.planner).toBe("model:claude-opus-5");
    // Both calls are counted, and the second read why the first was not accepted.
    expect(goal.body.planningUsage.calls).toBe(2);
    const [firstTry, secondTry] = anthropic.requests.slice(before).map((r) => r.body.messages[0]!.content);
    expect(firstTry).not.toMatch(/did not accept/);
    expect(secondTry).toMatch(
      /The board did not accept your last plan for this goal:\n- task 1 names @nobody/,
    );
    expect(secondTry).toContain(firstTry);
  });
});

describe("one planner per goal", () => {
  it("plans a goal once when two passes reach it together, and a dead planner's claim runs out", async () => {
    const { owner, api, base, companyId } = await seedCompany(board, "claim@example.com");
    await seatedPeter(api, base);
    await team(api, base);
    // A model as slow as a CLI call, counting how often it is asked.
    let calls = 0;
    const slow: PeterModel = {
      available: true,
      async complete(req) {
        calls++;
        await new Promise((r) => setTimeout(r, 300));
        const output = {
          title: "Claimed once",
          background: "",
          outcome: "One research note.",
          doneDefinition: "The note exists.",
          questions: [],
          department: null,
          tasks: [
            {
              title: "Research it",
              brief: "Write the note.",
              assignee: "@ricky",
              workKind: "research" as const,
              outputs: ["note.md"],
              criteria: [{ text: "The note answers the goal", weight: 1 }],
              dependsOn: [],
            },
          ],
        };
        return {
          output: output as never,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          model: req.model,
        };
      },
    };
    const deps: PeterDeps = {
      db: board.db,
      queue: board.queue,
      github: { fetch, token: null, apiBase: "" } as unknown as PeterDeps["github"],
      model: slow,
    };
    const actor = { kind: "user" as const, id: owner.userId };
    const tasksOf = async (goalId: string) =>
      (
        await board.db.query(
          "SELECT count(*)::int AS n FROM tasks t JOIN goals g ON g.project_id = t.project_id WHERE g.id = $1",
          [goalId],
        )
      ).rows[0].n;

    // The request and the loop at once: one model call, one set of tasks; the other pass leaves the goal alone.
    const goal = await createGoal(deps, companyId, actor, { text: "Write one research note." });
    const [a, b] = await Promise.all([planGoal(deps, goal.id), planGoal(deps, goal.id)]);
    expect(calls).toBe(1);
    expect([a.status, b.status].sort()).toEqual(["active", "planning"]);
    expect(await tasksOf(goal.id)).toBe(1);
    const after = (await board.db.query("SELECT status, planning_since FROM goals WHERE id = $1", [goal.id]))
      .rows[0];
    expect(after).toEqual({ status: "active", planning_since: null });

    // A claim that is still fresh is respected; one older than any model call is a planner that died.
    const held = await createGoal(deps, companyId, actor, { text: "Another note, held." });
    await board.db.query("UPDATE goals SET planning_since = now() WHERE id = $1", [held.id]);
    expect((await planGoal(deps, held.id)).status).toBe("planning");
    expect(calls).toBe(1);
    await board.db.query("UPDATE goals SET planning_since = now() - interval '11 minutes' WHERE id = $1", [
      held.id,
    ]);
    expect((await planGoal(deps, held.id)).status).toBe("active");
    expect(calls).toBe(2);
    expect(await tasksOf(held.id)).toBe(1);
  });
});
