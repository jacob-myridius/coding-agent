import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the myridius CLI path relative to this file so it works regardless
// of where the worker is installed (/app/worker/node_modules in the container).
const __dirname = dirname(fileURLToPath(import.meta.url));
const MYRIDIUS_CLI_PATH = join(__dirname, "node_modules", "myridius", "dist", "cli.mjs");

export async function runMyridiusImplementation({ workspacePath, prompt }) {
  const promptFile = join(workspacePath, "IMPLEMENTATION_PROMPT.md");
  await writeFile(promptFile, `${prompt}\n`, "utf8");

  const { bin, args } = buildMyridiusCliInvocation(process.env);
  console.log("aca_claude_worker_cli_invocation", { bin, args });

  await runProcess(bin, args, {
    cwd: workspacePath,
    env: buildCliEnv(process.env),
    stdinFile: promptFile,
    streamLineLogs: parseBooleanFlag(process.env.MYRIDIUS_CLI_STREAM_LINE_LOGS, true)
  });
}

export function buildMyridiusCliInvocation(env) {
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

  const bin = "node";
  const args = [MYRIDIUS_CLI_PATH, "--print"];
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
  mapped.MYRIDIUS_CONFIG_DIR = mapped.MYRIDIUS_CONFIG_DIR || mapped.CLAUDE_CONFIG_DIR || "/app/config";

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

function runProcess(bin, args, options) {
  return new Promise((resolve, reject) => {
    const streamLineLogs = Boolean(options.streamLineLogs);
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false
    });

    const forwardStdout = createLineForwarder("aca_claude_worker_cli_stdout_line", streamLineLogs, process.stdout);
    const forwardStderr = createLineForwarder("aca_claude_worker_cli_stderr_line", streamLineLogs, process.stderr);

    child.stdout.on("data", (chunk) => forwardStdout(chunk));
    child.stderr.on("data", (chunk) => forwardStderr(chunk));

    import("node:fs").then((fs) => {
      const input = fs.createReadStream(options.stdinFile);
      input.pipe(child.stdin);
    }).catch((error) => {
      reject(error);
    });

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

function createLineForwarder(tag, streamLineLogs, fallbackStream) {
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
      console.log(tag, { line });
    }
  };

  writeChunk.flush = () => {
    if (!streamLineLogs) {
      return;
    }
    const tail = buffer.trim();
    if (tail.length > 0) {
      console.log(tag, { line: tail });
    }
    buffer = "";
  };

  return writeChunk;
}



