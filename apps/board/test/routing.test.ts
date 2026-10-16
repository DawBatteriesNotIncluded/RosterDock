// Mentions become turns, answers restart the waiting assignee, teammate-filed
// tasks start themselves, and Peter chases what stalls. All through the API
// and the worker protocol; no engine, no network.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chasePass } from "../src/runs/chase.js";
import { MAX_REPLY_DEPTH, RESTARTS_PER_TASK_PER_HOUR, TURNS_PER_TASK_PER_HOUR } from "../src/runs/routing.js";
import {
  addProject,
  addTeammate,
  seatedPeter,
  seedCompany,
  startTestBoard,
  type Api,
  type TestBoard,
} from "./helpers.js";

let board: TestBoard;

beforeAll(async () => {
  board = await startTestBoard();
});
afterAll(async () => {
  await board.destroy();
});

async function setup(email: string) {
  const c = await seedCompany(board, email);
  const cody = await addTeammate(c.api, c.base, "Cody");
  const ricky = await addTeammate(c.api, c.base, "Ricky", "researcher");
  const project = await addProject(c.api, c.base);
  const task = (
    await c.api.post(`${c.base}/tasks`, {
      projectId: project.id,
      title: "Map VMS sub-workflow calls",
      assignee: { kind: "teammate", id: cody.id },
    })
  ).body;
  return { ...c, cody, ricky, project, task };
}

async function jobIdOf(runId: string): Promise<string> {
  const row = (
    await board.db.query<{ job_id: string | null }>("SELECT job_id FROM runs WHERE id = $1", [runId])
  ).rows[0];
  return row?.job_id ?? "00000000-0000-4000-8000-000000000000";
}

/** Claim a run as a worker; returns an API bound to the run token. */
async function claim(runId: string): Promise<Api> {
  const res = await board.app.inject({
    method: "POST",
    url: "/api/worker/claim",
    headers: { "x-rosterdock-worker-token": "test-worker-token" },
    payload: { runId, jobId: await jobIdOf(runId), workerId: "w" },
  });
  if (res.statusCode !== 201) throw new Error(`claim failed: ${res.body}`);
  return board.api(JSON.parse(res.body).token);
}

async function complete(asRun: Api, runId: string, status = "completed") {
  const res = await asRun.post(`/api/worker/runs/${runId}/complete`, { status, summary: "done", usage: {} });
  if (res.status !== 200) throw new Error(`complete failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function liveRuns(base: string, api: Api, taskId: string) {
  const runs = (await api.get(`${base}/tasks/${taskId}/runs`)).body as any[];
  return runs.filter((r) => ["queued", "running", "interrupted"].includes(r.status));
}

describe("mentions", () => {
  it("a mention gives the named teammate a turn on the task without moving it", async () => {
    const { api, base, task, ricky } = await setup("m1@example.com");
    const posted = await api.post(`${base}/tasks/${task.id}/messages`, {
      body: "@ricky which credential names does the outbound-mail workflow use?",
    });
    expect(posted.status).toBe(201);
    expect(posted.body.routed.turns).toHaveLength(1);
    const runId = posted.body.routed.turns[0].runId as string;
    const run = (await api.get(`${base}/runs/${runId}`)).body;
    expect(run.kind).toBe("turn");
    expect(run.teammateId).toBe(ricky.id);
    expect(run.triggerMessageId).toBe(posted.body.id);
    // The task still belongs to Cody and has not moved.
    const t = (await api.get(`${base}/tasks/${task.id}`)).body;
    expect(t.status).toBe("todo");
    expect(t.activeRunId).toBeNull();

    // The pack tells Ricky it is a turn and quotes the ask.
    const res = await board.app.inject({
      method: "POST",
      url: "/api/worker/claim",
      headers: { "x-rosterdock-worker-token": "test-worker-token" },
      payload: { runId, jobId: await jobIdOf(runId), workerId: "w" },
    });
    const claimed = JSON.parse(res.body);
    expect(claimed.pack).toContain("## Your turn");
    expect(claimed.pack).toContain("Daniel mentioned you on this task, which Cody is working on");
    expect(claimed.pack).toContain("> @ricky which credential names");
    expect(claimed.spec.turn.askedBy).toBe("Daniel");

    // Finishing the turn leaves the task where it was.
    await complete(board.api(claimed.token), runId);
    expect((await api.get(`${base}/tasks/${task.id}`)).body.status).toBe("todo");
    const events = (await api.get(`${base}/events`)).body as any[];
    const queued = events.find((e) => e.type === "run.queued" && e.payload.kind === "turn");
    expect(queued.payload.teammateName).toBe("Ricky");
    expect(events.some((e) => e.type === "task.moved" && e.payload.to === "review")).toBe(false);
  });

  it("a turn runs alongside the assignee's task run, and a live teammate is not woken twice", async () => {
    const { api, base, task, ricky, cody } = await setup("m2@example.com");
    const run = (await api.post(`${base}/tasks/${task.id}/runs`, {})).body;
    expect(run.status).toBe("queued");
    const first = await api.post(`${base}/tasks/${task.id}/messages`, { body: "@ricky a question" });
    expect(first.body.routed.turns).toHaveLength(1);
    const second = await api.post(`${base}/tasks/${task.id}/messages`, { body: "@ricky and another" });
    expect(second.body.routed.turns).toHaveLength(0);
    expect(second.body.routed.skipped[0].reason).toMatch(/already live/);
    // Mentioning the assignee while their run is live does not start a second run for them.
    const third = await api.post(`${base}/tasks/${task.id}/messages`, { body: "@cody status?" });
    expect(third.body.routed.turns).toHaveLength(0);
    const live = await liveRuns(base, api, task.id);
    expect(live.map((r) => [r.teammateId, r.kind]).sort()).toEqual(
      [
        [cody.id, "task"],
        [ricky.id, "turn"],
      ].sort(),
    );
  });

  it("a teammate mentioning itself routes nowhere", async () => {
    const { api, base, task, cody } = await setup("m3@example.com");
    const run = (await api.post(`${base}/tasks/${task.id}/runs`, {})).body;
    const asRun = await claim(run.id);
    const posted = await asRun.post(`${base}/tasks/${task.id}/messages`, { body: "@cody note to self" });
    expect(posted.status).toBe(201);
    expect(posted.body.mentions).toEqual([]);
    expect(posted.body.routed.turns).toEqual([]);
    expect((await liveRuns(base, api, task.id)).map((r) => r.teammateId)).toEqual([cody.id]);
  });

  it("reply chains stop after a bounded depth", async () => {
    const { api, base, task, ricky } = await setup("m4@example.com");
    const archy = await addTeammate(api, base, "Archy", "architect");
    // Cody's task run asks Ricky; Ricky and Archy then bounce the question between them.
    const codyRun = (await api.post(`${base}/tasks/${task.id}/runs`, {})).body;
    const asCody = await claim(codyRun.id);
    let posted = await asCody.post(`${base}/tasks/${task.id}/messages`, { body: "@ricky q1" });
    expect(posted.body.routed.turns).toHaveLength(1);
    await complete(asCody, codyRun.id);
    expect((await api.get(`${base}/tasks/${task.id}`)).body.status).toBe("review");

    let depth = 0;
    let turnRunId = posted.body.routed.turns[0].runId as string;
    let listener = archy;
    // Ricky asks Archy (depth 1) → Archy answers Ricky (depth 2) → Ricky follows up (depth 3) → stop.
    for (;;) {
      const asTurn = await claim(turnRunId);
      posted = await asTurn.post(`${base}/tasks/${task.id}/messages`, {
        body: `@${listener.handle} reply ${depth + 1}`,
      });
      await complete(asTurn, turnRunId);
      depth += 1;
      if (posted.body.routed.turns.length === 0) break;
      expect(depth).toBeLessThan(MAX_REPLY_DEPTH);
      turnRunId = posted.body.routed.turns[0].runId;
      listener = listener === archy ? ricky : archy;
    }
    expect(depth).toBe(MAX_REPLY_DEPTH);
    expect(posted.body.routed.skipped[0].reason).toMatch(/reply chain/);
    // Turns never moved the task.
    expect((await api.get(`${base}/tasks/${task.id}`)).body.status).toBe("review");
    // A person can restart the chain.
    const human = await api.post(`${base}/tasks/${task.id}/messages`, { body: "@ricky one more from me" });
    expect(human.body.routed.turns).toHaveLength(1);
  });

  it("caps turns per task per hour", async () => {
    const { api, base, task, project } = await setup("m5@example.com");
    const mates = [] as { handle: string }[];
    for (let i = 0; i < TURNS_PER_TASK_PER_HOUR + 1; i++)
      mates.push(await addTeammate(api, base, `Mate ${i}`));
    void project;
    for (let i = 0; i < TURNS_PER_TASK_PER_HOUR; i++) {
      const r = await api.post(`${base}/tasks/${task.id}/messages`, { body: `@${mates[i]!.handle} hi` });
      expect(r.body.routed.turns).toHaveLength(1);
    }
    const over = await api.post(`${base}/tasks/${task.id}/messages`, {
      body: `@${mates[TURNS_PER_TASK_PER_HOUR]!.handle} hi`,
    });
    expect(over.body.routed.turns).toHaveLength(0);
    expect(over.body.routed.skipped[0].reason).toMatch(/turns this hour/);
  });
});

describe("waiting on a teammate", () => {
  it("the answer from the waited-on teammate restarts the assignee", async () => {
    const { api, base, task, cody, ricky } = await setup("w1@example.com");
    const codyRun = (await api.post(`${base}/tasks/${task.id}/runs`, {})).body;
    const asCody = await claim(codyRun.id);
    // Cody asks and declares the wait; then his run ends blocked.
    const ask = await asCody.post(`${base}/tasks/${task.id}/messages`, {
      body: "@ricky which credential names?",
    });
    const turnId = ask.body.routed.turns[0].runId as string;
    await asCody.post(`${base}/tasks/${task.id}/move`, {
      status: "blocked",
      blocker: {
        code: "waiting_on_teammate",
        what: "Need the credential names.",
        waitingOn: { kind: "teammate", id: ricky.id, name: ricky.handle },
      },
    });
    await complete(asCody, codyRun.id, "blocked");
    expect((await api.get(`${base}/tasks/${task.id}`)).body.status).toBe("blocked");

    // Ricky's turn answers: the task is unblocked and Cody gets a fresh run with the answer in the conversation.
    const asRicky = await claim(turnId);
    const answer = await asRicky.post(`${base}/tasks/${task.id}/messages`, {
      body: "@cody GMAIL_OAUTH and SMTP_RELAY, by name.",
    });
    expect(answer.body.routed.restartedRunId).toBeTruthy();
    expect(answer.body.routed.turns).toHaveLength(0);
    expect(answer.body.routed.skipped[0].reason).toMatch(/restarted/);
    await complete(asRicky, turnId);
    const t = (await api.get(`${base}/tasks/${task.id}`)).body;
    expect(t.status).toBe("doing");
    expect(t.activeRunId).toBe(answer.body.routed.restartedRunId);
    const restarted = (await api.get(`${base}/runs/${answer.body.routed.restartedRunId}`)).body;
    expect(restarted.kind).toBe("task");
    expect(restarted.teammateId).toBe(cody.id);
    expect(restarted.createdBy).toEqual({ kind: "teammate", id: ricky.id });
    const res = await board.app.inject({
      method: "POST",
      url: "/api/worker/claim",
      headers: { "x-rosterdock-worker-token": "test-worker-token" },
      payload: { runId: restarted.id, jobId: await jobIdOf(restarted.id), workerId: "w" },
    });
    const pack = JSON.parse(res.body).pack as string;
    expect(pack).toContain("GMAIL_OAUTH and SMTP_RELAY");
    expect(pack).toContain("@ricky answered on the task");
  });

  it("two teammates without an answer cannot restart each other forever", async () => {
    const { api, base, task, ricky } = await setup("w3@example.com");
    const block = {
      code: "waiting_on_teammate",
      what: "Need the names.",
      waitingOn: { kind: "teammate", id: ricky.id, name: ricky.handle },
    };
    let codyRunId = (await api.post(`${base}/tasks/${task.id}/runs`, {})).body.id as string;
    for (let round = 0; round <= RESTARTS_PER_TASK_PER_HOUR; round++) {
      const asCody = await claim(codyRunId);
      const ask = await asCody.post(`${base}/tasks/${task.id}/messages`, { body: "@ricky which names?" });
      expect(ask.body.routed.turns).toHaveLength(1);
      await asCody.post(`${base}/tasks/${task.id}/move`, { status: "blocked", blocker: block });
      await complete(asCody, codyRunId, "blocked");
      const asRicky = await claim(ask.body.routed.turns[0].runId);
      const answer = await asRicky.post(`${base}/tasks/${task.id}/messages`, {
        body: "@cody no idea either",
      });
      await complete(asRicky, ask.body.routed.turns[0].runId);
      if (round < RESTARTS_PER_TASK_PER_HOUR) {
        expect(answer.body.routed.restartedRunId).toBeTruthy();
        codyRunId = answer.body.routed.restartedRunId;
      } else {
        expect(answer.body.routed.restartedRunId).toBeNull();
        expect(answer.body.routed.skipped[0].reason).toMatch(/stays blocked until a person/);
      }
    }
    const t = (await api.get(`${base}/tasks/${task.id}`)).body;
    expect(t.status).toBe("blocked");
    expect(t.blocker.waitingOn.id).toBe(ricky.id);
    expect(await liveRuns(base, api, task.id)).toEqual([]);
  });

  it("Peter chases a task that has waited on a teammate too long, once", async () => {
    const { api, base, task, ricky, cody } = await setup("w2@example.com");
    const peter = await seatedPeter(api, base);
    expect(peter.handle).toBe("peter");
    await api.post(`${base}/tasks/${task.id}/move`, {
      status: "blocked",
      blocker: {
        code: "waiting_on_teammate",
        what: "Need the credential names.",
        waitingOn: { kind: "teammate", id: ricky.id, name: ricky.handle },
      },
    });
    // Not stale yet: nothing happens.
    expect((await chasePass(board.db, board.queue, { blockedForMs: 60_000 })).chased).toEqual([]);
    await board.db.query("UPDATE tasks SET updated_at = now() - interval '11 minutes' WHERE id = $1", [
      task.id,
    ]);
    const first = await chasePass(board.db, board.queue, { blockedForMs: 10 * 60_000 });
    expect(first.chased).toHaveLength(1);
    expect(first.chased[0]!.teammateId).toBe(ricky.id);
    expect(first.chased[0]!.runId).toBeTruthy();
    const msgs = (await api.get(`${base}/tasks/${task.id}/messages`)).body as any[];
    expect(msgs.at(-1).author.name).toBe("Peter");
    expect(msgs.at(-1).body).toContain(
      `@ricky #${task.number} is waiting on you: Need the credential names.`,
    );
    expect((await api.get(`${base}/events`)).body.some((e: any) => e.type === "task.chased")).toBe(true);
    // Not again within the repeat window.
    expect((await chasePass(board.db, board.queue, { blockedForMs: 10 * 60_000 })).chased).toEqual([]);
    void cody;
  });
});

describe("teammate-filed tasks", () => {
  it("start on their own when assigned to a teammate", async () => {
    const { api, base, task, ricky, project } = await setup("t1@example.com");
    const run = (await api.post(`${base}/tasks/${task.id}/runs`, {})).body;
    const asCody = await claim(run.id);
    const filed = await asCody.post(`${base}/tasks`, {
      projectId: project.id,
      title: "Audit outbound-mail credentials",
      assignee: { kind: "teammate", id: ricky.id },
    });
    expect(filed.status).toBe(201);
    // The REST route does not auto-start (a person may be drafting); the board tool does. Simulate the tool path.
    const { autoDispatchCreated } = await import("../src/runs/routing.js");
    const { loadTask } = await import("../src/tasks/service.js");
    const row = await loadTask(board.db, filed.body.companyId, filed.body.id);
    const started = await autoDispatchCreated(board.db, board.queue, row, run.teammateId);
    expect(started).toBeTruthy();
    const t = (await api.get(`${base}/tasks/${filed.body.id}`)).body;
    expect(t.status).toBe("doing");
    expect(t.activeRunId).toBe(started);
    // A task that waits on another does not start.
    const dependent = await asCody.post(`${base}/tasks`, {
      projectId: project.id,
      title: "Write the mail runbook",
      assignee: { kind: "teammate", id: ricky.id },
      dependsOn: [filed.body.id],
    });
    const depRow = await loadTask(board.db, dependent.body.companyId, dependent.body.id);
    expect(await autoDispatchCreated(board.db, board.queue, depRow, run.teammateId)).toBeNull();
    expect((await api.get(`${base}/tasks/${dependent.body.id}`)).body.status).toBe("todo");
  });
});
