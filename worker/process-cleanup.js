import { execFile } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Kills processes the CLI left running after it exited (e.g. a dev server the agent started
 * with `&` to try its endpoints). Left alive they leak in the container, and on Windows they
 * also lock the workspace so it cannot be deleted (EBUSY).
 *
 * A process is considered left behind when it:
 * - descends from the CLI process (`rootPid`) and was started after the CLI (`startedAt`), or
 * - has the workspace in its command line, or (Linux) as its working directory.
 *
 * Never throws; returns the processes it killed.
 *
 * @param {{ workspacePath: string, rootPid?: number, startedAt?: number }} options
 * @returns {Promise<Array<{ pid: number, command: string }>>}
 */
export async function killWorkspaceProcesses({ workspacePath, rootPid, startedAt }) {
  try {
    const processes = process.platform === "win32" ? await listWindowsProcesses() : await listProcfsProcesses();
    const targets = selectLeftoverProcesses(processes, { workspacePath, rootPid, startedAt, selfPid: process.pid });
    for (const target of targets) {
      await killProcess(target.pid);
    }
    return targets.map(({ pid, command }) => ({ pid, command: command.slice(0, 200) }));
  } catch (error) {
    console.log("aca_claude_worker_process_cleanup_failed", { workspacePath, error: error.message });
    return [];
  }
}

/**
 * @param {Array<{ pid: number, ppid: number, startedAt?: number, command: string, cwd?: string }>} processes
 */
export function selectLeftoverProcesses(processes, { workspacePath, rootPid, startedAt, selfPid }) {
  const normalize = (value) => String(value || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const workspace = normalize(workspacePath);
  const byParent = new Map();
  for (const proc of processes) {
    if (!byParent.has(proc.ppid)) byParent.set(proc.ppid, []);
    byParent.get(proc.ppid).push(proc);
  }

  const selected = new Map();
  // Descendants of the CLI. Windows keeps the (dead) parent's pid on orphans, so the tree is
  // still walkable after the CLI exits; the start-time check guards against reused pids.
  if (rootPid) {
    const queue = [rootPid];
    while (queue.length > 0) {
      for (const child of byParent.get(queue.shift()) || []) {
        if (selected.has(child.pid)) continue;
        if (startedAt && child.startedAt && child.startedAt < startedAt - 1000) continue;
        selected.set(child.pid, child);
        queue.push(child.pid);
      }
    }
  }
  // Anything still pointing into the workspace (covers Linux, where orphans are re-parented to init).
  if (workspace) {
    for (const proc of processes) {
      const cwd = normalize(proc.cwd);
      if (mentionsPath(normalize(proc.command), workspace) || cwd === workspace || cwd.startsWith(`${workspace}/`)) {
        selected.set(proc.pid, proc);
      }
    }
  }

  selected.delete(selfPid);
  selected.delete(rootPid);
  return [...selected.values()];
}

/** True when `text` contains `dir` as a whole path (not as a prefix of a sibling like `dir-other`). */
function mentionsPath(text, dir) {
  for (let i = text.indexOf(dir); i !== -1; i = text.indexOf(dir, i + 1)) {
    const next = text[i + dir.length];
    if (next === undefined || !/[a-z0-9._-]/.test(next)) return true;
  }
  return false;
}

async function listWindowsProcesses() {
  const script =
    "Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; " +
    "started = if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }; " +
    "command = [string]$_.CommandLine } } | ConvertTo-Json -Compress";
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  });
  const parsed = JSON.parse(stdout || "[]");
  return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({
    pid: Number(p.pid),
    ppid: Number(p.ppid),
    startedAt: Number(p.started) || undefined,
    command: p.command || ""
  }));
}

async function listProcfsProcesses() {
  const entries = await readdir("/proc").catch(() => []);
  const processes = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const dir = path.join("/proc", entry);
    try {
      const [stat, cmdline, cwd] = await Promise.all([
        readFile(path.join(dir, "stat"), "utf8"),
        readFile(path.join(dir, "cmdline"), "utf8"),
        readlink(path.join(dir, "cwd")).catch(() => "")
      ]);
      // stat: "pid (comm) state ppid ..." — comm may contain spaces, so split after the last ')'
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      processes.push({ pid: Number(entry), ppid, command: cmdline.replace(/\0/g, " ").trim(), cwd });
    } catch {
      // process exited while scanning
    }
  }
  return processes;
}

async function killProcess(pid) {
  try {
    if (process.platform === "win32") {
      await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // already gone
  }
}

/**
 * Deletes a workspace without ever throwing: a failed cleanup must not turn a successful run
 * into a failed one. Retries cover transient Windows locks (EBUSY/EPERM) right after processes exit.
 */
export async function removeWorkspace(workspacePath, { rmImpl } = {}) {
  const remove = rmImpl || (await import("node:fs/promises")).rm;
  try {
    await remove(workspacePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    return true;
  } catch (error) {
    console.log("aca_claude_worker_workspace_cleanup_failed", { workspacePath, error: error.message });
    return false;
  }
}
