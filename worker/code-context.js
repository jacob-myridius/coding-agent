// Code retrieval integration for worker (JavaScript wrapper)
// This module provides code context retrieval for implementation prompts

import { createCodeRetrievalService, formatCodeContextForPrompt } from "../src/lib/code-rag/codeRetrievalService.js";
import { getConfig } from "../src/lib/config/env.js";

const config = getConfig();
const codeRetrievalService = createCodeRetrievalService(config);

/**
 * Retrieve relevant code context for a work item implementation
 * @param {Object} options - Retrieval options
 * @param {string} options.org - Azure DevOps organization
 * @param {string} options.project - Azure DevOps project
 * @param {string} options.repo - Repository name
 * @param {string} options.title - Work item title
 * @param {string} options.description - Work item description
 * @param {string} [options.language] - Filter by language (optional)
 * @returns {Promise<string>} Formatted code context for prompt
 */
export async function getCodeContext(options) {
  if (!codeRetrievalService.isEnabled) {
    console.log("code_retrieval_disabled", { reason: codeRetrievalService.reasonIfDisabled });
    return "";
  }

  try {
    // Build search query from work item details
    const query = buildSearchQuery(options.title, options.description);

    if (!query) {
      return "";
    }

    console.log("code_retrieval_started", {
      org: options.org,
      repo: options.repo,
      query: query.substring(0, 100)
    });

    const result = await codeRetrievalService.retrieve({
      org: options.org,
      project: options.project,
      repo: options.repo,
      query,
      language: options.language || undefined,
      excludeTests: false, // Include tests as they show patterns
      top: 5
    });

    console.log("code_retrieval_completed", {
      matches: result.matches.length,
      executionTimeMs: result.executionTimeMs
    });

    if (result.matches.length === 0) {
      return "";
    }

    // Format for prompt
    return formatCodeContextForPrompt(result);
  } catch (error) {
    console.error("code_retrieval_error", {
      error: error.message
    });
    return "";
  }
}

/**
 * Build a search query from work item details
 * @param {string} title - Work item title
 * @param {string} description - Work item description
 * @returns {string} Search query
 */
function buildSearchQuery(title, description) {
  // Extract key technical terms from title and description
  const text = `${title} ${description}`;

  // Remove HTML tags
  const cleanText = text.replace(/<[^>]*>/g, " ");

  // Extract meaningful terms (simplified)
  const words = cleanText
    .split(/\s+/)
    .map(w => w.trim())
    .filter(w => w.length > 3) // Skip short words
    .filter(w => !/^(the|and|or|for|with|from|this|that|then|when|where)$/i.test(w)); // Skip common words

  // Take first 10 meaningful words
  const query = words.slice(0, 10).join(" ");

  return query;
}

export { codeRetrievalService };

