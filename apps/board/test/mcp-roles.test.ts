// The role matrix reaches the board MCP server. POST /api/mcp names no company, so the route guard never
// sees a tool call; each tool asks `can` for its own action. Here the matrix is narrowed for teammates one
// action at a time, and every tool that needs it must refuse, through a real MCP client over HTTP.
import type * as Shared from "@rosterdock/shared";
import type { Action, Role } from "@rosterdock/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TOOL_ACTIONS, type BoardTool } from "../src/mcp/server.js";
import {
  addProject,
  addTeammate,
  seedCompany,
  startTestBoard,
  workerClaim,
  type TestBoard,
} from "./helpers.js";

// The actions taken away from the teammate role, for the test that is running.
const narrowed = vi.hoisted(() => new Set<string>());
vi.mock("@rosterdock/shared", async (importOriginal) => {
  const shared = await importOriginal<typeof Shared>();
  return {
    ...shared,
    can: (role: Role, action: Action) =>
      !(role === "teammate" && narrowed.has(action)) && shared.can(role, action),
  };
});

// Arguments each tool accepts, so the call reaches the tool and is not stopped by its input schema.
const ARGS: Record<BoardTool, Record<string, unknown>> = {
  board_read_task: {},
  board_read_output: { path: "notes.md" },
  board_list_my_tasks: {},
  board_post_message: { body: "Starting on the map." },
  board_create_task: { title: "List the credential names" },
  board_set_blocker: { reason: "Waiting on the credential list." },
  board_request_review: { note: "Ready." },
  board_log_decision: { decision: "Map the intake workflow first.", confidence: 0.7 },
  board_list_tools: {},
  board_tool_call: { connection: "n8n", tool: "list_workflows" },
  board_review_diff: {},
  board_review_comment: { file: "notes.md", hunk: 0, body: "Why this order?" },
  board_review_score: { scores: [{ criterion: 0, score: 1 }] },
  board_request_changes: { summary: "Again." },
  board_approve: { summary: "Good." },
};

let board: TestBoard;
let baseUrl: string;
beforeAll(async () => {
  board = await startTestBoard();
  baseUrl = await board.app.listen({ host: "127.0.0.1", port: 0 });
});
afterEach(() => narrowed.clear());
afterAll(async () => {
  await board.destroy();
});

async function asCody(email: string) {
  const { api, base, companyId } = await seedCompany(board, email);
  const cody = await addTeammate(api, base, "Cody");
  const project = await addProject(api, base);
  const task = (
    await api.post(`${base}/tasks`, {
      projectId: project.id,
      title: "Map VMS sub-workflow calls",
      assignee: { kind: "teammate", id: cody.id },
    })
  ).body;
  const run = (await api.post(`${base}/tasks/${task.id}/runs`, {})).body;
  const { token } = await workerClaim(board, run.id);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/api/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  const lastSeq = async () =>
    (
      await board.db.query<{ seq: number }>(
        "SELECT coalesce(max(seq), 0)::int AS seq FROM events WHERE company_id = $1",
        [companyId],
      )
    ).rows[0]!.seq;
  return { client, lastSeq };
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as { type: string; text?: string }[])[0]?.text ?? "";
}

describe("the board MCP server and the role matrix", () => {
  it("names an action for every tool it lists", async () => {
    const { client } = await asCody("mcp-roles1@example.com");
    const listed = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(listed).toEqual(Object.keys(TOOL_ACTIONS).sort());
    await client.close();
  });

  it("refuses every tool whose action the teammate role no longer holds, and writes nothing", async () => {
    const { client, lastSeq } = await asCody("mcp-roles2@example.com");
    const before = await lastSeq();
    for (const [name, action] of Object.entries(TOOL_ACTIONS) as [BoardTool, Action][]) {
      narrowed.clear();
      narrowed.add(action);
      const result = await client.callTool({ name, arguments: ARGS[name] });
      expect(result.isError, name).toBe(true);
      expect(textOf(result), name).toBe(`${name} is refused: teammates on this board may not ${action}`);
    }
    expect(await lastSeq()).toBe(before);

    // With the action back, the same call goes through.
    narrowed.clear();
    const posted = await client.callTool({ name: "board_post_message", arguments: ARGS.board_post_message });
    expect(posted.isError).toBeFalsy();
    expect(JSON.parse(textOf(posted)).body).toBe("Starting on the map.");
    expect(await lastSeq()).toBeGreaterThan(before);
    await client.close();
  });
});
