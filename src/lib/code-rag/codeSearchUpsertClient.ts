import type { AppConfig } from "../config/env.js";
import type { CodeSearchDocument } from "./codeIndexTypes.js";

export type CodeSearchUpsertClient = {
  isEnabled: boolean;
  reasonIfDisabled: string;
  upsertDocuments(documents: CodeSearchDocument[]): Promise<void>;
};

export function createCodeSearchUpsertClient(config: AppConfig): CodeSearchUpsertClient {
  const endpoint = config.codeSearchEndpoint?.trim();
  const apiKey = config.codeSearchApiKey?.trim();
  const indexName = config.codeSearchIndexName?.trim();

  if (!endpoint || !apiKey || !indexName) {
    return {
      isEnabled: false,
      reasonIfDisabled: "Code search endpoint, API key, or index name not configured",
      async upsertDocuments(): Promise<void> {
        // No-op
      }
    };
  }

  return {
    isEnabled: true,
    reasonIfDisabled: "",
    async upsertDocuments(documents: CodeSearchDocument[]): Promise<void> {
      if (documents.length === 0) return;

      const url = `${endpoint}/indexes/${indexName}/docs/index?api-version=2024-07-01`;

      const body = JSON.stringify({
        value: documents
      });

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": apiKey
        },
        body
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Code search upsert failed: ${response.status} ${error}`);
      }
    }
  };
}

