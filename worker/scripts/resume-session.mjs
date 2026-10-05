// Resumes a previous coding-agent CLI session: clones its feature branch into the original
// workspace path, continues the conversation with a follow-up message, and pushes new commits.
//
// Usage:
//   npm run resume:local -- <sessionId> "<follow-up message>" [options]
//   echo "<follow-up message>" | npm run resume:local -- <sessionId> [options]
//
// Options:
//   --no-push              Don't push commits the agent makes
//   --keep-workspace       Leave the cloned workspace on disk afterwards (path is printed)
//   --repo-url <url>       Clean https clone URL (needed for sessions created before manifests existed)
//   --branch <name>        Feature branch (defaults to the manifest, then the transcript)
//   --project-id <id>      Myridius project id used for the credential broker
//   --provider <name>      github (default) | azure-devops

import { resumeSession } from "../resume-session.js";

const VALUE_FLAGS = { "--repo-url": "repoUrl", "--branch": "branchName", "--project-id": "projectId", "--provider": "provider" };

function parseArgs(argv) {
  const options = { push: true, keepWorkspace: false, overrides: {} };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--no-push") options.push = false;
    else if (arg === "--keep-workspace") options.keepWorkspace = true;
    else if (arg in VALUE_FLAGS) {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      options.overrides[VALUE_FLAGS[arg]] = value;
      i += 1;
    } else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}`);
    else positional.push(arg);
  }
  const [sessionId, ...messageParts] = positional;
  return { ...options, sessionId, prompt: messageParts.join(" ") };
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (!options.sessionId) throw new Error('Usage: resume-session.mjs <sessionId> "<follow-up message>" [options]');
  if (!options.prompt.trim()) options.prompt = await readStdin();

  const result = await resumeSession(options);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`resume_session_failed: ${error.message}`);
  process.exitCode = 1;
}
