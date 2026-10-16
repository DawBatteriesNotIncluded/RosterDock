// A task can be closed without being Done: an owner or admin cancels it, with a
// note, and it stops counting as open, takes no run and no move, and can be
// reopened. A run that ends on a cancelled task is recorded and leaves it
// cancelled, with no review. Done and In review belong to their reviews.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addProject,
  addTeammate,
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

async function setup(api: Api, base: string) {
  const cody = await addTeammate(api, base, "Cody");
  const project = await addProject(api, base);
  const task = async (title: string) =>
    (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title,
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
  return { cody, project, task };
}

const DIFF =
  "diff --git a/notes.md b/notes.md\nnew file mode 100644\n--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1 @@\n+# Notes\n";

describe("cancelling a task", () => {
  it("closes it without Done, for owners and admins only, and it can be reopened", async () => {
    const { api, base } = await seedCompany(board, "c1@example.com");
    const { cody, project, task } = await setup(api, base);
    const drop = await task("Drop me");
    await task("Keep me");

    // A reviewer and a teammate are refused.
    const rae = await board.login("c1-reviewer@example.com", "Rae");
    await api.post(`${base}/members`, { email: "c1-reviewer@example.com", role: "reviewer" });
    expect((await board.api(rae.token).post(`${base}/tasks/${drop.id}/cancel`, {})).status).toBe(403);
    const token = (await api.post(`${base}/teammates/${cody.id}/tokens`, {})).body.token;
    expect((await board.api(token).post(`${base}/tasks/${drop.id}/cancel`, {})).status).toBe(403);

    const cancelled = await api.post(`${base}/tasks/${drop.id}/cancel`, { note: "Superseded by goal 2." });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("cancelled");
    const moved = ((await api.get(`${base}/events`)).body as any[]).find(
      (e) => e.type === "task.moved" && e.payload.to === "cancelled",
    );
    expect(moved.payload).toMatchObject({
      number: drop.number,
      from: "todo",
      toLabel: "Cancelled",
      note: "Superseded by goal 2.",
    });

    // It no longer counts as open, for the project or the teammate.
    const counts = ((await api.get(`${base}/projects`)).body as any[]).find(
      (p) => p.id === project.id,
    ).counts;
    expect(counts).toMatchObject({ open: 1, done: 0 });

    // It takes no run and no move, and is not cancelled twice.
    const run = await api.post(`${base}/tasks/${drop.id}/runs`, {});
    expect(run.status).toBe(409);
    expect(run.body.error).toBe(`#${drop.number} is cancelled`);
    const move = await api.post(`${base}/tasks/${drop.id}/move`, { status: "doing" });
    expect(move.body.error).toBe(`#${drop.number} is cancelled: reopen it before moving it`);
    expect((await api.post(`${base}/tasks/${drop.id}/cancel`, {})).body.error).toBe(
      `#${drop.number} is already cancelled`,
    );

    // Reopened, it is To do again; reopening a task that is not cancelled is refused, and so is a teammate.
    expect((await board.api(token).post(`${base}/tasks/${drop.id}/reopen`, {})).status).toBe(403);
    expect((await api.post(`${base}/tasks/${drop.id}/reopen`, {})).body.status).toBe("todo");
    expect((await api.post(`${base}/tasks/${drop.id}/reopen`, {})).status).toBe(409);
  });

  it("stops its live run, whose end leaves the task cancelled and opens no review", async () => {
    const { api, base } = await seedCompany(board, "c2@example.com");
    await addTeammate(api, base, "Verifier", "reviewer");
    const { task } = await setup(api, base);
    const t = await task("Half done");
    const run = (await api.post(`${base}/tasks/${t.id}/runs`, {})).body;
    const claimed = await workerClaim(board, run.id);

    expect((await api.post(`${base}/tasks/${t.id}/cancel`, {})).body.status).toBe("cancelled");
    expect((await api.get(`${base}/runs/${run.id}`)).body).toMatchObject({
      status: "running",
      stopRequested: true,
    });
    // The worker finishes anyway, with a diff: recorded, and nothing reopens the task.
    await claimed.api.post(`/api/worker/runs/${run.id}/artifacts`, {
      path: "changes.diff",
      kind: "diff",
      content: DIFF,
    });
    await workerComplete(board, claimed.token, run.id, { status: "completed", summary: "Finished anyway." });
    expect((await api.get(`${base}/runs/${run.id}`)).body.status).toBe("completed");
    expect((await api.get(`${base}/tasks/${t.id}`)).body.status).toBe("cancelled");
    expect((await api.get(`${base}/tasks/${t.id}/review`)).status).toBe(404);
  });

  it("leaves In review and Done to their reviews", async () => {
    const { api, base } = await seedCompany(board, "c3@example.com");
    const { task } = await setup(api, base);
    const t = await task("Reviewed");
    const run = (await api.post(`${base}/tasks/${t.id}/runs`, {})).body;
    const claimed = await workerClaim(board, run.id);
    await claimed.api.post(`/api/worker/runs/${run.id}/artifacts`, {
      path: "changes.diff",
      kind: "diff",
      content: DIFF,
    });
    await workerComplete(board, claimed.token, run.id, { status: "completed", summary: "Notes." });
    expect((await api.get(`${base}/tasks/${t.id}`)).body.status).toBe("review");
    expect((await api.post(`${base}/tasks/${t.id}/cancel`, {})).body.error).toBe(
      `#${t.number} is in review: its reviewer decides it, so request changes before cancelling it`,
    );
    const review = (await api.get(`${base}/tasks/${t.id}/review`)).body;
    expect((await api.post(`${base}/reviews/${review.id}/approve`, {})).status).toBe(200);
    expect((await api.post(`${base}/tasks/${t.id}/cancel`, {})).body.error).toBe(`#${t.number} is done`);
  });
});
