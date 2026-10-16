// Tokens are random, shown once, and stored only as sha256. Sessions carry a
// user; api_tokens carry a user or a teammate scoped to one company.

import { randomBytes } from "node:crypto";
import { sha256Hex, type ActorRef } from "@rosterdock/shared";
import type { Queryable } from "../db/pool.js";

export const SESSION_COOKIE = "rosterdock_session";

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export interface UserRow {
  id: string;
  email: string;
  name: string;
  oidc_subject: string | null;
  /** What the provider last said about the person (picture, username, names, locale); {} for a dev login. */
  profile?: Record<string, unknown> | null;
}

export interface TeammateRow {
  id: string;
  company_id: string;
  name: string;
  handle: string;
  role: string;
}

export type Principal =
  | { kind: "user"; actor: ActorRef; user: UserRow }
  | {
      kind: "teammate";
      actor: ActorRef;
      teammate: TeammateRow;
      tokenCompanyId: string;
      /** Set when the token was minted for one run; worker routes require it to match. */
      runId: string | null;
      /** What the token was minted for beyond the API: `manager` reaches the MCP server outside a run. */
      scopes: string[];
    };

export type SessionProvider = "dev" | "oidc";

export async function createSession(
  db: Queryable,
  userId: string,
  ttlSeconds: number,
  provider: SessionProvider = "dev",
): Promise<string> {
  const token = newToken();
  await db.query(
    "INSERT INTO sessions (user_id, token_hash, expires_at, provider) VALUES ($1, $2, now() + ($3 || ' seconds')::interval, $4)",
    [userId, sha256Hex(token), String(ttlSeconds), provider],
  );
  return token;
}

/** Ends the session; says how it was opened, or null when there was none. */
export async function deleteSession(db: Queryable, token: string): Promise<SessionProvider | null> {
  const res = await db.query<{ provider: SessionProvider }>(
    "DELETE FROM sessions WHERE token_hash = $1 RETURNING provider",
    [sha256Hex(token)],
  );
  return res.rows[0]?.provider ?? null;
}

export async function resolveSession(db: Queryable, token: string): Promise<Principal | null> {
  const res = await db.query<UserRow>(
    `SELECT u.id, u.email, u.name, u.oidc_subject, u.profile FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256Hex(token)],
  );
  const user = res.rows[0];
  if (!user) return null;
  return { kind: "user", actor: { kind: "user", id: user.id }, user };
}

export async function resolveApiToken(db: Queryable, token: string): Promise<Principal | null> {
  const hash = sha256Hex(token);
  const res = await db.query<{
    id: string;
    company_id: string;
    actor_kind: "user" | "teammate";
    actor_id: string;
    run_id: string | null;
    scopes: string[] | null;
  }>(
    "SELECT id, company_id, actor_kind, actor_id, run_id, scopes FROM api_tokens WHERE token_hash = $1 AND expires_at > now()",
    [hash],
  );
  const row = res.rows[0];
  if (!row) return null;
  void db.query("UPDATE api_tokens SET last_used_at = now() WHERE id = $1", [row.id]).catch(() => {});
  if (row.actor_kind === "teammate") {
    const t = await db.query<TeammateRow>(
      "SELECT id, company_id, name, handle, role FROM teammates WHERE id = $1 AND company_id = $2",
      [row.actor_id, row.company_id],
    );
    const teammate = t.rows[0];
    if (!teammate) return null;
    return {
      kind: "teammate",
      actor: { kind: "teammate", id: teammate.id },
      teammate,
      tokenCompanyId: row.company_id,
      runId: row.run_id,
      scopes: Array.isArray(row.scopes) ? row.scopes.filter((s) => typeof s === "string") : [],
    };
  }
  const u = await db.query<UserRow>(
    "SELECT id, email, name, oidc_subject, profile FROM users WHERE id = $1",
    [row.actor_id],
  );
  const user = u.rows[0];
  if (!user) return null;
  return { kind: "user", actor: { kind: "user", id: user.id }, user };
}

export async function mintApiToken(
  db: Queryable,
  input: {
    companyId: string;
    actor: ActorRef;
    ttlSeconds: number;
    label?: string;
    createdByUserId?: string;
    runId?: string;
    scopes?: string[];
  },
): Promise<{ token: string; id: string; expiresAt: string }> {
  const token = newToken();
  const res = await db.query<{ id: string; expires_at: Date }>(
    `INSERT INTO api_tokens (company_id, actor_kind, actor_id, token_hash, label, expires_at, created_by_user_id, run_id, scopes)
     VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' seconds')::interval, $7, $8, $9) RETURNING id, expires_at`,
    [
      input.companyId,
      input.actor.kind,
      input.actor.id,
      sha256Hex(token),
      input.label ?? null,
      String(input.ttlSeconds),
      input.createdByUserId ?? null,
      input.runId ?? null,
      JSON.stringify(input.scopes ?? []),
    ],
  );
  const row = res.rows[0]!;
  return { token, id: row.id, expiresAt: row.expires_at.toISOString() };
}
