// Approvals: a teammate's proposed write to a live system waits for a person;
// approve verifies the sha256 and sends exactly those bytes through the
// executor, then restarts the proposer with the outcome in their pack; a
// tampered payload sends nothing; reject leaves the task blocked and Peter
// re-plans it on his next pass. No live system: the executor is a fake that
// records what it was handed.
import { parseStdioCommands, payloadSha256 } from "@rosterdock/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { proposeApproval, type ApprovalRow } from "../src/approvals/service.js";
import { connectionRoots, writeTarget } from "../src/approvals/target.js";
import { peterPass } from "../src/peter/loop.js";
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
const sent: { approval: ApprovalRow; payload: unknown }[] = [];
let failNext: string | null = null;

beforeAll(async () => {
  board = await startTestBoard(
    // The drive's server runs inside the board, so the operator lists its command line.
    { stdioCommands: parseStdioCommands("npx -y @modelcontextprotocol/server-filesystem /srv/drive") },
    {
      approvalExecutor: async (approval) => {
        sent.push({ approval, payload: approval.payload });
        if (failNext) {
          const error = failNext;
          failNext = null;
          return { ok: false, error };
        }
        return {
          ok: true,
          result: { id: "list-212", name: approval.payload.name, token: "should-be-kept-out" },
        };
      },
    },
  );
});
afterAll(async () => {
  await board.destroy();
});

const deps = () => ({
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

async function runningTask(api: Api, base: string, assigneeId: string, title = "HubSpot warm-accounts list") {
  const project = await addProject(api, base);
  const task = (
    await api.post(`${base}/tasks`, {
      projectId: project.id,
      title,
      description: "Build the Q3 warm accounts list in HubSpot from the Fibbler export.",
      assignee: { kind: "teammate", id: assigneeId },
    })
  ).body;
  const run = (await api.post(`${base}/tasks/${task.id}/runs`, {})).body;
  const claimed = await workerClaim(board, run.id);
  return { task, run, claimed };
}

const proposal = (taskId: string, runId: string, teammateId: string, name = "Q3 warm accounts") => ({
  taskId,
  runId,
  teammateId,
  connection: "hubspot",
  tool: "create_list",
  title: `Create a HubSpot list "${name}"`,
  why: "Reporter needs a static list of the 212 engaging companies for the weekly summary.",
  payload: { name, objectType: "company", processingType: "MANUAL" },
});

describe("approvals", () => {
  it("parks the task on a proposed write, and a finished run leaves it there with no review", async () => {
    const { api, base } = await seedCompany(board, "ap1@example.com");
    const cody = await addTeammate(api, base, "Cody 3");
    const { task, run, claimed } = await runningTask(api, base, cody.id);

    const { approval, created } = await proposeApproval(
      board.db,
      task.companyId,
      proposal(task.id, run.id, cody.id),
    );
    expect(created).toBe(true);
    expect(approval.status).toBe("pending");
    expect(approval.payload_sha256).toBe(payloadSha256(approval.payload));
    expect(approval.teammate_name).toBe("Cody 3");
    // The same bytes again: the same row.
    const again = await proposeApproval(board.db, task.companyId, proposal(task.id, run.id, cody.id));
    expect(again.created).toBe(false);
    expect(again.approval.id).toBe(approval.id);

    let t = (await api.get(`${base}/tasks/${task.id}`)).body;
    expect(t.status).toBe("blocked");
    expect(t.blocker.code).toBe("approval_required");
    expect(t.blocker.waitingOn).toEqual({ kind: "approval", id: approval.id, name: approval.title });

    // The run ends (the teammate handed over): the task stays at the gate and no review opens.
    await workerComplete(board, claimed.token, run.id, {
      status: "completed",
      summary: "Proposed the list.",
    });
    t = (await api.get(`${base}/tasks/${task.id}`)).body;
    expect(t.status).toBe("blocked");
    expect(t.blocker.code).toBe("approval_required");
    expect((await api.get(`${base}/tasks/${task.id}/review`)).status).toBe(404);

    const list = (await api.get(`${base}/approvals?status=pending`)).body;
    expect(list.map((a: { id: string }) => a.id)).toEqual([approval.id]);
    expect(list[0].teammate.name).toBe("Cody 3");
    expect(list[0].taskNumber).toBe(t.number);
    const byTask = (await api.get(`${base}/tasks/${task.id}/approvals`)).body;
    expect(byTask).toHaveLength(1);
    const events = (await api.get(`${base}/events?limit=50`)).body as { type: string; payload: any }[];
    const proposed = events.find((e) => e.type === "approval.proposed");
    expect(proposed?.payload).toMatchObject({
      connection: "hubspot",
      tool: "create_list",
      teammateName: "Cody 3",
    });

    // Deciding is for owners and admins. A reviewer or viewer may look, not decide.
    const reviewer = await board.login("ap1-reviewer@example.com", "Rae");
    await api.post(`${base}/members`, { email: "ap1-reviewer@example.com", role: "reviewer" });
    expect((await board.api(reviewer.token).get(`${base}/approvals`)).status).toBe(200);
    expect(
      (await board.api(reviewer.token).post(`${base}/approvals/${approval.id}/approve`, {})).status,
    ).toBe(403);
  });

  it("approve verifies the hash, sends exactly the bound bytes, and restarts the proposer with the outcome", async () => {
    const { api, base } = await seedCompany(board, "ap2@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const { task, run, claimed } = await runningTask(api, base, cody.id);
    const { approval } = await proposeApproval(board.db, task.companyId, proposal(task.id, run.id, cody.id));
    await workerComplete(board, claimed.token, run.id, { status: "completed", summary: "Proposed." });
    sent.length = 0;

    const res = await api.post(`${base}/approvals/${approval.id}/approve`, { note: "Go ahead." });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("executed");
    expect(res.body.note).toBe("Go ahead.");
    expect(res.body.result).toMatchObject({ id: "list-212" });
    expect(res.body.restarted.runId).toBeTruthy();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toEqual(approval.payload);
    expect(payloadSha256(sent[0]!.payload)).toBe(approval.payload_sha256);

    // The proposer continues: a new run, the task in progress, the outcome in the pack.
    const t = (await api.get(`${base}/tasks/${task.id}`)).body;
    expect(t.status).toBe("doing");
    const runs = (await api.get(`${base}/tasks/${task.id}/runs`)).body as { id: string; note: string }[];
    expect(runs[0]!.id).toBe(res.body.restarted.runId);
    expect(runs[0]!.note).toContain("approved and executed");
    const next = await workerClaim(board, runs[0]!.id);
    expect(next.pack).toContain("## Approvals on this task");
    expect(next.pack).toContain('Create a HubSpot list "Q3 warm accounts" (hubspot · create_list): executed');
    expect(next.pack).toContain("list-212");

    const events = (await api.get(`${base}/events?limit=50`)).body as { type: string }[];
    const types = events.map((e) => e.type);
    expect(types).toContain("approval.approved");
    expect(types).toContain("approval.executed");
    // Decided twice: refused.
    expect((await api.post(`${base}/approvals/${approval.id}/approve`, {})).status).toBe(409);
    expect((await api.post(`${base}/approvals/${approval.id}/reject`, {})).status).toBe(409);
  });

  it("a payload that drifted after proposal sends nothing and is recorded as failed", async () => {
    const { api, base } = await seedCompany(board, "ap3@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const { task, run, claimed } = await runningTask(api, base, cody.id);
    const { approval } = await proposeApproval(board.db, task.companyId, proposal(task.id, run.id, cody.id));
    await workerComplete(board, claimed.token, run.id, { status: "completed" });
    await board.db.query("UPDATE approvals SET payload = $2 WHERE id = $1", [
      approval.id,
      JSON.stringify({ ...approval.payload, name: "Every account we have" }),
    ]);
    sent.length = 0;
    const res = await api.post(`${base}/approvals/${approval.id}/approve`, {});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("failed");
    expect(res.body.error).toContain("no longer matches the sha256");
    expect(sent).toHaveLength(0);
    const events = (await api.get(`${base}/events?limit=50`)).body as { type: string; payload: any }[];
    expect(events.find((e) => e.type === "approval.failed")?.payload.error).toContain("sha256");
    // The proposer was restarted and learns of it; in that run they propose again, and this time the live
    // system refuses: failed too, and the proposer learns of that as well.
    const restarted = (await api.get(`${base}/tasks/${task.id}/runs`)).body[0] as { id: string };
    const again = await workerClaim(board, restarted.id);
    expect(again.pack).toContain("approved but the send failed: the payload no longer matches");
    const second = await proposeApproval(
      board.db,
      task.companyId,
      proposal(task.id, restarted.id, cody.id, "Q3 warm accounts, take two"),
    );
    await workerComplete(board, again.token, restarted.id, { status: "completed" });
    expect((await api.get(`${base}/tasks/${task.id}`)).body.status).toBe("blocked");
    failNext = "HubSpot answered HTTP 429";
    const res2 = await api.post(`${base}/approvals/${second.approval.id}/approve`, {});
    expect(res2.body.status).toBe("failed");
    expect(res2.body.error).toBe("HubSpot answered HTTP 429");
    expect(res2.body.restarted.runId).toBeTruthy();
  });

  it("reject leaves the task blocked and Peter re-plans it with the note in the next pack", async () => {
    const { api, base, companyId } = await seedCompany(board, "ap4@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const { task, run, claimed } = await runningTask(api, base, cody.id);
    const { approval } = await proposeApproval(board.db, task.companyId, proposal(task.id, run.id, cody.id));
    await workerComplete(board, claimed.token, run.id, { status: "completed" });

    const res = await api.post(`${base}/approvals/${approval.id}/reject`, {
      note: "Not a static list; use the existing active list.",
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rejected");
    let t = (await api.get(`${base}/tasks/${task.id}`)).body;
    expect(t.status).toBe("blocked");
    expect(t.blocker.code).toBe("approval_required");

    const pass = await peterPass(deps(), companyId);
    expect(pass.replanned).toHaveLength(1);
    expect(pass.replanned[0]!.taskId).toBe(task.id);
    t = (await api.get(`${base}/tasks/${task.id}`)).body;
    expect(t.status).toBe("doing");
    expect(t.replans).toBe(1);
    const runs = (await api.get(`${base}/tasks/${task.id}/runs`)).body as { id: string; note: string }[];
    expect(runs[0]!.note).toContain("rejected proposal");
    // The note ends in its own full stop: quoted once, never "list..".
    expect(runs[0]!.note).toContain("use the existing active list. Do not propose that write again");
    expect(runs[0]!.note).not.toContain("..");
    const next = await workerClaim(board, runs[0]!.id);
    expect(next.pack).toContain("rejected: Not a static list; use the existing active list.");
    // A second pass changes nothing.
    expect((await peterPass(deps(), companyId)).replanned).toHaveLength(0);
  });

  it("with two proposals waiting, the proposer continues only once both are decided", async () => {
    const { api, base } = await seedCompany(board, "ap5@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const { task, run, claimed } = await runningTask(api, base, cody.id);
    const a = await proposeApproval(board.db, task.companyId, proposal(task.id, run.id, cody.id, "List A"));
    const b = await proposeApproval(board.db, task.companyId, proposal(task.id, run.id, cody.id, "List B"));
    await workerComplete(board, claimed.token, run.id, { status: "completed" });
    const first = await api.post(`${base}/approvals/${a.approval.id}/approve`, {});
    expect(first.body.status).toBe("executed");
    expect(first.body.restarted.runId).toBeNull();
    expect(first.body.restarted.reason).toContain("still wait");
    expect((await api.get(`${base}/tasks/${task.id}`)).body.status).toBe("blocked");
    const second = await api.post(`${base}/approvals/${b.approval.id}/approve`, {});
    expect(second.body.restarted.runId).toBeTruthy();
    expect((await api.get(`${base}/tasks/${task.id}`)).body.status).toBe("doing");
  });

  it("refuses a proposal that carries a credential value", async () => {
    const { api, base } = await seedCompany(board, "ap6@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const { task, run } = await runningTask(api, base, cody.id);
    await expect(
      proposeApproval(board.db, task.companyId, {
        ...proposal(task.id, run.id, cody.id),
        payload: { name: "x", apiKey: "sk-live-0123456789abcdefghijklmnop" },
      }),
    ).rejects.toThrow(/secret/i);
  });

  it("a newer proposal of the same write replaces the one still waiting, which can no longer be approved", async () => {
    const { api, base } = await seedCompany(board, "ap7@example.com");
    const brody = await addTeammate(api, base, "Brody");
    // The drive: the MCP filesystem server on one directory, so a path under it is one file however spelled.
    expect(
      (
        await api.post(`${base}/connections`, {
          name: "drive",
          transport: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/srv/drive"],
        })
      ).status,
    ).toBe(201);
    const { task, run, claimed } = await runningTask(api, base, brody.id, "Publish the positioning");
    const write = (path: string, content: string, title: string) => ({
      taskId: task.id,
      runId: run.id,
      teammateId: brody.id,
      connection: "drive",
      tool: "write_file",
      title,
      why: "The positioning goes to the drive's published folder.",
      payload: { path, content },
    });
    // Live on Lighthouse the draft named the file absolutely and the correction relatively.
    const draft = await proposeApproval(
      board.db,
      task.companyId,
      write("/srv/drive/published/positioning.md", "# Draft\n", "Publish positioning.md"),
    );
    const notes = await proposeApproval(
      board.db,
      task.companyId,
      write("published/notes.md", "# Notes\n", "Publish notes.md"),
    );
    // Two writes that name nothing (no path, no id) are never the same write.
    const mail = (body: string) => ({
      ...write("", "", "Email the team"),
      connection: "mail",
      tool: "send",
      payload: { to: "team@example.com", body },
    });
    const mailA = await proposeApproval(board.db, task.companyId, mail("First"));
    await proposeApproval(board.db, task.companyId, mail("Second"));
    const corrected = await proposeApproval(
      board.db,
      task.companyId,
      write("published/positioning.md", "# Corrected\n", "Publish corrected positioning.md"),
    );
    expect(corrected.created).toBe(true);

    const list = (await api.get(`${base}/approvals`)).body as any[];
    const byId = (id: string) => list.find((a) => a.id === id);
    expect(byId(draft.approval.id)).toMatchObject({
      status: "superseded",
      supersededBy: corrected.approval.id,
      target: "/srv/drive/published/positioning.md",
    });
    expect(byId(notes.approval.id).status).toBe("pending");
    expect(byId(mailA.approval.id)).toMatchObject({ status: "pending", target: null });
    // The task waits on the newer proposal.
    expect((await api.get(`${base}/tasks/${task.id}`)).body.blocker.waitingOn.id).toBe(corrected.approval.id);
    const superseded = ((await api.get(`${base}/events`)).body as any[]).find(
      (e) => e.type === "approval.superseded",
    );
    expect(superseded.payload).toMatchObject({
      by: corrected.approval.id,
      target: "published/positioning.md",
    });

    // The replaced one is decided neither way, and nothing is sent for it.
    await workerComplete(board, claimed.token, run.id, { status: "completed" });
    const before = sent.length;
    for (const verb of ["approve", "reject"]) {
      const res = await api.post(`${base}/approvals/${draft.approval.id}/${verb}`, {});
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("a newer proposal of the same write replaced this one; decide that one");
    }
    expect(sent).toHaveLength(before);
    expect((await api.post(`${base}/approvals/${corrected.approval.id}/approve`, {})).body.status).toBe(
      "executed",
    );
    expect(sent.at(-1)!.payload).toEqual({ path: "published/positioning.md", content: "# Corrected\n" });
  });

  it("names a write's target by the arguments that name it, never by what it carries", () => {
    expect(writeTarget({ path: "a/b.md", content: "x" })).toEqual({
      key: '[["path","a/b.md"]]',
      label: "a/b.md",
    });
    expect(writeTarget({ page_id: "p1", name: "Q3", body: "x" })?.label).toBe("Q3 · p1");
    expect(writeTarget({ to: "team@example.com", body: "x" })).toBeNull();
    // Under a directory the connection was started with, a path is named relative to it.
    const roots = connectionRoots(["-y", "@modelcontextprotocol/server-filesystem", "/srv/drive/"]);
    expect(roots).toEqual(["/srv/drive"]);
    // Lighthouse's drive is started as ~/Lighthouse/drive: the board's home, as the child sees it.
    expect(connectionRoots(["-y", "server-filesystem", "~/Lighthouse/drive"], "/home/node")).toEqual([
      "/home/node/Lighthouse/drive",
    ]);
    const key = (p: string) => writeTarget({ path: p, content: "x" }, roots)?.key;
    expect(key("/srv/drive/published/a.md")).toBe(key("published/a.md"));
    expect(key("./published/a.md")).toBe(key("published/a.md"));
    expect(key("/srv/drive/published/../published/a.md")).toBe(key("published/a.md"));
    expect(key("/etc/published/a.md")).not.toBe(key("published/a.md"));
  });
});
