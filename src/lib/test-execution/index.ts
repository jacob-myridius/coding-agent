/**
 * Test Execution Framework
 * Public API exports
 */

// Main executor
export { executeTests, createDefaultTestConfig, createTestConfigFromEnv } from './testExecutor.js';

// Framework detection
export { detectTestFramework } from './testFrameworkDetector.js';

// Test runner factory
export { createTestRunner, isFrameworkSupported } from './testRunnerFactory.js';

// Validator
export { validateTestResults, formatValidationMessage } from './testValidator.js';

// Types
export * from './types.js';

// Runners (for advanced usage)
export { BaseTestRunner } from './runners/baseTestRunner.js';
export { VitestTestRunner } from './runners/vitestRunner.js';
export { JestTestRunner } from './runners/jestRunner.js';

