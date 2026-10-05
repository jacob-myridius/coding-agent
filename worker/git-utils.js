import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import simpleGit from "simple-git";

/**
 * Resolves the git username for a GitHub token.
 * Primary: fetches the authenticated user's login from the GitHub API.
 * Fallback: derives the username from the email prefix (e.g. "bot@example.com" → "bot").
 */
export async function resolveGitUsername(githubToken, email) {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "myridius-code-agent/1.0",
      },
    });
    if (res.ok) {
      const { login } = await res.json();
      if (login) return login;
    }
  } catch {
    // Network or parse error — fall through to email-based fallback.
  }
  return email.split("@")[0];
}

export async function cloneRepository({ repoUrl, branchName, workspacePath, gitEmail, gitUsername }) {
  if (!gitEmail) throw new Error("cloneRepository: gitEmail is required — must be derived from project credentials");
  if (!gitUsername) throw new Error("cloneRepository: gitUsername is required — must be derived from project credentials");

  const git = simpleGit();
  await git.clone(repoUrl, workspacePath);

  const repoGit = simpleGit(workspacePath);
  await repoGit.checkoutLocalBranch(branchName);
  await repoGit.addConfig("user.name", gitUsername);
  await repoGit.addConfig("user.email", gitEmail);
  await installPushGuard(workspacePath, branchName);
  return repoGit;
}

/**
 * Clones an existing feature branch (used when resuming a session). If the branch was never
 * pushed, clones the default branch and creates it locally instead (`branchExisted: false`).
 */
export async function cloneBranch({ repoUrl, branchName, workspacePath, gitEmail, gitUsername }) {
  if (!gitEmail) throw new Error("cloneBranch: gitEmail is required — must be derived from project credentials");
  if (!gitUsername) throw new Error("cloneBranch: gitUsername is required — must be derived from project credentials");

  const git = simpleGit();
  const remoteHeads = await git.listRemote(["--heads", repoUrl, branchName]);
  const branchExisted = remoteHeads.trim().length > 0;

  if (branchExisted) {
    await git.clone(repoUrl, workspacePath, ["--branch", branchName]);
  } else {
    await git.clone(repoUrl, workspacePath);
  }

  const repoGit = simpleGit(workspacePath);
  if (!branchExisted) {
    await repoGit.checkoutLocalBranch(branchName);
  }
  await repoGit.addConfig("user.name", gitUsername);
  await repoGit.addConfig("user.email", gitEmail);
  await installPushGuard(workspacePath, branchName);
  return { repoGit, branchExisted };
}

/**
 * Installs a pre-push hook so the agent can only fast-forward the work item branch:
 * pushes to other refs, force pushes and branch deletions are rejected. It is a guardrail
 * for the agent, not a security boundary (`git push --no-verify` skips it, which the
 * worker's own force push relies on).
 */
export async function installPushGuard(workspacePath, branchName) {
  const allowedRef = `refs/heads/${branchName}`.replace(/'/g, "'\''");
  const hook = `#!/bin/sh
# Installed by the Myridius worker: only fast-forward pushes to the work item branch are allowed.
allowed='${allowedRef}'
while read local_ref local_sha remote_ref remote_sha; do
  if [ "$remote_ref" != "$allowed" ]; then
    echo "myridius push guard: only $allowed may be pushed (attempted $remote_ref)" >&2
    exit 1
  fi
  case "$local_sha" in
    *[!0]*) ;;
    *) echo "myridius push guard: deleting $remote_ref is not allowed" >&2; exit 1 ;;
  esac
  case "$remote_sha" in
    *[!0]*)
      if ! git merge-base --is-ancestor "$remote_sha" "$local_sha" 2>/dev/null; then
        echo "myridius push guard: non-fast-forward (force) push to $remote_ref is not allowed" >&2
        exit 1
      fi
      ;;
  esac
done
exit 0
`;
  const hookPath = join(workspacePath, ".git", "hooks", "pre-push");
  await writeFile(hookPath, hook, "utf8");
  await chmod(hookPath, 0o755);
}

export async function commitPushAll(repoGit, message) {
  await repoGit.add(".");
  const status = await repoGit.status();
  if (status.files.length === 0) {
    return false;
  }
  await repoGit.commit(message);
  await repoGit.push("origin", await repoGit.revparse(["--abbrev-ref", "HEAD"]));
  return true;
}

