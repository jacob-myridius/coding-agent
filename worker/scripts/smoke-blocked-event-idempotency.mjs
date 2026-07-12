import { processWorkItemEventBody } from "../processWorkItem.js";

const workItemId = 9911;
const revision = 3;
const payload = {
  eventType: "workitem.updated",
  resource: {
    id: workItemId,
    rev: revision,
    revision: {
      fields: {
        AIPlanningStatus: {
          oldValue: "Requesting for Approval",
          newValue: "ReadyForAIImplementation"
        },
        "System.WorkItemType": {
          oldValue: "Feature",
          newValue: "Feature"
        }
      }
    }
  }
};

const state = {
  reasonField: "",
  patchCount: 0,
  commentCount: 0
};

const azdoClient = {
  async getWorkItem(id) {
    if (id !== workItemId) {
      throw new Error(`Unexpected work item id: ${id}`);
    }
    return {
      id,
      fields: {
        AIPlanningStatusReason: state.reasonField
      }
    };
  },
  async patchWorkItemFields(id, operations) {
    if (id !== workItemId) {
      throw new Error(`Unexpected patch id: ${id}`);
    }
    const value = operations?.[0]?.value;
    state.reasonField = String(value || "");
    state.patchCount += 1;
  },
  async postComment(id, _text) {
    if (id !== workItemId) {
      throw new Error(`Unexpected comment id: ${id}`);
    }
    state.commentCount += 1;
  },
  async createPullRequest() {
    throw new Error("createPullRequest should not be called for blocked events");
  }
};

const first = await processWorkItemEventBody(payload, { azdoClient });
const second = await processWorkItemEventBody(payload, { azdoClient });

const checks = [
  {
    name: "first_call_is_blocked_wrong_type",
    pass: first.category === "skipped" && first.reasonCode === "WrongType"
  },
  {
    name: "second_call_is_blocked_wrong_type",
    pass: second.category === "skipped" && second.reasonCode === "WrongType"
  },
  {
    name: "single_patch_for_duplicate_skip",
    pass: state.patchCount === 1
  },
  {
    name: "single_comment_for_duplicate_skip",
    pass: state.commentCount === 1
  }
];

let failed = 0;
for (const check of checks) {
  console.log(JSON.stringify(check));
  if (!check.pass) {
    failed += 1;
  }
}

if (failed > 0) {
  process.exitCode = 1;
}

