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
  return repoGit;
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

