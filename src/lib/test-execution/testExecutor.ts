/**
 * Test Executor
 * Main orchestrator for test execution pipeline
 */

import { detectTestFramework } from './testFrameworkDetector.js';
import { createTestRunner, isFrameworkSupported } from './testRunnerFactory.js';
import { validateTestResults } from './testValidator.js';
import {
  TestExecutionConfig,
  TestExecutionSummary,
  TestFramework
} from './types.js';

/**
 * Execute tests in a repository workspace
 * @param workspacePath Path to repository workspace
 * @param config Test execution configuration
 * @param logger Optional logger for progress updates
 * @returns Test execution summary
 */
export async function executeTests(
  workspacePath: string,
  config: TestExecutionConfig,
  logger?: { log: (message: string) => void; error: (message: string) => void }
): Promise<TestExecutionSummary> {
  const log = logger?.log || (() => {});
  const logError = logger?.error || (() => {});

  // Step 1: Detect test framework
  log('Detecting test framework...');
  const frameworkInfo = await detectTestFramework(workspacePath);

  if (frameworkInfo.framework === TestFramework.UNKNOWN) {
    throw new Error('No supported test framework detected in repository');
  }

  log(`Detected ${frameworkInfo.framework} (confidence: ${(frameworkInfo.confidence * 100).toFixed(0)}%)`);

  if (frameworkInfo.configFile) {
    log(`Config file: ${frameworkInfo.configFile}`);
  }

  // Step 2: Check if framework is supported
  if (!isFrameworkSupported(frameworkInfo.framework)) {
    throw new Error(`Test framework ${frameworkInfo.framework} is not yet supported`);
  }

  // Step 3: Create test runner
  const runner = createTestRunner(frameworkInfo.framework);
  if (!runner) {
    throw new Error(`Failed to create test runner for ${frameworkInfo.framework}`);
  }

  // Step 4: Execute tests
  log('Executing tests...');
  const execution = await runner.execute(workspacePath, config);

  if (execution.timedOut) {
    logError(`Test execution timed out after ${execution.durationMs}ms`);
  } else {
    log(`Test execution completed in ${execution.durationMs}ms with exit code ${execution.exitCode}`);
  }

  // Step 5: Parse test results
  log('Parsing test results...');
  const results = await runner.parseResults(execution);
  log(`Tests: ${results.passed} passed, ${results.failed} failed, ${results.skipped} skipped (${results.total} total)`);

  // Step 6: Parse coverage (if enabled)
  let coverage = null;
  if (config.collectCoverage) {
    log('Parsing coverage report...');
    coverage = await runner.parseCoverage(workspacePath, config);

    if (coverage) {
      log(`Coverage: ${coverage.overall.toFixed(1)}% overall`);
    } else {
      logError('Coverage collection was enabled but no coverage report was found');
    }
  }

  // Step 7: Validate results
  log('Validating test results...');
  const validation = validateTestResults(results, coverage, config);

  if (validation.valid) {
    log('✅ Test validation passed');
  } else {
    logError(`❌ Test validation failed: ${validation.reason}`);
  }

  // Step 8: Return summary
  return {
    framework: frameworkInfo.framework,
    execution,
    results,
    coverage: coverage || undefined,
    validation,
    timestamp: new Date()
  };
}

/**
 * Create default test execution configuration
 * @returns Default configuration
 */
export function createDefaultTestConfig(): TestExecutionConfig {
  return {
    enabled: true,
    timeoutMs: 300000, // 5 minutes
    collectCoverage: true,
    requiredCoverage: 70,
    failOnLowCoverage: true,
    coverageFormat: 'istanbul'
  };
}

/**
 * Create test configuration from environment variables
 * @returns Configuration from environment
 */
export function createTestConfigFromEnv(): TestExecutionConfig {
  return {
    enabled: process.env.AI_TEST_EXECUTION_ENABLED === 'true',
    timeoutMs: parseInt(process.env.AI_TEST_TIMEOUT_MS || '300000', 10),
    collectCoverage: process.env.AI_TEST_COLLECT_COVERAGE !== 'false',
    requiredCoverage: parseInt(process.env.AI_TEST_REQUIRED_COVERAGE || '70', 10),
    failOnLowCoverage: process.env.AI_TEST_FAIL_ON_LOW_COVERAGE !== 'false',
    runnerCommand: process.env.AI_TEST_RUNNER_COMMAND || undefined,
    coverageFormat: (process.env.AI_TEST_COVERAGE_FORMAT as any) || 'istanbul'
  };
}

