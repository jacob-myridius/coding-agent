/**
 * Handles the ai:ready-for-implementation-plan route.
 *
 * For each tracker:
 *  1. Fetch the story and its linked design docs (arch + uiux)
 *  2. Call an LLM to generate an implementation plan as Markdown
 *  3. Persist the plan (Jira: attachment; GitHub: comment)
 *  4. Post a comment and advance labels to ai:implementation-plan-proposed
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { acquireToken } from "./broker-client.js";
import {
  fetchJiraIssue,
  fetchLinkedIssues,
  fetchIssueAttachments,
  downloadJiraAttachment,
  uploadJiraTextAttachment,
  deleteJiraAttachmentsByPrefix,
  updateJiraLabels,
  postJiraComment,
} from "./jira-client.js";
import { addIssueLabel, removeIssueLabel } from "./github-client.js";

const READY_FOR_IMPLEMENTATION_PLAN = "ai:ready-for-implementation-plan";
const IMPLEMENTATION_PLAN_PROPOSED = "ai:implementation-plan-proposed";
const NEEDS_GROOMING = "ai:needs-grooming";

// ---------------------------------------------------------------------------
// Jira path
// ---------------------------------------------------------------------------

export async function handleJiraImplementationPlan(payload, agentCtx, registeredRepos, dependencies = {}) {
  const jiraHost = extractJiraHost(payload);
  if (!jiraHost) throw new Error("impl_plan_jira: cannot determine Jira host from payload");

  const { projectId, executionId } = agentCtx;
  if (!projectId) throw new Error("impl_plan_jira: _agentContext.projectId is required");

  const consoleUrl = process.env.CONSOLE_URL;
  const agentSecret = process.env.AGENT_CALLBACK_SECRET;
  if (!consoleUrl || !agentSecret) throw new Error("impl_plan_jira: CONSOLE_URL and AGENT_CALLBACK_SECRET must be set");

  // Extract issue key from Jira webhook payload
  const issueKey = payload?.issue?.key;
  if (!issueKey) throw new Error("impl_plan_jira: cannot determine issue key from payload");

  console.log("impl_plan_jira: starting plan generation", { issueKey, projectId, executionId });

  // Acquire Jira read credentials
  let jiraToken, jiraEmail;
  try {
    ({ token: jiraToken, email: jiraEmail } = await acquireToken(
      projectId, "code", "jira", consoleUrl, agentSecret, "development", executionId, ["ISSUE_READ"]
    ));
  } catch (credErr) {
    console.error("impl_plan_jira: failed to acquire ISSUE_READ credentials", { issueKey, error: credErr.message });
    // Attempt to post an error comment via ISSUE_WRITE so the team knows what happened
    try {
      const { token: writeToken, email: writeEmail } = await acquireToken(
        projectId, "code", "jira", consoleUrl, agentSecret, "development", executionId, ["ISSUE_WRITE"]
      );
      await postJiraComment(jiraHost, issueKey, writeEmail, writeToken,
        `## Implementation Plan Could Not Be Generated\n\n` +
        `The code agent was unable to read this issue's fields because the **ISSUE_READ** ` +
        `capability has not been granted to the \`code\` agent for this project's Jira integration.\n\n` +
        `**Error:** ${credErr.message}\n\n` +
        `Please grant the \`ISSUE_READ\` capability to the \`code\` agent in the Myridius project settings, ` +
        `then re-label with \`ai:ready-for-implementation-plan\` to retry.`
      );
    } catch (commentErr) {
      console.error("impl_plan_jira: also failed to post error comment", { issueKey, error: commentErr.message });
    }
    throw credErr;
  }

  // Fetch story fields
  const issue = await fetchJiraIssue(jiraHost, issueKey, jiraEmail, jiraToken);
  const currentLabels = issue.labels;

  // Gate: check for test-plan-*.md on the issue itself
  const issueAttachments = await fetchIssueAttachments(jiraHost, issueKey, jiraEmail, jiraToken);
  const testPlanAttachment = issueAttachments.find((a) => /^test-plan-.+\.md$/i.test(a.filename));
  if (!testPlanAttachment) {
    // Acquire write credentials to post the comment and update labels
    const { token: writeToken, email: writeEmail } = await acquireToken(
      projectId, "code", "jira", consoleUrl, agentSecret, "development", executionId, ["ISSUE_WRITE"]
    );
    await postJiraComment(jiraHost, issueKey, writeEmail, writeToken,
      "⚠️ A test plan is required before the implementation plan can be generated. " +
      "Please apply `ai:ready-for-test-plan` to generate it first."
    );
    await updateJiraLabels(jiraHost, issueKey, writeToken, writeEmail,
      ["ai:ready-for-implementation-plan"], ["ai:needs-test-plan"], currentLabels
    );
    return { status: "blocked", reason: "MissingTestPlan" };
  }
  const testPlanContent = await downloadJiraAttachment(testPlanAttachment.content, jiraEmail, jiraToken).catch(() => "");

  // Fetch design docs from linked tickets
  const linkedIssues = await fetchLinkedIssues(jiraHost, issueKey, jiraEmail, jiraToken);
  let architectureDoc = "";
  let uiuxDoc = "";

  for (const linked of linkedIssues) {
    const attachments = await fetchIssueAttachments(jiraHost, linked.key, jiraEmail, jiraToken);

    if (!architectureDoc) {
      const archAttachment = attachments
        .filter((a) => a.filename.startsWith("system-design-") && a.filename.endsWith(".md"))
        .sort((a, b) => b.filename.localeCompare(a.filename))[0];
      if (archAttachment) {
        architectureDoc = await downloadJiraAttachment(archAttachment.content, jiraEmail, jiraToken).catch(() => "");
      }
    }

    if (!uiuxDoc) {
      const uiuxAttachment = attachments
        .filter((a) => a.filename.startsWith("uiux-spec-") && a.filename.endsWith(".md"))
        .sort((a, b) => b.filename.localeCompare(a.filename))[0];
      if (uiuxAttachment) {
        uiuxDoc = await downloadJiraAttachment(uiuxAttachment.content, jiraEmail, jiraToken).catch(() => "");
      }
    }

    if (architectureDoc && uiuxDoc) break;
  }

  // Generate plan via LLM
  const { content: planMarkdown, usage: planUsage } = await generatePlan({
    issueKey,
    title: issue.title,
    description: issue.description,
    acceptanceCriteria: issue.acceptanceCriteria,
    architectureDoc: architectureDoc || "(no architecture design doc found)",
    uiuxDoc: uiuxDoc || "(no UI/UX spec found)",
    testPlanContent: testPlanContent || "(no test plan found)",
    registeredRepos,
    dependencies,
  });

  // Emit plan-generated event for token usage tracking
  logConsoleEvent(consoleUrl, agentSecret, projectId, executionId, planUsage);

  // Acquire write credentials and persist plan
  const { token: jiraWriteToken, email: jiraWriteEmail } = await acquireToken(
    projectId, "code", "jira", consoleUrl, agentSecret, "development", executionId, ["ISSUE_WRITE"]
  );

  // Remove any prior implementation-plan.md before uploading the new one
  await deleteJiraAttachmentsByPrefix(jiraHost, issueKey, jiraWriteEmail, jiraWriteToken, ["implementation-plan"]);

  const filename = `implementation-plan-${executionId ?? Date.now()}.md`;
  await uploadJiraTextAttachment(jiraHost, issueKey, jiraWriteEmail, jiraWriteToken, planMarkdown, filename);

  const commentText =
    `## Implementation Plan Generated\n\n` +
    `An implementation plan has been attached as \`${filename}\`.\n\n` +
    `Review the plan, then label this issue with \`ai:ready-for-implementation\` to proceed with coding.\n\n` +
    `*Generated by Myridius Code Agent · Execution ${executionId ?? "n/a"}*`;

  await postJiraComment(jiraHost, issueKey, jiraWriteEmail, jiraWriteToken, commentText);

  // Advance labels: remove plan label, add proposed label
  await updateJiraLabels(
    jiraHost, issueKey, jiraWriteEmail, jiraWriteToken,
    [READY_FOR_IMPLEMENTATION_PLAN], [IMPLEMENTATION_PLAN_PROPOSED], currentLabels
  );

  console.log("impl_plan_jira: plan generated and attached", { issueKey, filename });
  return { category: "planned", issueKey, filename };
}

// ---------------------------------------------------------------------------
// GitHub path
// ---------------------------------------------------------------------------

export async function handleGitHubImplementationPlan(ctx, agentCtx, registeredRepos, token, dependencies = {}) {
  const { owner, repoName, issueNumber } = ctx;
  const { projectId, executionId } = agentCtx;

  console.log("impl_plan_github: starting plan generation", { owner, repoName, issueNumber, projectId });

  // Gate: check for <!-- test-plan --> marker comment
  const issueComments = await fetchIssueComments(owner, repoName, issueNumber, token);
  const testPlanComment = issueComments.find((c) => c.body?.includes("<!-- test-plan -->"));
  if (!testPlanComment) {
    await postGitHubComment(owner, repoName, issueNumber, token,
      "⚠️ A test plan is required before the implementation plan can be generated. " +
      "Please apply `ai:ready-for-test-plan` to generate it first."
    );
    await removeIssueLabel(owner, repoName, issueNumber, "ai:ready-for-implementation-plan", token).catch(() => {});
    await addIssueLabel(owner, repoName, issueNumber, "ai:needs-test-plan", token).catch(() => {});
    console.log(`impl_plan_github: blocked — no test-plan comment for issue #${issueNumber}`);
    return { status: "blocked", reason: "MissingTestPlan" };
  }
  const testPlanContent = testPlanComment.body;

  // Generate plan via LLM (GitHub has no attachment API — use issue body only)
  const { content: planMarkdown, usage: planUsage } = await generatePlan({
    issueKey: `${owner}/${repoName}#${issueNumber}`,
    title: ctx.title,
    description: ctx.body,
    acceptanceCriteria: "",
    architectureDoc: "(not available via GitHub — check linked design docs)",
    uiuxDoc: "(not available via GitHub — check linked design docs)",
    testPlanContent: testPlanContent || "(no test plan found)",
    registeredRepos,
    dependencies,
  });

  // Emit plan-generated event for token usage tracking
  const consoleUrl = process.env.CONSOLE_URL;
  const agentSecret = process.env.AGENT_CALLBACK_SECRET;
  logConsoleEvent(consoleUrl, agentSecret, projectId, executionId, planUsage);

  // Post plan as a specially-marked comment
  const commentBody =
    `<!-- implementation-plan -->\n## Implementation Plan\n\n${planMarkdown}\n\n` +
    `---\n*Review the plan, then label this issue \`ai:ready-for-implementation\` to proceed.*\n` +
    `*Generated by Myridius Code Agent · Execution ${executionId ?? "n/a"}*`;

  const res = await fetch(`https://api.github.com/repos/${owner}/${repoName}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "myridius-code-agent/1.0",
    },
    body: JSON.stringify({ body: commentBody }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub post plan comment failed (${res.status}): ${text}`);
  }

  // Advance labels
  await addIssueLabel(owner, repoName, issueNumber, "ai:implementation-plan-proposed", token).catch(() => {});
  await removeIssueLabel(owner, repoName, issueNumber, "ai:ready-for-implementation-plan", token).catch(() => {});

  console.log("impl_plan_github: plan posted as comment", { owner, repoName, issueNumber });
  return { category: "planned", workItemId: issueNumber };
}

// ---------------------------------------------------------------------------
// Shared — LLM plan generation
// ---------------------------------------------------------------------------

async function generatePlan({ issueKey, title, description, acceptanceCriteria, architectureDoc, uiuxDoc, testPlanContent, registeredRepos, dependencies }) {
  const promptTemplate = await readFile(
    path.join(process.cwd(), "prompts", "implementation-plan-prompt.md"),
    "utf8"
  );

  const repoList = registeredRepos.length > 0
    ? registeredRepos.map((r) => `- ${r}`).join("\n")
    : "- (no registered repositories — infer from context)";

  const prompt = promptTemplate
    .replaceAll("{{ISSUE_KEY}}", issueKey)
    .replaceAll("{{TITLE}}", title)
    .replaceAll("{{DESCRIPTION}}", description || "(no description)")
    .replaceAll("{{ACCEPTANCE_CRITERIA}}", acceptanceCriteria || "(no acceptance criteria)")
    .replaceAll("{{ARCHITECTURE_DOC}}", architectureDoc)
    .replaceAll("{{UIUX_DOC}}", uiuxDoc)
    .replaceAll("{{TEST_PLAN}}", testPlanContent || "Not provided")
    .replaceAll("{{REGISTERED_REPOS}}", repoList);

  if (dependencies.generatePlan) {
    const result = await dependencies.generatePlan(prompt);
    // Support both legacy string return and new { content, usage } return
    return typeof result === "string" ? { content: result, usage: undefined } : result;
  }

  return callAzureOpenAI(prompt);
}

async function callAzureOpenAI(prompt) {
  const endpoint = (process.env.AZURE_OPENAI_ENDPOINT || "").replace(/\/$/, "");
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;

  if (!endpoint || !apiKey || !deployment) {
    throw new Error("impl_plan: AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, and AZURE_OPENAI_DEPLOYMENT must be set");
  }

  const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=2024-02-01`;
  const MAX_RETRIES = 3;
  const BASE_BACKOFF_MS = 2000;

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": apiKey },
      body: JSON.stringify({
        messages: [{ role: "user", content: prompt }],
        max_completion_tokens: 8000,
        temperature: 0.3,
      }),
    });

    if (res.status === 429) {
      const retryAfterSec = Number(res.headers.get("Retry-After") ?? 0);
      const waitMs = retryAfterSec > 0 ? retryAfterSec * 1000 : BASE_BACKOFF_MS * Math.pow(2, attempt);
      lastError = new Error(`Azure OpenAI rate limited (429) — retry ${attempt + 1}/${MAX_RETRIES}`);
      console.warn("impl_plan: rate limited", { attempt, waitMs });
      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      break;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Azure OpenAI request failed (${res.status}): ${text}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("Azure OpenAI returned empty response for implementation plan");
    const u = data.usage;
    return {
      content,
      usage: u ? { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens, totalTokens: u.total_tokens } : undefined,
    };
  }

  throw lastError ?? new Error("Azure OpenAI request failed after retries");
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function logConsoleEvent(consoleUrl, agentSecret, projectId, executionId, tokenUsage) {
  if (!consoleUrl || !agentSecret || !projectId) return;
  fetch(`${consoleUrl}/api/projects/${projectId}/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${agentSecret}`,
    },
    body: JSON.stringify({
      stage: "implementation",
      agentName: "code",
      eventType: "plan-generated",
      summary: "Implementation plan generated",
      detail: JSON.stringify({ executionId }),
      ...(tokenUsage ? { tokenUsage } : {}),
    }),
  }).catch(() => {});
}

function extractJiraHost(payload) {
  const selfUrl = payload?.user?.self || payload?.issue?.self || "";
  try {
    return new URL(selfUrl).hostname || null;
  } catch {
    return null;
  }
}

async function fetchIssueComments(owner, repo, issueNumber, token) {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "myridius-code-agent/1.0",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub fetch issue comments failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function postGitHubComment(owner, repo, issueNumber, token, body) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "myridius-code-agent/1.0",
    },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub post comment failed (${res.status}): ${text}`);
  }
}
