import { describe, expect, it } from "vitest";
import { BLOCKED_FILE, HANDOVER_FILE, renderRunPack, runSpecHash, type RunSpec } from "../src/runs/pack.js";

const spec: RunSpec = {
  version: 1,
  runId: "00000000-0000-4000-8000-000000000001",
  attempt: 1,
  companyId: "00000000-0000-4000-8000-000000000002",
  companyName: "GTM Studio",
  task: {
    id: "00000000-0000-4000-8000-000000000003",
    number: 142,
    title: "Map VMS sub-workflow calls",
    description: "Every Execute Workflow node reachable from the intake workflow.",
    declaredOutputs: ["vms-architecture.md", "handover.md"],
    criteria: [{ text: "Every node in the diagram has a note", weight: 2 }],
    workKind: "build",
  },
  project: {
    id: "p",
    name: "VMS architecture map",
    client: "Globex",
    goal: "",
    repoUrl: null,
    defaultBranch: "main",
  },
  teammate: {
    id: "t",
    name: "Cody",
    handle: "cody",
    role: "n8n engineer",
    personaMd: "You are a senior n8n automation engineer.",
    playbooks: ["Reference credentials by name only."],
    engine: "claude_code",
    model: "claude-sonnet-5",
  },
  department: { name: "Engineering", writePolicy: "drafts" },
  conversation: [
    {
      author: "Peter",
      body: "Scope: every node reachable from the intake workflow.",
      at: "2026-09-12T04:00:00.000Z",
    },
  ],
  dependencies: [{ number: 139, title: "Outbound-mail credential map", status: "done" }],
  note: null,
  turn: null,
  previousAttempt: null,
  sandbox: { allowedTools: ["Read(./**)", "Write(./**)"], envNames: ["N8N_API_KEY"], timeoutSeconds: 1800 },
  limits: { artifactBytes: 512 * 1024 },
  inbox: [],
  checkpoint: null,
  review: null,
  approvals: [],
  tools: [],
};

describe("run pack", () => {
  it("renders every section a teammate needs, names only", () => {
    const md = renderRunPack(spec);
    expect(md).toContain("# Map VMS sub-workflow calls");
    expect(md).toContain("You are Cody (@cody), n8n engineer at GTM Studio.");
    expect(md).toContain("senior n8n automation engineer");
    expect(md).toContain("## Playbooks");
    expect(md).toContain("Department: Engineering. Policy: Drafts are fine");
    expect(md).toContain("- #139 Outbound-mail credential map (done)");
    expect(md).toContain("- Peter (2026-09-12T04:00:00.000Z): Scope:");
    expect(md).toContain("- vms-architecture.md");
    expect(md).toContain("## Acceptance criteria");
    expect(md).toContain("- Every node in the diagram has a note (2)");
    expect(md).toContain(HANDOVER_FILE);
    expect(md).toContain(BLOCKED_FILE);
    expect(md).toContain("You cannot mark your own task Done");
    expect(md).toContain("No repository. Your working directory starts empty");
    expect(md).toContain("## Sandbox");
    expect(md).toContain("Time limit: 30 minutes.");
    expect(md).toContain("Largest output the board keeps: 512 KB per file");
    expect(md).toContain("Tools available: Read(./**), Write(./**).");
    expect(md).toContain("Environment variables visible to you, by name: N8N_API_KEY.");
    expect(md).toContain(`spec sha256 ${runSpecHash(spec)}`);
  });

  it("describes the previous attempt and checkpoint on a resumed run", () => {
    const md = renderRunPack({
      ...spec,
      attempt: 2,
      previousAttempt: { error: "worker stopped heartbeating", summary: null },
      checkpoint: { filesWritten: ["vms-architecture.md"] },
    });
    expect(md).toContain("(attempt 2)");
    expect(md).toContain("## Previous attempt");
    expect(md).toContain("Error: worker stopped heartbeating");
    expect(md).toContain('"filesWritten"');
  });

  it("tells a researcher to cite sources, and a reviewer of research to use the checklist", () => {
    const research = renderRunPack({ ...spec, task: { ...spec.task, workKind: "research" } });
    expect(research).toContain("## Research");
    expect(research).toContain("End every document with a Sources section");
    expect(renderRunPack(spec)).not.toContain("## Research");
    const review = renderRunPack({
      ...spec,
      task: { ...spec.task, workKind: "research" },
      review: {
        id: "r",
        round: 1,
        status: "open",
        authorName: "Ricky",
        reviewerName: "Verifier",
        summary: null,
        files: [{ path: "research.md", status: "added", additions: 12, deletions: 0 }],
        comments: [],
        checks: [{ kind: "sources", ok: true, title: "The document cites sources" }],
        diff: "diff --git a/research.md b/research.md\n",
        diffTruncated: false,
      },
    });
    expect(review).toContain("This is a research review");
    expect(review).toContain("Research checklist:");
    expect(review).toContain("cites a source in a Sources section");
    expect(review).not.toContain("## Research\n");
  });

  it("tells an author sent back on a repository to edit the round's work, which the worker applies", () => {
    const sentBack: RunSpec = {
      ...spec,
      project: { ...spec.project, repoUrl: "https://github.com/acme/rosterdock.git" },
      review: {
        id: "r",
        round: 2,
        status: "changes_requested",
        authorName: "Wren",
        reviewerName: "Edie",
        summary: "Three fixes to the outline.",
        files: [{ path: "README.md", status: "modified", additions: 40, deletions: 12 }],
        comments: [],
        checks: [],
        diff: null,
        diffTruncated: false,
      },
      rework: {
        round: 2,
        diffSha256: "a".repeat(64),
        baseSha: null,
        diff: "diff --git a/README.md b/README.md\n",
      },
    };
    const md = renderRunPack(sentBack);
    expect(md).toContain("## Changes requested (review round 2)");
    expect(md).toContain(
      "Your working directory starts from round 2: its changes are applied to a fresh clone of main, uncommitted, so `git status` and `git diff` show them. Edit that work to address the comments; do not start over.",
    );
    expect(md).toContain("If main moved and round 2's changes no longer apply");
    expect(md).not.toContain("diff --git");
    expect(renderRunPack({ ...sentBack, rework: null })).not.toContain("Your working directory starts from");
  });

  it("hashes deterministically and changes with the spec", () => {
    expect(runSpecHash(spec)).toBe(runSpecHash({ ...spec }));
    expect(runSpecHash(spec)).not.toBe(runSpecHash({ ...spec, note: "hurry" }));
  });
});
