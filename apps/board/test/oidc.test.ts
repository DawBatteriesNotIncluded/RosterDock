// Single sign-on through OpenID Connect against a fake provider: the
// authorization-code flow with PKCE, the id_token verified, memberships from
// the email claim, and every way a sign-in is refused.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkClaims, resetOidcCaches, safeReturnTo, verifyJwt } from "../src/auth/oidc.js";
import { startTestBoard, type TestBoard } from "./helpers.js";
import { createOidcFake, type OidcFake } from "./oidc-fake.js";

const CLIENT_ID = "rosterdock-board";
const CLIENT_SECRET = "s3cret-for-tests-only";

let board: TestBoard;
let idp: OidcFake;

beforeAll(async () => {
  idp = createOidcFake({
    endSession: true,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  });
  board = await startTestBoard(
    {
      devLogin: false,
      oidc: {
        issuer: idp.issuer,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        tokenAuth: "basic",
        scopes: "openid email profile",
        displayName: "Acme SSO",
        allowedDomains: ["example.com", "acme.test"],
      },
    },
    { oidcFetch: idp.fetch },
  );
});
afterAll(async () => {
  await board.destroy();
});
beforeEach(() => {
  resetOidcCaches();
});

/** The browser's round trip: start at the board, authorize at the provider, come back with the code. */
async function signIn(who: Parameters<OidcFake["authorize"]>[1], returnTo?: string) {
  const start = await board.app.inject({
    method: "GET",
    url: `/api/auth/oidc/start${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`,
  });
  expect(start.statusCode).toBe(302);
  const authorizeUrl = start.headers.location as string;
  const callback = idp.authorize(authorizeUrl, who);
  const back = await board.app.inject({ method: "GET", url: callback.replace("http://rosterdock.test", "") });
  return { start, authorizeUrl, back };
}

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return String(first ?? "").split(";")[0] ?? "";
}

describe("oidc sign-in", () => {
  it("the sign-in page learns what is on offer without signing in", async () => {
    const res = await board.app.inject({ method: "GET", url: "/api/auth/providers" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      devLogin: false,
      oidc: { name: "Acme SSO", startUrl: "/api/auth/oidc/start" },
    });
    const dev = await board.app.inject({
      method: "POST",
      url: "/api/auth/dev-login",
      payload: { email: "x@example.com" },
    });
    expect(dev.statusCode).toBe(404);
  });

  it("start redirects to the provider with state, nonce and a PKCE challenge, and records the attempt", async () => {
    const start = await board.app.inject({ method: "GET", url: "/api/auth/oidc/start?returnTo=/approvals" });
    expect(start.statusCode).toBe(302);
    const u = new URL(start.headers.location as string);
    expect(u.origin + u.pathname).toBe(`${idp.issuer}/o/oauth2/v2/auth`);
    expect(u.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(u.searchParams.get("redirect_uri")).toBe("http://rosterdock.test/api/auth/oidc/callback");
    expect(u.searchParams.get("scope")).toBe("openid email profile");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const state = u.searchParams.get("state")!;
    const row = (
      await board.db.query<{ nonce: string; return_to: string }>(
        "SELECT nonce, return_to FROM oidc_logins WHERE state = $1",
        [state],
      )
    ).rows[0]!;
    expect(row.return_to).toBe("/approvals");
    expect(u.searchParams.get("nonce")).toBe(row.nonce);
    // The provider's discovery document was fetched by the board, from the issuer.
    expect(idp.calls.some((c) => c.url === `${idp.issuer}/.well-known/openid-configuration`)).toBe(true);
  });

  it("a verified id_token becomes a user, a session cookie and a redirect home", async () => {
    const { back, authorizeUrl } = await signIn(
      { sub: "sub-alice", email: "alice@example.com", name: "Alice Adams" },
      "/costs",
    );
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe("http://rosterdock.test/costs");
    const cookie = cookieOf(back);
    expect(cookie).toMatch(/^rosterdock_session=/);
    const me = await board.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    const body = JSON.parse(me.body);
    expect(body.user.email).toBe("alice@example.com");
    expect(body.user.name).toBe("Alice Adams");
    expect(body.user.profile).toEqual({});
    // The standard profile claims ride along and follow the provider on the next sign-in; a picture only over https.
    const second = await signIn(
      {
        sub: "sub-alice",
        email: "alice@example.com",
        name: "Alice Adams",
        claims: {
          picture: "https://idp.test/alice.png",
          preferred_username: "alice",
          given_name: "Alice",
          family_name: "Adams",
          locale: "en-GB",
        },
      },
      "/",
    );
    const me2 = JSON.parse(
      (
        await board.app.inject({
          method: "GET",
          url: "/api/auth/me",
          headers: { cookie: cookieOf(second.back) },
        })
      ).body,
    );
    expect(me2.user.id).toBe(body.user.id);
    expect(me2.user.profile).toEqual({
      picture: "https://idp.test/alice.png",
      preferredUsername: "alice",
      givenName: "Alice",
      familyName: "Adams",
      locale: "en-GB",
    });
    const third = await signIn(
      {
        sub: "sub-alice",
        email: "alice@example.com",
        name: "Alice Adams",
        claims: { picture: "http://idp.test/plain.png", locale: "fr" },
      },
      "/",
    );
    const me3 = JSON.parse(
      (
        await board.app.inject({
          method: "GET",
          url: "/api/auth/me",
          headers: { cookie: cookieOf(third.back) },
        })
      ).body,
    );
    expect(me3.user.profile).toEqual({ locale: "fr" });
    const user = (
      await board.db.query<{ oidc_subject: string }>("SELECT oidc_subject FROM users WHERE id = $1", [
        body.user.id,
      ])
    ).rows[0]!;
    expect(user.oidc_subject).toBe("sub-alice");
    // The token exchange carried the client secret as HTTP basic auth and the PKCE verifier, never in a URL.
    const exchange = idp.calls.find((c) => c.method === "POST")!;
    expect(exchange.authorization).toMatch(/^Basic /);
    expect(exchange.body).toContain("code_verifier=");
    expect(exchange.body).not.toContain("client_secret");
    // The attempt was consumed: nothing from the provider is stored beyond the subject.
    const state = new URL(authorizeUrl).searchParams.get("state");
    const logins = await board.db.query("SELECT count(*)::int AS n FROM oidc_logins WHERE state = $1", [
      state,
    ]);
    expect(logins.rows[0].n).toBe(0);
  });

  it("signing out ends the session and points at the provider's end_session_endpoint", async () => {
    const { back } = await signIn({ sub: "sub-out", email: "out@example.com", name: "Olive Out" });
    const cookie = cookieOf(back);
    const out = await board.app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    expect(out.statusCode).toBe(200);
    const body = JSON.parse(out.body) as { ok: boolean; signOutUrl: string | null };
    const url = new URL(body.signOutUrl!);
    expect(`${url.origin}${url.pathname}`).toBe(`${idp.issuer}/logout`);
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("post_logout_redirect_uri")).toBe("http://rosterdock.test/");
    expect(out.headers["set-cookie"]).toMatch(/rosterdock_session=;/);
    // The session is gone here whatever the provider does next.
    expect(
      (await board.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } })).statusCode,
    ).toBe(401);
  });

  it("memberships come from the email claim: an invited person signs in as the user the owner named", async () => {
    const owner = await signIn({ sub: "sub-owner", email: "owner@example.com", name: "Daniel" });
    const ownerToken = cookieOf(owner.back).replace("rosterdock_session=", "");
    const api = board.api(ownerToken);
    const created = await api.post("/api/companies", { name: "GTM Studio", template: "GTM company" });
    expect(created.status).toBe(201);
    const companyId = created.body.id as string;
    const invite = await api.post(`/api/companies/${companyId}/members`, {
      email: "Bob@Example.com",
      role: "reviewer",
    });
    expect(invite.status).toBe(201);
    const { back } = await signIn({ sub: "sub-bob", email: "bob@example.com", name: "Bob" });
    const me = await board.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: cookieOf(back) },
    });
    const body = JSON.parse(me.body);
    expect(body.memberships).toEqual([{ companyId, role: "reviewer", companyName: "GTM Studio" }]);
    expect(body.user.email).toBe("Bob@Example.com");
    // Signing in again finds the same user by subject.
    const again = await signIn({ sub: "sub-bob", email: "bob@example.com", name: "Robert" });
    const me2 = JSON.parse(
      (
        await board.app.inject({
          method: "GET",
          url: "/api/auth/me",
          headers: { cookie: cookieOf(again.back) },
        })
      ).body,
    );
    expect(me2.user.id).toBe(body.user.id);
    expect(me2.user.name).toBe("Robert");
  });

  it("refuses a state it did not issue, a replayed state, and an email outside the allowed domains", async () => {
    const forged = await board.app.inject({
      method: "GET",
      url: "/api/auth/oidc/callback?code=x&state=nope",
    });
    expect(forged.statusCode).toBe(302);
    expect(forged.headers.location).toBe("http://rosterdock.test/?auth_error=state");
    expect(forged.headers["set-cookie"]).toBeUndefined();

    const { back, authorizeUrl } = await signIn({ sub: "sub-carol", email: "carol@example.com" });
    expect(back.headers.location).toBe("http://rosterdock.test/");
    // The same callback URL a second time: the attempt was consumed.
    const replay = await board.app.inject({
      method: "GET",
      url: idp
        .authorize(authorizeUrl, { sub: "sub-carol", email: "carol@example.com" })
        .replace("http://rosterdock.test", ""),
    });
    expect(replay.headers.location).toBe("http://rosterdock.test/?auth_error=state");

    const outsider = await signIn({ sub: "sub-eve", email: "eve@elsewhere.net" });
    expect(outsider.back.headers.location).toBe("http://rosterdock.test/?auth_error=domain");
    expect(
      (await board.db.query("SELECT 1 FROM users WHERE lower(email) = 'eve@elsewhere.net'")).rowCount,
    ).toBe(0);

    const unverified = await signIn({ sub: "sub-frank", email: "frank@example.com", emailVerified: false });
    expect(unverified.back.headers.location).toBe("http://rosterdock.test/?auth_error=email");

    const denied = await board.app.inject({
      method: "GET",
      url: "/api/auth/oidc/callback?error=access_denied&state=x",
    });
    expect(denied.headers.location).toBe("http://rosterdock.test/?auth_error=denied");
  });

  it("refuses a token whose nonce or audience is not this sign-in's", async () => {
    const wrongNonce = await signIn({ sub: "sub-g", email: "g@example.com", claims: { nonce: "other" } });
    expect(wrongNonce.back.headers.location).toBe("http://rosterdock.test/?auth_error=token");
    const wrongAud = await signIn({ sub: "sub-h", email: "h@example.com", claims: { aud: "someone-else" } });
    expect(wrongAud.back.headers.location).toBe("http://rosterdock.test/?auth_error=token");
    expect(
      (await board.db.query("SELECT 1 FROM users WHERE oidc_subject IN ('sub-g', 'sub-h')")).rowCount,
    ).toBe(0);
  });

  it("survives the provider rotating its keys", async () => {
    idp.rotateKey();
    const { back } = await signIn({ sub: "sub-rot", email: "rot@acme.test" });
    expect(back.headers.location).toBe("http://rosterdock.test/");
  });
});

describe("id_token verification (pure)", () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "https://id.example.test",
    sub: "s",
    aud: CLIENT_ID,
    exp: nowSeconds + 60,
    nonce: "n",
  };
  let keys: JsonWebKey[];
  beforeAll(async () => {
    const res = await idp.fetch(`${idp.issuer}/keys/oauth2/v3/certs`);
    keys = ((await res.json()) as { keys: JsonWebKey[] }).keys;
  });

  it("accepts the provider's signature and rejects a stranger's, a tampered payload and alg none", () => {
    expect(verifyJwt(idp.signIdToken(claims), keys).sub).toBe("s");
    expect(() => verifyJwt(idp.signIdToken(claims, true), keys)).toThrow(/does not verify|no provider key/);
    const [h, , s] = idp.signIdToken(claims).split(".");
    const tampered = `${h}.${Buffer.from(JSON.stringify({ ...claims, sub: "admin" })).toString("base64url")}.${s}`;
    expect(() => verifyJwt(tampered, keys)).toThrow(/does not verify/);
    const none = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`;
    expect(() => verifyJwt(none, keys)).toThrow(/unsupported algorithm/);
  });

  it("checks issuer, audience, expiry and nonce", () => {
    const expect_ = { issuer: "https://id.example.test", clientId: CLIENT_ID, nonce: "n", nowSeconds };
    expect(() => checkClaims(claims, expect_)).not.toThrow();
    expect(() => checkClaims({ ...claims, iss: "https://evil.test" }, expect_)).toThrow(/someone else/);
    expect(() => checkClaims({ ...claims, aud: ["x", "y"] }, expect_)).toThrow(/another client/);
    expect(() => checkClaims({ ...claims, aud: ["x", CLIENT_ID] }, expect_)).not.toThrow();
    expect(() => checkClaims({ ...claims, exp: nowSeconds - 120 }, expect_)).toThrow(/expired/);
    expect(() => checkClaims({ ...claims, nonce: "m" }, expect_)).toThrow(/match this sign-in/);
  });
});

describe("where a sign-in or an authorisation returns to", () => {
  it("is a path on the board, never another site, however it is spelled", () => {
    expect(safeReturnTo("/approvals?x=1")).toBe("/approvals?x=1");
    for (const off of [
      "//evil.example/x",
      "/\\evil.example",
      "/\t/evil.example/x",
      "/\n/evil.example",
      "https://evil.example",
      7,
    ])
      expect(safeReturnTo(off), JSON.stringify(off)).toBe("/");
    // What a URL parser makes of the tab is why it is refused.
    expect(new URL("/\t/evil.example/x", "https://board.example").host).toBe("evil.example");
  });
});
