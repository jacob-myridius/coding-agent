// Type definitions for code repository RAG indexing

export type CodeIndexEvent = {
  eventType: "code.index-requested";
  org: string;
  project: string;
  repo: string;
  branch: string;
  commitSha: string;
  paths: string[];
  filePatterns: string[];
  fullReindex: boolean;
  requestedBy: string;
  requestTimestampUtc: string;
};

export type CodeSearchDocument = {
  "@search.action": "mergeOrUpload";

  // Identity
  id: string;
  sourceType: "code";

  // Repository context
  org: string;
  project: string;
  repo: string;
  branch: string;
  commitSha: string;

  // File context
  filePath: string;
  fileExtension: string;
  fileName: string;
  directory: string;

  // Code chunk
  chunkIndex: number;
  chunkCount: number;
  startLine: number;
  endLine: number;
  content: string;
  contentVector: number[];

  // Code metadata
  language: string;
  codeType: "function" | "class" | "interface" | "type" | "const" | "test" | "config" | "other";
  symbolName: string;
  imports: string[];
  dependencies: string[];

  // Context flags
  containsTests: boolean;
  testFramework: string;
  hasComments: boolean;
  commentRatio: number;

  // Quality indicators
  linesOfCode: number;

  // Timestamps
  lastModifiedUtc: string;
  indexedAtUtc: string;
};

export type ParsedCodeFile = {
  filePath: string;
  fileName: string;
  directory: string;
  extension: string;
  language: string;
  content: string;
  lastModifiedUtc: string;
  chunks: CodeChunk[];
};

export type CodeChunk = {
  chunkIndex: number;
  chunkCount: number;
  startLine: number;
  endLine: number;
  content: string;
  codeType: CodeSearchDocument["codeType"];
  symbolName: string;
  imports: string[];
  dependencies: string[];
  containsTests: boolean;
  testFramework: string;
  hasComments: boolean;
  commentRatio: number;
  linesOfCode: number;
};

export type CodeParserResult = {
  success: boolean;
  filePath: string;
  language: string;
  error?: string;
  chunks: CodeChunk[];
};

export type CodeIndexingStats = {
  filesProcessed: number;
  filesSkipped: number;
  filesFailed: number;
  chunksExtracted: number;
  documentsUpserted: number;
  totalLines: number;
  processingTimeMs: number;
};

export type CodeRetrievalRequest = {
  org: string;
  project: string;
  repo: string;
  query: string;
  language?: string;
  codeType?: string;
  filePattern?: string;
  excludeTests?: boolean;
  top?: number;
};

export type CodeRetrievalMatch = {
  filePath: string;
  fileName: string;
  startLine: number;
  endLine: number;
  content: string;
  language: string;
  codeType: string;
  symbolName: string;
  score: number;
  highlights?: string[];
};

export type CodeRetrievalResult = {
  matches: CodeRetrievalMatch[];
  totalMatches: number;
  query: string;
  executionTimeMs: number;
};

