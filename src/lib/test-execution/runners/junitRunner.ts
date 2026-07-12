/**
 * JUnit Test Runner
 * Executes JUnit tests via Maven or Gradle
 */

import { readFile, access } from 'fs/promises';
import { join } from 'path';
import { parseStringPromise } from 'xml2js';
import { TestFramework, TestExecutionConfig, TestExecutionResult, TestResults, CoverageReport } from '../types.js';
import { BaseTestRunner } from './baseTestRunner.js';

/**
 * JUnit test runner for Maven and Gradle projects
 */
export class JUnitTestRunner extends BaseTestRunner {
  readonly framework = TestFramework.JUNIT;

  /**
   * Build test command based on project type (Maven or Gradle)
   */
  protected buildTestCommand(config: TestExecutionConfig): string[] {
    // Check if it's a Maven project (pom.xml) - we'll detect this from filesystem
    const command: string[] = [];

    // For now, assume Maven (we can enhance detection later)
    // Maven project
    command.push('mvn');
    command.push('clean'); // Clean before test
    command.push('test');

    if (config.collectCoverage) {
      // Add JaCoCo goal
      command.push('jacoco:report');
    }

    // Maven options
    command.push('-B'); // Batch mode
    command.push('-q'); // Quiet mode (less verbose)

    return command;
  }

  /**
   * Parse JUnit test results from XML reports
   */
  async parseResults(executionResult: TestExecutionResult): Promise<TestResults> {
    const workspacePath = process.cwd(); // Assuming current directory
    const testReportsDir = await this.findTestReportsDir(workspacePath);

    if (!testReportsDir) {
      // Parse from console output if XML reports not found
      return this.parseConsoleOutput(executionResult.stdout);
    }

    try {
      const { readdir } = await import('fs/promises');
      const files = await readdir(testReportsDir);
      const xmlFiles = files.filter(f => f.startsWith('TEST-') && f.endsWith('.xml'));

      let total = 0;
      let passed = 0;
      let failed = 0;
      let skipped = 0;

      for (const xmlFile of xmlFiles) {
        const xmlPath = join(testReportsDir, xmlFile);
        const xmlContent = await readFile(xmlPath, 'utf-8');
        const parsed = await parseStringPromise(xmlContent);

        const testsuite = parsed.testsuite || parsed.testsuites?.testsuite?.[0];
        if (testsuite) {
          const attrs = testsuite.$;
          total += parseInt(attrs.tests || '0', 10);
          failed += parseInt(attrs.failures || '0', 10) + parseInt(attrs.errors || '0', 10);
          skipped += parseInt(attrs.skipped || '0', 10);
        }
      }

      passed = total - failed - skipped;

      return {
        total,
        passed,
        failed,
        skipped,
        durationMs: 0 // Will be filled by executor
      };
    } catch (error) {
      // Fallback to console parsing
      return this.parseConsoleOutput(executionResult.stdout);
    }
  }

  /**
   * Parse coverage from JaCoCo XML report
   */
  async parseCoverage(workspacePath: string, config: TestExecutionConfig): Promise<CoverageReport | null> {
    if (!config.collectCoverage) {
      return null;
    }

    // Try to find JaCoCo report
    const jacocoReportPaths = [
      join(workspacePath, 'target', 'site', 'jacoco', 'jacoco.xml'),
      join(workspacePath, 'build', 'reports', 'jacoco', 'test', 'jacocoTestReport.xml')
    ];

    for (const reportPath of jacocoReportPaths) {
      try {
        await access(reportPath);
        const xmlContent = await readFile(reportPath, 'utf-8');
        return await this.parseJaCoCoXml(xmlContent);
      } catch (error) {
        // Try next path
      }
    }

    return null;
  }

  /**
   * Parse JaCoCo XML coverage report
   */
  private async parseJaCoCoXml(xmlContent: string): Promise<CoverageReport | null> {
    try {
      const parsed = await parseStringPromise(xmlContent);
      const report = parsed.report;

      if (!report || !report.counter) {
        return null;
      }

      const counters = Array.isArray(report.counter) ? report.counter : [report.counter];

      const getCounter = (type: string) => {
        const counter = counters.find((c: any) => c.$.type === type);
        if (!counter) return { covered: 0, missed: 0, percentage: 0 };

        const covered = parseInt(counter.$.covered || '0', 10);
        const missed = parseInt(counter.$.missed || '0', 10);
        const total = covered + missed;
        const percentage = total > 0 ? (covered / total) * 100 : 0;

        return { covered, missed, percentage };
      };

      const instruction = getCounter('INSTRUCTION');
      const branch = getCounter('BRANCH');
      const line = getCounter('LINE');
      const method = getCounter('METHOD');

      // Use instruction coverage as overall
      const overall = instruction.percentage;

      return {
        overall,
        statements: instruction.percentage,
        branches: branch.percentage,
        functions: method.percentage,
        lines: line.percentage
      };
    } catch (error) {
      console.error(`Failed to parse JaCoCo XML: ${error}`);
      return null;
    }
  }

  /**
   * Find test reports directory
   */
  private async findTestReportsDir(workspacePath: string): Promise<string | null> {
    const candidates = [
      join(workspacePath, 'target', 'surefire-reports'), // Maven
      join(workspacePath, 'build', 'test-results', 'test')  // Gradle
    ];

    for (const dir of candidates) {
      try {
        await access(dir);
        return dir;
      } catch (error) {
        // Try next
      }
    }

    return null;
  }

  /**
   * Parse test results from Maven/Gradle console output
   */
  private parseConsoleOutput(stdout: string): TestResults {
    let total = 0;
    let passed = 0;
    let failed = 0;
    let skipped = 0;

    // Maven output parsing
    const mavenMatch = stdout.match(/Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)/);
    if (mavenMatch) {
      total = parseInt(mavenMatch[1], 10);
      const failures = parseInt(mavenMatch[2], 10);
      const errors = parseInt(mavenMatch[3], 10);
      skipped = parseInt(mavenMatch[4], 10);
      failed = failures + errors;
      passed = total - failed - skipped;

      return { total, passed, failed, skipped, durationMs: 0 };
    }

    // Gradle output parsing
    const gradleMatch = stdout.match(/(\d+) tests? completed, (\d+) failed(?:, (\d+) skipped)?/);
    if (gradleMatch) {
      total = parseInt(gradleMatch[1], 10);
      failed = parseInt(gradleMatch[2], 10);
      skipped = gradleMatch[3] ? parseInt(gradleMatch[3], 10) : 0;
      passed = total - failed - skipped;

      return { total, passed, failed, skipped, durationMs: 0 };
    }

    // Default: assume failure if we can't parse
    return {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      durationMs: 0
    };
  }
}




