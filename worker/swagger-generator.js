/**
 * swagger-generator.js
 *
 * Scans a repository workspace for HTTP route registrations and generates or
 * updates an openapi.yaml at the repo root. The file is committed via git so
 * it lands in the same commit as the implementation.
 *
 * Supports:
 *   - Node/Express  (app.get/post/put/delete/patch, router.*)
 *   - Java/Spring   (@GetMapping, @PostMapping, @PutMapping, @DeleteMapping,
 *                    @PatchMapping, @RequestMapping)
 *   - Python/FastAPI (app.get/post/put/delete/patch decorator pattern)
 *   - Python/Flask  (app.route, @app.get/post/...)
 *
 * The function is intentionally best-effort: it returns without throwing when
 * no routes are found or when the yaml write/commit fails.
 */

import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { simpleGit } from "simple-git";

// ---------------------------------------------------------------------------
// Route detection patterns (per language)
// ---------------------------------------------------------------------------

// Each entry: { method, pathCapture } — pathCapture is a regex applied to the
// matched line to extract the route path string.
const PATTERNS = {
  node: [
    // Express: app.get('/path', ...) or router.post('/path', ...)
    /(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
  ],
  java: [
    // Spring: @GetMapping("/path") or @RequestMapping(value="/path", method=...)
    /@(Get|Post|Put|Delete|Patch)Mapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/gi,
    /@RequestMapping\s*\([^)]*value\s*=\s*["']([^"']+)["'][^)]*method\s*=\s*RequestMethod\.(\w+)/gi,
  ],
  python: [
    // FastAPI / Flask decorators: @app.get("/path") or @router.post("/path")
    /@(?:app|router|blueprint)\.(get|post|put|delete|patch)\s*\(\s*["']([^"']+)["']/gi,
    // Flask @app.route("/path", methods=["GET"])
    /@(?:app|bp)\.route\s*\(\s*["']([^"']+)["'][^)]*methods\s*=\s*\[([^\]]+)\]/gi,
  ],
};

const HTTP_METHODS = new Set(["get", "post", "put", "delete", "patch"]);

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

async function detectLanguage(workspacePath) {
  // Check TECHSTACK.md first (written by the implementation prompt)
  try {
    const techstack = await readFile(path.join(workspacePath, "TECHSTACK.md"), "utf8");
    const lower = techstack.toLowerCase();
    if (lower.includes("java") || lower.includes("spring")) return "java";
    if (lower.includes("python") || lower.includes("fastapi") || lower.includes("flask")) return "python";
    if (lower.includes("node") || lower.includes("express") || lower.includes("javascript") || lower.includes("typescript")) return "node";
  } catch {
    // fall through to file-extension detection
  }

  // Fallback: check presence of characteristic files
  try {
    const entries = await readdir(workspacePath);
    if (entries.some((e) => e === "pom.xml" || e === "build.gradle")) return "java";
    if (entries.some((e) => e === "requirements.txt" || e === "pyproject.toml" || e === "setup.py")) return "python";
    if (entries.some((e) => e === "package.json")) return "node";
  } catch {
    // ignore
  }

  return "node"; // default
}

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "__pycache__", ".mypy_cache", "target", ".gradle"]);

async function collectSourceFiles(dir, exts, collected = []) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return collected;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    let info;
    try { info = await stat(full); } catch { continue; }
    if (info.isDirectory()) {
      await collectSourceFiles(full, exts, collected);
    } else if (exts.some((ext) => entry.endsWith(ext))) {
      collected.push(full);
    }
  }
  return collected;
}

function extensionsForLanguage(lang) {
  if (lang === "java") return [".java"];
  if (lang === "python") return [".py"];
  return [".js", ".ts", ".mjs", ".cjs"];
}

// ---------------------------------------------------------------------------
// Route extraction
// ---------------------------------------------------------------------------

function extractRoutesFromContent(content, language) {
  const routes = [];

  if (language === "node") {
    const pattern = /(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
    let m;
    while ((m = pattern.exec(content)) !== null) {
      routes.push({ method: m[1].toLowerCase(), path: m[2] });
    }
  } else if (language === "java") {
    // @GetMapping("/path")
    const singleMethodPattern = /@(Get|Post|Put|Delete|Patch)Mapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/gi;
    let m;
    while ((m = singleMethodPattern.exec(content)) !== null) {
      routes.push({ method: m[1].toLowerCase(), path: m[2] });
    }
    // @RequestMapping(value="/path", method=RequestMethod.GET)
    const requestMappingPattern = /@RequestMapping\s*\([^)]*value\s*=\s*["']([^"']+)["'][^)]*method\s*=\s*RequestMethod\.(\w+)/gi;
    while ((m = requestMappingPattern.exec(content)) !== null) {
      const method = m[2].toLowerCase();
      if (HTTP_METHODS.has(method)) {
        routes.push({ method, path: m[1] });
      }
    }
  } else if (language === "python") {
    // @app.get("/path") etc
    const decoratorPattern = /@(?:app|router|blueprint|bp)\.(get|post|put|delete|patch)\s*\(\s*["']([^"']+)["']/gi;
    let m;
    while ((m = decoratorPattern.exec(content)) !== null) {
      routes.push({ method: m[1].toLowerCase(), path: m[2] });
    }
    // @app.route("/path", methods=["GET", "POST"])
    const routePattern = /@(?:app|bp)\.route\s*\(\s*["']([^"']+)["'][^)]*methods\s*=\s*\[([^\]]+)\]/gi;
    while ((m = routePattern.exec(content)) !== null) {
      const routePath = m[1];
      const methodsRaw = m[2];
      const methods = methodsRaw.match(/["'](\w+)["']/g) || [];
      for (const meth of methods) {
        const cleaned = meth.replace(/["']/g, "").toLowerCase();
        if (HTTP_METHODS.has(cleaned)) {
          routes.push({ method: cleaned, path: routePath });
        }
      }
    }
  }

  return routes;
}

// ---------------------------------------------------------------------------
// OpenAPI YAML builder
// ---------------------------------------------------------------------------

function buildOpenApiYaml(routes, title) {
  // Deduplicate by method+path
  const seen = new Set();
  const unique = routes.filter(({ method, path: p }) => {
    const key = `${method}:${p}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (unique.length === 0) return null;

  // Group by path
  const byPath = {};
  for (const { method, path: p } of unique) {
    if (!byPath[p]) byPath[p] = [];
    byPath[p].push(method);
  }

  const lines = [
    "openapi: '3.0.3'",
    "info:",
    `  title: '${title.replace(/'/g, "''")}'`,
    "  version: '1.0.0'",
    "paths:",
  ];

  for (const [routePath, methods] of Object.entries(byPath).sort(([a], [b]) => a.localeCompare(b))) {
    // Convert Express-style :param to OpenAPI {param}
    const oapiPath = routePath.replace(/:(\w+)/g, "{$1}");
    lines.push(`  '${oapiPath}':`);
    for (const method of methods.sort()) {
      const operationId = `${method}_${oapiPath.replace(/[^a-zA-Z0-9]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "")}`;
      lines.push(`    ${method}:`);
      lines.push(`      operationId: '${operationId}'`);
      lines.push(`      summary: 'Auto-generated from route: ${method.toUpperCase()} ${routePath}'`);
      lines.push(`      responses:`);
      lines.push(`        '200':`);
      lines.push(`          description: Success`);
    }
  }

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Scans the workspace for HTTP route registrations and writes/updates
 * openapi.yaml at the repo root. Commits the file via git.
 *
 * @param {string} workspacePath  Absolute path to the cloned repo directory
 * @param {string} [language]     Override language detection ('node'|'java'|'python')
 */
export async function generateOpenApiSpec(workspacePath, language) {
  try {
    const lang = language || await detectLanguage(workspacePath);
    const exts = extensionsForLanguage(lang);
    const files = await collectSourceFiles(workspacePath, exts);

    const allRoutes = [];
    for (const file of files) {
      try {
        const content = await readFile(file, "utf8");
        const routes = extractRoutesFromContent(content, lang);
        allRoutes.push(...routes);
      } catch {
        // skip unreadable files
      }
    }

    if (allRoutes.length === 0) {
      console.log("[swagger-generator] No HTTP routes detected — skipping openapi.yaml generation.");
      return;
    }

    // Derive a title from the workspace folder name (last segment of path)
    const title = path.basename(workspacePath).replace(/[^a-zA-Z0-9 _-]/g, " ").trim() || "API";
    const yaml = buildOpenApiYaml(allRoutes, title);
    if (!yaml) return;

    const outPath = path.join(workspacePath, "openapi.yaml");
    await writeFile(outPath, yaml, "utf8");
    console.log(`[swagger-generator] Wrote openapi.yaml (${allRoutes.length} routes detected).`);

    // Commit the file via git
    const git = simpleGit(workspacePath);
    await git.add("openapi.yaml");
    const status = await git.status();
    if (status.staged.length > 0) {
      await git.commit("chore: update openapi.yaml [automated]", ["--no-verify"]);
      console.log("[swagger-generator] Committed openapi.yaml.");
    } else {
      console.log("[swagger-generator] openapi.yaml unchanged — no commit needed.");
    }
  } catch (err) {
    // Non-fatal — log and continue
    console.warn(`[swagger-generator] Failed to generate openapi.yaml: ${err.message}`);
  }
}
