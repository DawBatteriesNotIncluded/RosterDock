// Behavioural drift: a teammate's runs against their own baseline (cost,
// duration) and their reviews against their own rejection rate. One event
// per departure, per day; Peter records it; the notifier pushes it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  driftThresholds,
  checkRejectionDrift,
  detectOutlier,
  detectRejectionDrift,
  MIN_BASELINE_RUNS,
} from "../src/drift/drift.js";
import { driftSentence } from "../src/notify/notify.js";
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
const posts: string[] = [];
beforeAll(async () => {
  board = await startTestBoard(
    { notifyWebhookUrl: "https://hooks.test/needs-you" },
    {
      notifyFetch: async (_url, init) => {
        posts.push(String((JSON.parse(String(init?.body)) as { text: string }).text));
        return new Response("ok", { status: 200 });
      },
    },
  );
});
afterAll(async () => {
  await board.destroy();
});

describe("drift thresholds from Settings", () => {
  it("reads each threshold within its bounds and keeps the default otherwise", () => {
    expect(driftThresholds(null)).toEqual(DEFAULT_THRESHOLDS);
    expect(driftThresholds({ drift: { ratioFloor: 3, madFactor: 6, rejectionRateFloor: 0.8 } })).toEqual({
      ...DEFAULT_THRESHOLDS,
      ratioFloor: 3,
      madFactor: 6,
      rejectionRateFloor: 0.8,
    });
    expect(driftThresholds({ drift: { ratioFloor: 50, madFactor: "3", rejectionRateDelta: -1 } })).toEqual(
      DEFAULT_THRESHOLDS,
    );
  });

  it("a wider threshold lets the same run pass; a narrower one catches it", () => {
    const steady = [100, 110, 95, 105, 100, 98, 102];
    expect(detectOutlier("cost", steady, 320)).not.toBeNull();
    expect(detectOutlier("cost", steady, 320, { ...DEFAULT_THRESHOLDS, ratioFloor: 4 })).toBeNull();
    expect(
      detectOutlier("cost", steady, 140, { ...DEFAULT_THRESHOLDS, ratioFloor: 1.2, madFactor: 1 }),
    ).not.toBeNull();
    const rising = Array(9).fill(true).concat([false], Array(8).fill(false)) as boolean[];
    expect(detectRejectionDrift(rising)).not.toBeNull();
    expect(detectRejectionDrift(rising, { ...DEFAULT_THRESHOLDS, rejectionRateFloor: 1 })).toBeNull();
  });

  it("the board keeps a company's thresholds in its settings and refuses ones out of bounds", async () => {
    const { api, base } = await seedCompany(board, "dt1@example.com");
    const bad = await api.patch(base, { settings: { drift: { ratioFloor: 50 } } });
    expect(bad.status).toBe(400);
    const ok = await api.patch(base, { settings: { drift: { ratioFloor: 2.5, madFactor: 4 } } });
    expect(ok.status).toBe(200);
    expect(ok.body.settings.drift).toEqual({ ratioFloor: 2.5, madFactor: 4 });
  });
});

describe("detecting drift (pure)", () => {
  it("flags a sample beyond three MADs and at least 1.5 times the median, with enough history", () => {
    const steady = [100, 110, 95, 105, 100, 98, 102];
    expect(detectOutlier("cost", steady, 120)).toBeNull();
    expect(detectOutlier("cost", steady, 149)).toBeNull();
    const hit = detectOutlier("cost", steady, 320)!;
    expect(hit.metric).toBe("cost");
    expect(hit.baseline).toBe(100);
    expect(hit.ratio).toBeCloseTo(3.2, 2);
    expect(hit.samples).toBe(7);
    // A noisy history widens what counts as normal.
    const noisy = [50, 200, 100, 300, 80, 250, 120];
    expect(detectOutlier("duration", noisy, 320)).toBeNull();
    expect(detectOutlier("duration", noisy, 800)).not.toBeNull();
    // Too little history, or a zero baseline, says nothing.
    expect(detectOutlier("cost", steady.slice(0, MIN_BASELINE_RUNS - 1), 1000)).toBeNull();
    expect(detectOutlier("cost", [0, 0, 0, 0, 0], 1000)).toBeNull();
  });

  it("flags a rejection rate that rose to half or more, well above what it was", () => {
    const calm = Array(10).fill(false).concat(Array(8).fill(false)) as boolean[];
    expect(detectRejectionDrift(calm)).toBeNull();
    const rising = [
      true,
      true,
      true,
      false,
      true,
      true,
      false,
      true,
      false,
      true,
      ...Array(8).fill(false),
    ] as boolean[];
    const hit = detectRejectionDrift(rising)!;
    expect(hit.metric).toBe("rejection");
    expect(hit.value).toBe(0.7);
    expect(hit.baseline).toBe(0);
    // Always bad is not drift: the baseline was bad too.
    expect(detectRejectionDrift(Array(20).fill(true) as boolean[])).toBeNull();
    // Not enough before or after.
    expect(detectRejectionDrift([true, true, true, true, true, false, false])).toBeNull();
  });

  it("says it in a sentence", () => {
    expect(
      driftSentence({
        teammateName: "Cody",
        metric: "cost",
        value: 410_000,
        baseline: 128_000,
        ratio: 3.2,
        number: 12,
      }),
    ).toBe("Cody's runs cost 3.2× their usual (410k tokens against 128k tokens on #12).");
    expect(
      driftSentence({
        teammateName: "Cody",
        metric: "duration",
        value: 1_800_000,
        baseline: 600_000,
        ratio: 3,
      }),
    ).toBe("Cody's runs take 3.0× their usual (30 min against 10 min).");
    expect(
      driftSentence({ teammateName: "Cody", metric: "rejection", value: 0.7, baseline: 0.1, ratio: 7 }),
    ).toBe("Cody's work is coming back: 70% of recent reviews sent it back, against 10% before.");
  });
});

async function finishRun(api: Api, base: string, taskId: string, tokens: number, durationMs: number) {
  const run = (await api.post(`${base}/tasks/${taskId}/runs`, {})).body;
  const claimed = await workerClaim(board, run.id);
  await workerComplete(board, claimed.token, run.id, {
    status: "completed",
    summary: "done",
    usage: { inputTokens: tokens },
    durationMs,
  });
  // The review the run opened is approved by nobody here; the next run needs the task back in play.
  const task = (await api.get(`${base}/tasks/${taskId}`)).body;
  if (task.status === "review") {
    const reviews = (await api.get(`${base}/reviews?taskId=${taskId}`)).body as { id: string }[];
    const review = reviews.find(() => true);
    if (review) await api.post(`${base}/reviews/${review.id}/request-changes`, { summary: "again" });
    const restarted = (await api.get(`${base}/tasks/${taskId}`)).body;
    // Request-changes restarts the author: finish that run too so the next dispatch is clean.
    if (restarted.activeRunId) {
      const again = await workerClaim(board, restarted.activeRunId);
      await workerComplete(board, again.token, restarted.activeRunId, {
        status: "completed",
        summary: "done",
        usage: { inputTokens: tokens },
        durationMs,
      });
    }
  }
  return run.id as string;
}

describe("drift on the board", () => {
  it("records one departure per metric and day when a run costs far more than the teammate's usual, and tells you", async () => {
    const { api, base, companyId } = await seedCompany(board, "dr1@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const project = await addProject(api, base);
    const task = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "steady work",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    // A steady baseline of 120k-token, 10-minute runs.
    for (let i = 0; i < 4; i++) await finishRun(api, base, task.id, 120_000 + i * 1000, 600_000 + i * 1000);
    let events = (await api.get(`${base}/events?limit=200`)).body as { type: string }[];
    expect(events.filter((e) => e.type === "teammate.drift")).toHaveLength(0);
    // Then one run at 410k tokens and 35 minutes.
    const big = await finishRun(api, base, task.id, 410_000, 2_100_000);
    const latest = (await api.get(`${base}/events?limit=1`)).body[0].seq;
    await board.bus.waitFor(companyId, latest);
    for (let i = 0; i < 100; i++) {
      events = (await api.get(`${base}/events?limit=200`)).body;
      if (events.filter((e) => e.type === "teammate.drift").length >= 2) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const drifts = events.filter((e) => e.type === "teammate.drift") as any[];
    expect(drifts.map((d) => d.payload.metric).sort()).toEqual(["cost", "duration"]);
    const cost = drifts.find((d) => d.payload.metric === "cost");
    expect(cost.subject).toEqual({ kind: "teammate", id: cody.id });
    expect(cost.payload.teammateName).toBe("Cody");
    expect(cost.payload.managerName).toBe("Peter");
    expect(cost.payload.runId).toBe(big);
    expect(cost.payload.number).toBe(task.number);
    expect(cost.payload.ratio).toBeGreaterThan(3);
    expect(cost.payload.samples).toBeGreaterThanOrEqual(5);
    // Peter is the observer on the event.
    const peter = (await api.get(`${base}/teammates`)).body.find((t: any) => t.handle === "peter");
    expect(cost.actor).toEqual({ kind: "teammate", id: peter.id });
    // The notifier pushed both as one sentence each.
    for (let i = 0; i < 100 && posts.filter((p) => p.includes("Cody")).length < 2; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(posts.some((p) => p.includes("Cody's runs cost") && p.includes("their usual"))).toBe(true);
    expect(posts.some((p) => p.includes("Cody's runs take"))).toBe(true);
    // The baseline says what stands against Cody.
    const baseline = (await api.get(`${base}/teammates/${cody.id}/baseline`)).body;
    expect(baseline.runs).toBeGreaterThanOrEqual(6);
    expect(baseline.cost.latest).toBe(410_000);
    expect(baseline.cost.ratio).toBeGreaterThan(3);
    expect(baseline.drift.map((d: any) => d.metric).sort()).toEqual(["cost", "duration"]);
    // Another expensive run the same day is not a second alert.
    await finishRun(api, base, task.id, 500_000, 2_400_000);
    await board.bus.waitFor(companyId, (await api.get(`${base}/events?limit=1`)).body[0].seq);
    await new Promise((r) => setTimeout(r, 100));
    events = (await api.get(`${base}/events?limit=300`)).body;
    expect(events.filter((e) => e.type === "teammate.drift")).toHaveLength(2);
  });

  it("records a rising rejection rate on a teammate's reviews", async () => {
    const { api, base, companyId } = await seedCompany(board, "dr2@example.com");
    const brody = await addTeammate(api, base, "Brody", "requirements");
    const project = await addProject(api, base);
    const task = (
      await api.post(`${base}/tasks`, {
        projectId: project.id,
        title: "spec",
        assignee: { kind: "teammate", id: brody.id },
      })
    ).body;
    const run = (await api.post(`${base}/tasks/${task.id}/runs`, {})).body;
    const claimed = await workerClaim(board, run.id);
    await workerComplete(board, claimed.token, run.id, { status: "completed", summary: "done" });
    const review = ((await api.get(`${base}/reviews?taskId=${task.id}`)).body as { id: string }[])[0]!;
    // History straight into the ledger: eight approvals long ago, then nine send-backs among the last ten.
    const owner = (await api.get("/api/auth/me")).body.user.id as string;
    const insert = async (decision: string, daysAgo: number) =>
      board.db.query(
        `INSERT INTO review_decisions (company_id, review_id, round, decider_kind, decider_id, decision, note, created_at)
         VALUES ($1, $2, 1, 'user', $3, $4, NULL, now() - ($5 || ' days')::interval)`,
        [companyId, review.id, owner, decision, String(daysAgo)],
      );
    for (let i = 0; i < 8; i++) await insert("approve", 30 - i);
    for (let i = 0; i < 9; i++) await insert("request_changes", 9 - i);
    expect(
      (await checkRejectionDrift({ db: board.db, log: { warn: () => {} } }, companyId, review.id))?.metric,
    ).toBe("rejection");
    const events = (await api.get(`${base}/events?limit=50`)).body as any[];
    const drift = events.find((e) => e.type === "teammate.drift");
    expect(drift.subject.id).toBe(brody.id);
    expect(drift.payload.value).toBeCloseTo(0.9, 2);
    expect(drift.payload.baseline).toBe(0);
    // And a real request-changes through the route, with the same history, does not double it.
    const sent = await api.post(`${base}/reviews/${review.id}/request-changes`, { summary: "Once more." });
    expect(sent.status).toBe(200);
    await board.bus.waitFor(companyId, (await api.get(`${base}/events?limit=1`)).body[0].seq);
    await new Promise((r) => setTimeout(r, 100));
    const after = (await api.get(`${base}/events?limit=100`)).body as any[];
    expect(after.filter((e) => e.type === "teammate.drift")).toHaveLength(1);
    expect(
      (await api.get(`${base}/teammates/${brody.id}/baseline`)).body.rejection.recentRate,
    ).toBeGreaterThan(0.8);
  });
});
