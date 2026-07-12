import test from "node:test";
import assert from "node:assert/strict";
import { computeSkipReasonUpdate } from "../skip-reason.js";

test("returns no update when skip key already exists", () => {
  const result = computeSkipReasonUpdate(
    "line 1\n[AI-IMPL-SKIP] key=ai-impl-skip:10:2:wrongtype | code=WrongType",
    "new message",
    "ai-impl-skip:10:2:wrongtype"
  );

  assert.equal(result.shouldUpdate, false);
});

test("appends message when skip key does not exist", () => {
  const result = computeSkipReasonUpdate("existing", "new message", "ai-impl-skip:10:2:wrongtype");

  assert.equal(result.shouldUpdate, true);
  assert.equal(result.value, "existing\nnew message");
});

test("writes message when existing field is empty", () => {
  const result = computeSkipReasonUpdate("", "new message", "ai-impl-skip:10:2:wrongtype");

  assert.equal(result.shouldUpdate, true);
  assert.equal(result.value, "new message");
});

