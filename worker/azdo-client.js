import axios from "axios";

export function createAzdoClient() {
  const pat = requiredEnv("AZDO_PAT");
  const org = requiredEnv("AZDO_ORG");
  const project = requiredEnv("AZDO_PROJECT");
  const auth = Buffer.from(`:${pat}`, "utf8").toString("base64");

  const http = axios.create({
    baseURL: `https://dev.azure.com/${org}/${project}`,
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json"
    },
    timeout: 60_000
  });

  async function getWorkItem(workItemId) {
    const url = `/_apis/wit/workitems/${workItemId}?$expand=All&api-version=7.1`;
    const response = await http.get(url);
    return response.data;
  }

  async function patchWorkItemFields(workItemId, operations) {
    const url = `/_apis/wit/workitems/${workItemId}?api-version=7.1`;
    await http.patch(url, operations, {
      headers: {
        "Content-Type": "application/json-patch+json"
      }
    });
  }

  async function postComment(workItemId, text) {
    const url = `/_apis/wit/workItems/${workItemId}/comments?api-version=7.1-preview.4`;
    await http.post(url, { text });
  }

  async function createPullRequest(args) {
    const repo = requiredEnv("AZDO_REPO");
    const url = `/_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests?api-version=7.1`;
    const response = await http.post(url, {
      sourceRefName: `refs/heads/${args.sourceBranch}`,
      targetRefName: args.targetRefName || "refs/heads/main",
      title: args.title,
      description: args.description
    });
    return response.data;
  }

  async function findActivePullRequestBySourceBranch(sourceBranch) {
    const repo = requiredEnv("AZDO_REPO");
    const sourceRefName = sourceBranch.startsWith("refs/heads/") ? sourceBranch : `refs/heads/${sourceBranch}`;
    const url = `/_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests?searchCriteria.status=active&api-version=7.1`;
    const response = await http.get(url);
    const values = Array.isArray(response.data?.value) ? response.data.value : [];
    return values.find((pr) => String(pr?.sourceRefName || "") === sourceRefName) || null;
  }

  return {
    getWorkItem,
    patchWorkItemFields,
    postComment,
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
