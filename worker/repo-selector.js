/**
 * Selects one or more repositories from a list of ADO repositories based on the
 * work item's title, description, and type.
 *
 * Returns an array. Single-repo work items return a one-element array.
 * Work items that touch both frontend and backend concerns return multiple repos.
 *
 * Selection strategy:
 *  1. Score every active repo by keyword overlap with the work item
 *  2. Detect cross-cutting concerns (frontend + backend signals in the work item)
 *  3. If cross-cutting AND multiple repos score above threshold → return all relevant ones (max 3)
 *  4. Otherwise → return only the top-scoring repo
 *  5. Tie-break: alphabetical by name
 */

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "for", "on", "with",
  "is", "as", "at", "by", "be", "from", "that", "this", "it", "its",
  "are", "was", "were", "will", "has", "have", "had", "not", "but",
  "user", "story", "bug", "task", "feature", "epic", "implement", "add",
  "update", "fix", "create", "remove", "get", "set", "use", "new", "old"
]);

// Keywords strongly associated with frontend concerns
const FRONTEND_SIGNALS = new Set([
  "frontend", "front-end", "ui", "ux", "web", "client", "browser",
  "react", "vue", "angular", "next", "nuxt", "svelte",
  "page", "component", "view", "screen", "interface", "layout",
  "css", "html", "style", "design", "dashboard", "portal", "app"
]);

// Keywords strongly associated with backend concerns
const BACKEND_SIGNALS = new Set([
  "backend", "back-end", "api", "service", "server", "database", "db",
  "endpoint", "rest", "graphql", "grpc", "microservice",
  "lambda", "function", "worker", "queue", "event", "webhook",
  "repository", "dao", "model", "schema", "migration", "query"
]);

// Minimum score for a repo to be included in multi-repo selection
const MULTI_REPO_MIN_SCORE = 3;

/**
 * @param {Array<{id: string, name: string, isDisabled?: boolean, defaultBranch?: string}>} repos
 * @param {{ title: string, description: string, workItemType: string }} workItem
 * @returns {Array<{name: string, id: string, defaultBranch: string}>}
 */
export function selectRepositories(repos, workItem) {
  const active = repos.filter((r) => !r.isDisabled && r.name);
  if (active.length === 0) return [];
  if (active.length === 1) return active;

  const workItemText = `${workItem.title || ""} ${workItem.description || ""} ${workItem.workItemType || ""}`;
  const tokens = extractTokens(workItemText);

  const scored = active.map((repo) => {
    const repoTokens = extractTokens(repo.name);
    let score = 0;
    for (const rt of repoTokens) {
      if (tokens.has(rt)) score += 10;
    }
    const repoNameNorm = normalizeText(repo.name);
    for (const wt of tokens) {
      if (repoNameNorm.includes(wt)) score += 3;
    }
    return { repo, score };
  });

  scored.sort((a, b) => b.score - a.score || a.repo.name.localeCompare(b.repo.name));

  // When the work item signals cross-cutting concerns, include all repos that
  // score above the minimum threshold (capped at 3).
  if (isCrossCutting(workItemText) && scored.filter((s) => s.score >= MULTI_REPO_MIN_SCORE).length > 1) {
    const selected = scored
      .filter((s) => s.score >= MULTI_REPO_MIN_SCORE)
      .slice(0, 3)
      .map((s) => s.repo);

    console.log(
      `repo-selector: cross-cutting work item — selected ${selected.length} repos: ` +
      `[${selected.map((r) => r.name).join(", ")}]`
    );
    return selected;
  }

  // Default: single best-matching repo
  const chosen = scored[0].repo;
  console.log(
    `repo-selector: chose '${chosen.name}' (score=${scored[0].score}) from ${active.length} repos ` +
    `[${active.map((r) => r.name).join(", ")}]`
  );
  return [chosen];
}

/**
 * Returns true when the work item text contains signals from BOTH frontend and
 * backend domains, indicating that changes may be needed in multiple repos.
 */
function isCrossCutting(text) {
  const normalized = normalizeText(text);
  const words = new Set(normalized.split(/[\s\-_./\\]+/).filter((w) => w.length >= 2));

  const hasFrontend = [...FRONTEND_SIGNALS].some((s) => words.has(s) || normalized.includes(s));
  const hasBackend = [...BACKEND_SIGNALS].some((s) => words.has(s) || normalized.includes(s));

  return hasFrontend && hasBackend;
}

function extractTokens(text) {
  return new Set(
    normalizeText(text)
      .split(/[\s\-_./\\]+/)
      .filter((t) => t.length >= 3 && !STOP_WORDS.has(t))
  );
}

function normalizeText(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9\s\-_.]/g, "");
}
