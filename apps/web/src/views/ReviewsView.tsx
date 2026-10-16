// Reviews: the queue, and one review as the prototype draws it: files on the
// left, the diff with numbered lines and comment threads in the middle,
// checks, reviewers and the decision on the right. Everything here is a
// projection of the review the board returns; every write goes through the
// callbacks.
import type { ActorRef, ReviewCommentInput } from "@rosterdock/shared";
import { AlertTriangle, ArrowLeft, Check, ExternalLink, Minus } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  CompanyData,
  DiffHunk,
  DiffLine,
  Review,
  ReviewComment,
  ReviewDetail,
  ReviewFile,
  Role,
} from "../api/types.ts";
import { Avatar, Button, Empty, Pill, Segs, Topbar } from "../components/ui.tsx";
import { cn } from "../lib/cn.ts";
import { actorInfo, relativeTime } from "../lib/format.ts";

export interface ReviewsViewProps {
  data: CompanyData;
  meId?: string;
  role: Role;
  /** The diff layout to start with; otherwise what the person chose last (localStorage). */
  initialLayout?: DiffLayout;
  selectedId: string | null;
  onSelect(id: string | null): void;
  loadReview(id: string): Promise<ReviewDetail>;
  onComment(reviewId: string, input: ReviewCommentInput): Promise<void>;
  onResolve(reviewId: string, commentId: string): Promise<void>;
  onScore(
    reviewId: string,
    scores: {
      criterion: number;
      score: number;
    }[],
  ): Promise<void>;
  onApprove(reviewId: string, summary?: string): Promise<void>;
  onRequestChanges(reviewId: string, summary?: string): Promise<void>;
  onVeto(reviewId: string, note: string): Promise<void>;
  onAssignReviewer(reviewId: string, reviewer: ActorRef | null): Promise<void>;
  onOpenTask(taskId: string): void;
  /** For headless rendering: the review to show without loading. */
  initial?: ReviewDetail | null;
}

export const REVIEW_LABEL: Record<Review["status"], string> = {
  open: "In review",
  changes_requested: "Changes requested",
  approved: "Approved",
};

export function reviewTone(status: Review["status"]): "info" | "warn" | "ok" {
  return status === "approved" ? "ok" : status === "changes_requested" ? "warn" : "info";
}

/** Reviews that need someone: open ones first, then sent back, then approved; newest first within. */
export function sortReviews(reviews: Review[]): Review[] {
  const rank: Record<Review["status"], number> = { open: 0, changes_requested: 1, approved: 2 };
  return [...reviews].sort(
    (a, b) => rank[a.status] - rank[b.status] || b.updatedAt.localeCompare(a.updatedAt),
  );
}

type Anchor = { file: string; hunk: number; line?: number; oldLine?: number };

export type DiffLayout = "unified" | "split";
const LAYOUT_KEY = "rosterdock.review.layout";

function storedLayout(): DiffLayout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "split" ? "split" : "unified";
  } catch {
    return "unified";
  }
}

function storeLayout(layout: DiffLayout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, layout);
  } catch {
    // a private window or a headless render: the choice lives for this page only
  }
}

/**
 * A hunk as side-by-side rows: context on both sides, a run of deletions
 * paired with the run of additions that follows it, the longer run's tail
 * alone. Comments keep their anchors: the new-side number, or the old for a
 * deleted line.
 */
export function splitRows(hunk: DiffHunk): { left: DiffLine | null; right: DiffLine | null }[] {
  const rows: { left: DiffLine | null; right: DiffLine | null }[] = [];
  let i = 0;
  const lines = hunk.lines;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.kind === "ctx") {
      rows.push({ left: l, right: l });
      i += 1;
      continue;
    }
    const dels: DiffLine[] = [];
    while (i < lines.length && lines[i]!.kind === "del") dels.push(lines[i++]!);
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i]!.kind === "add") adds.push(lines[i++]!);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++)
      rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return rows;
}

const sameAnchor = (c: ReviewComment, a: Anchor) =>
  c.file === a.file &&
  c.hunk === a.hunk &&
  (c.line ?? null) === (a.line ?? null) &&
  (c.oldLine ?? null) === (a.oldLine ?? null);

function lineAnchor(file: string, hunk: number, l: DiffLine): Anchor {
  return l.kind === "del"
    ? { file, hunk, oldLine: l.old ?? undefined }
    : { file, hunk, line: l.new ?? undefined };
}

export function ReviewsView(p: ReviewsViewProps) {
  const [detail, setDetail] = useState<ReviewDetail | null>(p.initial ?? null);
  const [fileIndex, setFileIndex] = useState(0);
  const [layout, setLayoutState] = useState<DiffLayout>(p.initialLayout ?? storedLayout());
  const setLayout = (l: DiffLayout) => {
    setLayoutState(l);
    storeLayout(l);
  };
  const [composing, setComposing] = useState<Anchor | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const listed = p.selectedId ? p.data.reviews.find((r) => r.id === p.selectedId) : undefined;

  useEffect(() => {
    if (!p.selectedId) {
      setDetail(null);
      return;
    }
    if (p.initial && p.initial.id === p.selectedId) return;
    let alive = true;
    void p.loadReview(p.selectedId).then((d) => alive && setDetail(d));
    return () => {
      alive = false;
    };
  }, [p.selectedId, listed?.updatedAt, p.loadReview, p.initial]);

  useEffect(() => {
    setFileIndex(0);
    setComposing(null);
    setNote("");
  }, [p.selectedId]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      if (p.selectedId && !p.initial) setDetail(await p.loadReview(p.selectedId));
    } finally {
      setBusy(false);
    }
  };

  const queue = useMemo(() => sortReviews(p.data.reviews), [p.data.reviews]);
  const canDecide = p.role === "owner" || p.role === "admin" || p.role === "reviewer";
  const canVeto = p.role === "owner" || p.role === "admin";

  if (!p.selectedId || !detail) {
    return (
      <>
        <Topbar
          title="Reviews"
          subtitle={`${queue.filter((r) => r.status === "open").length} waiting · a review opens when a teammate's run finishes`}
        />
        <div className="content">
          <div className="rqueue scroll">
            {queue.map((r) => {
              const author = actorInfo(p.data, r.author, p.meId);
              const reviewer = r.reviewer ? actorInfo(p.data, r.reviewer, p.meId) : null;
              return (
                <button key={r.id} className="rcard" onClick={() => p.onSelect(r.id)}>
                  <span className="row">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="mono text-[12px] text-muted">#{r.taskNumber}</span>
                      <span className="truncate font-semibold">{r.taskTitle}</span>
                    </span>
                    <Pill tone={reviewTone(r.status)}>{REVIEW_LABEL[r.status]}</Pill>
                  </span>
                  <span className="flex items-center gap-2 text-[13px] text-ink-2">
                    {author ? (
                      <Avatar name={author.name} handle={author.handle} size="s" you={author.isYou} />
                    ) : null}
                    <span>{author?.name ?? "someone"}</span>
                    <span className="text-faint">→</span>
                    {reviewer ? (
                      <>
                        <Avatar name={reviewer.name} handle={reviewer.handle} size="s" you={reviewer.isYou} />
                        <span>{reviewer.name}</span>
                      </>
                    ) : (
                      <span className="text-muted">a person</span>
                    )}
                  </span>
                  <span className="foot mono">
                    <span>
                      round {r.round} · {r.fileCount} {r.fileCount === 1 ? "file" : "files"}{" "}
                      <span className="plus">+{r.additions}</span>{" "}
                      <span className="minus">−{r.deletions}</span>
                    </span>
                    <span>
                      {r.openComments ? `${r.openComments} open · ` : ""}
                      {relativeTime(r.updatedAt)}
                    </span>
                  </span>
                </button>
              );
            })}
            {queue.length === 0 ? (
              <Empty>Nothing to review. A review opens when a teammate's run finishes.</Empty>
            ) : null}
            {p.selectedId && !detail ? <Empty>Loading review…</Empty> : null}
          </div>
        </div>
      </>
    );
  }

  const r = detail;
  const author = actorInfo(p.data, r.author, p.meId);
  const reviewer = r.reviewer ? actorInfo(p.data, r.reviewer, p.meId) : null;
  const file: ReviewFile | undefined = r.files[Math.min(fileIndex, Math.max(0, r.files.length - 1))];
  const current = r.comments.filter((c) => c.round === r.round);
  const openComments = current.filter((c) => !c.resolved).length;
  const project = p.data.projects.find((x) => x.id === r.projectId);
  const pr = r.pullRequests[0] ?? null;
  const decided = r.decisions.filter((d) => d.round === r.round);
  const myDecision = decided.filter((d) => d.by.kind === "user" && d.by.id === p.meId).at(-1) ?? null;
  const others = queue.filter((x) => x.status !== "approved").slice(0, 8);
  const done = r.status === "approved";

  const submitComment = async (e: FormEvent, anchor: Anchor, body: string) => {
    e.preventDefault();
    if (!body.trim()) return;
    await act(() => p.onComment(r.id, { ...anchor, body: body.trim() }));
    setComposing(null);
  };

  const renderThread = (anchor: Anchor, comments: ReviewComment[]) => {
    if (!comments.length && !(composing && sameAnchorA(composing, anchor))) return null;
    const unresolved = comments.some((c) => !c.resolved);
    return (
      <Thread
        key={`${anchor.file}:${anchor.hunk}:${anchor.line ?? ""}:${anchor.oldLine ?? ""}`}
        data={p.data}
        meId={p.meId}
        comments={comments}
        resolved={comments.length > 0 && !unresolved}
        composing={!!composing && sameAnchorA(composing, anchor)}
        busy={busy || done}
        onSubmit={(e, body) => void submitComment(e, anchor, body)}
        onCancel={() => setComposing(null)}
        onResolve={
          unresolved
            ? () =>
                void act(() =>
                  Promise.all(comments.filter((c) => !c.resolved).map((c) => p.onResolve(r.id, c.id))).then(
                    () => {},
                  ),
                )
            : null
        }
      />
    );
  };

  const renderHunk = (h: DiffHunk) => {
    const path = file!.path;
    const hunkAnchor: Anchor = { file: path, hunk: h.index };
    return (
      <div key={h.index}>
        <div className="hunk">
          <span>{h.header}</span>
          <span>{h.section}</span>
          {!done ? (
            <button
              className="addc static"
              title="Comment on this hunk"
              onClick={() => setComposing(hunkAnchor)}
            >
              +
            </button>
          ) : null}
        </div>
        {renderThread(
          hunkAnchor,
          r.comments.filter(
            (c) => c.file === path && c.hunk === h.index && c.line === null && c.oldLine === null,
          ),
        )}
        {layout === "split"
          ? splitRows(h).map((row, i) => {
              const sides = [row.left, row.right].map((l, side) => {
                if (!l) return { l: null, anchor: null, here: [] as ReviewComment[], flag: false };
                // Context lines carry one anchor (the new side); a change carries its own.
                if (l.kind === "ctx" && side === 0)
                  return { l, anchor: null, here: [] as ReviewComment[], flag: false };
                const anchor = lineAnchor(path, h.index, l);
                const here = r.comments.filter((c) => sameAnchor(c, anchor));
                return { l, anchor, here, flag: here.some((c) => !c.resolved) };
              });
              const [left, right] = sides as [(typeof sides)[0], (typeof sides)[0]];
              return (
                <div key={i}>
                  <div className={cn("ln split", (left.flag || right.flag) && "flag")}>
                    <span className={cn("side", left.l?.kind === "del" && "del")}>
                      <span className="n">{left.l?.old ?? ""}</span>
                      <span className="c">{left.l?.text ?? ""}</span>
                      {!done && left.anchor ? (
                        <button
                          className="addc"
                          title="Comment on this line"
                          onClick={() => setComposing(left.anchor!)}
                        >
                          +
                        </button>
                      ) : null}
                    </span>
                    <span className={cn("side", right.l?.kind === "add" && "add")}>
                      <span className="n">{right.l?.new ?? ""}</span>
                      <span className="c">{right.l?.text ?? ""}</span>
                      {!done && right.anchor ? (
                        <button
                          className="addc"
                          title="Comment on this line"
                          onClick={() => setComposing(right.anchor!)}
                        >
                          +
                        </button>
                      ) : null}
                    </span>
                  </div>
                  {left.anchor ? renderThread(left.anchor, left.here) : null}
                  {right.anchor ? renderThread(right.anchor, right.here) : null}
                </div>
              );
            })
          : h.lines.map((l, i) => {
              const anchor = lineAnchor(path, h.index, l);
              const here = r.comments.filter((c) => sameAnchor(c, anchor));
              const flag = here.some((c) => !c.resolved);
              return (
                <div key={i}>
                  <div
                    className={cn("ln", l.kind === "add" && "add", l.kind === "del" && "del", flag && "flag")}
                  >
                    <span className="n">{l.old ?? ""}</span>
                    <span className="n">{l.new ?? ""}</span>
                    <span className="c">{l.text}</span>
                    {!done ? (
                      <button
                        className="addc"
                        title="Comment on this line"
                        onClick={() => setComposing(anchor)}
                      >
                        +
                      </button>
                    ) : null}
                  </div>
                  {renderThread(anchor, here)}
                </div>
              );
            })}
      </div>
    );
  };

  return (
    <>
      <Topbar
        title={r.taskTitle ?? "Review"}
        left={
          <>
            <span className="mono text-[13px] text-muted">#{r.taskNumber}</span>
            <Pill tone={reviewTone(r.status)}>{REVIEW_LABEL[r.status]}</Pill>
            <span className="text-[12px] text-muted">round {r.round}</span>
          </>
        }
        right={
          <>
            <div className="flex items-center gap-2 text-[13px] text-ink-2">
              {author ? (
                <Avatar name={author.name} handle={author.handle} size="s" you={author.isYou} />
              ) : null}
              <span>{author?.name ?? "someone"}</span>
              <span className="text-faint">→</span>
              {reviewer ? (
                <>
                  <Avatar name={reviewer.name} handle={reviewer.handle} size="s" you={reviewer.isYou} />
                  <span>{reviewer.name}</span>
                </>
              ) : null}
              <span className="text-faint">+</span>
              <Avatar name="You" size="s" you />
              <span>You</span>
            </div>
            {others.length > 1 ? (
              <Segs
                label="Review"
                value={r.id}
                onChange={(id) => p.onSelect(id)}
                options={others.map((x) => ({ value: x.id, label: `#${x.taskNumber}` }))}
              />
            ) : null}
            <Button size="sm" onClick={() => p.onOpenTask(r.taskId)}>
              Open task
            </Button>
            <Button size="sm" onClick={() => p.onSelect(null)}>
              <ArrowLeft size={14} />
              <span>All reviews</span>
            </Button>
          </>
        }
      />
      <div className="review">
        <div className="files">
          <div className="row" style={{ padding: "0 8px 10px" }}>
            <span className="eyebrow">
              {r.files.length} {r.files.length === 1 ? "file" : "files"}
            </span>
            <span className="mono text-[12px]">
              <span className="plus">+{r.additions}</span> <span className="minus">−{r.deletions}</span>
            </span>
          </div>
          {r.files.map((f, i) => (
            <button
              key={f.id}
              className={cn("file", i === fileIndex && "active")}
              onClick={() => setFileIndex(i)}
            >
              <span className="name mono">{f.path}</span>
              <span className="mono shrink-0 text-[11px]">
                {f.binary ? (
                  "binary"
                ) : (
                  <>
                    <span className="plus">+{f.additions}</span>
                    {f.deletions ? (
                      <>
                        {" "}
                        <span className="minus">−{f.deletions}</span>
                      </>
                    ) : null}
                  </>
                )}
              </span>
            </button>
          ))}
          {r.files.length === 0 ? <Empty>The run produced no diff.</Empty> : null}
          {r.declaredOutputs.length ? (
            <div className="mt-auto flex flex-col gap-1 border-t border-border px-2 pt-3 text-[12px] text-muted">
              <span className="font-semibold">Declared outputs</span>
              {r.declaredOutputs.map((o) => (
                <span key={o} className="mono">
                  {o}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <div className="diffwrap">
          {file ? (
            <>
              <div className="diff-h">
                <span className="mono text-[13px] font-medium">{file.path}</span>
                <span className="text-[12px] text-muted">
                  {file.status}
                  {file.binary ? " · binary, not shown" : ""}
                </span>
                <span className="seg ml-auto" role="group" aria-label="Diff layout">
                  <button
                    className={cn("segb", layout === "unified" && "active")}
                    onClick={() => setLayout("unified")}
                  >
                    Unified
                  </button>
                  <button
                    className={cn("segb", layout === "split" && "active")}
                    onClick={() => setLayout("split")}
                  >
                    Split
                  </button>
                </span>
              </div>
              <div className="diff">{file.hunks.map(renderHunk)}</div>
            </>
          ) : (
            <Empty>Nothing to show.</Empty>
          )}
        </div>
        <aside className="rpanel">
          <div className="flex flex-col gap-2">
            <span className="eyebrow">Checks</span>
            <div className="checks">
              {r.checks.map((c) => (
                <div key={c.id} className={cn("check", c.ok === false && "warn")}>
                  {c.ok === true ? (
                    <Check size={14} style={{ color: "var(--accent)" }} />
                  ) : c.ok === false ? (
                    <AlertTriangle size={14} style={{ color: "var(--warn)" }} />
                  ) : (
                    <Minus size={14} style={{ color: "var(--faint)" }} />
                  )}
                  <span>{c.title}</span>
                </div>
              ))}
              {openComments ? (
                <div className="check warn">
                  <AlertTriangle size={14} style={{ color: "var(--warn)" }} />
                  <span>
                    {openComments} open {openComments === 1 ? "comment" : "comments"}
                  </span>
                </div>
              ) : null}
              {r.checks.length === 0 && !openComments ? (
                <span className="text-muted">No checks yet.</span>
              ) : null}
            </div>
          </div>
          {r.criteria.length ? (
            <Criteria
              criteria={r.criteria}
              scores={r.scores ?? []}
              canScore={canDecide && !done}
              busy={busy}
              onSave={(scores) => void act(() => p.onScore(r.id, scores))}
            />
          ) : null}
          <div className="flex flex-col gap-2">
            <span className="eyebrow">Reviewers</span>
            {canDecide && !done ? (
              <select
                className="input"
                aria-label="Reviewer"
                disabled={busy}
                value={r.reviewer ? `${r.reviewer.kind}:${r.reviewer.id}` : ""}
                onChange={(e) => {
                  const [kind, id] = e.target.value.split(":");
                  void act(() =>
                    p.onAssignReviewer(r.id, kind && id ? { kind: kind as ActorRef["kind"], id } : null),
                  );
                }}
              >
                <option value="">Nobody assigned; people decide</option>
                <optgroup label="Teammates">
                  {p.data.teammates
                    .filter((t) => !(r.author.kind === "teammate" && r.author.id === t.id))
                    .map((t) => (
                      <option key={t.id} value={`teammate:${t.id}`}>
                        {t.name} · {t.role}
                      </option>
                    ))}
                </optgroup>
                <optgroup label="People">
                  {p.data.members
                    .filter(
                      (m) => m.role !== "viewer" && !(r.author.kind === "user" && r.author.id === m.userId),
                    )
                    .map((m) => (
                      <option key={m.userId} value={`user:${m.userId}`}>
                        {m.userId === p.meId ? "You" : m.name}
                      </option>
                    ))}
                </optgroup>
              </select>
            ) : null}
            {reviewer ? (
              <div className="reviewer">
                <span className="flex items-center gap-2">
                  <Avatar name={reviewer.name} handle={reviewer.handle} size="s" />
                  <span>{reviewer.name}</span>
                </span>
                <span
                  className="text-[12px] font-semibold"
                  style={{
                    color:
                      r.status === "changes_requested"
                        ? "var(--warn-ink)"
                        : r.status === "approved"
                          ? "var(--accent-ink)"
                          : "var(--info-ink)",
                  }}
                >
                  {decided.find((d) => d.by.kind === "teammate")?.decision === "approve"
                    ? "Approved"
                    : decided.find((d) => d.by.kind === "teammate")?.decision === "request_changes"
                      ? "Changes requested"
                      : "Reviewing"}
                </span>
              </div>
            ) : (
              <div className="reviewer">
                <span className="text-muted">No reviewer teammate; this one is yours.</span>
              </div>
            )}
            <div className="reviewer">
              <span className="flex items-center gap-2">
                <Avatar name="You" size="s" you />
                <span>You</span>
              </span>
              <span className="text-[12px] text-muted">
                {myDecision
                  ? myDecision.decision === "approve"
                    ? "Approved"
                    : myDecision.decision === "veto"
                      ? "Vetoed"
                      : "Changes requested"
                  : canDecide
                    ? "Optional"
                    : "Read only"}
              </span>
            </div>
          </div>
          {!done ? (
            <div className="flex flex-col gap-2">
              <textarea
                className="input"
                rows={2}
                placeholder="Note for the author (optional)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <Button
                variant="accent"
                className="block"
                disabled={busy || !canDecide || r.taskStatus === "doing"}
                onClick={() => void act(() => p.onApprove(r.id, note.trim() || undefined))}
              >
                Approve
              </Button>
              <Button
                className="block"
                disabled={busy || !canDecide || r.status === "changes_requested"}
                onClick={() => void act(() => p.onRequestChanges(r.id, note.trim() || undefined))}
              >
                {r.status === "changes_requested" ? "Sent back to the author" : "Request changes"}
              </Button>
            </div>
          ) : canVeto ? (
            <Button
              variant="danger"
              className="block"
              disabled={busy}
              onClick={() => {
                const why = window.prompt("Veto this approval? Say why; the task goes back to In review.");
                if (why?.trim()) void act(() => p.onVeto(r.id, why.trim()));
              }}
            >
              Veto approval
            </Button>
          ) : null}
          <div className="note">
            <span className="eyebrow">{done ? "Approved" : "When approved"}</span>
            {pr ? (
              pr.status === "opened" ? (
                <span>
                  Pull request{" "}
                  <a
                    href={pr.url ?? "#"}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-semibold"
                  >
                    #{pr.number} <ExternalLink size={12} />
                  </a>{" "}
                  opened to <span className="mono text-[12px]">{pr.repo}</span> on{" "}
                  <span className="mono text-[12px]">{pr.headBranch}</span>.
                </span>
              ) : pr.status === "closed" ? (
                <span className="text-[12px] text-muted">
                  {pr.provider === "gitlab" ? "Merge request" : "Pull request"}{" "}
                  <a className="link" href={pr.url ?? "#"} target="_blank" rel="noreferrer">
                    {pr.provider === "gitlab" ? "!" : "#"}
                    {pr.number}
                  </a>{" "}
                  to <span className="mono text-[12px]">{pr.repo}</span> was closed after the veto.
                </span>
              ) : pr.status === "failed" ? (
                <span>
                  The pull request to <span className="mono text-[12px]">{pr.repo}</span> could not be opened:{" "}
                  {pr.error}
                </span>
              ) : (
                <span>
                  A pull request to <span className="mono text-[12px]">{pr.repo}</span> is proposed and
                  waiting to be opened.
                </span>
              )
            ) : done ? (
              <span>
                #{r.taskNumber} is Done.{" "}
                {project?.repoUrl
                  ? "No pull request was opened: the run recorded no base commit."
                  : "This project has no repository, so there is no pull request."}
              </span>
            ) : (
              <span>
                Approving marks #{r.taskNumber} Done
                {project?.repoUrl ? (
                  <>
                    {" "}
                    and opens a pull request to <span className="mono text-[12px]">{project.repoUrl}</span>
                  </>
                ) : null}
                . Request changes sends {author?.name ?? "the author"} back with every comment in their pack.
              </span>
            )}
            {project?.repoUrl ? (
              <span className="chip warn" style={{ width: "fit-content", padding: "6px 10px", fontSize: 12 }}>
                <span className="dot warn" />
                Merging needs you
              </span>
            ) : null}
          </div>
          {r.summary ? (
            <div className="text-[12px] text-muted">
              Last note: <span className="text-ink-2">{r.summary}</span>
            </div>
          ) : null}
          <div className="mt-auto flex flex-col gap-1 text-[12px] text-muted">
            <span>
              Round {r.round} · {r.fileCount} {r.fileCount === 1 ? "file" : "files"} · +{r.additions} −
              {r.deletions}
            </span>
            <span className="mono">diff {r.diffSha256.slice(0, 12)}</span>
            {r.decisions.length ? (
              <span>
                {r.decisions.length} {r.decisions.length === 1 ? "decision" : "decisions"} so far
              </span>
            ) : null}
          </div>
        </aside>
      </div>
    </>
  );
}

const sameAnchorA = (a: Anchor, b: Anchor) =>
  a.file === b.file &&
  a.hunk === b.hunk &&
  (a.line ?? null) === (b.line ?? null) &&
  (a.oldLine ?? null) === (b.oldLine ?? null);

function Thread(p: {
  data: CompanyData;
  meId?: string;
  comments: ReviewComment[];
  resolved: boolean;
  composing: boolean;
  busy: boolean;
  onSubmit(e: FormEvent, body: string): void;
  onCancel(): void;
  onResolve: (() => void) | null;
}) {
  const [body, setBody] = useState("");
  const round = p.comments[0]?.round;
  return (
    <div className={cn("cthread", p.resolved && "resolved")}>
      {p.comments.map((c) => {
        const a = actorInfo(p.data, c.author, p.meId);
        return (
          <div key={c.id} className="msg">
            <Avatar name={a?.name ?? c.author.name ?? "?"} handle={a?.handle} size="m" you={a?.isYou} />
            <div className="body">
              <div className="hd">
                <b>{a?.name ?? c.author.name ?? "someone"}</b>
                {c.round !== round ? <span className="pill muted">round {c.round}</span> : null}
                <span>{relativeTime(c.createdAt)}</span>
              </div>
              <p>{c.body}</p>
            </div>
          </div>
        );
      })}
      {!p.busy ? (
        <form
          className="foot"
          onSubmit={(e) => {
            p.onSubmit(e, body);
            setBody("");
          }}
        >
          <input
            placeholder={p.comments.length ? "Reply…" : "Comment…"}
            autoComplete="off"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <Button size="sm" type="submit" disabled={!body.trim()}>
            {p.comments.length ? "Reply" : "Comment"}
          </Button>
          {p.composing && !p.comments.length ? (
            <Button size="sm" type="button" onClick={p.onCancel}>
              Cancel
            </Button>
          ) : null}
          {p.onResolve ? (
            <Button size="sm" type="button" onClick={p.onResolve}>
              Resolve
            </Button>
          ) : p.resolved ? (
            <span className="px-2 text-[12px] text-muted">Resolved</span>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}

function Criteria(p: {
  criteria: { text: string; weight: number }[];
  scores: { index: number; score: number; note: string | null }[];
  canScore: boolean;
  busy: boolean;
  onSave(scores: { criterion: number; score: number }[]): void;
}) {
  const [draft, setDraft] = useState<Record<number, string>>({});
  const value = (i: number) => draft[i] ?? String(p.scores.find((s) => s.index === i)?.score ?? "");
  const dirty = Object.keys(draft).length > 0;
  return (
    <div className="flex flex-col gap-2">
      <span className="eyebrow">Acceptance criteria</span>
      <div className="checks">
        {p.criteria.map((c, i) => (
          <div key={i} className="check" style={{ justifyContent: "space-between" }}>
            <span>
              {c.text} <span className="text-muted">({c.weight})</span>
            </span>
            {p.canScore ? (
              <input
                className="input"
                style={{ width: 64, padding: "3px 6px" }}
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={value(i)}
                onChange={(e) => setDraft((d) => ({ ...d, [i]: e.target.value }))}
              />
            ) : (
              <span className="mono text-[12px]">{value(i) || "—"}</span>
            )}
          </div>
        ))}
      </div>
      {p.canScore ? (
        <Button
          size="sm"
          disabled={!dirty || p.busy}
          onClick={() => {
            const scores = Object.entries(draft)
              .map(([i, v]) => ({ criterion: Number(i), score: Number(v) }))
              .filter((s) => Number.isFinite(s.score) && s.score >= 0 && s.score <= 1);
            if (scores.length) p.onSave(scores);
            setDraft({});
          }}
        >
          Save scores
        </Button>
      ) : null}
    </div>
  );
}
