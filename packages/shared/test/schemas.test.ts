import { describe, expect, it } from "vitest";
import {
  CreateDepartmentSchema,
  CreateTaskSchema,
  extractMentions,
  handleFor,
  MoveTaskSchema,
  CreateTeammateSchema,
  ModelPriceInputSchema,
  UpdateTeammateSchema,
} from "../src/index.js";

const id = "6b493e5f-a98f-4f86-8347-cb7bd6b90367";

describe("request schemas", () => {
  it("fills defaults", () => {
    const dept = CreateDepartmentSchema.parse({ name: "Engineering" });
    expect(dept.writePolicy).toBe("ask");
    expect(dept.memberTeammateIds).toEqual([]);
    const mate = CreateTeammateSchema.parse({ name: "Cody", role: "n8n engineer", model: "claude-sonnet-5" });
    expect(mate.engine).toBe("claude_code");
    expect(mate.playbooks).toEqual([]);
  });

  it("refuses moving a task to done", () => {
    expect(MoveTaskSchema.safeParse({ status: "done" }).success).toBe(false);
    expect(MoveTaskSchema.safeParse({ status: "review" }).success).toBe(true);
    expect(
      MoveTaskSchema.safeParse({ status: "blocked", blocker: { code: "waiting_on_teammate" } }).success,
    ).toBe(true);
    expect(MoveTaskSchema.safeParse({ status: "blocked", blocker: { code: "kill_switch" } }).success).toBe(
      false,
    );
  });

  it("accepts a user or a teammate as assignee", () => {
    expect(
      CreateTaskSchema.safeParse({ projectId: id, title: "T", assignee: { kind: "user", id } }).success,
    ).toBe(true);
    expect(
      CreateTaskSchema.safeParse({ projectId: id, title: "T", assignee: { kind: "teammate", id } }).success,
    ).toBe(true);
    expect(
      CreateTaskSchema.safeParse({ projectId: id, title: "T", assignee: { kind: "bot", id } }).success,
    ).toBe(false);
  });
});

describe("mentions", () => {
  it("extracts handles in order without duplicates", () => {
    expect(extractMentions("@ricky can you check with @brody? cc @ricky, email me@example.com")).toEqual([
      "ricky",
      "brody",
    ]);
  });

  it("derives handles from teammate names", () => {
    expect(handleFor("Cody 2")).toBe("cody2");
    expect(handleFor("Verifier")).toBe("verifier");
  });

  it("puts a dotted Claude model id right, as Claude Code takes it, and leaves other ids alone", () => {
    // Seen on a live board: claude-opus-5.5 in the teammate editor failed every run at once.
    expect(UpdateTeammateSchema.parse({ model: "claude-opus-5.5" }).model).toBe("claude-opus-5-5");
    expect(
      CreateTeammateSchema.parse({ name: "Finn", role: "finance", model: " claude-sonnet-5.1 " }).model,
    ).toBe("claude-sonnet-5-1");
    expect(ModelPriceInputSchema.shape.model.parse("claude-opus-5.5")).toBe("claude-opus-5-5");
    expect(UpdateTeammateSchema.parse({ model: "claude-opus-5-5" }).model).toBe("claude-opus-5-5");
    expect(UpdateTeammateSchema.parse({ model: "gpt-6.1-astra" }).model).toBe("gpt-6.1-astra");
    expect(UpdateTeammateSchema.parse({ model: "anthropic.claude-opus-5-5-v1:0" }).model).toBe(
      "anthropic.claude-opus-5-5-v1:0",
    );
  });
});
