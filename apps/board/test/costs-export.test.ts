// Costs as files: every run's usage as CSV, and the monthly report by project
// with chargeback tags, for a calendar month, priced with the table as it
// stands now.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addProject, addTeammate, seedCompany, startTestBoard, type Api, type TestBoard } from "./helpers.js";

let board: TestBoard;
beforeAll(async () => {
  board = await startTestBoard();
});
afterAll(async () => {
  await board.destroy();
});

async function runToCompletion(api: Api, base: string, taskId: string, usage: Record<string, number>) {
  const run = (await api.post(`${base}/tasks/${taskId}/runs`, {})).body;
  const job = (await board.db.query<{ job_id: string }>("SELECT job_id FROM runs WHERE id = $1", [run.id]))
    .rows[0]!.job_id;
  const claimed = await board.app.inject({
    method: "POST",
    url: "/api/worker/claim",
    headers: { "x-rosterdock-worker-token": "test-worker-token" },
    payload: { runId: run.id, jobId: job, workerId: "w" },
  });
  const token = JSON.parse(claimed.body).token as string;
  const done = await board
    .api(token)
    .post(`/api/worker/runs/${run.id}/complete`, { status: "completed", summary: "ok", usage });
  if (done.status !== 200) throw new Error(JSON.stringify(done.body));
  return run.id as string;
}

/** A small RFC 4180 reader: quoted cells may carry commas and doubled quotes. */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.trim().split("\r\n")) {
    const cells: string[] = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') {
          cell += '"';
          i++;
        } else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") {
        cells.push(cell);
        cell = "";
      } else cell += ch;
    }
    cells.push(cell);
    rows.push(cells);
  }
  return rows;
}

describe("costs export and the monthly report", () => {
  it("tags a project for chargeback, exports every run as CSV, and reports a month by project and tag", async () => {
    const { api, base, companyId } = await seedCompany(board, "ce1@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const acme = (
      await api.post(`${base}/projects`, {
        name: 'Acme, "phase 1"',
        client: "Acme",
        chargebackTag: "ACME-2026-Q3",
      })
    ).body;
    expect(acme.chargebackTag).toBe("ACME-2026-Q3");
    const internal = await addProject(api, base, "Gong digest");
    // The tag can be set and cleared later without touching anything else.
    const tagged = await api.patch(`${base}/projects/${internal.id}`, { chargebackTag: "INT" });
    expect(tagged.body.chargebackTag).toBe("INT");
    expect(tagged.body.client).toBe("Globex");
    const cleared = await api.patch(`${base}/projects/${internal.id}`, { chargebackTag: null });
    expect(cleared.body.chargebackTag).toBeNull();
    await api.put(`${base}/prices`, {
      model: "claude-sonnet-5",
      currency: "GBP",
      inputPerMillion: 240,
      outputPerMillion: 1200,
    });
    await api.put(`${base}/prices`, { model: "claude_code", currency: "GBP", seatPriceMonth: 20_000 });

    const t1 = (
      await api.post(`${base}/tasks`, {
        projectId: acme.id,
        title: "map",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    const t2 = (
      await api.post(`${base}/tasks`, {
        projectId: internal.id,
        title: "digest",
        assignee: { kind: "teammate", id: cody.id },
      })
    ).body;
    const r1 = await runToCompletion(api, base, t1.id, { inputTokens: 1_000_000, outputTokens: 1000 });
    const r2 = await runToCompletion(api, base, t2.id, { inputTokens: 500_000 });
    const r3 = await runToCompletion(api, base, t2.id, { inputTokens: 250_000 });
    // The third run happened last month.
    await board.db.query(
      "UPDATE run_usage SET created_at = date_trunc('month', now()) - interval '10 days' WHERE run_id = $1",
      [r3],
    );

    // Every run this month, one line each, priced now.
    const csv = await board.app.inject({
      method: "GET",
      url: `${base}/costs/export.csv?window=month`,
      headers: { authorization: `Bearer ${(await board.login("ce1@example.com")).token}` },
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toMatch(/^text\/csv/);
    expect(csv.headers["content-disposition"]).toMatch(/rosterdock-usage-month\.csv/);
    const rows = csvRows(csv.body);
    expect(rows[0]).toEqual([
      "date",
      "run_id",
      "task",
      "task_title",
      "teammate",
      "department",
      "project",
      "client",
      "chargeback_tag",
      "model",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "total_tokens",
      "cost",
      "currency",
      "kind",
      "goal",
    ]);
    expect(rows).toHaveLength(3);
    const line1 = rows.find((r) => r[1] === r1)!;
    // The project name carries a comma and quotes: quoted and doubled per RFC 4180.
    expect(csv.body).toContain('"Acme, ""phase 1"""');
    expect(line1.slice(9)).toEqual([
      "claude-sonnet-5",
      "1000000",
      "1000",
      "0",
      "0",
      "1001000",
      "2.41",
      "GBP",
      "run",
      "",
    ]);
    expect(line1[2]).toBe(`#${t1.number}`);
    expect(line1[4]).toBe("Cody");
    const line2 = rows.find((r) => r[1] === r2)!;
    expect(line2[6]).toBe("Gong digest");
    expect(line2[8]).toBe("");
    expect(line2[15]).toBe("1.20");

    // The monthly report, this month: the tagged project and the untagged one, totals, seats.
    const thisMonth = new Date().toISOString().slice(0, 7);
    const monthly = await api.get(`${base}/costs/monthly`);
    expect(monthly.status).toBe(200);
    const m = monthly.body;
    expect(m.month).toBe(thisMonth);
    expect(m.currency).toBe("GBP");
    expect(m.totals.tokens.total).toBe(1_501_000);
    expect(m.totals.costMinorUnits).toBe(241 + 120);
    expect(m.totals.runs).toBe(2);
    // Two teammates on the roster (Peter and Cody), both on claude_code seats.
    expect(m.totals.seatMinorUnits).toBe(40_000);
    expect(m.byProject.map((p: any) => [p.name, p.chargebackTag, p.runs, p.costMinorUnits])).toEqual([
      ['Acme, "phase 1"', "ACME-2026-Q3", 1, 241],
      ["Gong digest", null, 1, 120],
    ]);
    expect(m.byChargebackTag.map((t: any) => [t.tag, t.projects, t.costMinorUnits])).toEqual([
      ["ACME-2026-Q3", 1, 241],
      [null, 1, 120],
    ]);
    expect(m.byTeammate.find((t: any) => t.name === "Cody").runs).toBe(2);
    expect(m.byModel).toEqual([
      expect.objectContaining({ model: "claude-sonnet-5", runs: 2, costMinorUnits: 361 }),
    ]);
    expect(m.daily).toHaveLength(1);

    // Last month has the back-dated run only.
    const last = new Date();
    last.setUTCDate(1);
    last.setUTCMonth(last.getUTCMonth() - 1);
    const lastMonth = last.toISOString().slice(0, 7);
    const prev = (await api.get(`${base}/costs/monthly?month=${lastMonth}`)).body;
    expect(prev.month).toBe(lastMonth);
    expect(prev.totals.runs).toBe(1);
    expect(prev.totals.tokens.total).toBe(250_000);
    expect(prev.byProject.find((p: any) => p.name === "Gong digest").costMinorUnits).toBe(60);
    expect((await api.get(`${base}/costs/monthly?month=2026-13`)).status).toBe(400);

    // The chargeback CSV: one line per project for the month.
    const chargeback = await board.app.inject({
      method: "GET",
      url: `${base}/costs/monthly.csv?month=${thisMonth}`,
      headers: { authorization: `Bearer ${(await board.login("ce1@example.com")).token}` },
    });
    expect(chargeback.headers["content-disposition"]).toMatch(
      new RegExp(`rosterdock-chargeback-${thisMonth}\\.csv`),
    );
    const crow = csvRows(chargeback.body);
    expect(crow[0]).toEqual([
      "month",
      "project",
      "client",
      "chargeback_tag",
      "runs",
      "total_tokens",
      "cost",
      "currency",
    ]);
    expect(crow.find((r) => r[3] === "ACME-2026-Q3")?.slice(4)).toEqual(["1", "1001000", "2.41", "GBP"]);
    expect(crow.find((r) => r[1] === "Gong digest")?.slice(3)).toEqual(["", "1", "500000", "1.20", "GBP"]);

    // A viewer reads all of it; nobody outside the company does.
    const viewer = await board.login("ce1-viewer@example.com");
    await api.post(`${base}/members`, { email: "ce1-viewer@example.com", role: "viewer" });
    expect((await board.api(viewer.token).get(`${base}/costs/monthly`)).status).toBe(200);
    const stranger = await board.login("ce1-stranger@example.com");
    expect((await board.api(stranger.token).get(`/api/companies/${companyId}/costs/export.csv`)).status).toBe(
      403,
    );
  });
});
