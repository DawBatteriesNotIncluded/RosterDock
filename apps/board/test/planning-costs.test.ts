// A manager's own model calls count like runs: a goal's plan, a re-plan note
// (on a task outside any goal too) and an org proposal each leave a row of
// usage under the manager who made the call and the model that answered, so
// Costs, the monthly report, the CSV and the budgets count and price them like
// any run. The model answers from recorded responses; no network.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeAnthropic } from "./anthropic-fake.js";
import {
  addProject,
  addTeammate,
  seatedPeter,
  seedCompany,
  startTestBoard,
  workerClaim,
  workerComplete,
  type TestBoard,
} from "./helpers.js";

let board: TestBoard;
const anthropic = fakeAnthropic();

beforeAll(async () => {
  board = await startTestBoard({ anthropicApiKey: "test-key-by-name" }, { modelFetch: anthropic.fetch });
});
afterAll(async () => {
  await board.destroy();
});

describe("planning in Costs and budgets", () => {
  it("counts a goal's plan under Peter, the model that answered and the goal's project, priced and budgeted like a run", async () => {
    const { api, base } = await seedCompany(board, "pc1@example.com");
    const peter = await seatedPeter(api, base);
    await addTeammate(api, base, "Ricky", "researcher");
    await addTeammate(api, base, "Brody", "requirements");
    const cody = await addTeammate(api, base, "Cody", "n8n engineer");
    // The recorded plan routes the goal to this department.
    const eng = (await api.post(`${base}/departments`, { name: "Engineering", memberTeammateIds: [cody.id] }))
      .body;
    await api.put(`${base}/prices`, {
      model: "claude-opus-5",
      currency: "GBP",
      inputPerMillion: 100_000,
      outputPerMillion: 500_000,
    });
    await api.put(`${base}/budgets`, { scopeKind: "company", tokensLimit: 3000, window: "week" });
    anthropic.queue.push("plan-tasks.json");
    const goal = (
      await api.post(`${base}/goals`, {
        text: "Send a weekly digest of Gong calls to #sales.",
        caps: { tokens: 10_000 },
      })
    ).body;
    expect(goal.planner).toBe("model:claude-opus-5");
    expect(goal.departmentId).toBe(eng.id);
    // The recorded answer: 1,690 tokens in at £1,000 a million, 940 out at £5,000 a million.
    const planned = 1690 + 940;
    const cost = 169 + 470;

    const r = (await api.get(`${base}/costs?window=week`)).body;
    expect(r.totals).toMatchObject({ runs: 0, calls: 1, costMinorUnits: cost });
    expect(r.totals.tokens.total).toBe(planned);
    // Peter's line has his planning, where it said 0 tokens before.
    expect(r.byTeammate.find((t: any) => t.id === peter.id)).toMatchObject({
      tokens: { input: 1690, output: 940, total: planned },
      costMinorUnits: cost,
      runs: 0,
      calls: 1,
    });
    expect(r.byTeammate.find((t: any) => t.id === cody.id).tokens.total).toBe(0);
    expect(r.byModel.find((m: any) => m.model === "claude-opus-5")).toMatchObject({
      tokens: { total: planned },
      costMinorUnits: cost,
      calls: 1,
    });
    expect(r.byProject.find((p: any) => p.id === goal.projectId)).toMatchObject({
      tokens: { total: planned },
      calls: 1,
    });
    // It counts under the department the goal was in when Peter planned it: none yet, the plan routed it.
    expect(r.byDepartment.find((d: any) => d.id === null).tokens.total).toBe(planned);
    expect(r.daily).toEqual([{ day: expect.any(String), tokens: planned, costMinorUnits: cost }]);
    expect(r.forecast.tokens).toBeGreaterThanOrEqual(planned);

    // The budgets count it: the company's week, past 80% and said so by Peter; the goal's cap.
    expect(r.budget).toEqual({ tokensLimit: 3000, used: planned, percent: 87, window: "week" });
    const budgets = (await api.get(`${base}/budgets`)).body as any[];
    expect(budgets.find((b) => b.scopeKind === "company").used).toBe(planned);
    expect(budgets.find((b) => b.scopeKind === "goal")).toMatchObject({ scopeId: goal.id, used: planned });
    const alerts = ((await api.get(`${base}/events`)).body as any[]).filter((e) => e.type === "budget.alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].actor).toEqual({ kind: "teammate", id: peter.id });
    expect(alerts[0].payload).toMatchObject({
      scopeKind: "company",
      threshold: 80,
      percent: 87,
      used: planned,
    });

    // The goal's card prices its planning too.
    expect((await api.get(`${base}/goals/${goal.id}`)).body.spend).toMatchObject({
      runTokens: 0,
      planningTokens: planned,
      planningCalls: 1,
      totalTokens: planned,
      costMinorUnits: cost,
      currency: "GBP",
    });
  });

  it("counts a re-plan outside any goal and an org proposal, in the month and the CSV, and a budget they spend stops runs", async () => {
    const { owner, api, base } = await seedCompany(board, "pc2@example.com");
    const peter = await seatedPeter(api, base);
    const cody = await addTeammate(api, base, "Cody");
    const project = await addProject(api, base);
    await api.put(`${base}/budgets`, {
      scopeKind: "teammate",
      scopeId: peter.id,
      tokensLimit: 1_000_000,
      window: "month",
    });

    // A task filed by hand, outside any goal: its run fails and Peter re-plans it with the model.
    const task = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "Digest by hand",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    expect(task.goalId).toBeNull();
    const run = (await api.post(`${base}/tasks/${task.id}/runs`, {})).body;
    const claimed = await workerClaim(board, run.id);
    await workerComplete(board, claimed.token, run.id, {
      status: "failed",
      error: "tests ran too early",
      usage: { inputTokens: 1000, outputTokens: 100 },
    });
    anthropic.queue.push("replan.json");
    expect((await api.post(`${base}/peter/pass`, {})).body.replanned.map((x: any) => x.taskId)).toEqual([
      task.id,
    ]);
    // And an org proposal, which serves no project.
    anthropic.queue.push("org-proposal.json");
    expect(
      (await api.post(`${base}/drafts/org`, { brief: "Staff a research agency for client Globex." })).status,
    ).toBe(201);
    const replanned = 640 + 90;
    const proposed = 2100 + 700;

    const m = (await api.get(`${base}/costs/monthly`)).body;
    expect(m.totals).toMatchObject({ runs: 1, calls: 2 });
    expect(m.totals.tokens.total).toBe(1100 + replanned + proposed);
    expect(m.byTeammate.find((t: any) => t.id === peter.id)).toMatchObject({
      runs: 0,
      calls: 2,
      tokens: { total: replanned + proposed },
    });
    expect(m.byTeammate.find((t: any) => t.id === cody.id)).toMatchObject({ runs: 1, calls: 0 });
    // The re-plan counts in the task's project; the org proposal in no project.
    expect(m.byProject.find((p: any) => p.id === project.id)).toMatchObject({
      runs: 1,
      calls: 1,
      tokens: { total: 1100 + replanned },
    });
    expect(m.byModel.find((x: any) => x.model === "claude-opus-5")).toMatchObject({
      calls: 2,
      tokens: { total: replanned + proposed },
    });
    expect((await api.get(`${base}/budgets`)).body[0]).toMatchObject({
      scopeKind: "teammate",
      used: replanned + proposed,
    });

    // The usage CSV: a line per call next to the run's, with what it was and no run.
    const csv = await board.app.inject({
      method: "GET",
      url: `${base}/costs/export.csv?window=month`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    const [header, ...lines] = csv.body
      .trim()
      .split("\r\n")
      .map((l) => l.split(","));
    const col = (row: string[], name: string) => row[header!.indexOf(name)];
    expect(lines.map((l) => col(l, "kind"))).toEqual(["run", "re-plan", "org proposal"]);
    const [runLine, replanLine, orgLine] = lines as [string[], string[], string[]];
    expect(col(runLine, "teammate")).toBe("Cody");
    expect(col(replanLine, "run_id")).toBe("");
    expect(col(replanLine, "task")).toBe(`#${task.number}`);
    expect(col(replanLine, "task_title")).toBe("Digest by hand");
    expect(col(replanLine, "teammate")).toBe("Peter");
    expect(col(replanLine, "project")).toBe("VMS architecture map");
    expect(col(replanLine, "model")).toBe("claude-opus-5");
    expect(col(replanLine, "total_tokens")).toBe(String(replanned));
    expect(col(orgLine, "task")).toBe("");
    expect(col(orgLine, "project")).toBe("");
    expect(col(orgLine, "teammate")).toBe("Peter");
    expect(col(orgLine, "total_tokens")).toBe(String(proposed));

    // A company budget the run and the calls have spent between them stops the next run at dispatch.
    await api.put(`${base}/budgets`, { scopeKind: "company", tokensLimit: 4000, window: "month" });
    const next = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "Another",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    const refused = await api.post(`${base}/tasks/${next.id}/runs`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(
      `the company budget for GTM Studio is spent: ${(1100 + replanned + proposed).toLocaleString()} of 4,000 tokens this month`,
    );
  });
});
