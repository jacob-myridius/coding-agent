import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export async function walkDirectory(
  rootPath: string,
  includePaths: string[],
  filePatterns: string[],
  excludePatterns: string[]
): Promise<string[]> {
  const files: string[] = [];

  // If includePaths is empty, start from root
  const searchPaths = includePaths.length > 0
    ? includePaths.map(p => path.join(rootPath, p))
    : [rootPath];

  for (const searchPath of searchPaths) {
    await walkRecursive(searchPath, files, filePatterns, excludePatterns);
  }

  return files;
}

async function walkRecursive(
  dirPath: string,
  files: string[],
  filePatterns: string[],
  excludePatterns: string[]
): Promise<void> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      // Check if excluded
      if (shouldExclude(fullPath, excludePatterns)) {
        continue;
      }

      if (entry.isDirectory()) {
        await walkRecursive(fullPath, files, filePatterns, excludePatterns);
      } else if (entry.isFile()) {
        if (matchesPatterns(entry.name, filePatterns)) {
          files.push(fullPath);
        }
      }
    }
  } catch (error) {
    // Skip directories that can't be read
    console.warn(`Cannot read directory: ${dirPath}`);
  }
}

function shouldExclude(filePath: string, excludePatterns: string[]): boolean {
  for (const pattern of excludePatterns) {
    const regexPattern = pattern
      .replace(/\*\*/g, ".*")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, ".")
      .replace(/\//g, "\\/");

    if (new RegExp(regexPattern).test(filePath)) {
      return true;
    }
  }
  return false;
}

function matchesPatterns(fileName: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;

  for (const pattern of patterns) {
    // Simple extension matching
    if (pattern.startsWith(".") && fileName.endsWith(pattern)) {
      return true;
    }
    // Wildcard matching
    if (pattern.includes("*")) {
      const regexPattern = pattern
        .replace(/\./g, "\\.")
        .replace(/\*/g, ".*");
      if (new RegExp(`^${regexPattern}$`).test(fileName)) {
        return true;
      }
    }
  }

  return false;
}

