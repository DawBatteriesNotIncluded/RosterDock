// Waits that only a person can end reach a person. A blocked note naming no
// teammate ("@manager", seen on a live board) waits on a person, and Peter
// turns the goal amber once; a wait on the manager, on Peter or on a teammate
// that is gone goes to a person once the chase window passes; a teammate that
// does not answer its chase goes to a person a window later. No model: the
// worker is played by hand.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { peterPass } from "../src/peter/loop.js";
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

beforeAll(async () => {
  board = await startTestBoard();
});
afterAll(async () => {
  await board.destroy();
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

const WINDOW = 10 * 60_000;

async function team(api: Api, base: string) {
  const ricky = await addTeammate(api, base, "Ricky", "researcher");
  const brody = await addTeammate(api, base, "Brody", "requirements");
  const cody = await addTeammate(api, base, "Cody", "n8n engineer");
  return { ricky, brody, cody };
}

async function blockedTask(api: Api, base: string, assigneeId: string, waitingOn: Record<string, unknown>) {
  const project = await addProject(api, base, `Waits ${Math.random().toString(36).slice(2, 8)}`);
  const task = (
    await api.post(`${base}/tasks`, {
      projectId: project.id,
      title: "Map the outbound mail",
      assignee: { kind: "teammate", id: assigneeId },
    })
  ).body;
  const moved = await api.post(`${base}/tasks/${task.id}/move`, {
    status: "blocked",
    blocker: { code: "waiting_on_teammate", what: "Need the credential names.", waitingOn },
  });
  expect(moved.status).toBe(200);
  return moved.body as { id: string; number: number; blocker: any };
}

/** As if the wait began a while ago (and Peter chased it then, when `chasedAgoMs` is given). */
async function age(taskId: string, blockedAgoMs: number, chasedAgoMs?: number) {
  await board.db.query(
    `UPDATE tasks SET updated_at = now() - ($2 || ' milliseconds')::interval,
       last_chased_at = CASE WHEN $3::text IS NULL THEN last_chased_at ELSE now() - ($3 || ' milliseconds')::interval END
     WHERE id = $1`,
    [taskId, String(blockedAgoMs), chasedAgoMs === undefined ? null : String(chasedAgoMs)],
  );
}

const events = async (api: Api, base: string, type: string) =>
  ((await api.get(`${base}/events?limit=200`)).body as any[]).filter((e) => e.type === type);

describe("waits that only a person can end", () => {
  it("a blocked note naming no teammate waits on a person, and the goal turns amber once", async () => {
    const { api, base, companyId } = await seedCompany(board, "wait1@example.com");
    const peter = await seatedPeter(api, base);
    await team(api, base);
    const goal = (await api.post(`${base}/goals`, { text: "A Friday digest of Gong calls in Slack." })).body;
    const research = goal.tasks[0];
    const run = ((await api.get(`${base}/tasks/${research.id}/runs`)).body as { id: string }[])[0]!;
    const claimed = await workerClaim(board, run.id);
    // What the worker reports for a blocked.md that says "@manager": the handle as the teammate's id.
    await workerComplete(board, claimed.token, run.id, {
      status: "blocked",
      summary: "Blocked: waiting on @manager to grant web fetch access.",
      blocker: {
        code: "waiting_on_teammate",
        what: "Blocked: waiting on @manager to grant web fetch access.",
        waitingOn: { kind: "teammate", id: "manager", name: "manager" },
      },
    });
    let task = (await api.get(`${base}/tasks/${research.id}`)).body;
    expect(task.status).toBe("blocked");
    expect(task.blocker.code).toBe("waiting_on_person");
    expect(task.blocker.waitingOn).toBeUndefined();
    expect(task.blocker.what).toBe("Blocked: waiting on @manager to grant web fetch access.");
    expect(task.blocker.why).toBe("@manager is not a teammate here, so a person has to answer.");

    // Peter tells a person at once: the goal turns amber with the task's ask.
    const pass = await peterPass(deps(), companyId);
    expect(pass.escalated).toHaveLength(1);
    expect(pass.escalated[0]!.goalId).toBe(goal.id);
    let g = (await api.get(`${base}/goals/${goal.id}`)).body;
    expect(g.status).toBe("needs_you");
    expect(g.attention).toBe(
      `#${research.number} ${research.title} is waiting on a person: Blocked: waiting on @manager to grant web fetch access. @manager is not a teammate here, so a person has to answer.`,
    );
    const escalated = await events(api, base, "goal.escalated");
    expect(escalated).toHaveLength(1);
    expect(escalated[0].actor).toEqual({ kind: "teammate", id: peter.id });

    // Once per wait, and the goal stays amber while the task waits.
    const again = await peterPass(deps(), companyId);
    expect(again.escalated).toEqual([]);
    expect(again.resumed).toEqual([]);
    expect(await events(api, base, "goal.escalated")).toHaveLength(1);
    expect((await api.get(`${base}/goals/${goal.id}`)).body.status).toBe("needs_you");

    // The person gives it what it asked for and unblocks it: the goal carries on and the task starts again.
    expect((await api.post(`${base}/tasks/${research.id}/move`, { status: "todo" })).status).toBe(200);
    const resumed = await peterPass(deps(), companyId);
    expect(resumed.resumed).toEqual([goal.id]);
    expect(resumed.started.map((s) => s.taskId)).toContain(research.id);
    g = (await api.get(`${base}/goals/${goal.id}`)).body;
    expect(g.status).toBe("active");
    task = (await api.get(`${base}/tasks/${research.id}`)).body;
    expect(task.status).toBe("doing");
  });

  it("a teammate named by handle is stored by id; a name that is no teammate waits on a person", async () => {
    const { api, base } = await seedCompany(board, "wait2@example.com");
    const { ricky, cody } = await team(api, base);
    const byHandle = await blockedTask(api, base, cody.id, {
      kind: "teammate",
      id: "@Ricky",
      name: "@Ricky",
    });
    expect(byHandle.blocker.code).toBe("waiting_on_teammate");
    expect(byHandle.blocker.waitingOn).toEqual({ kind: "teammate", id: ricky.id, name: "ricky" });
    const nobody = await blockedTask(api, base, cody.id, { kind: "teammate", id: "dana", name: "dana" });
    expect(nobody.blocker.code).toBe("waiting_on_person");
    expect(nobody.blocker.what).toBe("Need the credential names.");
    expect(nobody.blocker.why).toBe("@dana is not a teammate here, so a person has to answer.");
  });

  it("a wait on Peter or on a teammate who is gone goes to a person once the chase window passes", async () => {
    const { api, base, companyId } = await seedCompany(board, "wait3@example.com");
    const peter = await seatedPeter(api, base);
    const { cody } = await team(api, base);
    const onPeter = await blockedTask(api, base, cody.id, {
      kind: "teammate",
      id: peter.id,
      name: peter.handle,
    });
    // A wait stored before the board resolved names: a handle nobody has.
    const gone = await blockedTask(api, base, cody.id, { kind: "teammate", id: cody.id, name: cody.handle });
    await board.db.query(
      `UPDATE tasks SET blocker = jsonb_set(blocker, '{waitingOn}', '{"kind":"teammate","id":"manager","name":"manager"}') WHERE id = $1`,
      [gone.id],
    );

    // Within the window, Peter may still answer: nobody is told and nobody is chased.
    let pass = await peterPass(deps(), companyId, { chase: { blockedForMs: WINDOW } });
    expect(pass.escalated).toEqual([]);
    expect(pass.chased).toBe(0);

    await age(onPeter.id, WINDOW + 60_000);
    await age(gone.id, WINDOW + 60_000);
    pass = await peterPass(deps(), companyId, { chase: { blockedForMs: WINDOW } });
    expect(pass.chased).toBe(0);
    expect(pass.escalated.map((e) => e.reason).sort()).toEqual(
      [
        `#${gone.number} Map the outbound mail is waiting on a person: Need the credential names. @manager is not a teammate here, so a person has to answer.`,
        `#${onPeter.number} Map the outbound mail is waiting on a person: Need the credential names. @peter manages this work and nobody chases a manager, so a person has to answer.`,
      ].sort(),
    );
    const t1 = (await api.get(`${base}/tasks/${onPeter.id}`)).body;
    expect(t1.blocker.code).toBe("waiting_on_person");
    expect(t1.blocker.what).toBe("Need the credential names.");
    // Peter's late answer would still restart it.
    expect(t1.blocker.waitingOn).toEqual({ kind: "teammate", id: peter.id, name: "peter" });
    expect((await api.get(`${base}/tasks/${gone.id}`)).body.blocker.waitingOn).toBeUndefined();
    // Outside any goal, Peter says so on the task, once.
    const msgs = (await api.get(`${base}/tasks/${onPeter.id}/messages`)).body as any[];
    expect(msgs.at(-1).author.name).toBe("Peter");
    expect(msgs.at(-1).body).toMatch(/^Needs a person: #\d+ Map the outbound mail is waiting on a person/);
    const blocked = (await events(api, base, "task.blocked")).filter(
      (e) => e.subject.id === onPeter.id && e.payload.blocker.code === "waiting_on_person",
    );
    expect(blocked).toHaveLength(1);
    expect(blocked[0].actor).toEqual({ kind: "teammate", id: peter.id });
    pass = await peterPass(deps(), companyId, { chase: { blockedForMs: WINDOW } });
    expect(pass.escalated).toEqual([]);
    expect((await api.get(`${base}/tasks/${onPeter.id}/messages`)).body).toHaveLength(msgs.length);
  });

  it("a teammate that does not answer its chase goes to a person a window later, and is chased once", async () => {
    const { api, base, companyId } = await seedCompany(board, "wait4@example.com");
    const peter = await seatedPeter(api, base);
    const { ricky, cody } = await team(api, base);
    const task = await blockedTask(api, base, cody.id, {
      kind: "teammate",
      id: ricky.id,
      name: ricky.handle,
    });
    await age(task.id, WINDOW + 60_000);
    let pass = await peterPass(deps(), companyId, { chase: { blockedForMs: WINDOW } });
    expect(pass.chased).toBe(1);
    expect(pass.escalated).toEqual([]);
    expect((await api.get(`${base}/tasks/${task.id}`)).body.blocker.code).toBe("waiting_on_teammate");

    // Ricky's turn ended without an answer. Within the window after the chase, nothing more.
    pass = await peterPass(deps(), companyId, { chase: { blockedForMs: WINDOW } });
    expect(pass.chased).toBe(0);
    expect(pass.escalated).toEqual([]);

    // A window after the chase: a person is told, and Ricky is not chased again.
    await age(task.id, 2 * WINDOW + 120_000, WINDOW + 60_000);
    pass = await peterPass(deps(), companyId, { chase: { blockedForMs: WINDOW } });
    expect(pass.chased).toBe(0);
    expect(pass.escalated).toHaveLength(1);
    expect(pass.escalated[0]!.reason).toBe(
      `#${task.number} Map the outbound mail is waiting on a person: Need the credential names. @ricky has not answered in the 11 minutes since Peter chased, so a person has to step in.`,
    );
    const t = (await api.get(`${base}/tasks/${task.id}`)).body;
    expect(t.blocker.code).toBe("waiting_on_person");
    expect(t.blocker.waitingOn).toEqual({ kind: "teammate", id: ricky.id, name: "ricky" });
    expect((await events(api, base, "task.chased")).filter((e) => e.subject.id === task.id)).toHaveLength(1);
    void peter;
  });
});
