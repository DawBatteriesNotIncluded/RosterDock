// What a goal produced, for the person who asked for it: the files its final
// tasks delivered (Done, and no task of the goal still open or done depends on
// them; work elsewhere built on them does not count), the files
// its other tasks delivered on the way, and every live write its tasks made,
// with what the board's record says that target holds now and whether it is
// the file review approved. Download all is a zip of the delivered files.

import { createHash } from "node:crypto";
import type { Queryable } from "../db/pool.js";
import { connectionRoots, writeTarget } from "../approvals/target.js";
import { declaredDeliverables, deliveredRunId } from "../runs/outputs.js";
import type { ArtifactRow } from "../runs/service.js";
import { artifactBytes } from "../storage/artifacts.js";
import type { ObjectStore } from "../storage/s3.js";
import { zipFiles } from "../storage/zip.js";
import { loadGoal } from "./goals.js";

interface ResultTask {
  id: string;
  number: number;
  title: string;
  declared_outputs: string[];
}

interface WriteRow {
  id: string;
  task_id: string;
  number: number;
  connection: string;
  tool: string;
  title: string;
  payload: Record<string, unknown>;
  executed_at: Date;
  decided_at: Date | null;
}

const basename = (p: string) => p.split("/").pop() ?? p;
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

async function deliveredFiles(db: Queryable, task: ResultTask): Promise<ArtifactRow[]> {
  const runId = await deliveredRunId(db, task.id);
  if (!runId) return [];
  const artifacts = (
    await db.query<ArtifactRow>("SELECT * FROM artifacts WHERE run_id = $1 ORDER BY path", [runId])
  ).rows;
  return declaredDeliverables(artifacts, task.declared_outputs ?? []).flatMap((d) => (d.row ? [d.row] : []));
}

const fileJson = (a: ArtifactRow) => ({
  artifactId: a.id,
  runId: a.run_id,
  path: a.path,
  bytes: a.bytes,
  sha256: a.sha256,
  binary: a.encoding === "base64",
});

/** The latest executed write first: by when it was sent, then by when a person decided it. */
const newestFirst = (a: WriteRow, b: WriteRow) =>
  b.executed_at.getTime() - a.executed_at.getTime() ||
  (b.decided_at?.getTime() ?? 0) - (a.decided_at?.getTime() ?? 0);

export async function goalResult(db: Queryable, companyId: string, goalId: string) {
  const goal = await loadGoal(db, companyId, goalId);
  const tasks = (
    await db.query<ResultTask & { status: string; needed: boolean }>(
      `SELECT t.id, t.number, t.title, t.declared_outputs, t.status,
         EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks n ON n.id = d.task_id
                 WHERE d.depends_on_task_id = t.id AND n.goal_id = t.goal_id
                   AND n.status <> 'cancelled') AS needed
       FROM tasks t WHERE t.goal_id = $1 ORDER BY t.number`,
      [goal.id],
    )
  ).rows;
  const done = tasks.filter((t) => t.status === "done");
  const withFiles = await Promise.all(
    done.map(async (t) => ({ task: t, files: await deliveredFiles(db, t) })),
  );
  const entry = ({ task, files }: (typeof withFiles)[number]) => ({
    taskId: task.id,
    number: task.number,
    title: task.title,
    files: files.map(fileJson),
  });
  const delivered = withFiles.filter((w) => !w.task.needed);
  const supporting = withFiles.filter((w) => w.task.needed);

  // Live writes: the goal's own, and for each target what the record says it holds now.
  const all = (
    await db.query<WriteRow>(
      `SELECT a.id, a.task_id, t.number, a.connection, a.tool, a.title, a.payload, a.executed_at, a.decided_at
       FROM approvals a JOIN tasks t ON t.id = a.task_id
       WHERE a.company_id = $1 AND a.status = 'executed'`,
      [companyId],
    )
  ).rows.sort(newestFirst);
  const connections = (
    await db.query<{ name: string; args: unknown }>(
      "SELECT name, args FROM connections WHERE company_id = $1",
      [companyId],
    )
  ).rows;
  const rootsOf = (name: string) => connectionRoots(connections.find((c) => c.name === name)?.args);
  const targetOf = (a: WriteRow) => writeTarget(a.payload, rootsOf(a.connection));
  const mine = new Set(tasks.map((t) => t.id));
  const files = withFiles.flatMap((w) => w.files.map((f) => ({ number: w.task.number, file: f })));
  const seen = new Set<string>();
  const published = [];
  for (const w of all.filter((a) => mine.has(a.task_id))) {
    const target = targetOf(w);
    const key = `${w.connection}\u0000${w.tool}\u0000${target?.key ?? w.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const now = target
      ? (all.find(
          (a) => a.connection === w.connection && a.tool === w.tool && targetOf(a)?.key === target.key,
        ) ?? w)
      : w;
    const content = typeof now.payload.content === "string" ? now.payload.content : null;
    const same =
      target && content !== null
        ? files.find((f) => basename(f.file.path) === basename(target.label))
        : undefined;
    published.push({
      connection: w.connection,
      tool: w.tool,
      target: target?.label ?? null,
      approvalId: w.id,
      title: w.title,
      number: w.number,
      executedAt: w.executed_at.toISOString(),
      // Written since, by a later approval (another task's, or this goal's again).
      now:
        now.id === w.id
          ? null
          : {
              approvalId: now.id,
              title: now.title,
              number: now.number,
              executedAt: now.executed_at.toISOString(),
            },
      content: content === null ? null : { sha256: sha256(content), chars: content.length },
      // Against the delivered file of the same name: is the live copy the one review approved?
      matchesDelivered:
        same && content !== null
          ? { number: same.number, path: same.file.path, same: sha256(content) === same.file.sha256 }
          : null,
    });
  }
  return {
    goalId: goal.id,
    title: goal.title,
    status: goal.status,
    delivered: delivered.map(entry),
    supporting: supporting.map(entry),
    published,
  };
}

export type GoalResult = Awaited<ReturnType<typeof goalResult>>;

/** Every file the goal's Done tasks delivered, final ones first, named by task: `31-positioning.md`. */
export async function goalResultZip(
  db: Queryable,
  store: ObjectStore | null,
  companyId: string,
  goalId: string,
): Promise<{ filename: string; bytes: Buffer }> {
  const result = await goalResult(db, companyId, goalId);
  const entries = [];
  for (const t of [...result.delivered, ...result.supporting]) {
    for (const f of t.files) {
      const row = (
        await db.query<ArtifactRow>("SELECT * FROM artifacts WHERE id = $1 AND company_id = $2", [
          f.artifactId,
          companyId,
        ])
      ).rows[0];
      const data = await artifactBytes(store, row ?? null);
      if (data)
        entries.push({ name: `${t.number}-${f.path.replace(/\//g, "-")}`, data, modified: row!.created_at });
    }
  }
  const slug =
    result.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "goal";
  return { filename: `${slug}.zip`, bytes: zipFiles(entries) };
}
