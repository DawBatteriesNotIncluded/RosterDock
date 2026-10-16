import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestBoard, type TestBoard } from "./helpers.js";

let board: TestBoard;

beforeAll(async () => {
  board = await startTestBoard();
});
afterAll(async () => {
  await board.destroy();
});

describe("auth", () => {
  it("health and ready are public", async () => {
    const anon = board.api("");
    expect((await anon.get("/api/health")).status).toBe(200);
    expect((await anon.get("/api/ready")).status).toBe(200);
  });

  it("everything else needs a sign-in", async () => {
    const res = await board.app.inject({ method: "GET", url: "/api/companies" });
    expect(res.statusCode).toBe(401);
  });

  it("dev login creates the user once, sets a cookie and returns a bearer token", async () => {
    const first = await board.app.inject({
      method: "POST",
      url: "/api/auth/dev-login",
      payload: { email: "Dan@Example.com", name: "Daniel" },
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers["set-cookie"]).toMatch(/rosterdock_session=/);
    const second = await board.app.inject({
      method: "POST",
      url: "/api/auth/dev-login",
      payload: { email: "dan@example.com" },
    });
    expect(JSON.parse(second.body).user.id).toBe(JSON.parse(first.body).user.id);

    const me = await board.api(JSON.parse(first.body).token).get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe("Dan@Example.com");
    expect(me.body.actor.kind).toBe("user");

    const cookie = String(first.headers["set-cookie"]).split(";")[0];
    const viaCookie = await board.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(viaCookie.statusCode).toBe(200);
  });

  it("logout invalidates the session; a dev session has no provider to sign out of", async () => {
    const { token } = await board.login("bye@example.com");
    const out = await board.api(token).post("/api/auth/logout");
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true, signOutUrl: null });
    expect((await board.api(token).get("/api/auth/me")).status).toBe(401);
  });

  it("rejects a dev login body carrying a secret-shaped name", async () => {
    const res = await board.app.inject({
      method: "POST",
      url: "/api/auth/dev-login",
      payload: { email: "x@example.com", name: "sk-abcdefghijklmnopqrstuvwxyz012345" },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe("dev login off", () => {
  it("returns 404 when ROSTERDOCK_DEV_LOGIN is not set", async () => {
    const other = await startTestBoard({ devLogin: false });
    try {
      const res = await other.app.inject({
        method: "POST",
        url: "/api/auth/dev-login",
        payload: { email: "x@example.com" },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await other.destroy();
    }
  });
});
