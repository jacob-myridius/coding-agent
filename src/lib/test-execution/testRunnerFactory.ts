/**
 * Test Runner Factory
 * Creates appropriate test runner based on detected framework
 */

import { TestFramework, ITestRunner } from './types.js';
import { VitestTestRunner } from './runners/vitestRunner.js';
import { JestTestRunner } from './runners/jestRunner.js';
import { JUnitTestRunner } from './runners/junitRunner.js';

/**
 * Create test runner for detected framework
 * @param framework Detected test framework
 * @returns Test runner instance or null if framework not supported
 */
export function createTestRunner(framework: TestFramework): ITestRunner | null {
  switch (framework) {
    case TestFramework.VITEST:
      return new VitestTestRunner();

    case TestFramework.JEST:
      return new JestTestRunner();

    case TestFramework.JUNIT:
      return new JUnitTestRunner();

    // Future frameworks (Phase 4)
    case TestFramework.NUNIT:
    case TestFramework.PYTEST:
      return null; // Not yet implemented

    case TestFramework.UNKNOWN:
    default:
      return null;
  }
}

/**
 * Check if a framework is supported
 * @param framework Test framework
 * @returns True if framework is supported
 */
export function isFrameworkSupported(framework: TestFramework): boolean {
  return createTestRunner(framework) !== null;
}


