// Codex teammates and the departments they sit in. Codex keeps to a department's tool list only as far as its
// own controls go (codexReach in @rosterdock/shared), and the worker refuses its runs under a list it cannot
// keep to. The board says so before any run: it refuses to seat a Codex teammate in such a department, to
// set such a list on a department where Codex teammates sit, and to move a seated teammate to Codex. Only
// what a change newly breaks is refused, so taking a teammate out, changing its engine or naming Bash stays
// open where a department was set up before; Peter's audit names those.

import { codexReach, type SandboxPreset } from "@rosterdock/shared";
import type { Queryable } from "../db/pool.js";
import { HttpError } from "../http-error.js";

/** Why Codex cannot keep to a department's tool list, or null when it can. */
export function codexMisfit(sandbox: Pick<SandboxPreset, "allowedTools"> | null | undefined): string | null {
  const reach = codexReach(sandbox?.allowedTools);
  return reach.ok ? null : reach.reason;
}

/** The Codex teammates among these, leaving out those already in the department (none for a new one). */
export async function codexNewcomers(
  db: Queryable,
  companyId: string,
  teammateIds: string[],
  departmentId: string | null,
): Promise<{ id: string; name: string }[]> {
  if (!teammateIds.length) return [];
  const res = await db.query<{ id: string; name: string }>(
    `SELECT t.id, t.name FROM teammates t
     WHERE t.company_id = $1 AND t.id = ANY($2::uuid[]) AND t.engine = 'codex'
       AND NOT EXISTS (SELECT 1 FROM department_members dm WHERE dm.department_id = $3 AND dm.teammate_id = t.id)
     ORDER BY t.name`,
    [companyId, teammateIds, departmentId],
  );
  return res.rows;
}

/** Seating these teammates in the department: refused for a Codex newcomer where Codex cannot keep to its list. */
export async function assertCodexSeats(
  db: Queryable,
  companyId: string,
  department: { id: string | null; name: string; sandbox: Pick<SandboxPreset, "allowedTools"> | null },
  teammateIds: string[],
): Promise<void> {
  const misfit = codexMisfit(department.sandbox);
  if (!misfit) return;
  const codex = await codexNewcomers(db, companyId, teammateIds, department.id);
  if (codex.length)
    throw codexRefused(
      codex.map((t) => t.name),
      department.name,
      misfit,
    );
}

/** The Codex teammates who sit in the department, by name. */
export async function codexMembers(
  db: Queryable,
  companyId: string,
  departmentId: string,
): Promise<string[]> {
  const res = await db.query<{ name: string }>(
    `SELECT t.name FROM department_members dm JOIN teammates t ON t.id = dm.teammate_id
     WHERE dm.company_id = $1 AND dm.department_id = $2 AND t.engine = 'codex' ORDER BY t.name`,
    [companyId, departmentId],
  );
  return res.rows.map((r) => r.name);
}

/** Moving a teammate to Codex: refused while it sits in a department whose tool list Codex cannot keep to. */
export async function assertCodexEngine(db: Queryable, companyId: string, teammateId: string): Promise<void> {
  const res = await db.query<{
    name: string;
    engine: string;
    department: string | null;
    sandbox: SandboxPreset | null;
  }>(
    `SELECT t.name, t.engine, d.name AS department, d.sandbox FROM teammates t
     LEFT JOIN department_members dm ON dm.teammate_id = t.id
     LEFT JOIN departments d ON d.id = dm.department_id
     WHERE t.id = $1 AND t.company_id = $2 ORDER BY d.created_at`,
    [teammateId, companyId],
  );
  // Already on Codex, or no such teammate (the update says so).
  if (!res.rows[0] || res.rows[0].engine === "codex") return;
  for (const { name, department, sandbox } of res.rows) {
    const misfit = department ? codexMisfit(sandbox) : null;
    if (misfit)
      throw new HttpError(
        409,
        `${name} sits in ${department}, and Codex cannot keep to ${department}'s tool list: ${misfit}. Name Bash on its own in the list, or take ${name} out of ${department} first.`,
      );
  }
}

/** The refusal of Codex teammates under a department's tool list: who, why, and the way out. */
export function codexRefused(names: string[], department: string, reason: string): HttpError {
  const who =
    names.length === 1 ? `${names[0]} runs` : `${names.slice(0, -1).join(", ")} and ${names.at(-1)} run`;
  return new HttpError(
    409,
    `${who} on Codex, which cannot keep to ${department}'s tool list: ${reason}. Name Bash on its own in the list, or pick another engine for ${names.length === 1 ? names[0] : "them"}.`,
  );
}
