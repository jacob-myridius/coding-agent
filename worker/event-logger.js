/**
 * Writes agent events to the shared Azure Table Storage `agentEvents` table.
 * Non-critical — all errors are swallowed to avoid affecting worker behaviour.
 */

import { TableClient } from "@azure/data-tables";
import { v4 as uuid } from "uuid";
import { tableClientOptions } from "./table-checkpoint-store.js";

const TABLE_NAME = "agentEvents";

// Created on first write; a fresh storage account (or Azurite) doesn't have the table yet.
let tableReady;

function getClient() {
  const connStr = (process.env.AZURE_STORAGE_CONNECTION_STRING || "").trim();
  if (!connStr) return null;
  return TableClient.fromConnectionString(connStr, TABLE_NAME, tableClientOptions(connStr));
}

/**
 * @param {{
 *   adoOrg: string,
 *   adoProject: string,
 *   type: 'webhook.received'|'agent.dispatched'|'agent.success'|'agent.error',
 *   agentId: string,
 *   workItemId?: number,
 *   pullRequestId?: number,
 *   message: string,
 *   meta?: Record<string, unknown>
 * }} event
 * @returns {Promise<void>}
 */
export async function logWorkerEvent(event) {
  const client = getClient();
  if (!client) return;
  tableReady ??= client.createTable().catch((err) => {
    tableReady = undefined; // retry on the next event
    throw err;
  });
  await tableReady;

  const pk = `${(event.adoOrg || "").toLowerCase()}:${(event.adoProject || "").toLowerCase()}`;
  const rk = `${new Date().toISOString().replace(/[:.]/g, "-")}_${uuid()}`;

  await client.upsertEntity({
    partitionKey: pk,
    rowKey: rk,
    type: event.type,
    agentId: event.agentId,
    workItemId: event.workItemId ?? null,
    pullRequestId: event.pullRequestId ?? null,
    message: event.message,
    metaJson: event.meta ? JSON.stringify(event.meta) : null,
  });
}
