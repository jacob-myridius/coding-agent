import test from "node:test";
import assert from "node:assert/strict";
import { evaluateImplementationTrigger, buildSkipKey } from "../policy.js";

test("eligible when User Story transitions to ReadyForAIImplementation", () => {
  const payload = {
    resource: {
      id: 123,
      rev: 4,
      revision: {
        fields: {
          AIPlanningStatus: { oldValue: "Requesting for Approval", newValue: "ReadyForAIImplementation" },
          "System.WorkItemType": { oldValue: "User Story", newValue: "User Story" }
        }
      }
    }
  };

  const result = evaluateImplementationTrigger(payload, { statusFieldRefName: "AIPlanningStatus" });
  assert.equal(result.eligible, true);
  assert.equal(result.workItemType, "user story");
});

test("eligible when transition is emitted under resource.fields.Custom.AIPlanningStatus", () => {
  const payload = {
    resource: {
      id: 762,
      rev: 28,
      fields: {
        "Custom.AIPlanningStatus": {
          oldValue: "ReadyForImplementation",
          newValue: "ReadyForAIImplementation"
        }
      },
      revision: {
        fields: {
          "System.WorkItemType": "User Story"
        }
      }
    }
  };

  const result = evaluateImplementationTrigger(payload, { statusFieldRefName: "AIPlanningStatus" });
  assert.equal(result.eligible, true);
  assert.equal(result.workItemId, 762);
  assert.equal(result.revision, 28);
  assert.equal(result.oldStatus, "readyforimplementation");
  assert.equal(result.newStatus, "readyforaiimplementation");
});

test("blocked for non-user story", () => {
  const payload = {
    resource: {
      id: 123,
      rev: 4,
      revision: {
        fields: {
          AIPlanningStatus: { oldValue: "Requesting for Approval", newValue: "ReadyForAIImplementation" },
          "System.WorkItemType": { oldValue: "Feature", newValue: "Feature" }
        }
      }
    }
  };

  const result = evaluateImplementationTrigger(payload, { statusFieldRefName: "AIPlanningStatus" });
  assert.equal(result.eligible, false);
  assert.equal(result.reasonCode, "WrongType");
});

test("blocked when no transition", () => {
  const payload = {
    resource: {
      id: 123,
      rev: 4,
      revision: {
        fields: {
          AIPlanningStatus: { oldValue: "ReadyForAIImplementation", newValue: "ReadyForAIImplementation" },
          "System.WorkItemType": { oldValue: "User Story", newValue: "User Story" }
        }
      }
    }
  };

  const result = evaluateImplementationTrigger(payload, { statusFieldRefName: "AIPlanningStatus" });
  assert.equal(result.eligible, false);
  assert.equal(result.reasonCode, "NoStatusTransition");
});

test("skip key is stable", () => {
  const key = buildSkipKey({ workItemId: 10, revision: 3, reasonCode: "WrongType" });
  assert.equal(key, "ai-impl-skip:10:3:wrongtype");
});


