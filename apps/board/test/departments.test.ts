import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addProject,
  addTeammate,
  seatedPeter,
  seedCompany,
  startTestBoard,
  type TestBoard,
} from "./helpers.js";

let board: TestBoard;

beforeAll(async () => {
  board = await startTestBoard();
});
afterAll(async () => {
  await board.destroy();
});

describe("departments", () => {
  it("creates a department with a lead and members, from teammates in the company only", async () => {
    const { api, base } = await seedCompany(board, "d1@example.com");
    const peter = await seatedPeter(api, base);
    const cody = await addTeammate(api, base, "Cody");
    const res = await api.post(`${base}/departments`, {
      name: "Engineering",
      writePolicy: "drafts",
      leadTeammateId: peter.id,
      memberTeammateIds: [cody.id],
    });
    expect(res.status).toBe(201);
    expect(res.body.slug).toBe("engineering");
    expect(res.body.leadTeammateId).toBe(peter.id);
    expect(res.body.members.map((m: any) => [m.name, m.isLead])).toEqual([
      ["Peter", true],
      ["Cody", false],
    ]);

    const other = await seedCompany(board, "d1b@example.com");
    const foreign = await addTeammate(other.api, other.base, "Ricky");
    const bad = await api.post(`${base}/departments`, { name: "Research", leadTeammateId: foreign.id });
    expect(bad.status).toBe(422);
  });

  it("cycles a matrix cell: none, member, lead, and demotes the previous lead", async () => {
    const { api, base } = await seedCompany(board, "d2@example.com");
    const peter = await seatedPeter(api, base);
    const cody = await addTeammate(api, base, "Cody");
    const dept = (await api.post(`${base}/departments`, { name: "Engineering", leadTeammateId: peter.id }))
      .body;
    const url = `${base}/departments/${dept.id}/members/${cody.id}`;

    let res = await api.put(url, { isLead: false });
    expect(res.status).toBe(200);
    expect(res.body.members.find((m: any) => m.teammateId === cody.id).isLead).toBe(false);

    res = await api.put(url, { isLead: true });
    expect(res.body.leadTeammateId).toBe(cody.id);
    expect(res.body.members.find((m: any) => m.teammateId === peter.id).isLead).toBe(false);

    res = await api.del(url);
    expect(res.status).toBe(200);
    expect(res.body.leadTeammateId).toBeNull();
    expect(res.body.members.map((m: any) => m.teammateId)).toEqual([peter.id]);

    const events = (await api.get(`${base}/events`)).body.map((e: any) => e.type);
    expect(events).toContain("department.member_added");
    expect(events).toContain("department.lead_changed");
    expect(events).toContain("department.member_removed");
  });

  it("refuses to dissolve a department with open tasks", async () => {
    const { api, base } = await seedCompany(board, "d3@example.com");
    const dept = (await api.post(`${base}/departments`, { name: "Finance" })).body;
    const project = await addProject(api, base, "Q3 close");
    const task = await api.post(`${base}/tasks`, {
      projectId: project.id,
      title: "Reconcile",
      departmentId: dept.id,
    });
    expect(task.status).toBe(201);
    const refused = await api.del(`${base}/departments/${dept.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/1 open task/);
  });

  it("carries a sandbox preset that reaches the run pack", async () => {
    const { api, base } = await seedCompany(board, "d5@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const created = await api.post(`${base}/departments`, {
      name: "Engineering",
      sandbox: {
        allowedTools: ["Read(./**)", "Write(./**)"],
        envNames: ["N8N_API_KEY"],
        timeoutSeconds: 900,
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.sandbox).toEqual({
      allowedTools: ["Read(./**)", "Write(./**)"],
      envNames: ["N8N_API_KEY"],
      timeoutSeconds: 900,
    });
    const patched = await api.patch(`${base}/departments/${created.body.id}`, {
      sandbox: { timeoutSeconds: 600 },
    });
    expect(patched.body.sandbox).toEqual({ timeoutSeconds: 600 });
    expect(
      (await api.patch(`${base}/departments/${created.body.id}`, { sandbox: { envNames: ["not a name"] } }))
        .status,
    ).toBe(400);

    const project = await addProject(api, base, "Sandboxed");
    const task = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "In the sandbox",
        departmentId: created.body.id,
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    const run = (await api.post(`${base}/tasks/${task.id}/runs`, {})).body;
    const job = (await board.db.query<{ job_id: string }>("SELECT job_id FROM runs WHERE id = $1", [run.id]))
      .rows[0]!.job_id;
    const claimed = await board.app.inject({
      method: "POST",
      url: "/api/worker/claim",
      headers: { "x-rosterdock-worker-token": "test-worker-token" },
      payload: { runId: run.id, jobId: job, workerId: "w" },
    });
    const body = JSON.parse(claimed.body);
    expect(body.spec.sandbox).toEqual({ allowedTools: null, envNames: null, timeoutSeconds: 600 });
    expect(body.pack).toContain("Time limit: 10 minutes.");
  });

  it("slugs are unique per company", async () => {
    const { api, base } = await seedCompany(board, "d4@example.com");
    expect((await api.post(`${base}/departments`, { name: "Marketing Ops" })).status).toBe(201);
    expect((await api.post(`${base}/departments`, { name: "marketing ops" })).status).toBe(409);
  });
});
