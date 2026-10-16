// Peter as architect: from a brief he proposes departments, teammates,
// toolboxes and policies as a draft; a person accepts it and the org is
// created; nobody is granted a tool. He audits a company for idle teammates,
// missing reviewers and leads, unseated teammates and wide sandboxes. Model
// against recorded responses, heuristic otherwise. No network.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeAnthropic } from "./anthropic-fake.js";
import {
  addProject,
  addTeammate,
  seatedPeter,
  seedCompany,
  startTestBoard,
  type TestBoard,
} from "./helpers.js";

let board: TestBoard;
let modelBoard: TestBoard;
const anthropic = fakeAnthropic();

beforeAll(async () => {
  board = await startTestBoard();
  modelBoard = await startTestBoard({ anthropicApiKey: "test-key-by-name" }, { modelFetch: anthropic.fetch });
});
afterAll(async () => {
  await board.destroy();
  await modelBoard.destroy();
});

describe("Peter as architect", () => {
  it("proposes a finance function from a brief as a draft, and accepting it creates the org", async () => {
    const { api, base } = await seedCompany(board, "a1@example.com");
    const peter = await seatedPeter(api, base);
    const res = await api.post(`${base}/drafts/org`, {
      brief: "I need a finance function that reconciles Xero weekly.",
    });
    expect(res.status).toBe(201);
    const draft = res.body;
    expect(draft.kind).toBe("org");
    expect(draft.status).toBe("proposed");
    expect(draft.planner).toBe("heuristic");
    expect(draft.createdBy).toEqual({ kind: "teammate", id: peter.id });
    expect(draft.proposal.departments).toHaveLength(1);
    const finance = draft.proposal.departments[0];
    expect(finance).toMatchObject({ name: "Finance", writePolicy: "ask", toolbox: ["xero"] });
    expect(finance.teammates.map((t: any) => [t.name, t.role, t.template, t.lead])).toEqual([
      ["Finn", "finance analyst", "Finn", true],
      ["Verifier", "reviewer", "Verifier", false],
    ]);
    // Nothing exists until a person accepts.
    expect((await api.get(`${base}/teammates`)).body).toHaveLength(1);
    expect((await api.get(`${base}/departments`)).body).toEqual([]);
    const accepted = await api.post(`${base}/drafts/${draft.id}/accept`, {});
    expect(accepted.status).toBe(200);
    expect(accepted.body.status).toBe("accepted");
    expect(accepted.body.outcome.departments.map((d: any) => d.name)).toEqual(["Finance"]);
    expect(accepted.body.outcome.teammates.map((t: any) => t.name)).toEqual(["Finn", "Verifier"]);
    const depts = (await api.get(`${base}/departments`)).body;
    expect(depts).toHaveLength(1);
    expect(depts[0].writePolicy).toBe("ask");
    expect(depts[0].members.map((m: any) => [m.name, m.isLead])).toEqual([
      ["Finn", true],
      ["Verifier", false],
    ]);
    const finn = (await api.get(`${base}/teammates`)).body.find((t: any) => t.name === "Finn");
    expect(finn.personaMd).toMatch(/finance analyst/);
    expect(finn.engine).toBe("claude_code");
    expect(finn.model).toBe("claude-opus-5-5");
    // Toolboxes are recommendations on the draft, not grants: the teammate carries no tool.
    expect(JSON.stringify(finn)).not.toContain("xero");
    const events = (await api.get(`${base}/events`)).body.map((e: any) => e.type);
    expect(events).toContain("draft.proposed");
    expect(events).toContain("draft.accepted");
    expect(events.filter((t: string) => t === "teammate.created")).toHaveLength(3);
    // Once decided, a draft stays decided.
    expect((await api.post(`${base}/drafts/${draft.id}/accept`, {})).status).toBe(409);
    expect((await api.post(`${base}/drafts/${draft.id}/reject`, {})).status).toBe(409);
    expect((await api.get(`${base}/drafts`)).body).toHaveLength(1);
  });

  it("skips departments that exist, numbers taken names, refuses a stale draft, and viewers may not decide", async () => {
    const { api, base } = await seedCompany(board, "a2@example.com");
    await addTeammate(api, base, "Cody");
    await api.post(`${base}/departments`, { name: "Research" });
    const res = await api.post(`${base}/drafts/org`, {
      brief: "Research the market and build the n8n integration.",
    });
    const draft = res.body;
    expect(draft.proposal.departments.map((d: any) => d.name)).toEqual(["Engineering"]);
    const eng = draft.proposal.departments[0];
    expect(eng.teammates.map((t: any) => t.name)).toEqual(["Archy", "Cody 2", "Verifier"]);
    expect(eng.writePolicy).toBe("drafts");
    // Meanwhile someone hires Cody 2 by hand: the draft no longer fits.
    await addTeammate(api, base, "Cody 2");
    const stale = await api.post(`${base}/drafts/${draft.id}/accept`, {});
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/"Cody 2" is already taken/);
    expect((await api.post(`${base}/drafts/${draft.id}/reject`, {})).body.status).toBe("rejected");
    // A viewer neither asks nor decides.
    await api.post(`${base}/members`, { email: "viewer-a2@example.com", role: "viewer" });
    const viewer = board.api((await board.login("viewer-a2@example.com")).token);
    expect((await viewer.post(`${base}/drafts/org`, { brief: "x" })).status).toBe(403);
    expect((await viewer.get(`${base}/drafts`)).status).toBe(200);
    // A brief nothing matches gets the default pair.
    const dflt = (await api.post(`${base}/drafts/org`, { brief: "Make us better." })).body;
    expect(dflt.proposal.departments.map((d: any) => d.name)).toEqual(["Engineering"]);
    expect(dflt.proposal.summary).toContain("nothing is granted");
  });

  it("audits the company: idle and unseated teammates, no reviewer, no lead, a sandbox wider than its policy", async () => {
    const { api, base } = await seedCompany(board, "a3@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const ricky = await addTeammate(api, base, "Ricky", "researcher");
    const finn = await addTeammate(api, base, "Finn", "finance analyst");
    const eng = (await api.post(`${base}/departments`, { name: "Engineering", memberTeammateIds: [cody.id] }))
      .body;
    const research = (
      await api.post(`${base}/departments`, {
        name: "Research",
        writePolicy: "readonly",
        leadTeammateId: ricky.id,
        sandbox: { allowedTools: ["Read(./**)", "Write(./**)", "Bash(*)"] },
      })
    ).body;
    // Cody is busy; Ricky and Finn are idle.
    const project = await addProject(api, base);
    await api.post(`${base}/tasks`, {
      projectId: project.id,
      title: "x",
      assignee: { kind: "teammate", id: cody.id },
    });
    const res = await api.post(`${base}/drafts/audit`, {});
    expect(res.status).toBe(201);
    const audit = res.body;
    expect(audit.kind).toBe("audit");
    const kinds = audit.proposal.findings.map((f: any) => [f.kind, f.subject?.name]);
    expect(kinds).toEqual(
      expect.arrayContaining([
        ["idle_teammate", "Ricky"],
        ["idle_teammate", "Finn"],
        ["unseated", "Finn"],
        ["no_lead", "Engineering"],
        ["no_reviewer", "Engineering"],
        ["no_reviewer", "Research"],
        ["wide_sandbox", "Research"],
      ]),
    );
    expect(kinds).not.toContainEqual(["idle_teammate", "Cody"]);
    expect(kinds).not.toContainEqual(["idle_teammate", "Peter"]);
    expect(kinds).not.toContainEqual(["unseated", "Cody"]);
    const wide = audit.proposal.findings.find((f: any) => f.kind === "wide_sandbox");
    expect(wide.text).toContain("allows Bash(*)");
    expect(wide.text).not.toContain("Write");
    expect(audit.proposal.summary).toMatch(/^7 things to look at/);
    // Accepting an audit acknowledges it and creates nothing.
    const before = (await api.get(`${base}/teammates`)).body.length;
    expect((await api.post(`${base}/drafts/${audit.id}/accept`, {})).body.status).toBe("accepted");
    expect((await api.get(`${base}/teammates`)).body).toHaveLength(before);
    void eng;
    void research;
    void finn;
  });

  it("proposes with the model against a recorded response, and falls back when the proposal does not fit", async () => {
    const { api, base } = await seedCompany(modelBoard, "a4@example.com");
    anthropic.queue.push("org-proposal.json");
    const res = await api.post(`${base}/drafts/org`, {
      brief: "Staff a research agency for client Globex.",
    });
    expect(res.status).toBe(201);
    expect(res.body.planner).toBe("model:claude-opus-5");
    expect(res.body.proposal.departments.map((d: any) => d.name)).toEqual(["Research agency"]);
    expect(res.body.usage).toEqual({ inputTokens: 2100, outputTokens: 700, calls: 1 });
    const req = anthropic.requests.at(-1)!;
    expect(req.body.system).toContain("Global templates:");
    expect(req.body.system).toContain("- Ricky: researcher");
    expect(req.body.messages[0]!.content).toContain("Staff a research agency");
    const accepted = (await api.post(`${base}/drafts/${res.body.id}/accept`, {})).body;
    expect(accepted.outcome.teammates.map((t: any) => t.name)).toEqual([
      "Ricky",
      "Brody",
      "Archy",
      "Verifier",
    ]);
    const archy = (await api.get(`${base}/teammates`)).body.find((t: any) => t.name === "Archy");
    expect(archy.personaMd).toContain("diagrams and notes");
    // The same proposal again names taken teammates: refused, heuristic instead.
    anthropic.queue.push("org-proposal.json");
    const again = (await api.post(`${base}/drafts/org`, { brief: "Another research agency." })).body;
    expect(again.planner).toMatch(
      /^heuristic \(the model's proposal was refused: department "Research agency" already exists/,
    );
  });
});
