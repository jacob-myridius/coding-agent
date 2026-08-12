/**
 * Test Execution JavaScript Wrapper
 * Provides JavaScript interface for worker to call TypeScript test execution
 */

import { executeTests, createTestConfigFromEnv, formatValidationMessage } from '../src/lib/test-execution/index.js';

/**
 * Execute tests and return formatted result
 * @param {string} workspacePath - Path to repository workspace
 * @param {object} logger - Logger with log() and error() methods
 * @returns {Promise<{success: boolean, summary: object, message: string}>}
 */
export async function runTests(workspacePath, logger = console) {
  try {
    // Get configuration from environment
    const config = createTestConfigFromEnv();

    // Check if test execution is enabled
    if (!config.enabled) {
      return {
        success: true,
        summary: null,
        message: 'Test execution is disabled (AI_TEST_EXECUTION_ENABLED=false)'
      };
    }

    // Execute tests
    logger.log('Starting test execution...');
    const summary = await executeTests(workspacePath, config, logger);

    // Format validation message
    const message = formatValidationMessage(summary.validation);

    return {
      success: summary.validation.valid,
      summary: {
        framework: summary.framework,
        total: summary.results.total,
        passed: summary.results.passed,
        failed: summary.results.failed,
        skipped: summary.results.skipped,
        durationMs: summary.execution.durationMs,
        coverage: summary.coverage ? {
          overall: summary.coverage.overall,
          statements: summary.coverage.statements,
          branches: summary.coverage.branches,
          functions: summary.coverage.functions,
          lines: summary.coverage.lines
        } : null
      },
      message
    };
  } catch (error) {
    // No test framework detected is not a blocking failure — just skip tests and let the PR proceed.
    if (error.message && error.message.includes('No supported test framework detected')) {
      logger.log(`Test execution skipped: ${error.message}`);
      return {
        success: true,
        summary: null,
        message: 'Test execution skipped — no supported test framework detected in repository'
      };
    }

    logger.error(`Test execution error: ${error.message}`);

    return {
      success: false,
      summary: null,
      message: `❌ **Test Execution Failed**\n\n**Error:** ${error.message}`
    };
  }
}

