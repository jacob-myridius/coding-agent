import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { createAzdoClient } from "./azdo-client.js";
import { runMyridiusImplementation } from "./claude-runner.js";
import { cloneRepository } from "./git-utils.js";
import { buildSkipKey, buildStatusReasonMessage, evaluateImplementationTrigger } from "./policy.js";
import { computeSkipReasonUpdate } from "./skip-reason.js";
import { getCodeContext } from "./code-context.js";
import { runTests } from "./test-execution.js";
import { ensureMavenGitignore, isMavenProject } from "./gitignore-manager.js";

const STATUS_REASON_FIELD = (process.env.AI_PLANNING_STATUS_REASON_FIELD_REF_NAME || "AIPlanningStatusReason").trim();
const STATUS_FIELD = (process.env.AI_PLANNING_STATUS_FIELD_REF_NAME || "AIPlanningStatus").trim();

export async function processWorkItemEventBody(body, dependencies = {}) {
  const payload = normalizePayload(body);
  const decision = evaluateImplementationTrigger(payload, {
    statusFieldRefName: STATUS_FIELD
  });

  const azdo = dependencies.azdoClient || createAzdoClient();
  const cloneRepo = dependencies.cloneRepository || cloneRepository;
  const runImplementation = dependencies.runImplementation || runMyridiusImplementation;

  if (!decision.eligible) {
    const workItemId = Number(payload?.resource?.workItemId ?? payload?.resource?.id ?? 0);
    const revision = Number(payload?.resource?.rev ?? payload?.resource?.revision?.id ?? 0);
    if (workItemId > 0 && revision > 0) {
      await postIdempotentSkipReason({ azdo, workItemId, revision, reasonCode: decision.reasonCode, detail: decision.reasonMessage });
    }
    return { category: "skipped", reasonCode: decision.reasonCode, reason: decision.reasonMessage };
  }

  const repoUrl = (process.env.AZDO_REPO_CLONE_URL || "").trim();
  if (!repoUrl) {
    await postIdempotentSkipReason({
      azdo,
      workItemId: decision.workItemId,
      revision: decision.revision,
      reasonCode: "MissingRepoContext",
      detail: "AZDO_REPO_CLONE_URL is not configured."
    });
    return { category: "skipped", reasonCode: "MissingRepoContext", reason: "Repository context missing" };
  }

  const workItem = await azdo.getWorkItem(decision.workItemId);
  const fields = asObject(workItem.fields) || {};

  const workspacePath = await mkdtemp(path.join(os.tmpdir(), `myridius-worker-${uuid()}-`));
  const branchName = `ai/us-${decision.workItemId}-r${decision.revision}`;

  try {
    const repoGit = await cloneRepo({ repoUrl, branchName, workspacePath });
    const initialHead = await repoGit.revparse(["HEAD"]);

    // Ensure .gitignore excludes test results and build artifacts
    if (await isMavenProject(workspacePath)) {
      console.log("Detected Maven project, ensuring .gitignore is configured...");
      await ensureMavenGitignore(workspacePath, {
        log: (msg) => console.log(`[Gitignore] ${msg}`),
        error: (msg) => console.error(`[Gitignore] ${msg}`)
      });
    }

    // Retrieve relevant code context
    const codeContext = await getCodeContext({
      org: (process.env.AZDO_ORG_NAME || "").trim(),
      project: (process.env.AZDO_PROJECT_NAME || "").trim(),
      repo: (process.env.AZDO_REPO_NAME || "").trim(),
      title: text(fields["System.Title"]),
      description: text(fields["System.Description"]),
      language: "typescript" // Can be made configurable
    });

    const promptTemplate = await readFile(path.join(process.cwd(), "prompts", "implementation-prompt.md"), "utf8");
    const prompt = promptTemplate
      .replaceAll("{{WORK_ITEM_ID}}", String(decision.workItemId))
      .replaceAll("{{WORK_ITEM_BRANCH}}", branchName)
      .replaceAll("{{TITLE}}", text(fields["System.Title"]))
      .replaceAll("{{DESCRIPTION}}", text(fields["System.Description"]))
      .replaceAll("{{ACCEPTANCE_CRITERIA}}", text(fields["Microsoft.VSTS.Common.AcceptanceCriteria"]))
      .replaceAll("{{CODE_CONTEXT}}", codeContext || "");

    await runImplementation({ workspacePath, prompt });

    const finalHead = await repoGit.revparse(["HEAD"]);
    const hasNewCommit = String(finalHead || "") !== String(initialHead || "");

    if (!hasNewCommit) {
      await postIdempotentSkipReason({
        azdo,
        workItemId: decision.workItemId,
        revision: decision.revision,
        reasonCode: "ExecutionSuppressed",
        detail: `CLI run finished but no commits were created on branch '${branchName}'.`
      });
      return { category: "skipped", reasonCode: "ExecutionSuppressed", reason: "No commits created" };
    }

    // Push the branch to origin
    console.log(`Pushing branch '${branchName}' to origin...`);
    await repoGit.push("origin", branchName, { "--set-upstream": null, "--force": null });
    console.log(`Branch '${branchName}' pushed successfully.`);

    // Push the branch to origin
    console.log(`Pushing branch '${branchName}' to origin...`);
    await repoGit.push("origin", branchName, { "--set-upstream": null, "--force": null });
    console.log(`Branch '${branchName}' pushed successfully.`);

    // Run tests after implementation
    console.log("Running tests...");
    const testResult = await runTests(workspacePath, {
      log: (msg) => console.log(`[Tests] ${msg}`),
      error: (msg) => console.error(`[Tests] ${msg}`)
    });

    // Post test results as comment
    await azdo.postComment(decision.workItemId, testResult.message);

    // If tests failed, block PR and notify
    if (!testResult.success) {
      await azdo.postComment(
        decision.workItemId,
        `⚠️ **Implementation blocked:** Tests must pass before PR can be created.\n\nPlease review the test failures above and update the implementation.`
      );

      return {
        category: "blocked",
        reasonCode: "TestsFailed",
        reason: "Tests failed - PR creation blocked",
        testSummary: testResult.summary
      };
    }

    // Check if PR already exists
    let activePr = await findActivePullRequestWithRetry(azdo, branchName, 2, 1000);

    if (!activePr) {
      // Create PR programmatically
      console.log(`Creating pull request for branch '${branchName}'...`);
      const prTitle = `feat(us-${decision.workItemId}): ${text(fields["System.Title"])}`;
      const prDescription = buildPullRequestDescription({
        workItemId: decision.workItemId,
        title: text(fields["System.Title"]),
        description: text(fields["System.Description"]),
        testSummary: testResult.summary,
        branchName
      });

      try {
        activePr = await azdo.createPullRequest({
          sourceBranch: branchName,
          targetRefName: "refs/heads/main",
          title: prTitle,
          description: prDescription
        });
        console.log(`Pull request created successfully: PR #${activePr.pullRequestId}`);
      } catch (error) {
        console.error(`Failed to create PR: ${error.message}`);
        await azdo.postComment(
          decision.workItemId,
          `⚠️ **PR Creation Failed:** ${error.message}\n\nBranch '${branchName}' has been pushed with passing tests. Please create the PR manually.`
        );
        return {
          category: "implemented",
          workItemId: decision.workItemId,
          branchName,
          testSummary: testResult.summary,
          prCreated: false
        };
      }
    } else {
      console.log(`Pull request already exists: PR #${activePr.pullRequestId}`);
    }

    const prLink = activePr.url || `https://dev.azure.com/${process.env.AZDO_ORG}/${process.env.AZDO_PROJECT}/_git/${process.env.AZDO_REPO}/pullrequest/${activePr.pullRequestId}`;

    const testInfo = testResult && testResult.summary && testResult.summary.total !== undefined
      ? `- Tests: ${testResult.summary.passed}/${testResult.summary.total} passed\n` +
        `- Coverage: ${testResult.summary.coverage || 'N/A'}\n`
      : `- Tests: Not executed or unavailable\n`;

    await azdo.postComment(
      decision.workItemId,
      `✅ **Implementation completed successfully!**\n\n` +
      `- Branch: \`${branchName}\`\n` +
      testInfo +
      `- Pull Request: [PR #${activePr.pullRequestId}](${prLink})\n\n` +
      `Please review and merge the pull request.`
    );

    return {
      category: "implemented",
      workItemId: decision.workItemId,
      branchName,
      pullRequestId: activePr.pullRequestId,
      testSummary: testResult.summary,
      prCreated: true
    };
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
}

function buildPullRequestDescription({ workItemId, title, description, testSummary, branchName }) {
  const htmlDescription = description || "No description provided.";
  const plainDescription = htmlDescription.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const summary = plainDescription.length > 200 ? plainDescription.substring(0, 200) + "..." : plainDescription;

  // Handle null/undefined testSummary
  const hasTestResults = testSummary && typeof testSummary.total !== 'undefined';
  const testResultsSection = hasTestResults ? `### Test Results
- **Total Tests:** ${testSummary.total}
- **Passed:** ${testSummary.passed}
- **Failed:** ${testSummary.failed}
- **Skipped:** ${testSummary.skipped || 0}
- **Coverage:** ${testSummary.coverage || "N/A"}` : `### Test Results
- **Status:** Tests were not executed or test results unavailable`;

  const testCheckbox = hasTestResults
    ? `- [x] Tests passing (${testSummary.passed}/${testSummary.total})`
    : `- [ ] Tests execution required`;

  return `## Work Item #${workItemId}: ${title}

### Summary
${summary}

${testResultsSection}

### Implementation Details
This pull request was automatically created by the AI implementation worker for work item #${workItemId}.

**Branch:** \`${branchName}\`

**Related Work Item:** #${workItemId}

### Checklist
- [x] Implementation completed
${testCheckbox}
- [x] Code pushed to branch
- [ ] Code review required
- [ ] Ready to merge

---
*Co-Authored-By: Myridius AI Implementation Worker*`;
}

async function postIdempotentSkipReason({ azdo, workItemId, revision, reasonCode, detail }) {
  const skipKey = buildSkipKey({ workItemId, revision, reasonCode });
  const message = buildStatusReasonMessage({ reasonCode, skipKey, detail });
  const workItem = await azdo.getWorkItem(workItemId);
  const fields = asObject(workItem.fields) || {};
  const existingReason = text(fields[STATUS_REASON_FIELD]);
  const reasonUpdate = computeSkipReasonUpdate(existingReason, message, skipKey);
  if (!reasonUpdate.shouldUpdate) {
    return;
  }

  await azdo.patchWorkItemFields(workItemId, [
    { op: "add", path: `/fields/${STATUS_REASON_FIELD}`, value: reasonUpdate.value }
  ]);
  await azdo.postComment(workItemId, message);
}

function normalizePayload(body) {
  if (typeof body === "string") {
    return JSON.parse(body);
  }
  if (Buffer.isBuffer(body)) {
    return JSON.parse(body.toString("utf8"));
  }
  return body;
}

function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value;
}

function text(value) {
  return String(value || "").trim();
}

async function findActivePullRequestWithRetry(azdo, sourceBranch, retries, waitMs) {
  if (!azdo || typeof azdo.findActivePullRequestBySourceBranch !== "function") {
    return null;
  }

  for (let attempt = 0; attempt < retries; attempt += 1) {
    const pr = await azdo.findActivePullRequestBySourceBranch(sourceBranch);
    if (pr) {
      return pr;
    }
    if (attempt < retries - 1) {
      await delay(waitMs);
    }
  }

  return null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}











