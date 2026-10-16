// The GitHub provider: opens a pull request from a reviewed diff without a
// git checkout, through the REST Git Data API. The diff is applied to the
// exact base commit the run started from (blobs, one tree, one commit, one
// branch, one pull request). `fetch` is injected so tests replay recorded
// responses; the token is a bearer header and never appears in errors.

import { applyFilePatch, type DiffFile } from "@rosterdock/shared";

export interface GitHubProvider {
  fetch: typeof fetch;
  /** null: the board has no ROSTERDOCK_GITHUB_TOKEN; pull requests stay proposed. */
  token: string | null;
  apiBase: string;
}

export interface GitHubRepo {
  owner: string;
  repo: string;
}

export class GitHubError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

/** `https://github.com/owner/repo(.git)` only. Other hosts and shapes are null. */
export function parseGitHubRepo(url: string | null | undefined): GitHubRepo | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.hostname.toLowerCase() !== "github.com") return null;
    const parts = u.pathname
      .replace(/\.git$/, "")
      .split("/")
      .filter(Boolean);
    if (parts.length !== 2) return null;
    return { owner: parts[0]!, repo: parts[1]! };
  } catch {
    return null;
  }
}

export interface PullRequestPlan {
  owner: string;
  repo: string;
  baseSha: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
  commitMessage: string;
  files: DiffFile[];
  /** Bytes of the binary files in the diff, base64 by path. */
  binaries?: Record<string, string>;
}

export interface OpenedPullRequest {
  number: number;
  url: string;
  commitSha: string;
  treeSha: string;
}

async function call<T>(gh: GitHubProvider, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await gh.fetch(`${gh.apiBase}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(gh.token ? { authorization: `Bearer ${gh.token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new GitHubError(`GitHub unreachable: ${(err as Error).message}`);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON error page
  }
  if (!res.ok) {
    const msg = (json as { message?: string } | null)?.message ?? text.slice(0, 200);
    throw new GitHubError(`GitHub ${method} ${path} failed (${res.status}): ${msg}`, res.status);
  }
  return json as T;
}

function decodeContent(payload: { content?: string; encoding?: string }): string {
  if (payload.encoding !== "base64" || typeof payload.content !== "string")
    throw new GitHubError("unexpected contents encoding from GitHub");
  return Buffer.from(payload.content.replace(/\n/g, ""), "base64").toString("utf8");
}

/** Open the pull request. A binary file rides as the bytes the run reported; without them it refuses the whole plan. */
export async function openPullRequest(gh: GitHubProvider, plan: PullRequestPlan): Promise<OpenedPullRequest> {
  if (!gh.token)
    throw new GitHubError("no GitHub token is configured on the board (ROSTERDOCK_GITHUB_TOKEN)");
  const repo = `/repos/${encodeURIComponent(plan.owner)}/${encodeURIComponent(plan.repo)}`;
  const binaries = plan.binaries ?? {};
  const missing = plan.files.filter((f) => f.binary && f.status !== "deleted" && !binaries[f.path]);
  if (missing.length)
    throw new GitHubError(
      `binary files cannot be opened as a pull request from a diff alone; the run reported no bytes for ${missing.map((f) => f.path).join(", ")}`,
    );
  const base = await call<{ tree: { sha: string } }>(gh, "GET", `${repo}/git/commits/${plan.baseSha}`);
  const tree: { path: string; mode: "100644"; type: "blob"; sha: string | null }[] = [];
  for (const file of plan.files) {
    if (file.status === "deleted") {
      tree.push({ path: file.path, mode: "100644", type: "blob", sha: null });
      continue;
    }
    if (file.binary) {
      const blob = await call<{ sha: string }>(gh, "POST", `${repo}/git/blobs`, {
        content: binaries[file.path],
        encoding: "base64",
      });
      tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
      continue;
    }
    let baseText: string | null = null;
    if (file.status === "modified") {
      const contents = await call<{ content?: string; encoding?: string }>(
        gh,
        "GET",
        `${repo}/contents/${file.path.split("/").map(encodeURIComponent).join("/")}?ref=${plan.baseSha}`,
      );
      baseText = decodeContent(contents);
    }
    const next = applyFilePatch(baseText, file);
    const blob = await call<{ sha: string }>(gh, "POST", `${repo}/git/blobs`, {
      content: next ?? "",
      encoding: "utf-8",
    });
    tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const newTree = await call<{ sha: string }>(gh, "POST", `${repo}/git/trees`, {
    base_tree: base.tree.sha,
    tree,
  });
  const commit = await call<{ sha: string }>(gh, "POST", `${repo}/git/commits`, {
    message: plan.commitMessage,
    tree: newTree.sha,
    parents: [plan.baseSha],
  });
  const ref = `refs/heads/${plan.headBranch}`;
  try {
    await call(gh, "POST", `${repo}/git/refs`, { ref, sha: commit.sha });
  } catch (err) {
    // The branch exists from an earlier round: move it.
    if (!(err instanceof GitHubError && err.status === 422)) throw err;
    await call(gh, "PATCH", `${repo}/git/${ref}`, { sha: commit.sha, force: true });
  }
  const pr = await call<{ number: number; html_url: string }>(gh, "POST", `${repo}/pulls`, {
    title: plan.title,
    head: plan.headBranch,
    base: plan.baseBranch,
    body: plan.body,
  });
  return { number: pr.number, url: pr.html_url, commitSha: commit.sha, treeSha: newTree.sha };
}

/**
 * Close a pull request the board opened, after a veto: a comment with the
 * note, then the state. The branch stays; a person may still want it.
 */
export async function closePullRequest(
  gh: GitHubProvider,
  repo: GitHubRepo,
  number: number,
  note: string | null,
): Promise<void> {
  if (!gh.token)
    throw new GitHubError("no GitHub token is configured on the board (ROSTERDOCK_GITHUB_TOKEN)");
  const base = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
  if (note) await call(gh, "POST", `${base}/issues/${number}/comments`, { body: note });
  await call(gh, "PATCH", `${base}/pulls/${number}`, { state: "closed" });
}
