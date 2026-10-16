// A goal's result, as its owner sees it: the files its final tasks delivered
// (Done, nothing open depends on them) apart from the ones on the way, and its
// live writes with what each target holds now by the board's record, checked
// against the file review approved. Live on Lighthouse the drive held a draft
// that review never approved; a later write of the approved text puts it right.
// All of it downloads as one zip, and each file on its own.
import { inflateRawSync } from "node:zlib";
import { parseStdioCommands } from "@rosterdock/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { proposeApproval } from "../src/approvals/service.js";
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
const sent: unknown[] = [];

beforeAll(async () => {
  board = await startTestBoard(
    // The drive's server runs inside the board, so the operator lists its command line.
    { stdioCommands: parseStdioCommands("npx -y @modelcontextprotocol/server-filesystem /srv/drive") },
    {
      approvalExecutor: async (approval) => {
        sent.push(approval.payload);
        return { ok: true, result: { ok: true } };
      },
    },
  );
});
afterAll(async () => {
  await board.destroy();
});

const diff = (path: string) =>
  `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+x\n`;

/** Run the task's claimed run to completion with these files. */
async function finish(runId: string, files: Record<string, string>) {
  const claimed = await workerClaim(board, runId);
  for (const [path, content] of Object.entries(files))
    await claimed.api.post(`/api/worker/runs/${runId}/artifacts`, { path, kind: "document", content });
  await claimed.api.post(`/api/worker/runs/${runId}/artifacts`, {
    path: "changes.diff",
    kind: "diff",
    content: diff(Object.keys(files)[0] ?? "x.md"),
  });
  await workerComplete(board, claimed.token, runId, { status: "completed", summary: "Delivered." });
}

async function approveReview(api: Api, base: string, taskId: string) {
  const review = (await api.get(`${base}/tasks/${taskId}/review`)).body;
  expect((await api.post(`${base}/reviews/${review.id}/approve`, {})).status).toBe(200);
}

/** A proposal from the task's live run to write this text to the drive, approved and executed. */
async function publish(
  api: Api,
  base: string,
  task: any,
  teammateId: string,
  content: string,
  path = "published/positioning.md",
) {
  const run = (await api.post(`${base}/tasks/${task.id}/runs`, {})).body;
  const claimed = await workerClaim(board, run.id);
  const { approval } = await proposeApproval(board.db, task.companyId, {
    taskId: task.id,
    runId: run.id,
    teammateId,
    connection: "drive",
    tool: "write_file",
    title: "Publish positioning.md",
    why: "The positioning goes to the drive.",
    payload: { path, content },
  });
  await workerComplete(board, claimed.token, run.id, { status: "completed" });
  expect((await api.post(`${base}/approvals/${approval.id}/approve`, {})).body.status).toBe("executed");
  // The proposer is started again with the outcome: that run is the one that delivers.
  return ((await api.get(`${base}/tasks/${task.id}/runs`)).body as { id: string; status: string }[]).find(
    (r) => r.status === "queued",
  )!.id;
}

describe("a goal's result", () => {
  it("names what it delivered, what it published, and whether the live copy is the approved one", async () => {
    const { api, base } = await seedCompany(board, "result@example.com");
    // Nobody to plan for yet: the goal waits for people with a project of its own.
    const goal = (await api.post(`${base}/goals`, { text: "Position RosterDock against its alternatives." }))
      .body;
    const scout = await addTeammate(api, base, "Scout", "market analyst");
    await api.post(`${base}/connections`, {
      name: "drive",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/srv/drive"],
    });
    await addTeammate(api, base, "Edie", "reviewer");
    const task = async (title: string, declaredOutputs: string[], dependsOn: string[] = []) =>
      (
        await api.post(`${base}/tasks`, {
          projectId: goal.projectId,
          title,
          assignee: { kind: "teammate", id: scout.id },
          declaredOutputs,
          dependsOn,
        })
      ).body;
    const shortlist = await task("Shortlist the alternatives", ["shortlist.md"]);
    const positioning = await task("Write the positioning", ["positioning.md"], [shortlist.id]);
    // Cancelled work that depended on the positioning does not make it a step on the way.
    const dropped = await task("Translate it", ["positioning-fr.md"], [positioning.id]);
    await api.post(`${base}/tasks/${dropped.id}/cancel`, {});

    await finish((await api.post(`${base}/tasks/${shortlist.id}/runs`, {})).body.id, {
      "shortlist.md": "# Shortlist\n",
    });
    await approveReview(api, base, shortlist.id);
    // The draft is published, then the run that delivers writes the approved text.
    const next = await publish(api, base, positioning, scout.id, "# Positioning (draft)\n");
    await finish(next, { "positioning.md": "# Positioning\n" });
    await approveReview(api, base, positioning.id);

    const result = (await api.get(`${base}/goals/${goal.id}/result`)).body;
    expect(result.delivered.map((t: any) => [t.number, t.files.map((f: any) => f.path)])).toEqual([
      [positioning.number, ["positioning.md"]],
    ]);
    expect(result.supporting.map((t: any) => [t.number, t.files.map((f: any) => f.path)])).toEqual([
      [shortlist.number, ["shortlist.md"]],
    ]);
    expect(result.published).toHaveLength(1);
    expect(result.published[0]).toMatchObject({
      connection: "drive",
      tool: "write_file",
      target: "published/positioning.md",
      number: positioning.number,
      now: null,
      matchesDelivered: { number: positioning.number, path: "positioning.md", same: false },
    });

    // Another task writes the approved text, naming the same file absolutely: the goal's result says who wrote
    // the target since, and that it matches.
    const upkeep = await addProject(api, base, "Drive upkeep");
    const fix = (
      await api.post(`${base}/tasks`, {
        projectId: upkeep.id,
        title: "Republish the approved positioning",
        assignee: { kind: "teammate", id: scout.id },
        // Work elsewhere built on the positioning: it is still what the goal delivered.
        dependsOn: [positioning.id],
      })
    ).body;
    await publish(api, base, fix, scout.id, "# Positioning\n", "/srv/drive/published/positioning.md");
    const again = (await api.get(`${base}/goals/${goal.id}/result`)).body;
    expect(again.delivered.map((t: any) => t.number)).toEqual([positioning.number]);
    const after = again.published;
    expect(after).toHaveLength(1);
    const fixed = after[0];
    expect(fixed.now).toMatchObject({ number: fix.number });
    expect(fixed.matchesDelivered.same).toBe(true);

    // Everything it delivered in one zip, final first, named by task.
    const zip = await board.app.inject({
      method: "GET",
      url: `${base}/goals/${goal.id}/result.zip`,
      headers: { authorization: `Bearer ${(await board.login("result@example.com")).token}` },
    });
    expect(zip.statusCode).toBe(200);
    expect(zip.headers["content-type"]).toBe("application/zip");
    expect(zip.headers["content-disposition"]).toBe(
      'attachment; filename="position-rosterdock-against-its-alternatives.zip"',
    );
    const bytes = zip.rawPayload;
    const names: string[] = [];
    const bodies: string[] = [];
    for (let at = 0; bytes.readUInt32LE(at) === 0x04034b50;) {
      const size = bytes.readUInt32LE(at + 18);
      const nameLen = bytes.readUInt16LE(at + 26);
      names.push(bytes.subarray(at + 30, at + 30 + nameLen).toString("utf8"));
      const body = bytes.subarray(at + 30 + nameLen, at + 30 + nameLen + size);
      bodies.push((bytes.readUInt16LE(at + 8) === 8 ? inflateRawSync(body) : body).toString("utf8"));
      at += 30 + nameLen + size;
    }
    expect(names).toEqual([`${positioning.number}-positioning.md`, `${shortlist.number}-shortlist.md`]);
    expect(bodies).toEqual(["# Positioning\n", "# Shortlist\n"]);

    // One file on its own, to save.
    const file = result.delivered[0].files[0];
    const one = await board.app.inject({
      method: "GET",
      url: `${base}/runs/${file.runId}/artifacts/${file.artifactId}/download`,
      headers: { authorization: `Bearer ${(await board.login("result@example.com")).token}` },
    });
    expect(one.body).toBe("# Positioning\n");
    expect(one.headers["content-disposition"]).toBe(
      "attachment; filename=\"positioning.md\"; filename*=UTF-8''positioning.md",
    );
  });
});
