import test from "node:test";
import assert from "node:assert/strict";
import { processWorkItemEventBody } from "../processWorkItem.js";

function buildEligiblePayload() {
  return {
    eventType: "workitem.updated",
    resource: {
      id: 762,
      rev: 64,
      revision: {
        fields: {
          AIPlanningStatus: {
            oldValue: "ReadyForImplementation",
            newValue: "ReadyForAIImplementation"
          },
          "System.WorkItemType": {
            oldValue: "User Story",
            newValue: "User Story"
          }
        }
      }
    }
  };
}

function buildMockAzdo(overrides = {}) {
  return {
    org: "test-org",
    project: "test-project",
    async listRepositories() {
      return [{ name: "sample-repo", isDisabled: false }];
    },
    buildCloneUrl(name) {
      return `https://test-org:pat@dev.azure.com/test-org/test-project/_git/${name}`;
    },
    async getWorkItem() {
      return {
        fields: {
          "System.Title": "Sample story",
          "System.Description": "desc",
          "Microsoft.VSTS.Common.AcceptanceCriteria": "ac",
          AIPlanningStatusReason: ""
        }
      };
    },
    async patchWorkItemFields() {},
    async postComment() {},
    async findActivePullRequestBySourceBranch() { return null; },
    async createPullRequest() { throw new Error("no PR in test"); },
    ...overrides
  };
}

test("returns skipped when CLI run leaves no new commit", async () => {
  const payload = buildEligiblePayload();
  const azdoClient = buildMockAzdo();

  const cloneRepository = async () => ({
    async revparse() { return "abc123"; },
    async push() {}
  });

  const result = await processWorkItemEventBody(payload, {
    azdoClient,
    cloneRepository,
    runImplementation: async () => {}
  });

  assert.equal(result.category, "skipped");
  assert.ok(Array.isArray(result.repos));
  assert.equal(result.repos[0].reasonCode, "ExecutionSuppressed");
});

test("returns implemented (no PR) when CLI creates new commit but PR creation fails", async () => {
  const payload = buildEligiblePayload();
  const azdoClient = buildMockAzdo();

  let revParseCount = 0;
  const cloneRepository = async () => ({
    async revparse() {
      revParseCount += 1;
      return revParseCount === 1 ? "abc123" : "def456";
    },
    async push() {}
  });

  const result = await processWorkItemEventBody(payload, {
    azdoClient,
    cloneRepository,
    runImplementation: async () => {}
  });

  // Tests are disabled in test env → pass; PR creation mock throws → implemented with prCreated: false
  assert.equal(result.category, "implemented");
  assert.ok(Array.isArray(result.repos));
  assert.equal(result.repos[0].repoName, "sample-repo");
  assert.equal(result.repos[0].prCreated, false);
});

test("returns implemented when active PR already exists for the branch", async () => {
  const payload = buildEligiblePayload();
  const azdoClient = buildMockAzdo({
    async findActivePullRequestBySourceBranch() {
      return { pullRequestId: 355, sourceRefName: "refs/heads/ai/us-762-r64", url: "https://dev.azure.com/pr/355" };
    }
  });

  let revParseCount = 0;
  const cloneRepository = async () => ({
    async revparse() {
      revParseCount += 1;
      return revParseCount === 1 ? "abc123" : "def456";
    },
    async push() {}
  });

  const result = await processWorkItemEventBody(payload, {
    azdoClient,
    cloneRepository,
    runImplementation: async () => {}
  });

  assert.equal(result.category, "implemented");
  assert.equal(result.repos[0].pullRequestId, 355);
});
