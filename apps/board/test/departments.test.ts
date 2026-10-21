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
    // The worker names the department when an engine cannot keep to its tool list.
    expect(body.spec.department).toEqual({ name: "Engineering", writePolicy: "ask" });
    expect(body.pack).toContain("Time limit: 10 minutes.");
  });

  it("keeps a Codex teammate out of a department whose tool list Codex cannot keep to, and says why", async () => {
    const { api, base, companyId } = await seedCompany(board, "d6@example.com");
    const dex = (
      await api.post(`${base}/teammates`, {
        name: "Dex",
        role: "automation engineer",
        engine: "codex",
        model: "gpt-6-astra",
      })
    ).body;
    const cody = await addTeammate(api, base, "Cody");
    const workspace = ["Read(./**)", "Write(./**)", "Edit(./**)", "Glob(./**)", "Grep(./**)"];
    const why =
      "it reads files and runs commands only through its shell, and the list leaves out Bash. Name Bash on its own in the list";
    const names = async () =>
      (await api.get(`${base}/departments`)).body.map((d: any) => [
        d.name,
        d.members.map((m: any) => m.name),
      ]);

    // Created with Dex in it: refused, and nothing is created.
    let res = await api.post(`${base}/departments`, {
      name: "Research",
      memberTeammateIds: [cody.id, dex.id],
      sandbox: { allowedTools: workspace },
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(
      `Dex runs on Codex, which cannot keep to Research's tool list: ${why}, or pick another engine for Dex.`,
    );
    expect(await names()).toEqual([]);
    // Without Dex, or with Bash named on its own, it is created.
    const research = (
      await api.post(`${base}/departments`, {
        name: "Research",
        memberTeammateIds: [cody.id],
        sandbox: { allowedTools: workspace },
      })
    ).body;
    const eng = (
      await api.post(`${base}/departments`, {
        name: "Engineering",
        leadTeammateId: dex.id,
        sandbox: { allowedTools: [...workspace, "Bash"] },
      })
    ).body;
    expect(eng.leadTeammateId).toBe(dex.id);

    // Seated in Research as a member or as its lead: refused.
    res = await api.put(`${base}/departments/${research.id}/members/${dex.id}`, { isLead: false });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/^Dex runs on Codex, which cannot keep to Research's tool list/);
    expect((await api.patch(`${base}/departments/${research.id}`, { leadTeammateId: dex.id })).status).toBe(
      409,
    );
    // A list Codex cannot keep to, set where Dex sits: refused; one that only some shell commands may run, too.
    res = await api.patch(`${base}/departments/${eng.id}`, { sandbox: { allowedTools: workspace } });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/^Dex runs on Codex, which cannot keep to Engineering's tool list/);
    res = await api.patch(`${base}/departments/${eng.id}`, {
      sandbox: { allowedTools: [...workspace, "Bash(npm test:*)"] },
    });
    expect(res.body.error).toBe(
      "Dex runs on Codex, which cannot keep to Engineering's tool list: it cannot hold its shell to some commands, and the list allows only Bash(npm test:*). Name Bash on its own in the list, or pick another engine for Dex.",
    );
    expect(
      (
        await api.patch(`${base}/departments/${eng.id}`, {
          sandbox: { allowedTools: ["Bash", "Read(./**)"], timeoutSeconds: 600 },
        })
      ).status,
    ).toBe(200);
    // A teammate who sits in Research moves to Codex: refused. One who sits nowhere it cannot keep to moves.
    res = await api.patch(`${base}/teammates/${cody.id}`, { engine: "codex", model: "gpt-6-astra" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(
      `Cody sits in Research, and Codex cannot keep to Research's tool list: ${why}, or take Cody out of Research first.`,
    );
    const finn = await addTeammate(api, base, "Finn");
    expect((await api.patch(`${base}/teammates/${finn.id}`, { engine: "codex" })).status).toBe(200);
    expect(await names()).toEqual([
      ["Research", ["Cody"]],
      ["Engineering", ["Dex"]],
    ]);

    // Set up before this check (or by hand): nothing that leaves it as it was, or undoes it, is refused.
    await board.db.query(
      "INSERT INTO department_members (company_id, department_id, teammate_id, is_lead) VALUES ($1, $2, $3, false)",
      [companyId, research.id, dex.id],
    );
    expect(
      (
        await api.patch(`${base}/departments/${research.id}`, {
          sandbox: { allowedTools: workspace, timeoutSeconds: 900 },
        })
      ).status,
    ).toBe(200);
    expect(
      (await api.put(`${base}/departments/${research.id}/members/${dex.id}`, { isLead: true })).status,
    ).toBe(200);
    expect((await api.patch(`${base}/teammates/${dex.id}`, { name: "Dex", engine: "codex" })).status).toBe(
      200,
    );
    expect((await api.patch(`${base}/teammates/${dex.id}`, { engine: "claude_code" })).status).toBe(200);
    expect((await api.del(`${base}/departments/${research.id}/members/${dex.id}`)).status).toBe(200);
  });

  it("slugs are unique per company", async () => {
    const { api, base } = await seedCompany(board, "d4@example.com");
    expect((await api.post(`${base}/departments`, { name: "Marketing Ops" })).status).toBe(201);
    expect((await api.post(`${base}/departments`, { name: "marketing ops" })).status).toBe(409);
  });
});
