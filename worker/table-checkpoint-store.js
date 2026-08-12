/**
 * Azure Table Storage-backed checkpoint store for the Event Hub consumer.
 *
 * Implements the CheckpointStore interface required by EventHubConsumerClient.
 * Uses @azure/data-tables (already a worker dependency) so no new packages needed.
 *
 * Table schema (partition = namespace|hub|consumerGroup, row = partitionId):
 *   - For ownership:  { ownerID, lastModifiedTimeInMs, etag }
 *   - For checkpoint: { sequenceNumber, offset }
 */

import { TableClient, TableServiceClient, odata } from "@azure/data-tables";

const OWNERSHIP_PREFIX = "own";
const CHECKPOINT_PREFIX = "chk";

function ownershipRow(o) {
  return {
    partitionKey: encodeKey(`${o.fullyQualifiedNamespace}|${o.eventHubName}|${o.consumerGroup}`),
    rowKey: `${OWNERSHIP_PREFIX}|${o.partitionId}`,
    ownerID: o.ownerId ?? "",
    lastModifiedTimeInMs: String(o.lastModifiedTimeInMs ?? Date.now()),
    etag: o.etag ?? "",
  };
}

function checkpointRow(c) {
  return {
    partitionKey: encodeKey(`${c.fullyQualifiedNamespace}|${c.eventHubName}|${c.consumerGroup}`),
    rowKey: `${CHECKPOINT_PREFIX}|${c.partitionId}`,
    sequenceNumber: String(c.sequenceNumber ?? ""),
    offset: String(c.offset ?? ""),
  };
}

function rowToOwnership(ns, hub, cg, row) {
  const partitionId = row.rowKey.replace(`${OWNERSHIP_PREFIX}|`, "");
  return {
    fullyQualifiedNamespace: ns,
    eventHubName: hub,
    consumerGroup: cg,
    partitionId,
    ownerId: row.ownerID ?? "",
    lastModifiedTimeInMs: Number(row.lastModifiedTimeInMs ?? 0),
    etag: row.etag ?? row["odata.etag"] ?? "",
  };
}

function rowToCheckpoint(ns, hub, cg, row) {
  const partitionId = row.rowKey.replace(`${CHECKPOINT_PREFIX}|`, "");
  return {
    fullyQualifiedNamespace: ns,
    eventHubName: hub,
    consumerGroup: cg,
    partitionId,
    sequenceNumber: Number(row.sequenceNumber ?? -1),
    offset: row.offset ?? "",
  };
}

function encodeKey(s) {
  // Table Storage partition/row keys cannot contain: / \ # ? and control chars
  return s.replace(/[/\\#?]/g, "_").slice(0, 128);
}

export class TableCheckpointStore {
  /** @param {string} connectionString @param {string} tableName */
  constructor(connectionString, tableName = "eventhubcheckpoints") {
    this._connStr = connectionString;
    this._tableName = tableName;
    this._client = TableClient.fromConnectionString(connectionString, tableName);
  }

  async ensureTable() {
    try {
      const svc = TableServiceClient.fromConnectionString(this._connStr);
      await svc.createTable(this._tableName);
    } catch {
      // table already exists — fine
    }
  }

  async listOwnership(fullyQualifiedNamespace, eventHubName, consumerGroup) {
    const pk = encodeKey(`${fullyQualifiedNamespace}|${eventHubName}|${consumerGroup}`);
    // Azure Table Storage does not support startswith() — use a RowKey range filter instead.
    // OWNERSHIP_PREFIX = "own"; rows are "own|{partitionId}". Upper bound uses '}' (ASCII 125),
    // one above '|' (ASCII 124), so the range covers exactly the "own|*" prefix.
    const ownLow = `${OWNERSHIP_PREFIX}|`;
    const ownHigh = `${OWNERSHIP_PREFIX}}`;
    const results = [];
    const iter = this._client.listEntities({
      queryOptions: { filter: odata`PartitionKey eq ${pk} and RowKey ge ${ownLow} and RowKey lt ${ownHigh}` },
    });
    for await (const row of iter) {
      results.push(rowToOwnership(fullyQualifiedNamespace, eventHubName, consumerGroup, row));
    }
    return results;
  }

  async claimOwnership(partitionOwnership) {
    const claimed = [];
    for (const o of partitionOwnership) {
      const row = ownershipRow(o);
      try {
        let newEtag;
        if (o.etag) {
          // Conditional replace — fails with 412 if another instance won the race
          const resp = await this._client.updateEntity(row, "Replace", { etag: o.etag });
          newEtag = resp.etag ?? o.etag;
        } else {
          // First-time claim — fails with 409 if another instance already claimed it
          const resp = await this._client.createEntity(row);
          newEtag = resp.etag ?? "";
        }
        claimed.push({ ...o, etag: newEtag, lastModifiedTimeInMs: Date.now() });
      } catch {
        // Claim lost — another instance won the race, skip this partition
      }
    }
    return claimed;
  }

  async updateCheckpoint(checkpoint) {
    const row = checkpointRow(checkpoint);
    await this._client.upsertEntity(row, "Replace");
  }

  async listCheckpoints(fullyQualifiedNamespace, eventHubName, consumerGroup) {
    const pk = encodeKey(`${fullyQualifiedNamespace}|${eventHubName}|${consumerGroup}`);
    // Same range-filter pattern as listOwnership: CHECKPOINT_PREFIX = "chk", rows are "chk|{partitionId}".
    const chkLow = `${CHECKPOINT_PREFIX}|`;
    const chkHigh = `${CHECKPOINT_PREFIX}}`;
    const results = [];
    const iter = this._client.listEntities({
      queryOptions: { filter: odata`PartitionKey eq ${pk} and RowKey ge ${chkLow} and RowKey lt ${chkHigh}` },
    });
    for await (const row of iter) {
      results.push(rowToCheckpoint(fullyQualifiedNamespace, eventHubName, consumerGroup, row));
    }
    return results;
  }
}
