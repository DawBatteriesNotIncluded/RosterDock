import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addProject, addTeammate, seedCompany, startTestBoard, type TestBoard } from "./helpers.js";

let board: TestBoard;

beforeAll(async () => {
  board = await startTestBoard();
});
afterAll(async () => {
  await board.destroy();
});

describe("messages", () => {
  it("posts on a task, resolves @mentions to teammates, and counts on the task", async () => {
    const { api, base } = await seedCompany(board, "m1@example.com");
    const ricky = await addTeammate(api, base, "Ricky", "researcher");
    const cody2 = await addTeammate(api, base, "Cody 2");
    const project = await addProject(api, base);
    const task = (
      await api.post(`${base}/tasks`, { projectId: project.id, title: "Map VMS sub-workflow calls" })
    ).body;

    const res = await api.post(`${base}/tasks/${task.id}/messages`, {
      body: "@ricky the outbound-mail sub-workflow references a credential I cannot resolve by name. @cody2 fyi. @nobody is not here.",
    });
    expect(res.status).toBe(201);
    expect(res.body.author.name).toBe("Daniel");
    expect(res.body.mentions.map((m: any) => m.handle)).toEqual(["ricky", "cody2"]);
    expect(res.body.mentions[0].id).toBe(ricky.id);
    expect(res.body.mentions[1].id).toBe(cody2.id);

    const list = await api.get(`${base}/tasks/${task.id}/messages`);
    expect(list.body).toHaveLength(1);
    expect((await api.get(`${base}/tasks/${task.id}`)).body.messageCount).toBe(1);

    const ev = (await api.get(`${base}/events`)).body.find((e: any) => e.type === "message.posted");
    expect(ev.subject).toEqual({ kind: "task", id: task.id });
    expect(ev.payload.mentions.map((m: any) => m.name)).toEqual(["Ricky", "Cody 2"]);
  });

  it("a teammate replies as itself; viewers cannot post", async () => {
    const { api, base } = await seedCompany(board, "m2@example.com");
    const ricky = await addTeammate(api, base, "Ricky", "researcher");
    const project = await addProject(api, base);
    const task = (await api.post(`${base}/tasks`, { projectId: project.id, title: "x" })).body;
    const token = (await api.post(`${base}/teammates/${ricky.id}/tokens`, {})).body.token;
    const reply = await board
      .api(token)
      .post(`${base}/tasks/${task.id}/messages`, { body: "Yes. Three credential names, no values." });
    expect(reply.status).toBe(201);
    expect(reply.body.author).toEqual({ kind: "teammate", id: ricky.id, name: "Ricky" });

    await api.post(`${base}/members`, { email: "v@example.com", role: "viewer" });
    const viewer = board.api((await board.login("v@example.com")).token);
    expect((await viewer.post(`${base}/tasks/${task.id}/messages`, { body: "hi" })).status).toBe(403);
    expect((await viewer.get(`${base}/tasks/${task.id}/messages`)).status).toBe(200);
  });

  it("refuses secret-shaped strings in a message body", async () => {
    const { api, base } = await seedCompany(board, "m3@example.com");
    const project = await addProject(api, base);
    const task = (await api.post(`${base}/tasks`, { projectId: project.id, title: "x" })).body;
    const res = await api.post(`${base}/tasks/${task.id}/messages`, {
      body: "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
    });
    expect(res.status).toBe(422);
  });
});
