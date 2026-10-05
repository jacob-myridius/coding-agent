import http from "http";
import { EventHubConsumerClient } from "@azure/event-hubs";
import { processWorkItemEventBody } from "./processWorkItem.js";
import { logWorkerEvent } from "./event-logger.js";
import { TableCheckpointStore } from "./table-checkpoint-store.js";

// Health HTTP server — start immediately so probes succeed even if Event Hub is misconfigured
http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "myridius-code-agent" }));
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(parseInt(process.env.PORT ?? "80", 10), () => {
  console.log("aca_claude_worker_health_server_listening", { port: process.env.PORT ?? 80 });
});

const connectionString = requiredEnv("EVENT_HUB_CONNECTION_STRING");
const eventHubName = requiredEnv("EVENT_HUB_NAME");
const consumerGroup = process.env.EVENT_HUB_CONSUMER_GROUP || "claude-code-worker";

// Persistent checkpoint store — uses Table Storage when connection string is available
// so the consumer resumes from the correct offset after restarts.
const storageConnStr = process.env.AZURE_STORAGE_CONNECTION_STRING || "";
let checkpointStore;
if (storageConnStr) {
  const store = new TableCheckpointStore(storageConnStr, "eventhubcheckpoints");
  await store.ensureTable();
  checkpointStore = store;
  console.log("aca_claude_worker_checkpoint_store_ready", { table: "eventhubcheckpoints" });
} else {
  console.warn("aca_claude_worker_checkpoint_store_disabled: AZURE_STORAGE_CONNECTION_STRING not set — checkpoints are in-memory only");
}

const client = checkpointStore
  ? new EventHubConsumerClient(consumerGroup, connectionString, eventHubName, checkpointStore)
  : new EventHubConsumerClient(consumerGroup, connectionString, eventHubName);

console.log("aca_claude_worker_starting", { eventHubName, consumerGroup });

client.subscribe({
  processEvents: async (events, context) => {
    for (const event of events) {
      try {
        const result = await processWorkItemEventBody(event.body);

        // Write result event to Table Storage — fire-and-forget
        const rawPayload = typeof event.body === "string" ? JSON.parse(event.body) : (event.body ?? {});
        const baseUrl = String(rawPayload?.resourceContainers?.collection?.baseUrl || "").trim();
        const orgMatch = baseUrl.replace(/\/$/, "").match(/\/([^/]+)$/);
        const adoOrg = (orgMatch ? orgMatch[1] : process.env.AZDO_ORG || "").toLowerCase();
        const projectContainer = rawPayload?.resourceContainers?.project;
        const adoProject = String(projectContainer?.name || projectContainer?.id || process.env.AZDO_PROJECT || "").toLowerCase();

        const eventType =
          result.category === "implemented" ? "agent.success" :
          result.category === "blocked"     ? "agent.error" :
                                              "agent.dispatched";

        logWorkerEvent({
          adoOrg,
          adoProject,
          type: eventType,
          agentId: "code",
          workItemId: result.workItemId,
          message: buildWorkerMessage(result),
          meta: {
            category: result.category,
            reasonCode: result.reasonCode,
            repos: result.repos?.map((r) => ({
              repoName: r.repoName,
              branchName: r.branchName,
              sessionId: r.sessionId,
              pullRequestId: r.pullRequestId,
              testSummary: r.testSummary,
            })),
          },
        }).catch((err) =>
          console.error("event_log_write_failed", { error: err.message })
        );

        console.log("aca_claude_worker_event_processed", {
          category: result.category,
          partitionId: context.partitionId,
          sequenceNumber: event.sequenceNumber,
          offset: event.offset,
          reasonCode: result.reasonCode || "",
          workItemId: result.workItemId || 0
        });

        // Advance the checkpoint so a restart doesn't re-process this event
        if (checkpointStore) {
          await context.updateCheckpoint(event).catch((err) =>
            console.error("aca_claude_worker_checkpoint_failed", { error: err.message })
          );
        }
      } catch (error) {
        const requestUrl = error?.config?.url
          ? `${error.config.baseURL || ""}${error.config.url}`
          : undefined;
        console.error("aca_claude_worker_event_failed", {
          partitionId: context.partitionId,
          sequenceNumber: event.sequenceNumber,
          offset: event.offset,
          errorMessage: error instanceof Error ? error.message : String(error),
          ...(requestUrl && { requestUrl }),
          ...(error?.response?.status && { httpStatus: error.response.status })
        });
      }
    }
  },
  processError: async (error, context) => {
    console.error("aca_claude_worker_consumer_error", {
      partitionId: context.partitionId,
      errorMessage: error instanceof Error ? error.message : String(error)
    });
  }
});

function buildWorkerMessage(result) {
  if (result.category === "implemented") {
    const repoParts = (result.repos ?? [])
      .filter((r) => r.category === "implemented")
      .map((r) => r.pullRequestId ? `${r.repoName} — PR #${r.pullRequestId}` : r.repoName);
    return repoParts.length > 0
      ? `Implemented in ${repoParts.join(", ")}`
      : `Work item #${result.workItemId ?? "?"} implemented`;
  }
  if (result.category === "blocked") {
    const repoNames = (result.repos ?? [])
      .filter((r) => r.category === "blocked")
      .map((r) => r.repoName)
      .join(", ");
    return `Tests failed in ${repoNames || "one or more repos"}`;
  }
  return `Skipped: ${result.reasonCode || result.reason || "no changes"}`;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

