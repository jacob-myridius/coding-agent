import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import simpleGit from "simple-git";
import { cloneBranch, cloneRepository } from "../git-utils.js";

const BRANCH = "ai/us-1-r1";
const identity = { gitEmail: "bot@example.com", gitUsername: "bot" };

async function setupRemote() {
  const root = await mkdtemp(path.join(os.tmpdir(), "push-guard-"));
  const remote = path.join(root, "remote.git");
  await simpleGit().init(true, [remote, "--initial-branch=main"]);

  const seed = path.join(root, "seed");
  await simpleGit().clone(remote, seed);
  const seedGit = simpleGit(seed);
  await seedGit.addConfig("user.name", "seed").addConfig("user.email", "seed@example.com");
  await writeFile(path.join(seed, "README.md"), "# seed\n");
  await seedGit.add(".").commit("init").push("origin", "main");
  return { root, remote };
}

async function commitFile(repoGit, workspacePath, name) {
  await writeFile(path.join(workspacePath, name), `${name}\n`);
  await repoGit.add(".").commit(`add ${name}`);
}

test("agent can push the work item branch, but not other branches, force pushes or deletions", async () => {
  const { root, remote } = await setupRemote();
  try {
    const workspacePath = path.join(root, "ws");
    const repoGit = await cloneRepository({ repoUrl: remote, branchName: BRANCH, workspacePath, ...identity });

    await commitFile(repoGit, workspacePath, "a.txt");
    await repoGit.push("origin", BRANCH);
    assert.match(await simpleGit(remote).raw(["branch", "--list", BRANCH]), /ai\/us-1-r1/);

    await assert.rejects(repoGit.push("origin", `${BRANCH}:main`), /only refs\/heads\/ai\/us-1-r1 may be pushed/);
    await assert.rejects(repoGit.push("origin", `${BRANCH}:other`), /only refs\/heads\/ai\/us-1-r1 may be pushed/);

    await repoGit.raw(["reset", "--hard", "HEAD~1"]);
    await commitFile(repoGit, workspacePath, "b.txt");
    await assert.rejects(repoGit.push("origin", BRANCH, { "--force": null }), /non-fast-forward/);

    await assert.rejects(repoGit.push("origin", `:${BRANCH}`), /deleting refs\/heads\/ai\/us-1-r1 is not allowed/);

    // The worker's own force push bypasses the guard.
    await repoGit.push("origin", BRANCH, { "--force": null, "--no-verify": null });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cloneBranch checks out the existing remote branch and installs the guard", async () => {
  const { root, remote } = await setupRemote();
  try {
    const first = path.join(root, "first");
    const firstGit = await cloneRepository({ repoUrl: remote, branchName: BRANCH, workspacePath: first, ...identity });
    await commitFile(firstGit, first, "a.txt");
    await firstGit.push("origin", BRANCH);

    const resumed = path.join(root, "resumed");
    const { repoGit, branchExisted } = await cloneBranch({ repoUrl: remote, branchName: BRANCH, workspacePath: resumed, ...identity });
    assert.equal(branchExisted, true);
    assert.equal((await repoGit.revparse(["--abbrev-ref", "HEAD"])).trim(), BRANCH);

    await commitFile(repoGit, resumed, "c.txt");
    await repoGit.push("origin", BRANCH);
    await assert.rejects(repoGit.push("origin", `${BRANCH}:main`), /may be pushed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cloneBranch recreates a branch that was never pushed", async () => {
  const { root, remote } = await setupRemote();
  try {
    const { repoGit, branchExisted } = await cloneBranch({ repoUrl: remote, branchName: BRANCH, workspacePath: path.join(root, "ws"), ...identity });
    assert.equal(branchExisted, false);
    assert.equal((await repoGit.revparse(["--abbrev-ref", "HEAD"])).trim(), BRANCH);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
