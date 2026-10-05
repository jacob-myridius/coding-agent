import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { v4 as uuid } from "uuid";

// Maximum wall-clock time for a single repo implementation (clone + LLM + push).
// Configurable via IMPL_TIMEOUT_MS; defaults to 30 minutes.
const IMPL_TIMEOUT_MS = parseInt(process.env.IMPL_TIMEOUT_MS || "1800000", 10);

const TIMEOUT_MESSAGE_PREFIX = "Implementation timed out after";

function failureReasonCode(err) {
  return String(err?.message || "").startsWith(TIMEOUT_MESSAGE_PREFIX) ? "ImplementationTimeout" : "ImplementationError";
}

function withTimeout(promise, ms, label) {
  let timer;
  const race = Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${TIMEOUT_MESSAGE_PREFIX} ${ms}ms: ${label}`)),
        ms
      );
    }),
  ]);
  return race.finally(() => clearTimeout(timer));
}
import { createAzdoClient } from "./azdo-client.js";
import { createGitHubClient, isGitHubPayload, extractGitHubIssueContext, addIssueLabel, removeIssueLabel, findPlanComment } from "./github-client.js";
import { isJiraPayload, extractJiraIssueContext, extractRepoFromTitle, createJiraGitHubClient, postJiraComment, fetchIssueAttachments, downloadJiraAttachment, updateJiraLabels } from "./jira-client.js";
import { handleJiraImplementationPlan, handleGitHubImplementationPlan } from "./implementation-plan-handler.js";
import { acquireToken } from "./broker-client.js";
import { runMyridiusImplementation } from "./claude-runner.js";
import { removeWorkspace } from "./process-cleanup.js";
import { cloneRepository, resolveGitUsername } from "./git-utils.js";
import { buildSkipKey, buildStatusReasonMessage, evaluateImplementationTrigger } from "./policy.js";
import { computeSkipReasonUpdate } from "./skip-reason.js";
import { getCodeContext } from "./code-context.js";
import { runTests } from "./test-execution.js";
import { ensureMavenGitignore, isMavenProject } from "./gitignore-manager.js";
import { selectRepositories } from "./repo-selector.js";

const STATUS_REASON_FIELD = (process.env.AI_PLANNING_STATUS_REASON_FIELD_REF_NAME || "AIPlanningStatusReason").trim();
const STATUS_FIELD = (process.env.AI_PLANNING_STATUS_FIELD_REF_NAME || "AIPlanningStatus").trim();

export async function processWorkItemEventBody(body, dependencies = {}) {
  const payload = normalizePayload(body);

  // Route GitHub payloads to dedicated handler
  if (isGitHubPayload(payload)) {
    return processGitHubIssueEventBody(payload, dependencies);
  }

  // Route Jira payloads to dedicated handler
  if (isJiraPayload(payload)) {
    return processJiraIssueEventBody(payload, dependencies);
  }

  // --- ADO path (existing logic) ---
  const decision = evaluateImplementationTrigger(payload, { statusFieldRefName: STATUS_FIELD });

  const { org, project } = extractAdoContext(payload);

  // Resolve git identity from the project-configured ADO email (tracker-ado-email secret via broker).
  const agentCtxAdo = (typeof payload._agentContext === "object" && payload._agentContext !== null) ? payload._agentContext : {};
  const registeredReposAdo = Array.isArray(agentCtxAdo.repositories) ? agentCtxAdo.repositories : [];
  if (!agentCtxAdo.projectId) throw new Error("aca_ado_worker: _agentContext.projectId is required for project-level git identity");
  const consoleUrlAdo = process.env.CONSOLE_URL;
  const agentSecretAdo = process.env.AGENT_CALLBACK_SECRET;
  if (!consoleUrlAdo || !agentSecretAdo) throw new Error("aca_ado_worker: CONSOLE_URL and AGENT_CALLBACK_SECRET must be set");
  const { email: gitEmail } = await acquireToken(
    agentCtxAdo.projectId, "code", "azure-devops", consoleUrlAdo, agentSecretAdo,
    "development", agentCtxAdo.executionId, ["ISSUE_READ"]
  );
  if (!gitEmail) throw new Error(`aca_ado_worker: broker returned no email for projectId=${agentCtxAdo.projectId} — ensure tracker-ado-email secret is set`);
  const gitUsername = gitEmail.split("@")[0];

  console.log("aca_worker_context", {
    org: org || "(env fallback)",
    project: project || "(env fallback)",
    eligible: decision.eligible,
    workItemId: decision.workItemId,
    reasonCode: decision.reasonCode || ""
  });
  const azdo = dependencies.azdoClient || createAzdoClient({ org, project });
  const cloneRepo = dependencies.cloneRepository || cloneRepository;
  const runImplementation = dependencies.runImplementation || runMyridiusImplementation;

  if (!decision.eligible) {
    const workItemId = Number(payload?.resource?.workItemId ?? payload?.resource?.id ?? 0);
    const revision = Number(payload?.resource?.rev ?? payload?.resource?.revision?.id ?? 0);
    if (workItemId > 0 && revision > 0) {
      await postIdempotentSkipReason({ azdo, workItemId, revision, reasonCode: decision.reasonCode, detail: decision.reasonMessage });
    }
    return { category: "skipped", workItemId: workItemId || undefined, reasonCode: decision.reasonCode, reason: decision.reasonMessage };
  }

  // --- Fetch work item fields (needed for both repo selection and prompt) ---
  const workItem = await azdo.getWorkItem(decision.workItemId);
  const fields = asObject(workItem.fields) || {};
  const title = text(fields["System.Title"]);
  const description = text(fields["System.Description"]);
  const acceptanceCriteria = text(fields["Microsoft.VSTS.Common.AcceptanceCriteria"]);

  // --- Resolve which repositories to implement in ---
  const selectedRepos = await resolveRepos(azdo, decision, { title, description }, registeredReposAdo);
  if (selectedRepos.length === 0) {
    await postIdempotentSkipReason({
      azdo,
      workItemId: decision.workItemId,
      revision: decision.revision,
      reasonCode: "MissingRepoContext",
      detail: `No repositories found in project '${azdo.project}'.`
    });
    return { category: "skipped", reasonCode: "MissingRepoContext", reason: "No repositories in project" };
  }

  const allRepoNames = selectedRepos.map((r) => r.name);
  console.log(`implementing work item ${decision.workItemId} across ${allRepoNames.length} repo(s): [${allRepoNames.join(", ")}]`);

  // --- Read prompt template once ---
  const promptTemplate = await readFile(path.join(process.cwd(), "prompts", "implementation-prompt.md"), "utf8");

  // --- Implement in each selected repo sequentially ---
  const repoResults = [];
  for (const repo of selectedRepos) {
    const repoName = repo.name;
    const repoUrl = azdo.buildCloneUrl(repoName);

    const result = await withTimeout(
      implementInRepo({
        azdo,
        repoName,
        repoUrl,
        decision,
        fields: { title, description, acceptanceCriteria },
        promptTemplate,
        allRepoNames,
        cloneRepo,
        runImplementation,
        gitEmail,
        gitUsername,
        sessionContext: { tracker: "azure-devops", provider: "azure-devops", projectId: agentCtxAdo.projectId, executionId: agentCtxAdo.executionId },
      }),
      IMPL_TIMEOUT_MS,
      `wi=${decision.workItemId} repo=${repoName}`
    ).catch((err) => {
      console.error(`[${repoName}] implementInRepo failed: ${err.message}`);
      return { category: "skipped", reasonCode: failureReasonCode(err), repoName, branchName: `ai/us-${decision.workItemId}-r${decision.revision}`, error: err.message };
    });
    repoResults.push(result);
  }

  // --- Aggregate results and post final comment ---
  const implemented = repoResults.filter((r) => r.category === "implemented");
  const blocked = repoResults.filter((r) => r.category === "blocked");
  const skipped = repoResults.filter((r) => r.category === "skipped");

  if (implemented.length > 0 || blocked.length > 0) {
    await azdo.postComment(decision.workItemId, buildSummaryComment(repoResults, decision.workItemId, azdo));
  }

  if (implemented.length === repoResults.length) {
    return { category: "implemented", workItemId: decision.workItemId, repos: repoResults };
  }
  if (blocked.length > 0) {
    return { category: "blocked", workItemId: decision.workItemId, repos: repoResults };
  }
  return { category: "skipped", workItemId: decision.workItemId, repos: repoResults };
}

// ---------------------------------------------------------------------------
// GitHub issue handler
// ---------------------------------------------------------------------------

async function processGitHubIssueEventBody(payload, dependencies = {}) {
  const ctx = extractGitHubIssueContext(payload);
  if (!ctx) {
    console.log("aca_github_worker_ignored: could not extract GitHub issue context");
    return { category: "skipped", reasonCode: "InvalidPayload", reason: "Missing GitHub issue context" };
  }

  // Accept both ready-for-implementation and ready-for-implementation-plan labels
  const GITHUB_IMPL_LABELS = new Set(["ready-for-implementation", "ai:ready-for-implementation", "ready-for-implementation-plan", "ai:ready-for-implementation-plan"]);
  if (ctx.action !== "labeled" || !GITHUB_IMPL_LABELS.has(ctx.labelName)) {
    console.log(`aca_github_worker_ignored: action=${ctx.action} label=${ctx.labelName}`);
    return { category: "skipped", reasonCode: "NoStatusTransition", reason: `Not a ready-for-implementation label event` };
  }

  console.log("aca_github_worker_context", { owner: ctx.owner, repo: ctx.repoName, issue: ctx.issueNumber });

  const github = dependencies.githubClient || createGitHubClient({ owner: ctx.owner, repoName: ctx.repoName, issueNumber: ctx.issueNumber });
  const cloneRepo = dependencies.cloneRepository || cloneRepository;
  const runImplementation = dependencies.runImplementation || runMyridiusImplementation;

  // Resolve git identity from the project-configured email (scm-github-email secret via broker).
  const agentCtxGh = (typeof payload._agentContext === "object" && payload._agentContext !== null) ? payload._agentContext : {};
  const registeredReposGh = Array.isArray(agentCtxGh.repositories) ? agentCtxGh.repositories : [];
  if (!agentCtxGh.projectId) throw new Error("aca_github_worker: _agentContext.projectId is required for project-level git identity");
  const consoleUrlGh = process.env.CONSOLE_URL;
  const agentSecretGh = process.env.AGENT_CALLBACK_SECRET;
  if (!consoleUrlGh || !agentSecretGh) throw new Error("aca_github_worker: CONSOLE_URL and AGENT_CALLBACK_SECRET must be set");
  const { token: ghToken, email: gitEmail } = await acquireToken(
    agentCtxGh.projectId, "code", "github",
    consoleUrlGh, agentSecretGh, "development", agentCtxGh.executionId
  );
  if (!gitEmail) throw new Error(`aca_github_worker: broker returned no email for projectId=${agentCtxGh.projectId} — ensure scm-github-email secret is set`);
  const gitUsername = await resolveGitUsername(ghToken, gitEmail);

  // ── Plan route ──────────────────────────────────────────────────────────────
  const agentLabelAddedGh = agentCtxGh.labelAdded ?? ctx.labelName ?? "";
  const isGhPlanRoute = agentLabelAddedGh === "ai:ready-for-implementation-plan" || agentLabelAddedGh === "ready-for-implementation-plan";
  if (isGhPlanRoute) {
    return handleGitHubImplementationPlan(ctx, agentCtxGh, registeredReposGh, ghToken, dependencies);
  }

  // ── Implementation route — pre-check for plan comment ──────────────────────
  const planComment = await findPlanComment(ctx.owner, ctx.repoName, ctx.issueNumber, ghToken);
  if (!planComment) {
    console.log(`aca_github_worker: no implementation plan found for issue #${ctx.issueNumber} — requesting plan first`);
    await removeIssueLabel(ctx.owner, ctx.repoName, ctx.issueNumber, "ai:ready-for-implementation", ghToken).catch(() => {});
    await removeIssueLabel(ctx.owner, ctx.repoName, ctx.issueNumber, "ready-for-implementation", ghToken).catch(() => {});
    await addIssueLabel(ctx.owner, ctx.repoName, ctx.issueNumber, "ai:ready-for-implementation-plan", ghToken).catch(() => {});
    await github.postComment(ctx.issueNumber,
      `## Implementation Plan Required\n\nNo implementation plan found for this issue.\n\n` +
      `Label with \`ai:ready-for-implementation-plan\` to generate a plan first, then re-label with \`ai:ready-for-implementation\` to proceed.`
    ).catch(() => {});
    return { category: "skipped", reasonCode: "MissingImplementationPlan", reason: "No implementation plan found" };
  }

  const promptTemplate = await readFile(path.join(process.cwd(), "prompts", "implementation-prompt.md"), "utf8");

  // Fake a decision object compatible with implementInRepo
  const decision = {
    eligible: true,
    workItemId: ctx.issueNumber,
    revision: 1, // GitHub issues don't have revisions
    workItemType: "User Story",
  };

  const fields = { title: ctx.title, description: ctx.body, acceptanceCriteria: "" };

  // Determine which repos to implement in.
  // When a plan specifies "## Target Repositories", use those. Otherwise fall back to heuristic selection.
  const planTargetReposGh = parsePlanTargetRepos(planComment);
  let selectedReposGh;
  if (planTargetReposGh.length > 0) {
    selectedReposGh = planTargetReposGh.map((name) => ({ name, active: true }));
    console.log(`aca_github_worker: using plan-specified repos: [${planTargetReposGh.join(", ")}]`);
  } else if (registeredReposGh.length > 1) {
    const repoObjs = registeredReposGh.map((r) => ({ name: r.split("/").pop(), active: true }));
    selectedReposGh = selectRepositories(repoObjs, { title: ctx.title, description: ctx.body, workItemType: "issue" });
    console.log(`aca_github_worker: selected ${selectedReposGh.length} repo(s) from ${registeredReposGh.length} registered: [${selectedReposGh.map((r) => r.name).join(", ")}]`);
  } else {
    selectedReposGh = [{ name: ctx.repoName, active: true }];
  }

  // Enrich prompt with implementation plan when present
  const planSection = planComment ? `## Implementation Plan\n${planComment}` : "";
  const enrichedPromptGh = promptTemplate.replaceAll("{{IMPLEMENTATION_PLAN}}", planSection);

  const allRepoNamesGh = selectedReposGh.map((r) => r.name);
  const repoResults = [];

  for (const repo of selectedReposGh) {
    const repoName = repo.name;
    const result = await withTimeout(
      implementInRepo({
        azdo: github,
        repoName,
        repoUrl: github.buildCloneUrl(repoName),
        decision,
        fields,
        promptTemplate: enrichedPromptGh,
        allRepoNames: allRepoNamesGh,
        cloneRepo,
        runImplementation,
        gitEmail,
        gitUsername,
        sessionContext: { tracker: "github", provider: "github", projectId: agentCtxGh.projectId, executionId: agentCtxGh.executionId },
      }),
      IMPL_TIMEOUT_MS,
      `github-issue=${ctx.issueNumber} repo=${repoName}`
    ).catch((err) => {
      console.error(`[${repoName}] GitHub implementInRepo failed: ${err.message}`);
      return { category: "skipped", reasonCode: failureReasonCode(err), repoName, branchName: `ai/us-${ctx.issueNumber}-r1`, error: err.message };
    });
    repoResults.push(result);
  }

  const implemented = repoResults.filter((r) => r.category === "implemented");
  const blocked = repoResults.filter((r) => r.category === "blocked");

  if (implemented.length > 0 || blocked.length > 0) {
    await github.postComment(ctx.issueNumber, buildSummaryComment(repoResults, ctx.issueNumber, github));
  }

  if (implemented.length === repoResults.length) {
    return { category: "implemented", workItemId: ctx.issueNumber, repos: repoResults };
  }
  if (blocked.length > 0) {
    return { category: "blocked", workItemId: ctx.issueNumber, repos: repoResults };
  }
  return { category: "skipped", workItemId: ctx.issueNumber, repos: repoResults };
}

// ---------------------------------------------------------------------------
// Jira issue handler
// ---------------------------------------------------------------------------

async function processJiraIssueEventBody(payload, dependencies = {}) {
  const ctx = extractJiraIssueContext(payload);
  if (!ctx) {
    console.log("aca_jira_worker_ignored: trigger label not present in Jira event");
    return { category: "skipped", reasonCode: "NoStatusTransition", reason: "Not a ready-for-implementation label event" };
  }

  // Jira host is derived from the webhook payload — no env var needed.
  const jiraHost = extractJiraHost(payload);
  if (!jiraHost) {
    throw new Error("aca_jira_worker: cannot determine Jira host from payload (user.self URL missing or malformed)");
  }

  // projectId and executionId come from the orchestrator-injected _agentContext.
  const agentCtx = (typeof payload._agentContext === "object" && payload._agentContext !== null)
    ? payload._agentContext : {};
  const projectId = agentCtx.projectId;
  const executionId = agentCtx.executionId;
  const registeredRepos = Array.isArray(agentCtx.repositories) ? agentCtx.repositories : [];
  if (!projectId) {
    throw new Error("aca_jira_worker: _agentContext.projectId is required — ensure this project is registered with the Myridius platform");
  }
  const consoleUrl = process.env.CONSOLE_URL;
  const agentSecret = process.env.AGENT_CALLBACK_SECRET;
  if (!consoleUrl || !agentSecret) {
    throw new Error("aca_jira_worker: CONSOLE_URL and AGENT_CALLBACK_SECRET must be set");
  }

  // ── Plan route ──────────────────────────────────────────────────────────────
  const agentLabelAdded = agentCtx.labelAdded ?? ctx.labelAdded ?? "";
  if (agentLabelAdded === "ai:ready-for-implementation-plan") {
    return handleJiraImplementationPlan(payload, agentCtx, registeredRepos, dependencies);
  }

  // Acquire SCM (GitHub) credentials — needed for clone, push, and PR creation.
  // The broker returns the project-configured git email (scm-github-email secret).
  const { token: githubToken, owner, email: gitEmail } = await acquireToken(
    projectId, "code", "github", consoleUrl, agentSecret, "development", executionId
  );
  if (!githubToken) throw new Error(`aca_jira_worker: broker returned empty GitHub token for projectId=${projectId}`);
  if (!owner) throw new Error(`aca_jira_worker: broker did not return GitHub owner for projectId=${projectId} — ensure project.github.org is set`);
  if (!gitEmail) throw new Error(`aca_jira_worker: broker returned no email for projectId=${projectId} — ensure scm-github-email secret is set`);
  const gitUsername = await resolveGitUsername(githubToken, gitEmail);

  // ── Implementation route — pre-check for plan attachment ────────────────────
  let implementationPlanContent = null;
  try {
    const { token: jiraReadToken, email: jiraReadEmail } = await acquireToken(
      projectId, "code", "jira", consoleUrl, agentSecret, "development", executionId, ["ISSUE_READ"]
    );
    const attachments = await fetchIssueAttachments(jiraHost, ctx.issueKey, jiraReadEmail, jiraReadToken);
    const planAttachment = attachments
      .filter((a) => a.filename.startsWith("implementation-plan") && a.filename.endsWith(".md"))
      .sort((a, b) => b.filename.localeCompare(a.filename))[0];

    if (!planAttachment) {
      console.log(`aca_jira_worker: no implementation-plan.md found on ${ctx.issueKey} — requesting plan first`);
      const { token: jiraWriteToken, email: jiraWriteEmail } = await acquireToken(
        projectId, "code", "jira", consoleUrl, agentSecret, "development", executionId, ["ISSUE_WRITE"]
      );
      const currentLabelsForReset = Array.isArray(payload?.issue?.fields?.labels) ? payload.issue.fields.labels : [];
      await postJiraComment(jiraHost, ctx.issueKey, jiraWriteEmail, jiraWriteToken,
        `## Implementation Plan Required\n\nNo \`implementation-plan.md\` attachment found on this issue.\n\n` +
        `Label with \`ai:ready-for-implementation-plan\` to generate a plan first, ` +
        `then re-label with \`ai:ready-for-implementation\` to proceed with coding.`
      ).catch(() => {});
      await updateJiraLabels(
        jiraHost, ctx.issueKey, jiraWriteEmail, jiraWriteToken,
        ["ai:ready-for-implementation"], ["ai:needs-grooming"], currentLabelsForReset
      ).catch(() => {});
      return { category: "skipped", reasonCode: "MissingImplementationPlan", reason: "No implementation-plan.md found on Jira issue" };
    }

    implementationPlanContent = await downloadJiraAttachment(planAttachment.content, jiraReadEmail, jiraReadToken).catch(() => null);
    console.log(`aca_jira_worker: found implementation plan '${planAttachment.filename}'`);
  } catch (err) {
    // Plan check failed — do NOT silently proceed. Stop and report so the team knows.
    console.error(`aca_jira_worker: plan pre-check failed: ${err.message}`);
    try {
      const { token: jiraWriteToken, email: jiraWriteEmail } = await acquireToken(
        projectId, "code", "jira", consoleUrl, agentSecret, "development", executionId, ["ISSUE_WRITE"]
      );
      const currentLabelsForReset = Array.isArray(payload?.issue?.fields?.labels) ? payload.issue.fields.labels : [];
      await postJiraComment(jiraHost, ctx.issueKey, jiraWriteEmail, jiraWriteToken,
        `## Implementation Cannot Proceed\n\n` +
        `The code agent was unable to check for an implementation plan attachment because it could not read this issue.\n\n` +
        `**Error:** ${err.message}\n\n` +
        `Please ensure the **ISSUE_READ** capability is granted to the \`code\` agent for this project's Jira integration ` +
        `in the Myridius project settings, then re-label with \`ai:ready-for-implementation\` to retry.`
      ).catch(() => {});
      await updateJiraLabels(
        jiraHost, ctx.issueKey, jiraWriteEmail, jiraWriteToken,
        ["ai:ready-for-implementation"], ["ai:needs-grooming"], currentLabelsForReset
      ).catch(() => {});
    } catch (commentErr) {
      console.error(`aca_jira_worker: also failed to post error comment on ${ctx.issueKey}: ${commentErr.message}`);
    }
    return { category: "skipped", reasonCode: "PlanCheckFailed", reason: `Plan pre-check failed: ${err.message}` };
  }

  // Determine which repos to implement in.
  // When a plan specifies "## Target Repositories", use those. Otherwise fall back to heuristic selection.
  const planTargetReposJira = parsePlanTargetRepos(implementationPlanContent);
  let selectedReposJira;
  if (planTargetReposJira.length > 0) {
    selectedReposJira = planTargetReposJira.map((name) => ({ name, active: true }));
    console.log(`aca_jira_worker: using plan-specified repos: [${planTargetReposJira.join(", ")}]`);
  } else if (registeredRepos.length > 0) {
    const repoObjs = registeredRepos.map((r) => ({ name: r.split("/").pop(), active: true }));
    selectedReposJira = selectRepositories(repoObjs, { title: ctx.title, description: ctx.body, workItemType: "story" });
    console.log(`aca_jira_worker: selected ${selectedReposJira.length} repo(s) from ${registeredRepos.length} registered: [${selectedReposJira.map((r) => r.name).join(", ")}]`);
  } else {
    // Legacy path: parse repo name from Jira issue title (e.g. "[Scaffold] my-repo-name")
    const fallbackRepo = extractRepoFromTitle(ctx.title);
    if (!fallbackRepo) {
      console.log(`aca_jira_worker_ignored: no registered repos and cannot determine GitHub repo from title='${ctx.title}'`);
      return { category: "skipped", reasonCode: "MissingRepoContext", reason: "Cannot determine GitHub repo — register project repos or include repo name in issue title" };
    }
    selectedReposJira = [{ name: fallbackRepo, active: true }];
  }

  if (selectedReposJira.length === 0) {
    return { category: "skipped", reasonCode: "MissingRepoContext", reason: "No repos selected from registered list" };
  }

  const allRepoNamesJira = selectedReposJira.map((r) => r.name);
  console.log("aca_jira_worker_context", { issueKey: ctx.issueKey, owner, repos: allRepoNamesJira, projectId, executionId });

  const cloneRepo = dependencies.cloneRepository || cloneRepository;
  const runImplementation = dependencies.runImplementation || runMyridiusImplementation;
  const rawPromptTemplate = await readFile(path.join(process.cwd(), "prompts", "implementation-prompt.md"), "utf8");
  const planSection = implementationPlanContent ? `## Implementation Plan\n${implementationPlanContent}` : "";
  const promptTemplate = rawPromptTemplate.replaceAll("{{IMPLEMENTATION_PLAN}}", planSection);

  // Synthetic decision — Jira issues don't have ADO-style revisions.
  const decision = {
    eligible: true,
    workItemId: ctx.issueKey,
    revision: 1,
    workItemType: "User Story",
  };

  const fields = {
    title: ctx.title,
    description: ctx.body,
    acceptanceCriteria: ctx.acceptanceCriteria,
  };

  const repoResults = [];
  for (const repo of selectedReposJira) {
    const repoName = repo.name;
    // Create a per-repo GitHub client (issue comments use the original issueKey; clone URL uses repoName).
    const client = dependencies.jiraClient || createJiraGitHubClient({ issueKey: ctx.issueKey, owner, repoName, githubToken });

    const result = await withTimeout(
      implementInRepo({
        azdo: client,
        repoName,
        repoUrl: client.buildCloneUrl(repoName),
        decision,
        fields,
        promptTemplate,
        allRepoNames: allRepoNamesJira,
        cloneRepo,
        runImplementation,
        gitEmail,
        gitUsername,
        sessionContext: { tracker: "jira", provider: "github", projectId, executionId },
      }),
      IMPL_TIMEOUT_MS,
      `jira-issue=${ctx.issueKey} repo=${repoName}`
    ).catch((err) => {
      console.error(`[${repoName}] Jira implementInRepo failed: ${err.message}`);
      return { category: "skipped", reasonCode: failureReasonCode(err), repoName, branchName: `ai/us-${ctx.issueKey}-r1`, error: err.message };
    });
    repoResults.push(result);
  }

  // Post result comment to Jira — acquire tracker credentials only now, with the
  // minimal ISSUE_WRITE capability. A comment failure is non-fatal.
  const implemented = repoResults.filter((r) => r.category === "implemented");
  const blocked = repoResults.filter((r) => r.category === "blocked");

  if (implemented.length > 0 || blocked.length > 0) {
    try {
      const { token: jiraToken, email: jiraEmail } = await acquireToken(
        projectId, "code", "jira", consoleUrl, agentSecret, "development", executionId,
        ["ISSUE_WRITE"]
      );
      // Use a dummy client reference for buildSummaryComment (only used for URL building in ADO)
      const dummyClient = { org: owner, project: owner };
      await postJiraComment(jiraHost, ctx.issueKey, jiraEmail, jiraToken, buildSummaryComment(repoResults, ctx.issueKey, dummyClient));
    } catch (err) {
      console.error(`aca_jira_worker: failed to post comment on ${ctx.issueKey}: ${err.message}`);
    }
  }

  if (implemented.length === repoResults.length) {
    return { category: "implemented", workItemId: ctx.issueKey, repos: repoResults };
  }
  if (blocked.length > 0) {
    return { category: "blocked", workItemId: ctx.issueKey, repos: repoResults };
  }
  return { category: "skipped", workItemId: ctx.issueKey, repos: repoResults };
}

// ---------------------------------------------------------------------------
// Per-repo implementation
// ---------------------------------------------------------------------------

async function implementInRepo({ azdo, repoName, repoUrl, decision, fields, promptTemplate, allRepoNames, cloneRepo, runImplementation, gitEmail, gitUsername, sessionContext = {} }) {
  const { title, description, acceptanceCriteria } = fields;
  // Myridius CLI session id, so a run can be inspected or continued later (resume-session.js).
  // The workspace path is derived from it so a resume can recreate the same cwd the CLI recorded.
  const sessionId = uuid();
  const workspacePath = path.join(os.tmpdir(), `myridius-worker-${sessionId}`);
  await mkdir(workspacePath, { recursive: true });
  const branchName = `ai/us-${decision.workItemId}-r${decision.revision}`;

  const allReposContext = allRepoNames.length > 1
    ? `This work item spans multiple repositories. You are implementing changes for '${repoName}'.\n` +
      `Other repositories also being updated: ${allRepoNames.filter((n) => n !== repoName).join(", ")}.\n` +
      `Focus only on the changes needed in THIS repository.`
    : "";

  try {
    const repoGit = await cloneRepo({ repoUrl, branchName, workspacePath, gitEmail, gitUsername });
    const initialHead = await repoGit.revparse(["HEAD"]);

    if (await isMavenProject(workspacePath)) {
      console.log(`[${repoName}] Detected Maven project, ensuring .gitignore is configured...`);
      await ensureMavenGitignore(workspacePath, {
        log: (msg) => console.log(`[${repoName}][Gitignore] ${msg}`),
        error: (msg) => console.error(`[${repoName}][Gitignore] ${msg}`)
      });
    }

    // Read TECHSTACK.md from the repo root if present — used for prompt context and
    // to infer the language for code search.
    let techStackContent = "";
    let techStackLanguage = "typescript"; // fallback
    try {
      techStackContent = await readFile(path.join(workspacePath, "TECHSTACK.md"), "utf8");
      console.log(`[${repoName}] TECHSTACK.md found (${techStackContent.length} chars).`);
      // Extract language from the table row "| Language | <value> |"
      const langMatch = techStackContent.match(/\|\s*Language\s*\|\s*([^|\n]+)\|/i);
      if (langMatch) techStackLanguage = langMatch[1].trim().toLowerCase();
    } catch {
      console.log(`[${repoName}] No TECHSTACK.md found — using defaults.`);
    }

    const codeContext = await getCodeContext({
      org: azdo.org,
      project: azdo.project,
      repo: repoName,
      title,
      description,
      language: techStackLanguage
    });

    const techStackSection = techStackContent
      ? `## Tech Stack Reference (TECHSTACK.md)\n${techStackContent}`
      : "";

    const prompt = promptTemplate
      .replaceAll("{{WORK_ITEM_ID}}", String(decision.workItemId))
      .replaceAll("{{REPO_NAME}}", repoName)
      .replaceAll("{{ALL_REPOS_CONTEXT}}", allReposContext)
      .replaceAll("{{WORK_ITEM_BRANCH}}", branchName)
      .replaceAll("{{TITLE}}", title)
      .replaceAll("{{DESCRIPTION}}", description)
      .replaceAll("{{ACCEPTANCE_CRITERIA}}", acceptanceCriteria)
      .replaceAll("{{TECH_STACK}}", techStackSection)
      .replaceAll("{{CODE_CONTEXT}}", codeContext || "");

    await runImplementation({
      workspacePath,
      prompt,
      sessionId,
      sessionManifest: {
        ...sessionContext,
        workItemId: decision.workItemId,
        repoName,
        repoUrl,
        branchName,
        baseBranch: "main"
      }
    });

    const finalHead = await repoGit.revparse(["HEAD"]);
    if (String(finalHead || "") === String(initialHead || "")) {
      console.log(`[${repoName}] No commits created — skipping push and PR.`);
      return { category: "skipped", reasonCode: "ExecutionSuppressed", repoName, branchName, sessionId };
    }

    console.log(`[${repoName}] Pushing branch '${branchName}'...`);
    // --no-verify: the pre-push guard (git-utils.js) only restrains the agent, not the worker.
    await repoGit.push("origin", branchName, { "--set-upstream": null, "--force": null, "--no-verify": null });
    console.log(`[${repoName}] Branch pushed successfully.`);

    console.log(`[${repoName}] Running tests...`);
    const testResult = await runTests(workspacePath, {
      log: (msg) => console.log(`[${repoName}][Tests] ${msg}`),
      error: (msg) => console.error(`[${repoName}][Tests] ${msg}`)
    });

    if (!testResult.success) {
      return { category: "blocked", reasonCode: "TestsFailed", repoName, branchName, sessionId, testSummary: testResult.summary };
    }

    let activePr = await findActivePullRequestWithRetry(azdo, repoName, branchName, 2, 1000);

    if (!activePr) {
      const prTitle = `feat(us-${decision.workItemId}): ${title}`;
      const prDescription = buildPullRequestDescription({
        workItemId: decision.workItemId,
        title,
        description,
        testSummary: testResult.summary,
        branchName,
        sessionId
      });
      try {
        activePr = await azdo.createPullRequest({ repo: repoName, sourceBranch: branchName, targetRefName: "refs/heads/main", title: prTitle, description: prDescription });
        console.log(`[${repoName}] PR #${activePr.pullRequestId} created.`);
      } catch (err) {
        console.error(`[${repoName}] Failed to create PR: ${err.message}`);
        return { category: "implemented", repoName, branchName, sessionId, testSummary: testResult.summary, prCreated: false };
      }
    }

    return {
      category: "implemented",
      repoName,
      branchName,
      sessionId,
      pullRequestId: activePr.pullRequestId,
      pullRequestUrl: activePr.url || buildPrUrl(azdo, repoName, activePr.pullRequestId),
      testSummary: testResult.summary,
      prCreated: true
    };
  } catch (err) {
    console.error(`[${repoName}] Implementation error: ${err.message}`);
    return { category: "skipped", reasonCode: "ImplementationError", repoName, branchName, sessionId, error: err.message };
  } finally {
    await removeWorkspace(workspacePath);
  }
}

// ---------------------------------------------------------------------------
// Repo resolution
// ---------------------------------------------------------------------------

async function resolveRepos(azdo, decision, { title, description }, registeredRepos = []) {
  const allRepos = await azdo.listRepositories();
  if (allRepos.length === 0) return [];

  // When the orchestrator injected a registered repo list, restrict selection to those repos.
  // If none of the registered names match (e.g. a project migration or naming mismatch),
  // fall back to the full repo list so we never silently produce zero candidates.
  let candidate = allRepos;
  if (registeredRepos.length > 0) {
    const filtered = allRepos.filter((r) =>
      registeredRepos.some((reg) => reg.split("/").pop() === r.name)
    );
    if (filtered.length > 0) candidate = filtered;
  }

  const selected = selectRepositories(candidate, {
    title,
    description,
    workItemType: decision.workItemType
  });

  return selected || [];
}

// ---------------------------------------------------------------------------
// Comment builders
// ---------------------------------------------------------------------------

function buildSummaryComment(repoResults, workItemId, azdo) {
  const lines = [`## AI Implementation Summary — Work Item #${workItemId}\n`];

  for (const r of repoResults) {
    lines.push(`### Repository: \`${r.repoName}\``);
    if (r.category === "implemented") {
      const prLink = r.pullRequestUrl ? `[PR #${r.pullRequestId}](${r.pullRequestUrl})` : `PR #${r.pullRequestId}`;
      lines.push(`- **Status:** ✅ Implemented`);
      lines.push(`- **Branch:** \`${r.branchName}\``);
      if (r.prCreated && r.pullRequestId) lines.push(`- **Pull Request:** ${prLink}`);
      if (r.testSummary?.total !== undefined) {
        lines.push(`- **Tests:** ${r.testSummary.passed}/${r.testSummary.total} passed, coverage: ${r.testSummary.coverage || "N/A"}`);
      }
    } else if (r.category === "blocked") {
      lines.push(`- **Status:** ⚠️ Blocked — tests failed`);
      lines.push(`- **Branch:** \`${r.branchName}\` (pushed, review required)`);
    } else {
      lines.push(`- **Status:** ⏭️ Skipped — ${r.reasonCode || r.error || "no changes"}`);
    }
    if (r.sessionId) lines.push(`- **Agent session:** \`${r.sessionId}\``);
    lines.push("");
  }

  lines.push("---");
  lines.push("*Co-Authored-By: Myridius AI Implementation Worker*");
  return lines.join("\n");
}

export function buildPullRequestDescription({ workItemId, title, description, testSummary, branchName, sessionId }) {
  const plainDesc = (description || "No description provided.").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const summary = plainDesc.length > 200 ? plainDesc.substring(0, 200) + "..." : plainDesc;

  const hasTestResults = testSummary && typeof testSummary.total !== "undefined";
  const testSection = hasTestResults
    ? `### Test Results\n- **Total:** ${testSummary.total}\n- **Passed:** ${testSummary.passed}\n- **Failed:** ${testSummary.failed}\n- **Coverage:** ${testSummary.coverage || "N/A"}`
    : `### Test Results\n- **Status:** Not executed or unavailable`;
  const testCheckbox = hasTestResults
    ? `- [x] Tests passing (${testSummary.passed}/${testSummary.total})`
    : `- [ ] Tests execution required`;

  // The hidden marker lets webhook handlers (e.g. PR merged/closed) recover the session from the PR body.
  const sessionSection = sessionId
    ? `\n**Agent session:** \`${sessionId}\`\n<!-- myridius-session-id: ${sessionId} -->\n`
    : "";

  return `## Work Item #${workItemId}: ${title}\n\n### Summary\n${summary}\n\n${testSection}\n\n### Implementation Details\nAutomatically created for work item #${workItemId}.\n\n**Branch:** \`${branchName}\`\n${sessionSection}\n### Checklist\n- [x] Implementation completed\n${testCheckbox}\n- [x] Code pushed to branch\n- [ ] Code review required\n\n---\n*Co-Authored-By: Myridius AI Implementation Worker*`;
}

function buildPrUrl(azdo, repoName, pullRequestId) {
  return `https://dev.azure.com/${azdo.org}/${encodeURIComponent(azdo.project)}/_git/${encodeURIComponent(repoName)}/pullrequest/${pullRequestId}`;
}

// ---------------------------------------------------------------------------
// Idempotent skip reason
// ---------------------------------------------------------------------------

async function postIdempotentSkipReason({ azdo, workItemId, revision, reasonCode, detail }) {
  const skipKey = buildSkipKey({ workItemId, revision, reasonCode });
  const message = buildStatusReasonMessage({ reasonCode, skipKey, detail });
  const workItem = await azdo.getWorkItem(workItemId);
  const fields = asObject(workItem.fields) || {};
  const existingReason = text(fields[STATUS_REASON_FIELD]);
  const reasonUpdate = computeSkipReasonUpdate(existingReason, message, skipKey);
  if (!reasonUpdate.shouldUpdate) return;
  await azdo.patchWorkItemFields(workItemId, [
    { op: "add", path: `/fields/${STATUS_REASON_FIELD}`, value: reasonUpdate.value }
  ]);
  await azdo.postComment(workItemId, message);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function extractAdoContext(payload) {
  const baseUrl = String(payload?.resourceContainers?.collection?.baseUrl || "").trim();
  const orgMatch = baseUrl.replace(/\/$/, "").match(/\/([^/]+)$/);
  const org = orgMatch ? orgMatch[1] : "";
  // ADO webhook payloads may include project.name, project.id (GUID), or both.
  // ADO REST API accepts GUIDs in place of project names in all URL positions,
  // so we use the name when available and fall back to the ID GUID.
  const projectContainer = payload?.resourceContainers?.project;
  const projectName = String(projectContainer?.name || "").trim();
  const projectId = String(projectContainer?.id || "").trim();
  const project = projectName || projectId || undefined;
  return { org: org || undefined, project };
}

function normalizePayload(body) {
  if (typeof body === "string") return JSON.parse(body);
  if (Buffer.isBuffer(body)) return JSON.parse(body.toString("utf8"));
  return body;
}

function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

function text(value) {
  return String(value || "").trim();
}

async function findActivePullRequestWithRetry(azdo, repo, sourceBranch, retries, waitMs) {
  if (!azdo || typeof azdo.findActivePullRequestBySourceBranch !== "function") return null;
  for (let attempt = 0; attempt < retries; attempt++) {
    const pr = await azdo.findActivePullRequestBySourceBranch(repo, sourceBranch);
    if (pr) return pr;
    if (attempt < retries - 1) await delay(waitMs);
  }
  return null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parses the "## Target Repositories" section from an implementation plan.
 * Lines in that section must be of the form: "- repo-name: reason"
 * Returns an array of repo names (just the name part before the colon).
 */
function parsePlanTargetRepos(planContent) {
  if (!planContent) return [];
  const sectionMatch = planContent.match(/^##\s+Target Repositories\s*\n([\s\S]*?)(?=\n##\s|\s*$)/m);
  if (!sectionMatch) return [];
  const lines = sectionMatch[1].split("\n");
  const repos = [];
  for (const line of lines) {
    const m = line.match(/^-\s+([\w][\w.-]*)(?:\s*:.*)?$/);
    if (m) repos.push(m[1]);
  }
  return repos;
}

/**
 * Extracts the Jira hostname from the webhook payload's user.self URL.
 * e.g. "https://example.atlassian.net/rest/api/2/user?..." → "example.atlassian.net"
 */
function extractJiraHost(payload) {
  const selfUrl = payload?.user?.self || payload?.issue?.self || "";
  try {
    return new URL(selfUrl).hostname || null;
  } catch {
    return null;
  }
}
