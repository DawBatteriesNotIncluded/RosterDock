import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addProject, addTeammate, seedCompany, startTestBoard, type Api, type TestBoard } from "./helpers.js";

let board: TestBoard;

beforeAll(async () => {
  board = await startTestBoard();
});
afterAll(async () => {
  await board.destroy();
});

/** Dispatch, claim and complete a run with the given usage. */
async function runToCompletion(api: Api, base: string, taskId: string, usage: Record<string, number>) {
  const dispatched = await api.post(`${base}/tasks/${taskId}/runs`, {});
  if (dispatched.status !== 201) return { dispatched, done: null };
  const run = dispatched.body;
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
  return { dispatched, done };
}

describe("budgets and prices", () => {
  it("prices a run from the model table", async () => {
    const { api, base } = await seedCompany(board, "b0@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const project = await addProject(api, base);
    const t = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "priced",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    expect(
      (
        await api.put(`${base}/prices`, {
          model: "claude-sonnet-5",
          currency: "GBP",
          inputPerMillion: 240,
          outputPerMillion: 1200,
        })
      ).status,
    ).toBe(200);
    const { done } = await runToCompletion(api, base, t.id, { inputTokens: 1_000_000, outputTokens: 700 });
    expect(done!.status).toBe(200);
    expect(done!.body.costMinorUnits).toBe(241); // 240p input + 0.84p output, rounded
    const prices = (await api.get(`${base}/prices`)).body;
    expect(prices).toHaveLength(1);
    expect(prices[0].model).toBe("claude-sonnet-5");
  });

  it("refuses to dispatch past a spent budget and alerts at 80% and 100%", async () => {
    const { api, base } = await seedCompany(board, "b1@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const project = await addProject(api, base);
    const mk = async (title: string) =>
      (
        await api.post(`${base}/tasks`, {
          projectId: project.id,
          title,
          assignee: { kind: "teammate", id: cody.id },
        })
      ).body as { id: string };

    expect(
      (await api.put(`${base}/budgets`, { scopeKind: "company", tokensLimit: 2000, window: "month" })).status,
    ).toBe(200);
    const first = await runToCompletion(api, base, (await mk("first")).id, {
      inputTokens: 1_000_000,
      outputTokens: 700,
    });
    expect(first.done!.status).toBe(200);

    // 1,000,700 used against a 2,000 budget: the next dispatch is refused.
    const refused = await api.post(`${base}/tasks/${(await mk("over budget")).id}/runs`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.details.blocker.code).toBe("token_budget_exhausted");
    expect(refused.body.error).toMatch(/company budget for GTM Studio/);

    // Raise the budget: usage already sits at 83% of it, so the next run crosses only 100%.
    await api.put(`${base}/budgets`, { scopeKind: "company", tokensLimit: 1_200_000, window: "month" });
    const second = await runToCompletion(api, base, (await mk("second")).id, { inputTokens: 250_000 });
    expect(second.done!.status).toBe(200);
    const all = (await api.get(`${base}/events`)).body.filter((e: any) => e.type === "budget.alert");
    // The first run blew the 2,000 budget in one go: 80% and 100% alerts against that limit.
    expect(
      all
        .filter((a: any) => a.payload.limit === 2000)
        .map((a: any) => a.payload.threshold)
        .sort((x: number, y: number) => x - y),
    ).toEqual([80, 100]);
    const alerts = all.filter((a: any) => a.payload.limit === 1_200_000);
    expect(alerts.map((a: any) => a.payload.threshold)).toEqual([100]);
    expect(alerts[0].payload.scopeKind).toBe("company");
    expect(alerts[0].payload.scopeName).toBe("GTM Studio");
    expect(alerts[0].payload.used).toBe(1_250_700);

    const budgets = (await api.get(`${base}/budgets`)).body;
    expect(budgets[0].used).toBe(1_250_700);
    expect(budgets[0].percent).toBe(104);
  });

  it("scopes budgets to the department, project or teammate they name", async () => {
    const { api, base } = await seedCompany(board, "b2@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const ricky = await addTeammate(api, base, "Ricky", "researcher");
    const project = await addProject(api, base);
    await api.put(`${base}/budgets`, {
      scopeKind: "teammate",
      scopeId: ricky.id,
      tokensLimit: 10,
      window: "week",
    });
    const rt = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "ricky",
        assignee: { kind: "teammate", id: ricky.id },
      })
    ).body;
    const ct = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "cody",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    const rickyRun = await runToCompletion(api, base, rt.id, { inputTokens: 50 });
    expect(rickyRun.done!.status).toBe(200);
    const again = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "ricky again",
        assignee: { kind: "teammate", id: ricky.id },
      })
    ).body;
    expect((await api.post(`${base}/tasks/${again.id}/runs`, {})).status).toBe(409);
    // Cody is unaffected by Ricky's budget.
    expect((await api.post(`${base}/tasks/${ct.id}/runs`, {})).status).toBe(201);
  });

  it("only owners and admins set budgets and prices", async () => {
    const { api, base } = await seedCompany(board, "b3@example.com");
    await api.post(`${base}/members`, { email: "vb@example.com", role: "viewer" });
    const viewer = board.api((await board.login("vb@example.com")).token);
    expect(
      (await viewer.put(`${base}/budgets`, { scopeKind: "company", tokensLimit: 1, window: "day" })).status,
    ).toBe(403);
    expect((await viewer.put(`${base}/prices`, { model: "m", currency: "GBP" })).status).toBe(403);
    expect((await viewer.get(`${base}/budgets`)).status).toBe(200);
  });
});
