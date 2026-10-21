// The sign-in routes take a few requests a minute from one client address; nothing else is limited.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { startTestBoard, type TestBoard } from "./helpers.js";

let limited: TestBoard;
let unlimited: TestBoard;

beforeAll(async () => {
  [limited, unlimited] = await Promise.all([
    startTestBoard({ signInRateLimit: 3 }),
    startTestBoard({ signInRateLimit: 0 }),
  ]);
});
afterAll(async () => {
  await Promise.all([limited.destroy(), unlimited.destroy()]);
});

const devLogin = (board: TestBoard, email: string, from?: string) =>
  board.app.inject({
    method: "POST",
    url: "/api/auth/dev-login",
    payload: { email },
    ...(from ? { headers: { "x-forwarded-for": from } } : {}),
  });

describe("sign-in rate limit", () => {
  it("answers 429 with retry-after once a client passes the limit, and counts each client apart", async () => {
    const from = "203.0.113.7";
    for (let i = 0; i < 3; i++)
      expect((await devLogin(limited, `a${i}@example.com`, from)).statusCode).toBe(200);
    const over = await devLogin(limited, "a3@example.com", from);
    expect(over.statusCode).toBe(429);
    expect(Number(over.headers["retry-after"])).toBeGreaterThan(0);
    expect(JSON.parse(over.body).error).toMatch(/rate limit/i);
    // Another client, by the address the proxy in front of the board names.
    expect((await devLogin(limited, "b@example.com", "203.0.113.8")).statusCode).toBe(200);
  });

  it("counts each sign-in route on its own, and leaves signed-in routes alone", async () => {
    const from = "203.0.113.9";
    let token = "";
    for (let i = 0; i < 4; i++) {
      const res = await devLogin(limited, "c@example.com", from);
      if (res.statusCode === 200) token = JSON.parse(res.body).token;
    }
    expect((await devLogin(limited, "c@example.com", from)).statusCode).toBe(429);
    // Single sign-on is not configured here: the route answers for itself instead of the limiter.
    const start = await limited.app.inject({
      method: "GET",
      url: "/api/auth/oidc/start",
      headers: { "x-forwarded-for": from },
    });
    expect(start.statusCode).toBe(404);
    for (let i = 0; i < 10; i++) {
      const me = await limited.app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { authorization: `Bearer ${token}`, "x-forwarded-for": from },
      });
      expect(me.statusCode).toBe(200);
    }
  });

  it("0 turns it off", async () => {
    for (let i = 0; i < 10; i++)
      expect((await devLogin(unlimited, `d${i}@example.com`, "203.0.113.10")).statusCode).toBe(200);
  });

  it("reads ROSTERDOCK_SIGNIN_RATE_LIMIT: 60 by default, a whole number or 0", () => {
    const env = { DATABASE_URL: "postgres://board/rosterdock" };
    expect(loadConfig(env).signInRateLimit).toBe(60);
    expect(loadConfig({ ...env, ROSTERDOCK_SIGNIN_RATE_LIMIT: " 10 " }).signInRateLimit).toBe(10);
    expect(loadConfig({ ...env, ROSTERDOCK_SIGNIN_RATE_LIMIT: "0" }).signInRateLimit).toBe(0);
    for (const bad of ["-1", "1.5", "many"])
      expect(() => loadConfig({ ...env, ROSTERDOCK_SIGNIN_RATE_LIMIT: bad })).toThrow(
        "ROSTERDOCK_SIGNIN_RATE_LIMIT",
      );
  });
});
