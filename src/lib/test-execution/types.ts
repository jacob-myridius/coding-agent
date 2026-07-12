/**
 * Test Execution Framework - Type Definitions
 * Phase 2: Test Execution Framework
 */

/**
 * Supported test frameworks
 */
export enum TestFramework {
  VITEST = 'vitest',
  JEST = 'jest',
  JUNIT = 'junit',
  NUNIT = 'nunit',
  PYTEST = 'pytest',
  UNKNOWN = 'unknown'
}

/**
 * Test execution configuration
 */
export interface TestExecutionConfig {
  /** Enable/disable test execution */
  enabled: boolean;

  /** Timeout for test execution in milliseconds */
  timeoutMs: number;

  /** Collect code coverage */
  collectCoverage: boolean;

  /** Required coverage threshold (0-100) */
  requiredCoverage: number;

  /** Fail build if coverage is below threshold */
  failOnLowCoverage: boolean;

  /** Override test runner command */
  runnerCommand?: string;

  /** Coverage report format */
  coverageFormat: 'istanbul' | 'lcov' | 'cobertura';
}

/**
 * Detected test framework information
 */
export interface TestFrameworkInfo {
  /** Detected framework type */
  framework: TestFramework;

  /** Configuration file path (if found) */
  configFile?: string;

  /** Test command from package.json or build config */
  testCommand?: string;

  /** Coverage command */
  coverageCommand?: string;

  /** Confidence level (0-1) */
  confidence: number;
}

/**
 * Test execution result
 */
export interface TestExecutionResult {
  /** Exit code from test runner */
  exitCode: number;

  /** Standard output */
  stdout: string;

  /** Standard error */
  stderr: string;

  /** Execution duration in milliseconds */
  durationMs: number;

  /** Whether execution timed out */
  timedOut: boolean;

  /** Test command that was executed */
  command: string;
}

/**
 * Parsed test results
 */
export interface TestResults {
  /** Total number of tests */
  total: number;

  /** Number of passed tests */
  passed: number;

  /** Number of failed tests */
  failed: number;

  /** Number of skipped tests */
  skipped: number;

  /** Test execution duration in milliseconds */
  durationMs: number;

  /** Test suites (optional) */
  suites?: TestSuite[];

  /** Error messages for failed tests */
  errors?: string[];
}

/**
 * Test suite information
 */
export interface TestSuite {
  /** Suite name */
  name: string;

  /** Number of tests in suite */
  tests: number;

  /** Number of passed tests */
  passed: number;

  /** Number of failed tests */
  failed: number;

  /** Suite duration in milliseconds */
  durationMs: number;
}

/**
 * Code coverage report
 */
export interface CoverageReport {
  /** Statement coverage percentage (0-100) */
  statements: number;

  /** Branch coverage percentage (0-100) */
  branches: number;

  /** Function coverage percentage (0-100) */
  functions: number;

  /** Line coverage percentage (0-100) */
  lines: number;

  /** Overall coverage percentage (average) */
  overall: number;

  /** Coverage by file (optional) */
  files?: FileCoverage[];
}

/**
 * Coverage for a single file
 */
export interface FileCoverage {
  /** File path */
  path: string;

  /** Statement coverage percentage */
  statements: number;

  /** Branch coverage percentage */
  branches: number;

  /** Function coverage percentage */
  functions: number;

  /** Line coverage percentage */
  lines: number;
}

/**
 * Test validation result
 */
export interface ValidationResult {
  /** Whether validation passed */
  valid: boolean;

  /** Validation failure reason */
  reason?: string;

  /** Test results */
  testResults?: TestResults;

  /** Coverage report */
  coverage?: CoverageReport;

  /** Additional details */
  details?: string[];
}

/**
 * Complete test execution summary
 */
export interface TestExecutionSummary {
  /** Test framework used */
  framework: TestFramework;

  /** Execution result */
  execution: TestExecutionResult;

  /** Parsed test results */
  results: TestResults;

  /** Coverage report */
  coverage?: CoverageReport;

  /** Validation result */
  validation: ValidationResult;

  /** Timestamp */
  timestamp: Date;
}

/**
 * Abstract test runner interface
 */
export interface ITestRunner {
  /** Test framework identifier */
  readonly framework: TestFramework;

  /**
   * Execute tests
   * @param workspacePath Path to repository workspace
   * @param config Test execution configuration
   * @returns Test execution result
   */
  execute(workspacePath: string, config: TestExecutionConfig): Promise<TestExecutionResult>;

  /**
   * Parse test results from execution output
   * @param executionResult Test execution result
   * @returns Parsed test results
   */
  parseResults(executionResult: TestExecutionResult): Promise<TestResults>;

  /**
   * Parse coverage report
   * @param workspacePath Path to repository workspace
   * @param config Test execution configuration
   * @returns Coverage report
   */
  parseCoverage(workspacePath: string, config: TestExecutionConfig): Promise<CoverageReport | null>;
}

