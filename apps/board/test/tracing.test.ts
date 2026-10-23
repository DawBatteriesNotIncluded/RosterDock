// One trace per run: when a run ends the board posts its spans (the run, the
// queue wait, each step, each brokered tool call) to the OTLP collector with
// the run's uuid as the trace id. The collector is an injected fetch.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRootSpanId, spanIdFor, traceIdForRun } from "@rosterdock/shared";
import { callTool } from "../src/broker/broker.js";
import { fakeAnthropic } from "./anthropic-fake.js";
import { fakeMcp } from "./mcp-fake.js";
import {
  addProject,
  addTeammate,
  seatedPeter,
  seedCompany,
  startTestBoard,
  testEgress,
  workerClaim,
  workerComplete,
  type TestBoard,
} from "./helpers.js";

let board: TestBoard;
const posts: { url: string; headers: Record<string, string>; body: any }[] = [];
const anthropic = fakeAnthropic();
const mcp = fakeMcp();
const env: NodeJS.ProcessEnv = { HUBSPOT_MCP_TOKEN: "fixture-token-000000" };
const otlp = {
  endpoint: "https://otel.test/v1/traces",
  headers: { authorization: "Bearer collector-token-for-tests" },
  serviceName: "rosterdock-board",
};

beforeAll(async () => {
  board = await startTestBoard(
    { otlp, anthropicApiKey: "test-key-by-name", sharedEnvNames: ["HUBSPOT_MCP_TOKEN"] },
    {
      modelFetch: anthropic.fetch,
      mcpFetch: mcp.fetch,
      env,
      otlpFetch: async (url, init) => {
        posts.push({
          url: String(url),
          headers: Object.fromEntries(new Headers(init?.headers)),
          body: JSON.parse(String(init?.body)),
        });
        return new Response("{}", { status: 200 });
      },
    },
  );
});
afterAll(async () => {
  await board.destroy();
});

describe("traces per run", () => {
  it("posts the run's spans to the collector when the run ends", async () => {
    const { api, base, companyId } = await seedCompany(board, "tr1@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const project = await addProject(api, base);
    const task = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "trace me",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    const run = (await api.post(`${base}/tasks/${task.id}/runs`, {})).body;
    const claimed = await workerClaim(board, run.id);
    await claimed.api.post(`/api/worker/runs/${run.id}/events`, {
      events: [
        {
          type: "step",
          payload: { text: "preparing the workspace" },
          at: new Date(Date.now() - 5000).toISOString(),
        },
        { type: "stdout", payload: { text: "hello" } },
        { type: "step", payload: { text: "running stub" }, at: new Date(Date.now() - 3000).toISOString() },
      ],
    });
    await workerComplete(board, claimed.token, run.id, {
      status: "failed",
      error: "the engine failed",
      usage: { inputTokens: 900, outputTokens: 100 },
      durationMs: 5000,
    });
    // The tracer works off the bus; wait for the terminal event to arrive.
    const latest = (await api.get(`${base}/events?limit=1`)).body[0].seq;
    await board.bus.waitFor(companyId, latest);
    for (let i = 0; i < 50 && posts.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(posts).toHaveLength(1);
    const post = posts[0]!;
    expect(post.url).toBe("https://otel.test/v1/traces");
    expect(post.headers.authorization).toBe("Bearer collector-token-for-tests");
    const rs = post.body.resourceSpans[0];
    expect(rs.resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "rosterdock-board" } },
    ]);
    const spans = rs.scopeSpans[0].spans as any[];
    const traceId = traceIdForRun(run.id);
    expect(spans.every((s) => s.traceId === traceId)).toBe(true);
    const root = spans.find((s) => s.spanId === runRootSpanId(run.id));
    expect(root.name).toBe("run task");
    expect(root.kind).toBe(2);
    expect(root.parentSpanId).toBeUndefined();
    const attr = (k: string) => root.attributes.find((a: any) => a.key === k)?.value;
    expect(attr("rosterdock.run_id")).toEqual({ stringValue: run.id });
    expect(attr("rosterdock.task_number")).toEqual({ intValue: String(task.number) });
    expect(attr("rosterdock.teammate")).toEqual({ stringValue: "Cody" });
    expect(attr("rosterdock.engine")).toEqual({ stringValue: "claude_code" });
    expect(attr("rosterdock.status")).toEqual({ stringValue: "failed" });
    expect(attr("rosterdock.tokens.total")).toEqual({ intValue: "1000" });
    expect(attr("rosterdock.duration_ms")).toEqual({ intValue: "5000" });
    expect(root.status).toEqual({ code: 2, message: "the engine failed" });
    // The queue wait and the two steps hang off the root; stdout is not a span.
    const children = spans.filter((s) => s.parentSpanId === runRootSpanId(run.id));
    expect(children.map((s) => s.name).sort()).toEqual([
      "queued",
      "step: preparing the workspace",
      "step: running stub",
    ]);
    const step1 = spans.find((s) => s.spanId === spanIdFor(run.id, "step:0"));
    const step2 = spans.find((s) => s.spanId === spanIdFor(run.id, "step:1"));
    expect(step1.endTimeUnixNano).toBe(step2.startTimeUnixNano);
    expect(BigInt(step2.endTimeUnixNano) >= BigInt(step2.startTimeUnixNano)).toBe(true);
    expect(BigInt(root.endTimeUnixNano) >= BigInt(root.startTimeUnixNano)).toBe(true);
    // Nothing that carries a value: no pack, no summary, no environment.
    const text = JSON.stringify(post.body);
    expect(text).not.toContain("collector-token");
  });

  it("traces Peter's model calls and a teammate's reads outside a run as one-span traces of their own", async () => {
    const { api, base, companyId } = await seedCompany(board, "tr2@example.com");
    await seatedPeter(api, base);
    const cody = await addTeammate(api, base, "Cody");
    await addTeammate(api, base, "Ricky", "researcher");
    posts.length = 0;
    // Peter plans by the model: one span with the purpose, the model, the tokens and how it ended.
    anthropic.queue.push("plan-questions.json");
    const goal = (await api.post(`${base}/goals`, { text: "Digest with the model." })).body;
    expect(goal.status).toBe("needs_you");
    for (let i = 0; i < 50 && posts.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    const planSpan = posts[0]!.body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(planSpan.name).toBe("peter.model plan");
    expect(planSpan.parentSpanId).toBeUndefined();
    const attr = (span: any, k: string) => span.attributes.find((a: any) => a.key === k)?.value;
    expect(attr(planSpan, "rosterdock.goal_id")).toEqual({ stringValue: goal.id });
    expect(attr(planSpan, "rosterdock.company_id")).toEqual({ stringValue: companyId });
    expect(attr(planSpan, "rosterdock.model")).toEqual({ stringValue: "claude-opus-5" });
    expect(attr(planSpan, "rosterdock.outcome")).toEqual({ stringValue: "output" });
    expect(attr(planSpan, "rosterdock.tokens.input")).toEqual({ intValue: "1420" });
    expect(attr(planSpan, "rosterdock.tokens.output")).toEqual({ intValue: "310" });
    expect(planSpan.status).toEqual({ code: 1 });
    // The prompt itself never travels.
    expect(JSON.stringify(posts[0]!.body)).not.toContain("Digest with the model");
    // A read through the broker with no run (a manager token) is a trace of its own; the same read in a run is not.
    const project = await addProject(api, base);
    const task = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "Warm accounts",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    expect(
      (
        await api.post(`${base}/connections`, {
          name: "hubspot",
          catalogId: "hubspot",
          url: "https://mcp.hubspot.test/mcp",
          authEnvName: "HUBSPOT_MCP_TOKEN",
        })
      ).status,
    ).toBe(201);
    await api.patch(`${base}/teammates/${cody.id}`, { toolbox: [{ connection: "hubspot", mode: "read" }] });
    const recorded: any[] = [];
    const tracer = { post: async (spans: any[]) => void recorded.push(...spans) };
    const actor = {
      companyId,
      teammateId: cody.id,
      teammateName: "Cody",
      runId: null,
      taskId: task.id,
    };
    const deps = { db: board.db, mcp: { egress: testEgress(mcp.fetch), env }, tracer };
    const read = await callTool(deps, actor, {
      connection: "hubspot",
      tool: "search_crm_objects",
      arguments: {},
    });
    expect(read.kind).toBe("result");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      name: "tool hubspot.search_crm_objects",
      kind: 3,
      attributes: {
        "rosterdock.company_id": companyId,
        "rosterdock.teammate": "Cody",
        "rosterdock.task_number": task.number,
        "rosterdock.outside_run": true,
        "rosterdock.ok": true,
      },
      status: { code: 1 },
    });
    expect(recorded[0].traceId).toMatch(/^[0-9a-f]{32}$/);
    // The same read from a run is left to the run's trace.
    const run = (await api.post(`${base}/tasks/${task.id}/runs`, {})).body;
    await callTool(
      deps,
      { ...actor, runId: run.id },
      { connection: "hubspot", tool: "search_crm_objects", arguments: {} },
    );
    expect(recorded).toHaveLength(1);
  });
});
