import test from "node:test";
import assert from "node:assert/strict";
import { buildMyridiusCliInvocation } from "../claude-runner.js";

test("defaults to implementation-focused agent with full-auto bypass mode", () => {
  const invocation = buildMyridiusCliInvocation({});
  assert.equal(invocation.bin, "node");
  assert.deepEqual(invocation.args, [
    "/app/node_modules/myridius/dist/cli.mjs",
    "--print",
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
    "/app/node_modules/myridius/dist/cli.mjs",
    "--print",
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
    "/app/node_modules/myridius/dist/cli.mjs",
    "--print",
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
    "/app/node_modules/myridius/dist/cli.mjs",
    "--print",
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
    "/app/node_modules/myridius/dist/cli.mjs",
    "--print",
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
    "/app/node_modules/myridius/dist/cli.mjs",
    "--print",
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
    "/app/node_modules/myridius/dist/cli.mjs",
    "--print",
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



