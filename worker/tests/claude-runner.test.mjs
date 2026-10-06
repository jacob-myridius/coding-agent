import test from "node:test";
import assert from "node:assert/strict";
import { buildMyridiusCliInvocation, MYRIDIUS_CLI_PATH, summarizeStreamEvent } from "../claude-runner.js";

test("defaults to implementation-focused agent with full-auto bypass mode", () => {
  const invocation = buildMyridiusCliInvocation({});
  assert.equal(invocation.bin, "node");
  assert.deepEqual(invocation.args, [
    MYRIDIUS_CLI_PATH,
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--agent",
    "backend-specialist",
    "--permission-mode",
    "bypassPermissions"
  ]);
});

test("supports explicit full-auto bypass when not running as root", () => {
  const invocation = buildMyridiusCliInvocation({ MYRIDIUS_CLI_FULL_AUTO: "1", USER: "appuser" });
  assert.equal(invocation.bin, "node");
  assert.deepEqual(invocation.args, [
    MYRIDIUS_CLI_PATH,
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--agent",
    "backend-specialist",
    "--permission-mode",
    "bypassPermissions"
  ]);
});

test("uses bypass mode when full-auto is set under root and root bypass is enabled", () => {
  const invocation = buildMyridiusCliInvocation({ MYRIDIUS_CLI_FULL_AUTO: "1", USER: "root" });
  assert.equal(invocation.bin, "node");
  assert.deepEqual(invocation.args, [
    MYRIDIUS_CLI_PATH,
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--agent",
    "backend-specialist",
    "--permission-mode",
    "bypassPermissions"
  ]);
});

test("falls back to auto mode when full-auto is set under root and root bypass is disabled", () => {
  const invocation = buildMyridiusCliInvocation({
    MYRIDIUS_CLI_FULL_AUTO: "1",
    MYRIDIUS_CLI_ALLOW_ROOT_BYPASS: "0",
    USER: "root"
  });
  assert.equal(invocation.bin, "node");
  assert.deepEqual(invocation.args, [
    MYRIDIUS_CLI_PATH,
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--agent",
    "backend-specialist",
    "--permission-mode",
    "auto"
  ]);
});

test("uses explicit MYRIDIUS_CLI_PERMISSION_MODE when provided", () => {
  const invocation = buildMyridiusCliInvocation({
    MYRIDIUS_CLI_PERMISSION_MODE: "plan",
    MYRIDIUS_CLI_FULL_AUTO: "0"
  });
  assert.equal(invocation.bin, "node");
  assert.deepEqual(invocation.args, [
    MYRIDIUS_CLI_PATH,
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--agent",
    "backend-specialist",
    "--permission-mode",
    "plan"
  ]);
});

test("does not add dangerous skip flag by default when explicit bypassPermissions mode is provided", () => {
  const invocation = buildMyridiusCliInvocation({
    MYRIDIUS_CLI_PERMISSION_MODE: "bypassPermissions",
    MYRIDIUS_CLI_FULL_AUTO: "0"
  });
  assert.equal(invocation.bin, "node");
  assert.deepEqual(invocation.args, [
    MYRIDIUS_CLI_PATH,
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--agent",
    "backend-specialist",
    "--permission-mode",
    "bypassPermissions"
  ]);
});

test("adds dangerous skip flag only when explicitly enabled and not running as root", () => {
  const invocation = buildMyridiusCliInvocation({
    MYRIDIUS_CLI_PERMISSION_MODE: "bypassPermissions",
    MYRIDIUS_CLI_DANGEROUSLY_SKIP_PERMISSIONS: "1",
    MYRIDIUS_CLI_FULL_AUTO: "0",
    USER: "appuser"
  });
  assert.equal(invocation.bin, "node");
  assert.deepEqual(invocation.args, [
    MYRIDIUS_CLI_PATH,
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--agent",
    "backend-specialist",
    "--permission-mode",
    "bypassPermissions",
    "--dangerously-skip-permissions"
  ]);
});

test("uses explicit MYRIDIUS_CLI_COMMAND when provided", () => {
  const invocation = buildMyridiusCliInvocation({
    MYRIDIUS_CLI_COMMAND: "node /tmp/cli.mjs --print --agent claude-code-guide --permission-mode auto"
  });
  assert.equal(invocation.bin, "node");
  assert.deepEqual(invocation.args, ["/tmp/cli.mjs", "--print", "--agent", "claude-code-guide", "--permission-mode", "auto"]);
});

test("disables --verbose for text output when MYRIDIUS_CLI_VERBOSE=0", () => {
  const invocation = buildMyridiusCliInvocation({ MYRIDIUS_CLI_OUTPUT_FORMAT: "text", MYRIDIUS_CLI_VERBOSE: "0" });
  assert.deepEqual(invocation.args.slice(0, 4), [MYRIDIUS_CLI_PATH, "-p", "--output-format", "text"]);
});

test("forces --verbose for stream-json even when MYRIDIUS_CLI_VERBOSE=0", () => {
  const invocation = buildMyridiusCliInvocation({ MYRIDIUS_CLI_VERBOSE: "0" });
  assert.deepEqual(invocation.args.slice(0, 5), [MYRIDIUS_CLI_PATH, "-p", "--verbose", "--output-format", "stream-json"]);
});

test("falls back to stream-json for an unknown output format", () => {
  const invocation = buildMyridiusCliInvocation({ MYRIDIUS_CLI_OUTPUT_FORMAT: "xml" });
  assert.deepEqual(invocation.args.slice(3, 5), ["--output-format", "stream-json"]);
});

test("summarizes assistant tool_use and text blocks with truncation", () => {
  const summary = summarizeStreamEvent(
    {
      type: "assistant",
      session_id: "s1",
      message: {
        content: [
          { type: "text", text: "abcdefghij" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "git status" } }
        ]
      }
    },
    5
  );
  assert.deepEqual(summary, {
    type: "assistant",
    sessionId: "s1",
    content: [
      { type: "text", text: "abcde... [5 more chars]" },
      { type: "tool_use", id: "t1", name: "Bash", input: '{"com... [19 more chars]' }
    ]
  });
});

test("summarizes the final result event", () => {
  const summary = summarizeStreamEvent({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 12,
    duration_ms: 1000,
    duration_api_ms: 800,
    total_cost_usd: 0.42,
    result: "done"
  });
  assert.equal(summary.type, "result");
  assert.equal(summary.subtype, "success");
  assert.equal(summary.isError, false);
  assert.equal(summary.numTurns, 12);
  assert.equal(summary.totalCostUsd, 0.42);
  assert.equal(summary.result, "done");
});

test("includes details of non-init system events such as api_retry", () => {
  const summary = summarizeStreamEvent({
    type: "system",
    subtype: "api_retry",
    session_id: "s1",
    attempt: 3,
    error_status: null,
    error: { message: "getaddrinfo ENOTFOUND" }
  });
  assert.deepEqual(summary, {
    type: "system",
    subtype: "api_retry",
    sessionId: "s1",
    attempt: 3,
    error_status: null,
    error: '{"message":"getaddrinfo ENOTFOUND"}'
  });
});

test("passes a pre-assigned session id to the CLI", () => {
  const invocation = buildMyridiusCliInvocation({}, { sessionId: "11111111-2222-3333-4444-555555555555" });
  assert.deepEqual(invocation.args.slice(5, 7), ["--session-id", "11111111-2222-3333-4444-555555555555"]);
});

test("resumes an existing session with --resume instead of --session-id", () => {
  const invocation = buildMyridiusCliInvocation({}, { sessionId: "ignored", resumeSessionId: "11111111-2222-3333-4444-555555555555" });
  assert.deepEqual(invocation.args.slice(5, 7), ["--resume", "11111111-2222-3333-4444-555555555555"]);
  assert.ok(!invocation.args.includes("--session-id"));
});
