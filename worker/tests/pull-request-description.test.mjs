import test from "node:test";
import assert from "node:assert/strict";
import { buildPullRequestDescription } from "../processWorkItem.js";

const baseArgs = {
  workItemId: 1,
  title: "Add task API",
  description: "Build it",
  testSummary: undefined,
  branchName: "ai/us-1-r1"
};

test("includes the agent session id and a parseable marker when provided", () => {
  const sessionId = "11111111-2222-3333-4444-555555555555";
  const body = buildPullRequestDescription({ ...baseArgs, sessionId });
  assert.match(body, /\*\*Agent session:\*\* `11111111-2222-3333-4444-555555555555`/);
  assert.equal(body.match(/<!-- myridius-session-id: ([0-9a-f-]+) -->/)?.[1], sessionId);
  assert.ok(body.indexOf("**Branch:**") < body.indexOf("**Agent session:**"));
  assert.ok(body.indexOf("**Agent session:**") < body.indexOf("### Checklist"));
});

test("omits the session section when no session id is known", () => {
  const body = buildPullRequestDescription(baseArgs);
  assert.doesNotMatch(body, /Agent session|myridius-session-id/);
  assert.match(body, /\*\*Branch:\*\* `ai\/us-1-r1`\n\n### Checklist/);
});
