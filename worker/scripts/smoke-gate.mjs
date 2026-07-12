import { evaluateImplementationTrigger } from "../policy.js";

const cases = [
  {
    name: "eligible_user_story_transition",
    payload: {
      eventType: "workitem.updated",
      resource: {
        id: 9001,
        rev: 12,
        revision: {
          fields: {
            AIPlanningStatus: {
              oldValue: "Requesting for Approval",
              newValue: "ReadyForAIImplementation"
            },
            "System.WorkItemType": {
              oldValue: "User Story",
              newValue: "User Story"
            }
          }
        }
      }
    },
    expected: { eligible: true, reasonCode: "" }
  },
  {
    name: "blocked_non_user_story",
    payload: {
      eventType: "workitem.updated",
      resource: {
        id: 9002,
        rev: 7,
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
    },
    expected: { eligible: false, reasonCode: "WrongType" }
  },
  {
    name: "blocked_no_status_transition",
    payload: {
      eventType: "workitem.updated",
      resource: {
        id: 9003,
        rev: 2,
        revision: {
          fields: {
            AIPlanningStatus: {
              oldValue: "ReadyForAIImplementation",
              newValue: "ReadyForAIImplementation"
            },
            "System.WorkItemType": {
              oldValue: "User Story",
              newValue: "User Story"
            }
          }
        }
      }
    },
    expected: { eligible: false, reasonCode: "NoStatusTransition" }
  }
];

let failed = 0;
for (const testCase of cases) {
  const result = evaluateImplementationTrigger(testCase.payload, {
    statusFieldRefName: "AIPlanningStatus"
  });

  const pass = result.eligible === testCase.expected.eligible
    && result.reasonCode === testCase.expected.reasonCode;

  console.log(JSON.stringify({
    test: testCase.name,
    pass,
    expected: testCase.expected,
    actual: { eligible: result.eligible, reasonCode: result.reasonCode }
  }));

  if (!pass) {
    failed += 1;
  }
}

if (failed > 0) {
  process.exitCode = 1;
}

