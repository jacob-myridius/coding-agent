# Myridius ACA Claude Worker

This worker runs in Azure Container Apps and consumes Azure DevOps work item events from Event Hub.

Events are dispatched by the webhook ingress when a human-authored `workitem.updated` transitions planning status to `ReadyForAIImplementation`.

## Trigger policy (implemented)

- Event type must be `workitem.updated`
- Work item type must be `User Story`
- `AIPlanningStatus` must transition from any non-target value to `ReadyForAIImplementation`
- Status field can be emitted as `AIPlanningStatus` or `Custom.AIPlanningStatus`
- If blocked, the worker keeps `AIPlanningStatus` unchanged and writes idempotent `AIPlanningStatusReason` + comment using reason taxonomy
- Worker pre-creates a deterministic work-item branch (`ai/us-{workItemId}-r{revision}`) before invoking the CLI
- The CLI is responsible for implementation, tests, commit/push, and PR creation

## Reason taxonomy

- `WrongType`
- `NoStatusTransition`
- `MissingRepoContext`
- `ExecutionSuppressed`
- `InvalidPayload`

## Required environment variables

- `EVENT_HUB_CONNECTION_STRING`
- `EVENT_HUB_NAME`
- `EVENT_HUB_CONSUMER_GROUP` (default: `claude-code-worker`)
- `AZDO_PAT`
- `AZDO_ORG`
- `AZDO_PROJECT`
- `AZDO_REPO`
- `AZDO_REPO_CLONE_URL`
- `GIT_USERNAME`
- `GIT_EMAIL`
- `MYRIDIUS_CLI_AGENT` (default: `backend-specialist`)
- `MYRIDIUS_CLI_FULL_AUTO` (default: `1`)
- `MYRIDIUS_CLI_PERMISSION_MODE` (optional explicit override; leave empty to let full-auto policy decide)
- `MYRIDIUS_CLI_ALLOW_ROOT_BYPASS` (default: `1`; allows bypass mode in root containers)
- `MYRIDIUS_CLI_DANGEROUSLY_SKIP_PERMISSIONS` (default: `1`; appends CLI `--dangerously-skip-permissions` for bypass mode)
- `MYRIDIUS_CLI_STREAM_LINE_LOGS` (default: `1`; when enabled, streams CLI output lines as `aca_claude_worker_cli_stdout_line` and `aca_claude_worker_cli_stderr_line`)
- `MYRIDIUS_CLI_COMMAND` (optional override; if empty, worker builds command as `node /app/node_modules/myridius/dist/cli.mjs --print --agent backend-specialist --permission-mode bypassPermissions --dangerously-skip-permissions`)
- `MYRIDIUS_OPENAI_API_KEY`
- `MYRIDIUS_OPENAI_MODEL_ENDPOINT`
- `MYRIDIUS_OPENAI_DEPLOYMENT_NAME`
- `AI_PLANNING_STATUS_FIELD_REF_NAME` (default: `AIPlanningStatus`)
- `AI_PLANNING_STATUS_REASON_FIELD_REF_NAME` (default: `AIPlanningStatusReason`)

The worker maps `MYRIDIUS_OPENAI_*` to `OPENAI_*` for CLI compatibility.

You can start from `worker/.env.example` and export values into your shell before running locally.

## Local run

```powershell
Set-Location "C:\Users\User\myridius-estimation-agent\worker"
npm install
npm test
npm run simulate
npm run smoke:gate
npm run smoke:skip
npm run smoke:blocked
```

Repo-level smoke wrapper:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\integration\runAcaWorkerGateSmoke.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\integration\runAcaWorkerGateSmoke.ps1 -IncludeSkipIdempotency
powershell -ExecutionPolicy Bypass -File .\scripts\integration\runAcaWorkerGateSmoke.ps1 -IncludeSkipIdempotency -IncludeBlockedEventIdempotency
```

## Build image

```powershell
Set-Location "C:\Users\User\myridius-estimation-agent"
docker build -f .\worker\Dockerfile -t myridius-aca-claude-worker:0.1.0 .
```

## Troubleshooting

If no events are processed after setting `AIPlanningStatus=ReadyForAIImplementation`:

1. Check webhook ingress logs for `implementation_dispatch_decision`.
2. If reason is `missingStatusChange`, inspect `changedFieldKeys` and verify status field naming in ADO (`AIPlanningStatus` vs `Custom.AIPlanningStatus`).
3. If reason is `notHumanAuthored`, verify actor identity and automation-account settings.
4. Verify worker revision env points to implementation hub:
   - `EVENT_HUB_NAME=myridius-implementation-events`
   - `EVENT_HUB_CONSUMER_GROUP=claude-code-worker`




5. If no active PR is detected after the CLI run, the worker records `ExecutionSuppressed` instead of marking the event as implemented.
