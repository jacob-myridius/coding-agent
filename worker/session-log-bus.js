import { AsyncLocalStorage } from "node:async_hooks";
import { inspect } from "node:util";

// Per-session live log buffer. A run (implementation or resume) is wrapped in runInSessionScope;
// with installConsoleTap active, every console.* call made anywhere inside that async scope is
// also appended to the session's ring buffer, where GET /api/sessions/:id/logs (session-http.js)
// replays and streams it. Stdout logging is unchanged.
//
// Frames: { seq, ts, type: "run" | "log" | "end", ... }
//   run  { kind, workItemId?, repoName?, branchName? }  a run started on the session
//   log  { level, event?, data? }                          one console call
//   end  { outcome }                                       the run finished

const MAX_LINE_CHARS = 16 * 1024;
const scope = new AsyncLocalStorage();
const TAPPED = Symbol.for("myridius.sessionLogTap");

export function createSessionLogBus({ maxLines, retainMs, now = () => Date.now(), env = process.env } = {}) {
  const lineLimit = maxLines ?? positiveInt(env.SESSION_LOG_MAX_LINES, 5000);
  const retention = retainMs ?? positiveInt(env.SESSION_LOG_RETAIN_MINUTES, 60) * 60_000;
  const sessions = new Map();

  function prune() {
    const t = now();
    for (const [id, session] of sessions) {
      if (session.state === "ended" && t - session.endedAtMs >= retention) sessions.delete(id);
    }
  }

  function push(session, frame) {
    const full = { seq: session.nextSeq++, ts: new Date(now()).toISOString(), ...frame };
    session.frames.push(full);
    if (session.frames.length > lineLimit) session.frames.shift();
    for (const listener of session.listeners) {
      try {
        listener(full);
      } catch {
        // A broken subscriber must never affect the run or other subscribers.
      }
    }
    return full;
  }

  function summary(session) {
    const { kind, workItemId, repoName, branchName } = session.meta;
    return {
      sessionId: session.id,
      state: session.state,
      kind,
      workItemId,
      repoName,
      branchName,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      outcome: session.outcome,
      lines: session.nextSeq - 1
    };
  }

  return {
    startRun(sessionId, meta = {}) {
      prune();
      let session = sessions.get(sessionId);
      if (!session) {
        session = { id: sessionId, frames: [], nextSeq: 1, listeners: new Set(), meta: {} };
        sessions.set(sessionId, session);
      }
      session.state = "running";
      session.meta = { ...session.meta, ...meta };
      session.startedAt = new Date(now()).toISOString();
      session.endedAt = undefined;
      session.endedAtMs = undefined;
      session.outcome = undefined;
      push(session, { type: "run", ...meta });
    },

    annotate(sessionId, meta) {
      const session = sessions.get(sessionId);
      if (session) session.meta = { ...session.meta, ...meta };
    },

    append(sessionId, { level, event, data }) {
      const session = sessions.get(sessionId);
      if (session) push(session, { type: "log", level, event, data });
    },

    endRun(sessionId, { outcome = "completed" } = {}) {
      const session = sessions.get(sessionId);
      if (!session || session.state !== "running") return;
      session.state = "ended";
      session.endedAtMs = now();
      session.endedAt = new Date(session.endedAtMs).toISOString();
      session.outcome = outcome;
      push(session, { type: "end", outcome });
      session.listeners.clear();
    },

    /**
     * Returns null for an unknown session. Otherwise the buffered frames after `afterSeq`, how many
     * requested frames were already dropped from the ring buffer, and whether the run is still going.
     * The listener only receives live frames while the session is running.
     */
    subscribe(sessionId, { afterSeq = 0 } = {}, listener) {
      prune();
      const session = sessions.get(sessionId);
      if (!session) return null;
      const firstSeq = session.frames[0]?.seq ?? session.nextSeq;
      const gap = Math.max(0, firstSeq - 1 - afterSeq);
      const replay = session.frames.filter((frame) => frame.seq > afterSeq);
      const running = session.state === "running";
      if (running && listener) session.listeners.add(listener);
      return { replay, gap, running, unsubscribe: () => session.listeners.delete(listener) };
    },

    isRunning(sessionId) {
      return sessions.get(sessionId)?.state === "running";
    },

    get(sessionId) {
      prune();
      const session = sessions.get(sessionId);
      return session ? summary(session) : null;
    },

    list() {
      prune();
      return [...sessions.values()]
        .map(summary)
        .sort((a, b) => (a.state === b.state ? b.startedAt.localeCompare(a.startedAt) : a.state === "running" ? -1 : 1));
    }
  };
}

export const sessionLogBus = createSessionLogBus();

/**
 * Runs `fn` as one run of `sessionId`: console output inside it (including from callbacks and child
 * process handlers created inside it) is captured by the tap. The outcome is the result's
 * `category[:reasonCode]` when it has one (processWorkItem results), "completed" otherwise.
 */
export async function runInSessionScope(sessionId, meta, fn, bus = sessionLogBus) {
  bus.startRun(sessionId, meta);
  let outcome = "completed";
  try {
    const result = await scope.run({ sessionId, bus }, fn);
    if (typeof result?.category === "string") outcome = [result.category, result.reasonCode].filter(Boolean).join(":");
    return result;
  } catch (error) {
    outcome = `failed: ${error?.message ?? error}`;
    throw error;
  } finally {
    bus.endRun(sessionId, { outcome });
  }
}

/** Copies console.log/info/warn/error calls made inside a session scope into that session's buffer. */
export function installConsoleTap(target = console) {
  if (target[TAPPED]) return;
  target[TAPPED] = true;
  let busy = false;
  for (const [method, level] of [["log", "info"], ["info", "info"], ["warn", "warn"], ["error", "error"]]) {
    const original = target[method].bind(target);
    target[method] = (...args) => {
      original(...args);
      const store = scope.getStore();
      if (!store || busy) return;
      busy = true;
      try {
        store.bus.append(store.sessionId, toLogLine(level, args));
      } catch {
        // Never let log capture break the caller.
      } finally {
        busy = false;
      }
    };
  }
}

export function toLogLine(level, args) {
  const event = typeof args[0] === "string" ? args[0] : undefined;
  const rest = event === undefined ? args : args.slice(1);
  const data = rest.length === 0 ? undefined : rest.length === 1 ? jsonSafe(rest[0]) : rest.map(jsonSafe);
  const serialized = redactCredentials(JSON.stringify({ event, data }));
  if (serialized.length > MAX_LINE_CHARS) {
    return { level, event: event && redactCredentials(event).slice(0, 512), data: { truncated: true, preview: serialized.slice(0, MAX_LINE_CHARS) } };
  }
  return { level, ...JSON.parse(serialized) };
}

// Clone URLs carry tokens (https://oauth2:<token>@github.com/...) and git errors echo them.
export function redactCredentials(text) {
  return String(text)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@"'\\]+@/gi, "$1***@")
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1***");
}

function jsonSafe(value) {
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return String(value);
  try {
    return JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v instanceof Error ? v.message : v)));
  } catch {
    return inspect(value, { depth: 4, breakLength: Infinity });
  }
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
