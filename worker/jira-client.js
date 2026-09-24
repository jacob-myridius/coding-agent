/**
 * Jira payload detection, issue context extraction, and GitHub SCM client
 * for the code agent.
 *
 * Responsibility split:
 *   - SCM operations (clone, push, PR)  → GitHub, via createJiraGitHubClient
 *   - Tracker operations (post comment) → Jira, via postJiraComment (called
 *     lazily after implementation, only when a comment needs to be posted)
 *
 * Jira credentials are never requested upfront — all issue content arrives
 * in the webhook payload and no Jira API read is required.
 */

// ---------------------------------------------------------------------------
// Payload detection
// ---------------------------------------------------------------------------

/**
 * Returns true if the Event Hub payload looks like a Jira webhook event.
 * Jira webhooks always include `webhookEvent` (starts with "jira:") and
 * `issue.key`.
 */
export function isJiraPayload(payload) {
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof payload.webhookEvent === "string" &&
    payload.webhookEvent.startsWith("jira:") &&
    typeof payload.issue?.key === "string"
  );
}

// ---------------------------------------------------------------------------
// Issue context extraction
// ---------------------------------------------------------------------------

const TRIGGER_LABELS = new Set(["ai:ready-for-implementation", "ai:ready-for-implementation-plan"]);

/**
 * Extracts the issue context needed to drive implementation.
 * Returns null if the trigger label was not added by this event — the caller
 * should return a NoStatusTransition skip in that case.
 *
 * Handles two event shapes:
 *   - jira:issue_created  — label is already present in issue.fields.labels
 *   - jira:issue_updated  — label was added in changelog.items
 */
export function extractJiraIssueContext(payload) {
  const issue = payload?.issue;
  if (!issue?.key || !issue?.fields) return null;

  let labelAdded = null;

  // Case 1: new issue created with the trigger label already set
  if (payload.webhookEvent === "jira:issue_created") {
    const labels = Array.isArray(issue.fields.labels) ? issue.fields.labels : [];
    const found = labels.find((l) => TRIGGER_LABELS.has(l));
    if (found) labelAdded = found;
  }

  // Case 2: existing issue updated — find the label in the changelog
  if (!labelAdded) {
    const items = Array.isArray(payload.changelog?.items) ? payload.changelog.items : [];
    for (const item of items) {
      if (item.field === "labels" || item.fieldId === "labels") {
        const fromStr = String(item.fromString ?? item.from ?? "");
        const toStr = String(item.toString ?? item.to ?? "");
        const added = toStr
          .split(/\s+/)
          .find((l) => l && !fromStr.split(/\s+/).includes(l));
        if (added && TRIGGER_LABELS.has(added)) {
          labelAdded = added;
          break;
        }
      }
    }
  }

  if (!labelAdded) return null;

  return {
    issueKey: issue.key,
    labelAdded,
    title: String(issue.fields?.summary ?? ""),
    body: extractJiraText(issue.fields?.description),
    acceptanceCriteria: String(issue.fields?.customfield_10014 ?? ""),
  };
}

// ---------------------------------------------------------------------------
// Repo name extraction from scaffold story title
// ---------------------------------------------------------------------------

/**
 * Scaffold stories created by the architecture agent follow the title format:
 *   "[Scaffold] my-repo-name"  or  "[Scaffold] my-repo-name — ui component"
 *
 * Returns the repo name, or null if the title doesn't match.
 */
export function extractRepoFromTitle(title) {
  const m = title.match(/^\[scaffold\]\s+([\w][\w-]*)/i);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Standalone Jira tracker operation — called lazily after implementation
// ---------------------------------------------------------------------------

/**
 * Posts a plain-text comment on a Jira issue (ADF-wrapped).
 * Credentials are acquired from the broker only when this is called,
 * with the minimal ISSUE_WRITE capability — no upfront ISSUE_READ needed.
 *
 * @param {string} host     Jira cloud hostname (e.g. "example.atlassian.net")
 * @param {string} issueKey Jira issue key (e.g. "MTRAW-5")
 * @param {string} email    Jira service account email
 * @param {string} token    Jira API token
 * @param {string} text     Plain-text comment body
 */
export async function postJiraComment(host, issueKey, email, token, text) {
  const url = `https://${host}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`;
  const body = {
    body: {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: basicAuth(email, token),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Jira postComment ${issueKey} failed (${res.status}): ${errText}`);
  }
}

// ---------------------------------------------------------------------------
// GitHub SCM client (duck-typed to match azdo-client.js / github-client.js)
// ---------------------------------------------------------------------------

/**
 * Creates a GitHub-only implementation client for use with implementInRepo.
 *
 * Issue content (title, description, acceptance criteria) already arrives in
 * the webhook payload — no Jira API read is needed here.  Tracker credentials
 * are acquired separately and only when posting a result comment.
 *
 * @param {object} opts
 * @param {string} opts.issueKey    Jira issue key — used for org/project labels in code search
 * @param {string} opts.owner       GitHub org / owner (from broker GitHub grant)
 * @param {string} opts.repoName    GitHub repo name (from scaffold story title)
 * @param {string} opts.githubToken GitHub personal access token (from broker)
 */
export function createJiraGitHubClient({ issueKey, owner, repoName, githubToken }) {
  // Expose org/project so getCodeContext() in code-context.js doesn't crash.
  // Use GitHub owner/repo for search context rather than Jira host/project.
  const org = owner;
  const project = repoName;

  // Tracker methods are no-ops — issue content comes from the webhook payload,
  // and comments are posted via postJiraComment after implementInRepo returns.
  async function getWorkItem(_id) { return { id: _id, fields: {} }; }
  async function patchWorkItemFields(_id, _ops) {}
  async function postComment(_id, _text) {}

  // ── GitHub / code operations ──────────────────────────────────────────────

  function listRepositories() {
    return Promise.resolve([
      { name: repoName, id: `${owner}/${repoName}`, remoteUrl: buildCloneUrl(repoName) },
    ]);
  }

  function buildCloneUrl(_repoName) {
    return `https://oauth2:${githubToken}@github.com/${owner}/${repoName}.git`;
  }

  async function createPullRequest({ repo, sourceBranch, targetRefName, title: prTitle, description }) {
    const base = targetRefName.replace("refs/heads/", "");
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls`;
    const res = await fetch(url, {
      method: "POST",
      headers: githubHeaders(),
      body: JSON.stringify({ title: prTitle, body: description, head: sourceBranch, base }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub createPullRequest ${owner}/${repo} failed (${res.status}): ${text}`);
    }
    const pr = await res.json();
    return { pullRequestId: pr.number, url: pr.html_url };
  }

  async function findActivePullRequestBySourceBranch(repo, sourceBranch) {
    const head = encodeURIComponent(`${owner}:${sourceBranch}`);
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&head=${head}`;
    const res = await fetch(url, { headers: githubHeaders() });
    if (!res.ok) return null;
    const prs = await res.json();
    if (!Array.isArray(prs) || prs.length === 0) return null;
    return { pullRequestId: prs[0].number, url: prs[0].html_url };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function githubHeaders() {
    return {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "myridius-code-agent/1.0",
    };
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

// ---------------------------------------------------------------------------
// Jira tracker utilities (used by implementation-plan-handler.js)
// ---------------------------------------------------------------------------

/**
 * Fetches basic issue fields: summary, description, labels, acceptance criteria.
 */
export async function fetchJiraIssue(host, issueKey, email, token) {
  const url = `https://${host}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,description,labels,customfield_10014`;
  const res = await fetch(url, { headers: { Authorization: basicAuth(email, token), Accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Jira fetch issue ${issueKey} failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  return {
    title: data.fields?.summary ?? "",
    description: extractJiraText(data.fields?.description),
    acceptanceCriteria: String(data.fields?.customfield_10014 ?? ""),
    labels: Array.isArray(data.fields?.labels) ? data.fields.labels : [],
  };
}

/** Returns attachment metadata (id, filename, content URL) for a Jira issue. */
export async function fetchIssueAttachments(host, issueKey, email, token) {
  const res = await fetch(
    `https://${host}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=attachment`,
    { headers: { Authorization: basicAuth(email, token), Accept: "application/json" } }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return data.fields?.attachment ?? [];
}

/** Downloads the text content of a Jira attachment by its content URL. */
export async function downloadJiraAttachment(contentUrl, email, token) {
  const res = await fetch(contentUrl, { headers: { Authorization: basicAuth(email, token) } });
  if (!res.ok) throw new Error(`Jira attachment download failed (${res.status}): ${contentUrl}`);
  return res.text();
}

/** Uploads a text file as an attachment to a Jira issue (multipart form). */
export async function uploadJiraTextAttachment(host, issueKey, email, token, text, filename) {
  const boundary = `----MyridiBoundary${Date.now()}`;
  const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/markdown\r\n\r\n${text}\r\n--${boundary}--`;
  const res = await fetch(
    `https://${host}/rest/api/3/issue/${encodeURIComponent(issueKey)}/attachments`,
    {
      method: "POST",
      headers: {
        Authorization: basicAuth(email, token),
        "X-Atlassian-Token": "no-check",
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    }
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Jira upload attachment ${filename} to ${issueKey} failed (${res.status}): ${errText}`);
  }
}

/** Deletes attachments whose filenames start with any of the given prefixes. */
export async function deleteJiraAttachmentsByPrefix(host, issueKey, email, token, prefixes) {
  const attachments = await fetchIssueAttachments(host, issueKey, email, token);
  await Promise.allSettled(
    attachments
      .filter((a) => prefixes.some((p) => a.filename.startsWith(p)))
      .map((a) =>
        fetch(`https://${host}/rest/api/3/attachment/${a.id}`, {
          method: "DELETE",
          headers: { Authorization: basicAuth(email, token) },
        }).catch(() => {})
      )
  );
}

/** Applies label mutations (add + remove) by fetching current labels and PUTting the result. */
export async function updateJiraLabels(host, issueKey, email, token, labelsToRemove, labelsToAdd, currentLabels) {
  const filtered = currentLabels.filter((l) => !labelsToRemove.includes(l));
  const merged = [...filtered, ...labelsToAdd.filter((l) => !filtered.includes(l))];
  const res = await fetch(
    `https://${host}/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
    {
      method: "PUT",
      headers: { Authorization: basicAuth(email, token), "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ fields: { labels: merged } }),
    }
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Jira update labels on ${issueKey} failed (${res.status}): ${errText}`);
  }
}

/** Returns linked Jira issue keys with their relationship type. */
export async function fetchLinkedIssues(host, issueKey, email, token) {
  const res = await fetch(
    `https://${host}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=issuelinks`,
    { headers: { Authorization: basicAuth(email, token), Accept: "application/json" } }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return (data.fields?.issuelinks ?? [])
    .map((link) => ({
      key: link.outwardIssue?.key ?? link.inwardIssue?.key ?? "",
      relationship: link.type?.name ?? "",
    }))
    .filter((l) => Boolean(l.key));
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function basicAuth(email, token) {
  return "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
}

/**
 * Recursively extracts plain text from an Atlassian Document Format (ADF) node.
 * Falls back to a string representation for non-ADF values.
 */
function extractJiraText(adf) {
  if (typeof adf === "string") return adf;
  if (!adf || typeof adf !== "object") return "";
  const node = adf;
  if (node.type === "text" && typeof node.text === "string") return node.text;
  if (Array.isArray(node.content)) return node.content.map(extractJiraText).join(" ");
  return "";
}
