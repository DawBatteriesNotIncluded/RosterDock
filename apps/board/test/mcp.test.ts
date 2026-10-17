// The board MCP server through a real MCP client over HTTP on an ephemeral
// localhost port. No model, no external network.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addProject,
  addTeammate,
  seatedPeter,
  seedCompany,
  startTestBoard,
  type TestBoard,
  workerClaim,
} from "./helpers.js";

let board: TestBoard;
let baseUrl: string;

beforeAll(async () => {
  board = await startTestBoard();
  const address = await board.app.listen({ host: "127.0.0.1", port: 0 });
  baseUrl = address;
});
afterAll(async () => {
  await board.destroy();
});

async function claimedToken(api: ReturnType<TestBoard["api"]>, base: string, taskId: string) {
  const run = (await api.post(`${base}/tasks/${taskId}/runs`, {})).body;
  const job = (await board.db.query<{ job_id: string }>("SELECT job_id FROM runs WHERE id = $1", [run.id]))
    .rows[0]!.job_id;
  const res = await board.app.inject({
    method: "POST",
    url: "/api/worker/claim",
    headers: { "x-rosterdock-worker-token": "test-worker-token" },
    payload: { runId: run.id, jobId: job, workerId: "w" },
  });
  return { runId: run.id as string, token: JSON.parse(res.body).token as string };
}

async function connect(token: string) {
  const client = new Client({ name: "test", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/api/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): any {
  const content = (result.content as { type: string; text?: string }[])[0];
  const t = content?.text ?? "";
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

describe("board MCP server", () => {
  it("lists the board tools and acts as the teammate whose run token it was given", async () => {
    const { api, base } = await seedCompany(board, "mcp1@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const ricky = await addTeammate(api, base, "Ricky", "researcher");
    const project = await addProject(api, base);
    const task = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "Map VMS sub-workflow calls",
        description: "Every Execute Workflow node reachable from the intake workflow.",
        assignee: { kind: "teammate", id: cody.id },
        declaredOutputs: ["vms-architecture.md"],
      })
    ).body;
    await api.post(`${base}/tasks/${task.id}/messages`, { body: "Scope: intake workflow only." });
    const { runId, token } = await claimedToken(api, base, task.id);
    const client = await connect(token);

    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual([
      "board_approve",
      "board_create_task",
      "board_list_my_tasks",
      "board_list_tools",
      "board_log_decision",
      "board_post_message",
      "board_read_output",
      "board_read_task",
      "board_request_changes",
      "board_request_review",
      "board_review_comment",
      "board_review_diff",
      "board_review_score",
      "board_set_blocker",
      "board_tool_call",
    ]);

    // Read defaults to the run's task and includes the conversation.
    const read = text(await client.callTool({ name: "board_read_task", arguments: {} }));
    expect(read.number).toBe(1);
    expect(read.assigneeHandle).toBe("cody");
    expect(read.conversation.map((m: any) => m.body)).toEqual(["Scope: intake workflow only."]);
    expect(read.declaredOutputs).toEqual(["vms-architecture.md"]);

    const mine = text(await client.callTool({ name: "board_list_my_tasks", arguments: {} }));
    expect(mine.map((t: any) => t.number)).toEqual([1]);

    // Post with a mention: recorded as authored by Cody, routed to Ricky, self-mentions dropped.
    const posted = text(
      await client.callTool({
        name: "board_post_message",
        arguments: {
          body: "@ricky which credential names does the outbound-mail sub-workflow use? (cc @cody)",
        },
      }),
    );
    expect(posted.author).toMatchObject({ kind: "teammate", id: cody.id, name: "Cody" });
    expect(posted.mentions.map((m: any) => m.handle)).toEqual(["ricky"]);

    // File a follow-up for Ricky that this task waits on.
    const created = text(
      await client.callTool({
        name: "board_create_task",
        arguments: {
          title: "List credential names in outbound-mail",
          assigneeHandle: "@ricky",
          declaredOutputs: ["credentials.md"],
        },
      }),
    );
    expect(created.number).toBe(2);
    expect(created.createdBy).toEqual({ kind: "teammate", id: cody.id });
    expect(created.assignee).toEqual({ kind: "teammate", id: ricky.id });
    expect(created.projectId).toBe(project.id);

    // A decision with assumptions and confidence.
    const decision = text(
      await client.callTool({
        name: "board_log_decision",
        arguments: {
          decision: "Treat VMS_MAIL as the only outbound path.",
          assumptions: ["No other SMTP node exists"],
          confidence: 0.7,
        },
      }),
    );
    expect(decision.confidence).toBe(0.7);
    expect(decision.runId).toBe(runId);
    const decisions = (await api.get(`${base}/tasks/${task.id}/decisions`)).body;
    expect(decisions).toHaveLength(1);

    // Block on Ricky, then hand over to review.
    const blocked = text(
      await client.callTool({
        name: "board_set_blocker",
        arguments: { reason: "Need the credential list from Ricky.", waitingOnHandle: "ricky" },
      }),
    );
    expect(blocked.status).toBe("blocked");
    expect(blocked.blocker.code).toBe("waiting_on_teammate");
    expect(blocked.blocker.waitingOn.name).toBe("ricky");

    const reviewed = text(
      await client.callTool({
        name: "board_request_review",
        arguments: { note: "Diagram and notes are written." },
      }),
    );
    expect(reviewed.status).toBe("review");

    // Only the assignee can request review of a task.
    const notMine = await client.callTool({ name: "board_request_review", arguments: { task: "#2" } });
    expect(notMine.isError).toBe(true);
    expect(text(notMine)).toMatch(/only the assignee/);

    // The secret guard applies to tool input.
    const leaky = await client.callTool({
      name: "board_post_message",
      arguments: { body: "ghp_0123456789abcdefghijklmnopqrstuvwxyz" },
    });
    expect(leaky.isError).toBe(true);

    const events = (await api.get(`${base}/events`)).body.map((e: any) => e.type);
    for (const t of ["message.posted", "task.created", "decision.logged", "task.blocked", "task.moved"])
      expect(events).toContain(t);
    await client.close();
  });

  it("refuses tokens that are not run-scoped", async () => {
    const { api, base } = await seedCompany(board, "mcp2@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const plain = (await api.post(`${base}/teammates/${cody.id}/tokens`, {})).body.token as string;
    const client = new Client({ name: "test", version: "0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/api/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${plain}` } },
    });
    await expect(client.connect(transport)).rejects.toThrow(/run-scoped teammate tokens/);
    const anon = new Client({ name: "test", version: "0" });
    await expect(
      anon.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/api/mcp`))),
    ).rejects.toThrow(/sign in required/);
  });

  it("a token minted with the manager scope reaches the server outside a run and names the task", async () => {
    const { api, base } = await seedCompany(board, "mcp4@example.com");
    const peter = await seatedPeter(api, base);
    const cody = await addTeammate(api, base, "Cody");
    const project = await addProject(api, base, "Digest");
    const task = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "First",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    const minted = (
      await api.post(`${base}/teammates/${peter.id}/tokens`, {
        scope: "manager",
        label: "Peter from a laptop",
      })
    ).body;
    const client = await connect(minted.token);
    // No run, so no default task: every call names one.
    const noTask = await client.callTool({ name: "board_read_task", arguments: {} });
    expect(noTask.isError).toBe(true);
    expect(text(noTask)).toMatch(/say which task/);
    const read = text(
      await client.callTool({ name: "board_read_task", arguments: { task: `#${task.number}` } }),
    );
    expect(read.id).toBe(task.id);
    // Creating a task names the project; the task is Peter's, in that project, with no parent.
    const noProject = await client.callTool({ name: "board_create_task", arguments: { title: "Where?" } });
    expect(text(noProject)).toMatch(/say which project/);
    const created = text(
      await client.callTool({
        name: "board_create_task",
        arguments: {
          title: "Second",
          project: "digest",
          assigneeHandle: "@cody",
          dependsOnTask: `#${task.number}`,
        },
      }),
    );
    expect(created).toMatchObject({
      projectId: project.id,
      parentTaskId: null,
      createdBy: { kind: "teammate", id: peter.id },
      assignee: { kind: "teammate", id: cody.id },
      dependsOn: [task.id],
    });
    // A message or a decision outside a run carries no run; the toolbox is read for the named task.
    const posted = text(
      await client.callTool({
        name: "board_post_message",
        arguments: { task: `#${task.number}`, body: "Start with the intake workflow." },
      }),
    );
    const messageRow = (
      await board.db.query<{ run_id: string | null }>("SELECT run_id FROM messages WHERE id = $1", [
        posted.id,
      ])
    ).rows[0]!;
    expect(messageRow.run_id).toBeNull();
    const decided = text(
      await client.callTool({
        name: "board_log_decision",
        arguments: { task: `#${task.number}`, decision: "Intake first.", confidence: 0.9 },
      }),
    );
    expect(decided.runId).toBeNull();
    expect(
      text(await client.callTool({ name: "board_list_tools", arguments: { task: `#${task.number}` } })),
    ).toEqual([]);
    const noTaskTools = await client.callTool({ name: "board_list_tools", arguments: {} });
    expect(noTaskTools.isError).toBe(true);
    // The mint said so, and the token is Peter's on the REST API too.
    const minting = (await api.get(`${base}/events`)).body.find(
      (e: any) => e.type === "teammate.token_minted",
    );
    expect(minting.payload).toMatchObject({ scope: "manager", label: "Peter from a laptop" });
    const me = await board.api(minted.token).get("/api/auth/me");
    expect(me.status).toBe(200);
    await client.close();
  });

  it("a follow-up filed into another project keeps its department's sandbox, pool and write policy", async () => {
    const { api, base } = await seedCompany(board, "mcp5@example.com");
    const cody = await addTeammate(api, base, "Cody");
    await addTeammate(api, base, "Ricky");
    const own = await addProject(api, base, "Intake");
    const other = await addProject(api, base, "Outbound");
    const secure = (
      await api.post(`${base}/departments`, {
        name: "Secure engineering",
        writePolicy: "drafts",
        memberTeammateIds: [cody.id],
        sandbox: { pool: "secure", allowedTools: ["Read(./**)"], timeoutSeconds: 900 },
      })
    ).body;
    const open = (await api.post(`${base}/departments`, { name: "Open lab", writePolicy: "ask" })).body;
    const task = (
      await api.post(`${base}/tasks`, {
        projectId: own.id,
        title: "Map the intake",
        departmentId: secure.id,
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    const { token } = await claimedToken(api, base, task.id);
    const client = await connect(token);
    const created = text(
      await client.callTool({
        name: "board_create_task",
        arguments: { title: "Map the outbound mail", project: "Outbound", assigneeHandle: "@ricky" },
      }),
    );
    expect(created).toMatchObject({ projectId: other.id, departmentId: secure.id, parentTaskId: task.id });
    expect(created.startedRunId).toBeTruthy();
    // Its run queues on the department's pool and carries the department's sandbox and write policy.
    const queued = (
      await board.db.query<{ queue_name: string }>("SELECT queue_name FROM runs WHERE id = $1", [
        created.startedRunId,
      ])
    ).rows[0]!;
    expect(queued.queue_name).toBe("runs.secure");
    const { spec } = await workerClaim(board, created.startedRunId);
    expect(spec.sandbox).toEqual({ allowedTools: ["Read(./**)"], envNames: null, timeoutSeconds: 900 });
    expect(spec.department).toEqual({ name: "Secure engineering", writePolicy: "drafts" });

    // The REST API is no side door: the run's token files a follow-up in the run's task's department and
    // cannot name another, or none, on create or on a change.
    const rest = board.api(token);
    const filed = await rest.post(`${base}/tasks`, { projectId: other.id, title: "From REST" });
    expect(filed.status).toBe(201);
    expect(filed.body).toMatchObject({ departmentId: secure.id, parentTaskId: task.id });
    for (const departmentId of [open.id, null]) {
      const refused = await rest.post(`${base}/tasks`, { projectId: other.id, title: "Out", departmentId });
      expect(refused.status).toBe(403);
      expect(refused.body.error).toMatch(/stays in the department of the run's task/);
      expect((await rest.patch(`${base}/tasks/${created.id}`, { departmentId })).status).toBe(403);
    }
    expect((await rest.patch(`${base}/tasks/${created.id}`, { departmentId: secure.id })).status).toBe(200);
    // Outside a run a teammate names only a department it belongs to; a person names any.
    const plain = board.api((await api.post(`${base}/teammates/${cody.id}/tokens`, {})).body.token);
    const outside = await plain.post(`${base}/tasks`, {
      projectId: other.id,
      title: "Elsewhere",
      departmentId: open.id,
    });
    expect(outside.status).toBe(403);
    expect(outside.body.error).toMatch(/only into a department it belongs to/);
    const mine = await plain.post(`${base}/tasks`, {
      projectId: other.id,
      title: "Mine",
      departmentId: secure.id,
    });
    expect(mine.status).toBe(201);
    const byPerson = await api.post(`${base}/tasks`, {
      projectId: other.id,
      title: "Lab",
      departmentId: open.id,
    });
    expect(byPerson.body.departmentId).toBe(open.id);
    await client.close();
  });

  it("caps tasks teammates create per project per day", async () => {
    const { api, base } = await seedCompany(board, "mcp3@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const project = await addProject(api, base);
    const task = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "root",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    const { token } = await claimedToken(api, base, task.id);
    const client = await connect(token);
    let refused = 0;
    for (let i = 0; i < 26; i++) {
      const r = await client.callTool({ name: "board_create_task", arguments: { title: `follow-up ${i}` } });
      if (r.isError) refused += 1;
    }
    expect(refused).toBe(1);
    await client.close();
  });
});
