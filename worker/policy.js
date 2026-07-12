import reasonCatalog from "./config/reason-taxonomy.json" with { type: "json" };

const TARGET_STATUS = "readyforaiimplementation";
const USER_STORY_TYPES = new Set(["user story", "story"]);

export function evaluateImplementationTrigger(payload, options = {}) {
  const statusFieldRef = (options.statusFieldRefName || "AIPlanningStatus").trim();
  const resource = asObject(payload?.resource);
  if (!resource) {
    return blocked("InvalidPayload", "Missing payload.resource");
  }

  const revision = asObject(resource.revision);
  const resourceFields = asObject(resource.fields);
  const revisionFields = asObject(revision?.fields);
  const statusNode = resolveStatusChangeNode(resourceFields, revisionFields, statusFieldRef);

  const oldStatus = normalizeText(statusNode?.oldValue);
  const newStatus = normalizeText(statusNode?.newValue ?? statusNode?.value);
  const transitioned = oldStatus !== newStatus;

  if (!transitioned || newStatus !== TARGET_STATUS) {
    return blocked(
      "NoStatusTransition",
      `Required transition to ReadyForAIImplementation was not detected (old='${oldStatus || "<empty>"}', new='${newStatus || "<empty>"}').`
    );
  }

  const workItemType = resolveWorkItemType(resource, revisionFields);
  if (!USER_STORY_TYPES.has(workItemType)) {
    return blocked(
      "WrongType",
      `Work item type '${workItemType || "<empty>"}' is not eligible. Only User Story is supported in MVP.`
    );
  }

  const workItemId = Number(resource.workItemId ?? resource.id ?? 0);
  const revisionNumber = Number(resource.rev ?? revision?.id ?? 0);
  if (!Number.isFinite(workItemId) || workItemId <= 0 || !Number.isFinite(revisionNumber) || revisionNumber <= 0) {
    return blocked("InvalidPayload", "Work item ID or revision is missing/invalid.");
  }

  return {
    eligible: true,
    reasonCode: "",
    reasonMessage: "",
    workItemType,
    oldStatus,
    newStatus,
    workItemId: Math.floor(workItemId),
    revision: Math.floor(revisionNumber)
  };
}

export function buildSkipKey(args) {
  return [
    "ai-impl-skip",
    String(args.workItemId || ""),
    String(args.revision || ""),
    String(args.reasonCode || "")
  ].join(":").toLowerCase();
}

export function buildStatusReasonMessage(args) {
  const reasonDescription = reasonCatalog[args.reasonCode] || "Skipped: policy gate blocked execution.";
  return [
    `[AI-IMPL-SKIP] key=${args.skipKey}`,
    `code=${args.reasonCode}`,
    reasonDescription,
    args.detail || ""
  ].filter(Boolean).join(" | ");
}

function blocked(reasonCode, detail) {
  return {
    eligible: false,
    reasonCode,
    reasonMessage: detail,
    workItemType: "",
    oldStatus: "",
    newStatus: "",
    workItemId: 0,
    revision: 0
  };
}

function resolveWorkItemType(resource, revisionFields) {
  const revisionTypeRaw = revisionFields?.["System.WorkItemType"];
  const revisionTypeNode = asObject(revisionTypeRaw);
  const fromRevision = normalizeText(
    revisionTypeNode ? (revisionTypeNode.newValue ?? revisionTypeNode.value) : revisionTypeRaw
  );
  if (fromRevision) {
    return fromRevision;
  }

  const fields = asObject(resource.fields);
  const resourceTypeRaw = fields?.["System.WorkItemType"];
  const resourceTypeNode = asObject(resourceTypeRaw);
  const fromResource = normalizeText(
    resourceTypeNode ? (resourceTypeNode.newValue ?? resourceTypeNode.value) : resourceTypeRaw
  );
  return fromResource;
}

function resolveStatusChangeNode(resourceFields, revisionFields, statusFieldRefName) {
  const candidates = buildStatusFieldCandidates(statusFieldRefName);

  // Primary source: ADO update payload change nodes include old/new under resource.fields.
  const fromResourceFields = resolveFieldNode(resourceFields, candidates, true);
  if (fromResourceFields) {
    return fromResourceFields;
  }

  // Fallback: some payloads may only provide revision.fields values.
  return resolveFieldNode(revisionFields, candidates, false);
}

function resolveFieldNode(fields, candidates, requireChangeNode) {
  if (!fields) {
    return null;
  }

  for (const candidate of candidates) {
    const direct = asObject(fields[candidate]);
    if (isUsableStatusNode(direct, requireChangeNode)) {
      return direct;
    }
  }

  const normalizedCandidates = new Set(candidates.map(normalizeFieldRef));
  for (const [key, value] of Object.entries(fields)) {
    const node = asObject(value);
    if (!isUsableStatusNode(node, requireChangeNode)) {
      continue;
    }
    if (normalizedCandidates.has(normalizeFieldRef(key))) {
      return node;
    }
  }

  for (const [key, value] of Object.entries(fields)) {
    const normalizedKey = normalizeFieldRef(key);
    const node = asObject(value);
    if (!isUsableStatusNode(node, requireChangeNode)) {
      continue;
    }
    if (normalizedKey === "aiplanningstatus" || normalizedKey.endsWith(".aiplanningstatus")) {
      return node;
    }
  }

  return null;
}

function buildStatusFieldCandidates(statusFieldRefName) {
  const normalized = statusFieldRefName.trim();
  const candidates = new Set();
  if (normalized) {
    candidates.add(normalized);
    if (normalized.toLowerCase().startsWith("custom.")) {
      candidates.add(normalized.slice("custom.".length));
    } else {
      candidates.add(`Custom.${normalized}`);
    }
  }
  candidates.add("AIPlanningStatus");
  candidates.add("Custom.AIPlanningStatus");
  return Array.from(candidates);
}

function normalizeFieldRef(value) {
  return String(value || "").trim().toLowerCase();
}

function isUsableStatusNode(node, requireChangeNode) {
  if (!node) {
    return false;
  }

  const hasChange = Object.prototype.hasOwnProperty.call(node, "oldValue")
    || Object.prototype.hasOwnProperty.call(node, "newValue")
    || Object.prototype.hasOwnProperty.call(node, "value");
  if (requireChangeNode) {
    return hasChange;
  }

  return hasChange || Object.keys(node).length === 0;
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value;
}



