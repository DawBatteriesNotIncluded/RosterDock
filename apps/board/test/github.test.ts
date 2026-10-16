// The GitHub provider against the recorded API shapes. No network.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseUnifiedDiff } from "@rosterdock/shared";
import { describe, expect, it } from "vitest";
import { GitHubError, openPullRequest, parseGitHubRepo } from "../src/git/github.js";
import { fakeGitHub } from "./github-fake.js";

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

const plan = (files = parseUnifiedDiff(DIFF).filter((f) => !f.binary)) => ({
  owner: "acme",
  repo: "gtm-automations",
  baseSha: "0253df7ed00df5f84097e01499f26e4be2f011cf",
  baseBranch: "main",
  headBranch: "rosterdock/task-1",
  title: "#1 Map VMS sub-workflow calls",
  body: "Review round 2 approved by Verifier.",
  commitMessage: "#1 Map VMS sub-workflow calls",
  files,
});

const contents = Object.fromEntries(Object.entries(BASE).filter(([, v]) => v !== null)) as Record<
  string,
  string
>;

describe("parseGitHubRepo", () => {
  it("accepts https github.com owner/repo with or without .git and nothing else", () => {
    expect(parseGitHubRepo("https://github.com/acme/gtm-automations")).toEqual({
      owner: "acme",
      repo: "gtm-automations",
    });
    expect(parseGitHubRepo("https://github.com/acme/gtm-automations.git")).toEqual({
      owner: "acme",
      repo: "gtm-automations",
    });
    expect(parseGitHubRepo("https://gitlab.com/acme/x")).toBeNull();
    expect(parseGitHubRepo("git@github.com:acme/x.git")).toBeNull();
    expect(parseGitHubRepo("https://github.com/acme")).toBeNull();
    expect(parseGitHubRepo(null)).toBeNull();
  });
});

describe("openPullRequest", () => {
  it("applies the diff to the base commit through blobs, a tree, a commit, a branch and a pull request", async () => {
    const gh = fakeGitHub(contents);
    const opened = await openPullRequest(
      { fetch: gh.fetch, token: "ghs_test", apiBase: "https://api.github.test" },
      plan(),
    );
    expect(opened).toEqual({
      number: 42,
      url: "https://github.com/acme/gtm-automations/pull/42",
      commitSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      treeSha: "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c",
    });
    const calls = gh.requests.map((r) => `${r.method} ${r.path}`);
    expect(calls[0]).toBe(
      "GET /repos/acme/gtm-automations/git/commits/0253df7ed00df5f84097e01499f26e4be2f011cf",
    );
    // Modified files are fetched at the base sha; added and deleted ones are not.
    expect(calls.filter((c) => c.includes("/contents/"))).toEqual([
      "GET /repos/acme/gtm-automations/contents/notes%20dir/plain.txt?ref=0253df7ed00df5f84097e01499f26e4be2f011cf",
      "GET /repos/acme/gtm-automations/contents/workflows/vms-digest.json?ref=0253df7ed00df5f84097e01499f26e4be2f011cf",
    ]);
    // Every blob carries the exact patched content.
    const blobs = gh.requests
      .filter((r) => r.path.endsWith("/git/blobs"))
      .map((r) => r.body as { content: string });
    expect(blobs.map((b) => b.content)).toEqual([
      AFTER["docs/vms-architecture.md"],
      AFTER["notail.txt"],
      AFTER["notes dir/plain.txt"],
      AFTER["workflows/vms-digest.json"],
    ]);
    const tree = gh.requests.find((r) => r.path.endsWith("/git/trees"))!.body as {
      base_tree: string;
      tree: { path: string; sha: string | null }[];
    };
    expect(tree.base_tree).toBe("3c2d7f1b9a0e5d4c8b7a6f5e4d3c2b1a0f9e8d7c");
    expect(tree.tree.map((t) => [t.path, t.sha === null])).toEqual([
      ["docs/old.md", true],
      ["docs/vms-architecture.md", false],
      ["notail.txt", false],
      ["notes dir/plain.txt", false],
      ["workflows/vms-digest.json", false],
    ]);
    const commit = gh.requests.find((r) => r.path.endsWith("/git/commits") && r.method === "POST")!.body as {
      parents: string[];
    };
    expect(commit.parents).toEqual(["0253df7ed00df5f84097e01499f26e4be2f011cf"]);
    expect(gh.requests.find((r) => r.path.endsWith("/git/refs"))!.body).toEqual({
      ref: "refs/heads/rosterdock/task-1",
      sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    });
    expect(gh.requests.find((r) => r.path.endsWith("/pulls"))!.body).toEqual({
      title: "#1 Map VMS sub-workflow calls",
      head: "rosterdock/task-1",
      base: "main",
      body: "Review round 2 approved by Verifier.",
    });
    // Auth is a bearer header on every call and appears nowhere else.
    expect(gh.requests.every((r) => r.headers.authorization === "Bearer ghs_test")).toBe(true);
  });

  it("moves an existing branch instead of failing, refuses binary files and reports API errors without the token", async () => {
    const gh = fakeGitHub(contents);
    gh.branchExists = true;
    await openPullRequest({ fetch: gh.fetch, token: "ghs_test", apiBase: "https://api.github.test" }, plan());
    expect(
      gh.requests.some((r) => r.method === "PATCH" && r.path.endsWith("/git/refs/heads/rosterdock/task-1")),
    ).toBe(true);

    await expect(
      openPullRequest(
        { fetch: gh.fetch, token: "ghs_test", apiBase: "https://api.github.test" },
        plan(parseUnifiedDiff(DIFF)),
      ),
    ).rejects.toThrow(/binary files cannot be opened .* logo\.bin/);
    // With the bytes the run reported, the binary file is a base64 blob in the tree.
    const withBytes = fakeGitHub(contents);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]).toString("base64");
    await openPullRequest(
      { fetch: withBytes.fetch, token: "ghs_test", apiBase: "https://api.github.test" },
      { ...plan(parseUnifiedDiff(DIFF)), binaries: { "logo.bin": png } },
    );
    const blobs = withBytes.requests.filter((r) => r.path.endsWith("/git/blobs")).map((r) => r.body) as {
      content: string;
      encoding: string;
    }[];
    expect(blobs.find((b) => b.encoding === "base64")).toEqual({ content: png, encoding: "base64" });
    const tree = withBytes.requests.find((r) => r.path.endsWith("/git/trees"))!.body as {
      tree: { path: string }[];
    };
    expect(tree.tree.map((t) => t.path)).toContain("logo.bin");

    const bad = fakeGitHub(contents);
    bad.failWith = 401;
    const err = await openPullRequest(
      { fetch: bad.fetch, token: "ghs_secret", apiBase: "https://api.github.test" },
      plan(),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.status).toBe(401);
    expect(err.message).toMatch(/Bad credentials/);
    expect(err.message).not.toContain("ghs_secret");

    await expect(openPullRequest({ fetch: gh.fetch, token: null, apiBase: "x" }, plan())).rejects.toThrow(
      /ROSTERDOCK_GITHUB_TOKEN/,
    );
  });
});
