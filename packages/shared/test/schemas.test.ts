import { describe, expect, it } from "vitest";
import {
  boardBranch,
  CreateDepartmentSchema,
  CreateGoalSchema,
  CreateProjectSchema,
  CreateTaskSchema,
  extractMentions,
  handleFor,
  isBoardBranch,
  MoveTaskSchema,
  CreateTeammateSchema,
  ModelPriceInputSchema,
  RunArtifactSchema,
  UpdateProjectSchema,
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

  it("a goal opens its project on a repository and a branch, and no repository URL carries a credential", () => {
    const goal = CreateGoalSchema.parse({
      text: "Fix the export",
      repoUrl: "https://github.com/acme/app",
      defaultBranch: "develop",
    });
    expect(goal).toMatchObject({
      repoUrl: "https://github.com/acme/app",
      defaultBranch: "develop",
      caps: {},
    });
    expect(CreateGoalSchema.parse({ text: "Fix the export" }).repoUrl).toBeUndefined();
    // A branch belongs to a repository.
    expect(CreateGoalSchema.safeParse({ text: "Fix the export", defaultBranch: "develop" }).success).toBe(
      false,
    );
    expect(CreateGoalSchema.safeParse({ text: "Fix the export", repoUrl: "not a url" }).success).toBe(false);
    // A password, or a user on http(s), is a credential: the worker's token is named in its environment.
    for (const repoUrl of [
      "https://deploy:hunter2@github.com/acme/app",
      "https://deploy@github.com/acme/app",
      "ssh://git:hunter2@example.com/acme/app.git",
    ]) {
      expect(CreateGoalSchema.safeParse({ text: "Fix the export", repoUrl }).success).toBe(false);
      expect(CreateProjectSchema.safeParse({ name: "App", repoUrl }).success).toBe(false);
      expect(UpdateProjectSchema.safeParse({ repoUrl }).success).toBe(false);
    }
    // A goal goes into a project that exists, or opens one on a repository; not both.
    expect(CreateGoalSchema.parse({ text: "Fix the export", projectId: id }).projectId).toBe(id);
    expect(
      CreateGoalSchema.safeParse({
        text: "Fix the export",
        projectId: id,
        repoUrl: "https://github.com/acme/app",
      }).success,
    ).toBe(false);
    expect(
      CreateGoalSchema.safeParse({ text: "Fix the export", projectId: id, defaultBranch: "develop" }).success,
    ).toBe(false);
    // The user on an ssh URL is who git signs in as, not a secret.
    expect(
      CreateProjectSchema.safeParse({ name: "App", repoUrl: "ssh://git@example.com/acme/app.git" }).success,
    ).toBe(true);
  });

  it("a default branch is never rosterdock or under rosterdock/, where the board writes its own branches", () => {
    const repoUrl = "https://github.com/acme/app";
    // `rosterdock` itself too: git cannot hold it beside the board's `rosterdock/task-N`.
    for (const defaultBranch of [
      boardBranch(1),
      " Rosterdock/next ",
      "refs/heads/rosterdock/task-2",
      "rosterdock",
      "refs/heads/RosterDock",
    ]) {
      expect(
        CreateProjectSchema.safeParse({ name: "App", repoUrl, defaultBranch }).error?.issues[0]?.message,
      ).toBe(
        "a default branch is never rosterdock or under rosterdock/: the board writes its own branches there",
      );
      expect(UpdateProjectSchema.safeParse({ defaultBranch }).success).toBe(false);
      expect(CreateGoalSchema.safeParse({ text: "Fix the export", repoUrl, defaultBranch }).success).toBe(
        false,
      );
    }
    for (const defaultBranch of ["main", "release/rosterdock", "rosterdocks", "rosterdock-next"])
      expect(CreateProjectSchema.parse({ name: "App", defaultBranch }).defaultBranch).toBe(defaultBranch);
    expect(isBoardBranch(boardBranch(12))).toBe(true);
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

describe("a run's artifact", () => {
  it("keeps its path as the run named it: one with a space or a U+FEFF at an end is another file", () => {
    for (const name of ["\ufeffreport.md", " report.md", "report.md "])
      expect(RunArtifactSchema.parse({ path: name, content: "x" }).path).toBe(name);
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
    expect(ModelPriceInputSchema.parse({ model: "claude-opus-5.5" }).model).toBe("claude-opus-5-5");
    // A provider's price keeps the id as the provider takes it.
    expect(
      ModelPriceInputSchema.parse({
        model: "claude-3.7-sonnet",
        providerId: "00000000-0000-4000-8000-000000000001",
      }).model,
    ).toBe("claude-3.7-sonnet");
    expect(UpdateTeammateSchema.parse({ model: "claude-opus-5-5" }).model).toBe("claude-opus-5-5");
    expect(UpdateTeammateSchema.parse({ model: "gpt-6.1-astra" }).model).toBe("gpt-6.1-astra");
    expect(UpdateTeammateSchema.parse({ model: "anthropic.claude-opus-5-5-v1:0" }).model).toBe(
      "anthropic.claude-opus-5-5-v1:0",
    );
  });
});
