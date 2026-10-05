# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An AI code-implementation worker for the Myridius platform. It consumes tracker events (Azure DevOps, GitHub Issues, Jira) from Azure Event Hub, clones the target repo(s), runs the pinned `myridius` CLI agent (vendored as `myridius-cli-agent-0.9.2.tgz`) to implement the story, runs tests, and verifies a PR exists. It is deployed to Azure Container Apps.

**The top-level `README.md` and `QUICK_START.md` are largely stale** (they describe a planned `src/worker/*.ts` + Azure Functions layout that does not exist). The real application is the plain-JS ESM app in `worker/`. `worker/code_worker_workflow.md` and `worker/README.md` are the accurate docs.

## Two packages

- **Root package (`package.json`, TypeScript)** — only `src/lib/` (code-rag, test-execution, config, vault-client). Compiled with `tsc` to `dist/`. It is a library, not a runnable service.
- **`worker/` package (JavaScript, `"type": "module"`)** — the actual service. Depends on `myridius` via `file:../myridius-cli-agent-0.9.2.tgz`.

The coupling point: `worker/test-execution.js` imports `../dist/src/lib/test-execution/index.js`, so **the root must be built (`npm run build`) before the worker's test-execution path works**. Other worker modules are self-contained (e.g. `worker/code-context.js` intentionally reimplements Azure AI Search retrieval without depending on `src/`).

## Commands

Root (TypeScript libs):
```bash
npm install
npm run build        # tsc -> dist/
npm run lint         # eslint src --ext .ts
npm run format       # prettier
```
(Root `npm test` runs jest, but there are currently no root tests.)

Worker:
```bash
cd worker
npm install
npm test                                            # node --test tests/**/*.test.mjs
node --test tests/policy.test.mjs                   # single test file
node --test --test-name-pattern="<name>" tests/processWorkItem.execution-gate.test.mjs
npm run simulate                                    # scripts/simulate-event.mjs
npm run smoke:gate | smoke:skip | smoke:blocked     # idempotency/gate smoke scripts
npm start                                           # node worker.js (needs Event Hub env)
```

Docker / deploy: the image actually used for ACA is `worker/Dockerfile` (built from repo root: `docker build -f worker/Dockerfile .`), which installs JDK/Maven/Gradle/Python/.NET so the CLI can build and test target repos. Deploy scripts are PowerShell in `scripts/deploy/`.

## Worker architecture

- `worker.js` — entry point. Starts a health HTTP server on `PORT` (default 80), subscribes an `EventHubConsumerClient` (consumer group default `claude-code-worker`), uses `TableCheckpointStore` (Azure Table Storage) when `AZURE_STORAGE_CONNECTION_STRING` is set, otherwise in-memory checkpoints. Each event → `processWorkItemEventBody`, then result logged via `event-logger.js`.
- `processWorkItem.js` — central orchestrator. `processWorkItemEventBody(body, dependencies)` routes by payload shape:
  - `isGitHubPayload` (has `repository.full_name` + `sender.login`) → GitHub issue path
  - `isJiraPayload` (`webhookEvent` starts with `jira:`) → Jira path (Jira issue, code in GitHub)
  - otherwise → Azure DevOps path, gated by `policy.js` `evaluateImplementationTrigger` (`AIPlanningStatus` transition to `ReadyForAIImplementation` on a User Story)
- **Label-driven routes (GitHub/Jira):** `ai:ready-for-implementation` triggers implementation; `ai:ready-for-implementation-plan` routes to `implementation-plan-handler.js`, which generates a plan (Jira: attachment, GitHub: comment) and moves the label to `ai:implementation-plan-proposed` (or `ai:needs-grooming`).
- **Credentials come from the credential broker, not env vars.** Every path requires `payload._agentContext.projectId` (injected by the platform orchestrator) and calls `broker-client.js` `acquireToken(projectId, "code", provider, CONSOLE_URL, AGENT_CALLBACK_SECRET, ...)` to get short-lived tokens and the git email. `CONSOLE_URL` and `AGENT_CALLBACK_SECRET` must be set. `_agentContext.repositories` lists registered repos.
- `repo-selector.js` — keyword scoring to pick 1–3 target repos (multi-repo when frontend+backend signals are detected).
- `implementInRepo` (in `processWorkItem.js`) is tracker-agnostic: GitHub/Jira paths pass a client (`github-client.js` / `createJiraGitHubClient`) that duck-types the `azdo-client.js` interface (`getWorkItem`, `postComment`, `buildCloneUrl`, `createPullRequest`, `findActivePullRequestBySourceBranch`). Per repo it: clones into an `os.tmpdir()` workspace (token embedded in clone URL) on branch `ai/us-{id}-r{rev}`, ensures Maven `.gitignore`, reads `TECHSTACK.md` if present, fetches code context (`code-context.js`), renders `prompts/implementation-prompt.md`, runs the CLI via `claude-runner.js`, then **the worker** force-pushes, runs tests (`test-execution.js`), and creates the PR if tests pass. Wrapped in `withTimeout` (`IMPL_TIMEOUT_MS`, default 30 min). Workspace removed in `finally`.
- **Responsibility split:** the CLI edits, commits, and pushes the work item branch (the prompt forbids it from running tests or opening PRs). Both clone helpers in `git-utils.js` install a `pre-push` hook that only allows fast-forward pushes to that branch (no other refs, force pushes or deletions); the worker's own `--force` push uses `--no-verify` to bypass it. If HEAD didn't move after the CLI run → `ExecutionSuppressed`. Tests fail → `blocked`/`TestsFailed` (branch is already pushed, no PR). `worker/README.md` and `code_worker_workflow.md` still say the CLI creates the PR — that is outdated.
- `claude-runner.js` spawns `node node_modules/myridius/dist/cli.mjs -p --verbose --output-format stream-json --session-id <uuid> --agent <MYRIDIUS_CLI_AGENT> --permission-mode ...` (format/verbosity via `MYRIDIUS_CLI_OUTPUT_FORMAT` / `MYRIDIUS_CLI_VERBOSE`; each stream-json line is summarized into `aca_claude_worker_cli_event` / `aca_claude_worker_cli_result` logs, truncated to `MYRIDIUS_CLI_LOG_MAX_CHARS`). The session id is pre-generated, attached to every `aca_claude_worker_cli_*` log line, and returned as `sessionId` on each per-repo result (and in `agentEvents` meta) with `cwd` = the workspace, piping the rendered prompt (also written to `IMPLEMENTATION_PROMPT.md` in the workspace) to stdin. `myridius` is a Claude Code fork; it reads `MYRIDIUS_CONFIG_DIR` (default `/app/config`, containing `config/claude.json` MCP config) and is pointed at an OpenAI-compatible endpoint via `MYRIDIUS_OPENAI_*` → `OPENAI_*` + `MYRIDIUS_USE_OPENAI=1`. `--dangerously-skip-permissions` is only added when not running as root.
- **Session resume:** `implementInRepo` picks the CLI session id up front, uses `os.tmpdir()/myridius-worker-<sessionId>` as the workspace, and the runner writes a credential-free manifest to `MYRIDIUS_CONFIG_DIR/worker-sessions/<sessionId>.json`. `resume-session.js` (`npm run resume:local -- <sessionId> "<message>"`) clones the feature branch into the transcript's recorded cwd **first** (the CLI only finds a session from the same cwd), runs the CLI with `--resume`, then the worker pushes new commits. The same flow is exposed over HTTP by the worker's server (`session-http.js`): `POST /api/sessions/:sessionId/resume` with `Authorization: Bearer $AGENT_CALLBACK_SECRET` and `{"message"}` streams NDJSON progress (status/session/event/heartbeat, then result or error); one resume per session at a time, and none while the session's run is still going (409). Host helper: `../local/resume-session.sh <sessionId> "<message>"`.
- **Live session logs:** `implementInRepo` and `resumeSession` run inside `runInSessionScope` (`session-log-bus.js`, AsyncLocalStorage); `worker.js` installs a console tap that copies every `console.*` call made inside a scope (credentials redacted) into an in-memory per-session ring buffer (`SESSION_LOG_MAX_LINES`, default 5000; ended sessions kept `SESSION_LOG_RETAIN_MINUTES`, default 60). Served by `session-http.js` with the same bearer secret: `GET /api/sessions` (list) and `GET /api/sessions/:sessionId/logs` (SSE: `run`/`log`/`end`/`gap` events, replay after `Last-Event-ID` or `?after=`, then live until the run ends). Host helper: `../local/session-logs.sh --list | <sessionId>`. Buffers are per replica and lost on restart; stdout logging is unchanged. Resuming needs the same `MYRIDIUS_CONFIG_DIR` (transcripts live in `projects/<cwd-slug>/`), which is container-local on ACA.
- **Skip reasons are idempotent**: key `ai-impl-skip:{workItemId}:{revision}:{reasonCode}`; codes in `config/reason-taxonomy.json` (`WrongType`, `NoStatusTransition`, `MissingRepoContext`, `ExecutionSuppressed`, `InvalidPayload`). See `skip-reason.js` / `postIdempotentSkipReason`.
- Results have a `category` (`implemented` / `blocked` / `skipped` ...) which `worker.js` maps to event types (`agent.success` / `agent.error` / `agent.dispatched`).

## Testing conventions

Worker tests use `node:test` + `node:assert/strict` (`.test.mjs`). External effects are injected through the `dependencies` argument of `processWorkItemEventBody` — `azdoClient`, `githubClient`, `jiraClient`, `cloneRepository`, `runImplementation` — so tests pass mocks rather than hitting network/git/CLI. Keep new side-effecting code injectable the same way.

## Gotchas

- `worker/node_modules/` is not tracked (`.gitignore`); run `npm install` in `worker/` after cloning. The Docker image installs its own (`.dockerignore` excludes it).
- Structured logs use snake_case event names as the first `console.log` arg (e.g. `aca_claude_worker_event_processed`, `aca_jira_worker_ignored`); follow that pattern.
- CLI defaults are set in three places that must agree: `claude-runner.js`, `worker/Dockerfile` `ENV`, and `worker/scripts/startup.sh`.
- The ADO path never substitutes `{{IMPLEMENTATION_PLAN}}` in the prompt template (only GitHub/Jira paths do).
