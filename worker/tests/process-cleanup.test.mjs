import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { killWorkspaceProcesses, removeWorkspace, selectLeftoverProcesses } from "../process-cleanup.js";

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test("kills a background process the CLI left running in the workspace", async () => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), "myridius-worker-orphan-"));
  const startedAt = Date.now();
  try {
    // Like the agent's `node src/server.js &`: a parent starts a detached child in the
    // workspace, prints its pid, and exits, leaving the child orphaned.
    const parent = spawn(
      process.execPath,
      [
        "-e",
        "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',cwd:process.cwd()});c.unref();console.log(c.pid)"
      ],
      { cwd: workspacePath, stdio: ["ignore", "pipe", "inherit"] }
    );
    let out = "";
    parent.stdout.on("data", (d) => (out += d));
    await new Promise((resolve) => parent.on("close", resolve));
    const orphanPid = Number(out.trim());
    assert.ok(orphanPid > 0 && isAlive(orphanPid), "orphan is running after its parent exited");

    const killed = await killWorkspaceProcesses({ workspacePath, rootPid: parent.pid, startedAt });

    assert.ok(killed.some((p) => p.pid === orphanPid), `orphan ${orphanPid} reported as killed`);
    assert.ok(await waitFor(() => !isAlive(orphanPid)), "orphan is gone");
    assert.equal(await removeWorkspace(workspacePath), true, "workspace can be deleted afterwards");
  } finally {
    await rm(workspacePath, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
});

test("selects descendants of the CLI and processes pointing into the workspace only", () => {
  const ws = "C:\\Temp\\myridius-worker-abc";
  const procs = [
    { pid: 10, ppid: 1, startedAt: 100000, command: "node cli.mjs" },
    { pid: 11, ppid: 10, startedAt: 102000, command: "bash -c 'PORT=3011 node src/server.js'" },
    { pid: 12, ppid: 11, startedAt: 102000, command: "node src/server.js" },
    { pid: 13, ppid: 10, startedAt: 50000, command: "reused pid, older than the CLI" },
    { pid: 20, ppid: 1, command: "node C:/Temp/myridius-worker-abc/src/server.js" },
    { pid: 21, ppid: 1, command: "node other.js", cwd: "/tmp/myridius-worker-abc/sub" },
    { pid: 30, ppid: 1, command: "node C:/Temp/myridius-worker-abcdef/x.js" },
    { pid: 99, ppid: 1, command: `node C:/Temp/myridius-worker-abc/self.js` }
  ];
  const selected = selectLeftoverProcesses(procs, { workspacePath: ws, rootPid: 10, startedAt: 100000, selfPid: 99 })
    .map((p) => p.pid)
    .sort((a, b) => a - b);
  assert.deepEqual(selected, [11, 12, 20]);

  const linux = selectLeftoverProcesses(procs, { workspacePath: "/tmp/myridius-worker-abc", selfPid: 99 }).map((p) => p.pid);
  assert.deepEqual(linux, [21]);
});

test("removeWorkspace never throws, so cleanup cannot fail a successful run", async () => {
  const busy = Object.assign(new Error("EBUSY: resource busy or locked, rmdir 'x'"), { code: "EBUSY" });
  assert.equal(await removeWorkspace("x", { rmImpl: async () => { throw busy; } }), false);
});
