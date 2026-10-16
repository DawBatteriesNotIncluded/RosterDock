// The git hosts the board can open a change on: GitHub (a pull request) and
// GitLab (a merge request). A project's repository URL says which; the same
// plan, the same sha256-bound payload and the same outcome row serve both.

import type { DiffFile } from "@rosterdock/shared";
import {
  closePullRequest,
  openPullRequest,
  parseGitHubRepo,
  type GitHubProvider,
  type OpenedPullRequest,
} from "./github.js";
import {
  closeMergeRequest,
  gitLabHost,
  openMergeRequest,
  parseGitLabRepo,
  type GitLabProvider,
} from "./gitlab.js";

export interface GitHosts {
  github: GitHubProvider;
  /** null: no GitLab on this board; a GitLab repository URL proposes nothing. */
  gitlab: GitLabProvider | null;
}

export type GitProvider = "github" | "gitlab";

export interface RepoRef {
  provider: GitProvider;
  /** owner/repo on GitHub; group/project on GitLab. What the pull_requests row stores as `repo`. */
  path: string;
}

/** Which host a repository URL belongs to, or null when the board opens nothing there. */
export function parseRepo(
  url: string | null | undefined,
  hosts: Pick<GitHosts, "gitlab"> | null,
): RepoRef | null {
  const gh = parseGitHubRepo(url);
  if (gh) return { provider: "github", path: `${gh.owner}/${gh.repo}` };
  if (hosts?.gitlab) {
    const gl = parseGitLabRepo(url, gitLabHost(hosts.gitlab.apiBase));
    if (gl) return { provider: "gitlab", path: gl.project };
  }
  return null;
}

export interface ChangePlan {
  /** Bytes of the binary files in the diff, base64 by path; a binary file without them refuses the plan. */
  binaries?: Record<string, string>;
  baseSha: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
  commitMessage: string;
  files: DiffFile[];
}

/** What the host calls the change, for people. */
export function changeNoun(provider: string): string {
  return provider === "gitlab" ? "merge request" : "pull request";
}

/** Open the change on the host the row names. */
export async function openChange(
  hosts: GitHosts,
  provider: string,
  path: string,
  plan: ChangePlan,
): Promise<OpenedPullRequest> {
  if (provider === "gitlab") {
    if (!hosts.gitlab) throw new Error("no GitLab is configured on the board (ROSTERDOCK_GITLAB_TOKEN)");
    return openMergeRequest(hosts.gitlab, { ...plan, project: path });
  }
  const repo = parseGitHubRepo(`https://github.com/${path}`);
  if (!repo) throw new Error(`${path} is not a GitHub repository`);
  return openPullRequest(hosts.github, { ...plan, owner: repo.owner, repo: repo.repo });
}

/** Close the change the board opened, with a note. */
export async function closeChange(
  hosts: GitHosts,
  provider: string,
  path: string,
  number: number,
  note: string | null,
): Promise<void> {
  if (provider === "gitlab") {
    if (!hosts.gitlab) throw new Error("no GitLab is configured on the board (ROSTERDOCK_GITLAB_TOKEN)");
    return closeMergeRequest(hosts.gitlab, { project: path }, number, note);
  }
  const repo = parseGitHubRepo(`https://github.com/${path}`);
  if (!repo) throw new Error(`${path} is not a GitHub repository`);
  return closePullRequest(hosts.github, repo, number, note);
}
