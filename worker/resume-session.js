import { mkdir, readdir } from "node:fs/promises";
import { acquireToken } from "./broker-client.js";
import { runMyridiusImplementation } from "./claude-runner.js";
import { cloneBranch, resolveGitUsername } from "./git-utils.js";
import { removeWorkspace } from "./process-cleanup.js";
import {
  assertSessionId,
  findSessionTranscript,
  readSessionManifest,
  readTranscriptContext,
  stripCredentials,
  withCredentials
} from "./session-manifest.js";

/**
 * Continues a previous CLI session on its feature branch.
 *
 * Order matters: the feature branch is cloned into the session's original workspace path
 * FIRST, because the CLI only finds a transcript from the cwd it was recorded in, and the
 * agent needs the branch's current files before it does anything else. Then the CLI runs
 * with --resume (it may push the feature branch itself), and the worker pushes anything left.
 *
 * @param {{
 *   sessionId: string,
 *   prompt: string,
 *   push?: boolean,
 *   keepWorkspace?: boolean,
 *   overrides?: { repoUrl?: string, branchName?: string, projectId?: string, provider?: string }
 * }} options
 * @param {object} [dependencies] injectable side effects (env, acquireToken, cloneBranch, runImplementation, resolveGitUsername)
 */
export async function resumeSession({ sessionId, prompt, push = true, keepWorkspace = false, overrides = {} }, dependencies = {}) {
  assertSessionId(sessionId);
  if (!String(prompt || "").trim()) throw new Error("resumeSession: a prompt (the follow-up message) is required");

  const env = dependencies.env || process.env;
  const getToken = dependencies.acquireToken || acquireToken;
  const clone = dependencies.cloneBranch || cloneBranch;
  const runImplementation = dependencies.runImplementation || runMyridiusImplementation;
  const getGitUsername = dependencies.resolveGitUsername || resolveGitUsername;

  const transcriptPath = await findSessionTranscript(sessionId, env);
  if (!transcriptPath) {
    throw new Error(
      `resumeSession: no transcript found for session ${sessionId} under MYRIDIUS_CONFIG_DIR/projects ` +
      `(MYRIDIUS_CONFIG_DIR=${env.MYRIDIUS_CONFIG_DIR || "(default)"})`
    );
  }

  const manifest = (await readSessionManifest(sessionId, env)) || {};
  const transcript = await readTranscriptContext(transcriptPath);
  const target = {
    repoUrl: overrides.repoUrl || manifest.repoUrl,
    branchName: overrides.branchName || manifest.branchName || transcript.gitBranch,
    projectId: overrides.projectId || manifest.projectId,
    provider: overrides.provider || manifest.provider || "github",
    // The transcript's cwd is authoritative: it is the directory the CLI will look the session up from.
    workspacePath: transcript.cwd || manifest.workspacePath,
    baseBranch: manifest.baseBranch || "main"
  };
  const missing = Object.entries({ repoUrl: "--repo-url", branchName: "--branch", projectId: "--project-id", workspacePath: null })
    .filter(([key]) => !target[key])
    .map(([key, flag]) => (flag ? `${key} (${flag})` : key));
  if (missing.length > 0) {
    throw new Error(`resumeSession: session ${sessionId} has no manifest value for: ${missing.join(", ")}`);
  }

  console.log("aca_claude_worker_resume_started", {
    sessionId,
    repoUrl: stripCredentials(target.repoUrl),
    branchName: target.branchName,
    provider: target.provider,
    workspacePath: target.workspacePath,
    manifest: Object.keys(manifest).length > 0
  });

  if (await directoryHasEntries(target.workspacePath)) {
    throw new Error(
      `resumeSession: workspace ${target.workspacePath} already exists and is not empty ` +
      `(another resume in progress, or a leftover from an earlier run — remove it and retry)`
    );
  }

  const consoleUrl = env.CONSOLE_URL;
  const agentSecret = env.AGENT_CALLBACK_SECRET;
  if (!consoleUrl || !agentSecret) throw new Error("resumeSession: CONSOLE_URL and AGENT_CALLBACK_SECRET must be set");
  const { token, email: gitEmail } = await getToken(target.projectId, "code", target.provider, consoleUrl, agentSecret, "development");
  if (!gitEmail) throw new Error(`resumeSession: broker returned no git email for projectId=${target.projectId}`);

  const { authUrl, gitUsername } = await buildAuthenticatedClone(target, token, gitEmail, env, getGitUsername);

  await mkdir(target.workspacePath, { recursive: true });
  try {
    // ── Step 1: clone the feature branch ─────────────────────────────────────
    const { repoGit, branchExisted } = await clone({
      repoUrl: authUrl,
      branchName: target.branchName,
      workspacePath: target.workspacePath,
      gitEmail,
      gitUsername
    });
    const initialHead = String(await repoGit.revparse(["HEAD"])).trim();
    console.log("aca_claude_worker_resume_cloned", { sessionId, branchName: target.branchName, branchExisted, head: initialHead });

    // ── Step 2: resume the CLI session ───────────────────────────────────────
    await runImplementation({
      workspacePath: target.workspacePath,
      prompt: buildResumePrompt({ ...target, branchExisted, head: initialHead, prompt }),
      resumeSessionId: sessionId
    });

    // ── Step 3: push whatever the agent committed ────────────────────────────
    const finalHead = String(await repoGit.revparse(["HEAD"])).trim();
    const newCommits = finalHead === initialHead
      ? 0
      : Number.parseInt(String(await repoGit.raw(["rev-list", "--count", `${initialHead}..${finalHead}`])).trim(), 10) || 0;
    let pushed = false;
    if (newCommits > 0 && push) {
      await repoGit.push("origin", target.branchName, { "--set-upstream": null });
      pushed = true;
    }

    const result = { sessionId, branchName: target.branchName, branchExisted, initialHead, finalHead, newCommits, pushed };
    console.log("aca_claude_worker_resume_completed", result);
    return result;
  } finally {
    if (!keepWorkspace) {
      await removeWorkspace(target.workspacePath);
    }
  }
}

async function buildAuthenticatedClone(target, token, gitEmail, env, getGitUsername) {
  if (target.provider === "azure-devops") {
    // Matches azdo-client.js: the org name as user and the PAT from the environment as password.
    const pat = env.AZDO_PAT || token;
    if (!pat) throw new Error("resumeSession: AZDO_PAT is required to clone Azure DevOps repositories");
    const org = new URL(target.repoUrl).pathname.split("/").filter(Boolean)[0] || "azdo";
    return { authUrl: withCredentials(target.repoUrl, org, pat), gitUsername: gitEmail.split("@")[0] };
  }
  if (!token) throw new Error(`resumeSession: broker returned no ${target.provider} token for projectId=${target.projectId}`);
  return { authUrl: withCredentials(target.repoUrl, "oauth2", token), gitUsername: await getGitUsername(token, gitEmail) };
}

export function buildResumePrompt({ branchName, baseBranch, branchExisted, head, prompt }) {
  const checkout = branchExisted
    ? `The workspace was re-cloned from \`origin/${branchName}\` at commit \`${head}\`.`
    : `Branch \`${branchName}\` was never pushed, so it was recreated from \`${baseBranch}\` at commit \`${head}\`. ` +
      `Any work from your previous turns that was not pushed is NOT in the workspace.`;
  return [
    "[Session resumed by the Myridius worker]",
    checkout,
    "Files may have changed since your previous turns (for example, reviewer commits). Check `git log` and re-read files before editing them.",
    `The same rules apply as before: commit your changes and push them with \`git push origin ${branchName}\`. ` +
      "Do not push other branches, force-push, open pull requests, or run the test suite.",
    "",
    "Follow-up request:",
    prompt.trim()
  ].join("\n");
}

async function directoryHasEntries(dirPath) {
  try {
    return (await readdir(dirPath)).length > 0;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
