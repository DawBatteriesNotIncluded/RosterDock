// Worker pools per department: a department's sandbox names a pool, its runs
// go on the pool's queue, and the reaper and a stop find the job there.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reaperPass } from "../src/runs/reaper.js";
import { addProject, addTeammate, seedCompany, startTestBoard, type TestBoard } from "./helpers.js";

let board: TestBoard;
beforeAll(async () => {
  board = await startTestBoard();
});
afterAll(async () => {
  await board.destroy();
});

describe("worker pools", () => {
  it("routes a department's runs to its pool's queue, and everything else to the default one", async () => {
    const { api, base } = await seedCompany(board, "wp1@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const project = await addProject(api, base);
    const secure = await api.post(`${base}/departments`, {
      name: "Secure engineering",
      writePolicy: "drafts",
      memberTeammateIds: [cody.id],
      sandbox: { pool: "secure", timeoutSeconds: 900 },
    });
    expect(secure.status).toBe(201);
    expect(secure.body.sandbox).toEqual({ pool: "secure", timeoutSeconds: 900 });
    // Not a slug: refused at the boundary.
    expect(
      (await api.patch(`${base}/departments/${secure.body.id}`, { sandbox: { pool: "Not A Pool" } })).status,
    ).toBe(400);

    const inPool = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "in the pool",
        departmentId: secure.body.id,
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    const outside = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "anywhere",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    const r1 = (await api.post(`${base}/tasks/${inPool.id}/runs`, {})).body;
    const r2 = (await api.post(`${base}/tasks/${outside.id}/runs`, {})).body;
    const rows = (
      await board.db.query<{ id: string; queue_name: string; job_id: string }>(
        "SELECT id, queue_name, job_id FROM runs WHERE id = ANY($1::uuid[])",
        [[r1.id, r2.id]],
      )
    ).rows;
    const pooled = rows.find((r) => r.id === r1.id)!;
    const plain = rows.find((r) => r.id === r2.id)!;
    expect(pooled.queue_name).toBe("runs.secure");
    expect(plain.queue_name).toBe("runs");
    // The jobs sit on those queues, with the runs settings, and nowhere else.
    expect((await board.queue.boss.getJobById("runs.secure", pooled.job_id))?.state).toBe("created");
    expect(await board.queue.boss.getJobById("runs", pooled.job_id)).toBeNull();
    expect((await board.queue.boss.getJobById("runs", plain.job_id))?.state).toBe("created");
    expect(await board.queue.jobState(pooled.job_id, "runs.secure")).toBe("created");
    const queue = await board.queue.boss.getQueue("runs.secure");
    expect(queue?.retryLimit).toBe(5);

    // The reaper leaves a healthy pooled job alone.
    const swept = await reaperPass(board.db, board.queue, { staleAfterMs: 90_000, orphanAfterMs: 30_000 });
    expect(swept.failed).not.toContain(r1.id);
    expect(swept.requeued).not.toContain(r1.id);
    expect((await api.get(`${base}/runs/${r1.id}`)).body.status).toBe("queued");

    // A stop cancels the job on the pool's queue.
    expect((await api.post(`${base}/runs/${r1.id}/stop`, {})).status).toBe(200);
    expect((await board.queue.boss.getJobById("runs.secure", pooled.job_id))?.state).toBe("cancelled");
    expect((await api.get(`${base}/runs/${r1.id}`)).body.status).toBe("stopped");
  });
});
