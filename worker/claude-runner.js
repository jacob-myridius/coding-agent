import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { killWorkspaceProcesses } from "./process-cleanup.js";
import { resolveMyridiusConfigDir, writeSessionManifest } from "./session-manifest.js";

// Resolve the myridius CLI path relative to this file so it works regardless
// of where the worker is installed (/app/worker/node_modules in the container).
const __dirname = dirname(fileURLToPath(import.meta.url));
export const MYRIDIUS_CLI_PATH = join(__dirname, "node_modules", "myridius", "dist", "cli.mjs");

const OUTPUT_FORMATS = new Set(["text", "json", "stream-json"]);
const DEFAULT_LOG_MAX_CHARS = 2000;

/**
 * Runs the myridius CLI in `workspacePath`.
 * - New run: pass `sessionId` (or let one be generated) and optionally `sessionManifest`,
 *   which is saved next to the CLI's transcripts so the session can be resumed later.
 * - Resume: pass `resumeSessionId`; the CLI continues that conversation (`--resume`).
 * `onEvent(summary)` receives each summarized stream-json event (the same object that is logged).
 */
export async function runMyridiusImplementation({ workspacePath, prompt, sessionId, resumeSessionId, sessionManifest, onEvent }) {
  const resuming = Boolean(resumeSessionId);
  // Pre-assigning the session id means it is known (and logged) even if the CLI fails
  // before emitting its init event, and the run can later be continued with --resume.
  const session = { id: resumeSessionId || sessionId || randomUUID() };

  let stdinFile;
  if (!resuming) {
    stdinFile = join(workspacePath, "IMPLEMENTATION_PROMPT.md");
    await writeFile(stdinFile, `${prompt}
`, "utf8");
  }

  if (sessionManifest && !resuming) {
    await writeSessionManifest({ ...sessionManifest, sessionId: session.id, workspacePath }, process.env).catch((error) =>
      console.log("aca_claude_worker_session_manifest_write_failed", { sessionId: session.id, error: error.message })
    );
  }

  const { bin, args } = buildMyridiusCliInvocation(
    process.env,
    resuming ? { resumeSessionId: session.id } : { sessionId: session.id }
  );
  console.log("aca_claude_worker_cli_invocation", { sessionId: session.id, resumed: resuming, workspacePath, bin, args });

  const cli = { pid: undefined, startedAt: Date.now() };
  try {
    await runProcess(bin, args, {
      onSpawn: (pid) => { cli.pid = pid; },
      cwd: workspacePath,
      env: buildCliEnv(process.env),
      stdinFile,
      stdinText: resuming ? `${prompt}
` : undefined,
      streamLineLogs: parseBooleanFlag(process.env.MYRIDIUS_CLI_STREAM_LINE_LOGS, true),
      parseStreamJson: args.includes("stream-json"),
      logMaxChars: parsePositiveInt(process.env.MYRIDIUS_CLI_LOG_MAX_CHARS, DEFAULT_LOG_MAX_CHARS),
      session,
      onEvent
    });
  } catch (error) {
    error.sessionId = session.id;
    console.log("aca_claude_worker_cli_failed", { sessionId: session.id, error: error.message });
    throw error;
  } finally {
    // The agent may leave background processes (e.g. a dev server started with `&`) running.
    const killed = await killWorkspaceProcesses({ workspacePath, rootPid: cli.pid, startedAt: cli.startedAt });
    if (killed.length > 0) {
      console.log("aca_claude_worker_cli_orphans_killed", { sessionId: session.id, processes: killed });
    }
  }

  console.log("aca_claude_worker_cli_completed", { sessionId: session.id });
  return { sessionId: session.id };
}

export function buildMyridiusCliInvocation(env, { sessionId, resumeSessionId } = {}) {
  const explicitCommand = String(env.MYRIDIUS_CLI_COMMAND || "").trim();
  if (explicitCommand) {
    const [bin, ...args] = explicitCommand.split(/\s+/);
    return { bin, args };
  }

  const agent = String(env.MYRIDIUS_CLI_AGENT || "backend-specialist").trim();
  const fullAuto = parseBooleanFlag(env.MYRIDIUS_CLI_FULL_AUTO, true);
  const permissionMode = String(env.MYRIDIUS_CLI_PERMISSION_MODE || "").trim();
  const allowRootBypass = parseBooleanFlag(env.MYRIDIUS_CLI_ALLOW_ROOT_BYPASS, true);
  const dangerousSkipPermissions = parseBooleanFlag(env.MYRIDIUS_CLI_DANGEROUSLY_SKIP_PERMISSIONS, false);
  const runningAsRoot = isRunningAsRoot(env);
  const outputFormat = resolveOutputFormat(env.MYRIDIUS_CLI_OUTPUT_FORMAT);
  // stream-json in print mode requires --verbose, so it is forced on for that format.
  const verbose = outputFormat === "stream-json" || parseBooleanFlag(env.MYRIDIUS_CLI_VERBOSE, true);

  const bin = "node";
  const args = [MYRIDIUS_CLI_PATH, "-p"];
  if (verbose) {
    args.push("--verbose");
  }
  args.push("--output-format", outputFormat);
  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  } else if (sessionId) {
    args.push("--session-id", sessionId);
  }
  if (agent) {
    args.push("--agent", agent);
  }

  if (permissionMode) {
    args.push("--permission-mode", permissionMode);
    if (permissionMode === "bypassPermissions" && dangerousSkipPermissions && !runningAsRoot) {
      args.push("--dangerously-skip-permissions");
    }
  } else if (fullAuto && (!runningAsRoot || allowRootBypass)) {
    args.push("--permission-mode", "bypassPermissions");
    if (dangerousSkipPermissions && !runningAsRoot) {
      args.push("--dangerously-skip-permissions");
    }
  } else {
    // Safe fallback for environments that do not explicitly enable bypass.
    args.push("--permission-mode", "auto");
  }

  return { bin, args };
}

function resolveOutputFormat(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return OUTPUT_FORMATS.has(normalized) ? normalized : "stream-json";
}

function isRunningAsRoot(env) {
  if (typeof process.getuid === "function") {
    return process.getuid() === 0;
  }

  const user = String(env.USER || env.USERNAME || "").trim().toLowerCase();
  return user === "root";
}

function buildCliEnv(env) {
  const mapped = { ...env };

  // Keep worker config path consistent across local/container runs.
  // The CLI reads MYRIDIUS_CONFIG_DIR (not CLAUDE_CONFIG_DIR).
  mapped.MYRIDIUS_CONFIG_DIR = resolveMyridiusConfigDir(mapped);

  // Provide OpenAI aliases expected by the CLI if only MYRIDIUS_* values are set.
  mapped.OPENAI_API_KEY = mapped.OPENAI_API_KEY || mapped.MYRIDIUS_OPENAI_API_KEY || "";
  mapped.OPENAI_BASE_URL = mapped.OPENAI_BASE_URL || mapped.MYRIDIUS_OPENAI_MODEL_ENDPOINT || "";
  mapped.OPENAI_MODEL = mapped.OPENAI_MODEL || mapped.MYRIDIUS_OPENAI_DEPLOYMENT_NAME || "";

  // When an OpenAI-compatible endpoint is configured, tell the CLI to use
  // OpenAI-compatible mode. Without this the CLI defaults to Codex/GPT auth,
  // overrides OPENAI_MODEL with "codexplan", and exits with "Not logged in".
  if (mapped.OPENAI_BASE_URL && mapped.OPENAI_API_KEY && !mapped.MYRIDIUS_USE_OPENAI) {
    mapped.MYRIDIUS_USE_OPENAI = "1";
  }

  return mapped;
}

function parseBooleanFlag(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  return !(normalized === "0" || normalized === "false" || normalized === "no");
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function runProcess(bin, args, options) {
  return new Promise((resolve, reject) => {
    const streamLineLogs = Boolean(options.streamLineLogs);
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false
    });
    options.onSpawn?.(child.pid);

    const session = options.session;
    const forwardStdout = options.parseStreamJson
      ? createStreamJsonForwarder(options.logMaxChars, session, options.onEvent)
      : createLineForwarder("aca_claude_worker_cli_stdout_line", streamLineLogs, process.stdout, session);
    const forwardStderr = createLineForwarder("aca_claude_worker_cli_stderr_line", streamLineLogs, process.stderr, session);

    child.stdout.on("data", (chunk) => forwardStdout(chunk));
    child.stderr.on("data", (chunk) => forwardStderr(chunk));

    if (options.stdinText !== undefined) {
      child.stdin.end(options.stdinText);
    } else {
      import("node:fs").then((fs) => {
        const input = fs.createReadStream(options.stdinFile);
        input.pipe(child.stdin);
      }).catch((error) => {
        reject(error);
      });
    }

    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      forwardStdout.flush();
      forwardStderr.flush();
      if (code === 0) {
        resolve(undefined);
        return;
      }
      reject(new Error(`Myridius CLI exited with code ${code}`));
    });
  });
}

function createLineForwarder(tag, streamLineLogs, fallbackStream, session) {
  let buffer = "";

  const writeChunk = (chunk) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (!streamLineLogs) {
      fallbackStream.write(text);
      return;
    }

    buffer += text;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }
      console.log(tag, { sessionId: session.id, line });
    }
  };

  writeChunk.flush = () => {
    if (!streamLineLogs) {
      return;
    }
    const tail = buffer.trim();
    if (tail.length > 0) {
      console.log(tag, { sessionId: session.id, line: tail });
    }
    buffer = "";
  };

  return writeChunk;
}

// Parses the CLI's stream-json output (one JSON event per line) and logs a
// compact structured summary of each event so runs can be monitored live.
function createStreamJsonForwarder(maxChars, session, onEvent) {
  let buffer = "";

  const handleLine = (line) => {
    if (line.trim().length === 0) {
      return;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      console.log("aca_claude_worker_cli_stdout_line", { sessionId: session.id, line: truncate(line, maxChars) });
      return;
    }
    // With a custom MYRIDIUS_CLI_COMMAND the CLI picks its own id; adopt it from the stream.
    if (event?.session_id) {
      session.id = event.session_id;
    }
    const summary = { sessionId: session.id, ...summarizeStreamEvent(event, maxChars) };
    const tag = summary.type === "result" ? "aca_claude_worker_cli_result" : "aca_claude_worker_cli_event";
    console.log(tag, summary);
    try {
      onEvent?.(summary);
    } catch (error) {
      console.log("aca_claude_worker_cli_event_callback_failed", { sessionId: session.id, error: error.message });
    }
  };

  const writeChunk = (chunk) => {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    lines.forEach(handleLine);
  };

  writeChunk.flush = () => {
    handleLine(buffer);
    buffer = "";
  };

  return writeChunk;
}

export function summarizeStreamEvent(event, maxChars = DEFAULT_LOG_MAX_CHARS) {
  const type = event?.type || "unknown";
  const base = { type };
  if (event?.subtype) {
    base.subtype = event.subtype;
  }
  if (event?.session_id) {
    base.sessionId = event.session_id;
  }

  if (type === "system" && event.subtype === "init") {
    return {
      ...base,
      model: event.model,
      cwd: event.cwd,
      permissionMode: event.permissionMode,
      tools: Array.isArray(event.tools) ? event.tools.length : undefined,
      mcpServers: Array.isArray(event.mcp_servers)
        ? event.mcp_servers.map((server) => `${server.name}:${server.status}`)
        : undefined
    };
  }

  if (type === "system") {
    // Other system events (api_retry, compact_boundary, ...) carry their details as
    // top-level fields, e.g. attempt / error_status / error / retry_delay_ms.
    const details = {};
    for (const [key, value] of Object.entries(event)) {
      if (["type", "subtype", "session_id", "uuid"].includes(key)) {
        continue;
      }
      details[key] = typeof value === "object" && value !== null
        ? truncate(JSON.stringify(value), maxChars)
        : truncate(value, maxChars);
    }
    return { ...base, ...details };
  }

  if (type === "assistant" || type === "user") {
    const content = Array.isArray(event.message?.content) ? event.message.content : [];
    return { ...base, content: content.map((block) => summarizeContentBlock(block, maxChars)) };
  }

  if (type === "result") {
    return {
      ...base,
      isError: Boolean(event.is_error),
      numTurns: event.num_turns,
      durationMs: event.duration_ms,
      durationApiMs: event.duration_api_ms,
      totalCostUsd: event.total_cost_usd,
      usage: event.usage,
      result: truncate(event.result, maxChars)
    };
  }

  return base;
}

function summarizeContentBlock(block, maxChars) {
  switch (block?.type) {
    case "text":
      return { type: "text", text: truncate(block.text, maxChars) };
    case "thinking":
      return { type: "thinking", text: truncate(block.thinking, maxChars) };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: truncate(JSON.stringify(block.input), maxChars) };
    case "tool_result":
      return {
        type: "tool_result",
        toolUseId: block.tool_use_id,
        isError: Boolean(block.is_error),
        content: truncate(typeof block.content === "string" ? block.content : JSON.stringify(block.content), maxChars)
      };
    default:
      return { type: block?.type || "unknown" };
  }
}

function truncate(value, maxChars) {
  if (typeof value !== "string") {
    return value;
  }
  return value.length > maxChars ? `${value.slice(0, maxChars)}... [${value.length - maxChars} more chars]` : value;
}
