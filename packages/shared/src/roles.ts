// Roles and the single permission matrix. The board's guard consults `can`
// and nothing else decides authorisation. Teammates are actors with the
// `teammate` role; users carry a per-company membership role.

export const ROLES = ["owner", "admin", "reviewer", "viewer", "teammate"] as const;
export type Role = (typeof ROLES)[number];

export const ACTOR_KINDS = ["user", "teammate"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** A user or a teammate. Every author, assignee, reviewer and event actor is one of these. */
export interface ActorRef {
  kind: ActorKind;
  id: string;
}

export const ACTIONS = [
  "company.read",
  "company.update",
  "membership.manage",
  "department.manage",
  "teammate.manage",
  "teammate.token",
  "project.manage",
  "project.configure",
  "goal.caps",
  "task.create",
  "task.update",
  "task.cancel",
  "message.post",
  "events.read",
  "review.comment",
  "review.decide",
  "review.veto",
  "review.assign",
  "approval.decide",
  "connection.manage",
] as const;
export type Action = (typeof ACTIONS)[number];

const EVERYONE: readonly Role[] = ROLES;
const OWNERS_ADMINS: readonly Role[] = ["owner", "admin"];
const CONTRIBUTORS: readonly Role[] = ["owner", "admin", "reviewer", "teammate"];

const MATRIX: Record<Action, readonly Role[]> = {
  "company.read": EVERYONE,
  "company.update": OWNERS_ADMINS,
  "membership.manage": OWNERS_ADMINS,
  "department.manage": OWNERS_ADMINS,
  "teammate.manage": OWNERS_ADMINS,
  "teammate.token": OWNERS_ADMINS,
  // Peter opens projects on handoff, so teammates may manage projects.
  "project.manage": ["owner", "admin", "teammate"],
  // Set a project's repository, its default branch and its client policy: where the work goes and what the
  // client allows. People only: a teammate never points its work elsewhere or loosens the policy it works under.
  "project.configure": OWNERS_ADMINS,
  // Raise or lower a goal's caps. People only: a teammate at the cap asks, never widens it.
  "goal.caps": OWNERS_ADMINS,
  "task.create": CONTRIBUTORS,
  "task.update": CONTRIBUTORS,
  // Drop a task nobody will finish. People only: a teammate that thinks so says it on the task.
  "task.cancel": OWNERS_ADMINS,
  "message.post": CONTRIBUTORS,
  "events.read": EVERYONE,
  "review.comment": CONTRIBUTORS,
  // Approve or request changes. Teammates only as the review's assigned reviewer; the author never (service rule).
  "review.decide": ["owner", "admin", "reviewer", "teammate"],
  // Undo an approval. Humans only.
  "review.veto": OWNERS_ADMINS,
  // Hand a review to a teammate or a person, or take it. People who may decide.
  "review.assign": ["owner", "admin", "reviewer"],
  // Approve or reject a proposed write to a live system. Humans only: the one gate besides merges.
  "approval.decide": OWNERS_ADMINS,
  // Add, discover, reclassify or remove a connection to an external system. Humans only.
  "connection.manage": OWNERS_ADMINS,
};

export function can(role: Role, action: Action): boolean {
  return MATRIX[action].includes(role);
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function isActorKind(value: unknown): value is ActorKind {
  return typeof value === "string" && (ACTOR_KINDS as readonly string[]).includes(value);
}

export function sameActor(a: ActorRef | null | undefined, b: ActorRef | null | undefined): boolean {
  return !!a && !!b && a.kind === b.kind && a.id === b.id;
}
