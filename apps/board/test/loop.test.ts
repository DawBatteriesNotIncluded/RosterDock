// Peter's loop: a failed run is re-planned with nobody watching, twice, then
// the goal turns amber; tasks start when what they wait on is Done; a review
// sent back restarts the author; reviews that go round too long escalate;
// load is rebalanced between teammates of one role; a goal closes with its
// spend when every task is Done; the loop wakes on events. No model, no
// network: the worker is played by hand and the model by recorded responses.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeAnthropic } from "./anthropic-fake.js";
import { peterPass, startPeterLoop } from "../src/peter/loop.js";
import { MAX_REPLANS, MAX_REVIEW_ROUNDS } from "../src/peter/replan.js";
import {
  addProject,
  addTeammate,
  seatedPeter,
  seedCompany,
  startTestBoard,
  workerClaim,
  workerComplete,
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

const deps = () => ({
  db: board.db,
  queue: board.queue,
  github: { fetch, token: null, apiBase: "" },
  model: {
    available: false,
    complete: async () => {
      throw new Error("no model");
    },
  },
});

async function team(api: Api, base: string) {
  const ricky = await addTeammate(api, base, "Ricky", "researcher");
  const brody = await addTeammate(api, base, "Brody", "requirements");
  const cody = await addTeammate(api, base, "Cody", "n8n engineer");
  return { ricky, brody, cody };
}

async function runOf(api: Api, base: string, taskId: string) {
  const runs = (await api.get(`${base}/tasks/${taskId}/runs`)).body as {
    id: string;
    status: string;
    note: string | null;
  }[];
  return runs[0]!;
}

describe("Peter's loop", () => {
  it("re-plans a failed run without a human, twice, then turns the goal amber", async () => {
    const { api, base, companyId } = await seedCompany(board, "l1@example.com");
    const peter = await seatedPeter(api, base);
    await team(api, base);
    const goal = (await api.post(`${base}/goals`, { text: "Ship the Gong digest." })).body;
    const research = goal.tasks[0];
    // The worker fails the run. Nobody touches the board.
    let run = await runOf(api, base, research.id);
    let claimed = await workerClaim(board, run.id);
    await workerComplete(board, claimed.token, run.id, {
      status: "failed",
      error: "npm test exited with code 1",
    });
    expect((await api.get(`${base}/tasks/${research.id}`)).body.status).toBe("blocked");

    const first = await peterPass(deps(), companyId);
    expect(first.replanned).toHaveLength(1);
    expect(first.escalated).toEqual([]);
    const task = (await api.get(`${base}/tasks/${research.id}`)).body;
    expect(task.status).toBe("doing");
    expect(task.replans).toBe(1);
    run = await runOf(api, base, research.id);
    expect(run.id).toBe(first.replanned[0]!.runId);
    // The new run's pack carries Peter's note and the failure.
    claimed = await workerClaim(board, run.id);
    expect(claimed.pack).toContain(
      "Re-planned by Peter after a failed run. Attempt 1 failed: npm test exited with code 1",
    );
    expect(claimed.pack).toContain("Start from what already exists");
    const events = (await api.get(`${base}/events`)).body as any[];
    const replanned = events.find((e) => e.type === "task.replanned");
    expect(replanned.actor).toEqual({ kind: "teammate", id: peter.id });
    expect(replanned.payload).toMatchObject({
      number: research.number,
      replans: 1,
      error: "npm test exited with code 1",
    });
    const msgs = (await api.get(`${base}/tasks/${research.id}/messages`)).body as any[];
    expect(msgs.at(-1).author.name).toBe("Peter");
    expect(msgs.at(-1).body).toMatch(/^Re-planned after attempt 1/);

    // A second failure is re-planned again; a third is not: the goal needs a person, the task stays blocked.
    await workerComplete(board, claimed.token, run.id, { status: "failed", error: "still failing" });
    expect((await peterPass(deps(), companyId)).replanned).toHaveLength(1);
    expect((await api.get(`${base}/tasks/${research.id}`)).body.replans).toBe(MAX_REPLANS);
    run = await runOf(api, base, research.id);
    claimed = await workerClaim(board, run.id);
    await workerComplete(board, claimed.token, run.id, { status: "failed", error: "third strike" });
    const third = await peterPass(deps(), companyId);
    expect(third.replanned).toEqual([]);
    expect(third.escalated).toHaveLength(1);
    expect(third.escalated[0]!.reason).toMatch(/failed 3 times; the last error: third strike/);
    const g = (await api.get(`${base}/goals/${goal.id}`)).body;
    expect(g.status).toBe("needs_you");
    expect(g.attention).toMatch(/failed 3 times/);
    expect((await api.get(`${base}/tasks/${research.id}`)).body.status).toBe("blocked");
    // Another pass changes nothing.
    const again = await peterPass(deps(), companyId);
    expect(again.escalated).toEqual([]);
    expect(again.replanned).toEqual([]);
    expect(
      (await api.get(`${base}/events`)).body.filter((e: any) => e.type === "goal.escalated"),
    ).toHaveLength(1);
    expect(again.resumed).toEqual([]);

    // The person deals with it (fixes the cause, puts the task back in To do): the goal carries on by itself.
    expect((await api.post(`${base}/tasks/${research.id}/move`, { status: "todo" })).status).toBe(200);
    const resumed = await peterPass(deps(), companyId);
    expect(resumed.resumed).toEqual([goal.id]);
    expect(resumed.started.map((s) => s.taskId)).toEqual([research.id]);
    const back = (await api.get(`${base}/goals/${goal.id}`)).body;
    expect(back.status).toBe("active");
    expect(back.attention).toBeNull();
    const carried = (await api.get(`${base}/events`)).body.find((e: any) => e.type === "goal.resumed");
    expect(carried.actor).toEqual({ kind: "teammate", id: peter.id });
    expect(carried.payload.was).toMatch(/failed 3 times/);
  });

  it("starts tasks when what they wait on is Done, and closes the goal with its spend", async () => {
    const { api, base, companyId } = await seedCompany(board, "l2@example.com");
    const { brody, cody } = await team(api, base);
    void brody;
    void cody;
    await api.put(`${base}/prices`, {
      model: "claude-sonnet-5",
      currency: "GBP",
      inputPerMillion: 1000,
      outputPerMillion: 1000,
    });
    const goal = (await api.post(`${base}/goals`, { text: "Three steps." })).body;
    const [research, requirements, build] = goal.tasks;
    // Nothing to do while the first task runs.
    expect((await peterPass(deps(), companyId)).started).toEqual([]);
    // Finish it: it goes to review; no reviewer teammate, so the owner approves. Then the next starts.
    let run = await runOf(api, base, research.id);
    let claimed = await workerClaim(board, run.id);
    await workerComplete(board, claimed.token, run.id, {
      status: "completed",
      summary: "researched",
      usage: { inputTokens: 1000, outputTokens: 500 },
    });
    const review = (await api.get(`${base}/tasks/${research.id}/review`)).body;
    expect((await api.post(`${base}/reviews/${review.id}/approve`, {})).status).toBe(200);
    const pass = await peterPass(deps(), companyId);
    expect(pass.started.map((s) => s.taskId)).toEqual([requirements.id]);
    expect((await api.get(`${base}/tasks/${requirements.id}`)).body.status).toBe("doing");
    expect((await api.get(`${base}/tasks/${build.id}`)).body.status).toBe("todo");
    expect((await runOf(api, base, requirements.id)).note).toBe(
      "Started by Peter: everything this task waited on is done.",
    );
    // Finish the rest by hand and approve; the goal closes on the next pass with what it cost.
    for (const t of [requirements, build]) {
      run = await runOf(api, base, t.id);
      claimed = await workerClaim(board, run.id);
      await workerComplete(board, claimed.token, run.id, {
        status: "completed",
        summary: "ok",
        usage: { inputTokens: 1000, outputTokens: 500 },
      });
      const r = (await api.get(`${base}/tasks/${t.id}/review`)).body;
      await api.post(`${base}/reviews/${r.id}/approve`, {});
      await peterPass(deps(), companyId);
    }
    const g = (await api.get(`${base}/goals/${goal.id}`)).body;
    expect(g.status).toBe("done");
    expect(g.spend).toMatchObject({
      runs: 3,
      runTokens: 4500,
      planningTokens: 0,
      totalTokens: 4500,
      currency: "GBP",
    });
    expect(g.spend.costMinorUnits).toBe(Math.round(4500 * 0.001));
    const done = (await api.get(`${base}/events`)).body.find((e: any) => e.type === "goal.done");
    expect(done.payload.spend.totalTokens).toBe(4500);
    expect(done.payload.managerName).toBe("Peter");
  });

  it("restarts an author the review sent back when the restart could not happen at decision time", async () => {
    const { api, base, companyId } = await seedCompany(board, "l3@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const project = await addProject(api, base);
    const task = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "x",
        assignee: { kind: "teammate", id: cody.id },
        criteria: [{ text: "works", weight: 1 }],
      })
    ).body;
    const run = (await api.post(`${base}/tasks/${task.id}/runs`, {})).body;
    const claimed = await workerClaim(board, run.id);
    await workerComplete(board, claimed.token, run.id);
    const review = (await api.get(`${base}/tasks/${task.id}/review`)).body;
    // The engine is off when the owner requests changes: the author cannot restart.
    await board.db.query("UPDATE engines SET enabled = false WHERE id = 'claude_code'");
    const sent = await api.post(`${base}/reviews/${review.id}/request-changes`, { summary: "more" });
    expect(sent.status).toBe(200);
    expect((await api.get(`${base}/tasks/${task.id}`)).body.status).toBe("review");
    expect((await peterPass(deps(), companyId)).restarted).toEqual([]);
    await board.db.query("UPDATE engines SET enabled = true WHERE id = 'claude_code'");
    const pass = await peterPass(deps(), companyId);
    expect(pass.restarted.map((r) => r.taskId)).toEqual([task.id]);
    expect((await api.get(`${base}/tasks/${task.id}`)).body.status).toBe("doing");
    // The restarted author's run fails, and Peter has no re-plans left: the round is not restarted again.
    // (On a live board it was, after every failure, a run every few seconds.)
    const restartedRun = await runOf(api, base, task.id);
    const c0 = await workerClaim(board, restartedRun.id);
    await workerComplete(board, c0.token, restartedRun.id, { status: "failed", error: "boom" });
    await board.db.query("UPDATE tasks SET replans = $2 WHERE id = $1", [task.id, MAX_REPLANS]);
    const after0 = await peterPass(deps(), companyId);
    expect(after0.restarted).toEqual([]);
    expect((await api.get(`${base}/tasks/${task.id}`)).body.status).toBe("blocked");
    // A review that keeps going round escalates the goal it belongs to.
    const goal = (await api.post(`${base}/goals`, { text: "Round and round." })).body;
    const first = goal.tasks[0];
    const r1 = await runOf(api, base, first.id);
    const c1 = await workerClaim(board, r1.id);
    await workerComplete(board, c1.token, r1.id);
    const rv = (await api.get(`${base}/tasks/${first.id}/review`)).body;
    await board.db.query("UPDATE reviews SET round = $2 WHERE id = $1", [rv.id, MAX_REVIEW_ROUNDS]);
    // A person asking for another round is deciding: the author works on it and nothing escalates.
    const more = await api.post(`${base}/reviews/${rv.id}/request-changes`, { summary: "again" });
    expect(more.body.restarted.runId).toBeTruthy();
    expect((await peterPass(deps(), companyId)).escalated).toEqual([]);
    // With nobody on it (the run stopped), a review past the cap escalates the goal it belongs to.
    await api.post(`${base}/runs/${more.body.restarted.runId}/stop`, {});
    const esc = await peterPass(deps(), companyId);
    expect(esc.escalated.map((e) => e.goalId)).toEqual([goal.id]);
    expect(esc.resumed).toEqual([]);
    expect(esc.started).toEqual([]);
    expect((await api.get(`${base}/goals/${goal.id}`)).body.attention).toMatch(/gone 3 rounds/);
    // The person approves the work as it stands: the goal is active again.
    expect((await api.post(`${base}/reviews/${rv.id}/approve`, { summary: "Good enough." })).status).toBe(
      200,
    );
    const after = await peterPass(deps(), companyId);
    expect(after.resumed).toEqual([goal.id]);
    expect((await api.get(`${base}/goals/${goal.id}`)).body.status).not.toBe("needs_you");
  });

  it("rebalances Peter's queued tasks from an overloaded teammate to an idle one of the same role", async () => {
    const { api, base, companyId } = await seedCompany(board, "l4@example.com");
    const cody = await addTeammate(api, base, "Cody", "n8n engineer");
    const cody2 = await addTeammate(api, base, "Cody 2", "n8n engineer");
    const ricky = await addTeammate(api, base, "Ricky", "researcher");
    void ricky;
    // Four goals: the heuristic assigns by load, so Cody and Cody 2 alternate; pile Cody up by hand.
    const ids: string[] = [];
    for (let i = 0; i < 4; i++)
      ids.push((await api.post(`${base}/goals`, { text: `Goal ${i}.` })).body.tasks.at(-1).id);
    await board.db.query("UPDATE tasks SET assignee_id = $2 WHERE id = ANY($1::uuid[])", [ids, cody.id]);
    const pass = await peterPass(deps(), companyId);
    expect(pass.rebalanced).toHaveLength(1);
    expect(pass.rebalanced[0]).toMatchObject({ from: cody.id, to: cody2.id });
    const moved = (await api.get(`${base}/tasks/${pass.rebalanced[0]!.taskId}`)).body;
    expect(moved.assignee.id).toBe(cody2.id);
    const ev = (await api.get(`${base}/events`)).body.find((e: any) => e.type === "task.assigned");
    expect(ev.payload.reason).toBe("Cody has 4 open tasks");
  });

  it("wakes on the events it watches", async () => {
    const { api, base, companyId } = await seedCompany(board, "l5@example.com");
    await team(api, base);
    const loop = startPeterLoop(deps(), board.bus, 0, { warn: () => {} }, { debounceMs: 10 });
    try {
      // The loop hears goal.created too and may claim the planning before the request does: then the
      // request answers with the goal still in planning, and the tasks and the first run come from the
      // loop's pass a moment later.
      const created = (await api.post(`${base}/goals`, { text: "Wake up." })).body;
      let goal = created;
      let run: Awaited<ReturnType<typeof runOf>> | undefined;
      for (const until = Date.now() + 5000; !run && Date.now() < until;) {
        if (!goal.tasks.length) goal = (await api.get(`${base}/goals/${created.id}`)).body;
        if (goal.tasks.length) run = await runOf(api, base, goal.tasks[0].id);
        if (!run) await new Promise((r) => setTimeout(r, 50));
      }
      const claimed = await workerClaim(board, run!.id);
      await workerComplete(board, claimed.token, run!.id, { status: "failed", error: "boom" });
      // run.failed reaches the bus; the loop passes and re-plans without anyone calling it.
      const deadline = Date.now() + 5000;
      let status = "blocked";
      while (Date.now() < deadline && status !== "doing") {
        await new Promise((r) => setTimeout(r, 100));
        status = (await api.get(`${base}/tasks/${goal.tasks[0].id}`)).body.status;
      }
      expect(status).toBe("doing");
      expect((await api.get(`${base}/tasks/${goal.tasks[0].id}`)).body.replans).toBe(1);
    } finally {
      loop.stop();
    }
    void companyId;
  });

  it("chases through the loop and a pass on demand is a route for owners", async () => {
    const { api, base } = await seedCompany(board, "l6@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const ricky = await addTeammate(api, base, "Ricky", "researcher");
    const project = await addProject(api, base);
    const task = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "x",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    await api.post(`${base}/tasks/${task.id}/move`, {
      status: "blocked",
      blocker: {
        code: "waiting_on_teammate",
        what: "Need the names.",
        waitingOn: { kind: "teammate", id: ricky.id, name: ricky.handle },
      },
    });
    await board.db.query("UPDATE tasks SET updated_at = now() - interval '11 minutes' WHERE id = $1", [
      task.id,
    ]);
    const res = await api.post(`${base}/peter/pass`, {});
    expect(res.status).toBe(200);
    expect(res.body.chased).toBe(1);
    const viewer = board.api((await board.login("viewer-l6@example.com")).token);
    await api.post(`${base}/members`, { email: "viewer-l6@example.com", role: "viewer" });
    expect((await viewer.post(`${base}/peter/pass`, {})).status).toBe(403);
  });

  it("writes the re-plan note with the model, and escalates when the model says a person must act", async () => {
    const { api, base, companyId } = await seedCompany(modelBoard, "l7@example.com");
    await team(api, base);
    // Plan by heuristic (the fake answers 500 with nothing queued), then fail the run.
    const goal = (await api.post(`${base}/goals`, { text: "Digest with the model." })).body;
    // The note is written with the teammate's own model and names who reads it.
    const ricky = goal.tasks[0].assignee.id;
    await api.patch(`${base}/teammates/${ricky}`, { model: "claude-haiku-4-5-20251001" });
    const run = await runOf(api, base, goal.tasks[0].id);
    const claimed = await workerClaim(modelBoard, run.id);
    await workerComplete(modelBoard, claimed.token, run.id, {
      status: "failed",
      error: "tests ran too early",
    });
    anthropic.queue.push("replan.json");
    const pass = (await api.post(`${base}/peter/pass`, {})).body;
    expect(pass.replanned).toHaveLength(1);
    const req = anthropic.requests.at(-1)!;
    expect(req.body.model).toBe("claude-haiku-4-5-20251001");
    expect(req.body.messages[0]!.content).toContain(
      "Teammate: Ricky, researcher, working through claude_code",
    );
    expect(req.body.messages[0]!.content).toContain("Error: tests ran too early");
    expect(req.body.messages[0]!.content).toContain(`Task #${goal.tasks[0].number}`);
    const next = await runOf(api, base, goal.tasks[0].id);
    expect(next.note).toContain("Write gong-digest.workflow.json first");
    // Peter's re-plan tokens count as planning spend on the goal.
    expect((await api.get(`${base}/goals/${goal.id}`)).body.spend.planningTokens).toBe(640 + 90);
    // The model decides a person must act: no rerun, the goal needs you with the model's reason.
    // A model Peter's client cannot reach (a Codex teammate) means the note is written with Peter's.
    await api.patch(`${base}/teammates/${ricky}`, { model: "gpt-5" });
    const c2 = await workerClaim(modelBoard, next.id);
    await workerComplete(modelBoard, c2.token, next.id, { status: "failed", error: "401 from Gong" });
    anthropic.queue.push("replan-needs-person.json");
    const esc = (await api.post(`${base}/peter/pass`, {})).body;
    expect(anthropic.requests.at(-1)!.body.model).toBe("claude-opus-5");
    expect(esc.replanned).toEqual([]);
    expect(esc.escalated[0]!.reason).toMatch(/GONG_API_TOKEN/);
    expect((await api.get(`${base}/goals/${goal.id}`)).body.status).toBe("needs_you");
    void companyId;
  });
});
