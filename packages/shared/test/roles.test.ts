import { describe, expect, it } from "vitest";
import { ACTIONS, can, isRole, ROLES, sameActor } from "../src/index.js";

const MUTATING = ACTIONS.filter((a) => a !== "company.read" && a !== "events.read");

describe("permission matrix", () => {
  it("owners can do everything", () => {
    for (const action of ACTIONS) expect(can("owner", action), action).toBe(true);
  });

  it("viewers can only read", () => {
    expect(can("viewer", "company.read")).toBe(true);
    expect(can("viewer", "events.read")).toBe(true);
    for (const action of MUTATING) expect(can("viewer", action), action).toBe(false);
  });

  it("teammates act on the board but never on the org chart, toolboxes or memberships", () => {
    expect(can("teammate", "task.create")).toBe(true);
    expect(can("teammate", "task.update")).toBe(true);
    expect(can("teammate", "message.post")).toBe(true);
    expect(can("teammate", "project.manage")).toBe(true);
    // A teammate opens projects; a person says where their work goes and what their client allows.
    expect(can("teammate", "project.configure")).toBe(false);
    expect(can("admin", "project.configure")).toBe(true);
    expect(can("teammate", "department.manage")).toBe(false);
    expect(can("teammate", "teammate.manage")).toBe(false);
    expect(can("teammate", "teammate.token")).toBe(false);
    expect(can("teammate", "membership.manage")).toBe(false);
    expect(can("teammate", "company.update")).toBe(false);
    // M5: the two human gates besides merges.
    expect(can("teammate", "approval.decide")).toBe(false);
    expect(can("teammate", "connection.manage")).toBe(false);
    expect(can("reviewer", "approval.decide")).toBe(false);
    expect(can("admin", "approval.decide")).toBe(true);
    expect(can("admin", "connection.manage")).toBe(true);
  });

  it("reviewers contribute to tasks and conversations but do not manage structure", () => {
    expect(can("reviewer", "task.update")).toBe(true);
    expect(can("reviewer", "message.post")).toBe(true);
    expect(can("reviewer", "project.manage")).toBe(false);
    expect(can("reviewer", "department.manage")).toBe(false);
  });

  it("reviews: contributors comment, reviewers and teammates decide, only owners and admins veto", () => {
    for (const r of ["owner", "admin", "reviewer", "teammate"] as const) {
      expect(can(r, "review.comment"), r).toBe(true);
      expect(can(r, "review.decide"), r).toBe(true);
    }
    expect(can("viewer", "review.comment")).toBe(false);
    expect(can("viewer", "review.decide")).toBe(false);
    expect(can("reviewer", "review.veto")).toBe(false);
    expect(can("teammate", "review.veto")).toBe(false);
    expect(can("admin", "review.veto")).toBe(true);
  });

  it("every action names at least one role and every role is known", () => {
    for (const action of ACTIONS)
      expect(
        ROLES.some((r) => can(r, action)),
        action,
      ).toBe(true);
    expect(isRole("owner")).toBe(true);
    expect(isRole("root")).toBe(false);
  });
});

describe("sameActor", () => {
  it("compares kind and id", () => {
    expect(sameActor({ kind: "user", id: "1" }, { kind: "user", id: "1" })).toBe(true);
    expect(sameActor({ kind: "user", id: "1" }, { kind: "teammate", id: "1" })).toBe(false);
    expect(sameActor(null, { kind: "user", id: "1" })).toBe(false);
  });
});
