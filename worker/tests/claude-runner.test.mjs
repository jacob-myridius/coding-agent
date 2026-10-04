import test from "node:test";
import assert from "node:assert/strict";
import { buildMyridiusCliInvocation } from "../claude-runner.js";

// The CLI path is resolved relative to __dirname at runtime; we only verify it
// ends with the expected suffix rather than hardcoding an absolute path.
function assertCliInvocation(invocation, expectedArgsTail) {
  assert.equal(invocation.bin, "node");
  assert.ok(
    invocation.args[0].endsWith("myridius/dist/cli.mjs") || invocation.args[0].endsWith("myridius\\dist\\cli.mjs"),
    `args[0] should be the myridius CLI path, got: ${invocation.args[0]}`
  );
  assert.deepEqual(invocation.args.slice(1), expectedArgsTail);
}

test("defaults to implementation-focused agent with full-auto bypass mode", () => {
  const invocation = buildMyridiusCliInvocation({});
  assertCliInvocation(invocation, [
    "--print",
    "--output-format",
    "json",
    "--agent",
    "backend-specialist",
    "--permission-mode",
    "bypassPermissions"
  ]);
});

test("supports explicit full-auto bypass when not running as root", () => {
  const invocation = buildMyridiusCliInvocation({ MYRIDIUS_CLI_FULL_AUTO: "1", USER: "appuser" });
  assertCliInvocation(invocation, [
    "--print",
    "--output-format",
    "json",
    "--agent",
    "backend-specialist",
    "--permission-mode",
    "bypassPermissions"
  ]);
});

test("uses bypass mode when full-auto is set under root and root bypass is enabled", () => {
  const invocation = buildMyridiusCliInvocation({ MYRIDIUS_CLI_FULL_AUTO: "1", USER: "root" });
  assertCliInvocation(invocation, [
    "--print",
    "--output-format",
    "json",
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
  assertCliInvocation(invocation, [
    "--print",
    "--output-format",
    "json",
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
  assertCliInvocation(invocation, [
    "--print",
    "--output-format",
    "json",
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
  assertCliInvocation(invocation, [
    "--print",
    "--output-format",
    "json",
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
  assertCliInvocation(invocation, [
    "--print",
    "--output-format",
    "json",
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
