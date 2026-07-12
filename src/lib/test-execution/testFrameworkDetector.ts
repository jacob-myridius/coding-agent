/**
 * Test Framework Detector
 * Detects which test framework is used in a repository
 */

import { readFile, access } from 'fs/promises';
import { join } from 'path';
import { TestFramework, TestFrameworkInfo } from './types.js';

/**
 * Detect test framework in a repository
 * @param workspacePath Path to repository workspace
 * @returns Detected framework information
 */
export async function detectTestFramework(workspacePath: string): Promise<TestFrameworkInfo> {
  // Try Node.js/TypeScript frameworks first
  const nodeInfo = await detectNodeFramework(workspacePath);
  if (nodeInfo.framework !== TestFramework.UNKNOWN) {
    return nodeInfo;
  }

  // Try Java frameworks
  const javaInfo = await detectJavaFramework(workspacePath);
  if (javaInfo.framework !== TestFramework.UNKNOWN) {
    return javaInfo;
  }

  // Try .NET frameworks
  const dotnetInfo = await detectDotNetFramework(workspacePath);
  if (dotnetInfo.framework !== TestFramework.UNKNOWN) {
    return dotnetInfo;
  }

  // Try Python frameworks
  const pythonInfo = await detectPythonFramework(workspacePath);
  if (pythonInfo.framework !== TestFramework.UNKNOWN) {
    return pythonInfo;
  }

  // No framework detected
  return {
    framework: TestFramework.UNKNOWN,
    confidence: 0
  };
}

/**
 * Detect Node.js/TypeScript test frameworks (Vitest, Jest)
 */
async function detectNodeFramework(workspacePath: string): Promise<TestFrameworkInfo> {
  const packageJsonPath = join(workspacePath, 'package.json');

  try {
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf-8'));
    const deps = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies
    };
    const scripts = packageJson.scripts || {};

    // Check for Vitest
    if (deps['vitest']) {
      const configFile = await findFile(workspacePath, [
        'vitest.config.ts',
        'vitest.config.js',
        'vitest.config.mjs'
      ]);

      return {
        framework: TestFramework.VITEST,
        configFile,
        testCommand: scripts['test'] || 'vitest run',
        coverageCommand: scripts['test:coverage'] || 'vitest run --coverage',
        confidence: 0.95
      };
    }

    // Check for Jest
    if (deps['jest'] || deps['@jest/core']) {
      const configFile = await findFile(workspacePath, [
        'jest.config.ts',
        'jest.config.js',
        'jest.config.json'
      ]);

      return {
        framework: TestFramework.JEST,
        configFile,
        testCommand: scripts['test'] || 'jest',
        coverageCommand: scripts['test:coverage'] || 'jest --coverage',
        confidence: 0.95
      };
    }

    // Check scripts for hints
    const testScript = scripts['test'] || '';
    if (testScript.includes('vitest')) {
      return {
        framework: TestFramework.VITEST,
        testCommand: testScript,
        confidence: 0.7
      };
    }
    if (testScript.includes('jest')) {
      return {
        framework: TestFramework.JEST,
        testCommand: testScript,
        confidence: 0.7
      };
    }

  } catch (error) {
    // package.json not found or invalid
  }

  return { framework: TestFramework.UNKNOWN, confidence: 0 };
}

/**
 * Detect Java test frameworks (JUnit)
 */
async function detectJavaFramework(workspacePath: string): Promise<TestFrameworkInfo> {
  const pomPath = join(workspacePath, 'pom.xml');

  try {
    await access(pomPath);
    const pomContent = await readFile(pomPath, 'utf-8');

    // Check for JUnit
    if (pomContent.includes('junit') || pomContent.includes('JUnit')) {
      return {
        framework: TestFramework.JUNIT,
        configFile: 'pom.xml',
        testCommand: 'mvn test',
        coverageCommand: 'mvn test jacoco:report',
        confidence: 0.9
      };
    }
  } catch (error) {
    // pom.xml not found
  }

  // Check for Gradle
  const gradleFiles = ['build.gradle', 'build.gradle.kts'];
  for (const gradleFile of gradleFiles) {
    try {
      const gradlePath = join(workspacePath, gradleFile);
      await access(gradlePath);
      const gradleContent = await readFile(gradlePath, 'utf-8');

      if (gradleContent.includes('junit')) {
        return {
          framework: TestFramework.JUNIT,
          configFile: gradleFile,
          testCommand: './gradlew test',
          coverageCommand: './gradlew test jacocoTestReport',
          confidence: 0.9
        };
      }
    } catch (error) {
      // File not found
    }
  }

  return { framework: TestFramework.UNKNOWN, confidence: 0 };
}

/**
 * Detect .NET test frameworks (NUnit, xUnit)
 */
async function detectDotNetFramework(workspacePath: string): Promise<TestFrameworkInfo> {
  try {
    // Look for .csproj files
    const { readdir } = await import('fs/promises');
    const files = await readdir(workspacePath);
    const csprojFiles = files.filter(f => f.endsWith('.csproj'));

    for (const csprojFile of csprojFiles) {
      const csprojPath = join(workspacePath, csprojFile);
      const csprojContent = await readFile(csprojPath, 'utf-8');

      if (csprojContent.includes('NUnit') || csprojContent.includes('nunit')) {
        return {
          framework: TestFramework.NUNIT,
          configFile: csprojFile,
          testCommand: 'dotnet test',
          coverageCommand: 'dotnet test --collect:"XPlat Code Coverage"',
          confidence: 0.9
        };
      }
    }
  } catch (error) {
    // Directory read error
  }

  return { framework: TestFramework.UNKNOWN, confidence: 0 };
}

/**
 * Detect Python test frameworks (pytest)
 */
async function detectPythonFramework(workspacePath: string): Promise<TestFrameworkInfo> {
  // Check for requirements.txt or setup.py
  const requirementsPath = join(workspacePath, 'requirements.txt');
  const setupPath = join(workspacePath, 'setup.py');
  const pyprojectPath = join(workspacePath, 'pyproject.toml');

  try {
    // Check requirements.txt
    await access(requirementsPath);
    const requirements = await readFile(requirementsPath, 'utf-8');

    if (requirements.includes('pytest')) {
      const configFile = await findFile(workspacePath, [
        'pytest.ini',
        'pyproject.toml',
        'setup.cfg'
      ]);

      return {
        framework: TestFramework.PYTEST,
        configFile,
        testCommand: 'pytest',
        coverageCommand: 'pytest --cov',
        confidence: 0.9
      };
    }
  } catch (error) {
    // requirements.txt not found
  }

  try {
    // Check setup.py
    await access(setupPath);
    const setupContent = await readFile(setupPath, 'utf-8');

    if (setupContent.includes('pytest')) {
      return {
        framework: TestFramework.PYTEST,
        configFile: 'setup.py',
        testCommand: 'pytest',
        coverageCommand: 'pytest --cov',
        confidence: 0.85
      };
    }
  } catch (error) {
    // setup.py not found
  }

  try {
    // Check pyproject.toml
    await access(pyprojectPath);
    const pyprojectContent = await readFile(pyprojectPath, 'utf-8');

    if (pyprojectContent.includes('pytest')) {
      return {
        framework: TestFramework.PYTEST,
        configFile: 'pyproject.toml',
        testCommand: 'pytest',
        coverageCommand: 'pytest --cov',
        confidence: 0.9
      };
    }
  } catch (error) {
    // pyproject.toml not found
  }

  return { framework: TestFramework.UNKNOWN, confidence: 0 };
}

/**
 * Find first existing file from a list of candidates
 */
async function findFile(basePath: string, candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      const filePath = join(basePath, candidate);
      await access(filePath);
      return candidate;
    } catch (error) {
      // File doesn't exist, try next
    }
  }
  return undefined;
}

