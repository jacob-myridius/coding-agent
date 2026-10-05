import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createSessionRequestHandler } from "../session-http.js";
import { createSessionLogBus } from "../session-log-bus.js";

const SESSION_ID = "91536cec-f84f-49eb-93c1-6424375eca68";
const SECRET = "test-secret";
const auth = { Authorization: `Bearer ${SECRET}` };

async function startServer(options = {}) {
  const handler = createSessionRequestHandler({
    env: { AGENT_CALLBACK_SECRET: SECRET },
    findSessionTranscript: async (id) => (id === SESSION_ID ? "/config/projects/x/transcript.jsonl" : null),
    resumeSession: async () => ({ sessionId: SESSION_ID }),
    logBus: createSessionLogBus(),
    ...options
  });
  const server = http.createServer(async (req, res) => {
    if (await handler(req, res)) return;
    res.writeHead(404);
    res.end("not handled");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

function post(base, id, body, headers = auth) {
  return fetch(`${base}/api/sessions/${id}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

async function readLines(response) {
  return (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
}

test("streams status, session, events and the result as NDJSON", async () => {
  let received;
  const { base, close } = await startServer({
    resumeSession: async (options) => {
      received = options;
      options.hooks.onStatus("cloning");
      options.hooks.onStatus("session", { sessionId: SESSION_ID, branchName: "ai/us-1-r1", branchExisted: true, head: "abc" });
      options.hooks.onStatus("running");
      options.hooks.onEvent({ sessionId: SESSION_ID, type: "assistant", content: [{ type: "tool_use", name: "Bash" }] });
      options.hooks.onStatus("pushing");
      options.hooks.onStatus("done");
      return { sessionId: SESSION_ID, newCommits: 1, pushed: true };
    }
  });
  try {
    const response = await post(base, SESSION_ID, { message: "Add GET /tasks/:id", push: false, overrides: { projectId: "local-dev" } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/x-ndjson/);
    const lines = await readLines(response);
    assert.deepEqual(lines.map((l) => l.type === "status" ? `status:${l.phase}` : l.type), [
      "status:cloning", "session", "status:running", "event", "status:pushing", "status:done", "result"
    ]);
    assert.equal(lines.find((l) => l.type === "session").branchName, "ai/us-1-r1");
    assert.equal(lines.find((l) => l.type === "event").event.content[0].name, "Bash");
    assert.deepEqual(lines.at(-1), { type: "result", sessionId: SESSION_ID, newCommits: 1, pushed: true });

    assert.equal(received.sessionId, SESSION_ID);
    assert.equal(received.prompt, "Add GET /tasks/:id");
    assert.equal(received.push, false);
    assert.deepEqual(received.overrides, { projectId: "local-dev" });
  } finally {
    await close();
  }
});

test("ends the stream with an error line when the resume fails", async () => {
  const { base, close } = await startServer({
    resumeSession: async () => {
      throw new Error("workspace already exists");
    }
  });
  try {
    const response = await post(base, SESSION_ID, { message: "x" });
    assert.equal(response.status, 200);
    assert.deepEqual((await readLines(response)).at(-1), { type: "error", message: "workspace already exists" });
  } finally {
    await close();
  }
});

test("rejects unauthenticated, invalid and unknown requests before streaming", async () => {
  const { base, close } = await startServer();
  try {
    assert.equal((await post(base, SESSION_ID, { message: "x" }, {})).status, 401);
    assert.equal((await post(base, SESSION_ID, { message: "x" }, { Authorization: "Bearer wrong" })).status, 401);
    assert.equal((await post(base, "not-a-uuid", { message: "x" })).status, 400);
    assert.equal((await post(base, SESSION_ID, {})).status, 400);
    assert.equal((await post(base, SESSION_ID, "{not json")).status, 400);
    assert.equal((await post(base, SESSION_ID, { message: "x", push: "yes" })).status, 400);
    assert.equal((await post(base, SESSION_ID, { message: "x".repeat(33 * 1024) })).status, 413);
    assert.equal((await post(base, "00000000-0000-0000-0000-000000000000", { message: "x" })).status, 404);

    const get = await fetch(`${base}/api/sessions/${SESSION_ID}/resume`, { headers: auth });
    assert.equal(get.status, 405);
    assert.deepEqual(await get.json(), { error: "Method not allowed" });
  } finally {
    await close();
  }
});

test("returns 503 when no secret is configured", async () => {
  const { base, close } = await startServer({ env: {} });
  try {
    assert.equal((await post(base, SESSION_ID, { message: "x" })).status, 503);
  } finally {
    await close();
  }
});

test("allows one resume per session at a time", async () => {
  let release;
  const blocked = new Promise((resolve) => (release = resolve));
  const { base, close } = await startServer({
    resumeSession: async () => {
      await blocked;
      return { sessionId: SESSION_ID };
    }
  });
  try {
    const first = post(base, SESSION_ID, { message: "first" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await post(base, SESSION_ID, { message: "second" });
    assert.equal(second.status, 409);
    release();
    assert.equal((await first).status, 200);
    await (await first).text();
    // Free again once the first resume finished.
    assert.equal((await post(base, SESSION_ID, { message: "third" })).status, 200);
  } finally {
    await close();
  }
});

test("sends heartbeats while the agent is working", async () => {
  const { base, close } = await startServer({
    heartbeatMs: 20,
    resumeSession: async () => {
      await new Promise((resolve) => setTimeout(resolve, 90));
      return { sessionId: SESSION_ID };
    }
  });
  try {
    const lines = await readLines(await post(base, SESSION_ID, { message: "x" }));
    assert.ok(lines.filter((l) => l.type === "heartbeat").length >= 2);
    assert.equal(lines.at(-1).type, "result");
  } finally {
    await close();
  }
});

test("leaves other routes to the caller", async () => {
  const { base, close } = await startServer();
  try {
    const response = await fetch(`${base}/api/health`);
    assert.equal(await response.text(), "not handled");
  } finally {
    await close();
  }
});

// ── GET /api/sessions and GET /api/sessions/:id/logs ─────────────────────────

function getLogs(base, id, headers = auth, query = "") {
  return fetch(`${base}/api/sessions/${id}/logs${query}`, { headers });
}

// Parses an SSE body into [{ id, event, data }] (comments and the retry hint are skipped).
function parseSse(text) {
  return text
    .split("\n\n")
    .map((block) => {
      const frame = {};
      for (const line of block.split("\n")) {
        const [, field, value] = /^(id|event|data): (.*)$/.exec(line) || [];
        if (field) frame[field] = field === "data" ? JSON.parse(value) : value;
      }
      return frame;
    })
    .filter((frame) => frame.event);
}

test("replays an ended session's logs over SSE and closes", async () => {
  const logBus = createSessionLogBus();
  logBus.startRun(SESSION_ID, { kind: "implementation", branchName: "ai/us-1-r1" });
  logBus.append(SESSION_ID, { level: "info", event: "[sample] Pushing branch 'ai/us-1-r1'..." });
  logBus.endRun(SESSION_ID, { outcome: "implemented" });
  const { base, close } = await startServer({ logBus });
  try {
    const response = await getLogs(base, SESSION_ID);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const frames = parseSse(await response.text());
    assert.deepEqual(frames.map((f) => `${f.id}:${f.event}`), ["1:run", "2:log", "3:end"]);
    assert.equal(frames[1].data.event, "[sample] Pushing branch 'ai/us-1-r1'...");
    assert.equal(frames[2].data.outcome, "implemented");

    const resumed = parseSse(await (await getLogs(base, SESSION_ID, { ...auth, "Last-Event-ID": "2" })).text());
    assert.deepEqual(resumed.map((f) => f.id), ["3"]);
    const after = parseSse(await (await getLogs(base, SESSION_ID, auth, "?after=1")).text());
    assert.deepEqual(after.map((f) => f.id), ["2", "3"]);
  } finally {
    await close();
  }
});

test("streams live frames of a running session until it ends", async () => {
  const logBus = createSessionLogBus();
  logBus.startRun(SESSION_ID, { kind: "resume" });
  const { base, close } = await startServer({ logBus, heartbeatMs: 10 });
  try {
    const response = await getLogs(base, SESSION_ID);
    const textPromise = response.text();
    await new Promise((resolve) => setTimeout(resolve, 40));
    logBus.append(SESSION_ID, { level: "info", event: "aca_claude_worker_cli_event", data: { type: "assistant" } });
    logBus.endRun(SESSION_ID, { outcome: "completed" });
    const text = await textPromise;
    assert.match(text, /^: ping$/m, "heartbeats keep the stream alive");
    assert.deepEqual(parseSse(text).map((f) => f.event), ["run", "log", "end"]);
  } finally {
    await close();
  }
});

test("reports frames that fell out of the buffer", async () => {
  const logBus = createSessionLogBus({ maxLines: 2 });
  logBus.startRun(SESSION_ID, { kind: "resume" });
  logBus.append(SESSION_ID, { level: "info", event: "a" });
  logBus.endRun(SESSION_ID);
  const { base, close } = await startServer({ logBus });
  try {
    const frames = parseSse(await (await getLogs(base, SESSION_ID)).text());
    assert.deepEqual(frames.map((f) => f.event), ["gap", "log", "end"]);
    assert.deepEqual(frames[0].data, { dropped: 1 });
  } finally {
    await close();
  }
});

test("rejects log requests that are unauthenticated, invalid or unknown", async () => {
  const { base, close } = await startServer();
  try {
    assert.equal((await getLogs(base, SESSION_ID, {})).status, 401);
    assert.equal((await getLogs(base, "not-a-uuid")).status, 400);
    assert.equal((await getLogs(base, SESSION_ID)).status, 404);
    assert.equal((await getLogs(base, SESSION_ID, auth, "?after=-1")).status, 400);
    const post = await fetch(`${base}/api/sessions/${SESSION_ID}/logs`, { method: "POST", headers: auth });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET");
  } finally {
    await close();
  }
});

test("lists sessions with live logs", async () => {
  const logBus = createSessionLogBus();
  logBus.startRun(SESSION_ID, { kind: "implementation", workItemId: 2, repoName: "sample", branchName: "ai/us-2-r1" });
  const { base, close } = await startServer({ logBus });
  try {
    assert.equal((await fetch(`${base}/api/sessions`)).status, 401);
    const response = await fetch(`${base}/api/sessions`, { headers: auth });
    assert.equal(response.status, 200);
    const { sessions } = await response.json();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, SESSION_ID);
    assert.equal(sessions[0].state, "running");
    assert.equal(sessions[0].branchName, "ai/us-2-r1");
  } finally {
    await close();
  }
});

test("refuses to resume a session whose run is still going", async () => {
  const logBus = createSessionLogBus();
  logBus.startRun(SESSION_ID, { kind: "implementation" });
  const { base, close } = await startServer({ logBus });
  try {
    assert.equal((await post(base, SESSION_ID, { message: "x" })).status, 409);
    logBus.endRun(SESSION_ID);
    assert.equal((await post(base, SESSION_ID, { message: "x" })).status, 200);
  } finally {
    await close();
  }
});
