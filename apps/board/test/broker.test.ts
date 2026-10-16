// The broker: every external tool call from a run goes through the board.
// Reads run and are recorded; writes become approvals a person decides; policy
// only narrows (toolbox, then the department, then the client); an approved
// write reaches the connection as exactly the bytes approved. The connection is
// a fake MCP server replaying recorded JSON-RPC; no network.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeMcp } from "./mcp-fake.js";
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
let baseUrl: string;
const mcp = fakeMcp();
const env: NodeJS.ProcessEnv = { HUBSPOT_MCP_TOKEN: "fixture-token-000000" };

beforeAll(async () => {
  board = await startTestBoard({ sharedEnvNames: ["HUBSPOT_MCP_TOKEN"] }, { mcpFetch: mcp.fetch, env });
  baseUrl = await board.app.listen({ host: "127.0.0.1", port: 0 });
});
afterAll(async () => {
  await board.destroy();
});

async function connect(token: string) {
  const client = new Client({ name: "test", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/api/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): { value: any; isError: boolean } {
  const content = (result.content as { type: string; text?: string }[])[0];
  const t = content?.text ?? "";
  try {
    return { value: JSON.parse(t), isError: !!result.isError };
  } catch {
    return { value: t, isError: !!result.isError };
  }
}

/** A company with a discovered HubSpot connection and Cody holding it at the given mode. */
async function setup(
  api: Api,
  base: string,
  mode: "off" | "read" | "ask",
  opts: { writePolicy?: string; clientPolicy?: unknown } = {},
) {
  const hubspot = (
    await api.post(`${base}/connections`, {
      name: "hubspot",
      catalogId: "hubspot",
      url: "https://mcp.hubspot.test/mcp",
      authEnvName: "HUBSPOT_MCP_TOKEN",
    })
  ).body;
  await api.post(`${base}/connections/${hubspot.id}/discover`, {});
  const cody = await addTeammate(api, base, "Cody");
  if (mode !== "off")
    await api.patch(`${base}/teammates/${cody.id}`, { toolbox: [{ connection: "hubspot", mode }] });
  const dept = opts.writePolicy
    ? (
        await api.post(`${base}/departments`, {
          name: "Research",
          writePolicy: opts.writePolicy,
          memberTeammateIds: [cody.id],
        })
      ).body
    : null;
  const project = await addProject(api, base);
  if (opts.clientPolicy)
    await api.patch(`${base}/projects/${project.id}`, { clientPolicy: opts.clientPolicy });
  const task = (
    await api.post(`${base}/tasks`, {
      projectId: project.id,
      title: "Q3 warm accounts list",
      description: "Build the list in HubSpot.",
      assignee: { kind: "teammate", id: cody.id },
      departmentId: dept?.id ?? null,
    })
  ).body;
  const run = (await api.post(`${base}/tasks/${task.id}/runs`, {})).body;
  const claimed = await workerClaim(board, run.id);
  const client = await connect(claimed.token);
  return { hubspot, cody, project, task, run, claimed, client };
}

const write = {
  connection: "hubspot",
  tool: "manage_crm_objects",
  arguments: { action: "create", objectType: "company", properties: { name: "Q3 warm accounts" } },
  title: "Create the company list Q3 warm accounts in HubSpot",
  why: "The weekly summary needs a static list of the 212 engaging companies.",
};

describe("the tool broker", () => {
  it("a read runs at once with exactly the arguments given, is recorded, and the pack names the tools", async () => {
    const { api, base } = await seedCompany(board, "br1@example.com");
    const { client, claimed, task } = await setup(api, base, "read");
    expect(claimed.pack).toContain("## Your tools");
    expect(claimed.pack).toContain("- hubspot (read only)");
    expect(claimed.pack).toContain("reads: search_crm_objects, get_properties, whoami");
    expect(claimed.pack).toContain("writes (refused here): manage_crm_objects, run_report");
    expect(claimed.pack).toContain("board_tool_call");

    const listed = text(await client.callTool({ name: "board_list_tools", arguments: {} }));
    expect(listed.value).toHaveLength(1);
    expect(listed.value[0]).toMatchObject({
      connection: "hubspot",
      mode: "read",
      granted: "read",
      narrowed: null,
    });
    const verdicts = Object.fromEntries(listed.value[0].tools.map((t: any) => [t.name, t.verdict]));
    expect(verdicts).toEqual({
      search_crm_objects: "run",
      get_properties: "run",
      manage_crm_objects: "refuse",
      run_report: "refuse",
      whoami: "run",
    });

    mcp.calls.length = 0;
    const read = text(
      await client.callTool({
        name: "board_tool_call",
        arguments: {
          connection: "hubspot",
          tool: "search_crm_objects",
          arguments: { objectType: "company", query: "warm" },
        },
      }),
    );
    expect(read.isError).toBe(false);
    expect(read.value.kind).toBe("result");
    expect(read.value.result.total).toBe(2);
    expect(mcp.calls).toEqual([
      { name: "search_crm_objects", arguments: { objectType: "company", query: "warm" } },
    ]);
    const events = (await api.get(`${base}/events?limit=10`)).body as { type: string; payload: any }[];
    const called = events.find((e) => e.type === "tool.called");
    expect(called?.payload).toMatchObject({
      connection: "hubspot",
      tool: "search_crm_objects",
      ok: true,
      taskId: task.id,
      teammateName: "Cody",
      argumentKeys: ["objectType", "query"],
    });
    expect(JSON.stringify(events)).not.toContain("fixture-token");
    // A write under read is refused, and the connection never hears of it.
    const refused = text(await client.callTool({ name: "board_tool_call", arguments: write }));
    expect(refused.isError).toBe(true);
    expect(refused.value).toContain("writes to hubspot and your access here is read only");
    expect(mcp.calls).toHaveLength(1);
    // A tool that is not on the connection is refused too.
    const unknown = text(
      await client.callTool({
        name: "board_tool_call",
        arguments: { connection: "hubspot", tool: "delete_everything" },
      }),
    );
    expect(unknown.isError).toBe(true);
    expect(unknown.value).toContain("is not a tool on hubspot");
  });

  it("a write under ask becomes an approval; approve sends exactly the approved bytes and the teammate continues", async () => {
    const { api, base } = await seedCompany(board, "br2@example.com");
    const { client, claimed, task, run } = await setup(api, base, "ask");
    expect(claimed.pack).toContain("- hubspot (reads run, writes are proposed)");
    mcp.calls.length = 0;
    // No title: the broker asks for one, nothing is proposed.
    const bare = text(
      await client.callTool({
        name: "board_tool_call",
        arguments: { ...write, title: undefined, why: undefined },
      }),
    );
    expect(bare.isError).toBe(true);
    expect(bare.value).toContain("give a title");
    const proposed = text(await client.callTool({ name: "board_tool_call", arguments: write }));
    expect(proposed.isError).toBe(false);
    expect(proposed.value.kind).toBe("proposed");
    expect(proposed.value.message).toContain("A person decides");
    // Proposed twice: the same approval, and the teammate is told so.
    const again = text(await client.callTool({ name: "board_tool_call", arguments: write }));
    expect(again.value.approvalId).toBe(proposed.value.approvalId);
    expect(again.value.message).toContain("already proposed");
    expect(mcp.calls).toHaveLength(0);
    let t = (await api.get(`${base}/tasks/${task.id}`)).body;
    expect(t.status).toBe("blocked");
    expect(t.blocker.code).toBe("approval_required");
    await workerComplete(board, claimed.token, run.id, {
      status: "completed",
      summary: "Proposed the list.",
    });

    const pending = (await api.get(`${base}/approvals?status=pending`)).body;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      connection: "hubspot",
      tool: "manage_crm_objects",
      title: write.title,
      payload: write.arguments,
    });
    expect(pending[0].connectionId).toBeTruthy();
    const decided = await api.post(`${base}/approvals/${pending[0].id}/approve`, {});
    expect(decided.status).toBe(200);
    expect(decided.body.status).toBe("executed");
    expect(decided.body.result).toMatchObject({ id: "301" });
    expect(mcp.calls).toEqual([{ name: "manage_crm_objects", arguments: write.arguments }]);
    expect(mcp.requests.at(-1)?.headers.authorization).toBe("Bearer fixture-token-000000");
    t = (await api.get(`${base}/tasks/${task.id}`)).body;
    expect(t.status).toBe("doing");
    const next = await workerClaim(board, decided.body.restarted.runId);
    expect(next.pack).toContain(`${write.title} (hubspot · manage_crm_objects): executed`);
    expect(next.pack).toContain('"id":"301"');
  });

  it("policy only narrows: a readonly department caps ask at read; a client cap of off switches it off", async () => {
    const { api, base } = await seedCompany(board, "br3@example.com");
    const a = await setup(api, base, "ask", { writePolicy: "readonly" });
    expect(a.claimed.pack).toContain("- hubspot (read only; the Research department is read only)");
    const refused = text(await a.client.callTool({ name: "board_tool_call", arguments: write }));
    expect(refused.isError).toBe(true);
    expect(refused.value).toContain("the Research department is read only");
    const read = text(
      await a.client.callTool({
        name: "board_tool_call",
        arguments: { connection: "hubspot", tool: "get_properties", arguments: { objectType: "company" } },
      }),
    );
    expect(read.isError).toBe(false);

    const { api: api2, base: base2 } = await seedCompany(board, "br3b@example.com");
    const b = await setup(api2, base2, "ask", { clientPolicy: { default: null, caps: { hubspot: "off" } } });
    expect(b.claimed.pack).toContain("No live system is in your toolbox for this task");
    const listed = text(await b.client.callTool({ name: "board_list_tools", arguments: {} }));
    expect(listed.value[0]).toMatchObject({ mode: "off", granted: "ask" });
    expect(listed.value[0].narrowed).toContain("the client Globex allows no use of it");
    const off = text(
      await b.client.callTool({
        name: "board_tool_call",
        arguments: { connection: "hubspot", tool: "get_properties", arguments: {} },
      }),
    );
    expect(off.isError).toBe(true);
    expect(off.value).toContain("hubspot is off for this task");
  });

  it("a connection not in the toolbox, unknown, or switched off is refused before any call", async () => {
    const { api, base } = await seedCompany(board, "br4@example.com");
    const { client, hubspot } = await setup(api, base, "off");
    mcp.calls.length = 0;
    const notGranted = text(
      await client.callTool({
        name: "board_tool_call",
        arguments: { connection: "hubspot", tool: "get_properties" },
      }),
    );
    expect(notGranted.isError).toBe(true);
    expect(notGranted.value).toContain("hubspot is not in your toolbox");
    const nowhere = text(
      await client.callTool({
        name: "board_tool_call",
        arguments: { connection: "xero", tool: "list-invoices" },
      }),
    );
    expect(nowhere.value).toContain("no connection named xero");
    // Granted, but one tool switched off by a person: listed as refused, refused on the call, and a pack
    // from now on names it as off. The rest of the connection is untouched.
    const cody = (await api.get(`${base}/teammates`)).body.find(
      (t: { handle: string }) => t.handle === "cody",
    );
    await api.patch(`${base}/teammates/${cody.id}`, { toolbox: [{ connection: "hubspot", mode: "read" }] });
    await api.patch(`${base}/connections/${hubspot.id}`, {
      tools: [{ name: "get_properties", off: true }],
    });
    const listed = text(await client.callTool({ name: "board_list_tools", arguments: {} }));
    const byName = Object.fromEntries(listed.value[0].tools.map((t: any) => [t.name, t]));
    expect(byName.get_properties).toMatchObject({ off: true, verdict: "refuse" });
    expect(byName.search_crm_objects).toMatchObject({ off: false, verdict: "run" });
    const toolOff = text(
      await client.callTool({
        name: "board_tool_call",
        arguments: { connection: "hubspot", tool: "get_properties" },
      }),
    );
    expect(toolOff.isError).toBe(true);
    expect(toolOff.value).toContain("get_properties on hubspot is switched off by a person");
    expect(mcp.calls).toHaveLength(0);
    const other = (
      await api.post(`${base}/tasks`, {
        projectId: (await api.get(`${base}/projects`)).body[0].id,
        title: "Another list",
        description: "Read only.",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    const otherRun = (await api.post(`${base}/tasks/${other.id}/runs`, {})).body;
    const otherPack = (await workerClaim(board, otherRun.id)).pack;
    expect(otherPack).toContain("reads: search_crm_objects, whoami");
    expect(otherPack).toContain("switched off by a person, do not call: get_properties");
    // The whole connection switched off by a person.
    await api.patch(`${base}/connections/${hubspot.id}`, { enabled: false });
    const off = text(
      await client.callTool({
        name: "board_tool_call",
        arguments: { connection: "hubspot", tool: "get_properties" },
      }),
    );
    expect(off.value).toContain("switched off by a person");
    expect(mcp.calls).toHaveLength(0);
  });

  it("a toolbox may name only some of a connection's tools: the rest are unlisted, refused, and absent from the pack", async () => {
    const { api, base } = await seedCompany(board, "br4b@example.com");
    const { client, cody, hubspot } = await setup(api, base, "read");
    // A name the connection does not know is a typo, refused at save time.
    const typo = await api.patch(`${base}/teammates/${cody.id}`, {
      toolbox: [{ connection: "hubspot", mode: "read", tools: ["search_crm_objects", "nope"] }],
    });
    expect(typo.status).toBe(422);
    expect(typo.body.error).toContain("no tool named nope on hubspot");
    const saved = await api.patch(`${base}/teammates/${cody.id}`, {
      toolbox: [{ connection: "hubspot", mode: "read", tools: ["search_crm_objects"] }],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.toolbox).toEqual([
      { connection: "hubspot", mode: "read", tools: ["search_crm_objects"] },
    ]);
    // Listed: only the picked tool exists for this teammate.
    const listed = text(await client.callTool({ name: "board_list_tools", arguments: {} }));
    expect(listed.value[0].tools.map((t: any) => t.name)).toEqual(["search_crm_objects"]);
    // Called: an unpicked tool is refused before any call; the picked one runs.
    mcp.calls.length = 0;
    const refused = text(
      await client.callTool({
        name: "board_tool_call",
        arguments: { connection: "hubspot", tool: "get_properties" },
      }),
    );
    expect(refused.isError).toBe(true);
    expect(refused.value).toContain("get_properties on hubspot is not in your toolbox");
    expect(mcp.calls).toHaveLength(0);
    const ran = text(
      await client.callTool({
        name: "board_tool_call",
        arguments: { connection: "hubspot", tool: "search_crm_objects", arguments: { query: "acme" } },
      }),
    );
    expect(ran.isError).toBe(false);
    expect(mcp.calls).toHaveLength(1);
    // The pack of a later run names only the picked tool.
    const other = (
      await api.post(`${base}/tasks`, {
        projectId: (await api.get(`${base}/projects`)).body[0].id,
        title: "Picked tools only",
        description: "Read only.",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    const otherRun = (await api.post(`${base}/tasks/${other.id}/runs`, {})).body;
    const pack = (await workerClaim(board, otherRun.id)).pack;
    expect(pack).toContain("reads: search_crm_objects");
    expect(pack).not.toContain("whoami");
    // Back to the whole connection: no tools named, everything listed again.
    await api.patch(`${base}/teammates/${cody.id}`, { toolbox: [{ connection: "hubspot", mode: "read" }] });
    const all = text(await client.callTool({ name: "board_list_tools", arguments: {} }));
    expect(all.value[0].tools.length).toBeGreaterThan(1);
    expect(hubspot.name).toBe("hubspot");
  });

  it("an approved write whose connection was removed or refuses is recorded as failed, and nothing else is sent", async () => {
    const { api, base } = await seedCompany(board, "br5@example.com");
    const { client, claimed, run, hubspot } = await setup(api, base, "ask");
    await client.callTool({ name: "board_tool_call", arguments: write });
    // A credential value in a write's arguments never becomes a proposal.
    const leak = text(
      await client.callTool({
        name: "board_tool_call",
        arguments: {
          ...write,
          arguments: { ...write.arguments, apiKey: "sk-live-0123456789abcdefghijklmnop" },
        },
      }),
    );
    expect(leak.isError).toBe(true);
    expect(leak.value).toMatch(/secret/i);
    await workerComplete(board, claimed.token, run.id, { status: "completed" });
    const pending = (await api.get(`${base}/approvals?status=pending`)).body;
    // The connection cannot be removed while a proposal on it waits.
    expect((await api.del(`${base}/connections/${hubspot.id}`)).status).toBe(409);
    mcp.calls.length = 0;
    mcp.errorTools.add("manage_crm_objects");
    const failed = await api.post(`${base}/approvals/${pending[0].id}/approve`, {});
    mcp.errorTools.delete("manage_crm_objects");
    expect(failed.body.status).toBe("failed");
    expect(failed.body.error).toContain("unauthorized");
    expect(mcp.calls).toHaveLength(1);
  });

  it("an approved write on a tool a person switched off since it was proposed is not sent", async () => {
    const { api, base } = await seedCompany(board, "br6@example.com");
    const { client, claimed, run, hubspot } = await setup(api, base, "ask");
    await client.callTool({ name: "board_tool_call", arguments: write });
    await workerComplete(board, claimed.token, run.id, { status: "completed" });
    const pending = (await api.get(`${base}/approvals?status=pending`)).body;
    expect(pending).toHaveLength(1);
    await api.patch(`${base}/connections/${hubspot.id}`, {
      tools: [{ name: "manage_crm_objects", off: true }],
    });
    mcp.calls.length = 0;
    const failed = await api.post(`${base}/approvals/${pending[0].id}/approve`, {});
    expect(failed.body.status).toBe("failed");
    expect(failed.body.error).toContain("manage_crm_objects on hubspot is switched off by a person");
    expect(mcp.calls).toHaveLength(0);
  });
});
