// The GitLab provider against the recorded API shapes, and the host registry
// that picks a provider from a repository URL. No network.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseUnifiedDiff } from "@rosterdock/shared";
import { describe, expect, it } from "vitest";
import { closeMergeRequest, GitLabError, openMergeRequest, parseGitLabRepo } from "../src/git/gitlab.js";
import { changeNoun, parseRepo } from "../src/git/hosts.js";
import { fakeGitLab } from "./gitlab-fake.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const shared = path.resolve(here, "../../../packages/shared/test/fixtures");
const DIFF = readFileSync(path.join(shared, "changes.diff"), "utf8");
const BASE = JSON.parse(readFileSync(path.join(shared, "diff-base.json"), "utf8")) as Record<
  string,
  string | null
>;
const AFTER = JSON.parse(readFileSync(path.join(shared, "diff-after.json"), "utf8")) as Record<
  string,
  string | null
>;
const contents = Object.fromEntries(Object.entries(BASE).filter(([, v]) => v !== null)) as Record<
  string,
  string
>;

const plan = (files = parseUnifiedDiff(DIFF).filter((f) => !f.binary)) => ({
  project: "acme/gtm-automations",
  baseSha: "0253df7ed00df5f84097e01499f26e4be2f011cf",
  baseBranch: "main",
  headBranch: "rosterdock/task-1",
  title: "#1 Map VMS sub-workflow calls",
  body: "Review round 2 approved by Verifier.",
  commitMessage: "#1 Map VMS sub-workflow calls",
  files,
});

const provider = (fetch: typeof globalThis.fetch, token: string | null = "glpat-test") => ({
  fetch,
  token,
  apiBase: "https://gitlab.com/api/v4",
});

describe("parseGitLabRepo and the host registry", () => {
  it("accepts https gitlab.com namespace/project with subgroups, a self-hosted host when named, and nothing else", () => {
    expect(parseGitLabRepo("https://gitlab.com/acme/gtm-automations")).toEqual({
      project: "acme/gtm-automations",
    });
    expect(parseGitLabRepo("https://gitlab.com/acme/ops/gtm-automations.git")).toEqual({
      project: "acme/ops/gtm-automations",
    });
    expect(parseGitLabRepo("https://gitlab.com/acme")).toBeNull();
    expect(parseGitLabRepo("https://gitlab.com/acme/x/-/merge_requests/1")).toBeNull();
    expect(parseGitLabRepo("https://github.com/acme/x")).toBeNull();
    expect(parseGitLabRepo("https://git.example.com/acme/x")).toBeNull();
    expect(parseGitLabRepo("https://git.example.com/acme/x", "git.example.com")).toEqual({
      project: "acme/x",
    });
    expect(parseGitLabRepo("http://gitlab.com/acme/x")).toBeNull();
    const hosts = {
      github: { fetch, token: null, apiBase: "https://api.github.com" },
      gitlab: { fetch, token: null, apiBase: "https://git.example.com/api/v4" },
    };
    expect(parseRepo("https://github.com/acme/x.git", hosts)).toEqual({ provider: "github", path: "acme/x" });
    expect(parseRepo("https://git.example.com/acme/ops/x", hosts)).toEqual({
      provider: "gitlab",
      path: "acme/ops/x",
    });
    expect(parseRepo("https://gitlab.com/acme/x", hosts)).toBeNull();
    expect(parseRepo("https://gitlab.com/acme/x", { ...hosts, gitlab: null })).toBeNull();
    expect(changeNoun("gitlab")).toBe("merge request");
    expect(changeNoun("github")).toBe("pull request");
  });
});

describe("openMergeRequest", () => {
  it("applies the diff to the base commit as one commit of actions on a fresh branch, then opens the merge request", async () => {
    const gl = fakeGitLab(contents);
    const opened = await openMergeRequest(provider(gl.fetch), plan());
    expect(opened).toEqual({
      number: 17,
      url: "https://gitlab.com/acme/gtm-automations/-/merge_requests/17",
      commitSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      treeSha: "",
    });
    const calls = gl.requests.map((r) => `${r.method} ${r.path}`);
    expect(calls[0]).toBe(
      "GET /projects/acme%2Fgtm-automations/repository/commits/0253df7ed00df5f84097e01499f26e4be2f011cf",
    );
    // Modified files are read raw at the base sha; added and deleted ones are not.
    expect(calls.filter((c) => c.includes("/repository/files/"))).toEqual([
      "GET /projects/acme%2Fgtm-automations/repository/files/notes%20dir%2Fplain.txt/raw?ref=0253df7ed00df5f84097e01499f26e4be2f011cf",
      "GET /projects/acme%2Fgtm-automations/repository/files/workflows%2Fvms-digest.json/raw?ref=0253df7ed00df5f84097e01499f26e4be2f011cf",
    ]);
    // A branch that does not exist yet answers 404 to the delete; the commit starts it from the base.
    expect(calls).toContain(
      "DELETE /projects/acme%2Fgtm-automations/repository/branches/rosterdock%2Ftask-1",
    );
    const commit = gl.requests.find((r) => r.path.endsWith("/repository/commits") && r.method === "POST")!
      .body as {
      branch: string;
      start_sha: string;
      commit_message: string;
      actions: { action: string; file_path: string; content?: string }[];
    };
    expect(commit.branch).toBe("rosterdock/task-1");
    expect(commit.start_sha).toBe("0253df7ed00df5f84097e01499f26e4be2f011cf");
    expect(commit.actions.map((a) => [a.action, a.file_path])).toEqual([
      ["delete", "docs/old.md"],
      ["create", "docs/vms-architecture.md"],
      ["create", "notail.txt"],
      ["update", "notes dir/plain.txt"],
      ["update", "workflows/vms-digest.json"],
    ]);
    // Every action carries the exact patched content.
    expect(commit.actions.filter((a) => a.action !== "delete").map((a) => a.content)).toEqual([
      AFTER["docs/vms-architecture.md"],
      AFTER["notail.txt"],
      AFTER["notes dir/plain.txt"],
      AFTER["workflows/vms-digest.json"],
    ]);
    expect(gl.requests.find((r) => r.path.endsWith("/merge_requests"))!.body).toEqual({
      source_branch: "rosterdock/task-1",
      target_branch: "main",
      title: "#1 Map VMS sub-workflow calls",
      description: "Review round 2 approved by Verifier.",
    });
    // Auth is the private token header on every call and appears nowhere else.
    expect(gl.requests.every((r) => r.headers["private-token"] === "glpat-test")).toBe(true);
    expect(JSON.stringify(gl.requests.map((r) => r.body))).not.toContain("glpat-test");
  });

  it("removes a branch left by an earlier round, refuses binary files, needs a token, and reports API errors without it", async () => {
    const gl = fakeGitLab(contents);
    gl.branchExists = true;
    await openMergeRequest(provider(gl.fetch), plan());
    expect(gl.requests.some((r) => r.method === "DELETE" && r.path.includes("/repository/branches/"))).toBe(
      true,
    );
    await expect(openMergeRequest(provider(gl.fetch), plan(parseUnifiedDiff(DIFF)))).rejects.toThrow(
      /binary files cannot be opened .* logo\.bin/,
    );
    // With the bytes the run reported, the binary file is a base64 action.
    const withBytes = fakeGitLab(contents);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]).toString("base64");
    await openMergeRequest(provider(withBytes.fetch), {
      ...plan(parseUnifiedDiff(DIFF)),
      binaries: { "logo.bin": png },
    });
    const commit = withBytes.requests.find(
      (r) => r.path.endsWith("/repository/commits") && r.method === "POST",
    )!.body as { actions: { file_path: string; content?: string; encoding?: string }[] };
    expect(commit.actions.find((a) => a.file_path === "logo.bin")).toEqual({
      action: "update",
      file_path: "logo.bin",
      content: png,
      encoding: "base64",
    });
    await expect(openMergeRequest(provider(gl.fetch, null), plan())).rejects.toThrow(
      /ROSTERDOCK_GITLAB_TOKEN/,
    );
    const bad = fakeGitLab(contents);
    bad.failWith = 401;
    const err = await openMergeRequest(provider(bad.fetch, "glpat-secret"), plan()).catch((e) => e);
    expect(err).toBeInstanceOf(GitLabError);
    expect(err.status).toBe(401);
    expect(err.message).toContain("401");
    expect(err.message).not.toContain("glpat-secret");
  });

  it("closes a merge request with the note first", async () => {
    const gl = fakeGitLab(contents);
    await closeMergeRequest(provider(gl.fetch), { project: "acme/gtm-automations" }, 17, "Vetoed: not done.");
    expect(gl.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /projects/acme%2Fgtm-automations/merge_requests/17/notes",
      "PUT /projects/acme%2Fgtm-automations/merge_requests/17",
    ]);
    expect(gl.requests[0]!.body).toEqual({ body: "Vetoed: not done." });
    expect(gl.requests[1]!.body).toEqual({ state_event: "close" });
  });
});
