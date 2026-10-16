import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addTeammate, seedCompany, startTestBoard, type TestBoard } from "./helpers.js";

let board: TestBoard;

beforeAll(async () => {
  board = await startTestBoard();
});
afterAll(async () => {
  await board.destroy();
});

describe("companies and memberships", () => {
  it("creating a company makes the creator its owner and records events", async () => {
    const { api, companyId, base } = await seedCompany(board, "c1@example.com");
    const list = await api.get("/api/companies");
    expect(list.body.map((c: any) => c.id)).toContain(companyId);
    expect(list.body[0].role).toBe("owner");

    const events = await api.get(`${base}/events`);
    expect(events.status).toBe(200);
    // Peter is seated with the company (M4).
    expect(events.body.map((e: any) => e.type)).toEqual([
      "teammate.created",
      "membership.granted",
      "company.created",
    ]);
    expect(events.body[2].seq).toBe(1);
    expect(events.body[0].seq).toBe(3);
    expect(events.body[0].payload.name).toBe("Peter");
  });

  it("non-members are refused and cannot see the company", async () => {
    const { companyId, base } = await seedCompany(board, "c2@example.com");
    const stranger = await board.login("stranger@example.com");
    const api = board.api(stranger.token);
    expect((await api.get(base)).status).toBe(403);
    expect((await api.get("/api/companies")).body.map((c: any) => c.id)).not.toContain(companyId);
  });

  it("viewers read but cannot mutate; admins can; only owners grant owner", async () => {
    const { api, base } = await seedCompany(board, "c3@example.com");
    expect((await api.post(`${base}/members`, { email: "viewer@example.com", role: "viewer" })).status).toBe(
      201,
    );
    expect((await api.post(`${base}/members`, { email: "admin@example.com", role: "admin" })).status).toBe(
      201,
    );

    const viewer = board.api((await board.login("viewer@example.com")).token);
    expect((await viewer.get(base)).status).toBe(200);
    expect((await viewer.patch(base, { name: "Nope" })).status).toBe(403);
    expect((await viewer.post(`${base}/projects`, { name: "Nope" })).status).toBe(403);

    const admin = board.api((await board.login("admin@example.com")).token);
    expect((await admin.patch(base, { name: "GTM Studio Ltd" })).status).toBe(200);
    expect(
      (await admin.post(`${base}/members`, { email: "second-owner@example.com", role: "owner" })).status,
    ).toBe(403);
    expect(
      (await api.post(`${base}/members`, { email: "second-owner@example.com", role: "owner" })).status,
    ).toBe(201);
  });

  it("keeps at least one owner", async () => {
    const { api, owner, base } = await seedCompany(board, "c4@example.com");
    expect((await api.del(`${base}/members/${owner.userId}`)).status).toBe(409);
  });

  it("teammates act as themselves: same guard, teammate role, no company creation", async () => {
    const { api, base } = await seedCompany(board, "c5@example.com");
    const cody = await addTeammate(api, base, "Cody");
    const minted = await api.post(`${base}/teammates/${cody.id}/tokens`, { label: "test" });
    expect(minted.status).toBe(201);
    expect(typeof minted.body.token).toBe("string");

    const asCody = board.api(minted.body.token);
    const me = await asCody.get("/api/auth/me");
    expect(me.body.actor).toEqual({ kind: "teammate", id: cody.id });
    expect(me.body.memberships[0].role).toBe("teammate");

    expect((await asCody.post("/api/companies", { name: "Rogue Co" })).status).toBe(403);
    expect((await asCody.post(`${base}/teammates`, { name: "Clone", role: "x", model: "m" })).status).toBe(
      403,
    );
    expect((await asCody.post(`${base}/departments`, { name: "Shadow" })).status).toBe(403);
    const project = await asCody.post(`${base}/projects`, { name: "Cody's project" });
    expect(project.status).toBe(201);

    // The token is scoped to its company: another company is invisible.
    const other = await seedCompany(board, "c6@example.com");
    expect((await asCody.get(other.base)).status).toBe(403);
  });

  it("keeps the office layout in the company settings: slots, colours and desk cells, and nothing else", async () => {
    const { api, base } = await seedCompany(board, "c8@example.com");
    const office = { rooms: { none: { slot: 0, color: "#e6f2ec" } }, desks: { "t-1": { col: 2, row: 1 } } };
    const ok = await api.patch(base, { settings: { office } });
    expect(ok.status).toBe(200);
    expect(ok.body.settings.office).toEqual(office);
    const bad = await api.patch(base, {
      settings: { office: { desks: { "t-1": { col: "left", row: 0 } } } },
    });
    expect(bad.status).toBe(400);
    const off = await api.patch(base, { settings: { office: { rooms: { none: { color: "green" } } } } });
    expect(off.status).toBe(400);
    expect((await api.get(base)).body.settings.office).toEqual(office);
  });

  it("rejects raw secret material at the write boundary", async () => {
    const { api, base } = await seedCompany(board, "c7@example.com");
    const res = await api.patch(base, {
      settings: { n8nApiKey: "sk-live-0123456789abcdef0123456789abcdef" },
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/secret/);
    expect(JSON.stringify(res.body)).not.toContain("sk-live");
  });
});
