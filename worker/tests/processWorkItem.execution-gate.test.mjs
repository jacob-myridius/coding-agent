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

test("returns skipped when CLI run leaves no new commit and no active PR", async () => {
  const payload = buildEligiblePayload();

  const azdoClient = {
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
    async findActivePullRequestBySourceBranch() {
      return null;
    }
  };

  const cloneRepository = async () => ({
    async revparse() {
      return "abc123";
    }
  });

  const runImplementation = async () => {};

  const result = await processWorkItemEventBody(payload, {
    azdoClient,
    cloneRepository,
    runImplementation
  });

  assert.equal(result.category, "skipped");
  assert.equal(result.reasonCode, "ExecutionSuppressed");
});

test("returns skipped when CLI run creates a new commit but no active PR exists", async () => {
  const payload = buildEligiblePayload();

  const azdoClient = {
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
    async findActivePullRequestBySourceBranch() {
      return null;
    }
  };

  let revParseCount = 0;
  const cloneRepository = async () => ({
    async revparse() {
      revParseCount += 1;
      return revParseCount === 1 ? "abc123" : "def456";
    }
  });

  const runImplementation = async () => {};

  const result = await processWorkItemEventBody(payload, {
    azdoClient,
    cloneRepository,
    runImplementation
  });

  assert.equal(result.category, "skipped");
  assert.equal(result.reasonCode, "ExecutionSuppressed");
  assert.equal(result.reason, "No active pull request detected");
});

test("returns implemented when active PR exists even if head is unchanged", async () => {
  const payload = buildEligiblePayload();

  const azdoClient = {
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
    async findActivePullRequestBySourceBranch() {
      return { pullRequestId: 355, sourceRefName: "refs/heads/ai/us-762-r64" };
    }
  };

  const cloneRepository = async () => ({
    async revparse() {
      return "abc123";
    }
  });

  const runImplementation = async () => {};

  const result = await processWorkItemEventBody(payload, {
    azdoClient,
    cloneRepository,
    runImplementation
  });

  assert.equal(result.category, "implemented");
  assert.equal(result.workItemId, 762);
});


