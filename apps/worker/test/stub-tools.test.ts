// The stub engine's [stub:tool] marker: one governed call through the run's
// board MCP server, with the run token as the bearer; a proposal or an answer
// ends up in the handover, and a write a person already decided is not
// proposed again. The board is a fake fetch answering JSON-RPC.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callBoardTool, decidedInPack, stubEngine, toolMarkerFromPack } from "../src/engines/stub.js";

const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
function fakeBoard(reply: { text: string; isError?: boolean }) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body));
    calls.push({ url, headers: init?.headers as Record<string, string>, body });
    if (body.method === "initialize")
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "rosterdock" } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: reply.text }], isError: reply.isError ?? false },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
});

/** The pack of a run restarted after a person decided a write, as the board renders its approvals. */
function withApprovals(outcome: string): string {
  return [
    "# Task",
    "",
    'Create the list. [stub:tool hubspot manage_crm_objects {"action":"create","objectType":"company"}]',
    "",
    "## Approvals on this task",
    "Writes to live systems you (or an earlier run) proposed. An approved write was executed by the board exactly as proposed: do not repeat it.",
    "- Search companies (hubspot · search_crm_objects): executed",
    `- Stub write: manage_crm_objects on hubspot (hubspot · manage_crm_objects): ${outcome}`,
    "",
    "## Expected outputs",
    "- notes.md",
    "",
    "## Sandbox",
    "",
  ].join("\n");
}

async function run(pack: string, mcp: { url: string; token: string } | null) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rosterdock-stub-"));
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  try {
    const result = await stubEngine.run({
      workdir: dir,
      pack,
      model: "stub",
      signal: new AbortController().signal,
      emit: (e) => events.push({ type: e.type, payload: e.payload ?? {} }),
      onUsage: () => {},
      env: {},
      allowedTools: null,
      mcp,
    });
    const handover = await readFile(path.join(dir, "handover-summary.md"), "utf8");
    return { result, handover, events };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("the stub engine's tool marker", () => {
  it("parses the marker with or without arguments", () => {
    expect(toolMarkerFromPack('x [stub:tool hubspot search_crm_objects {"objectType":"company"}] y')).toEqual(
      {
        connection: "hubspot",
        tool: "search_crm_objects",
        arguments: { objectType: "company" },
      },
    );
    expect(toolMarkerFromPack("[stub:tool n8n list_workflows]")).toEqual({
      connection: "n8n",
      tool: "list_workflows",
      arguments: {},
    });
    expect(toolMarkerFromPack("no marker")).toBeNull();
  });

  it("proposes a write through the board with the run token, and the handover says it waits", async () => {
    vi.stubGlobal(
      "fetch",
      fakeBoard({
        text: JSON.stringify({
          kind: "proposed",
          approvalId: "a1",
          status: "pending",
          message: "A person decides.",
        }),
      }),
    );
    const pack = `# Task\n\nCreate the list. [stub:tool hubspot manage_crm_objects {"action":"create","objectType":"company"}]\n\n## Expected outputs\n- notes.md\n\n## Sandbox\n`;
    const { result, handover, events } = await run(pack, {
      url: "http://board.test/api/mcp",
      token: "run-token-1",
    });
    expect(result.ok).toBe(true);
    expect(handover).toContain("Proposed hubspot · manage_crm_objects for approval; waiting on a person.");
    expect(calls.map((c) => c.body.method)).toEqual(["initialize", "tools/call"]);
    expect(calls[1]!.headers.authorization).toBe("Bearer run-token-1");
    expect(calls[1]!.body.params).toMatchObject({
      name: "board_tool_call",
      arguments: {
        connection: "hubspot",
        tool: "manage_crm_objects",
        arguments: { action: "create", objectType: "company" },
        title: "Stub write: manage_crm_objects on hubspot",
      },
    });
    expect(events.some((e) => e.type === "tool_result")).toBe(true);
  });

  it("a read's answer and a refusal both land in the handover; no MCP means the marker is ignored", async () => {
    vi.stubGlobal("fetch", fakeBoard({ text: JSON.stringify({ kind: "result", result: { total: 2 } }) }));
    const read = await run(
      "# T\n[stub:tool hubspot search_crm_objects]\n## Expected outputs\n\n## Sandbox\n",
      {
        url: "http://board.test/api/mcp",
        token: "t",
      },
    );
    expect(read.handover).toContain("Called hubspot · search_crm_objects; answer:");
    expect(read.handover).toContain('"total":2');
    vi.stubGlobal(
      "fetch",
      fakeBoard({ text: "hubspot is not in your toolbox; ask a person to grant it", isError: true }),
    );
    const refused = await run(
      "# T\n[stub:tool hubspot search_crm_objects]\n## Expected outputs\n\n## Sandbox\n",
      {
        url: "http://board.test/api/mcp",
        token: "t",
      },
    );
    expect(refused.handover).toContain(
      "The board refused hubspot · search_crm_objects: hubspot is not in your toolbox",
    );
    const direct = await callBoardTool(
      { url: "http://board.test/api/mcp", token: "t" },
      "board_list_tools",
      {},
    );
    expect(direct.isError).toBe(true);
    calls.length = 0;
    const none = await run(
      "# T\n[stub:tool hubspot search_crm_objects]\n## Expected outputs\n\n## Sandbox\n",
      null,
    );
    expect(none.handover).not.toContain("hubspot");
    expect(calls).toHaveLength(0);
  });

  it("the run restarted after a person decided does not propose the same write again", async () => {
    const mcp = { url: "http://board.test/api/mcp", token: "run-token-2" };
    vi.stubGlobal("fetch", fakeBoard({ text: JSON.stringify({ kind: "proposed", approvalId: "a2" }) }));
    const executed = await run(withApprovals('executed; answer: {"id":"list-212"}'), mcp);
    expect(executed.result.ok).toBe(true);
    expect(calls).toHaveLength(0);
    expect(executed.handover).toContain(
      "Already approved and executed: hubspot · manage_crm_objects; not proposed again.",
    );
    expect(executed.events.some((e) => e.type === "tool" && e.payload.name === "board_tool_call")).toBe(
      false,
    );
    // A rejected write is not proposed again as it was either: the pack says so.
    const rejected = await run(withApprovals("rejected: use the active list"), mcp);
    expect(calls).toHaveLength(0);
    expect(rejected.handover).toContain(
      "A person rejected hubspot · manage_crm_objects; not proposed again.",
    );
    // A send that failed is proposed again once fixed; a proposal still waiting is the same row on the board.
    const failed = await run(withApprovals("approved but the send failed: 503"), mcp);
    expect(calls.map((c) => c.body.method)).toEqual(["initialize", "tools/call"]);
    expect(failed.handover).toContain("Proposed hubspot · manage_crm_objects for approval");
    calls.length = 0;
    await run(withApprovals("waiting for a person"), mcp);
    expect(calls.map((c) => c.body.method)).toEqual(["initialize", "tools/call"]);
  });

  it("reads what became of the write from the pack's approvals, by connection and tool", () => {
    const decided = (outcome: string, tool = "manage_crm_objects") =>
      decidedInPack(withApprovals(outcome), "hubspot", tool);
    expect(decided('executed; answer: {"id":"list-212"}')).toBe("executed");
    expect(decided("approved")).toBe("executed");
    expect(decided("rejected: use the active list")).toBe("rejected");
    expect(decided("rejected")).toBe("rejected");
    expect(decided("approved but the send failed: 503")).toBeNull();
    expect(decided("waiting for a person")).toBeNull();
    expect(decided("superseded")).toBeNull();
    // Another tool's outcome on the same connection is not this write's.
    expect(decided("rejected", "create_list")).toBeNull();
    expect(
      decidedInPack("# Task\n[stub:tool hubspot manage_crm_objects]\n", "hubspot", "manage_crm_objects"),
    ).toBeNull();
  });
});
