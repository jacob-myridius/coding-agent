import axios from "axios";

export function createAzdoClient({ org: orgOverride, project: projectOverride } = {}) {
  const pat = requiredEnv("AZDO_PAT");
  const org = orgOverride || requiredEnv("AZDO_ORG");
  const project = projectOverride || requiredEnv("AZDO_PROJECT");
  const auth = Buffer.from(`:${pat}`, "utf8").toString("base64");

  const headers = {
    Authorization: `Basic ${auth}`,
    "Content-Type": "application/json"
  };

  // Project-scoped client — for all operations.
  // Note: PAT is project-scoped, so org-scoped API calls return 404.
  // The `project` here may be a project name OR a project GUID — ADO accepts both.
  const http = axios.create({
    baseURL: `https://dev.azure.com/${org}/${encodeURIComponent(project)}`,
    headers,
    timeout: 60_000
  });

  async function getWorkItem(workItemId) {
    // Use project-scoped URL so a project-scoped PAT can authenticate.
    // `project` may be a name or GUID — ADO accepts both in URL paths.
    const url = `/_apis/wit/workitems/${workItemId}?$expand=All&api-version=7.1`;
    const response = await http.get(url);
    return response.data;
  }

  async function patchWorkItemFields(workItemId, operations) {
    const url = `/_apis/wit/workitems/${workItemId}?api-version=7.1`;
    await http.patch(url, operations, {
      headers: {
        ...headers,
        "Content-Type": "application/json-patch+json"
      }
    });
  }

  async function postComment(workItemId, text) {
    const url = `/_apis/wit/workItems/${workItemId}/comments?api-version=7.1-preview.4`;
    await http.post(url, { text });
  }

  async function listRepositories() {
    const url = `/_apis/git/repositories?api-version=7.1`;
    const response = await http.get(url);
    return Array.isArray(response.data?.value) ? response.data.value : [];
  }

  function buildCloneUrl(repoName) {
    return `https://${org}:${pat}@dev.azure.com/${org}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repoName)}`;
  }

  async function createPullRequest({ repo, sourceBranch, targetRefName, title, description }) {
    const url = `/_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests?api-version=7.1`;
    const response = await http.post(url, {
      sourceRefName: `refs/heads/${sourceBranch}`,
      targetRefName: targetRefName || "refs/heads/main",
      title,
      description
    });
    return response.data;
  }

  async function findActivePullRequestBySourceBranch(repo, sourceBranch) {
    const sourceRefName = sourceBranch.startsWith("refs/heads/") ? sourceBranch : `refs/heads/${sourceBranch}`;
    const url = `/_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests?searchCriteria.status=active&api-version=7.1`;
    const response = await http.get(url);
    const values = Array.isArray(response.data?.value) ? response.data.value : [];
    return values.find((pr) => String(pr?.sourceRefName || "") === sourceRefName) || null;
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
    findActivePullRequestBySourceBranch
  };
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}
