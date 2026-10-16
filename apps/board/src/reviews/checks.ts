// Review checks. Pure functions over the parsed diff, the run's artifacts and
// the task: no database. The evidence idea comes from the v1 prototype (a
// verdict must be substantive and parseable); here the
// evidence is the diff itself, the declared outputs, the repository's tests and
// the reviewer's scores against the task's weighted criteria.

import {
  addedText,
  containsRawSecret,
  findRawSecrets,
  type Criterion,
  type DiffFile,
} from "@rosterdock/shared";
import type { FetchedSource } from "./sources.js";

export type CheckKind = "secrets" | "outputs" | "tests" | "evaluation" | "sources";

export interface CheckResult {
  kind: CheckKind;
  /** null: not run (nothing declared, no test script, not scored yet). */
  ok: boolean | null;
  title: string;
  detail: Record<string, unknown>;
}

// Assignments of a literal value to a secret-named key: `api_key = "…"`, `"password": "…"`.
const ASSIGNED_SECRET_RE =
  /(?:api[_-]?key|secret|password|passwd|token|private[_-]?key)["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i;

/** Secret-shaped strings anywhere in the added lines. Reports lines, never values. */
export function secretsCheck(files: DiffFile[]): CheckResult {
  const lines: { path: string; line: number }[] = [];
  for (const f of files) {
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l.kind !== "add") continue;
        const shaped =
          findRawSecrets({ text: l.text }).length > 0 ||
          containsRawSecret(l.text) ||
          ASSIGNED_SECRET_RE.test(l.text);
        if (shaped) lines.push({ path: f.path, line: l.new ?? 0 });
      }
    }
  }
  const scanned = addedText(files).length;
  if (lines.length) {
    return {
      kind: "secrets",
      ok: false,
      title: `${lines.length} secret-shaped ${lines.length === 1 ? "string" : "strings"} in the diff`,
      detail: { lines: lines.slice(0, 20), scannedChars: scanned },
    };
  }
  return {
    kind: "secrets",
    ok: true,
    title: "No credential values in the diff",
    detail: { scannedChars: scanned },
  };
}

/** Every declared output is in the diff or among the run's artifacts. */
export function outputsCheck(declared: string[], artifactPaths: string[], files: DiffFile[]): CheckResult {
  if (!declared.length) {
    return { kind: "outputs", ok: null, title: "No outputs were declared", detail: {} };
  }
  const present = new Set<string>();
  for (const p of artifactPaths) {
    present.add(p);
    present.add(p.split("/").pop() ?? p);
  }
  for (const f of files) {
    if (f.status === "deleted") continue;
    present.add(f.path);
    present.add(f.path.split("/").pop() ?? f.path);
  }
  const missing = declared.filter((d) => !present.has(d));
  if (missing.length) {
    return {
      kind: "outputs",
      ok: false,
      title: `Missing declared ${missing.length === 1 ? "output" : "outputs"}: ${missing.join(", ")}`,
      detail: { declared, missing },
    };
  }
  return {
    kind: "outputs",
    ok: true,
    title: `All ${declared.length} declared ${declared.length === 1 ? "output is" : "outputs are"} present`,
    detail: { declared, missing: [] },
  };
}

const SOURCES_HEADING_RE = /^#{1,6}\s*(sources|references|bibliography)\b/im;
const SOURCE_LINE_RE = /^\s*(?:[-*+]|\d+[.)])\s+\S|https?:\/\//m;

/**
 * Research documents cite their sources: a "Sources" (or "References") heading
 * followed by at least one entry, or links in the text. Null with no documents.
 * With the linked sources fetched, every one of them must have answered: a
 * claim that cites a page nobody can read is not cited.
 */
export function sourcesCheck(
  documents: { path: string; content: string | null }[],
  fetched: FetchedSource[] | null = null,
): CheckResult {
  if (!documents.length) {
    return { kind: "sources", ok: null, title: "No documents to check for sources", detail: {} };
  }
  const missing: string[] = [];
  const cited: string[] = [];
  for (const d of documents) {
    const text = d.content ?? "";
    const heading = SOURCES_HEADING_RE.exec(text);
    const after = heading ? text.slice(heading.index + heading[0].length) : "";
    const ok = (heading && SOURCE_LINE_RE.test(after)) || /https?:\/\/\S+/.test(text);
    (ok ? cited : missing).push(d.path);
  }
  const detail = { documents: documents.map((d) => d.path), missing, cited, sources: fetched ?? [] };
  if (missing.length) {
    return {
      kind: "sources",
      ok: false,
      title: `${missing.length === 1 ? "A document cites" : `${missing.length} documents cite`} no sources: ${missing.join(", ")}`,
      detail,
    };
  }
  const base = `${cited.length === 1 ? "The document cites" : `All ${cited.length} documents cite`} sources`;
  const dead = (fetched ?? []).filter((s) => !s.ok);
  if (dead.length) {
    return {
      kind: "sources",
      ok: false,
      title: `${base} · ${dead.length} of ${fetched!.length} ${dead.length === 1 ? "does" : "do"} not answer: ${dead.map((s) => s.url).join(", ")}`,
      detail,
    };
  }
  const answered = fetched?.length
    ? ` · ${fetched.length} ${fetched.length === 1 ? "source" : "sources"} answered`
    : "";
  return { kind: "sources", ok: true, title: `${base}${answered}`, detail };
}

/** The worker's report of the repository's own tests. */
export function testsCheck(reported: { ok: boolean | null; title: string; detail?: string }): CheckResult {
  return {
    kind: "tests",
    ok: reported.ok,
    title: reported.title,
    detail: reported.detail ? { output: reported.detail.slice(0, 20_000) } : {},
  };
}

export interface CriterionScore {
  index: number;
  text: string;
  weight: number;
  score: number;
  note: string | null;
}

/** Weighted mean at or above this passes the evaluation check. */
export const EVALUATION_PASS = 0.7;

/** Merge the reviewer's scores with the task's criteria; unknown indexes are refused. */
export function scoreCriteria(
  criteria: Criterion[],
  scores: { criterion: number; score: number; note?: string }[],
): CriterionScore[] {
  const out: CriterionScore[] = [];
  for (const s of scores) {
    const c = criteria[s.criterion];
    if (!c) throw new Error(`no criterion ${s.criterion}; the task has ${criteria.length}`);
    out.push({
      index: s.criterion,
      text: c.text,
      weight: c.weight,
      score: Math.max(0, Math.min(1, s.score)),
      note: s.note ?? null,
    });
  }
  return out;
}

export function weightedScore(scores: CriterionScore[]): number | null {
  const total = scores.reduce((a, s) => a + s.weight, 0);
  if (!total) return null;
  return scores.reduce((a, s) => a + s.weight * s.score, 0) / total;
}

/** The evaluation check from the task's criteria and the scores so far. */
export function evaluationCheck(criteria: Criterion[], scores: CriterionScore[] | null): CheckResult | null {
  if (!criteria.length) return null;
  if (!scores || !scores.length) {
    return {
      kind: "evaluation",
      ok: null,
      title: `${criteria.length} ${criteria.length === 1 ? "criterion" : "criteria"} not scored yet`,
      detail: { criteria: criteria.length, scored: 0 },
    };
  }
  const mean = weightedScore(scores) ?? 0;
  const pct = Math.round(mean * 100);
  const unscored = criteria.length - new Set(scores.map((s) => s.index)).size;
  const ok = mean >= EVALUATION_PASS && unscored === 0;
  const suffix = unscored ? `, ${unscored} not scored` : "";
  return {
    kind: "evaluation",
    ok,
    title: `Evaluation ${pct}% of weighted criteria${suffix}`,
    detail: {
      score: mean,
      threshold: EVALUATION_PASS,
      criteria: criteria.length,
      scored: criteria.length - unscored,
    },
  };
}
