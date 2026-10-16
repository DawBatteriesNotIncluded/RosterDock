// The GitLab provider: opens a merge request from a reviewed diff without a
// git checkout, through the REST API v4 (repository files, one commit with
// its actions, one merge request). The diff is applied to the exact base
// commit the run started from: modified files are read at that sha, the
// commit starts a fresh branch from it (an older branch of the same name is
// deleted first). `fetch` is injected so tests replay recorded responses; the
// token is a PRIVATE-TOKEN header and never appears in errors. gitlab.com by
// default; a self-hosted instance by ROSTERDOCK_GITLAB_API.

import { applyFilePatch, type DiffFile } from "@rosterdock/shared";
import type { OpenedPullRequest } from "./github.js";

export interface GitLabProvider {
  fetch: typeof fetch;
  /** null: the board has no ROSTERDOCK_GITLAB_TOKEN; merge requests stay proposed. */
  token: string | null;
  /** The API root, e.g. https://gitlab.com/api/v4. Its host is the one repository URLs must carry. */
  apiBase: string;
}

export interface GitLabRepo {
  /** The project path with namespace: group/subgroup/project. */
  project: string;
}

export class GitLabError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "GitLabError";
    this.status = status;
  }
}

/** The host repository URLs must carry to be this provider's: the API base's. */
export function gitLabHost(apiBase: string): string {
  try {
    return new URL(apiBase).hostname.toLowerCase();
  } catch {
    return "gitlab.com";
  }
}

/** `https://<host>/group(/subgroup...)/project(.git)`; at least a namespace and a project. Other hosts and shapes are null. */
export function parseGitLabRepo(url: string | null | undefined, host = "gitlab.com"): GitLabRepo | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.hostname.toLowerCase() !== host.toLowerCase()) return null;
    const parts = u.pathname
      .replace(/\.git$/, "")
      .split("/")
      .filter(Boolean);
    if (parts.length < 2 || parts.includes("-")) return null;
    return { project: parts.join("/") };
  } catch {
    return null;
  }
}

export interface MergeRequestPlan {
  project: string;
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

async function call<T>(
  gl: GitLabProvider,
  method: string,
  path: string,
  body?: unknown,
  opts: { raw?: boolean } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await gl.fetch(`${gl.apiBase}${path}`, {
      method,
      headers: {
        accept: opts.raw ? "text/plain" : "application/json",
        ...(gl.token ? { "private-token": gl.token } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new GitLabError(`GitLab unreachable: ${(err as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 200);
    try {
      const json = JSON.parse(text) as { message?: unknown; error?: unknown };
      msg =
        typeof json.message === "string" ? json.message : JSON.stringify(json.message ?? json.error ?? msg);
    } catch {
      // non-JSON error page
    }
    throw new GitLabError(`GitLab ${method} ${path} failed (${res.status}): ${msg}`, res.status);
  }
  if (opts.raw) return text as unknown as T;
  try {
    return (text ? JSON.parse(text) : null) as T;
  } catch {
    throw new GitLabError(`GitLab ${method} ${path} answered something that is not JSON`);
  }
}

const projectId = (project: string) => encodeURIComponent(project);
const filePath = (path: string) => encodeURIComponent(path);

/** Open the merge request. Binary files cannot be carried by a text diff and refuse the whole plan. */
export async function openMergeRequest(
  gl: GitLabProvider,
  plan: MergeRequestPlan,
): Promise<OpenedPullRequest> {
  if (!gl.token)
    throw new GitLabError("no GitLab token is configured on the board (ROSTERDOCK_GITLAB_TOKEN)");
  const p = `/projects/${projectId(plan.project)}`;
  const binaries = plan.binaries ?? {};
  const missing = plan.files.filter((f) => f.binary && f.status !== "deleted" && !binaries[f.path]);
  if (missing.length)
    throw new GitLabError(
      `binary files cannot be opened as a merge request from a diff alone; the run reported no bytes for ${missing.map((f) => f.path).join(", ")}`,
    );
  // The base must exist as the run recorded it.
  await call<{ id: string }>(gl, "GET", `${p}/repository/commits/${plan.baseSha}`);
  const actions: {
    action: "create" | "update" | "delete";
    file_path: string;
    content?: string;
    encoding?: "base64";
  }[] = [];
  for (const file of plan.files) {
    if (file.status === "deleted") {
      actions.push({ action: "delete", file_path: file.path });
      continue;
    }
    if (file.binary) {
      actions.push({
        action: file.status === "added" ? "create" : "update",
        file_path: file.path,
        content: binaries[file.path],
        encoding: "base64",
      });
      continue;
    }
    let baseText: string | null = null;
    if (file.status === "modified")
      baseText = await call<string>(
        gl,
        "GET",
        `${p}/repository/files/${filePath(file.path)}/raw?ref=${plan.baseSha}`,
        undefined,
        { raw: true },
      );
    actions.push({
      action: file.status === "added" ? "create" : "update",
      file_path: file.path,
      content: applyFilePatch(baseText, file) ?? "",
    });
  }
  // A branch left by an earlier round is removed, so the commit starts from the base again.
  try {
    await call(gl, "DELETE", `${p}/repository/branches/${encodeURIComponent(plan.headBranch)}`);
  } catch (err) {
    if (!(err instanceof GitLabError && err.status === 404)) throw err;
  }
  const commit = await call<{ id: string }>(gl, "POST", `${p}/repository/commits`, {
    branch: plan.headBranch,
    start_sha: plan.baseSha,
    commit_message: plan.commitMessage,
    actions,
  });
  const mr = await call<{ iid: number; web_url: string }>(gl, "POST", `${p}/merge_requests`, {
    source_branch: plan.headBranch,
    target_branch: plan.baseBranch,
    title: plan.title,
    description: plan.body,
  });
  return { number: mr.iid, url: mr.web_url, commitSha: commit.id, treeSha: "" };
}

/** Close a merge request the board opened, after a veto: a note, then the state. The branch stays. */
export async function closeMergeRequest(
  gl: GitLabProvider,
  repo: GitLabRepo,
  iid: number,
  note: string | null,
): Promise<void> {
  if (!gl.token)
    throw new GitLabError("no GitLab token is configured on the board (ROSTERDOCK_GITLAB_TOKEN)");
  const p = `/projects/${projectId(repo.project)}/merge_requests/${iid}`;
  if (note) await call(gl, "POST", `${p}/notes`, { body: note });
  await call(gl, "PUT", p, { state_event: "close" });
}
