/**
 * Mocha Test Runner
 * Executes tests using Mocha framework
 */

import { BaseTestRunner } from './baseTestRunner.js';
import { TestFramework, TestExecutionConfig, TestExecutionResult, TestResults, CoverageReport } from '../types.js';

export class MochaTestRunner extends BaseTestRunner {
  readonly framework = TestFramework.MOCHA;

  protected buildTestCommand(config: TestExecutionConfig): string[] {
    if (config.runnerCommand) {
      return config.runnerCommand.split(' ');
    }

    // Use npm test so the project's own test script is honoured.
    // Pass --reporter json for structured output, suppressing watch mode.
    // CI=true (set in env by BaseTestRunner) already disables color/interactive.
    return ['npm', 'test', '--', '--reporter', 'json', '--exit'];
  }

  async parseResults(executionResult: TestExecutionResult): Promise<TestResults> {
    if (executionResult.timedOut) {
      return {
        total: 0, passed: 0, failed: 0, skipped: 0,
        durationMs: executionResult.durationMs,
        errors: ['Test execution timed out']
      };
    }

    // Mocha JSON reporter writes to stdout; there may be npm log lines before it.
    try {
      const json = this.extractJsonFromOutput(executionResult.stdout);
      if (json) {
        const data = JSON.parse(json);
        const stats = data.stats ?? {};
        return {
          total: stats.tests ?? 0,
          passed: stats.passes ?? 0,
          failed: stats.failures ?? 0,
          skipped: stats.pending ?? 0,
          durationMs: executionResult.durationMs,
          errors: (data.failures ?? []).map((f: { fullTitle?: string; err?: { message?: string } }) =>
            `${f.fullTitle ?? 'test'}: ${f.err?.message ?? 'failed'}`
          )
        };
      }
    } catch {
      // fall through to text parsing
    }

    return this.parseTextOutput(executionResult);
  }

  async parseCoverage(_workspacePath: string, _config: TestExecutionConfig): Promise<CoverageReport | null> {
    // Mocha does not bundle coverage — relies on nyc/c8 run separately. Not supported here.
    return null;
  }

  private extractJsonFromOutput(output: string): string | null {
    // Mocha JSON starts with '{' (object with stats/passes/failures keys)
    const start = output.indexOf('{"stats"');
    if (start >= 0) return output.substring(start);
    const fallback = output.indexOf('{');
    if (fallback >= 0) return output.substring(fallback);
    return null;
  }

  private parseTextOutput(executionResult: TestExecutionResult): TestResults {
    const output = executionResult.stdout + '\n' + executionResult.stderr;

    // Mocha text output: "5 passing", "2 failing", "1 pending"
    const passingMatch = output.match(/(\d+)\s+passing/i);
    const failingMatch = output.match(/(\d+)\s+failing/i);
    const pendingMatch = output.match(/(\d+)\s+pending/i);

    const passed = passingMatch ? parseInt(passingMatch[1], 10) : 0;
    const failed = failingMatch ? parseInt(failingMatch[1], 10) : 0;
    const skipped = pendingMatch ? parseInt(pendingMatch[1], 10) : 0;

    return {
      total: passed + failed + skipped,
      passed,
      failed,
      skipped,
      durationMs: executionResult.durationMs,
      errors: failed > 0 ? ['Tests failed (see output for details)'] : []
    };
  }
}
