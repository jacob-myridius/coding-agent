/**
 * Self-contained code context retrieval for the worker.
 * Queries Azure AI Search when configured; returns "" when not configured.
 * No dependencies on compiled TypeScript output from ../src/.
 */

const CODE_SEARCH_ENDPOINT = (process.env.CODE_SEARCH_ENDPOINT || "").trim();
const CODE_SEARCH_API_KEY = (process.env.CODE_SEARCH_API_KEY || "").trim();
const CODE_SEARCH_INDEX_NAME = (process.env.CODE_SEARCH_INDEX_NAME || "").trim();
// Set CODE_SEARCH_SEMANTIC=true to enable semantic search (requires Standard tier or above).
// When enabled, CODE_SEARCH_SEMANTIC_CONFIG names the semantic configuration (default: "code-semantic-config").
const CODE_SEARCH_SEMANTIC = (process.env.CODE_SEARCH_SEMANTIC || "").trim().toLowerCase() === "true";
const CODE_SEARCH_SEMANTIC_CONFIG = (process.env.CODE_SEARCH_SEMANTIC_CONFIG || "code-semantic-config").trim();

const isEnabled = Boolean(CODE_SEARCH_ENDPOINT && CODE_SEARCH_API_KEY && CODE_SEARCH_INDEX_NAME);

if (!isEnabled) {
  console.log("code_retrieval_disabled", {
    reason: "CODE_SEARCH_ENDPOINT, CODE_SEARCH_API_KEY, or CODE_SEARCH_INDEX_NAME not configured"
  });
} else {
  console.log("code_retrieval_enabled", {
    index: CODE_SEARCH_INDEX_NAME,
    semantic: CODE_SEARCH_SEMANTIC,
    ...(CODE_SEARCH_SEMANTIC && { semanticConfig: CODE_SEARCH_SEMANTIC_CONFIG })
  });
}

/**
 * Retrieve relevant code context for a work item implementation.
 * @param {{ org: string, project: string, repo: string, title: string, description: string, language?: string }} options
 * @returns {Promise<string>}
 */
export async function getCodeContext(options) {
  if (!isEnabled) return "";

  const query = buildSearchQuery(options.title, options.description);
  if (!query) return "";

  console.log("code_retrieval_started", {
    org: options.org,
    repo: options.repo,
    query: query.substring(0, 100)
  });

  try {
    const filters = [
      `org eq '${escapeOData(options.org)}'`,
      `project eq '${escapeOData(options.project)}'`,
      `repo eq '${escapeOData(options.repo)}'`
    ];
    if (options.language) {
      filters.push(`language eq '${escapeOData(options.language)}'`);
    }

    const url = `${CODE_SEARCH_ENDPOINT}/indexes/${CODE_SEARCH_INDEX_NAME}/docs/search?api-version=2024-07-01`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": CODE_SEARCH_API_KEY
      },
      body: JSON.stringify({
        search: query,
        filter: filters.join(" and "),
        searchMode: "all",
        queryType: CODE_SEARCH_SEMANTIC ? "semantic" : "simple",
        ...(CODE_SEARCH_SEMANTIC && { semanticConfiguration: CODE_SEARCH_SEMANTIC_CONFIG }),
        top: 5,
        // Omit $select — return all fields; avoids failure when index schema differs
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Code search failed: ${response.status} ${error}`);
    }

    const data = await response.json();
    const matches = Array.isArray(data.value) ? data.value : [];

    console.log("code_retrieval_completed", { matches: matches.length });

    if (matches.length === 0) return "";

    return formatResults(matches);
  } catch (error) {
    console.error("code_retrieval_error", { error: error.message });
    return "";
  }
}

function buildSearchQuery(title, description) {
  const text = `${title || ""} ${description || ""}`.replace(/<[^>]*>/g, " ");
  const words = text
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 3)
    .filter((w) => !/^(the|and|or|for|with|from|this|that|then|when|where)$/i.test(w));
  return words.slice(0, 10).join(" ");
}

function formatResults(matches) {
  const lines = ["### Relevant Code Examples from This Codebase\n"];
  lines.push(`Found ${matches.length} relevant code snippet(s):\n`);
  for (let i = 0; i < Math.min(matches.length, 5); i++) {
    const m = matches[i];
    const title = m.symbolName ? `${m.symbolName} (${m.codeType})` : m.fileName;
    lines.push(`\n#### ${i + 1}. ${title}`);
    lines.push(`**File:** \`${m.filePath}\` (lines ${m.startLine}-${m.endLine})`);
    lines.push(`**Language:** ${m.language}\n`);
    lines.push("```" + (m.language || ""));
    lines.push(m.content || "");
    lines.push("```\n");
  }
  if (matches.length > 5) {
    lines.push(`\n_... and ${matches.length - 5} more relevant examples_\n`);
  }
  return lines.join("\n");
}

function escapeOData(value) {
  return String(value || "").replace(/'/g, "''");
}
