// Resolving and validating actors within a company. An assignee, author or
// reviewer is either a company member (user) or a company teammate.

import type { ActorRef } from "@rosterdock/shared";
import type { Queryable } from "./db/pool.js";
import { HttpError } from "./http-error.js";

export interface ActorSummary extends ActorRef {
  name: string;
  handle: string | null;
  role: string;
}

export async function assertActorInCompany(
  db: Queryable,
  companyId: string,
  actor: ActorRef,
): Promise<ActorSummary> {
  if (actor.kind === "teammate") {
    const res = await db.query<{ name: string; handle: string; role: string }>(
      "SELECT name, handle, role FROM teammates WHERE id = $1 AND company_id = $2",
      [actor.id, companyId],
    );
    const row = res.rows[0];
    if (!row) throw new HttpError(422, "assignee teammate is not in this company");
    return { ...actor, name: row.name, handle: row.handle, role: row.role };
  }
  const res = await db.query<{ name: string; role: string }>(
    "SELECT u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.company_id = $1 AND m.user_id = $2",
    [companyId, actor.id],
  );
  const row = res.rows[0];
  if (!row) throw new HttpError(422, "assignee user is not a member of this company");
  return { ...actor, name: row.name, handle: null, role: row.role };
}

/** Name lookup for event payloads and UI labels. Never throws; unknown actors get a placeholder. */
export async function describeActor(
  db: Queryable,
  companyId: string,
  actor: ActorRef | null,
): Promise<ActorSummary | null> {
  if (!actor) return null;
  try {
    return await assertActorInCompany(db, companyId, actor);
  } catch {
    return { ...actor, name: "unknown", handle: null, role: "" };
  }
}
