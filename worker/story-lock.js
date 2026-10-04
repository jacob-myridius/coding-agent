/**
 * Distributed story lock backed by Azure Table Storage.
 *
 * Prevents concurrent code agent instances from working on the same user story.
 * Uses createEntity() 409-conflict detection — same pattern as the platform
 * orchestrator's platformOrchestratorIdempotency table.
 *
 * Table: codeAgentStoryLocks
 *   partitionKey: "{tracker}:{scope}"  e.g. "github:owner/repo", "jira:host:PROJECT", "ado:org:project"
 *   rowKey:       "{storyId}"          issue number, Jira key, or ADO work item ID (string)
 */

import { TableClient } from "@azure/data-tables";

const TABLE_NAME = "codeAgentStoryLocks";
const DEFAULT_STALE_HOURS = 2;

function getTableClient(connectionString) {
  return TableClient.fromConnectionString(connectionString, TABLE_NAME);
}

async function ensureTable(client) {
  try {
    await client.createTable();
  } catch (err) {
    if (err.statusCode !== 409) throw err;
  }
}

function partitionKey(tracker, scope) {
  return `${tracker}:${scope}`;
}

/**
 * Attempts to acquire a story lock.
 *
 * Returns:
 *   { acquired: true }                                              — fresh lock acquired
 *   { acquired: true, stalePreviousLock: { ... } }                 — stale lock auto-released; caller should post warning comment
 *   { acquired: false, existingLock: { executionId, lockedAt, lastHeartbeat, status, storyTitle } }
 *                                                                  — active lock held by another execution; caller should block
 */
export async function acquireStoryLock(connectionString, { tracker, scope, storyId, executionId, storyTitle = "" }) {
  const client = getTableClient(connectionString);
  await ensureTable(client);

  const pk = partitionKey(tracker, scope);
  const rk = String(storyId);
  const now = new Date().toISOString();

  const entity = {
    partitionKey: pk,
    rowKey: rk,
    executionId,
    status: "in-progress",
    lockedAt: now,
    lastHeartbeat: now,
    storyTitle,
  };

  try {
    await client.createEntity(entity);
    return { acquired: true };
  } catch (err) {
    if (err.statusCode !== 409) throw err;

    // Lock exists — read current state
    let existing;
    try {
      existing = await client.getEntity(pk, rk);
    } catch (readErr) {
      throw new Error(`[story-lock] acquireStoryLock: failed to read existing lock: ${readErr.message}`);
    }

    const existingLock = {
      executionId: existing.executionId,
      lockedAt: existing.lockedAt,
      lastHeartbeat: existing.lastHeartbeat,
      status: existing.status,
      storyTitle: existing.storyTitle || "",
    };

    // Same-executionId replay: the Event Hub message was re-delivered after a container restart
    // before the checkpoint could advance. The existing lock belongs to us — take it over.
    if (existingLock.executionId === executionId) {
      console.warn(`[story-lock] same-executionId replay for ${tracker}:${scope}/${storyId} (execId=${executionId}). Releasing stale self-lock and resuming.`);
      await client.deleteEntity(pk, rk);
      await client.createEntity(entity);
      return { acquired: true };
    }

    // Auto-release completed or failed locks (label re-applied after prior run completed)
    if (existingLock.status === "completed" || existingLock.status === "failed") {
      await client.deleteEntity(pk, rk);
      await client.createEntity(entity);
      return { acquired: true };
    }

    // Check if in-progress lock is stale by heartbeat age
    const staleHours = parseFloat(process.env.CODE_AGENT_LOCK_STALE_HOURS || String(DEFAULT_STALE_HOURS));
    const heartbeatAgeHours = (Date.now() - new Date(existingLock.lastHeartbeat).getTime()) / 3_600_000;

    if (heartbeatAgeHours > staleHours) {
      // Stale — auto-release and take over
      console.warn(`[story-lock] stale lock detected for ${tracker}:${scope}/${storyId} (execId=${existingLock.executionId}, heartbeat age=${heartbeatAgeHours.toFixed(1)}h > threshold=${staleHours}h). Auto-releasing.`);
      await client.deleteEntity(pk, rk);
      await client.createEntity(entity);
      return { acquired: true, stalePreviousLock: existingLock };
    }

    // Fresh active lock — block this execution
    console.warn(`[story-lock] duplicate blocked for ${tracker}:${scope}/${storyId} (active execId=${existingLock.executionId}, heartbeat age=${heartbeatAgeHours.toFixed(1)}h)`);
    return { acquired: false, existingLock };
  }
}

/**
 * Updates lastHeartbeat for an active lock. Only updates if executionId matches,
 * preventing a foreign heartbeat from keeping a dead lock alive.
 */
export async function updateHeartbeat(connectionString, { tracker, scope, storyId, executionId }) {
  const client = getTableClient(connectionString);
  const pk = partitionKey(tracker, scope);
  const rk = String(storyId);

  try {
    const existing = await client.getEntity(pk, rk);
    if (existing.executionId !== executionId) {
      console.warn(`[story-lock] updateHeartbeat skipped — executionId mismatch (ours=${executionId}, stored=${existing.executionId})`);
      return;
    }
    await client.updateEntity({ partitionKey: pk, rowKey: rk, lastHeartbeat: new Date().toISOString() }, "Merge");
  } catch (err) {
    // Non-fatal — heartbeat failure doesn't stop implementation
    console.warn(`[story-lock] updateHeartbeat failed: ${err.message}`);
  }
}

/**
 * Marks a lock as completed or failed.
 * Only updates if executionId matches to prevent a late-running duplicate from
 * releasing the lock acquired by a newer execution.
 */
export async function releaseStoryLock(connectionString, { tracker, scope, storyId, executionId, status }) {
  const client = getTableClient(connectionString);
  const pk = partitionKey(tracker, scope);
  const rk = String(storyId);

  try {
    const existing = await client.getEntity(pk, rk);
    if (existing.executionId !== executionId) {
      console.warn(`[story-lock] releaseStoryLock skipped — executionId mismatch (ours=${executionId}, stored=${existing.executionId})`);
      return;
    }
    await client.updateEntity({
      partitionKey: pk,
      rowKey: rk,
      status,
      releasedAt: new Date().toISOString(),
    }, "Merge");
    console.log(`[story-lock] lock released: ${tracker}:${scope}/${storyId} status=${status} execId=${executionId}`);
  } catch (err) {
    console.warn(`[story-lock] releaseStoryLock failed: ${err.message}`);
  }
}
