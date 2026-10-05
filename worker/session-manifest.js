import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

// Worker-side metadata about a CLI session (repo, branch, workspace path, ...), stored next to
// the CLI's own transcripts in MYRIDIUS_CONFIG_DIR so both travel together. Never holds credentials.
const MANIFEST_DIR_NAME = "worker-sessions";
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveMyridiusConfigDir(env = process.env) {
  // The CLI reads MYRIDIUS_CONFIG_DIR (not CLAUDE_CONFIG_DIR).
  return env.MYRIDIUS_CONFIG_DIR || env.CLAUDE_CONFIG_DIR || "/app/config";
}

export function assertSessionId(sessionId) {
  if (!SESSION_ID_PATTERN.test(String(sessionId || ""))) {
    throw new Error(`Invalid session id '${sessionId}': expected a UUID`);
  }
}

/** Removes credentials embedded in a clone URL (e.g. https://oauth2:<token>@github.com/...). */
export function stripCredentials(repoUrl) {
  try {
    const url = new URL(repoUrl);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return String(repoUrl || "").replace(/\/\/[^@/]+@/, "//");
  }
}

/** Adds credentials to a clean https clone URL. */
export function withCredentials(repoUrl, username, password) {
  const url = new URL(repoUrl);
  url.username = encodeURIComponent(username);
  url.password = encodeURIComponent(password);
  return url.toString();
}

export async function writeSessionManifest(manifest, env = process.env) {
  assertSessionId(manifest.sessionId);
  const dir = join(resolveMyridiusConfigDir(env), MANIFEST_DIR_NAME);
  await mkdir(dir, { recursive: true });
  const record = {
    ...manifest,
    repoUrl: manifest.repoUrl ? stripCredentials(manifest.repoUrl) : undefined,
    createdAt: manifest.createdAt || new Date().toISOString()
  };
  await writeFile(join(dir, `${manifest.sessionId}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

export async function readSessionManifest(sessionId, env = process.env) {
  assertSessionId(sessionId);
  try {
    const raw = await readFile(join(resolveMyridiusConfigDir(env), MANIFEST_DIR_NAME, `${sessionId}.json`), "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Finds the CLI transcript (<config>/projects/<cwd-slug>/<sessionId>.jsonl) for a session. */
export async function findSessionTranscript(sessionId, env = process.env) {
  assertSessionId(sessionId);
  const projectsDir = join(resolveMyridiusConfigDir(env), "projects");
  let entries;
  try {
    entries = await readdir(projectsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(projectsDir, entry.name, `${sessionId}.jsonl`);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // not in this project directory
    }
  }
  return null;
}

/**
 * Reads the working directory and git branch the CLI recorded in a transcript.
 * The CLI only finds a session from the same cwd, so this cwd is where a resume must run.
 */
export async function readTranscriptContext(transcriptPath) {
  const lines = createInterface({ input: createReadStream(transcriptPath, "utf8"), crlfDelay: Infinity });
  const context = {};
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!context.cwd && record.cwd) context.cwd = record.cwd;
      if (!context.gitBranch && record.gitBranch && record.gitBranch !== "HEAD") context.gitBranch = record.gitBranch;
      if (context.cwd && context.gitBranch) break;
    }
  } finally {
    lines.close();
  }
  return context;
}
