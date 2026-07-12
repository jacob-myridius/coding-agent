import test from "node:test";
import assert from "node:assert/strict";
import { processWorkItemEventBody } from "../processWorkItem.js";

test("blocked duplicate event writes status reason/comment only once", async () => {
  const payload = {
    eventType: "workitem.updated",
    resource: {
      id: 8001,
      rev: 5,
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
    async getWorkItem() {
      return {
        fields: {
          AIPlanningStatusReason: state.reasonField
        }
      };
    },
    async patchWorkItemFields(_id, operations) {
      state.reasonField = String(operations?.[0]?.value || "");
      state.patchCount += 1;
    },
    async postComment() {
      state.commentCount += 1;
    },
    async createPullRequest() {
      throw new Error("should not create pull request for blocked event");
    }
  };

  const first = await processWorkItemEventBody(payload, { azdoClient });
  const second = await processWorkItemEventBody(payload, { azdoClient });

  assert.equal(first.category, "skipped");
  assert.equal(first.reasonCode, "WrongType");
  assert.equal(second.category, "skipped");
  assert.equal(second.reasonCode, "WrongType");
  assert.equal(state.patchCount, 1);
  assert.equal(state.commentCount, 1);
});

test("blocked non-user-story with transition from resource.fields uses WrongType (not NoStatusTransition)", async () => {
  const payload = {
    eventType: "workitem.updated",
    resource: {
      id: 8002,
      rev: 6,
      fields: {
        "Custom.AIPlanningStatus": {
          oldValue: "ReadyForImplementation",
          newValue: "ReadyForAIImplementation"
        }
      },
      revision: {
        fields: {
          "System.WorkItemType": "Feature"
        }
      }
    }
  };

  const azdoClient = {
    async getWorkItem() {
      return { fields: { AIPlanningStatusReason: "" } };
    },
    async patchWorkItemFields() {},
    async postComment() {},
    async createPullRequest() {
      throw new Error("should not create pull request for blocked event");
    }
  };

  const result = await processWorkItemEventBody(payload, { azdoClient });
  assert.equal(result.category, "skipped");
  assert.equal(result.reasonCode, "WrongType");
});


