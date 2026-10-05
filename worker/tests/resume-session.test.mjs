import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resumeSession, buildResumePrompt } from "../resume-session.js";
import { readSessionManifest, stripCredentials, writeSessionManifest } from "../session-manifest.js";

const SESSION_ID = "2728d0d7-cf89-4fab-82e6-c60d2415b08d";

async function setupConfig({ manifest = true, gitBranch = "ai/us-1-r1" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "resume-test-"));
  const configDir = path.join(root, "config");
  const workspacePath = path.join(root, `myridius-worker-${SESSION_ID}`);
  const projectDir = path.join(configDir, "projects", workspacePath.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    path.join(projectDir, `${SESSION_ID}.jsonl`),
    [
      JSON.stringify({ type: "queue-operation" }),
      JSON.stringify({ type: "user", cwd: workspacePath, gitBranch, sessionId: SESSION_ID, message: { role: "user", content: "hi" } })
    ].join("\n") + "\n"
  );
  const env = { MYRIDIUS_CONFIG_DIR: configDir, CONSOLE_URL: "http://console", AGENT_CALLBACK_SECRET: "secret" };
  if (manifest) {
    await writeSessionManifest(
      {
        sessionId: SESSION_ID,
        provider: "github",
        projectId: "local-dev",
        repoName: "sample",
        repoUrl: "https://oauth2:old-token@github.com/acme/sample.git",
        branchName: "ai/us-1-r1",
        baseBranch: "main",
        workspacePath
      },
      env
    );
  }
  return { root, env, workspacePath };
}

function createMocks({ commitsAdded = 1, branchExisted = true } = {}) {
  const calls = [];
  let head = "aaa111";
  const repoGit = {
    revparse: async () => head,
    raw: async () => `${commitsAdded}\n`,
    push: async (remote, branch, opts) => calls.push({ step: "push", remote, branch, opts })
  };
  const dependencies = {
    acquireToken: async (...args) => {
      calls.push({ step: "token", args });
      return { token: "fresh-token", email: "bot@example.com" };
    },
    resolveGitUsername: async () => "bot",
    cloneBranch: async (args) => {
      calls.push({ step: "clone", args });
      await writeFile(path.join(args.workspacePath, "README.md"), "# sample\n");
      return { repoGit, branchExisted };
    },
    runImplementation: async (args) => {
      // The branch must already be on disk when the CLI starts.
      await access(path.join(args.workspacePath, "README.md"));
      calls.push({ step: "cli", args });
      if (commitsAdded > 0) head = "bbb222";
      return { sessionId: args.resumeSessionId };
    }
  };
  return { calls, dependencies };
}

test("clones the feature branch first, then resumes the CLI session, then pushes", async () => {
  const { root, env, workspacePath } = await setupConfig();
  const { calls, dependencies } = createMocks();
  try {
    const result = await resumeSession({ sessionId: SESSION_ID, prompt: "Add pagination" }, { ...dependencies, env });

    assert.deepEqual(calls.map((c) => c.step), ["token", "clone", "cli", "push"]);
    const clone = calls.find((c) => c.step === "clone").args;
    assert.equal(clone.workspacePath, workspacePath);
    assert.equal(clone.branchName, "ai/us-1-r1");
    assert.equal(clone.repoUrl, "https://oauth2:fresh-token@github.com/acme/sample.git");

    const cli = calls.find((c) => c.step === "cli").args;
    assert.equal(cli.resumeSessionId, SESSION_ID);
    assert.equal(cli.workspacePath, workspacePath);
    assert.match(cli.prompt, /re-cloned from `origin\/ai\/us-1-r1` at commit `aaa111`/);
    assert.match(cli.prompt, /Follow-up request:\nAdd pagination$/);

    assert.deepEqual(calls.find((c) => c.step === "push").branch, "ai/us-1-r1");
    assert.equal(result.newCommits, 1);
    assert.equal(result.pushed, true);
    await assert.rejects(access(workspacePath), "workspace is removed afterwards");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not push when the agent made no commits, and honours --keep-workspace", async () => {
  const { root, env, workspacePath } = await setupConfig();
  const { calls, dependencies } = createMocks({ commitsAdded: 0 });
  try {
    const result = await resumeSession(
      { sessionId: SESSION_ID, prompt: "Just explain the design", keepWorkspace: true },
      { ...dependencies, env }
    );
    assert.deepEqual(calls.map((c) => c.step), ["token", "clone", "cli"]);
    assert.equal(result.pushed, false);
    assert.ok((await readdir(workspacePath)).includes("README.md"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("falls back to the transcript and overrides when a session has no manifest", async () => {
  const { root, env, workspacePath } = await setupConfig({ manifest: false });
  const { calls, dependencies } = createMocks();
  try {
    await assert.rejects(
      resumeSession({ sessionId: SESSION_ID, prompt: "x" }, { ...dependencies, env }),
      /repoUrl \(--repo-url\), projectId \(--project-id\)/
    );
    await resumeSession(
      {
        sessionId: SESSION_ID,
        prompt: "x",
        overrides: { repoUrl: "https://github.com/acme/sample.git", projectId: "local-dev" }
      },
      { ...dependencies, env }
    );
    const clone = calls.find((c) => c.step === "clone").args;
    assert.equal(clone.workspacePath, workspacePath);
    assert.equal(clone.branchName, "ai/us-1-r1", "branch comes from the transcript");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to clone into a non-empty workspace", async () => {
  const { root, env, workspacePath } = await setupConfig();
  const { calls, dependencies } = createMocks();
  try {
    await mkdir(workspacePath, { recursive: true });
    await writeFile(path.join(workspacePath, "leftover.txt"), "x");
    await assert.rejects(resumeSession({ sessionId: SESSION_ID, prompt: "x" }, { ...dependencies, env }), /already exists/);
    assert.equal(calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails clearly when the transcript is missing", async () => {
  const { root, env } = await setupConfig();
  const { dependencies } = createMocks();
  try {
    await assert.rejects(
      resumeSession({ sessionId: "00000000-0000-0000-0000-000000000000", prompt: "x" }, { ...dependencies, env }),
      /no transcript found/
    );
    await assert.rejects(resumeSession({ sessionId: "../etc", prompt: "x" }, { ...dependencies, env }), /Invalid session id/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("warns the agent when the branch was never pushed", () => {
  const prompt = buildResumePrompt({ branchName: "ai/us-1-r1", baseBranch: "main", branchExisted: false, head: "ccc", prompt: "go" });
  assert.match(prompt, /was never pushed, so it was recreated from `main`/);
});

test("manifests never store credentials", async () => {
  const { root, env } = await setupConfig();
  try {
    const manifest = await readSessionManifest(SESSION_ID, env);
    assert.equal(manifest.repoUrl, "https://github.com/acme/sample.git");
    assert.equal(stripCredentials("https://org:pat@dev.azure.com/org/p/_git/r"), "https://dev.azure.com/org/p/_git/r");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
