/**
 * Jest Test Runner
 * Executes tests using Jest framework
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { BaseTestRunner } from './baseTestRunner.js';
import { TestFramework, TestExecutionConfig, TestExecutionResult, TestResults, CoverageReport } from '../types.js';

/**
 * Jest test runner implementation
 */
export class JestTestRunner extends BaseTestRunner {
  readonly framework = TestFramework.JEST;

  /**
   * Build Jest test command
   */
  protected buildTestCommand(config: TestExecutionConfig): string[] {
    if (config.runnerCommand) {
      return config.runnerCommand.split(' ');
    }

    const cmd = ['npm', 'test', '--'];

    // Output as JSON for easier parsing
    cmd.push('--json');

    // Don't watch
    cmd.push('--watchAll=false');

    // Collect coverage if requested
    if (config.collectCoverage) {
      cmd.push('--coverage');
    }

    return cmd;
  }

  /**
   * Parse Jest test results from JSON output
   */
  async parseResults(executionResult: TestExecutionResult): Promise<TestResults> {
    if (executionResult.timedOut) {
      return {
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        durationMs: executionResult.durationMs,
        errors: ['Test execution timed out']
      };
    }

    try {
      // Jest outputs JSON to stdout
      const jsonOutput = this.extractJsonFromOutput(executionResult.stdout);
      const data = JSON.parse(jsonOutput);

      // Jest JSON format
      const results: TestResults = {
        total: data.numTotalTests || 0,
        passed: data.numPassedTests || 0,
        failed: data.numFailedTests || 0,
        skipped: data.numPendingTests || 0,
        durationMs: executionResult.durationMs,
        errors: []
      };

      // Extract error messages from test results
      if (data.testResults && Array.isArray(data.testResults)) {
        for (const fileResult of data.testResults) {
          if (fileResult.assertionResults) {
            for (const test of fileResult.assertionResults) {
              if (test.status === 'failed' && test.failureMessages) {
                results.errors?.push(...test.failureMessages);
              }
            }
          }
        }
      }

      return results;
    } catch (error) {
      // Failed to parse JSON, try to extract basic info from text output
      return this.parseTextOutput(executionResult);
    }
  }

  /**
   * Parse Jest coverage report
   */
  async parseCoverage(workspacePath: string, config: TestExecutionConfig): Promise<CoverageReport | null> {
    if (!config.collectCoverage) {
      return null;
    }

    try {
      // Jest uses Istanbul format in coverage/coverage-summary.json
      const coveragePath = join(workspacePath, 'coverage', 'coverage-summary.json');
      const coverageData = JSON.parse(await readFile(coveragePath, 'utf-8'));

      // Get totals
      const total = coverageData.total;
      if (!total) {
        return null;
      }

      return {
        statements: total.statements?.pct || 0,
        branches: total.branches?.pct || 0,
        functions: total.functions?.pct || 0,
        lines: total.lines?.pct || 0,
        overall: this.calculateOverall(
          total.statements?.pct || 0,
          total.branches?.pct || 0,
          total.functions?.pct || 0,
          total.lines?.pct || 0
        )
      };
    } catch (error) {
      // Coverage file not found or invalid
      return null;
    }
  }

  /**
   * Extract JSON from output that may contain other text
   */
  private extractJsonFromOutput(output: string): string {
    // Try to find JSON object in output
    const jsonStart = output.indexOf('{');
    if (jsonStart >= 0) {
      return output.substring(jsonStart);
    }
    return output;
  }

  /**
   * Parse text output when JSON parsing fails
   */
  private parseTextOutput(executionResult: TestExecutionResult): TestResults {
    const output = executionResult.stdout + '\n' + executionResult.stderr;

    // Look for patterns like "Tests: 2 failed, 5 passed, 7 total"
    const testSummaryMatch = output.match(/Tests:\s+(?:(\d+)\s+failed[,\s]*)?(?:(\d+)\s+passed[,\s]*)?(?:(\d+)\s+skipped[,\s]*)?(\d+)\s+total/i);

    if (testSummaryMatch) {
      const failed = testSummaryMatch[1] ? parseInt(testSummaryMatch[1], 10) : 0;
      const passed = testSummaryMatch[2] ? parseInt(testSummaryMatch[2], 10) : 0;
      const skipped = testSummaryMatch[3] ? parseInt(testSummaryMatch[3], 10) : 0;
      const total = parseInt(testSummaryMatch[4], 10);

      return {
        total,
        passed,
        failed,
        skipped,
        durationMs: executionResult.durationMs,
        errors: failed > 0 ? ['Tests failed (see output for details)'] : []
      };
    }

    // Fallback: look for individual counts
    const passedMatch = output.match(/(\d+)\s+passed/i);
    const failedMatch = output.match(/(\d+)\s+failed/i);
    const skippedMatch = output.match(/(\d+)\s+(?:skipped|pending)/i);

    const passed = passedMatch ? parseInt(passedMatch[1], 10) : 0;
    const failed = failedMatch ? parseInt(failedMatch[1], 10) : 0;
    const skipped = skippedMatch ? parseInt(skippedMatch[1], 10) : 0;

    return {
      total: passed + failed + skipped,
      passed,
      failed,
      skipped,
      durationMs: executionResult.durationMs,
      errors: failed > 0 ? ['Tests failed (see output for details)'] : []
    };
  }

  /**
   * Calculate overall coverage percentage
   */
  private calculateOverall(statements: number, branches: number, functions: number, lines: number): number {
    return (statements + branches + functions + lines) / 4;
  }
}

