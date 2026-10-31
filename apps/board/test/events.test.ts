import http from "node:http";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerGuard } from "../src/auth/guard.js";
import { mutate } from "../src/mutate.js";
import { addProject, seedCompany, startTestBoard, type TestBoard } from "./helpers.js";

let board: TestBoard;

beforeAll(async () => {
  board = await startTestBoard();
});
afterAll(async () => {
  await board.destroy();
});

function parseSse(text: string): { id: number; event: string; data: any }[] {
  return text
    .split("\n\n")
    .filter((chunk) => chunk.includes("data:"))
    .map((chunk) => {
      const lines = chunk.split("\n");
      const get = (k: string) =>
        lines
          .find((l) => l.startsWith(`${k}:`))
          ?.slice(k.length + 1)
          .trim() ?? "";
      return { id: Number(get("id")), event: get("event"), data: JSON.parse(get("data")) };
    });
}

describe("event stream", () => {
  it("lists newest first, replays after a seq, and filters by subject", async () => {
    const { api, base } = await seedCompany(board, "e1@example.com");
    const project = await addProject(api, base);
    const task = (await api.post(`${base}/tasks`, { projectId: project.id, title: "x" })).body;
    await api.post(`${base}/tasks/${task.id}/move`, { status: "doing" });

    const recent = await api.get(`${base}/events`);
    expect(recent.body[0].type).toBe("task.moved");
    const seqs = recent.body.map((e: any) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));

    const after = await api.get(`${base}/events?afterSeq=3`);
    expect(after.body.map((e: any) => e.type)).toEqual(["project.created", "task.created", "task.moved"]);

    const forTask = await api.get(`${base}/events?subjectKind=task&subjectId=${task.id}`);
    expect(forTask.body.map((e: any) => e.type)).toEqual(["task.created", "task.moved"]);
  });

  it("the SSE tail replays the backlog and then delivers live events, once each, per company", async () => {
    const { api, base, companyId } = await seedCompany(board, "e2@example.com");
    const other = await seedCompany(board, "e2b@example.com");

    // Backlog only, then close: ?once=1
    const snapshot = await board.app.inject({
      method: "GET",
      url: `${base}/events/stream?once=1`,
      headers: { authorization: `Bearer ${(await board.login("e2@example.com")).token}` },
    });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.headers["content-type"]).toMatch(/text\/event-stream/);
    const backlog = parseSse(snapshot.body);
    expect(backlog.map((e) => e.event)).toEqual([
      "company.created",
      "membership.granted",
      "teammate.created",
    ]);
    expect(backlog.every((e) => e.data.companyId === companyId)).toBe(true);

    // Live: open the stream from seq 2, write events in both companies, read what arrives.
    const token = (await board.login("e2@example.com")).token;
    const stream = await board.app.inject({
      method: "GET",
      url: `${base}/events/stream`,
      headers: { authorization: `Bearer ${token}`, "last-event-id": "3" },
      payloadAsStream: true,
    });
    expect(stream.statusCode).toBe(200);
    const reader = stream.stream();
    const chunks: string[] = [];
    reader.on("data", (c: Buffer) => chunks.push(c.toString()));

    const project = await addProject(api, base, "Live project");
    await other.api.post(`${other.base}/projects`, { name: "Other company project" });
    const task = await api.post(`${base}/tasks`, { projectId: project.id, title: "Live task" });
    expect(task.status).toBe(201);

    const lastSeq = (await api.get(`${base}/events`)).body[0].seq as number;
    await board.bus.waitFor(companyId, lastSeq);
    await new Promise((r) => setTimeout(r, 50));
    reader.destroy();

    const got = parseSse(chunks.join(""));
    expect(got.map((e) => e.event)).toEqual(["project.created", "task.created"]);
    expect(got.every((e) => e.data.companyId === companyId)).toBe(true);
    expect(got.map((e) => e.id)).toEqual([4, 5]);
  });
});

describe("every mutating company route", () => {
  it("declares a permission action (the guard fails closed otherwise)", async () => {
    // A mutating company route without config.action would 500 for an owner; each change appends an event.
    const { api, base, companyId } = await seedCompany(board, "g1@example.com");
    const events = async () =>
      Number(
        (
          await board.db.query<{ n: string }>("SELECT count(*) AS n FROM events WHERE company_id = $1", [
            companyId,
          ])
        ).rows[0]!.n,
      );
    const project = await addProject(api, base);
    const task = (await api.post(`${base}/tasks`, { projectId: project.id, title: "x" })).body;
    const probes: [string, string, unknown][] = [
      ["PATCH", base, { name: "Renamed" }],
      ["POST", `${base}/members`, { email: "p@example.com", role: "viewer" }],
      ["POST", `${base}/departments`, { name: "D" }],
      ["POST", `${base}/teammates`, { name: "T", role: "r", model: "m" }],
      ["POST", `${base}/projects`, { name: "P" }],
      ["POST", `${base}/tasks`, { projectId: project.id, title: "y" }],
      ["PATCH", `${base}/tasks/${task.id}`, { title: "z" }],
      ["POST", `${base}/tasks/${task.id}/move`, { status: "doing" }],
      ["POST", `${base}/tasks/${task.id}/messages`, { body: "hello" }],
    ];
    for (const [method, url, body] of probes) {
      const before = await events();
      const res = await board.app.inject({
        method: method as "POST",
        url,
        headers: { authorization: `Bearer ${(await board.login("g1@example.com")).token}` },
        payload: body,
      });
      expect(res.statusCode, `${method} ${url}`).toBeLessThan(300);
      expect(await events(), `${method} ${url} appended an event`).toBeGreaterThan(before);
    }
  });

  it("every company route refuses someone outside the company, at the guard", async () => {
    const { companyId } = await seedCompany(board, "g-owner@example.com");
    const outsider = await board.login("g-outsider@example.com", "Mallory");
    // Every route the board serves, read from Fastify's printed tree. The count keeps a change in the print's
    // format from passing with no routes at all.
    const stack: string[] = [];
    const routes: { method: string; url: string }[] = [];
    for (const line of board.app.printRoutes({ commonPrefix: false }).split("\n")) {
      const m = /^([│ ]*)[├└]── (\S+) \(([A-Z, ]+)\)$/.exec(line);
      if (!m) continue;
      stack.length = m[1]!.length / 4;
      stack.push(m[2]!);
      for (const method of m[3]!.split(", ")) routes.push({ method, url: stack.join("") });
    }
    const company = routes.filter((r) => r.url.includes("/:companyId") && r.method !== "HEAD");
    expect(company.length).toBeGreaterThan(100);
    for (const { method, url } of company) {
      const res = await board.app.inject({
        method: method as "GET",
        url: url.replace(":companyId", companyId).replace(/:\w+/g, "00000000-0000-4000-8000-000000000000"),
        headers: { authorization: `Bearer ${outsider.token}` },
        ...(method === "GET" || method === "DELETE" ? {} : { payload: {} }),
      });
      expect([res.statusCode, JSON.parse(res.body).error], `${method} ${url}`).toEqual([
        403,
        "not a member of this company",
      ]);
    }
  });

  it("fails closed on a company route that declares no permission", async () => {
    const app = Fastify();
    registerGuard(app, board.db);
    app.get("/api/companies/:companyId/unguarded", async () => ({ ok: true }));
    app.post("/api/companies/:companyId/unguarded", async () => ({ ok: true }));
    for (const method of ["GET", "POST"] as const) {
      const res = await app.inject({
        method,
        url: "/api/companies/c-1/unguarded",
        ...(method === "POST" ? { payload: {} } : {}),
      });
      expect(res.statusCode, method).toBe(500);
      expect(res.body, method).toMatch(/missing a permission action/);
    }
    await app.close();
  });

  it("rolls back a change that appends no event", async () => {
    const { owner, api, base, companyId } = await seedCompany(board, "g-rollback@example.com");
    const name = (await api.get(base)).body.name;
    await expect(
      mutate(board.db, companyId, { kind: "user", id: owner.userId }, async (ctx) => {
        await ctx.client.query("UPDATE companies SET name = 'Renamed with no event' WHERE id = $1", [
          companyId,
        ]);
      }),
    ).rejects.toThrow("mutation committed no event");
    expect((await api.get(base)).body.name).toBe(name);
  });

  it("ends open streams when the board shuts down, so shutting down does not wait on a browser tab", async () => {
    const own = await startTestBoard();
    const { owner, base } = await seedCompany(own, "e-close@example.com");
    const address = await own.app.listen({ host: "127.0.0.1", port: 0 });
    const res = await new Promise<http.IncomingMessage>((resolve, reject) =>
      http
        .get(
          `${address}${base}/events/stream`,
          { headers: { authorization: `Bearer ${owner.token}` } },
          resolve,
        )
        .on("error", reject),
    );
    expect(res.statusCode).toBe(200);
    const ended = new Promise<void>((resolve) => res.on("end", resolve).on("close", resolve));
    res.resume();
    const closed = own.close().then(() => "closed");
    try {
      const outcome = await Promise.race([
        closed,
        new Promise((resolve) => setTimeout(() => resolve("still waiting on the stream"), 3000)),
      ]);
      expect(outcome).toBe("closed");
      await ended;
    } finally {
      res.destroy();
      await closed;
      await own.db_.drop();
    }
  });
});
