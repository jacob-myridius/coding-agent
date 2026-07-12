import simpleGit from "simple-git";

export async function cloneRepository({ repoUrl, branchName, workspacePath }) {
  const git = simpleGit();
  await git.clone(repoUrl, workspacePath);

  const repoGit = simpleGit(workspacePath);
  await repoGit.checkoutLocalBranch(branchName);
  await repoGit.addConfig("user.name", requiredEnv("GIT_USERNAME"));
  await repoGit.addConfig("user.email", requiredEnv("GIT_EMAIL"));
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

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}
