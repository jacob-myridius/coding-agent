# Spec: Interactive session resume from the web console

| | |
|---|---|
| **Status** | Draft |
| **Components** | coding-agent (`worker/`), platform-console (`api/`, `frontend/`) |
| **Builds on** | CLI session IDs, session manifests, `resume-session.js`, the push guard |

## 1. Summary

When a developer opens a pull request or issue in the Myridius web console, they can continue the coding agent's conversation that produced it. The console opens a WebSocket to a new **session service** running the coding-agent image. That service re-clones the feature branch, resumes the CLI session with `--resume`, and relays messages between the browser and the CLI. The agent keeps its earlier turns, works on the current branch, and pushes its commits to the feature branch, which updates the open PR.

## 2. Goals and non-goals

**Goals**
- Resume any recorded coding-agent session by its session ID from the console, with earlier turns restored.
- Multi-turn chat over one connection, with tool calls and results streamed live.
- The agent works on a fresh checkout of the feature branch and can push only to that branch.
- Only developers with write access to the session's project can resume it, and every message is audited.
- The Event Hub worker keeps running unchanged alongside it.

**Non-goals (for this spec)**
- Starting brand-new sessions from the console. The normal label/tracker flow still does that.
- Several developers sharing one live session. One driver per session at a time.
- Resuming sessions whose transcripts were lost before transcript storage existed (see §8).
- Replacing the worker's test execution or PR creation.

## 3. Background: what exists today

| Capability | Where | Notes |
|---|---|---|
| Session ID chosen before the run, logged on every CLI line | `worker/claude-runner.js` | `--session-id <uuid>`; `sessionId` is the first field of every `aca_claude_worker_cli_*` log |
| Workspace path derived from the session ID | `worker/processWorkItem.js` (`implementInRepo`) | `os.tmpdir()/myridius-worker-<sessionId>` |
| Session manifest (repo, branch, provider, project, workspace; no credentials) | `worker/session-manifest.js` | `MYRIDIUS_CONFIG_DIR/worker-sessions/<sessionId>.json` |
| Session ID surfaced to people | PR description (`**Agent session:**` + `<!-- myridius-session-id: … -->`), issue summary comment, `agentEvents` `meta.repos[].sessionId` | |
| One-shot resume: clone branch first, `--resume`, push | `worker/resume-session.js`, `npm run resume:local` | Verified end to end on a real session |
| Push guard (fast-forward pushes to the work item branch only) | `worker/git-utils.js` `installPushGuard` | `pre-push` hook; a guardrail, not a security boundary |
| Multi-turn streaming input on a resumed session | CLI flags `--input-format stream-json --output-format stream-json` | Verified manually: one resumed process answered two sequential stdin messages |

**Constraint that shapes the design:** the CLI stores transcripts per working folder (`MYRIDIUS_CONFIG_DIR/projects/<cwd-slug>/<sessionId>.jsonl`, plus `<sessionId>/subagents/` and `memory/`). It only finds a session when run from the **same absolute cwd**, with the same config folder. The console today has no WebSocket support. It is Express with Entra JWT auth (`requireAuth`, `requireWritePermission`).

## 4. Architecture

```
Browser (console web)
   │  wss://<console>/api/sessions/<sessionId>/ws?ticket=…    user identity + project authorization
   ▼
Console API (Express)  ── relays frames ──►  Session service (coding-agent image, separate Container App)
                         wss, Bearer AGENT_CALLBACK_SECRET        │
                                                                  │ 1. acquire session lock
                                                                  │ 2. restore transcript, broker token,
                                                                  │    clone feature branch into recorded cwd,
                                                                  │    install push guard
                                                                  │ 3. spawn myridius -p --verbose --resume <id>
                                                                  │      --input-format stream-json
                                                                  │      --output-format stream-json
                                                                  ▼
                                                           CLI stdin  ◄── user messages
                                                           CLI stdout ──► events to browser
```

- **The browser never connects to the coding agent directly.** The console API authenticates the developer, authorizes them against the session's project, and relays frames.
- **The session service is a separate Container App from the same image as the worker.** It has the CLI, the language toolchains and the git tooling. Interactive sessions run for minutes, so they must not hold Event Hub partitions or count against worker scaling. It runs `node session-server.js` instead of `node worker.js`.
- **Transcript storage is shared** (§8), so any session-service replica can resume any session.

## 5. User flow

1. The developer opens a PR or issue in the console. The console shows the **Agent session** ID from `agentEvents` (`meta.repos[].sessionId`), or parsed from the PR body marker, with a **Resume** button.
2. The browser calls `POST /api/sessions/:sessionId/ticket`. It receives a single-use ticket valid for 60 seconds.
3. The browser opens `wss://<console>/api/sessions/:sessionId/ws?ticket=<ticket>`.
4. The console validates the ticket, then opens the upstream WebSocket to the session service and relays frames.
5. The session service sends `status: cloning`, prepares the workspace, sends `history` (earlier turns from the transcript), then `status: ready`.
6. The developer sends messages. Each becomes one CLI user message. Events stream back. Each turn ends with `turn_result`.
7. After each turn, the service pushes any unpushed commits (`pushed`).
8. The session ends on **End session**, disconnect, or idle timeout. The CLI exits, and the service does a final push, saves the transcript, deletes the workspace and releases the lock (`status: closed`).

## 6. WebSocket protocol

Every frame is a JSON object with a `type`. The same protocol is used between browser ↔ console and console ↔ session service. The console relays frames unchanged, except that it adds the user's identity to the upstream `hello` frame.

### 6.1 Client → server

| Frame | Fields | Meaning |
|---|---|---|
| `hello` | `user: {id, name, email}` (added by the console upstream only) | First upstream frame, used for audit and commit attribution |
| `message` | `text: string` (max 32 KB) | One user turn. Rejected with `error` while a turn is running |
| `interrupt` | — | Stop the current turn (§12, open question 1) |
| `end` | — | End the session gracefully |
| `ping` | — | Keep-alive; answered with `pong` |

### 6.2 Server → client

| Frame | Fields | Meaning |
|---|---|---|
| `status` | `phase: "cloning" \| "ready" \| "running" \| "idle" \| "pushing" \| "closed"`, `detail?` | Lifecycle |
| `session` | `sessionId, repo, branchName, branchExisted, head` | Sent once after cloning |
| `history` | `turns: Turn[]` | Earlier conversation from the transcript (§7.4) |
| `event` | `event` | One CLI stream event, in the same summarized shape as `summarizeStreamEvent` (`claude-runner.js`) |
| `turn_result` | `isError, numTurns, durationMs, totalCostUsd` | End of a turn (from the CLI `result` event) |
| `pushed` | `head, newCommits` | The service pushed commits the agent left unpushed |
| `error` | `code, message, fatal` | `fatal: true` is followed by `closed` |
| `pong` | — | |

Error codes: `UNAUTHORIZED`, `FORBIDDEN`, `SESSION_NOT_FOUND`, `SESSION_LOCKED`, `WORKSPACE_PREP_FAILED`, `TURN_IN_PROGRESS`, `MESSAGE_TOO_LARGE`, `CLI_EXITED`, `BUDGET_EXCEEDED`, `IDLE_TIMEOUT`.

### 6.3 CLI input mapping

A `message` frame is written to CLI stdin as one line:

```json
{"type":"user","message":{"role":"user","content":"<text>"}}
```

The **first** message of a connection is wrapped with the resume note from `buildResumePrompt` (`resume-session.js`): fresh checkout at commit X, re-read files, push rules.

## 7. Coding-agent changes

### 7.1 Split `resumeSession` into steps (`worker/resume-session.js`)

Refactor the one-shot function into reusable steps. `resumeSession` stays as the composition used by `npm run resume`.

| Function | Responsibility |
|---|---|
| `prepareResumeWorkspace({ sessionId, overrides }, deps)` | Transcript lookup, manifest/transcript context, empty-workspace check, broker token, `cloneBranch` + push guard. Returns `{ target, repoGit, branchExisted, initialHead }` |
| `pushPending(repoGit, branchName)` | Pushes commits not yet on `origin/<branch>` (fast-forward, no force) |
| `finalizeResume(prepared, { keepWorkspace })` | Final push, transcript save (§8), workspace removal |

### 7.2 Streaming mode in the runner (`worker/claude-runner.js`)

Add `startMyridiusSession({ workspacePath, resumeSessionId, onEvent })`. It returns `{ send(text), interrupt(), close(), done: Promise }`.
- Spawns with `--input-format stream-json` added to the existing args (`buildMyridiusCliInvocation` gets an `inputFormat` option).
- Keeps stdin open; `send` writes one JSON line.
- Calls `onEvent(summary)` for each parsed stdout line, reusing `createStreamJsonForwarder` logic; logging stays as it is today.
- `close()` ends stdin and waits for exit. `done` rejects on a non-zero exit, as `runProcess` does today.

### 7.3 Session service (`worker/session-server.js`, new)

- HTTP server with a WebSocket endpoint `GET /sessions/:sessionId` (library: `ws`). It requires `Authorization: Bearer <AGENT_CALLBACK_SECRET>` and rejects anything else with 401.
- Per connection:
  1. Acquire the session lock (§9), else send `SESSION_LOCKED`.
  2. Restore the transcript (§8), then `prepareResumeWorkspace`.
  3. Send `session` and `history`, then `startMyridiusSession`, then `ready`.
  4. On `message`: if a turn is running, send `TURN_IN_PROGRESS`; else `send`, and set `running`.
  5. On CLI `result`: send `turn_result`, run `pushPending` (`pushing` / `pushed`), set `idle`.
  6. On `end`, socket close, idle timeout or budget exceeded: `close()`, then `finalizeResume`, release the lock, send `closed`.
- Health endpoint `GET /api/health`, same as the worker.
- Dependencies are injectable (`acquireToken`, `cloneBranch`, `startSession`, lock store, transcript store), following the worker's testing convention.

### 7.4 History from the transcript

`readTranscriptTurns(transcriptPath)` in `session-manifest.js` converts transcript records into `Turn[]`:

```ts
type Turn = { role: "user" | "assistant"; at: string; blocks: Array<
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: string }      // truncated like the logs
  | { type: "tool_result"; isError: boolean; content: string }
>}
```

Skip `queue-operation` and other bookkeeping records. Subagent transcripts are not expanded; only their final result appears, as the CLI itself does.

### 7.5 Container entry point

- Image unchanged.
- The session-service Container App overrides the command to `node /app/session-server.js`, with ingress enabled (external off; internal to the Container Apps environment) and WebSocket support.

## 8. Transcript storage

Resuming requires the session's transcript folder in the same `MYRIDIUS_CONFIG_DIR` the CLI runs with, and the CLI must run from the recorded cwd.

| Option | How | Trade-off |
|---|---|---|
| **A. Blob Storage (recommended)** | After every worker run and every session end, upload `projects/<cwd-slug>/` (the transcript, `<sessionId>/subagents/`, `memory/`) and the manifest to container `agent-sessions/<sessionId>/`. On resume, download into the local config folder before spawning | No shared filesystem; works with the existing storage account (Azurite locally). Upload/download time grows with the transcript |
| B. Azure Files mount for `MYRIDIUS_CONFIG_DIR` | Mount the same share in worker and session-service apps | Simplest code; file locking and latency on SMB, and every CLI config write goes over the network |

The cwd must be identical: the workspace path is `os.tmpdir()/myridius-worker-<sessionId>`, so worker and session-service containers must have the same `TMPDIR` (`/tmp`). The session service always uses the transcript's recorded `cwd` (as `resume-session.js` already does).

## 9. Concurrency and lifecycle

- **Lock:** one active connection per session ID. Use a blob lease on `agent-sessions/<sessionId>/lock` (60 s, renewed every 20 s), or a Table Storage row with an ETag, holding `{ owner, connectionId, since }`. A second connection gets `SESSION_LOCKED` with the current holder's name.
- **Worker vs session:** if the Event Hub worker starts a new run for the same work item while a session is open, the worker uses a new session ID and branch revision, so they don't conflict. A session on an old branch revision is still allowed.
- **Timeouts:**
  - idle 15 minutes (no `message`): end session
  - one turn 30 minutes (`IMPL_TIMEOUT_MS`): `interrupt`, then end
  - connection maximum 4 hours
- **Crash recovery:** if the session service dies, the lease expires. The workspace is lost, but every turn's commits were pushed after the turn, and the transcript is saved after each turn (option A), so the next resume picks up from the last completed turn.

## 10. Console changes (platform-console)

### 10.1 API (`api/src`)

| Route | Auth | Behavior |
|---|---|---|
| `GET /api/sessions/:sessionId` | `requireAuth` | Session metadata (repo, branch, PR, work item, last activity) from `agentEvents` `meta.repos[]` and the manifest |
| `POST /api/sessions/:sessionId/ticket` | `requireAuth`, `requireWritePermission` on the session's project | Single-use ticket (random 32 bytes, stored hashed with user, sessionId, expiry 60 s) |
| `GET /api/sessions/:sessionId/ws` (WebSocket upgrade) | `?ticket=` | Validates and consumes the ticket, opens the upstream WebSocket to `SESSION_SERVICE_URL` with `AGENT_CALLBACK_SECRET`, sends `hello` with the user, relays frames both ways, closes both sides together |

Implementation notes:
- Express doesn't handle upgrades; attach `ws` in `noServer` mode to the HTTP server's `upgrade` event in `api/src/index.ts`.
- Check `Origin` against the configured console origins on upgrade.
- New config: `SESSION_SERVICE_URL`. Uses the existing `AGENT_CALLBACK_SECRET`.

### 10.2 Web (`frontend/src`)

- **Resume** button on PR and issue views where a session ID is known.
- Chat panel:
  - history rendered first, then live events
  - tool calls collapsed by default (name + short input), text messages expanded
  - a status bar with phase, branch and head commit, plus a cost/turns readout from `turn_result`
- Input is disabled while `running`. **Stop** sends `interrupt`; **End session** sends `end`.
- On `closed` or connection loss: show the reason and offer **Resume again**.

## 11. Security

| Risk | Mitigation |
|---|---|
| Interactive shell access to the container via the agent | Only project writers can resume; one-time tickets; Origin check; service-to-service secret; session service ingress internal only |
| Agent pushing outside its branch | Push guard hook (guardrail). For enforcement: branch protection on default branches, and branch-scoped tokens where the provider supports them |
| Permission mode | Interactive sessions start in `acceptEdits` with a restricted tool list, not `bypassPermissions`. Configurable via `MYRIDIUS_SESSION_PERMISSION_MODE` |
| Credential exposure | Fresh broker token per session; token only in the workspace remote, which is deleted at session end; manifests and frames never contain tokens (`stripCredentials`) |
| Prompt injection via repo content | Same exposure as batch runs; audited, scoped tokens, push guard |
| Cost runaway | Per-session budget (`MYRIDIUS_SESSION_MAX_COST_USD`, tracked from `turn_result.totalCostUsd`), idle and turn timeouts |
| Audit | Write `session.started`, `session.message` (text, user), `session.turn` (cost, turns), `session.ended` to `agentEvents` with `sessionId` and user |

## 12. Open questions

1. **Interrupt:** does the `myridius` CLI support the stream-json `interrupt` control request? If not, interrupt by stopping the process and resuming the session again on the next message.
2. **Tool approvals in the browser:** keep `acceptEdits` + an allow-list, or forward permission prompts to the browser (`--permission-prompt-tool`) as approve/deny frames? The second is a protocol extension (`approval_request` / `approval_response`).
3. **PR feedback:** should the service comment on the PR after a session ("Session `<id>` resumed by `<user>`: N commits")? Requires a PR-comment method in `azdo-client.js` for Azure DevOps.
4. **Transcript retention:** how long to keep `agent-sessions/` blobs after the PR merges? Ties into the workspace/cleanup triggers design.
5. **Session lookup by PR:** should the console resolve the session from a PR number automatically (body marker) rather than showing the ID?

## 13. Rollout

| Phase | Scope | Exit criteria |
|---|---|---|
| 0. HTTP resume (done) | `POST /api/sessions/:sessionId/resume` on the worker's HTTP server (`worker/session-http.js`): one message per request, NDJSON progress stream, bearer secret, per-session in-process lock. Host helper `local/resume-session.sh` | Resume from the host against the container or a native worker |
| 0b. Live session logs (done) | `GET /api/sessions/:sessionId/logs` (SSE) and `GET /api/sessions` (`worker/session-http.js`). Each implementation/resume run is wrapped in an AsyncLocalStorage scope; a console tap copies every log line of the run (credentials redacted) into an in-memory per-session ring buffer (`worker/session-log-bus.js`). Replay via `Last-Event-ID`/`?after=`, then live until `end`; resume returns 409 while a run is still going. Host helper `local/session-logs.sh` | Attach to a running Event Hub implementation run from the host and watch clone → CLI → push → tests → PR live |
| 1. Agent core | §7.1, §7.2, §7.3, §7.4 locally; transcripts from the local config folder | Multi-turn resume works locally via `wscat`; the agent pushes to the feature branch; lock rejects a second connection |
| 2. Storage | §8 option A with Azurite locally, Blob Storage in Azure; worker uploads after runs | A session created on one container resumes on another |
| 3. Console | §10 API relay + tickets + UI | Developer resumes from a PR page in the local stack; unauthorized users get 403 |
| 4. Hardening | §11 audit, budgets, permission mode; open questions 1–2 resolved | Security review sign-off; deployed to UAT as a separate Container App |

## 14. Testing

- **Unit (`node:test`, injected dependencies):**
  - protocol state machine (`message` while `running` rejected, idle timeout, `end`)
  - history conversion
  - lock acquire/release/expiry
  - ticket single-use and expiry
  - `buildMyridiusCliInvocation` with `inputFormat`
- **Integration:** session service against a local bare git remote and a fake CLI that emits stream-json, the same approach as `tests/push-guard.test.mjs` and the fake CLI used for the runner.
- **End to end (local stack):** issue → worker run → PR with session ID → resume from the console → follow-up change pushed to the PR.
