// The cost report: tokens to money by department, project, teammate and
// model; API billing next to seat billing; forecast and budget.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addProject, addTeammate, seedCompany, startTestBoard, type Api, type TestBoard } from "./helpers.js";

let board: TestBoard;

beforeAll(async () => {
  board = await startTestBoard();
});
afterAll(async () => {
  await board.destroy();
});

async function runToCompletion(api: Api, base: string, taskId: string, usage: Record<string, number>) {
  const run = (await api.post(`${base}/tasks/${taskId}/runs`, {})).body;
  const job = (await board.db.query<{ job_id: string }>("SELECT job_id FROM runs WHERE id = $1", [run.id]))
    .rows[0]!.job_id;
  const claimed = await board.app.inject({
    method: "POST",
    url: "/api/worker/claim",
    headers: { "x-rosterdock-worker-token": "test-worker-token" },
    payload: { runId: run.id, jobId: job, workerId: "w" },
  });
  const token = JSON.parse(claimed.body).token as string;
  const done = await board
    .api(token)
    .post(`/api/worker/runs/${run.id}/complete`, { status: "completed", summary: "ok", usage });
  if (done.status !== 200) throw new Error(JSON.stringify(done.body));
}

describe("cost report", () => {
  it("adds up tokens and money by department, project, teammate and model, with seats and a forecast", async () => {
    const { api, base, companyId } = await seedCompany(board, "c1@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const ricky = await addTeammate(api, base, "Ricky", "researcher");
    const eng = (await api.post(`${base}/departments`, { name: "Engineering", writePolicy: "drafts" })).body;
    await api.put(`${base}/departments/${eng.id}/members/${cody.id}`, { isLead: true });
    const project = await addProject(api, base);
    const other = await addProject(api, base, "Gong digest");
    // Cody's model is priced per token; Ricky's engine has a seat price and no token price.
    await api.put(`${base}/prices`, {
      model: "claude-sonnet-5",
      currency: "GBP",
      inputPerMillion: 240,
      outputPerMillion: 1200,
    });
    await api.put(`${base}/prices`, { model: "claude_code", currency: "GBP", seatPriceMonth: 20_000 });
    await api.patch(`${base}/teammates/${ricky.id}`, { model: "haiku" });
    await api.put(`${base}/budgets`, { scopeKind: "company", tokensLimit: 10_000_000, window: "week" });
    await api.put(`${base}/budgets`, {
      scopeKind: "department",
      scopeId: eng.id,
      tokensLimit: 2_000_000,
      window: "week",
    });

    const t1 = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "a",
        departmentId: eng.id,
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    const t2 = (
      await api.post(`${base}/tasks`, {
        projectId: other.id,
        title: "b",
        assignee: { kind: "teammate", id: ricky.id },
      })
    ).body;
    await runToCompletion(api, base, t1.id, { inputTokens: 1_000_000, outputTokens: 1000 });
    await runToCompletion(api, base, t2.id, { inputTokens: 500_000, cacheReadTokens: 100_000 });

    const res = await api.get(`${base}/costs?window=week`);
    expect(res.status).toBe(200);
    const r = res.body;
    expect(r.window).toBe("week");
    expect(r.currency).toBe("GBP");
    expect(r.totals.tokens.total).toBe(1_601_000);
    expect(r.totals.runs).toBe(2);
    expect(r.totals.costMinorUnits).toBe(241); // Cody's run; Ricky's model has no per-token price
    // Two seats on claude_code, pro-rated to a week: 20000 * 7 / 30.4 each.
    // Three claude_code seats: Cody, Ricky and the seated Peter.
    expect(r.totals.seatMinorUnits).toBe(3 * Math.round((20_000 * 7) / 30.4));
    expect(r.forecast.costMinorUnits).toBeGreaterThanOrEqual(241);
    expect(r.forecast.tokens).toBeGreaterThanOrEqual(1_601_000);
    expect(r.budget).toEqual({ tokensLimit: 10_000_000, used: 1_601_000, percent: 16, window: "week" });

    const engLine = r.byDepartment.find((d: any) => d.id === eng.id);
    expect(engLine.tokens.total).toBe(1_001_000);
    expect(engLine.teammates).toBe(1);
    expect(engLine.budget.percent).toBe(50);
    expect(r.byDepartment.find((d: any) => d.id === null).tokens.total).toBe(600_000);

    expect(r.byProject.map((p: any) => [p.name, p.tokens.total])).toEqual([
      ["VMS architecture map", 1_001_000],
      ["Gong digest", 600_000],
    ]);
    const codyLine = r.byTeammate.find((m: any) => m.id === cody.id);
    expect(codyLine.departmentName).toBe("Engineering");
    expect(codyLine.costMinorUnits).toBe(241);
    expect(codyLine.tokens.cacheRead).toBe(0);
    const rickyLine = r.byTeammate.find((m: any) => m.id === ricky.id);
    expect(rickyLine.costMinorUnits).toBeNull();
    expect(rickyLine.tokens.cacheRead).toBe(100_000);
    expect(r.byModel.map((m: any) => m.model).sort()).toEqual(["claude-sonnet-5", "haiku"]);
    expect(r.bySeat).toEqual([{ key: "claude_code", teammates: 3, seatMinorUnits: r.totals.seatMinorUnits }]);
    expect(r.daily).toHaveLength(1);
    expect(r.daily[0].tokens).toBe(1_601_000);
    expect(r.daily[0].costMinorUnits).toBe(241);
    expect(r.prices).toBe(2);

    // A price set after the run prices it on the report (cache reads fall back to the input price).
    await api.put(`${base}/prices`, { model: "haiku", currency: "GBP", inputPerMillion: 100 });
    const again = (await api.get(`${base}/costs?window=week`)).body;
    expect(again.byTeammate.find((m: any) => m.id === ricky.id).costMinorUnits).toBe(60);
    expect(again.totals.costMinorUnits).toBe(301);
    expect(again.daily[0].costMinorUnits).toBe(301);
    void companyId;
  });

  it("list prices fill the models the company uses and has not priced, and price the runs already done", async () => {
    const { api, base } = await seedCompany(board, "c-list@example.com");
    const cody = await addTeammate(api, base, "Cody"); // claude-sonnet-5
    const dex = await addTeammate(api, base, "Dex", "automation engineer");
    await api.patch(`${base}/teammates/${dex.id}`, { engine: "codex", model: "gpt-6-astra" });
    const project = await addProject(api, base);
    const task = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "a",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    await runToCompletion(api, base, task.id, {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 2_000_000,
    });
    // A price a person set (the seated Peter's model) is theirs and stays.
    await api.put(`${base}/prices`, { model: "claude-opus-5-5", currency: "USD", inputPerMillion: 1 });

    const filled = await api.post(`${base}/prices/list`, {});
    expect(filled.status).toBe(200);
    // Codex's model has no published list price: said, not guessed.
    expect(filled.body).toEqual({ added: ["claude-sonnet-5"], unknown: ["gpt-6-astra"] });
    const prices = (await api.get(`${base}/prices`)).body as any[];
    expect(prices.find((x) => x.model === "claude-sonnet-5")).toMatchObject({
      currency: "USD",
      inputPerMillion: 200,
      outputPerMillion: 1000,
      cacheReadPerMillion: 20,
      cacheWritePerMillion: 250,
    });
    expect(prices.find((x) => x.model === "claude-opus-5-5")).toMatchObject({ inputPerMillion: 1 });
    // The run done before there were prices is priced now: $2 in, $10 out, $0.20 a million cache reads.
    expect((await api.get(`${base}/costs?window=week`)).body.totals.costMinorUnits).toBe(200 + 100 + 40);
    // A second fill has nothing to add.
    expect((await api.post(`${base}/prices/list`, {})).body).toEqual({ added: [], unknown: ["gpt-6-astra"] });
  });

  it("a stub run counts under the stub, not the model its teammate names, and has no price", async () => {
    // Seen on a live board: a stub teammate on claude-sonnet-5-5 had its runs listed and priced as that model.
    const { api, base } = await seedCompany(board, "c-stub@example.com");
    const stubby = await addTeammate(api, base, "Stubby");
    await api.patch(`${base}/teammates/${stubby.id}`, { engine: "stub", model: "claude-sonnet-5-5" });
    await api.put(`${base}/prices`, {
      model: "claude-sonnet-5-5",
      currency: "GBP",
      inputPerMillion: 240,
      outputPerMillion: 1200,
    });
    const project = await addProject(api, base);
    const task = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "a",
        assignee: { kind: "teammate", id: stubby.id },
      })
    ).body;
    await runToCompletion(api, base, task.id, { inputTokens: 1200, outputTokens: 300 });

    const r = (await api.get(`${base}/costs?window=week`)).body;
    expect(
      r.byModel.map((m: any) => [m.model, m.teammates, m.runs, m.tokens.total, m.costMinorUnits]),
    ).toEqual([["stub", 1, 1, 1500, null]]);
    expect(r.byTeammate.find((m: any) => m.id === stubby.id)).toMatchObject({
      model: "stub",
      engine: "stub",
      costMinorUnits: null,
    });
    expect(r.totals.costMinorUnits).toBeNull();
    const [run] = (await api.get(`${base}/tasks/${task.id}/runs`)).body as any[];
    expect(run.costMinorUnits).toBeNull();
    const month = (await api.get(`${base}/costs/monthly`)).body;
    expect(month.byModel.map((m: any) => m.model)).toEqual(["stub"]);
    expect(month.byTeammate.find((m: any) => m.id === stubby.id).model).toBe("stub");
    // Filling list prices asks nobody to price the stub.
    expect((await api.post(`${base}/prices/list`, {})).body.unknown).not.toContain("stub");
  });

  it("an empty company reports zeros, no budget and no seats", async () => {
    const { api, base } = await seedCompany(board, "c2@example.com");
    const r = (await api.get(`${base}/costs`)).body;
    expect(r.totals.tokens.total).toBe(0);
    expect(r.totals.costMinorUnits).toBeNull();
    expect(r.budget).toBeNull();
    // Only the seated Peter, with nothing spent.
    expect(r.byTeammate.map((m: any) => [m.handle, m.tokens.total])).toEqual([["peter", 0]]);
    expect(r.daily).toEqual([]);
    // Unknown windows fall back to the week.
    expect((await api.get(`${base}/costs?window=year`)).body.window).toBe("week");
  });

  it("runs can be listed by several statuses at once", async () => {
    const { api, base } = await seedCompany(board, "c3@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const project = await addProject(api, base);
    const t = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "a",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    await api.post(`${base}/tasks/${t.id}/runs`, {});
    expect((await api.get(`${base}/runs?status=queued,running`)).body).toHaveLength(1);
    expect((await api.get(`${base}/runs?status=running`)).body).toHaveLength(0);
  });
});
