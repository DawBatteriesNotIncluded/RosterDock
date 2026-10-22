// Review checks. Pure functions over the parsed diff, the run's artifacts and
// the task: no database. The evidence idea comes from the v1 prototype (a
// verdict must be substantive and parseable); here the
// evidence is the diff itself, the declared outputs, the repository's tests and
// the reviewer's scores against the task's weighted criteria.

import {
  addedText,
  containsRawSecret,
  findRawSecrets,
  sha256Hex,
  type Criterion,
  type DiffFile,
} from "@rosterdock/shared";
import type { FetchedSource } from "./sources.js";

export type CheckKind = "secrets" | "outputs" | "tests" | "evaluation" | "sources";

/**
 * A check whose failure stops a teammate's approval: a credential value in the diff, the repository's own
 * tests failing. A person may approve over one, and the approval records it.
 */
export const BLOCKING_CHECKS: readonly CheckKind[] = ["secrets", "tests"];

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

/** A secret-shaped string somewhere in the line. */
function secretShaped(text: string): boolean {
  return findRawSecrets({ text }).length > 0 || containsRawSecret(text) || ASSIGNED_SECRET_RE.test(text);
}

/** What the secrets check records of the round's binary files, for a pull request to hold their bytes to. */
export interface BinaryDetail {
  /** The sha256 of each binary file's bytes as scanned. */
  binaries: { path: string; sha256: string }[];
  /** Every binary file: the review shows none of their bytes. */
  unshown: string[];
}

/** A binary file's bytes, scanned: their sha256, and the lines that hold a secret-shaped string. */
export interface ScannedBinary {
  path: string;
  /** Null where the run sent no bytes for it. */
  sha256: string | null;
  lines: number[];
  chars: number;
}

/**
 * Scan the bytes a pull request would write for a file the diff calls binary, as lines of text: a file git calls
 * binary (an attribute, a NUL byte) may be text all the same. Again without its NUL bytes, so UTF-16 text reads
 * too. Kept to the result, so a round's files are read one at a time.
 */
export function scanBinary(path: string, bytes: Buffer | null): ScannedBinary {
  if (!bytes) return { path, sha256: null, lines: [], chars: 0 };
  const lines = new Set<number>();
  let chars = 0;
  for (const view of bytes.includes(0) ? [bytes, bytes.filter((b) => b !== 0)] : [bytes]) {
    const text = Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("utf8");
    chars += text.length;
    for (const [i, line] of text.split("\n").entries()) if (secretShaped(line)) lines.add(i + 1);
  }
  return { path, sha256: sha256Hex(bytes), lines: [...lines], chars };
}

/**
 * Secret-shaped strings anywhere in the added lines, and in every binary file's bytes (scanBinary). Reports
 * lines, never values. The review shows no binary file's bytes: the check names them, and a pull request takes
 * them only where a person approved. `unread`: why the run's diff could not be read (parseUnifiedDiff threw),
 * so nothing of it was scanned, and the check fails.
 */
export function secretsCheck(
  files: DiffFile[],
  unread?: string,
  binaries: ScannedBinary[] = [],
): CheckResult {
  if (unread !== undefined)
    return {
      kind: "secrets",
      ok: false,
      title: "The run's diff could not be read, so it was not scanned and the review shows none of its files",
      detail: { unread },
    };
  const lines: { path: string; line: number }[] = [];
  for (const f of files) {
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l.kind === "add" && secretShaped(l.text)) lines.push({ path: f.path, line: l.new ?? 0 });
      }
    }
  }
  let scanned = addedText(files).length;
  const bound: BinaryDetail = { binaries: [], unshown: [] };
  for (const b of binaries) {
    bound.unshown.push(b.path);
    if (b.sha256) bound.binaries.push({ path: b.path, sha256: b.sha256 });
    scanned += b.chars;
    for (const line of b.lines) lines.push({ path: b.path, line });
  }
  const detail = binaries.length ? { scannedChars: scanned, ...bound } : { scannedChars: scanned };
  if (lines.length) {
    return {
      kind: "secrets",
      ok: false,
      title: `${lines.length} secret-shaped ${lines.length === 1 ? "string" : "strings"} in the diff`,
      detail: { ...detail, lines: lines.slice(0, 20) },
    };
  }
  const n = bound.unshown.length;
  const named = bound.unshown.slice(0, 5).join(", ") + (n > 5 ? ` and ${n - 5} more` : "");
  return {
    kind: "secrets",
    ok: true,
    title: n
      ? `No credential values in the diff; the review cannot show ${n} binary ${n === 1 ? "file" : "files"}, which a pull request takes only with a person's approval: ${named}`
      : "No credential values in the diff",
    detail,
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
