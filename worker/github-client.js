/**
 * GitHub client — provides the same interface as azdo-client.js
 * so processWorkItem.js can use it without branching.
 *
 * Required env var:  GITHUB_TOKEN  (personal access token or fine-grained PAT)
 */

const BASE_URL = "https://api.github.com";

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "myridius-code-agent/1.0",
    "Content-Type": "application/json",
  };
}

export function createGitHubClient({ owner, repoName, issueNumber }) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("Missing required environment variable: GITHUB_TOKEN");

  const headers = githubHeaders(token);
  // Expose org/project so existing code that reads azdo.org / azdo.project still works
  const org = owner;
  const project = repoName;

  async function apiFetch(path, options = {}) {
    const res = await fetch(`${BASE_URL}${path}`, { headers, ...options });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub API ${options.method || "GET"} ${path} failed: ${res.status} ${text}`);
    }
    return res.json();
  }

  /** Mimic ADO getWorkItem — returns { id, fields } */
  async function getWorkItem(id) {
    const issue = await apiFetch(`/repos/${owner}/${repoName}/issues/${id}`);
    return {
      id: issue.number,
      fields: {
        "System.Title": issue.title || "",
        "System.Description": issue.body || "",
        "System.WorkItemType": "User Story",
        "Microsoft.VSTS.Common.AcceptanceCriteria": "",
      },
    };
  }

  /** Mimic ADO patchWorkItemFields — GitHub doesn't have custom fields; no-op */
  async function patchWorkItemFields(_id, _ops) {
    // GitHub issues don't support custom fields like ADO — silently skip
  }

  /** Post a comment on the issue */
  async function postComment(id, text) {
    await apiFetch(`/repos/${owner}/${repoName}/issues/${id}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: text }),
    });
  }

  /** Returns only the current repo (GitHub context is already repo-scoped) */
  async function listRepositories() {
    return [{ name: repoName, id: `${owner}/${repoName}`, remoteUrl: `https://github.com/${owner}/${repoName}` }];
  }

  /** Build authenticated HTTPS clone URL */
  function buildCloneUrl(_repoName) {
    return `https://oauth2:${token}@github.com/${owner}/${_repoName}.git`;
  }

  /** Create a GitHub pull request */
  async function createPullRequest({ repo: rName, sourceBranch, targetRefName, title, description }) {
    const base = (targetRefName || "refs/heads/main").replace("refs/heads/", "");
    const pr = await apiFetch(`/repos/${owner}/${rName}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title, body: description, head: sourceBranch, base }),
    });
    return {
      pullRequestId: pr.number,
      url: pr.html_url,
    };
  }

  /** Find an open PR for the given source branch */
  async function findActivePullRequestBySourceBranch(rName, sourceBranch) {
    const prs = await apiFetch(
      `/repos/${owner}/${rName}/pulls?state=open&head=${encodeURIComponent(owner + ":" + sourceBranch)}`
    ).catch(() => []);
    if (!prs.length) return null;
    return { pullRequestId: prs[0].number, url: prs[0].html_url };
  }

  return {
    org,
    project,
    getWorkItem,
    patchWorkItemFields,
    postComment,
    listRepositories,
    buildCloneUrl,
    createPullRequest,
    findActivePullRequestBySourceBranch,
  };
}

/**
 * Detect if a raw Event Hub payload is a GitHub webhook payload.
 * GitHub webhooks always include `repository.full_name` and `sender.login`.
 */
export function isGitHubPayload(payload) {
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof payload.repository?.full_name === "string" &&
    typeof payload.sender?.login === "string"
  );
}

/**
 * Adds a label to a GitHub issue.
 */
export async function addIssueLabel(owner, repo, issueNumber, label, token) {
  const res = await fetch(`${BASE_URL}/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
    method: "POST",
    headers: githubHeaders(token),
    body: JSON.stringify({ labels: [label] }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub addIssueLabel ${owner}/${repo}#${issueNumber} failed (${res.status}): ${text}`);
  }
}

/**
 * Removes a label from a GitHub issue (no-op if label does not exist).
 */
export async function removeIssueLabel(owner, repo, issueNumber, label, token) {
  const res = await fetch(
    `${BASE_URL}/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
    { method: "DELETE", headers: githubHeaders(token) }
  );
  // 404 means label wasn't applied — treat as success
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub removeIssueLabel ${owner}/${repo}#${issueNumber} failed (${res.status}): ${text}`);
  }
}

/**
 * Finds the first issue comment that starts with the <!-- implementation-plan --> marker.
 * Returns the comment body string, or null if not found.
 */
export async function findPlanComment(owner, repo, issueNumber, token) {
  const url = `${BASE_URL}/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`;
  const res = await fetch(url, { headers: githubHeaders(token) });
  if (!res.ok) return null;
  const comments = await res.json().catch(() => []);
  if (!Array.isArray(comments)) return null;
  const planComment = comments.find((c) => typeof c.body === "string" && c.body.trimStart().startsWith("<!-- implementation-plan -->"));
  return planComment?.body ?? null;
}

/**
 * Extract GitHub issue context from an issue-labeled webhook payload.
 * Returns null if this isn't a GitHub issue event.
 */
export function extractGitHubIssueContext(payload) {
  const action = payload?.action;
  const issue = payload?.issue;
  const repo = payload?.repository;

  if (!issue || !repo) return null;

  const owner = repo?.owner?.login || repo?.full_name?.split("/")[0];
  const repoName = repo?.name;
  const issueNumber = issue?.number;

  if (!owner || !repoName || !issueNumber) return null;

  return {
    owner,
    repoName,
    issueNumber,
    action,
    title: issue.title || "",
    body: issue.body || "",
    labelName: payload?.label?.name || null,
  };
}
