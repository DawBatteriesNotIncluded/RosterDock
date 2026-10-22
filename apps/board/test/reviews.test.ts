// The review object end to end: a completed run opens a review, the reviewer
// teammate gets a run and decides through the board tools, request changes
// restarts the author with the comments in the pack, approve is the only path
// to Done, humans veto. No model, no git host.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { renderBinaryFileDiff, renderNewFileDiff } from "@rosterdock/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GitHosts } from "../src/git/hosts.js";
import { needsYouText } from "../src/notify/notify.js";
import { executePullRequest } from "../src/reviews/outcomes.js";
import { approveReview, vetoReview } from "../src/reviews/service.js";
import { fakeGitHub } from "./github-fake.js";
import { fakeGitLab } from "./gitlab-fake.js";
import { addProject, addTeammate, seedCompany, startTestBoard, type Api, type TestBoard } from "./helpers.js";

let board: TestBoard;
let baseUrl: string;

const here = path.dirname(fileURLToPath(import.meta.url));
const shared = path.resolve(here, "../../../packages/shared/test/fixtures");
const DIFF = readFileSync(path.join(shared, "changes.diff"), "utf8");
// Without its binary logo.bin, which the review cannot show, so only a person approves it.
const TEXT_DIFF = DIFF.replace(/diff --git a\/logo\.bin[\s\S]*?(?=diff --git)/, "");
const BASE = JSON.parse(readFileSync(path.join(shared, "diff-base.json"), "utf8")) as Record<
  string,
  string | null
>;
const BASE_SHA = "0253df7ed00df5f84097e01499f26e4be2f011cf";
// Task #6 of the dogfood company, as its review recorded it: round 1, round 2, and the base both were taken against.
const ROUND_1 = readFileSync(path.join(shared, "rework/round-1.diff"), "utf8");
const ROUND_2 = readFileSync(path.join(shared, "rework/round-2.diff"), "utf8");
const ROUND_1_BASE = "80f18e27f280cbaa1a0be5dfdccce5b9a0e6e258";
const github = fakeGitHub(
  Object.fromEntries(Object.entries(BASE).filter(([, v]) => v !== null)) as Record<string, string>,
);
const gitlab = fakeGitLab(
  Object.fromEntries(Object.entries(BASE).filter(([, v]) => v !== null)) as Record<string, string>,
);

// The one research source the tests cite; everything else on the web is a 404.
const web: typeof fetch = async (input) =>
  String(input) === "https://gong.io/docs/calls"
    ? new Response(
        "<html><head><title>Calls API</title></head><body><p>GET /v2/calls lists calls.</p></body></html>",
        {
          status: 200,
          headers: { "content-type": "text/html" },
        },
      )
    : new Response("nope", { status: 404, headers: { "content-type": "text/plain" } });

beforeAll(async () => {
  board = await startTestBoard(
    { gitlabToken: "glpat-test" },
    { githubFetch: github.fetch, gitlabFetch: gitlab.fetch, webFetch: web },
  );
  baseUrl = await board.app.listen({ host: "127.0.0.1", port: 0 });
});
afterAll(async () => {
  await board.destroy();
});

async function claim(runId: string) {
  const job = (await board.db.query<{ job_id: string }>("SELECT job_id FROM runs WHERE id = $1", [runId]))
    .rows[0]!.job_id;
  const res = await board.app.inject({
    method: "POST",
    url: "/api/worker/claim",
    headers: { "x-rosterdock-worker-token": "test-worker-token" },
    payload: { runId, jobId: job, workerId: "w" },
  });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body) as {
    token: string;
    pack: string;
    run: { kind: string };
    spec: { rework?: unknown };
  };
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
  const t = (result.content as { text?: string }[])[0]?.text ?? "";
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

/** Run the assignee's task run to completion with a diff and an output. */
async function completeTaskRun(
  api: Api,
  base: string,
  taskId: string,
  diff: string,
  opts: { baseSha?: string; tests?: { kind: "tests"; ok: boolean; title: string } } = {},
) {
  const run = (await api.post(`${base}/tasks/${taskId}/runs`, {})).body;
  expect(run.status).toBe("queued");
  const { token } = await claim(run.id);
  const asRun = board.api(token);
  await asRun.post(`/api/worker/runs/${run.id}/artifacts`, {
    path: "vms-architecture.md",
    kind: "document",
    content: "# VMS workflow architecture\n",
  });
  await asRun.post(`/api/worker/runs/${run.id}/artifacts`, {
    path: "changes.diff",
    kind: "diff",
    content: diff,
  });
  // As the worker does right after cloning: the commit the run's changes stand on.
  if (opts.baseSha) await asRun.post(`/api/worker/runs/${run.id}/cloned`, { sha: opts.baseSha });
  const done = await asRun.post(`/api/worker/runs/${run.id}/complete`, {
    status: "completed",
    summary: "Mapped the workflow.",
    usage: { inputTokens: 1000, outputTokens: 100 },
    ...(opts.baseSha ? { baseSha: opts.baseSha } : {}),
    checks: [opts.tests ?? { kind: "tests", ok: true, title: "npm test passed", detail: "12 passing" }],
  });
  expect(done.status).toBe(200);
  return run.id as string;
}

async function liveRuns(api: Api, base: string) {
  return (await api.get(`${base}/runs?status=queued,running`)).body as {
    id: string;
    kind: string;
    teammateId: string;
  }[];
}

describe("reviews", () => {
  it("opens a review from the completed run's diff, with checks, and starts the reviewer teammate", async () => {
    const { api, base } = await seedCompany(board, "rv1@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const verifier = await addTeammate(api, base, "Verifier", "reviewer");
    const project = await addProject(api, base);
    const task = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "Map VMS sub-workflow calls",
        assignee: { kind: "teammate", id: cody.id },
        declaredOutputs: ["vms-architecture.md", "diagram.svg"],
        criteria: [
          { text: "Every node in the diagram has a note", weight: 2 },
          { text: "Credentials by name only", weight: 1 },
        ],
      })
    ).body;
    expect(task.criteria).toHaveLength(2);
    const runId = await completeTaskRun(api, base, task.id, TEXT_DIFF, { baseSha: "0".repeat(40) });

    expect((await api.get(`${base}/tasks/${task.id}`)).body.status).toBe("review");
    const review = (await api.get(`${base}/tasks/${task.id}/review`)).body;
    expect(review).toMatchObject({
      round: 1,
      status: "open",
      runId,
      baseSha: "0".repeat(40),
      author: { kind: "teammate", id: cody.id, name: "Cody" },
      reviewer: { kind: "teammate", id: verifier.id, name: "Verifier" },
      fileCount: 5,
      additions: 14,
      deletions: 6,
      openComments: 0,
      taskNumber: 1,
    });
    expect(review.files.map((f: any) => [f.path, f.status])).toContainEqual([
      "workflows/vms-digest.json",
      "modified",
    ]);
    const json = review.files.find((f: any) => f.path === "workflows/vms-digest.json");
    expect(json.hunks).toHaveLength(2);
    expect(json.hunks[0].lines.find((l: any) => l.kind === "del")).toMatchObject({ old: 4, new: null });
    const checks = Object.fromEntries(review.checks.map((c: any) => [c.kind, c]));
    expect(checks.secrets).toMatchObject({ ok: true, title: "No credential values in the diff" });
    expect(checks.outputs).toMatchObject({ ok: false, title: "Missing declared output: diagram.svg" });
    expect(checks.tests).toMatchObject({ ok: true, title: "npm test passed" });
    expect(checks.evaluation).toMatchObject({ ok: null, title: "2 criteria not scored yet" });
    expect(review.criteria).toHaveLength(2);

    // The review is in the queue, and the Verifier has a review run queued on the task.
    const queue = (await api.get(`${base}/reviews?status=open`)).body;
    expect(queue.map((r: any) => r.id)).toEqual([review.id]);
    const live = await liveRuns(api, base);
    expect(live.map((r) => [r.kind, r.teammateId])).toEqual([["review", verifier.id]]);
    expect((await api.get(`${base}/tasks/${task.id}`)).body.status).toBe("review");

    const types = (await api.get(`${base}/events`)).body.map((e: any) => e.type);
    expect(types).toContain("review.opened");
    const opened = (await api.get(`${base}/events`)).body.find((e: any) => e.type === "review.opened");
    expect(opened.subject).toEqual({ kind: "review", id: review.id });
    expect(opened.payload).toMatchObject({
      round: 1,
      files: 5,
      reviewer: { name: "Verifier" },
      authorName: "Cody",
    });
  });

  it("the reviewer reviews through the board tools: diff, anchored comments, scores, request changes, then approve", async () => {
    const { api, base } = await seedCompany(board, "rv2@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const verifier = await addTeammate(api, base, "Verifier", "reviewer");
    const project = await addProject(api, base);
    const task = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "Map VMS sub-workflow calls",
        assignee: { kind: "teammate", id: cody.id },
        declaredOutputs: ["vms-architecture.md"],
        criteria: [{ text: "Workflow imports as draft", weight: 1 }],
      })
    ).body;
    await completeTaskRun(api, base, task.id, TEXT_DIFF);
    const reviewId = (await api.get(`${base}/tasks/${task.id}/review`)).body.id as string;

    // The Verifier's review run: its pack carries the diff and the review tools.
    const [reviewRun] = await liveRuns(api, base);
    expect(reviewRun!.kind).toBe("review");
    const claimed = await claim(reviewRun!.id);
    expect(claimed.run.kind).toBe("review");
    expect(claimed.pack).toContain("## Your review");
    expect(claimed.pack).toContain("round 1 of Cody's work");
    expect(claimed.pack).toContain('+    "executionOrder": "v1",');
    expect(claimed.pack).toContain("board_request_changes");
    expect(claimed.pack).toContain("ok No credential values in the diff");
    const vclient = await connect(claimed.token);
    const tools = (await vclient.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(
      expect.arrayContaining([
        "board_review_diff",
        "board_review_comment",
        "board_review_score",
        "board_request_changes",
        "board_approve",
      ]),
    );

    const diff = text(
      await vclient.callTool({ name: "board_review_diff", arguments: { file: "workflows/vms-digest.json" } }),
    );
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0].hunks[0].lines).toContain('+    4     "executionOrder": "v1",');
    expect(diff.criteria).toHaveLength(1);

    // Comment on a line, on a hunk, and refuse bad anchors.
    const c1 = text(
      await vclient.callTool({
        name: "board_review_comment",
        arguments: {
          file: "workflows/vms-digest.json",
          hunk: 0,
          line: 6,
          body: 'Keep "active": false; activation is approval-gated.',
        },
      }),
    );
    expect(c1).toMatchObject({
      file: "workflows/vms-digest.json",
      hunk: 0,
      line: 6,
      resolved: false,
      author: { name: "Verifier" },
    });
    const c2 = text(
      await vclient.callTool({
        name: "board_review_comment",
        arguments: { file: "docs/old.md", hunk: 0, oldLine: 3, body: "Fine to remove." },
      }),
    );
    expect(c2.oldLine).toBe(3);
    const badLine = await vclient.callTool({
      name: "board_review_comment",
      arguments: { file: "workflows/vms-digest.json", hunk: 0, line: 99, body: "x" },
    });
    expect(badLine.isError).toBe(true);
    expect(text(badLine)).toMatch(/no new line 99/);
    const badFile = await vclient.callTool({
      name: "board_review_comment",
      arguments: { file: "nope.md", hunk: 0, body: "x" },
    });
    expect(text(badFile)).toMatch(/not in this review/);
    const badHunk = await vclient.callTool({
      name: "board_review_comment",
      arguments: { file: "docs/old.md", hunk: 4, body: "x" },
    });
    expect(text(badHunk)).toMatch(/no hunk 4/);

    // Scores become the evaluation check.
    const scored = text(
      await vclient.callTool({
        name: "board_review_score",
        arguments: { scores: [{ criterion: 0, score: 0.4, note: "imports active" }] },
      }),
    );
    expect(scored.checks.find((c: any) => c.kind === "evaluation")).toMatchObject({
      ok: false,
      title: "Evaluation 40% of weighted criteria",
    });
    const badScore = await vclient.callTool({
      name: "board_review_score",
      arguments: { scores: [{ criterion: 3, score: 1 }] },
    });
    expect(text(badScore)).toMatch(/no criterion 3/);

    // Request changes: the review waits and Cody is restarted with the comments in the pack.
    const sentBack = text(
      await vclient.callTool({
        name: "board_request_changes",
        arguments: { summary: "One fix: do not activate on import." },
      }),
    );
    expect(sentBack.status).toBe("changes_requested");
    expect(sentBack.restarted.runId).toBeTruthy();
    expect((await api.get(`${base}/tasks/${task.id}`)).body.status).toBe("doing");
    const codyRun = await claim(sentBack.restarted.runId);
    expect(codyRun.run.kind).toBe("task");
    expect(codyRun.pack).toContain("## Changes requested (review round 1)");
    expect(codyRun.pack).toContain("Verifier sent your work back");
    expect(codyRun.pack).toContain("> One fix: do not activate on import.");
    expect(codyRun.pack).toContain(
      'workflows/vms-digest.json @@ -1,7 +1,9 @@ line 6 · Verifier: Keep "active": false',
    );
    expect(codyRun.pack).not.toContain("## Your review");
    // No repository, nothing to apply: the working directory starts empty as on round 1.
    expect(codyRun.spec.rework).toBeNull();
    expect(codyRun.pack).not.toContain("Your working directory starts from round");
    // A second request on a waiting review is refused; the queue shows it as waiting.
    const again = await vclient.callTool({ name: "board_request_changes", arguments: {} });
    expect(text(again)).toMatch(/changes requested/);
    expect((await api.get(`${base}/reviews?status=changes_requested`)).body.map((r: any) => r.id)).toEqual([
      reviewId,
    ]);
    await vclient.close();
    // The Verifier's run ends once it has decided; a review run never moves the task.
    await board.api(claimed.token).post(`/api/worker/runs/${reviewRun!.id}/complete`, {
      status: "completed",
      summary: "Requested one change.",
    });
    expect((await api.get(`${base}/tasks/${task.id}`)).body.status).toBe("doing");

    // Cody's second run completes with a fixed diff: round 2, checks rerun, Verifier gets a new run.
    const fixed = TEXT_DIFF.replace('+    "active": false,\n', "");
    const asCody = board.api(codyRun.token);
    await asCody.post(`/api/worker/runs/${sentBack.restarted.runId}/artifacts`, {
      path: "changes.diff",
      kind: "diff",
      content: fixed,
    });
    await asCody.post(`/api/worker/runs/${sentBack.restarted.runId}/artifacts`, {
      path: "vms-architecture.md",
      kind: "document",
      content: "# VMS\n",
    });
    expect(
      (
        await asCody.post(`/api/worker/runs/${sentBack.restarted.runId}/complete`, {
          status: "completed",
          summary: "Fixed.",
        })
      ).status,
    ).toBe(200);
    const round2 = (await api.get(`${base}/reviews/${reviewId}`)).body;
    expect(round2).toMatchObject({
      round: 2,
      status: "open",
      runId: sentBack.restarted.runId,
      additions: 13,
      scores: null,
    });
    expect(round2.comments.map((c: any) => c.round)).toEqual([1, 1]);
    expect(round2.checks.find((c: any) => c.kind === "evaluation")).toMatchObject({ ok: null });
    expect(round2.decisions.map((d: any) => d.decision)).toEqual(["request_changes"]);
    const live2 = await liveRuns(api, base);
    expect(live2.filter((r) => r.kind === "review").map((r) => r.teammateId)).toEqual([verifier.id]);

    // The Verifier approves round 2 through the tools: Done, and only the review did it.
    const v2 = await claim(live2.find((r) => r.kind === "review")!.id);
    expect(v2.pack).toContain("round 2 of Cody's work");
    expect(v2.pack).toContain("Comments so far");
    expect(v2.pack).toContain("(round 1) · Verifier: Keep");
    const vclient2 = await connect(v2.token);
    text(
      await vclient2.callTool({
        name: "board_review_score",
        arguments: { scores: [{ criterion: 0, score: 1 }] },
      }),
    );
    const approved = text(
      await vclient2.callTool({
        name: "board_approve",
        arguments: { summary: "Draft imports inactive now." },
      }),
    );
    expect(approved).toMatchObject({ status: "approved", taskStatus: "done" });
    await vclient2.close();
    const t = (await api.get(`${base}/tasks/${task.id}`)).body;
    expect(t.status).toBe("done");
    expect(t.doneBy).toMatchObject({
      reviewId,
      round: 2,
      by: { kind: "teammate", id: verifier.id, name: "Verifier" },
    });
    const types = (await api.get(`${base}/events`)).body.map((e: any) => e.type);
    for (const ty of [
      "review.commented",
      "review.scored",
      "review.changes_requested",
      "review.approved",
      "task.done",
    ])
      expect(types).toContain(ty);
    // Done is final for moves and for further comments.
    expect((await api.post(`${base}/tasks/${task.id}/move`, { status: "doing" })).status).toBe(409);
    expect(
      (await api.post(`${base}/reviews/${reviewId}/comments`, { file: "docs/old.md", hunk: 0, body: "late" }))
        .status,
    ).toBe(409);
  });

  it("at the round cap a teammate reviewer's request for changes leaves the author waiting; a person's still restarts them", async () => {
    const { api, base } = await seedCompany(board, "rv-cap@example.com");
    const cody = await addTeammate(api, base, "Cody");
    await addTeammate(api, base, "Verifier", "reviewer");
    const project = await addProject(api, base);
    const newTask = async (title: string) =>
      (
        await api.post(`${base}/tasks`, {
          projectId: project.id,
          title,
          assignee: { kind: "teammate", id: cody.id },
          declaredOutputs: ["vms-architecture.md"],
        })
      ).body;
    const liveTaskRuns = async (taskId: string) =>
      (await api.get(`${base}/tasks/${taskId}/runs`)).body.filter(
        (r: any) => r.kind === "task" && ["queued", "running"].includes(r.status),
      );

    // The Verifier sends round 3 back: the author is not started again, and the tool says why.
    const task = await newTask("Map VMS sub-workflow calls");
    await completeTaskRun(api, base, task.id, DIFF);
    const reviewId = (await api.get(`${base}/tasks/${task.id}/review`)).body.id as string;
    await board.db.query("UPDATE reviews SET round = 3 WHERE id = $1", [reviewId]);
    const [reviewRun] = await liveRuns(api, base);
    const vclient = await connect((await claim(reviewRun!.id)).token);
    const sentBack = text(
      await vclient.callTool({ name: "board_request_changes", arguments: { summary: "Still not right." } }),
    );
    await vclient.close();
    expect(sentBack.status).toBe("changes_requested");
    expect(sentBack.restarted).toEqual({
      runId: null,
      reason: "the review has gone 3 rounds without approval; a person decides it now",
    });
    expect(await liveTaskRuns(task.id)).toEqual([]);

    // A person asking for a fourth round is deciding: Cody is started again.
    const other = await newTask("Map VMS sub-workflow calls, again");
    await completeTaskRun(api, base, other.id, DIFF);
    const otherReview = (await api.get(`${base}/tasks/${other.id}/review`)).body.id as string;
    await board.db.query("UPDATE reviews SET round = 3 WHERE id = $1", [otherReview]);
    const byPerson = await api.post(`${base}/reviews/${otherReview}/request-changes`, {
      summary: "One more pass.",
    });
    expect(byPerson.status).toBe(200);
    expect(byPerson.body.restarted.runId).toBeTruthy();
    expect(await liveTaskRuns(other.id)).toHaveLength(1);
  });

  it("the author never decides, only the assigned reviewer teammate does, and viewers cannot comment", async () => {
    const { api, base } = await seedCompany(board, "rv3@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const ricky = await addTeammate(api, base, "Ricky", "researcher");
    await addTeammate(api, base, "Verifier", "QA reviewer");
    const project = await addProject(api, base);
    const task = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "x",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    await completeTaskRun(api, base, task.id, DIFF);
    const review = (await api.get(`${base}/tasks/${task.id}/review`)).body;
    expect(review.reviewer.name).toBe("Verifier");

    // Cody (the author) on a new turn-like run: cannot approve their own work.
    const other = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "y",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    const codyRun = (await api.post(`${base}/tasks/${other.id}/runs`, {})).body;
    const codyClient = await connect((await claim(codyRun.id)).token);
    const own = await codyClient.callTool({ name: "board_approve", arguments: { task: "#1" } });
    expect(own.isError).toBe(true);
    expect(text(own)).toMatch(/author cannot decide/);
    // Cody may still comment on the review of their own task (a reply to the reviewer).
    const reply = text(
      await codyClient.callTool({
        name: "board_review_comment",
        arguments: { task: "#1", file: "docs/old.md", hunk: 0, body: "Agreed." },
      }),
    );
    expect(reply.author.name).toBe("Cody");
    await codyClient.close();

    // Ricky is a teammate but not the assigned reviewer.
    const rickyTask = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "z",
        assignee: { kind: "teammate", id: ricky.id },
      })
    ).body;
    const rickyRun = (await api.post(`${base}/tasks/${rickyTask.id}/runs`, {})).body;
    const rickyClient = await connect((await claim(rickyRun.id)).token);
    expect(text(await rickyClient.callTool({ name: "board_approve", arguments: { task: "#1" } }))).toMatch(
      /assigned reviewer/,
    );
    expect(
      text(await rickyClient.callTool({ name: "board_request_changes", arguments: { task: "#1" } })),
    ).toMatch(/assigned reviewer/);
    await rickyClient.close();

    // A viewer can read but not comment; a reviewer-role person can decide.
    await api.post(`${base}/members`, { email: "rv3-view@example.com", role: "viewer" });
    await api.post(`${base}/members`, { email: "rv3-rev@example.com", role: "reviewer" });
    const viewer = board.api((await board.login("rv3-view@example.com")).token);
    const reviewer = board.api((await board.login("rv3-rev@example.com")).token);
    expect((await viewer.get(`${base}/reviews/${review.id}`)).status).toBe(200);
    expect(
      (
        await viewer.post(`${base}/reviews/${review.id}/comments`, {
          file: "docs/old.md",
          hunk: 0,
          body: "x",
        })
      ).status,
    ).toBe(403);
    expect((await viewer.post(`${base}/reviews/${review.id}/approve`, {})).status).toBe(403);
    const approved = await reviewer.post(`${base}/reviews/${review.id}/approve`, { summary: "Looks right." });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("approved");
    expect((await api.get(`${base}/tasks/${task.id}`)).body.status).toBe("done");
    expect((await reviewer.post(`${base}/reviews/${review.id}/approve`, {})).status).toBe(409);
  });

  it("without a reviewer teammate the review waits for a person; approve marks Done and a veto undoes it", async () => {
    const { api, base } = await seedCompany(board, "rv4@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const project = await addProject(api, base);
    const task = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "x",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    await completeTaskRun(api, base, task.id, DIFF);
    const review = (await api.get(`${base}/tasks/${task.id}/review`)).body;
    expect(review.reviewer).toBeNull();
    expect(await liveRuns(api, base)).toEqual([]);

    // Humans comment through the REST route, resolve, then approve.
    const c = await api.post(`${base}/reviews/${review.id}/comments`, {
      file: "notes dir/plain.txt",
      hunk: 0,
      line: 2,
      body: "Good catch on the trailing newline.",
    });
    expect(c.status).toBe(201);
    expect((await api.get(`${base}/reviews/${review.id}`)).body.openComments).toBe(1);
    expect(
      (await api.post(`${base}/reviews/${review.id}/comments/${c.body.id}/resolve`, {})).body.resolved,
    ).toBe(true);
    expect((await api.get(`${base}/reviews/${review.id}`)).body.openComments).toBe(0);

    const approved = await api.post(`${base}/reviews/${review.id}/approve`, {});
    expect(approved.body.status).toBe("approved");
    expect(approved.body.decisions.at(-1)).toMatchObject({
      decision: "approve",
      by: { kind: "user", name: "Daniel" },
    });
    expect((await api.get(`${base}/tasks/${task.id}`)).body).toMatchObject({
      status: "done",
      doneBy: { round: 1 },
    });

    // A reviewer-role person cannot veto; the owner can, and the task goes back to In review.
    await api.post(`${base}/members`, { email: "rv4-rev@example.com", role: "reviewer" });
    const reviewer = board.api((await board.login("rv4-rev@example.com")).token);
    expect((await reviewer.post(`${base}/reviews/${review.id}/veto`, { note: "no" })).status).toBe(403);
    expect((await api.post(`${base}/reviews/${review.id}/veto`, {})).status).toBe(400);
    const vetoed = await api.post(`${base}/reviews/${review.id}/veto`, {
      note: "The diagram is missing; not done.",
    });
    expect(vetoed.status).toBe(200);
    expect(vetoed.body.status).toBe("open");
    expect(vetoed.body.decisions.map((d: any) => d.decision)).toEqual(["approve", "veto"]);
    const t = (await api.get(`${base}/tasks/${task.id}`)).body;
    expect(t.status).toBe("review");
    expect(t.doneBy).toBeNull();
    expect((await api.post(`${base}/reviews/${review.id}/veto`, { note: "again" })).status).toBe(409);
    const types = (await api.get(`${base}/events`)).body.map((e: any) => e.type);
    expect(types).toContain("review.vetoed");

    // Request changes from a person restarts the author too.
    const sent = await api.post(`${base}/reviews/${review.id}/request-changes`, {
      summary: "Add the diagram.",
    });
    expect(sent.status).toBe(200);
    expect(sent.body.restarted.runId).toBeTruthy();
    expect((await api.get(`${base}/tasks/${task.id}`)).body.status).toBe("doing");
    // While the author works, an approval is refused.
    expect((await api.post(`${base}/reviews/${review.id}/approve`, {})).status).toBe(409);
  });

  it("approving a review on a GitHub project proposes a pull request bound by sha256 and opens it", async () => {
    const { api, base } = await seedCompany(board, "rv6@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const project = (
      await api.post(`${base}/projects`, {
        name: "gtm-automations",
        client: "Globex",
        repoUrl: "https://github.com/acme/gtm-automations.git",
        defaultBranch: "main",
      })
    ).body;
    const task = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "Map VMS sub-workflow calls",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    // Binary files cannot ride a text diff: the fixture's logo.bin stays out of this run.
    const textOnly = DIFF.replace(/diff --git a\/logo\.bin[\s\S]*?(?=diff --git)/, "");
    await completeTaskRun(api, base, task.id, textOnly, { baseSha: BASE_SHA });
    const review = (await api.get(`${base}/tasks/${task.id}/review`)).body;
    github.requests.length = 0;
    const approved = await api.post(`${base}/reviews/${review.id}/approve`, { summary: "Ship it." });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("approved");
    expect(approved.body.taskStatus).toBe("done");
    const [pr] = approved.body.pullRequests;
    expect(pr).toMatchObject({
      provider: "github",
      repo: "acme/gtm-automations",
      baseBranch: "main",
      headBranch: "rosterdock/task-1",
      status: "opened",
      number: 42,
      url: "https://github.com/acme/gtm-automations/pull/42",
      error: null,
    });
    expect(pr.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    // A veto closes the pull request with the note as a comment; the branch stays.
    const opening = [...github.requests];
    github.requests.length = 0;
    const vetoed = await api.post(`${base}/reviews/${review.id}/veto`, { note: "Wrong workflow, not done." });
    expect(vetoed.status).toBe(200);
    expect(vetoed.body.pullRequests[0]).toMatchObject({ status: "closed", number: 42, error: null });
    expect(vetoed.body.pullRequests[0].closedAt).not.toBeNull();
    expect(github.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /repos/acme/gtm-automations/issues/42/comments",
      "PATCH /repos/acme/gtm-automations/pulls/42",
    ]);
    expect(github.requests[0]!.body).toEqual({
      body: "Vetoed on the RosterDock board: Wrong workflow, not done.",
    });
    expect(github.requests[1]!.body).toEqual({ state: "closed" });
    const closedEvent = (await api.get(`${base}/events?limit=10`)).body.find(
      (e: any) => e.type === "pr.closed",
    );
    expect(closedEvent.payload).toMatchObject({
      prNumber: 42,
      ok: true,
      error: null,
      repo: "acme/gtm-automations",
    });
    // Approve again: a new round is not needed; the review is open and approves as before.
    github.requests.length = 0;
    const reapproved = await api.post(`${base}/reviews/${review.id}/approve`, { summary: "Now yes." });
    expect(reapproved.body.status).toBe("approved");
    expect(reapproved.body.pullRequests[0]).toMatchObject({ status: "opened", number: 42 });
    github.requests.splice(0, github.requests.length, ...opening);
    // The provider applied the reviewed diff to the recorded base and opened the branch and pull request.
    const calls = github.requests.map((r) => `${r.method} ${r.path}`);
    expect(calls[0]).toBe(`GET /repos/acme/gtm-automations/git/commits/${BASE_SHA}`);
    expect(calls.at(-1)).toBe("POST /repos/acme/gtm-automations/pulls");
    const pull = github.requests.at(-1)!.body as { title: string; body: string; head: string; base: string };
    expect(pull).toMatchObject({
      title: "Task 1: Map VMS sub-workflow calls",
      head: "rosterdock/task-1",
      base: "main",
    });
    expect(pull.body).toContain("task 1, round 1, approved by Daniel");
    expect(pull.body).toContain("Merging needs a person");
    // No bare #1 anywhere the host reads it: GitHub would link it to the repository's own PR 1.
    const commit = github.requests.find((r) => r.method === "POST" && r.path.endsWith("/git/commits"))!
      .body as { message: string };
    expect(commit.message).toMatch(/^Task 1: Map VMS sub-workflow calls\n\nReview /);
    for (const text of [pull.title, pull.body, commit.message]) expect(text).not.toMatch(/#\d/);
    const types = (await api.get(`${base}/events`)).body.map((e: any) => e.type);
    expect(types).toContain("pr.proposed");
    expect(types).toContain("pr.opened");
    const stored = (
      await board.db.query("SELECT payload, payload_sha256 FROM pull_requests WHERE id = $1", [pr.id])
    ).rows[0]!;
    expect(stored.payload.baseSha).toBe(BASE_SHA);

    // A GitHub failure is recorded on the pull request and announced; the task is still Done.
    const task2 = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "Second",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    await completeTaskRun(api, base, task2.id, textOnly, { baseSha: BASE_SHA });
    const review2 = (await api.get(`${base}/tasks/${task2.id}/review`)).body;
    github.failWith = 401;
    try {
      const failed = await api.post(`${base}/reviews/${review2.id}/approve`, {});
      expect(failed.body.taskStatus).toBe("done");
      expect(failed.body.pullRequests[0]).toMatchObject({ status: "failed" });
      expect(failed.body.pullRequests[0].error).toMatch(/Bad credentials/);
      expect(failed.body.pullRequests[0].error).not.toContain("ghs_test_token");
    } finally {
      github.failWith = null;
    }
    expect((await api.get(`${base}/events`)).body.map((e: any) => e.type)).toContain("pr.failed");

    // Without a base sha (no repository clone) no pull request is proposed.
    const task3 = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "Third",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    await completeTaskRun(api, base, task3.id, textOnly);
    const review3 = (await api.get(`${base}/tasks/${task3.id}/review`)).body;
    expect((await api.post(`${base}/reviews/${review3.id}/approve`, {})).body.pullRequests).toEqual([]);

    // Research is documents, delivered on the board: approving it opens no pull request on the repository.
    const research = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "Research the digest's sources",
        assignee: { kind: "teammate", id: cody.id },
        workKind: "research",
      })
    ).body;
    await completeTaskRun(api, base, research.id, textOnly, { baseSha: BASE_SHA });
    const review4 = (await api.get(`${base}/tasks/${research.id}/review`)).body;
    github.requests.length = 0;
    const approvedResearch = (await api.post(`${base}/reviews/${review4.id}/approve`, {})).body;
    expect(approvedResearch).toMatchObject({ status: "approved", taskStatus: "done", pullRequests: [] });
    expect(github.requests).toEqual([]);
  });

  it("opens a pull request only from the files the review showed, as its diff still reads them", async () => {
    const { api, base } = await seedCompany(board, "rv-reread@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const project = (
      await api.post(`${base}/projects`, {
        name: "gtm-automations",
        client: "Globex",
        repoUrl: "https://github.com/acme/gtm-automations.git",
        defaultBranch: "main",
      })
    ).body;
    const textOnly = DIFF.replace(/diff --git a\/logo\.bin[\s\S]*?(?=diff --git)/, "");
    const open = async (title: string) => {
      const task = (
        await api.post(`${base}/tasks`, {
          projectId: project.id,
          title,
          assignee: { kind: "teammate", id: cody.id },
        })
      ).body;
      await completeTaskRun(api, base, task.id, textOnly, { baseSha: BASE_SHA });
      return (await api.get(`${base}/tasks/${task.id}/review`)).body;
    };
    const approve = async (id: string) =>
      (await api.post(`${base}/reviews/${id}/approve`, { summary: "Ship it." })).body.pullRequests[0];
    github.requests.length = 0;
    // Rows as a review opened before the upgrade may hold them: the diff reads otherwise now, so neither the
    // rows nor the diff is what the review showed and its secrets check scanned. Nothing is merged.
    const old = await open("Opened before the upgrade");
    await board.db.query(
      "UPDATE review_files SET hunks = hunks #- '{0,lines,0}', additions = additions - 1 WHERE review_id = $1 AND position = 0",
      [old.id],
    );
    expect(await approve(old.id)).toMatchObject({
      status: "failed",
      error:
        "the review's diff reads otherwise than the files the review showed (an older board read it): veto the approval and request changes, for a round this board reads",
    });
    // A diff that no longer hashes to what the review was opened with opens nothing.
    const changed = await open("Its diff changed since");
    await board.db.query(
      "UPDATE artifacts SET content = content || ' ' WHERE kind = 'diff' AND run_id = (SELECT run_id FROM reviews WHERE id = $1)",
      [changed.id],
    );
    expect(await approve(changed.id)).toMatchObject({
      status: "failed",
      error: "the review's diff no longer matches the sha256 it was opened with",
    });
    // Nor does one in a store this board cannot read: the rows alone are not the diff.
    const stored = await open("Its diff is in a store this board has not");
    await board.db.query(
      "UPDATE artifacts SET content = NULL, object_key = 'companies/x/runs/y/z' WHERE kind = 'diff' AND run_id = (SELECT run_id FROM reviews WHERE id = $1)",
      [stored.id],
    );
    expect(await approve(stored.id)).toMatchObject({
      status: "failed",
      error: "the review's diff could not be read from the object store",
    });
    expect(github.requests).toEqual([]);
    // As stored, it opens.
    const fresh = await open("Opened after the upgrade");
    expect(await approve(fresh.id)).toMatchObject({ status: "opened", error: null });
    expect(JSON.stringify(github.requests)).toContain("workflows/vms-digest.json");
  });

  it("opens a pull request only on the commit the run's clone was at, which the worker reports once per attempt", async () => {
    const { api, base } = await seedCompany(board, "rv-cloned@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const project = (
      await api.post(`${base}/projects`, {
        name: "gtm-automations",
        client: "Globex",
        repoUrl: "https://github.com/acme/gtm-automations.git",
        defaultBranch: "main",
      })
    ).body;
    const textOnly = TEXT_DIFF;
    const OTHER = "b".repeat(40);
    const open = async (title: string, cloned: string | null, baseSha: string) => {
      const task = (
        await api.post(`${base}/tasks`, {
          projectId: project.id,
          title,
          assignee: { kind: "teammate", id: cody.id },
        })
      ).body;
      const run = (await api.post(`${base}/tasks/${task.id}/runs`, {})).body;
      const asRun = board.api((await claim(run.id)).token);
      if (cloned) {
        expect((await asRun.post(`/api/worker/runs/${run.id}/cloned`, { sha: cloned })).status).toBe(200);
        // The same again is no change; another is refused: the engine holds this token too.
        expect((await asRun.post(`/api/worker/runs/${run.id}/cloned`, { sha: cloned })).status).toBe(200);
        expect((await asRun.post(`/api/worker/runs/${run.id}/cloned`, { sha: OTHER })).status).toBe(409);
      }
      await asRun.post(`/api/worker/runs/${run.id}/artifacts`, {
        path: "changes.diff",
        kind: "diff",
        content: textOnly,
      });
      await asRun.post(`/api/worker/runs/${run.id}/complete`, {
        status: "completed",
        summary: "Done.",
        baseSha,
      });
      return (await api.get(`${base}/tasks/${task.id}/review`)).body;
    };
    const approve = async (id: string) =>
      (await api.post(`${base}/reviews/${id}/approve`, { summary: "Ship it." })).body.pullRequests[0];
    github.requests.length = 0;
    // Changes that stand on another commit than the clone's (a checkout, a commit in the run) open nothing.
    const moved = await open("Moved", BASE_SHA, OTHER);
    expect(await approve(moved.id)).toMatchObject({
      status: "failed",
      error: `the run's changes stand on ${OTHER.slice(0, 12)}, not on ${BASE_SHA.slice(0, 12)}, the commit it was cloned at: the pull request would carry commits its review never showed`,
    });
    // Nor does a run that reported no clone (an older worker).
    const unreported = await open("Unreported", null, BASE_SHA);
    expect(await approve(unreported.id)).toMatchObject({
      status: "failed",
      error:
        "the run recorded no commit its clone was at (an older worker ran it): veto the approval and request changes, for a round this board reads",
    });
    expect(github.requests).toEqual([]);
    // A new attempt clones afresh, and reports its own.
    const task = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "Retried",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    const run = (await api.post(`${base}/tasks/${task.id}/runs`, {})).body;
    const first = board.api((await claim(run.id)).token);
    await first.post(`/api/worker/runs/${run.id}/cloned`, { sha: OTHER });
    await board.db.query("UPDATE runs SET status = 'interrupted' WHERE id = $1", [run.id]);
    const second = board.api((await claim(run.id)).token);
    expect((await second.post(`/api/worker/runs/${run.id}/cloned`, { sha: BASE_SHA })).status).toBe(200);
  });

  it("sends the author back on a repository with the round's diff to start from, and says on the task when it did not carry over", async () => {
    const { api, base } = await seedCompany(board, "rv-rework@example.com");
    const wren = await addTeammate(api, base, "Wren");
    const project = (
      await api.post(`${base}/projects`, {
        name: "RosterDock",
        client: "RosterDock",
        repoUrl: "https://github.com/acme/rosterdock.git",
        defaultBranch: "main",
      })
    ).body;
    const task = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "README landing page",
        assignee: { kind: "teammate", id: wren.id },
      })
    ).body;
    await completeTaskRun(api, base, task.id, ROUND_1, { baseSha: ROUND_1_BASE });
    const review = (await api.get(`${base}/tasks/${task.id}/review`)).body;
    // The sha256 the dogfood board recorded for this diff.
    expect(review.diffSha256).toBe("d7bbc46771c270e2dde39f8d9b4321b2c121bd33454378a7079217594e7184a2");

    // Sent back: the author's run carries round 1 whole, bound by that sha256, and the brief says so.
    const sentBack = await api.post(`${base}/reviews/${review.id}/request-changes`, {
      summary: "Three fixes to the outline.",
    });
    const runId = sentBack.body.restarted.runId as string;
    const claimed = await claim(runId);
    expect(claimed.spec.rework).toEqual({
      round: 1,
      diffSha256: review.diffSha256,
      baseSha: ROUND_1_BASE,
      diff: ROUND_1,
    });
    expect(claimed.pack).toContain(
      "Your working directory starts from round 1: its changes are applied to a fresh clone of main, uncommitted",
    );
    expect(claimed.pack).toContain("the worker starts you from the clean clone instead and says so");
    // The diff is in the clone, not in the brief.
    expect(claimed.pack).not.toContain("For real models, see [Engines](#engines) below");

    // main moved and round 1 did not apply: the worker says so, and the board says it on the task.
    const asWren = board.api(claimed.token);
    await asWren.post(`/api/worker/runs/${runId}/artifacts`, {
      path: "changes.diff",
      kind: "diff",
      content: ROUND_2,
    });
    const reason = "README.md changed on main since round 1";
    const done = await asWren.post(`/api/worker/runs/${runId}/complete`, {
      status: "completed",
      summary: `Started from a fresh copy of main: round 1's changes did not carry over (${reason}). Rewrote the outline.`,
      rework: { round: 1, applied: false, reason },
    });
    expect(done.status).toBe(200);
    const messages = (await api.get(`${base}/tasks/${task.id}/messages`)).body;
    expect(messages.map((m: any) => [m.author, m.body])).toEqual([
      [
        { kind: "teammate", id: wren.id, name: "Wren" },
        `Round 1's changes did not carry over to this run: ${reason}. It started from a fresh copy of main and makes the change again instead of editing round 1.`,
      ],
    ]);
    expect(
      (await board.db.query("SELECT run_id FROM messages WHERE id = $1", [messages[0].id])).rows[0].run_id,
    ).toBe(runId);
    const posted = (await api.get(`${base}/events?limit=20`)).body.find(
      (e: any) => e.type === "message.posted" && e.payload.messageId === messages[0].id,
    );
    expect(posted).toMatchObject({ subject: { kind: "task", id: task.id }, payload: { authorName: "Wren" } });
    expect((await api.get(`${base}/runs/${runId}`)).body.summary).toMatch(
      /^Started from a fresh copy of main/,
    );

    // Round 2 opened as usual; sent back again, the next run starts from round 2, and one that carried over says nothing.
    const round2 = (await api.get(`${base}/tasks/${task.id}/review`)).body;
    expect(round2).toMatchObject({ round: 2, status: "open" });
    const again = await api.post(`${base}/reviews/${round2.id}/request-changes`, { summary: "One more." });
    const next = await claim(again.body.restarted.runId);
    expect(next.spec.rework).toMatchObject({ round: 2, diff: ROUND_2, diffSha256: round2.diffSha256 });
    const asNext = board.api(next.token);
    await asNext.post(`/api/worker/runs/${again.body.restarted.runId}/artifacts`, {
      path: "changes.diff",
      kind: "diff",
      content: ROUND_2,
    });
    await asNext.post(`/api/worker/runs/${again.body.restarted.runId}/complete`, {
      status: "completed",
      summary: "Edited round 2.",
      rework: { round: 2, applied: true },
    });
    expect((await api.get(`${base}/tasks/${task.id}/messages`)).body).toHaveLength(1);
  });

  it("a research task's review checks that its documents cite sources, and its reviewer gets the checklist", async () => {
    const { api, base } = await seedCompany(board, "rv6@example.com");
    const ricky = await addTeammate(api, base, "Ricky", "researcher");
    await addTeammate(api, base, "Verifier", "reviewer");
    const project = await addProject(api, base);
    const task = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "Map the Gong export",
        assignee: { kind: "teammate", id: ricky.id },
        declaredOutputs: ["research.md"],
        workKind: "research",
      })
    ).body;
    expect(task.workKind).toBe("research");
    const run = (await api.post(`${base}/tasks/${task.id}/runs`, {})).body;
    const claimed = await claim(run.id);
    expect(claimed.pack).toContain("## Research");
    const asRun = board.api(claimed.token);
    const doc = "# Gong export\n\nCalls come from /v2/calls.\n";
    await asRun.post(`/api/worker/runs/${run.id}/artifacts`, {
      path: "research.md",
      kind: "document",
      content: doc,
    });
    await asRun.post(`/api/worker/runs/${run.id}/artifacts`, {
      path: "changes.diff",
      kind: "diff",
      content: renderNewFileDiff("research.md", doc),
    });
    await asRun.post(`/api/worker/runs/${run.id}/complete`, { status: "completed", summary: "Mapped." });
    const review = (await api.get(`${base}/tasks/${task.id}/review`)).body;
    expect(review.workKind).toBe("research");
    const sources = review.checks.find((c: any) => c.kind === "sources");
    expect(sources.ok).toBe(false);
    expect(sources.title).toBe("A document cites no sources: research.md");
    // The Verifier's review run reads the checklist, not a code review.
    const reviewRun = (await liveRuns(api, base)).find((r) => r.kind === "review")!;
    const reviewer = await claim(reviewRun.id);
    expect(reviewer.pack).toContain("This is a research review");
    expect(reviewer.pack).toContain("Research checklist:");
    expect(reviewer.pack).toContain("FAIL A document cites no sources");
    // Sent back; the rerun's document cites its source and the check passes in round 2.
    const client = await connect(reviewer.token);
    await client.callTool({ name: "board_request_changes", arguments: { summary: "Cite the Gong docs." } });
    await client.close();
    // The reviewer's run ends as the worker would end it, so round 2 can give the Verifier a fresh one.
    await board
      .api(reviewer.token)
      .post(`/api/worker/runs/${reviewRun.id}/complete`, { status: "completed", summary: "Sent back." });
    const rerun = (await api.get(`${base}/tasks/${task.id}/runs`)).body.find(
      (r: any) => r.kind === "task" && r.status === "queued",
    );
    const c2 = await claim(rerun.id);
    const cited = `${doc}\n## Sources\n- https://gong.io/docs/calls\n`;
    const asRerun = board.api(c2.token);
    await asRerun.post(`/api/worker/runs/${rerun.id}/artifacts`, {
      path: "research.md",
      kind: "document",
      content: cited,
    });
    await asRerun.post(`/api/worker/runs/${rerun.id}/artifacts`, {
      path: "changes.diff",
      kind: "diff",
      content: renderNewFileDiff("research.md", cited),
    });
    await asRerun.post(`/api/worker/runs/${rerun.id}/complete`, { status: "completed", summary: "Cited." });
    const round2 = (await api.get(`${base}/tasks/${task.id}/review`)).body;
    expect(round2.round).toBe(2);
    // The cited source was fetched: the check says it answered and keeps what it said.
    const cited2 = round2.checks.find((c: any) => c.kind === "sources");
    expect(cited2.ok).toBe(true);
    expect(cited2.title).toBe("The document cites sources · 1 source answered");
    expect(cited2.detail.sources).toEqual([
      expect.objectContaining({
        url: "https://gong.io/docs/calls",
        ok: true,
        status: 200,
        title: "Calls API",
      }),
    ]);
    // The round-2 reviewer reads what the source says, marked as material.
    const reviewRun2 = (await liveRuns(api, base)).find((r) => r.kind === "review" && r.status === "queued")!;
    const reviewer2 = await claim(reviewRun2.id);
    expect(reviewer2.pack).toContain("ok The document cites sources · 1 source answered");
    expect(reviewer2.pack).toContain("Sources fetched for you");
    expect(reviewer2.pack).toContain("- https://gong.io/docs/calls — answered: Calls API");
    expect(reviewer2.pack).toContain("  > GET /v2/calls lists calls.");
  });

  it("a research document citing a page that does not answer fails the sources check and names it", async () => {
    const { api, base } = await seedCompany(board, "rv7@example.com");
    const ricky = await addTeammate(api, base, "Ricky", "researcher");
    const project = await addProject(api, base);
    const task = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "Gone",
        assignee: { kind: "teammate", id: ricky.id },
        workKind: "research",
      })
    ).body;
    const run = (await api.post(`${base}/tasks/${task.id}/runs`, {})).body;
    const claimed = await claim(run.id);
    const asRun = board.api(claimed.token);
    const doc = "# Gone\n\n## Sources\n- https://gong.io/docs/calls\n- https://gong.io/docs/gone\n";
    await asRun.post(`/api/worker/runs/${run.id}/artifacts`, {
      path: "gone.md",
      kind: "document",
      content: doc,
    });
    await asRun.post(`/api/worker/runs/${run.id}/complete`, { status: "completed", summary: "Done." });
    const review = (await api.get(`${base}/tasks/${task.id}/review`)).body;
    const sources = review.checks.find((c: any) => c.kind === "sources");
    expect(sources.ok).toBe(false);
    expect(sources.title).toBe(
      "The document cites sources · 1 of 2 does not answer: https://gong.io/docs/gone",
    );
    expect(sources.detail.sources.map((s: any) => [s.url, s.ok, s.note])).toEqual([
      ["https://gong.io/docs/calls", true, null],
      ["https://gong.io/docs/gone", false, "answered 404"],
    ]);
  });

  it("scans every file the diff calls binary from the bytes the run sent, and a pull request carries only those bytes", async () => {
    const { api, base, owner, companyId } = await seedCompany(board, "rv-binaries@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const verifier = await addTeammate(api, base, "Verifier", "reviewer");
    const project = (
      await api.post(`${base}/projects`, {
        name: "binaries",
        client: "Globex",
        repoUrl: "https://github.com/acme/binaries",
        defaultBranch: "main",
      })
    ).body;
    const stanza = (p: string) =>
      `diff --git a/${p} b/${p}\nindex 1111111..2222222 100644\nBinary files a/${p} and b/${p} differ\n`;
    // `without`: binary files in the diff the run sent no bytes for.
    const open = async (title: string, files: { path: string; bytes: Buffer }[], without: string[] = []) => {
      const task = (
        await api.post(`${base}/tasks`, {
          projectId: project.id,
          title,
          assignee: { kind: "teammate", id: cody.id },
        })
      ).body;
      const run = (await api.post(`${base}/tasks/${task.id}/runs`, {})).body;
      const asRun = board.api((await claim(run.id)).token);
      for (const f of files) {
        // As the worker sends them: bytes without a NUL as text, others base64.
        const text = !f.bytes.includes(0);
        const posted = await asRun.post(`/api/worker/runs/${run.id}/artifacts`, {
          path: f.path,
          kind: "file",
          content: f.bytes.toString(text ? "utf8" : "base64"),
          encoding: text ? "utf8" : "base64",
        });
        expect(posted.status).toBe(201);
      }
      await asRun.post(`/api/worker/runs/${run.id}/artifacts`, {
        path: "changes.diff",
        kind: "diff",
        content: [...files.map((f) => f.path), ...without].map(stanza).join(""),
      });
      await asRun.post(`/api/worker/runs/${run.id}/cloned`, { sha: BASE_SHA });
      await asRun.post(`/api/worker/runs/${run.id}/complete`, {
        status: "completed",
        summary: "Done.",
        baseSha: BASE_SHA,
      });
      const review = (await api.get(`${base}/tasks/${task.id}/review`)).body;
      return { task, review, secrets: review.checks.find((c: any) => c.kind === "secrets") };
    };
    const approve = async (id: string) =>
      (await api.post(`${base}/reviews/${id}/approve`, {})).body.pullRequests[0];
    const blobs = () =>
      github.requests
        .filter(
          (r) => r.path.endsWith("/git/blobs") && (r.body as { encoding: string }).encoding === "base64",
        )
        .map((r) => (r.body as { content: string }).content);

    // A text file a .gitattributes `-diff` or `binary` (or .git/info/attributes) has git call binary: scanned.
    const marked = await open("Attributes", [
      { path: "config.json", bytes: Buffer.from('{ "smtp_password": "not-a-real-value-123" }\n') },
    ]);
    expect(marked.secrets).toMatchObject({
      ok: false,
      title: "1 secret-shaped string in the diff",
      detail: { lines: [{ path: "config.json", line: 1 }] },
    });
    // Text with a NUL byte in it: scanned all the same.
    const nul = await open("A NUL byte", [
      {
        path: "data.bin",
        bytes: Buffer.concat([Buffer.from([0]), Buffer.from('\napi_key = "not-a-real-value-123"\n')]),
      },
    ]);
    expect(nul.secrets).toMatchObject({ ok: false, detail: { lines: [{ path: "data.bin", line: 2 }] } });

    // Clean text git calls binary passes, and the pull request writes the bytes the check scanned.
    const lock = Buffer.from("plain words\n");
    const clean = await open("Clean", [{ path: "yarn.lock", bytes: lock }]);
    expect(clean.secrets).toMatchObject({
      ok: true,
      title:
        "No credential values in the diff's text; the review cannot show 1 binary file, read only as text, which a pull request takes only with a person's approval: yarn.lock",
    });
    github.requests.length = 0;
    expect(await approve(clean.review.id)).toMatchObject({ status: "opened" });
    expect(blobs()).toEqual([lock.toString("base64")]);
    // Bytes that changed since the review scanned them, or a review an older board opened, open nothing.
    const changed = await open("Changed since", [{ path: "yarn.lock", bytes: lock }]);
    await board.db.query(
      "UPDATE artifacts SET content = 'other words' WHERE run_id = $1 AND path = 'yarn.lock'",
      [changed.review.runId],
    );
    expect(await approve(changed.review.id)).toMatchObject({
      status: "failed",
      error: "the bytes of yarn.lock are not the ones its review scanned",
    });
    const older = await open("Opened by an older board", [{ path: "yarn.lock", bytes: lock }]);
    await board.db.query(
      "UPDATE review_checks SET detail = '{\"scannedChars\": 0}' WHERE review_id = $1 AND kind = 'secrets'",
      [older.review.id],
    );
    expect(await approve(older.review.id)).toMatchObject({
      status: "failed",
      error:
        "the review did not scan the bytes of yarn.lock (an older board opened it): veto the approval and request changes, for a round this board reads",
    });

    // The review shows no binary file's bytes: a teammate cannot put one into a pull request; a person can, on
    // the record.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    const logo = await open("Logo", [{ path: "logo.png", bytes: png }]);
    expect(logo.secrets).toMatchObject({ ok: true, detail: { unshown: ["logo.png"] } });
    const reviewerClaim = async (taskId: string) => {
      const runs = (await api.get(`${base}/tasks/${taskId}/runs`)).body as { id: string; kind: string }[];
      return claim(runs.find((r) => r.kind === "review")!.id);
    };
    const reviewerToken = async (taskId: string) => (await reviewerClaim(taskId)).token;
    // The reviewer is told before it decides, and its approval hands the review to people, who are asked.
    const logoClaim = await reviewerClaim(logo.task.id);
    expect(logoClaim.pack).toContain(
      "The diff has binary files the review cannot show: logo.png. Where approving opens a pull request, only a person approves them",
    );
    const asVerifier = board.api(logoClaim.token);
    const refused = await asVerifier.post(`${base}/reviews/${logo.review.id}/approve`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(
      `#${logo.task.number} would put binary files the review cannot show into a pull request (logo.png): a person decides it now, and has been asked`,
    );
    const handed = (await api.get(`${base}/reviews/${logo.review.id}`)).body;
    expect(handed).toMatchObject({ status: "open", reviewer: null });
    const asked = (await api.get(`${base}/events?limit=200`)).body.find(
      (e: any) => e.type === "review.needs_person" && e.subject.id === logo.review.id,
    );
    expect(asked.payload).toMatchObject({
      number: logo.task.number,
      files: ["logo.png"],
      teammateName: "Verifier",
    });
    expect(needsYouText(asked, "GTM Studio")).toBe(
      `#${logo.task.number} Logo carries binary files a review cannot show (logo.png): its pull request needs a person's approval in Reviews.`,
    );
    github.requests.length = 0;
    expect(await approve(logo.review.id)).toMatchObject({ status: "opened" });
    expect(blobs()).toEqual([png.toString("base64")]);
    const approvedEvent = (await api.get(`${base}/events?limit=200`)).body.find(
      (e: any) => e.type === "review.approved" && e.subject.id === logo.review.id,
    );
    expect(approvedEvent.payload.binaryFiles).toEqual(["logo.png"]);
    // Where a teammate approved one all the same (a check row that names none), the pull request refuses it.
    const stale = await open("Logo again", [{ path: "logo.png", bytes: png }]);
    await board.db.query(
      `UPDATE review_checks SET detail = jsonb_set(detail, '{binaries}', '[]') WHERE review_id = $1 AND kind = 'secrets'`,
      [stale.review.id],
    );
    const asVerifier2 = board.api(await reviewerToken(stale.task.id));
    const byTeammate = await asVerifier2.post(`${base}/reviews/${stale.review.id}/approve`, {});
    expect(byTeammate.status).toBe(200);
    expect(byTeammate.body.pullRequests[0]).toMatchObject({
      status: "failed",
      error: "logo.png is binary, which the review cannot show: only a person approves it",
    });

    // A binary file the run sent no bytes for stops no teammate's approval: the pull request refuses it.
    const noBytes = await open("No bytes", [], ["blob.bin"]);
    const asVerifier3 = board.api(await reviewerToken(noBytes.task.id));
    const noBytesApproved = await asVerifier3.post(`${base}/reviews/${noBytes.review.id}/approve`, {});
    expect(noBytesApproved.status).toBe(200);
    expect(noBytesApproved.body.pullRequests[0]).toMatchObject({ status: "failed" });
    // A person who vetoes before the pull request is opened stops it: it opens only for an approved review.
    const vetoed = await open("Vetoed", [{ path: "yarn.lock", bytes: lock }]);
    const hosts: GitHosts = {
      github: { fetch: github.fetch, token: "ghs_test_token", apiBase: "https://api.github.test" },
      gitlab: null,
    };
    const person = { kind: "user" as const, id: owner.userId };
    const proposed = await approveReview(board.db, companyId, person, "owner", vetoed.review.id, {}, hosts);
    await vetoReview(board.db, companyId, person, vetoed.review.id, { note: "Not yet." }, hosts);
    github.requests.length = 0;
    expect(await executePullRequest(board.db, hosts, companyId, proposed.pullRequestId!)).toMatchObject({
      status: "failed",
      error: "the review is no longer approved: a person vetoed it before the pull request was opened",
    });
    expect(github.requests).toEqual([]);
    // Who approved is the one the pull request was proposed by, never who decided the review since: a teammate's,
    // vetoed and approved again by a person, still carries no binary file.
    const again = await open("Approved again", [{ path: "logo.png", bytes: png }]);
    await board.db.query(
      `UPDATE review_checks SET detail = jsonb_set(detail, '{binaries}', '[]') WHERE review_id = $1 AND kind = 'secrets'`,
      [again.review.id],
    );
    const teammate = { kind: "teammate" as const, id: verifier.id };
    const byVerifier = await approveReview(
      board.db,
      companyId,
      teammate,
      "teammate",
      again.review.id,
      {},
      hosts,
    );
    await vetoReview(board.db, companyId, person, again.review.id, { note: "Mine to decide." }, hosts);
    await approveReview(board.db, companyId, person, "owner", again.review.id, {}, hosts);
    expect(await executePullRequest(board.db, hosts, companyId, byVerifier.pullRequestId!)).toMatchObject({
      status: "failed",
      error: "logo.png is binary, which the review cannot show: only a person approves it",
    });

    // Where approving opens no pull request (no repository), a teammate approves a binary deliverable as before.
    const plain = await addProject(api, base, "Charts");
    const chartTask = (
      await api.post(`${base}/tasks`, {
        projectId: plain.id,
        title: "Chart",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    const chartRun = (await api.post(`${base}/tasks/${chartTask.id}/runs`, {})).body;
    const asChartRun = board.api((await claim(chartRun.id)).token);
    await asChartRun.post(`/api/worker/runs/${chartRun.id}/artifacts`, {
      path: "chart.png",
      kind: "file",
      content: png.toString("base64"),
      encoding: "base64",
    });
    await asChartRun.post(`/api/worker/runs/${chartRun.id}/artifacts`, {
      path: "changes.diff",
      kind: "diff",
      content: renderBinaryFileDiff("chart.png"),
    });
    await asChartRun.post(`/api/worker/runs/${chartRun.id}/complete`, {
      status: "completed",
      summary: "Done.",
    });
    const chartReview = (await api.get(`${base}/tasks/${chartTask.id}/review`)).body;
    const asVerifier4 = board.api(await reviewerToken(chartTask.id));
    const chartApproved = await asVerifier4.post(`${base}/reviews/${chartReview.id}/approve`, {});
    expect(chartApproved.status).toBe(200);
    expect(chartApproved.body).toMatchObject({ status: "approved", taskStatus: "done", pullRequests: [] });
  });

  it("a diff with a binary file opens a pull request when the run reported the bytes, and says which file when not", async () => {
    const { api, base } = await seedCompany(board, "rv9@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const project = (
      await api.post(`${base}/projects`, {
        name: "gtm-automations-bin",
        client: "Globex",
        repoUrl: "https://github.com/acme/gtm-automations",
        defaultBranch: "main",
      })
    ).body;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    const start = async (title: string) => {
      const task = (
        await api.post(`${base}/tasks`, {
          projectId: project.id,
          title,
          assignee: { kind: "teammate", id: cody.id },
        })
      ).body;
      const run = (await api.post(`${base}/tasks/${task.id}/runs`, {})).body;
      const { token } = await claim(run.id);
      return { task, run, asRun: board.api(token) };
    };
    // The bytes ride as a base64 artifact; the board keeps them base64 and says so.
    const withBytes = await start("Logo and workflow");
    const posted = await withBytes.asRun.post(`/api/worker/runs/${withBytes.run.id}/artifacts`, {
      path: "logo.bin",
      kind: "file",
      content: png.toString("base64"),
      encoding: "base64",
    });
    expect(posted.status).toBe(201);
    expect(posted.body).toMatchObject({ encoding: "base64", bytes: 8, inline: true });
    const stored = (
      await board.db.query<{ content: string; encoding: string }>(
        "SELECT content, encoding FROM artifacts WHERE id = $1",
        [posted.body.id],
      )
    ).rows[0]!;
    expect(stored).toEqual({ content: png.toString("base64"), encoding: "base64" });
    const fetched = (await api.get(`${base}/runs/${withBytes.run.id}/artifacts/${posted.body.id}`)).body;
    expect(fetched).toMatchObject({ encoding: "base64", content: png.toString("base64") });
    await withBytes.asRun.post(`/api/worker/runs/${withBytes.run.id}/artifacts`, {
      path: "changes.diff",
      kind: "diff",
      content: DIFF,
    });
    await withBytes.asRun.post(`/api/worker/runs/${withBytes.run.id}/cloned`, { sha: BASE_SHA });
    await withBytes.asRun.post(`/api/worker/runs/${withBytes.run.id}/complete`, {
      status: "completed",
      summary: "Done.",
      baseSha: BASE_SHA,
    });
    const review = (await api.get(`${base}/tasks/${withBytes.task.id}/review`)).body;
    expect(review.files.find((f: any) => f.path === "logo.bin").binary).toBe(true);
    github.requests.length = 0;
    const approved = await api.post(`${base}/reviews/${review.id}/approve`, {});
    expect(approved.body.pullRequests[0]).toMatchObject({ status: "opened", number: 42 });
    const blob = github.requests.find(
      (r) => r.path.endsWith("/git/blobs") && (r.body as { encoding: string }).encoding === "base64",
    );
    expect(blob?.body).toEqual({ content: png.toString("base64"), encoding: "base64" });
    // Without the artifact the pull request fails and names the file; the task is still Done.
    const without = await start("Logo only");
    await without.asRun.post(`/api/worker/runs/${without.run.id}/artifacts`, {
      path: "changes.diff",
      kind: "diff",
      content: DIFF,
    });
    await without.asRun.post(`/api/worker/runs/${without.run.id}/cloned`, { sha: BASE_SHA });
    await without.asRun.post(`/api/worker/runs/${without.run.id}/complete`, {
      status: "completed",
      summary: "Done.",
      baseSha: BASE_SHA,
    });
    const review2 = (await api.get(`${base}/tasks/${without.task.id}/review`)).body;
    const failed = await api.post(`${base}/reviews/${review2.id}/approve`, {});
    expect(failed.body.taskStatus).toBe("done");
    expect(failed.body.pullRequests[0]).toMatchObject({ status: "failed" });
    expect(failed.body.pullRequests[0].error).toMatch(/no bytes for logo\.bin/);
  });

  it("approving a review on a GitLab project opens a merge request, and a veto closes it", async () => {
    const { api, base } = await seedCompany(board, "rv8@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const project = (
      await api.post(`${base}/projects`, {
        name: "gtm-automations-gl",
        client: "Globex",
        repoUrl: "https://gitlab.com/acme/gtm-automations",
        defaultBranch: "main",
      })
    ).body;
    const task = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "Map VMS sub-workflow calls",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    const textOnly = DIFF.replace(/diff --git a\/logo\.bin[\s\S]*?(?=diff --git)/, "");
    await completeTaskRun(api, base, task.id, textOnly, { baseSha: BASE_SHA });
    const review = (await api.get(`${base}/tasks/${task.id}/review`)).body;
    gitlab.requests.length = 0;
    github.requests.length = 0;
    const approved = await api.post(`${base}/reviews/${review.id}/approve`, { summary: "Ship it." });
    expect(approved.body.status).toBe("approved");
    expect(approved.body.pullRequests[0]).toMatchObject({
      provider: "gitlab",
      repo: "acme/gtm-automations",
      baseBranch: "main",
      headBranch: `rosterdock/task-${task.number}`,
      status: "opened",
      number: 17,
      url: "https://gitlab.com/acme/gtm-automations/-/merge_requests/17",
      error: null,
    });
    expect(github.requests).toEqual([]);
    expect(gitlab.requests.map((r) => `${r.method} ${r.path}`)).toContain(
      "POST /projects/acme%2Fgtm-automations/merge_requests",
    );
    const opened = (await api.get(`${base}/events?limit=10`)).body.find((e: any) => e.type === "pr.opened");
    expect(opened.payload).toMatchObject({ provider: "gitlab", prNumber: 17, repo: "acme/gtm-automations" });
    gitlab.requests.length = 0;
    const vetoed = await api.post(`${base}/reviews/${review.id}/veto`, { note: "Not yet." });
    expect(vetoed.body.pullRequests[0]).toMatchObject({ status: "closed", number: 17 });
    expect(gitlab.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /projects/acme%2Fgtm-automations/merge_requests/17/notes",
      "PUT /projects/acme%2Fgtm-automations/merge_requests/17",
    ]);
  });

  it("a run with no diff still opens a review with no files, and secret-shaped diffs fail the check", async () => {
    const { api, base } = await seedCompany(board, "rv5@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const project = await addProject(api, base);
    const task = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "x",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    const run = (await api.post(`${base}/tasks/${task.id}/runs`, {})).body;
    const asRun = board.api((await claim(run.id)).token);
    await asRun.post(`/api/worker/runs/${run.id}/complete`, {
      status: "completed",
      summary: "Nothing to write.",
    });
    const review = (await api.get(`${base}/tasks/${task.id}/review`)).body;
    expect(review.files).toEqual([]);
    expect(review.checks.find((c: any) => c.kind === "outputs").ok).toBeNull();

    const leaky = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "y",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    const diff = DIFF.replace('+    "active": false,', '+    "smtp_password": "hunter2hunter2",');
    await completeTaskRun(api, base, leaky.id, diff);
    const r2 = (await api.get(`${base}/tasks/${leaky.id}/review`)).body;
    const secrets = r2.checks.find((c: any) => c.kind === "secrets");
    expect(secrets.ok).toBe(false);
    expect(secrets.detail.lines).toEqual([{ path: "workflows/vms-digest.json", line: 6 }]);
    expect(JSON.stringify(secrets)).not.toContain("hunter2");

    // A diff git would not write: a hunk longer than its header, whose next line would rename the file.
    const unread = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "z",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    const forged = [
      "diff --git a/notes.md b/notes.md",
      "--- a/notes.md",
      "+++ b/notes.md",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "+++ b/../../outside.md",
      '+"smtp_password": "hunter2hunter2",',
      "",
    ].join("\n");
    await completeTaskRun(api, base, unread.id, forged);
    const r3 = (await api.get(`${base}/tasks/${unread.id}/review`)).body;
    expect(r3.files).toEqual([]);
    expect(r3.checks.find((c: any) => c.kind === "secrets")).toMatchObject({
      ok: false,
      detail: { unread: "notes.md: hunk 1 is longer than its header says" },
    });
  });

  it("a failed credential scan or failing tests stop a teammate's approval; a person approves over them, on the record", async () => {
    const { api, base } = await seedCompany(board, "rv12@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const verifier = await addTeammate(api, base, "Verifier", "reviewer");
    const project = await addProject(api, base);
    const leaky = TEXT_DIFF.replace('+    "active": false,', '+    "smtp_password": "hunter2hunter2",');
    const red = { kind: "tests" as const, ok: false, title: "npm test failed: 2 failing" };
    for (const [title, diff, tests, failed] of [
      ["Leaky", leaky, undefined, { kind: "secrets", title: "1 secret-shaped string in the diff" }],
      ["Red", TEXT_DIFF, red, { kind: "tests", title: red.title }],
    ] as const) {
      const task = (
        await api.post(`${base}/tasks`, {
          projectId: project.id,
          title,
          assignee: { kind: "teammate", id: cody.id },
        })
      ).body;
      await completeTaskRun(api, base, task.id, diff, tests ? { tests } : {});
      const review = (await api.get(`${base}/tasks/${task.id}/review`)).body;
      expect(review.reviewer).toMatchObject({ kind: "teammate", id: verifier.id });
      const reviewRun = (await liveRuns(api, base)).find((r) => r.kind === "review")!;
      const claimed = await claim(reviewRun.id);
      expect(claimed.pack).toContain(`FAIL ${failed.title}`);
      expect(claimed.pack).toContain("blocks your approval");

      // The assigned reviewer teammate, over MCP and over REST: refused, and the task stays in review.
      const vclient = await connect(claimed.token);
      const refused = await vclient.callTool({ name: "board_approve", arguments: { summary: "Fine." } });
      expect(refused.isError).toBe(true);
      expect(text(refused)).toContain(failed.title);
      await vclient.close();
      const rest = await board.api(claimed.token).post(`${base}/reviews/${review.id}/approve`, {});
      expect(rest.status).toBe(409);
      expect((await api.get(`${base}/tasks/${task.id}`)).body.status).toBe("review");
      await board.api(claimed.token).post(`/api/worker/runs/${reviewRun.id}/complete`, {
        status: "completed",
        summary: "Left it to a person.",
        usage: {},
      });

      // A person may approve over it, and the approval says which check they overrode.
      const approved = await api.post(`${base}/reviews/${review.id}/approve`, {});
      expect(approved.status).toBe(200);
      expect(approved.body.status).toBe("approved");
      const event = (await api.get(`${base}/events?limit=200`)).body.find(
        (e: any) => e.type === "review.approved" && e.subject.id === review.id,
      );
      expect(event.payload.overrodeChecks).toEqual([failed]);
    }
  });
});
