// Authentication: resolves a Principal from the session cookie or a bearer
// token for every non-public route, and exposes the dev login when enabled.

import { bearerToken, DevLoginSchema } from "@rosterdock/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { BoardConfig } from "../config.js";
import type { Db } from "../db/pool.js";
import { HttpError } from "../http-error.js";
import { withTransaction } from "../db/pool.js";
import { companyCreationRefusal } from "../operator.js";
import { parseBody } from "../validate.js";
import {
  beginLogin,
  discover,
  finishLogin,
  OidcError,
  safeReturnTo,
  upsertOidcUser,
  type OidcDeps,
} from "./oidc.js";
import { createSession, deleteSession, resolveApiToken, resolveSession, SESSION_COOKIE } from "./tokens.js";

export function registerAuth(app: FastifyInstance, db: Db, config: BoardConfig, oidc: OidcDeps): void {
  /** Where the browser is: ROSTERDOCK_PUBLIC_URL, else the request's own origin (behind a trusted proxy). */
  const publicBase = (req: FastifyRequest): string => config.publicUrl ?? `${req.protocol}://${req.host}`;
  const setSessionCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: config.cookieSecure,
      maxAge: config.sessionTtlSeconds,
    });

  app.addHook("onRequest", async (req) => {
    if (req.routeOptions.config.public) return;
    const bearer = bearerToken(req.headers.authorization);
    const cookie = req.cookies[SESSION_COOKIE];
    const principal = bearer
      ? ((await resolveSession(db, bearer)) ?? (await resolveApiToken(db, bearer)))
      : cookie
        ? await resolveSession(db, cookie)
        : null;
    if (!principal) throw new HttpError(401, "sign in required");
    req.principal = principal;
  });

  app.post("/api/auth/dev-login", { config: { public: true } }, async (req, reply) => {
    if (!config.devLogin) throw new HttpError(404, "dev login is disabled");
    const body = parseBody(DevLoginSchema, req.body);
    const name = body.name ?? body.email.split("@")[0] ?? body.email;
    const { user, token } = await withTransaction(db, async (client) => {
      const res = await client.query<{ id: string; email: string; name: string }>(
        `INSERT INTO users (email, name) VALUES ($1, $2)
         ON CONFLICT ((lower(email))) DO UPDATE SET updated_at = now()
         RETURNING id, email, name`,
        [body.email, name],
      );
      const user = res.rows[0]!;
      const token = await createSession(client, user.id, config.sessionTtlSeconds);
      return { user, token };
    });
    setSessionCookie(reply, token);
    return { user, token };
  });

  // What the sign-in page offers. Names only; nothing here identifies the provider beyond its label.
  app.get("/api/auth/providers", { config: { public: true } }, async () => ({
    devLogin: config.devLogin,
    oidc: config.oidc ? { name: config.oidc.displayName, startUrl: "/api/auth/oidc/start" } : null,
  }));

  // OpenID Connect: the browser goes to the provider with a state, a nonce and a PKCE challenge the
  // board recorded, and comes back to the callback with a code the board exchanges server to server.
  app.get("/api/auth/oidc/start", { config: { public: true } }, async (req, reply) => {
    if (!config.oidc) throw new HttpError(404, "single sign-on is not configured");
    const base = publicBase(req);
    const returnTo = safeReturnTo((req.query as { returnTo?: unknown }).returnTo);
    const { url } = await beginLogin(db, config.oidc, oidc, {
      redirectUri: `${base}/api/auth/oidc/callback`,
      returnTo,
    });
    return reply.redirect(url, 302);
  });

  app.get("/api/auth/oidc/callback", { config: { public: true } }, async (req, reply) => {
    if (!config.oidc) throw new HttpError(404, "single sign-on is not configured");
    const base = publicBase(req);
    const q = req.query as { code?: string; state?: string; error?: string };
    const fail = (code: string) => reply.redirect(`${base}/?auth_error=${encodeURIComponent(code)}`, 302);
    if (q.error) return fail(q.error === "access_denied" ? "denied" : "provider");
    if (!q.code || !q.state) return fail("state");
    try {
      const identity = await finishLogin(db, config.oidc, oidc, {
        code: q.code,
        state: q.state,
        redirectUri: `${base}/api/auth/oidc/callback`,
      });
      const token = await withTransaction(db, async (client) => {
        const user = await upsertOidcUser(client, identity);
        return createSession(client, user.id, config.sessionTtlSeconds, "oidc");
      });
      setSessionCookie(reply, token);
      return reply.redirect(`${base}${identity.returnTo}`, 302);
    } catch (err) {
      if (err instanceof OidcError) {
        oidc.log.warn(`oidc sign-in refused (${err.code}): ${err.message}`);
        return fail(err.code);
      }
      throw err;
    }
  });

  app.get("/api/auth/me", { config: {} }, async (req) => {
    const p = req.principal;
    if (p.kind === "teammate") {
      return {
        actor: p.actor,
        teammate: {
          id: p.teammate.id,
          name: p.teammate.name,
          handle: p.teammate.handle,
          companyId: p.teammate.company_id,
        },
        memberships: [{ companyId: p.teammate.company_id, role: "teammate" }],
      };
    }
    const res = await db.query<{ company_id: string; role: string; name: string }>(
      `SELECT m.company_id, m.role, c.name FROM memberships m JOIN companies c ON c.id = m.company_id
       WHERE m.user_id = $1 ORDER BY c.created_at`,
      [p.actor.id],
    );
    return {
      actor: p.actor,
      user: { id: p.user.id, email: p.user.email, name: p.user.name, profile: p.user.profile ?? {} },
      memberships: res.rows.map((r) => ({ companyId: r.company_id, role: r.role, companyName: r.name })),
      // Whether the board would let this person found a company now, so the web offers it only then.
      mayCreateCompany: (await companyCreationRefusal(db, config, p.user.email)) === null,
    };
  });

  // Sign out here; for a session the identity provider opened, also where to sign out there
  // (RP-initiated logout: the provider's end_session_endpoint with this client and a way back).
  app.post("/api/auth/logout", { config: {} }, async (req, reply) => {
    const cookie = req.cookies[SESSION_COOKIE];
    const bearer = bearerToken(req.headers.authorization);
    const token = cookie ?? bearer;
    const provider = token ? await deleteSession(db, token) : null;
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    let signOutUrl: string | null = null;
    if (provider === "oidc" && config.oidc) {
      try {
        const doc = await discover(config.oidc, oidc);
        if (doc.end_session_endpoint) {
          const url = new URL(doc.end_session_endpoint);
          url.searchParams.set("client_id", config.oidc.clientId);
          url.searchParams.set("post_logout_redirect_uri", `${publicBase(req)}/`);
          signOutUrl = url.toString();
        }
      } catch (err) {
        oidc.log.warn(`provider sign-out skipped: ${(err as Error).message}`);
      }
    }
    return { ok: true, signOutUrl };
  });
}
