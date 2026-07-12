import { EventHubConsumerClient } from "@azure/event-hubs";
import { processWorkItemEventBody } from "./processWorkItem.js";

const connectionString = requiredEnv("EVENT_HUB_CONNECTION_STRING");
const eventHubName = requiredEnv("EVENT_HUB_NAME");
const consumerGroup = process.env.EVENT_HUB_CONSUMER_GROUP || "claude-code-worker";

const client = new EventHubConsumerClient(consumerGroup, connectionString, eventHubName);

console.log("aca_claude_worker_starting", { eventHubName, consumerGroup });

client.subscribe({
  processEvents: async (events, context) => {
    for (const event of events) {
      try {
        const result = await processWorkItemEventBody(event.body);
        console.log("aca_claude_worker_event_processed", {
          category: result.category,
          partitionId: context.partitionId,
          sequenceNumber: event.sequenceNumber,
          offset: event.offset,
          reasonCode: result.reasonCode || "",
          workItemId: result.workItemId || 0
        });
      } catch (error) {
        console.error("aca_claude_worker_event_failed", {
          partitionId: context.partitionId,
          sequenceNumber: event.sequenceNumber,
          offset: event.offset,
          errorMessage: error instanceof Error ? error.message : String(error)
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

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

