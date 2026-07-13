import { parse } from "@typescript-eslint/typescript-estree";
import type { CodeChunk, CodeParserResult } from "./codeIndexTypes.js";

export function parseTypeScriptFile(filePath: string, content: string): CodeParserResult {
  try {
    const ast = parse(content, {
      loc: true,
      range: true,
      comment: true,
      tokens: false
    });

    const chunks: CodeChunk[] = [];
    const imports: string[] = extractImports(content);
    const lines = content.split("\n");

    // Extract top-level declarations
    for (const node of ast.body) {
      const chunk = extractChunkFromNode(node, content, lines, imports);
      if (chunk) {
        chunks.push(chunk);
      }
    }

    // If no chunks extracted (e.g., only imports/comments), create single chunk
    if (chunks.length === 0 && content.trim().length > 0) {
      chunks.push(createFallbackChunk(content, lines, imports));
    }

    // Update chunk counts
    chunks.forEach((chunk, index) => {
      chunk.chunkIndex = index;
      chunk.chunkCount = chunks.length;
    });

    return {
      success: true,
      filePath,
      language: "typescript",
      chunks
    };
  } catch (error) {
    return {
      success: false,
      filePath,
      language: "typescript",
      error: error instanceof Error ? error.message : String(error),
      chunks: []
    };
  }
}

function extractChunkFromNode(node: any, content: string, lines: string[], imports: string[]): CodeChunk | null {
  if (!node.loc) return null;

  const startLine = node.loc.start.line;
  const endLine = node.loc.end.line;
  const chunkContent = lines.slice(startLine - 1, endLine).join("\n");

  // Determine code type and symbol name
  let codeType: CodeChunk["codeType"] = "other";
  let symbolName = "";
  let containsTests = false;
  let testFramework = "";

  switch (node.type) {
    case "FunctionDeclaration":
      codeType = "function";
      symbolName = node.id?.name || "anonymous";
      containsTests = isTestFunction(symbolName, chunkContent);
      if (containsTests) testFramework = detectTestFramework(content);
      break;
    case "ClassDeclaration":
      codeType = "class";
      symbolName = node.id?.name || "anonymous";
      containsTests = isTestClass(symbolName, chunkContent);
      if (containsTests) testFramework = detectTestFramework(content);
      break;
    case "InterfaceDeclaration":
    case "TSInterfaceDeclaration":
      codeType = "interface";
      symbolName = node.id?.name || "anonymous";
      break;
    case "TypeAliasDeclaration":
    case "TSTypeAliasDeclaration":
      codeType = "type";
      symbolName = node.id?.name || "anonymous";
      break;
    case "VariableDeclaration":
      codeType = "const";
      symbolName = extractVariableName(node);
      break;
    case "ExportNamedDeclaration":
    case "ExportDefaultDeclaration":
      if (node.declaration) {
        return extractChunkFromNode(node.declaration, content, lines, imports);
      }
      break;
  }

  const { hasComments, commentRatio } = analyzeComments(chunkContent);
  const linesOfCode = endLine - startLine + 1;

  return {
    chunkIndex: 0, // Will be set later
    chunkCount: 0, // Will be set later
    startLine,
    endLine,
    content: chunkContent,
    codeType,
    symbolName,
    imports,
    dependencies: extractDependencies(chunkContent),
    containsTests,
    testFramework,
    hasComments,
    commentRatio,
    linesOfCode
  };
}

function extractImports(content: string): string[] {
  const imports: string[] = [];
  const importRegex = /import\s+(?:{[^}]+}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/g;
  let match;

  while ((match = importRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }

  return imports;
}

function extractDependencies(content: string): string[] {
  const deps: string[] = [];
  // Extract referenced types/functions (simplified heuristic)
  const typeRegex = /:\s*([A-Z]\w+)/g;
  let match;

  while ((match = typeRegex.exec(content)) !== null) {
    if (!deps.includes(match[1])) {
      deps.push(match[1]);
    }
  }

  return deps.slice(0, 20); // Limit to top 20
}

function extractVariableName(node: any): string {
  if (node.declarations && node.declarations.length > 0) {
    const decl = node.declarations[0];
    if (decl.id && decl.id.name) {
      return decl.id.name;
    }
  }
  return "variable";
}

function isTestFunction(name: string, content: string): boolean {
  const testPatterns = [/test\(/i, /it\(/i, /describe\(/i, /@Test/, /\.test\./];
  return testPatterns.some(pattern => pattern.test(name) || pattern.test(content));
}

function isTestClass(name: string, content: string): boolean {
  return name.endsWith("Test") || name.endsWith("Tests") || name.includes("Test") || content.includes("@Test");
}

function detectTestFramework(content: string): string {
  if (content.includes("jest") || content.includes("@jest")) return "jest";
  if (content.includes("mocha")) return "mocha";
  if (content.includes("vitest")) return "vitest";
  if (content.includes("@testing-library")) return "testing-library";
  return "";
}

function analyzeComments(content: string): { hasComments: boolean; commentRatio: number } {
  const lines = content.split("\n");
  let commentLines = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      commentLines++;
    }
  }

  const hasComments = commentLines > 0;
  const commentRatio = lines.length > 0 ? commentLines / lines.length : 0;

  return { hasComments, commentRatio };
}

function createFallbackChunk(content: string, lines: string[], imports: string[]): CodeChunk {
  const { hasComments, commentRatio } = analyzeComments(content);

  return {
    chunkIndex: 0,
    chunkCount: 1,
    startLine: 1,
    endLine: lines.length,
    content,
    codeType: "other",
    symbolName: "",
    imports,
    dependencies: [],
    containsTests: false,
    testFramework: "",
    hasComments,
    commentRatio,
    linesOfCode: lines.length
  };
}

export function shouldIndexFile(filePath: string, excludePatterns: string[]): boolean {
  // Check if file matches exclude patterns
  for (const pattern of excludePatterns) {
    const regexPattern = pattern.replace(/\*/g, ".*").replace(/\//g, "\\/");
    if (new RegExp(regexPattern).test(filePath)) {
      return false;
    }
  }

  // Check if it's a supported file
  const supportedExtensions = [".ts", ".tsx", ".js", ".jsx"];
  return supportedExtensions.some(ext => filePath.endsWith(ext));
}

