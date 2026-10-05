import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  createSessionLogBus,
  installConsoleTap,
  redactCredentials,
  runInSessionScope,
  toLogLine
} from "../session-log-bus.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

// A console-like target so the tests don't wrap (or print through) the real console.
function createConsole() {
  const printed = [];
  const target = {};
  for (const method of ["log", "info", "warn", "error"]) target[method] = (...args) => printed.push([method, ...args]);
  installConsoleTap(target);
  return { target, printed };
}

test("assigns sequence numbers and records run, log and end frames", () => {
  const bus = createSessionLogBus();
  bus.startRun(A, { kind: "implementation", repoName: "sample" });
  bus.append(A, { level: "info", event: "hello" });
  bus.endRun(A, { outcome: "implemented" });

  const { replay, gap, running } = bus.subscribe(A);
  assert.deepEqual(replay.map((f) => `${f.seq}:${f.type}`), ["1:run", "2:log", "3:end"]);
  assert.equal(gap, 0);
  assert.equal(running, false);
  assert.equal(replay[0].repoName, "sample");
  assert.deepEqual({ ...bus.get(A), startedAt: undefined, endedAt: undefined }, {
    sessionId: A, state: "ended", kind: "implementation", workItemId: undefined, repoName: "sample",
    branchName: undefined, startedAt: undefined, endedAt: undefined, outcome: "implemented", lines: 3
  });
  assert.equal(bus.subscribe(B), null);
});

test("replays after a sequence number, reports dropped frames, then delivers live frames", () => {
  const bus = createSessionLogBus({ maxLines: 3 });
  bus.startRun(A, { kind: "resume" });
  for (let i = 0; i < 4; i += 1) bus.append(A, { level: "info", event: `line ${i}` });

  const live = [];
  const sub = bus.subscribe(A, { afterSeq: 1 }, (frame) => live.push(frame));
  assert.deepEqual(sub.replay.map((f) => f.seq), [3, 4, 5]);
  assert.equal(sub.gap, 1, "seq 2 fell out of the ring buffer");
  assert.equal(sub.running, true);

  bus.append(A, { level: "warn", event: "live" });
  bus.endRun(A);
  assert.deepEqual(live.map((f) => f.type), ["log", "end"]);

  sub.unsubscribe();
  assert.equal(bus.subscribe(A, { afterSeq: 7 }).replay.length, 0);
});

test("a new run on the same session continues the sequence", () => {
  const bus = createSessionLogBus();
  bus.startRun(A, { kind: "implementation", branchName: "ai/us-1-r1" });
  bus.endRun(A);
  bus.startRun(A, { kind: "resume" });
  assert.equal(bus.isRunning(A), true);
  assert.deepEqual(bus.subscribe(A).replay.map((f) => `${f.seq}:${f.type}`), ["1:run", "2:end", "3:run"]);
  assert.equal(bus.get(A).kind, "resume");
  assert.equal(bus.get(A).branchName, "ai/us-1-r1", "metadata from earlier runs is kept");
});

test("drops ended sessions after the retention period and lists running sessions first", () => {
  let clock = Date.parse("2026-10-06T00:00:00Z");
  const bus = createSessionLogBus({ retainMs: 1000, now: () => clock });
  bus.startRun(A, { kind: "implementation" });
  bus.endRun(A);
  clock += 10;
  bus.startRun(B, { kind: "resume" });
  assert.deepEqual(bus.list().map((s) => s.sessionId), [B, A]);
  clock += 1000;
  assert.equal(bus.get(A), null);
  assert.deepEqual(bus.list().map((s) => s.sessionId), [B], "running sessions never expire");
});

test("the console tap captures only inside a scope and keeps concurrent scopes apart", async () => {
  const bus = createSessionLogBus();
  const { target, printed } = createConsole();

  target.log("outside");
  await Promise.all([
    runInSessionScope(A, { kind: "implementation" }, async () => {
      target.log("a1", { sessionId: A });
      await new Promise((resolve) => setTimeout(resolve, 5));
      target.error("a2");
      return { category: "blocked", reasonCode: "TestsFailed" };
    }, bus),
    runInSessionScope(B, { kind: "resume" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      target.warn("b1");
    }, bus)
  ]);

  assert.equal(printed.length, 4, "everything is still printed");
  const events = (id) => bus.subscribe(id).replay.filter((f) => f.type === "log").map((f) => `${f.level}:${f.event}`);
  assert.deepEqual(events(A), ["info:a1", "error:a2"]);
  assert.deepEqual(events(B), ["warn:b1"]);
  assert.equal(bus.get(A).outcome, "blocked:TestsFailed");
  assert.equal(bus.get(B).outcome, "completed");
});

test("captures logs from child process callbacks and records failures", async () => {
  const bus = createSessionLogBus();
  const { target } = createConsole();

  await assert.rejects(
    runInSessionScope(A, { kind: "implementation" }, async () => {
      const child = spawn(process.execPath, ["-e", "console.log('from child')"]);
      child.stdout.on("data", (chunk) => target.log("aca_test_child_line", { line: String(chunk).trim() }));
      await new Promise((resolve) => child.on("close", resolve));
      throw new Error("boom");
    }, bus)
  );

  const line = bus.subscribe(A).replay.find((f) => f.event === "aca_test_child_line");
  assert.deepEqual(line.data, { line: "from child" });
  assert.equal(bus.get(A).outcome, "failed: boom");
});

test("log lines are JSON-safe, truncated and free of credentials", () => {
  assert.deepEqual(toLogLine("error", ["[repo] failed", new Error("nope")]), {
    level: "error", event: "[repo] failed", data: { name: "Error", message: "nope" }
  });
  assert.deepEqual(toLogLine("info", [{ a: 1n }]).data, { a: "1" });
  assert.equal(toLogLine("info", ["x", "y", 2]).data.length, 2);

  const line = toLogLine("error", [
    "clone failed: https://oauth2:ghp_secret@github.com/acme/sample.git",
    { url: "https://org:pat@dev.azure.com/org/_git/r", header: "Bearer abc.def" }
  ]);
  const text = JSON.stringify(line);
  assert.doesNotMatch(text, /ghp_secret|:pat@|abc\.def/);
  assert.match(text, /https:\/\/\*\*\*@github\.com/);
  assert.equal(redactCredentials("see https://github.com/acme/x"), "see https://github.com/acme/x");

  const big = toLogLine("info", ["big", "x".repeat(40_000)]);
  assert.equal(big.data.truncated, true);
});
