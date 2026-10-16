// Department leads are Peter instances scoped to their department: a goal
// routed to a department is planned, started, re-planned and chased by its
// lead, in the lead's name; the company Peter routes goals to leads and keeps
// what belongs to no department. No model, no network.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGoal, planGoal, type PeterDeps } from "../src/peter/goals.js";
import { peterPass } from "../src/peter/loop.js";
import type { PeterModel } from "../src/peter/model.js";
import { managerFor, managerForTask } from "../src/peter/seat.js";
import {
  addTeammate,
  seatedPeter,
  seedCompany,
  startTestBoard,
  workerClaim,
  workerComplete,
  type TestBoard,
} from "./helpers.js";

let board: TestBoard;

beforeAll(async () => {
  board = await startTestBoard();
});
afterAll(async () => {
  await board.destroy();
});

const baseDeps = () => ({
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

async function company(email: string) {
  const c = await seedCompany(board, email);
  const { api, base } = c;
  const peter = await seatedPeter(api, base);
  const archy = await addTeammate(api, base, "Archy", "architect");
  const cody = await addTeammate(api, base, "Cody", "n8n engineer");
  const ricky = await addTeammate(api, base, "Ricky", "researcher");
  const finn = await addTeammate(api, base, "Finn", "finance analyst");
  const eng = (
    await api.post(`${base}/departments`, {
      name: "Engineering",
      writePolicy: "drafts",
      leadTeammateId: archy.id,
      memberTeammateIds: [cody.id, ricky.id],
    })
  ).body;
  return { ...c, peter, archy, cody, ricky, finn, eng };
}

describe("department leads", () => {
  it("the lead is the manager of its department; the company Peter manages the rest", async () => {
    const { companyId, archy, peter, eng } = await company("dl1@example.com");
    expect((await managerFor(board.db, companyId, eng.id))?.id).toBe(archy.id);
    expect((await managerFor(board.db, companyId, null))?.id).toBe(peter.id);
    const other = (
      await board
        .api((await board.login("dl1@example.com")).token)
        .post(`/api/companies/${companyId}/departments`, { name: "Ops" })
    ).body;
    // A department without a lead falls back to Peter.
    expect((await managerFor(board.db, companyId, other.id))?.id).toBe(peter.id);
  });

  it("a goal routed to a department is planned, started, re-planned and chased by its lead", async () => {
    const { api, base, companyId, archy, cody, ricky, eng } = await company("dl2@example.com");
    const goal = (await api.post(`${base}/goals`, { text: "Map the VMS workflows.", departmentId: eng.id }))
      .body;
    expect(goal.status).toBe("active");
    expect(goal.departmentId).toBe(eng.id);
    // Planned by Archy from the department's members; Archy never assigns himself.
    expect(goal.tasks.map((t: any) => [t.assignee.id, t.departmentId, t.createdBy.id])).toEqual([
      [ricky.id, eng.id, archy.id],
      [cody.id, eng.id, archy.id],
    ]);
    const planned = (await api.get(`${base}/events`)).body.find((e: any) => e.type === "goal.planned");
    expect(planned.actor).toEqual({ kind: "teammate", id: archy.id });
    expect(planned.payload.managerName).toBe("Archy");
    // Started by Archy.
    const runs = (await api.get(`${base}/tasks/${goal.tasks[0].id}/runs`)).body;
    expect(runs[0].createdBy).toEqual({ kind: "teammate", id: archy.id });
    // Re-planned by Archy after a failure.
    const claimed = await workerClaim(board, runs[0].id);
    await workerComplete(board, claimed.token, runs[0].id, { status: "failed", error: "nope" });
    const pass = await peterPass(baseDeps(), companyId);
    expect(pass.replanned).toHaveLength(1);
    const msgs = (await api.get(`${base}/tasks/${goal.tasks[0].id}/messages`)).body;
    expect(msgs.at(-1).author.name).toBe("Archy");
    expect((await api.get(`${base}/tasks/${goal.tasks[0].id}/runs`)).body[0].note).toMatch(
      /^Re-planned by Archy/,
    );
    // Chased by Archy: the build task waits on Ricky in the department.
    await api.post(`${base}/tasks/${goal.tasks[1].id}/move`, {
      status: "blocked",
      blocker: {
        code: "waiting_on_teammate",
        what: "Need the map.",
        waitingOn: { kind: "teammate", id: ricky.id, name: "ricky" },
      },
    });
    await board.db.query("UPDATE tasks SET updated_at = now() - interval '11 minutes' WHERE id = $1", [
      goal.tasks[1].id,
    ]);
    const chased = await peterPass(baseDeps(), companyId);
    expect(chased.chased).toBe(1);
    const nudge = (await api.get(`${base}/tasks/${goal.tasks[1].id}/messages`)).body.at(-1);
    expect(nudge.author.name).toBe("Archy");
    expect(nudge.body).toMatch(/^@ricky #\d+ is waiting on you/);
  });

  it("the company Peter routes a goal to the department its work lands in, and keeps the rest", async () => {
    const { api, base, companyId, archy, peter, eng, finn, ricky, cody } = await company("dl3@example.com");
    // Research and build both land in Engineering: the goal is routed there and Archy tends it from then on.
    // Archy, an architect, is the least loaded builder and gets the build himself.
    const routed = (await api.post(`${base}/goals`, { text: "Build the digest." })).body;
    expect(routed.departmentId).toBe(eng.id);
    expect(routed.tasks.map((t: any) => t.assignee.id)).toEqual([ricky.id, archy.id]);
    // Planned by Peter (the goal had no department when planning began).
    const planned = (await api.get(`${base}/events`)).body.find(
      (e: any) => e.type === "goal.planned" && e.subject.id === routed.id,
    );
    expect(planned.actor).toEqual({ kind: "teammate", id: peter.id });
    // Ricky's task is Archy's to manage; Archy's own task is Peter's: nobody manages their own task.
    expect(
      (await managerForTask(board.db, companyId, { department_id: eng.id, assignee_id: ricky.id }))?.id,
    ).toBe(archy.id);
    expect(
      (await managerForTask(board.db, companyId, { department_id: eng.id, assignee_id: archy.id }))?.id,
    ).toBe(peter.id);
    void cody;
    // Finn is in no department; a goal only he can do stays with Peter.
    await board.db.query("UPDATE teammates SET role = 'finance builder' WHERE id = $1", [finn.id]);
    await board.db.query("UPDATE teammates SET role = 'reviewer' WHERE id = ANY($1::uuid[])", [
      [archy.id, cody.id],
    ]);
    await board.db.query("DELETE FROM department_members WHERE teammate_id = ANY($1::uuid[])", [
      [ricky.id, archy.id, cody.id],
    ]);
    const kept = (await api.post(`${base}/goals`, { text: "Reconcile Xero." })).body;
    expect(kept.departmentId).toBeNull();
    expect(kept.tasks.map((t: any) => t.assignee.id)).toContain(finn.id);
  });

  it("a lead's model plans from the department's members only: an outsider in the plan is refused", async () => {
    const { owner, companyId, archy, cody, ricky, eng } = await company("dl-roster@example.com");
    const seen: string[] = [];
    // A model that answers with whoever the test names, and records the roster it was shown.
    const naming = (handles: string[]): PeterModel => ({
      available: true,
      async complete(req) {
        seen.push(req.system);
        const output = {
          title: "Scoped",
          background: "",
          outcome: "Done.",
          doneDefinition: "Done.",
          questions: [],
          department: null,
          tasks: handles.map((h) => ({
            title: `Work for ${h}`,
            brief: "Do it.",
            assignee: `@${h}`,
            workKind: "research" as const,
            outputs: [`${h}.md`],
            criteria: [{ text: "It is done", weight: 1 }],
            dependsOn: [],
          })),
        };
        return {
          output: output as never,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          model: req.model,
        };
      },
    });
    const deps = (model: PeterModel): PeterDeps => ({
      ...(baseDeps() as unknown as PeterDeps),
      model,
    });
    const actor = { kind: "user" as const, id: owner.userId };

    const inside = await createGoal(deps(naming(["ricky", "cody"])), companyId, actor, {
      text: "Map the VMS workflows.",
      departmentId: eng.id,
    });
    const planned = await planGoal(deps(naming(["ricky", "cody"])), inside.id);
    expect(planned.planner).toMatch(/^model:/);
    // Archy was shown Engineering's members and nobody else.
    expect(seen[0]).toContain("@ricky (Ricky)");
    expect(seen[0]).toContain("@cody (Cody)");
    expect(seen[0]).not.toContain("@finn");
    expect(seen[0]).not.toContain("@archy (Archy)");

    const outside = await createGoal(deps(naming(["finn"])), companyId, actor, {
      text: "Price the VMS work.",
      departmentId: eng.id,
    });
    const refused = await planGoal(deps(naming(["finn"])), outside.id);
    expect(refused.planner).toMatch(
      /^heuristic \(the model's plan was refused: task 1 names @finn, who is not on the roster/,
    );
    const assignees = (
      await board.db.query(
        "SELECT assignee_id FROM tasks t JOIN goals g ON g.project_id = t.project_id WHERE g.id = $1",
        [outside.id],
      )
    ).rows.map((r) => r.assignee_id);
    expect(assignees.every((a) => [ricky.id, cody.id].includes(a))).toBe(true);
    expect(assignees).not.toContain(archy.id);
  });
});
