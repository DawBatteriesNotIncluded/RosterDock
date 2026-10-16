// What a task delivered: the files of the run its approved review approved (or,
// before any approval, its last completed task run), and among them the
// outputs it declared. board_read_output pages through one; a dependent task's
// brief carries them.

import type { Queryable } from "../db/pool.js";
import { artifactText } from "../storage/artifacts.js";
import type { ObjectStore } from "../storage/s3.js";
import { MAX_PACK_DEPENDENCY_CHARS, type DependencyOutput, type RunSpec } from "./pack.js";
import type { ArtifactRow } from "./service.js";

/** The run whose work the task delivered: the one its approved review approved, else its last completed task run. */
export async function deliveredRunId(db: Queryable, taskId: string): Promise<string | null> {
  const res = await db.query<{ id: string | null }>(
    `SELECT COALESCE(
       (SELECT run_id FROM reviews WHERE task_id = $1 AND status = 'approved'),
       (SELECT id FROM runs WHERE task_id = $1 AND kind = 'task' AND status = 'completed'
          ORDER BY finished_at DESC NULLS LAST LIMIT 1)
     ) AS id`,
    [taskId],
  );
  return res.rows[0]?.id ?? null;
}

const basename = (p: string) => p.split("/").pop() ?? p;

/**
 * The declared outputs among a run's files, matched as the outputs check
 * matches them (by path, or by file name); every file and document when the
 * task declared none. A declared output the run did not keep has no row.
 */
export function declaredDeliverables(
  artifacts: ArtifactRow[],
  declared: string[],
): { path: string; row: ArtifactRow | null }[] {
  const files = artifacts.filter((a) => a.kind === "file" || a.kind === "document");
  if (!declared.length) return files.map((row) => ({ path: row.path, row }));
  return declared.map((d) => ({
    path: d,
    row: files.find((a) => a.path === d) ?? files.find((a) => basename(a.path) === d) ?? null,
  }));
}

/**
 * A task's dependencies for its brief: each done one with the outputs it
 * declared, their text inline until MAX_PACK_DEPENDENCY_CHARS is used up
 * across all of them; the files of one that declared none are named only.
 */
export async function dependenciesForBrief(
  db: Queryable,
  store: ObjectStore | null,
  taskId: string,
): Promise<RunSpec["dependencies"]> {
  const deps = (
    await db.query<{ id: string; number: number; title: string; status: string; declared_outputs: string[] }>(
      `SELECT t.id, t.number, t.title, t.status, t.declared_outputs FROM task_dependencies d
       JOIN tasks t ON t.id = d.depends_on_task_id WHERE d.task_id = $1 ORDER BY t.number`,
      [taskId],
    )
  ).rows;
  let room = MAX_PACK_DEPENDENCY_CHARS;
  const out: RunSpec["dependencies"] = [];
  for (const d of deps) {
    const entry = { number: d.number, title: d.title, status: d.status };
    const runId = d.status === "done" ? await deliveredRunId(db, d.id) : null;
    if (!runId) {
      out.push(entry);
      continue;
    }
    const artifacts = (
      await db.query<ArtifactRow>("SELECT * FROM artifacts WHERE run_id = $1 ORDER BY path", [runId])
    ).rows;
    const declared = d.declared_outputs ?? [];
    const outputs: DependencyOutput[] = [];
    for (const { path, row } of declaredDeliverables(artifacts, declared)) {
      if (!row) outputs.push({ path, text: null, chars: null, bytes: 0, note: "missing" });
      else if (row.encoding === "base64")
        outputs.push({ path: row.path, text: null, chars: null, bytes: row.bytes, note: "binary" });
      else {
        const text = await artifactText(store, row);
        if (text === null)
          outputs.push({ path: row.path, text: null, chars: null, bytes: row.bytes, note: "unavailable" });
        else if (!declared.length)
          outputs.push({
            path: row.path,
            text: null,
            chars: text.length,
            bytes: row.bytes,
            note: "undeclared",
          });
        else {
          const shown = text.slice(0, room);
          room -= shown.length;
          outputs.push({ path: row.path, text: shown, chars: text.length, bytes: row.bytes });
        }
      }
    }
    out.push({ ...entry, outputs });
  }
  return out;
}

/** Where a task's deliverable stands: approved, in review, sent back, finished without a review, or nothing yet. */
export type DeliverableState = "approved" | "in_review" | "changes_requested" | "unreviewed" | "none";

/**
 * What a task delivered, for the person reading the ticket: the files it declared from the run its review
 * approved (or its last completed task run before that), where the review stands on them, and the declared
 * outputs no run has kept. Every other file of every run stays on the task's artifact list.
 */
export async function taskDeliverable(
  db: Queryable,
  task: { id: string; declared_outputs: string[] | null },
): Promise<{
  runId: string | null;
  state: DeliverableState;
  round: number | null;
  files: ArtifactRow[];
  missing: string[];
}> {
  const declared = task.declared_outputs ?? [];
  const runId = await deliveredRunId(db, task.id);
  const review = (
    await db.query<{ status: string; run_id: string; round: number }>(
      "SELECT status, run_id, round FROM reviews WHERE task_id = $1",
      [task.id],
    )
  ).rows[0];
  if (!runId) return { runId: null, state: "none", round: null, files: [], missing: declared };
  const artifacts = (
    await db.query<ArtifactRow>("SELECT * FROM artifacts WHERE run_id = $1 ORDER BY path", [runId])
  ).rows;
  const found = declaredDeliverables(artifacts, declared);
  const state: DeliverableState =
    review?.status === "approved"
      ? "approved"
      : review && review.run_id === runId
        ? review.status === "changes_requested"
          ? "changes_requested"
          : "in_review"
        : "unreviewed";
  return {
    runId,
    state,
    round: review?.round ?? null,
    files: found.flatMap((f) => (f.row ? [f.row] : [])),
    missing: found.filter((f) => !f.row).map((f) => f.path),
  };
}
