export function computeSkipReasonUpdate(existingValue, nextMessage, skipKey) {
  const existing = String(existingValue || "").trim();
  const normalizedKey = String(skipKey || "").trim();

  if (normalizedKey.length > 0 && existing.includes(normalizedKey)) {
    return {
      shouldUpdate: false,
      value: existing
    };
  }

  return {
    shouldUpdate: true,
    value: [existing, String(nextMessage || "").trim()].filter(Boolean).join("\n").trim()
  };
}

