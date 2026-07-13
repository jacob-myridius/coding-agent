import type { AppConfig } from "../config/env.js";
import type { CodeRetrievalRequest, CodeRetrievalResult, CodeRetrievalMatch } from "./codeIndexTypes.js";

export type CodeRetrievalService = {
  isEnabled: boolean;
  reasonIfDisabled: string;
  retrieve(request: CodeRetrievalRequest): Promise<CodeRetrievalResult>;
};

export function createCodeRetrievalService(config: AppConfig): CodeRetrievalService {
  const endpoint = config.codeSearchEndpoint?.trim();
  const apiKey = config.codeSearchApiKey?.trim();
  const indexName = config.codeSearchIndexName?.trim();

  if (!endpoint || !apiKey || !indexName) {
    return {
      isEnabled: false,
      reasonIfDisabled: "Code search endpoint, API key, or index name not configured",
      async retrieve(): Promise<CodeRetrievalResult> {
        return emptyResult("");
      }
    };
  }

  return {
    isEnabled: true,
    reasonIfDisabled: "",
    async retrieve(request: CodeRetrievalRequest): Promise<CodeRetrievalResult> {
      const startTime = Date.now();

      try {
        const query = request.query.trim();
        if (!query) {
          return emptyResult(query);
        }

        const top = Math.min(request.top || 10, 50); // Max 50 results

        // Build search request
        const searchRequest = buildSearchRequest(request, top, config);

        // Execute search
        const url = `${endpoint}/indexes/${indexName}/docs/search?api-version=2024-07-01`;
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "api-key": apiKey
          },
          body: JSON.stringify(searchRequest)
        });

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Code search failed: ${response.status} ${error}`);
        }

        const result: any = await response.json();

        // Parse results
        const matches = parseSearchResults(result, request);

        return {
          matches,
          totalMatches: result["@odata.count"] || matches.length,
          query,
          executionTimeMs: Date.now() - startTime
        };
      } catch (error) {
        console.error("Code retrieval error:", error);
        return emptyResult(request.query);
      }
    }
  };
}

function buildSearchRequest(request: CodeRetrievalRequest, top: number, _config: AppConfig): any {
  // Build filter conditions
  const filters: string[] = [];

  filters.push(`org eq '${escapeODataString(request.org)}'`);
  filters.push(`project eq '${escapeODataString(request.project)}'`);
  filters.push(`repo eq '${escapeODataString(request.repo)}'`);

  if (request.language) {
    filters.push(`language eq '${escapeODataString(request.language)}'`);
  }

  if (request.codeType) {
    filters.push(`codeType eq '${escapeODataString(request.codeType)}'`);
  }

  if (request.filePattern) {
    // Convert glob pattern to OData search
    const pattern = request.filePattern.replace(/\*/g, "");
    filters.push(`search.ismatch('${escapeODataString(pattern)}', 'filePath')`);
  }

  if (request.excludeTests) {
    filters.push(`containsTests eq false`);
  }

  return {
    search: request.query,
    filter: filters.join(" and "),
    searchMode: "all",
    queryType: "semantic",
    semanticConfiguration: "code-semantic-config",
    top,
    select: [
      "filePath",
      "fileName",
      "startLine",
      "endLine",
      "content",
      "language",
      "codeType",
      "symbolName"
    ].join(","),
    highlight: "content",
    highlightPreTag: "<mark>",
    highlightPostTag: "</mark>"
  };
}

function parseSearchResults(result: any, _request: CodeRetrievalRequest): CodeRetrievalMatch[] {
  const matches: CodeRetrievalMatch[] = [];

  if (!result.value || !Array.isArray(result.value)) {
    return matches;
  }

  for (const doc of result.value) {
    const highlights = doc["@search.highlights"]?.content || [];

    matches.push({
      filePath: doc.filePath || "",
      fileName: doc.fileName || "",
      startLine: doc.startLine || 0,
      endLine: doc.endLine || 0,
      content: doc.content || "",
      language: doc.language || "",
      codeType: doc.codeType || "other",
      symbolName: doc.symbolName || "",
      score: doc["@search.score"] || 0,
      highlights: highlights
    });
  }

  return matches;
}

function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}

function emptyResult(query: string): CodeRetrievalResult {
  return {
    matches: [],
    totalMatches: 0,
    query,
    executionTimeMs: 0
  };
}

// Helper function to format code context for prompts
export function formatCodeContextForPrompt(result: CodeRetrievalResult): string {
  if (result.matches.length === 0) {
    return "No relevant code examples found in the codebase.";
  }

  const sections: string[] = [];

  sections.push("### Relevant Code Examples from This Codebase\n");
  sections.push(`Found ${result.matches.length} relevant code snippet(s):\n`);

  for (let i = 0; i < Math.min(result.matches.length, 5); i++) {
    const match = result.matches[i];
    const title = match.symbolName
      ? `${match.symbolName} (${match.codeType})`
      : match.fileName;

    sections.push(`\n#### ${i + 1}. ${title}`);
    sections.push(`**File:** \`${match.filePath}\` (lines ${match.startLine}-${match.endLine})`);
    sections.push(`**Language:** ${match.language}\n`);
    sections.push("```" + match.language);
    sections.push(match.content);
    sections.push("```\n");
  }

  if (result.matches.length > 5) {
    sections.push(`\n_... and ${result.matches.length - 5} more relevant examples_\n`);
  }

  return sections.join("\n");
}

