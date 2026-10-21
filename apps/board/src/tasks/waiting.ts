// Who a blocked task waits on, made true where the blocker is set: a run's
// report, a move, the board MCP's board_set_blocker. A teammate named by id or
// by handle is that teammate, stored by id and handle. A name that is no
// teammate here (a role such as "@manager", a person's first name) is a
// person: the task waits on a person and Peter tells one, instead of waiting
// on a teammate nobody can chase.

import { blockerFor, type BlockerRecord } from "@rosterdock/shared";
import type { Queryable } from "../db/pool.js";

export interface NamedTeammate {
  id: string;
  handle: string;
  name: string;
}

/** The teammate a blocker names, in this company: by its id, or by its handle with or without the @. */
export async function teammateNamed(
  db: Queryable,
  companyId: string,
  ref: { id: string; name?: string },
): Promise<NamedTeammate | null> {
  const handle = (ref.name ?? ref.id).trim().replace(/^@/, "").toLowerCase();
  const res = await db.query<NamedTeammate>(
    `SELECT id, handle, name FROM teammates WHERE company_id = $1 AND (id::text = $2 OR handle = $3)
     ORDER BY (id::text = $2) DESC LIMIT 1`,
    [companyId, ref.id, handle],
  );
  return res.rows[0] ?? null;
}

/** The blocker as it is stored: a wait on a teammate who exists, or a wait on a person. */
export async function settleWaitingOn(
  db: Queryable,
  companyId: string,
  blocker: BlockerRecord,
): Promise<BlockerRecord> {
  const w = blocker.waitingOn;
  if (w?.kind !== "teammate") return blocker;
  const target = await teammateNamed(db, companyId, w);
  if (target) return { ...blocker, waitingOn: { kind: "teammate", id: target.id, name: target.handle } };
  const { waitingOn: _unknown, ...rest } = blocker;
  if (blocker.code !== "waiting_on_teammate") return rest;
  const said = (w.name ?? w.id).trim().replace(/^@/, "");
  return blockerFor("waiting_on_person", {
    // The teammate's own words, unless it gave none.
    ...(rest.what !== blockerFor("waiting_on_teammate").what ? { what: rest.what } : {}),
    why: `@${said} is not a teammate here, so a person has to answer.`,
  });
}
