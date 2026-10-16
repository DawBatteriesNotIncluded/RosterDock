import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addProject, addTeammate, seedCompany, startTestBoard, type TestBoard } from "./helpers.js";

let board: TestBoard;

beforeAll(async () => {
  board = await startTestBoard();
});
afterAll(async () => {
  await board.destroy();
});

describe("tasks", () => {
  it("numbers tasks per company and records who created and who is assigned", async () => {
    const { api, base } = await seedCompany(board, "t1@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const project = await addProject(api, base);
    const a = await api.post(`${base}/tasks`, {
      projectId: project.id,
      title: "Map VMS sub-workflow calls",
      assignee: { kind: "teammate", id: cody.id },
    });
    const b = await api.post(`${base}/tasks`, { projectId: project.id, title: "Inventory nodes" });
    expect(a.status).toBe(201);
    expect([a.body.number, b.body.number]).toEqual([1, 2]);
    expect(a.body.assignee).toEqual({ kind: "teammate", id: cody.id });
    expect(a.body.createdBy.kind).toBe("user");

    const other = await seedCompany(board, "t1b@example.com");
    const otherProject = await addProject(other.api, other.base);
    const c = await other.api.post(`${other.base}/tasks`, {
      projectId: otherProject.id,
      title: "First in other company",
    });
    expect(c.body.number).toBe(1);

    // A project from another company is refused.
    expect((await api.post(`${base}/tasks`, { projectId: otherProject.id, title: "x" })).status).toBe(422);
  });

  it("a teammate creates a task carrying its own identity, and can assign it to another teammate", async () => {
    const { api, base } = await seedCompany(board, "t2@example.com");
    const ricky = await addTeammate(api, base, "Ricky", "researcher");
    const cody = await addTeammate(api, base, "Cody");
    const project = await addProject(api, base);
    const token = (await api.post(`${base}/teammates/${ricky.id}/tokens`, {})).body.token;
    const asRicky = board.api(token);
    const res = await asRicky.post(`${base}/tasks`, {
      projectId: project.id,
      title: "Cross-check credential names against outbound-mail map",
      assignee: { kind: "teammate", id: cody.id },
    });
    expect(res.status).toBe(201);
    expect(res.body.createdBy).toEqual({ kind: "teammate", id: ricky.id });
    const ev = (await api.get(`${base}/events`)).body.find((e: any) => e.type === "task.created");
    expect(ev.actor).toEqual({ kind: "teammate", id: ricky.id });
    expect(ev.payload.createdByName).toBe("Ricky");
    expect(ev.payload.assignee.name).toBe("Cody");
  });

  it("moves between columns, never to Done, and blocked carries a structured reason", async () => {
    const { api, base } = await seedCompany(board, "t3@example.com");
    const project = await addProject(api, base);
    const task = (await api.post(`${base}/tasks`, { projectId: project.id, title: "Build digest" })).body;
    const url = `${base}/tasks/${task.id}/move`;

    let res = await api.post(url, { status: "doing" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("doing");

    res = await api.post(url, { status: "done" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/approved review/);

    res = await api.post(url, {
      status: "blocked",
      blocker: { code: "waiting_on_teammate", what: "Waiting on @brody for the criteria." },
    });
    expect(res.status).toBe(200);
    expect(res.body.blocker.code).toBe("waiting_on_teammate");
    expect(res.body.blocker.what).toMatch(/brody/);
    expect(res.body.blocker.retrySafe).toBe(true);

    res = await api.post(url, { status: "blocked" });
    expect(res.status).toBe(200);

    res = await api.post(url, { status: "review" });
    expect(res.body.status).toBe("review");
    expect(res.body.blocker).toBeNull();

    const types = (await api.get(`${base}/events`)).body.map((e: any) => e.type);
    expect(types.filter((t: string) => t === "task.moved").length).toBe(4);
    expect(types).toContain("task.blocked");
    expect(types).toContain("task.unblocked");
  });

  it("refuses to start a task whose dependencies are not done, and refuses cycles", async () => {
    const { api, base } = await seedCompany(board, "t4@example.com");
    const project = await addProject(api, base);
    const first = (await api.post(`${base}/tasks`, { projectId: project.id, title: "Build" })).body;
    const second = (
      await api.post(`${base}/tasks`, { projectId: project.id, title: "Verify", dependsOn: [first.id] })
    ).body;
    expect(second.dependsOn).toEqual([first.id]);

    const blocked = await api.post(`${base}/tasks/${second.id}/move`, { status: "doing" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.details.blocker.code).toBe("dependencies_unresolved");
    expect(blocked.body.error).toMatch(/#1 Build/);

    expect((await api.put(`${base}/tasks/${first.id}/dependencies/${second.id}`)).status).toBe(409);
    expect((await api.del(`${base}/tasks/${second.id}/dependencies/${first.id}`)).status).toBe(200);
    expect((await api.post(`${base}/tasks/${second.id}/move`, { status: "doing" })).status).toBe(200);
  });

  it("validates assignees against the company and lists by project, department and status", async () => {
    const { api, base } = await seedCompany(board, "t5@example.com");
    const project = await addProject(api, base);
    const dept = (await api.post(`${base}/departments`, { name: "Research" })).body;
    const foreign = await seedCompany(board, "t5b@example.com");
    const foreignMate = await addTeammate(foreign.api, foreign.base, "Ricky");
    expect(
      (
        await api.post(`${base}/tasks`, {
          projectId: project.id,
          title: "x",
          assignee: { kind: "teammate", id: foreignMate.id },
        })
      ).status,
    ).toBe(422);
    const t = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "Research Globex",
        departmentId: dept.id,
      })
    ).body;
    await api.post(`${base}/tasks/${t.id}/move`, { status: "doing" });
    expect((await api.get(`${base}/tasks?departmentId=${dept.id}`)).body).toHaveLength(1);
    expect((await api.get(`${base}/tasks?status=doing`)).body[0].id).toBe(t.id);
    expect((await api.get(`${base}/tasks?status=todo`)).body).toHaveLength(0);
    expect((await foreign.api.get(`${foreign.base}/tasks`)).body).toHaveLength(0);
    expect((await api.get(`${foreign.base}/tasks`)).status).toBe(403);
  });

  it("reviewers can post and move but viewers cannot", async () => {
    const { api, base } = await seedCompany(board, "t6@example.com");
    const project = await addProject(api, base);
    const t = (await api.post(`${base}/tasks`, { projectId: project.id, title: "x" })).body;
    await api.post(`${base}/members`, { email: "rev@example.com", role: "reviewer" });
    await api.post(`${base}/members`, { email: "view@example.com", role: "viewer" });
    const rev = board.api((await board.login("rev@example.com")).token);
    const view = board.api((await board.login("view@example.com")).token);
    expect((await rev.post(`${base}/tasks/${t.id}/move`, { status: "review" })).status).toBe(200);
    expect((await view.post(`${base}/tasks/${t.id}/move`, { status: "todo" })).status).toBe(403);
    expect((await view.get(`${base}/tasks`)).status).toBe(200);
  });
});
