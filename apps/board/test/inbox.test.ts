// Reviewer assignment from the board (not by role alone) and the per-teammate
// inbox: a projection of the events addressed to a teammate, with "new" meaning
// since their last run started, carried into their next run pack.
import { renderNewFileDiff } from "@rosterdock/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addProject, addTeammate, seedCompany, startTestBoard, type Api, type TestBoard } from "./helpers.js";

let board: TestBoard;

beforeAll(async () => {
  board = await startTestBoard();
});
afterAll(async () => {
  await board.destroy();
});

async function claim(runId: string, workerId = "worker-1") {
  const job = (
    await board.db.query<{ job_id: string | null }>("SELECT job_id FROM runs WHERE id = $1", [runId])
  ).rows[0]!.job_id;
  const res = await board.app.inject({
    method: "POST",
    url: "/api/worker/claim",
    headers: { "x-rosterdock-worker-token": "test-worker-token" },
    payload: { runId, jobId: job ?? "00000000-0000-4000-8000-000000000000", workerId },
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

async function liveRuns(api: Api, base: string) {
  return (await api.get(`${base}/runs?status=queued,running`)).body as {
    id: string;
    kind: string;
    teammateId: string;
    status: string;
  }[];
}

/** A task run by Cody, completed with a one-file diff, so a review opens. */
async function completeTaskRun(api: Api, base: string, taskId: string) {
  const run = (await api.post(`${base}/tasks/${taskId}/runs`, {})).body;
  const claimed = await claim(run.id);
  const asRun = board.api(claimed.body.token);
  await asRun.post(`/api/worker/runs/${run.id}/artifacts`, {
    path: "changes.diff",
    kind: "diff",
    content: renderNewFileDiff("notes.md", "# notes\n"),
  });
  const done = await asRun.post(`/api/worker/runs/${run.id}/complete`, {
    status: "completed",
    summary: "Wrote the notes.",
    usage: { inputTokens: 100, outputTokens: 10 },
    durationMs: 1000,
  });
  expect(done.status).toBe(200);
  return run.id as string;
}

describe("reviewer assignment", () => {
  it("a person hands the review to another teammate: the old review run stops, a new one starts, the event says so", async () => {
    const { api, base } = await seedCompany(board, "ra1@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const verifier = await addTeammate(api, base, "Verifier", "reviewer");
    const finn = await addTeammate(api, base, "Finn", "quality lead");
    const project = await addProject(api, base);
    const task = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "Write the notes",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    await completeTaskRun(api, base, task.id);
    const review = (await api.get(`${base}/tasks/${task.id}/review`)).body;
    expect(review.reviewer).toMatchObject({ kind: "teammate", id: verifier.id });
    const before = await liveRuns(api, base);
    expect(before.map((r) => [r.kind, r.teammateId])).toEqual([["review", verifier.id]]);

    const res = await api.post(`${base}/reviews/${review.id}/reviewer`, {
      reviewer: { kind: "teammate", id: finn.id },
    });
    expect(res.status).toBe(200);
    expect(res.body.reviewer).toEqual({ kind: "teammate", id: finn.id, name: "Finn" });
    expect(res.body.started).toMatchObject({ runId: expect.any(String) });
    const after = await liveRuns(api, base);
    expect(after.map((r) => [r.kind, r.teammateId])).toEqual([["review", finn.id]]);
    const old = (await api.get(`${base}/runs/${before[0]!.id}`)).body;
    expect(old.status).toBe("stopped");

    const events = (await api.get(`${base}/events`)).body as { type: string; payload: any }[];
    const ev = events.find((e) => e.type === "review.reassigned")!;
    expect(ev.payload).toMatchObject({
      number: task.number,
      reviewer: { kind: "teammate", id: finn.id, name: "Finn" },
      previous: { kind: "teammate", id: verifier.id, name: "Verifier" },
      byName: "Daniel",
    });

    // Finn's inbox says the review is theirs; the Verifier's no longer lists it as new work.
    const inbox = (await api.get(`${base}/teammates/${finn.id}/inbox`)).body;
    expect(inbox.items.map((i: any) => i.text)).toEqual([
      `Daniel made #${task.number} Write the notes yours to review.`,
    ]);
    expect(inbox.items[0].reviewId).toBe(review.id);
  });

  it("refuses the author, an unknown teammate, a viewer, and a decided review; a person may take it themselves", async () => {
    const { api, base, owner } = await seedCompany(board, "ra2@example.com");
    const cody = await addTeammate(api, base, "Cody");
    await addTeammate(api, base, "Verifier", "reviewer");
    const project = await addProject(api, base);
    const task = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "Write the notes",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    await completeTaskRun(api, base, task.id);
    const review = (await api.get(`${base}/tasks/${task.id}/review`)).body;
    const assign = (reviewer: unknown) => api.post(`${base}/reviews/${review.id}/reviewer`, { reviewer });

    expect((await assign({ kind: "teammate", id: cody.id })).status).toBe(422);
    expect((await assign({ kind: "teammate", id: "00000000-0000-4000-8000-000000000009" })).status).toBe(422);

    const viewer = await board.login("viewer-ra2@example.com", "Vera");
    await api.post(`${base}/members`, { email: "viewer-ra2@example.com", role: "viewer" });
    expect((await assign({ kind: "user", id: viewer.userId })).status).toBe(422);
    // A viewer may not assign either.
    const asViewer = board.api(viewer.token);
    expect(
      (
        await asViewer.post(`${base}/reviews/${review.id}/reviewer`, {
          reviewer: { kind: "user", id: owner.userId },
        })
      ).status,
    ).toBe(403);

    // The owner takes the review: the teammate's review run stops, nobody is started.
    const mine = await assign({ kind: "user", id: owner.userId });
    expect(mine.status).toBe(200);
    expect(mine.body.reviewer).toMatchObject({ kind: "user", id: owner.userId });
    expect(mine.body.started).toBeNull();
    expect(await liveRuns(api, base)).toEqual([]);

    // Cleared: people decide, as when no reviewer role exists.
    const cleared = await assign(null);
    expect(cleared.body.reviewer).toBeNull();

    await api.post(`${base}/reviews/${review.id}/approve`, {});
    expect((await assign({ kind: "user", id: owner.userId })).status).toBe(409);
  });
});

describe("the inbox", () => {
  it("lists what is addressed to a teammate, newest first, marks what is new since their last run, and puts it in the pack", async () => {
    const { api, base } = await seedCompany(board, "ib1@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const ricky = await addTeammate(api, base, "Ricky", "n8n engineer");
    const project = await addProject(api, base);
    const t1 = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "Map the workflow",
        assignee: { kind: "teammate", id: ricky.id },
      })
    ).body;
    const t2 = (await api.post(`${base}/tasks`, { projectId: project.id, title: "Second task" })).body;
    // A run for Ricky: everything before its start has been seen.
    const run = (await api.post(`${base}/tasks/${t1.id}/runs`, {})).body;
    const claimed = await claim(run.id);
    expect(claimed.status).toBe(201);
    expect(claimed.body.spec.inbox).toEqual([]);
    const asRun = board.api(claimed.body.token);
    await asRun.post(`/api/worker/runs/${run.id}/complete`, {
      status: "completed",
      summary: "Mapped it.",
      usage: { inputTokens: 10, outputTokens: 1 },
      durationMs: 10,
    });
    // Then: a mention by a person, a hand-off by a person; a message Ricky posts is not their own inbox.
    await api.post(`${base}/tasks/${t2.id}/messages`, { body: "@ricky can you take this one?" });
    await api.patch(`${base}/tasks/${t2.id}`, { assignee: { kind: "teammate", id: ricky.id } });
    const asCody = board.api(
      (await api.post(`${base}/teammates/${cody.id}/tokens`, { label: "test" })).body.token as string,
    );
    await asCody.post(`${base}/tasks/${t2.id}/messages`, { body: "@ricky the credential is by name." });

    const inbox = (await api.get(`${base}/teammates/${ricky.id}/inbox`)).body;
    expect(inbox.since).not.toBeNull();
    expect(inbox.items.map((i: any) => [i.type, i.unread])).toEqual([
      ["message.posted", true],
      ["task.assigned", true],
      ["message.posted", true],
      ["task.created", false],
    ]);
    expect(inbox.unread).toBe(3);
    expect(inbox.items[0].text).toBe(
      `Cody mentioned you on #${t2.number} Second task: "@ricky the credential is by name."`,
    );
    expect(inbox.items[1].text).toBe(`#${t2.number} Second task was assigned to you.`);
    expect(inbox.items[3].text).toBe(`#${t1.number} Map the workflow was assigned to you.`);
    expect(inbox.items[0].taskId).toBe(t2.id);
    // Cody's inbox is empty: nothing was addressed to Cody.
    expect((await api.get(`${base}/teammates/${cody.id}/inbox`)).body.items).toEqual([]);

    // Ricky's next run, on a third task, carries the unread items oldest first, minus that task's own
    // hand-off (the pack has it), and the pack says so.
    const t3 = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "Third task",
        assignee: { kind: "teammate", id: ricky.id },
      })
    ).body;
    const next = (await api.post(`${base}/tasks/${t3.id}/runs`, {})).body;
    const claimedNext = await claim(next.id, "worker-2");
    expect(claimedNext.body.spec.inbox.map((i: any) => i.text)).toEqual([
      `Daniel mentioned you on #${t2.number} Second task: "@ricky can you take this one?"`,
      `#${t2.number} Second task was assigned to you.`,
      `Cody mentioned you on #${t2.number} Second task: "@ricky the credential is by name."`,
    ]);
    expect(claimedNext.body.pack).toContain("## Your inbox");
    expect(claimedNext.body.pack).toContain("- 2026");
    expect(claimedNext.body.pack).toContain(": Daniel mentioned you on");
    // Once that run has started, nothing is new until something else arrives.
    expect((await api.get(`${base}/teammates/${ricky.id}/inbox`)).body.unread).toBe(0);
  });
});
