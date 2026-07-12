import { computeSkipReasonUpdate } from "../skip-reason.js";

const skipKey = "ai-impl-skip:10:2:wrongtype";
const firstMessage = `[AI-IMPL-SKIP] key=${skipKey} | code=WrongType | Skipped: work item type is not User Story.`;

const first = computeSkipReasonUpdate("", firstMessage, skipKey);
const second = computeSkipReasonUpdate(first.value, firstMessage, skipKey);

const cases = [
  {
    name: "first_write_updates",
    pass: first.shouldUpdate === true && first.value.includes(skipKey)
  },
  {
    name: "second_write_is_idempotent",
    pass: second.shouldUpdate === false
  }
];

let failed = 0;
for (const item of cases) {
  console.log(JSON.stringify(item));
  if (!item.pass) {
    failed += 1;
  }
}

if (failed > 0) {
  process.exitCode = 1;
}

