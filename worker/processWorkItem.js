import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { v4 as uuid } from "uuid";

// Maximum wall-clock time for a single repo implementation (clone + LLM + push).
// Configurable via IMPL_TIMEOUT_MS; defaults to 30 minutes.
const IMPL_TIMEOUT_MS = parseInt(process.env.IMPL_TIMEOUT_MS || "1800000", 10);

function withTimeout(promise, ms, label) {
  let timer;
  const race = Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Implementation timed out after ${ms}ms: ${label}`)),
        ms
      );
    }),
  ]);
  return race.finally(() => clearTimeout(timer));
}
import { createAzdoClient } from "./azdo-client.js";
import { runMyridiusImplementation } from "./claude-runner.js";
import { cloneRepository } from "./git-utils.js";
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
  const decision = evaluateImplementationTrigger(payload, { statusFieldRefName: STATUS_FIELD });

  const { org, project } = extractAdoContext(payload);
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
  const selectedRepos = await resolveRepos(azdo, decision, { title, description });
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
        runImplementation
      }),
      IMPL_TIMEOUT_MS,
      `wi=${decision.workItemId} repo=${repoName}`
    ).catch((err) => {
      console.error(`[${repoName}] implementInRepo failed: ${err.message}`);
      return { category: "skipped", reasonCode: "ImplementationTimeout", repoName, branchName: `ai/us-${decision.workItemId}-r${decision.revision}` };
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
// Per-repo implementation
// ---------------------------------------------------------------------------

async function implementInRepo({ azdo, repoName, repoUrl, decision, fields, promptTemplate, allRepoNames, cloneRepo, runImplementation }) {
  const { title, description, acceptanceCriteria } = fields;
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), `myridius-worker-${uuid()}-`));
  const branchName = `ai/us-${decision.workItemId}-r${decision.revision}`;

  const allReposContext = allRepoNames.length > 1
    ? `This work item spans multiple repositories. You are implementing changes for '${repoName}'.\n` +
      `Other repositories also being updated: ${allRepoNames.filter((n) => n !== repoName).join(", ")}.\n` +
      `Focus only on the changes needed in THIS repository.`
    : "";

  try {
    const repoGit = await cloneRepo({ repoUrl, branchName, workspacePath });
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

    await runImplementation({ workspacePath, prompt });

    const finalHead = await repoGit.revparse(["HEAD"]);
    if (String(finalHead || "") === String(initialHead || "")) {
      console.log(`[${repoName}] No commits created — skipping push and PR.`);
      return { category: "skipped", reasonCode: "ExecutionSuppressed", repoName, branchName };
    }

    console.log(`[${repoName}] Pushing branch '${branchName}'...`);
    await repoGit.push("origin", branchName, { "--set-upstream": null, "--force": null });
    console.log(`[${repoName}] Branch pushed successfully.`);

    console.log(`[${repoName}] Running tests...`);
    const testResult = await runTests(workspacePath, {
      log: (msg) => console.log(`[${repoName}][Tests] ${msg}`),
      error: (msg) => console.error(`[${repoName}][Tests] ${msg}`)
    });

    if (!testResult.success) {
      return { category: "blocked", reasonCode: "TestsFailed", repoName, branchName, testSummary: testResult.summary };
    }

    let activePr = await findActivePullRequestWithRetry(azdo, repoName, branchName, 2, 1000);

    if (!activePr) {
      const prTitle = `feat(us-${decision.workItemId}): ${title}`;
      const prDescription = buildPullRequestDescription({
        workItemId: decision.workItemId,
        title,
        description,
        testSummary: testResult.summary,
        branchName
      });
      try {
        activePr = await azdo.createPullRequest({ repo: repoName, sourceBranch: branchName, targetRefName: "refs/heads/main", title: prTitle, description: prDescription });
        console.log(`[${repoName}] PR #${activePr.pullRequestId} created.`);
      } catch (err) {
        console.error(`[${repoName}] Failed to create PR: ${err.message}`);
        return { category: "implemented", repoName, branchName, testSummary: testResult.summary, prCreated: false };
      }
    }

    return {
      category: "implemented",
      repoName,
      branchName,
      pullRequestId: activePr.pullRequestId,
      pullRequestUrl: activePr.url || buildPrUrl(azdo, repoName, activePr.pullRequestId),
      testSummary: testResult.summary,
      prCreated: true
    };
  } catch (err) {
    console.error(`[${repoName}] Implementation error: ${err.message}`);
    return { category: "skipped", reasonCode: "ImplementationError", repoName, branchName, error: err.message };
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Repo resolution
// ---------------------------------------------------------------------------

async function resolveRepos(azdo, decision, { title, description }) {
  const repos = await azdo.listRepositories();
  if (repos.length === 0) return [];

  const selected = selectRepositories(repos, {
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
    lines.push("");
  }

  lines.push("---");
  lines.push("*Co-Authored-By: Myridius AI Implementation Worker*");
  return lines.join("\n");
}

function buildPullRequestDescription({ workItemId, title, description, testSummary, branchName }) {
  const plainDesc = (description || "No description provided.").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const summary = plainDesc.length > 200 ? plainDesc.substring(0, 200) + "..." : plainDesc;

  const hasTestResults = testSummary && typeof testSummary.total !== "undefined";
  const testSection = hasTestResults
    ? `### Test Results\n- **Total:** ${testSummary.total}\n- **Passed:** ${testSummary.passed}\n- **Failed:** ${testSummary.failed}\n- **Coverage:** ${testSummary.coverage || "N/A"}`
    : `### Test Results\n- **Status:** Not executed or unavailable`;
  const testCheckbox = hasTestResults
    ? `- [x] Tests passing (${testSummary.passed}/${testSummary.total})`
    : `- [ ] Tests execution required`;

  return `## Work Item #${workItemId}: ${title}\n\n### Summary\n${summary}\n\n${testSection}\n\n### Implementation Details\nAutomatically created for work item #${workItemId}.\n\n**Branch:** \`${branchName}\`\n\n### Checklist\n- [x] Implementation completed\n${testCheckbox}\n- [x] Code pushed to branch\n- [ ] Code review required\n\n---\n*Co-Authored-By: Myridius AI Implementation Worker*`;
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
