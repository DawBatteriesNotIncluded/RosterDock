// A teammate's effort: set, changed, kept when another field changes, reset to
// the engine's default, refused when it is not a level; carried in the run
// spec the worker claims; and kept through a templates file.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addProject,
  addTeammate,
  seedCompany,
  startTestBoard,
  workerClaim,
  type TestBoard,
} from "./helpers.js";

let board: TestBoard;

beforeAll(async () => {
  board = await startTestBoard();
});
afterAll(async () => {
  await board.destroy();
});

describe("a teammate's effort", () => {
  it("is set, kept, reset and refused like any teammate field, and reaches the worker in the run spec", async () => {
    const { api, base } = await seedCompany(board, "effort@example.com");
    const made = await api.post(`${base}/teammates`, {
      name: "Fern",
      role: "frontend engineer",
      model: "claude-sonnet-5-5",
      effort: "high",
    });
    expect(made.status).toBe(201);
    expect(made.body.effort).toBe("high");
    const id = made.body.id as string;
    expect((await api.patch(`${base}/teammates/${id}`, { effort: "max" })).body.effort).toBe("max");
    // Another field changes; the effort stays.
    expect((await api.patch(`${base}/teammates/${id}`, { role: "web engineer" })).body.effort).toBe("max");
    expect((await api.patch(`${base}/teammates/${id}`, { effort: "extreme" })).status).toBe(400);

    // The worker gets it with the run.
    const project = await addProject(api, base);
    const task = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "Build the page",
        assignee: { kind: "teammate", id },
      })
    ).body;
    const run = (await api.post(`${base}/tasks/${task.id}/runs`, {})).body;
    const claimed = await workerClaim(board, run.id);
    expect((claimed.spec.teammate as { effort: string | null }).effort).toBe("max");

    // Null is the engine's own default again.
    expect((await api.patch(`${base}/teammates/${id}`, { effort: null })).body.effort).toBeNull();
    const plain = await addTeammate(api, base, "Cody");
    expect((await api.get(`${base}/teammates/${plain.id}`)).body.effort).toBeNull();
  });

  it("travels in a templates file, from a template and on a teammate", async () => {
    const { api, base } = await seedCompany(board, "effort-file@example.com");
    const file = {
      format: "rosterdock/templates/1",
      teammateTemplates: [
        {
          name: "Deep thinker",
          role: "architect",
          model: "claude-opus-5-5",
          effort: "xhigh",
          personaMd: "Think.",
        },
      ],
      teammates: [
        { name: "Archy", template: "Deep thinker" },
        { name: "Quick", role: "writer", model: "claude-haiku-4-5", effort: "low" },
      ],
    };
    expect((await api.post(`${base}/templates/import`, file)).status).toBe(200);
    const mates = (await api.get(`${base}/teammates`)).body as { name: string; effort: string | null }[];
    expect(mates.find((m) => m.name === "Archy")?.effort).toBe("xhigh");
    expect(mates.find((m) => m.name === "Quick")?.effort).toBe("low");
    const exported = (await api.get(`${base}/templates/export`)).body;
    expect(exported.teammateTemplates.find((t: any) => t.name === "Deep thinker").effort).toBe("xhigh");
    expect(exported.teammates.find((t: any) => t.name === "Quick").effort).toBe("low");
    // The seated Peter has none, and the file says nothing for him.
    expect(exported.teammates.find((t: any) => t.name === "Peter")).not.toHaveProperty("effort");
  });
});
