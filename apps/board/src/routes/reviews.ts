// Reviews: the queue, one review with its diff, comments, scores and decisions.
// Deciding goes through review.decide; the service adds the rules the matrix
// cannot express (the author never decides, a teammate only as the assigned
// reviewer). Veto is review.veto: owners and admins.

import {
  AssignReviewerSchema,
  ReviewCommentSchema,
  ReviewDecisionSchema,
  ReviewScoreSchema,
  ReviewVetoSchema,
  REVIEW_STATUSES,
  type ReviewStatus,
} from "@rosterdock/shared";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/pool.js";
import type { GitHosts } from "../git/hosts.js";
import type { ObjectStore } from "../storage/s3.js";
import { HttpError, notFound } from "../http-error.js";
import type { RunQueue } from "../queue.js";
import { executePullRequest, restartAuthor } from "../reviews/outcomes.js";
import {
  addComment,
  approveReview,
  assignReviewer,
  commentToJson,
  listReviews,
  requestChanges,
  resolveComment,
  reviewDetail,
  reviewForTask,
  reviewToJson,
  scoreReview,
  vetoReview,
} from "../reviews/service.js";
import { dispatchReviewRun, liveRunFor, stopRun } from "../runs/service.js";
import { parseBody, uuidParam } from "../validate.js";

export function registerReviewRoutes(
  app: FastifyInstance,
  db: Db,
  queue: RunQueue,
  hosts: GitHosts,
  store: ObjectStore | null = null,
): void {
  app.get("/api/companies/:companyId/reviews", { config: { action: "company.read" } }, async (req) => {
    const q = req.query as { status?: string };
    const statuses = q.status
      ? q.status.split(",").map((s) => {
          const t = s.trim() as ReviewStatus;
          if (!REVIEW_STATUSES.includes(t)) throw new HttpError(400, `unknown review status ${s}`);
          return t;
        })
      : null;
    return (await listReviews(db, req.companyId, statuses)).map(reviewToJson);
  });

  app.get(
    "/api/companies/:companyId/reviews/:reviewId",
    { config: { action: "company.read" } },
    async (req) => {
      const id = uuidParam((req.params as { reviewId: string }).reviewId, "reviewId");
      return reviewDetail(db, req.companyId, id);
    },
  );

  app.get(
    "/api/companies/:companyId/tasks/:taskId/review",
    { config: { action: "company.read" } },
    async (req) => {
      const taskId = uuidParam((req.params as { taskId: string }).taskId, "taskId");
      const review = await reviewForTask(db, req.companyId, taskId);
      if (!review) throw notFound("review");
      return reviewDetail(db, req.companyId, review.id);
    },
  );

  app.post(
    "/api/companies/:companyId/reviews/:reviewId/comments",
    { config: { action: "review.comment" } },
    async (req, reply) => {
      const id = uuidParam((req.params as { reviewId: string }).reviewId, "reviewId");
      const body = parseBody(ReviewCommentSchema, req.body);
      const row = await addComment(db, req.companyId, req.principal.actor, id, body);
      reply.code(201);
      return commentToJson(row);
    },
  );

  app.post(
    "/api/companies/:companyId/reviews/:reviewId/comments/:commentId/resolve",
    { config: { action: "review.comment" } },
    async (req) => {
      const params = req.params as { reviewId: string; commentId: string };
      const id = uuidParam(params.reviewId, "reviewId");
      const commentId = uuidParam(params.commentId, "commentId");
      return commentToJson(await resolveComment(db, req.companyId, req.principal.actor, id, commentId));
    },
  );

  app.post(
    "/api/companies/:companyId/reviews/:reviewId/scores",
    { config: { action: "review.decide" } },
    async (req) => {
      const id = uuidParam((req.params as { reviewId: string }).reviewId, "reviewId");
      const body = parseBody(ReviewScoreSchema, req.body);
      await scoreReview(db, req.companyId, req.principal.actor, req.companyRole, id, body);
      return reviewDetail(db, req.companyId, id);
    },
  );

  // Request changes: the review waits, and the author is started again with the comments in the pack.
  app.post(
    "/api/companies/:companyId/reviews/:reviewId/request-changes",
    { config: { action: "review.decide" } },
    async (req) => {
      const id = uuidParam((req.params as { reviewId: string }).reviewId, "reviewId");
      const body = parseBody(ReviewDecisionSchema, req.body);
      const review = await requestChanges(db, req.companyId, req.principal.actor, req.companyRole, id, body);
      const restarted = await restartAuthor(db, queue, req.companyId, req.principal.actor, review);
      return { ...(await reviewDetail(db, req.companyId, id)), restarted };
    },
  );

  // Approve: the one path to Done. The pull request the approval proposed is executed right after.
  app.post(
    "/api/companies/:companyId/reviews/:reviewId/approve",
    { config: { action: "review.decide" } },
    async (req) => {
      const id = uuidParam((req.params as { reviewId: string }).reviewId, "reviewId");
      const body = parseBody(ReviewDecisionSchema, req.body);
      const { pullRequestId } = await approveReview(
        db,
        req.companyId,
        req.principal.actor,
        req.companyRole,
        id,
        body,
        hosts,
      );
      if (pullRequestId) await executePullRequest(db, hosts, req.companyId, pullRequestId, store);
      return reviewDetail(db, req.companyId, id);
    },
  );

  // Who reviews from here. An open review's reviewer teammate is stopped and the new one started.
  app.post(
    "/api/companies/:companyId/reviews/:reviewId/reviewer",
    { config: { action: "review.assign" } },
    async (req) => {
      const id = uuidParam((req.params as { reviewId: string }).reviewId, "reviewId");
      const body = parseBody(AssignReviewerSchema, req.body);
      const out = await assignReviewer(db, req.companyId, req.principal.actor, id, body);
      if (
        out.previous?.kind === "teammate" &&
        !(out.review.reviewer_kind === "teammate" && out.review.reviewer_id === out.previous.id)
      ) {
        const live = await liveRunFor(db, out.review.task_id, out.previous.id);
        if (live && live.kind === "review")
          await stopRun(db, queue, req.companyId, req.principal.actor, live.id).catch(() => {});
      }
      let started: { runId: string | null; reason: string | null } | null = null;
      if (out.reviewerTeammateId) {
        started = await dispatchReviewRun(db, queue, req.companyId, {
          id: out.review.id,
          task_id: out.review.task_id,
          round: out.review.round,
          reviewer_id: out.reviewerTeammateId,
        })
          .then((run) => ({ runId: run.id, reason: null }))
          .catch((err: unknown) => ({
            runId: null,
            reason: err instanceof HttpError ? err.message : String(err),
          }));
      }
      return { ...(await reviewDetail(db, req.companyId, id)), started };
    },
  );

  app.post(
    "/api/companies/:companyId/reviews/:reviewId/veto",
    { config: { action: "review.veto" } },
    async (req) => {
      const id = uuidParam((req.params as { reviewId: string }).reviewId, "reviewId");
      const body = parseBody(ReviewVetoSchema, req.body);
      await vetoReview(db, req.companyId, req.principal.actor, id, body, hosts);
      return reviewDetail(db, req.companyId, id);
    },
  );
}
