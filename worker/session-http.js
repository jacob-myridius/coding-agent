import { createHash, timingSafeEqual } from "node:crypto";
import { resumeSession as defaultResumeSession } from "./resume-session.js";
import { assertSessionId, findSessionTranscript as defaultFindSessionTranscript } from "./session-manifest.js";
import { sessionLogBus } from "./session-log-bus.js";

// Session routes on the worker's HTTP server, all authenticated with the same AGENT_CALLBACK_SECRET
// the worker uses with the credential broker (Authorization: Bearer <secret>):
//
//   GET  /api/sessions                      sessions this worker has live logs for (JSON)
//   GET  /api/sessions/:sessionId/logs      every log line of the session's runs, replayed then live (SSE)
//   POST /api/sessions/:sessionId/resume    resume a CLI session with one follow-up message (NDJSON stream)
const LIST_ROUTE = /^\/api\/sessions\/?$/;
const SESSION_ROUTE = /^\/api\/sessions\/([^/]+)\/(resume|logs)\/?$/;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGE_CHARS = 32 * 1024;
const HEARTBEAT_MS = 15_000;
const MAX_SSE_BUFFERED_BYTES = 1024 * 1024;
const OVERRIDE_KEYS = ["repoUrl", "branchName", "projectId", "provider"];

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * @returns {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<boolean>}
 *   resolves true when the request was handled, false when the route doesn't match.
 */
export function createSessionRequestHandler({
  env = process.env,
  resumeSession = defaultResumeSession,
  findSessionTranscript = defaultFindSessionTranscript,
  logBus = sessionLogBus,
  heartbeatMs = HEARTBEAT_MS
} = {}) {
  const activeResumes = new Set();

  return async function handleSessionRequest(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    if (LIST_ROUTE.test(url.pathname)) {
      return handle(req, res, { method: "GET", logTag: "aca_claude_worker_session_list_http" }, async () => {
        sendJson(res, 200, { sessions: logBus.list() });
        return { outcome: "listed", statusCode: 200 };
      });
    }

    const match = SESSION_ROUTE.exec(url.pathname);
    if (!match) return false;
    const [, rawId, action] = match;

    if (action === "logs") {
      return handle(req, res, { method: "GET", rawId, logTag: "aca_claude_worker_session_logs_http" }, (sessionId) =>
        streamLogs(req, res, url, sessionId)
      );
    }
    return handle(req, res, { method: "POST", rawId, logTag: "aca_claude_worker_resume_http_request" }, (sessionId) =>
      streamResume(req, res, sessionId)
    );
  };

  // Shared method/auth/session-id checks and error responses. `run` returns the fields to log.
  async function handle(req, res, { method, rawId, logTag }, run) {
    let sessionId = rawId;
    try {
      if (req.method !== method) {
        res.setHeader("Allow", method);
        throw new HttpError(405, "Method not allowed");
      }
      authorize(req, env);
      if (rawId !== undefined) {
        sessionId = decodeURIComponent(rawId);
        try {
          assertSessionId(sessionId);
        } catch (error) {
          throw new HttpError(400, error.message);
        }
      }
      const outcome = await run(sessionId);
      console.log(logTag, { ...(sessionId && { sessionId }), ...outcome });
    } catch (error) {
      const statusCode = error instanceof HttpError ? error.statusCode : 500;
      if (!res.headersSent) {
        sendJson(res, statusCode, { error: statusCode === 500 ? "Internal error" : error.message });
      } else {
        res.end();
      }
      console.log(logTag, {
        ...(sessionId && { sessionId }),
        outcome: "rejected",
        statusCode,
        ...(statusCode === 500 && { error: error.message })
      });
    }
    return true;
  }

  async function streamResume(req, res, sessionId) {
    const request = await readResumeRequest(req);
    // Also refuse while the session's original implementation run (or a CLI resume) is still going.
    if (activeResumes.has(sessionId) || logBus.isRunning(sessionId)) {
      throw new HttpError(409, `Session ${sessionId} is already running`);
    }
    activeResumes.add(sessionId);
    try {
      if (!(await findSessionTranscript(sessionId, env))) {
        throw new HttpError(404, `No transcript found for session ${sessionId}`);
      }

      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no"
      });
      const write = (frame) => {
        if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(frame)}\n`);
      };
      let clientDisconnected = false;
      res.on("close", () => {
        if (!res.writableFinished) clientDisconnected = true;
      });
      const heartbeat = setInterval(() => write({ type: "heartbeat" }), heartbeatMs);
      console.log("aca_claude_worker_resume_http_request", { sessionId, outcome: "started", statusCode: 200 });

      try {
        const result = await resumeSession({
          sessionId,
          prompt: request.message,
          push: request.push,
          overrides: request.overrides,
          hooks: {
            onStatus: (phase, detail) => write(phase === "session" ? { type: "session", ...detail } : { type: "status", phase }),
            onEvent: (event) => write({ type: "event", event })
          }
        });
        write({ type: "result", ...result });
        // The run is not cancelled when the client goes away: commits are still pushed and logs are complete.
        return { outcome: "completed", statusCode: 200, clientDisconnected };
      } catch (error) {
        write({ type: "error", message: error.message });
        return { outcome: "failed", statusCode: 200, clientDisconnected, error: error.message };
      } finally {
        clearInterval(heartbeat);
        res.end();
      }
    } finally {
      activeResumes.delete(sessionId);
    }
  }

  // Server-sent events: replay buffered frames after Last-Event-ID (or ?after=), then stream live
  // until the run ends. EventSource clients reconnect with Last-Event-ID automatically.
  async function streamLogs(req, res, url, sessionId) {
    const afterSeq = parseAfterSeq(req.headers["last-event-id"] ?? url.searchParams.get("after"));
    const startedAt = Date.now();
    let finish;
    const done = new Promise((resolve) => (finish = resolve));
    let closed = false;
    let heartbeat;
    let subscription;

    const close = (reason) => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      subscription?.unsubscribe();
      if (reason === "slow-client") res.destroy();
      else res.end();
      finish(reason);
    };
    const send = (text) => {
      if (closed || res.writableEnded || res.destroyed) return;
      if (!res.write(text) && res.writableLength > MAX_SSE_BUFFERED_BYTES) close("slow-client");
    };
    const sendFrame = (frame) => send(`id: ${frame.seq}\nevent: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);

    subscription = logBus.subscribe(sessionId, { afterSeq }, (frame) => {
      sendFrame(frame);
      if (frame.type === "end") close("ended");
    });
    if (!subscription) throw new HttpError(404, `No logs for session ${sessionId} on this worker (unknown or expired)`);

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    send("retry: 3000\n\n");
    if (subscription.gap > 0) send(`event: gap\ndata: ${JSON.stringify({ dropped: subscription.gap })}\n\n`);
    for (const frame of subscription.replay) sendFrame(frame);

    if (!subscription.running) {
      close("ended");
    } else {
      heartbeat = setInterval(() => send(": ping\n\n"), heartbeatMs);
      res.on("close", () => close("client-disconnected"));
    }
    const reason = await done;
    return { outcome: reason, statusCode: 200, replayed: subscription.replay.length, durationMs: Date.now() - startedAt };
  }
}

function parseAfterSeq(value) {
  if (value === undefined || value === null || value === "") return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new HttpError(400, "Last-Event-ID / 'after' must be a non-negative integer");
  return parsed;
}

function authorize(req, env) {
  const secret = env.AGENT_CALLBACK_SECRET;
  if (!secret) throw new HttpError(503, "Session endpoints are not configured (AGENT_CALLBACK_SECRET is not set)");
  if (!isAuthorized(req.headers.authorization, secret)) throw new HttpError(401, "Unauthorized");
}

function isAuthorized(header, secret) {
  const match = /^Bearer\s+(.+)$/i.exec(String(header || ""));
  if (!match) return false;
  // Hash both sides so the comparison is constant-time regardless of length.
  const digest = (value) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(match[1].trim()), digest(secret));
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "application/json", ...(statusCode >= 400 && { Connection: "close" }) });
  res.end(JSON.stringify(body));
}

async function readResumeRequest(req) {
  const body = await readJsonBody(req);
  const message = typeof body.message === "string" ? body.message : "";
  if (!message.trim()) throw new HttpError(400, "Body must include a non-empty 'message' string");
  if (message.length > MAX_MESSAGE_CHARS) throw new HttpError(413, `'message' exceeds ${MAX_MESSAGE_CHARS} characters`);
  if (body.push !== undefined && typeof body.push !== "boolean") throw new HttpError(400, "'push' must be a boolean");

  const overrides = {};
  if (body.overrides !== undefined) {
    if (typeof body.overrides !== "object" || body.overrides === null || Array.isArray(body.overrides)) {
      throw new HttpError(400, "'overrides' must be an object");
    }
    for (const key of OVERRIDE_KEYS) {
      const value = body.overrides[key];
      if (value === undefined) continue;
      if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `'overrides.${key}' must be a non-empty string`);
      overrides[key] = value.trim();
    }
  }

  return { message, push: body.push ?? true, overrides };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on("data", (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        reject(new HttpError(413, `Body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (rejected) return;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
        resolve(parsed);
      } catch {
        reject(new HttpError(400, "Body must be a JSON object"));
      }
    });
    req.on("error", (error) => {
      if (!rejected) reject(new HttpError(400, error.message));
    });
  });
}
