import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reaperPass } from "../src/runs/reaper.js";
import { addProject, addTeammate, seedCompany, startTestBoard, type Api, type TestBoard } from "./helpers.js";

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
  const project = await addProject(c.api, c.base);
  const task = (
    await c.api.post(`${c.base}/tasks`, {
      projectId: project.id,
      title: "Map VMS sub-workflow calls",
      assignee: { kind: "teammate", id: cody.id },
      declaredOutputs: ["vms-architecture.md"],
    })
  ).body;
  return { ...c, cody, project, task };
}

async function jobIdOf(runId: string): Promise<string> {
  const row = (
    await board.db.query<{ job_id: string | null }>("SELECT job_id FROM runs WHERE id = $1", [runId])
  ).rows[0];
  return row?.job_id ?? "00000000-0000-4000-8000-000000000000";
}

// A worker presents the pg-boss job id it was handed; the board checks it matches the run.
async function claim(runId: string, workerId = "worker-1", jobId?: string) {
  const res = await board.app.inject({
    method: "POST",
    url: "/api/worker/claim",
    headers: { "x-rosterdock-worker-token": "test-worker-token" },
    payload: { runId, jobId: jobId ?? (await jobIdOf(runId)), workerId },
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

async function dispatch(api: Api, base: string, taskId: string) {
  const res = await api.post(`${base}/tasks/${taskId}/runs`, {});
  return res;
}

describe("dispatch", () => {
  it("queues a run for a teammate-assigned task, moves it to In progress, and refuses a second live run", async () => {
    const { api, base, task, cody } = await setup("r1@example.com");
    const res = await dispatch(api, base, task.id);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("queued");
    expect(res.body.teammateId).toBe(cody.id);
    expect(res.body.engine).toBe("claude_code");
    const t = (await api.get(`${base}/tasks/${task.id}`)).body;
    expect(t.status).toBe("doing");
    expect(t.activeRunId).toBe(res.body.id);

    const again = await dispatch(api, base, task.id);
    expect(again.status).toBe(409);
    expect(again.body.details.blocker.code).toBe("lease_conflict");

    const types = (await api.get(`${base}/events`)).body.map((e: any) => e.type);
    expect(types).toContain("run.queued");
    expect(types).toContain("task.moved");
  });

  it("refuses unassigned tasks, human assignees, unresolved dependencies and disabled engines", async () => {
    const { api, base, project, cody, owner } = await setup("r2@example.com");
    const unassigned = (await api.post(`${base}/tasks`, { projectId: project.id, title: "x" })).body;
    expect((await dispatch(api, base, unassigned.id)).status).toBe(422);
    const human = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "y",
        assignee: { kind: "user", id: owner.userId },
      })
    ).body;
    expect((await dispatch(api, base, human.id)).status).toBe(422);
    const dep = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "z",
        assignee: { kind: "teammate", id: cody.id },
        dependsOn: [unassigned.id],
      })
    ).body;
    const blocked = await dispatch(api, base, dep.id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.details.blocker.code).toBe("dependencies_unresolved");

    const oc = await addTeammate(api, base, "Cody 3");
    await api.patch(`${base}/teammates/${oc.id}`, { engine: "opencode" });
    const ocTask = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "w",
        assignee: { kind: "teammate", id: oc.id },
      })
    ).body;
    const unavailable = await dispatch(api, base, ocTask.id);
    expect(unavailable.status).toBe(409);
    expect(unavailable.body.details.blocker.code).toBe("adapter_unavailable");
  });

  it("viewers cannot dispatch", async () => {
    const { api, base, task } = await setup("r3@example.com");
    await api.post(`${base}/members`, { email: "v3@example.com", role: "viewer" });
    const viewer = board.api((await board.login("v3@example.com")).token);
    expect((await dispatch(viewer, base, task.id)).status).toBe(403);
  });
});

describe("worker protocol", () => {
  it("claim needs the worker token and hands back a pack plus a run-scoped token", async () => {
    const { api, base, task } = await setup("r4@example.com");
    const run = (await dispatch(api, base, task.id)).body;

    const noToken = await board.app.inject({
      method: "POST",
      url: "/api/worker/claim",
      payload: { runId: run.id, jobId: await jobIdOf(run.id), workerId: "w" },
    });
    expect(noToken.statusCode).toBe(401);

    // A worker holding a different job id is refused.
    expect((await claim(run.id, "worker-x", "00000000-0000-4000-8000-00000000dead")).status).toBe(409);

    const claimed = await claim(run.id);
    expect(claimed.status).toBe(201);
    expect(claimed.body.run.status).toBe("running");
    expect(claimed.body.run.attempt).toBe(1);
    expect(claimed.body.pack).toContain("# Map VMS sub-workflow calls");
    expect(claimed.body.pack).toContain("You are Cody (@cody)");
    expect(claimed.body.pack).toContain("- vms-architecture.md");
    expect(claimed.body.spec.task.number).toBe(1);
    expect(typeof claimed.body.token).toBe("string");

    expect((await claim(run.id)).status).toBe(409);
  });

  it("the run token works only for its own run, and the full lifecycle lands the task in review", async () => {
    const { api, base, task, cody } = await setup("r5@example.com");
    const other = await setup("r5b@example.com");
    const run = (await dispatch(api, base, task.id)).body;
    const otherRun = (await dispatch(other.api, other.base, other.task.id)).body;
    const { body: claimed } = await claim(run.id);
    const asRun = board.api(claimed.token);

    // Scoped: the other run refuses this token.
    expect((await asRun.post(`/api/worker/runs/${otherRun.id}/heartbeat`, {})).status).toBe(403);
    // The token still acts as the teammate on the board (needed for the board MCP in M2).
    expect((await asRun.get("/api/auth/me")).body.actor).toEqual({ kind: "teammate", id: cody.id });

    const hb = await asRun.post(`/api/worker/runs/${run.id}/heartbeat`, {
      step: "reading the intake workflow",
      usage: { inputTokens: 1200 },
    });
    expect(hb.status).toBe(200);
    expect(hb.body.stopRequested).toBe(false);

    const ev = await asRun.post(`/api/worker/runs/${run.id}/events`, {
      events: [
        { type: "step", payload: { text: "listing nodes" } },
        { type: "tool", payload: { name: "Read", input: "workflows/intake.json" } },
      ],
    });
    expect(ev.status).toBe(200);
    expect(ev.body.lastSeq).toBe(3); // run.claimed was seq 1

    const art = await asRun.post(`/api/worker/runs/${run.id}/artifacts`, {
      path: "vms-architecture.md",
      kind: "document",
      content: "# VMS workflow architecture\n\nFive sub-workflows.",
    });
    expect(art.status).toBe(201);
    expect(art.body.bytes).toBeGreaterThan(10);
    expect(art.body.sha256).toHaveLength(64);

    expect(
      (
        await asRun.post(`/api/worker/runs/${run.id}/checkpoint`, {
          checkpoint: { filesWritten: ["vms-architecture.md"] },
        })
      ).status,
    ).toBe(200);

    const done = await asRun.post(`/api/worker/runs/${run.id}/complete`, {
      status: "completed",
      summary: "Mapped five sub-workflows; diagram and notes written.",
      usage: { inputTokens: 68_000, outputTokens: 775 },
      durationMs: 252_000,
    });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe("completed");
    expect(done.body.totalTokens).toBe(68_775);

    // The token died with the run.
    expect((await asRun.get("/api/auth/me")).status).toBe(401);

    const t = (await api.get(`${base}/tasks/${task.id}`)).body;
    expect(t.status).toBe("review");
    expect(t.activeRunId).toBeNull();

    const detail = (await api.get(`${base}/runs/${run.id}`)).body;
    expect(detail.events.map((e: any) => e.type)).toEqual([
      "run.claimed",
      "step",
      "tool",
      "artifact",
      "run.finished",
    ]);
    expect(detail.artifacts).toHaveLength(1);
    expect(detail.currentStep).toBeNull();
    const content = (await api.get(`${base}/runs/${run.id}/artifacts/${detail.artifacts[0].id}`)).body;
    expect(content.content).toContain("Five sub-workflows");

    const types = (await api.get(`${base}/events`)).body.map((e: any) => e.type);
    expect(types).toContain("run.started");
    expect(types).toContain("artifact.created");
    expect(types).toContain("run.completed");
    expect((await api.get(`${base}/tasks/${task.id}/runs`)).body).toHaveLength(1);
  });

  it("a failed run blocks the task with the worker's reason; a blocked run carries the teammate's blocker", async () => {
    const { api, base, task, project, cody } = await setup("r6@example.com");
    const run = (await dispatch(api, base, task.id)).body;
    const asRun = board.api((await claim(run.id)).body.token);
    await asRun.post(`/api/worker/runs/${run.id}/complete`, {
      status: "failed",
      error: "claude exited with code 1",
    });
    let t = (await api.get(`${base}/tasks/${task.id}`)).body;
    expect(t.status).toBe("blocked");
    expect(t.blocker.code).toBe("worker_reported");
    expect(t.blocker.what).toBe("claude exited with code 1");

    const t2 = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "Research",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    const run2 = (await dispatch(api, base, t2.id)).body;
    const asRun2 = board.api((await claim(run2.id)).body.token);
    await asRun2.post(`/api/worker/runs/${run2.id}/complete`, {
      status: "blocked",
      summary: "Need the comparison criteria.",
      blocker: {
        code: "waiting_on_teammate",
        what: "Waiting on @brody for the criteria.",
        waitingOn: { kind: "teammate", id: "brody", name: "brody" },
      },
    });
    t = (await api.get(`${base}/tasks/${t2.id}`)).body;
    expect(t.status).toBe("blocked");
    expect(t.blocker.code).toBe("waiting_on_teammate");
    expect(t.blocker.waitingOn.name).toBe("brody");
  });

  it("stop: a queued run stops at once; a running run is told at its next heartbeat", async () => {
    const { api, base, task, project, cody } = await setup("r7@example.com");
    const run = (await dispatch(api, base, task.id)).body;
    const stopped = await api.post(`${base}/runs/${run.id}/stop`, {});
    expect(stopped.body.status).toBe("stopped");
    expect((await api.get(`${base}/tasks/${task.id}`)).body.status).toBe("todo");

    const t2 = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "Second",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    const run2 = (await dispatch(api, base, t2.id)).body;
    const asRun2 = board.api((await claim(run2.id)).body.token);
    expect((await api.post(`${base}/runs/${run2.id}/stop`, {})).body.stopRequested).toBe(true);
    const hb = await asRun2.post(`/api/worker/runs/${run2.id}/heartbeat`, {});
    expect(hb.body.stopRequested).toBe(true);
    await asRun2.post(`/api/worker/runs/${run2.id}/complete`, {
      status: "stopped",
      summary: "Stopped on request.",
    });
    expect((await api.get(`${base}/tasks/${t2.id}`)).body.status).toBe("todo");
  });

  it("refuses secret-shaped strings in artifacts and events", async () => {
    const { api, base, task } = await setup("r8@example.com");
    const run = (await dispatch(api, base, task.id)).body;
    const asRun = board.api((await claim(run.id)).body.token);
    const res = await asRun.post(`/api/worker/runs/${run.id}/artifacts`, {
      path: "notes.md",
      content: "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
    });
    expect(res.status).toBe(422);
    const bad = await asRun.post(`/api/worker/runs/${run.id}/events`, {
      events: [{ type: "log", payload: { line: "sk-abcdefghijklmnopqrstuvwxyz0123456789" } }],
    });
    expect(bad.status).toBe(422);
  });
});

describe("claim takeover", () => {
  it("refuses a fresh running run with its status, but hands over one whose heartbeat is stale", async () => {
    const { api, base, task } = await setup("r12@example.com");
    const run = (await dispatch(api, base, task.id)).body;
    await claim(run.id, "worker-1");
    const refused = await claim(run.id, "worker-2");
    expect(refused.status).toBe(409);
    expect(refused.body.details.status).toBe("running");

    await board.db.query("UPDATE runs SET heartbeat_at = now() - interval '5 minutes' WHERE id = $1", [
      run.id,
    ]);
    const taken = await claim(run.id, "worker-2");
    expect(taken.status).toBe(201);
    expect(taken.body.run.attempt).toBe(2);
    expect(taken.body.run.workerId).toBe("worker-2");
    const types = (await api.get(`${base}/events?subjectKind=run&subjectId=${run.id}`)).body.map(
      (e: any) => e.type,
    );
    expect(types).toEqual(["run.queued", "run.started", "run.interrupted", "run.started"]);
  });
});

describe("reaper", () => {
  it("interrupts a run whose worker stopped heartbeating, lets a worker resume it as attempt 2 from the checkpoint", async () => {
    const { api, base, task } = await setup("r9@example.com");
    const run = (await dispatch(api, base, task.id)).body;
    const asRun = board.api((await claim(run.id)).body.token);
    await asRun.post(`/api/worker/runs/${run.id}/checkpoint`, { checkpoint: { step: 3 } });
    // Nothing is stale yet.
    let pass = await reaperPass(board.db, board.queue, { staleAfterMs: 60_000, orphanAfterMs: 30_000 });
    expect(pass.interrupted).toEqual([]);
    // Age the heartbeat.
    await board.db.query("UPDATE runs SET heartbeat_at = now() - interval '10 minutes' WHERE id = $1", [
      run.id,
    ]);
    pass = await reaperPass(board.db, board.queue, { staleAfterMs: 60_000, orphanAfterMs: 30_000 });
    expect(pass.interrupted).toEqual([run.id]);
    expect((await api.get(`${base}/runs/${run.id}`)).body.status).toBe("interrupted");
    // The old token is dead once a new worker claims.
    const resumed = await claim(run.id, "worker-2");
    expect(resumed.status).toBe(201);
    expect(resumed.body.run.attempt).toBe(2);
    expect(resumed.body.pack).toContain("## Previous attempt");
    expect(resumed.body.pack).toContain('"step": 3');
    expect((await asRun.post(`/api/worker/runs/${run.id}/heartbeat`, {})).status).toBe(401);
    const types = (await api.get(`${base}/events`)).body.map((e: any) => e.type);
    expect(types).toContain("run.interrupted");
    expect(types.filter((x: string) => x === "run.started")).toHaveLength(2);
  });

  it("fails a run whose job is gone for good and blocks the task with retries_exhausted", async () => {
    const { api, base, task } = await setup("r10@example.com");
    const run = (await dispatch(api, base, task.id)).body;
    await claim(run.id);
    await board.db.query("UPDATE runs SET heartbeat_at = now() - interval '10 minutes' WHERE id = $1", [
      run.id,
    ]);
    await reaperPass(board.db, board.queue, { staleAfterMs: 60_000, orphanAfterMs: 30_000 });
    // Simulate pg-boss giving up on the job.
    const row = (await board.db.query("SELECT job_id FROM runs WHERE id = $1", [run.id])).rows[0];
    await board.db.query(`UPDATE pgboss.job SET state = 'failed' WHERE id = $1`, [row.job_id]);
    const pass = await reaperPass(board.db, board.queue, { staleAfterMs: 60_000, orphanAfterMs: 30_000 });
    expect(pass.failed).toEqual([run.id]);
    const t = (await api.get(`${base}/tasks/${task.id}`)).body;
    expect(t.status).toBe("blocked");
    expect(t.blocker.code).toBe("retries_exhausted");
    expect(t.activeRunId).toBeNull();
  });

  it("re-enqueues a queued run that never got a job", async () => {
    const { api, base, task } = await setup("r11@example.com");
    const run = (await dispatch(api, base, task.id)).body;
    await board.db.query(
      "UPDATE runs SET job_id = NULL, queued_at = now() - interval '5 minutes' WHERE id = $1",
      [run.id],
    );
    const pass = await reaperPass(board.db, board.queue, { staleAfterMs: 60_000, orphanAfterMs: 30_000 });
    expect(pass.requeued).toEqual([run.id]);
    const row = (await board.db.query("SELECT job_id FROM runs WHERE id = $1", [run.id])).rows[0];
    expect(row.job_id).toBeTruthy();
    expect(await board.queue.jobState(row.job_id)).toBe("created");
  });
});
