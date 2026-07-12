/**
 * Test Validator
 * Validates test results and coverage against requirements
 */

import { TestResults, CoverageReport, ValidationResult, TestExecutionConfig } from './types.js';

/**
 * Validate test results and coverage
 * @param results Test results
 * @param coverage Coverage report (optional)
 * @param config Test execution configuration
 * @returns Validation result
 */
export function validateTestResults(
  results: TestResults,
  coverage: CoverageReport | null | undefined,
  config: TestExecutionConfig
): ValidationResult {
  const details: string[] = [];

  // Check if tests failed
  if (results.failed > 0) {
    return {
      valid: false,
      reason: `${results.failed} test(s) failed out of ${results.total}`,
      testResults: results,
      coverage: coverage || undefined,
      details: results.errors || []
    };
  }

  // Check if no tests were run
  if (results.total === 0) {
    return {
      valid: false,
      reason: 'No tests were executed',
      testResults: results,
      coverage: coverage || undefined,
      details: ['No tests found or test execution failed']
    };
  }

  // Check coverage if collection is enabled and enforcement is required
  if (config.collectCoverage) {
    if (!coverage && config.failOnLowCoverage) {
      return {
        valid: false,
        reason: 'Coverage collection was enabled but no coverage report was generated',
        testResults: results,
        coverage: undefined,
        details: ['Check if coverage is properly configured in test framework']
      };
    }

    // If coverage is available and enforcement is enabled, check threshold
    if (coverage && config.failOnLowCoverage && coverage.overall < config.requiredCoverage) {
      details.push(`Overall coverage: ${coverage.overall.toFixed(1)}% (required: ${config.requiredCoverage}%)`);
      details.push(`- Statements: ${coverage.statements.toFixed(1)}%`);
      details.push(`- Branches: ${coverage.branches.toFixed(1)}%`);
      details.push(`- Functions: ${coverage.functions.toFixed(1)}%`);
      details.push(`- Lines: ${coverage.lines.toFixed(1)}%`);

      return {
        valid: false,
        reason: `Code coverage ${coverage.overall.toFixed(1)}% is below required ${config.requiredCoverage}%`,
        testResults: results,
        coverage,
        details
      };
    }

    if (coverage) {
      details.push(`Coverage: ${coverage.overall.toFixed(1)}% (required: ${config.requiredCoverage}%) ✓`);
    }
  }

  // All validations passed
  details.push(`${results.passed} test(s) passed out of ${results.total} ✓`);
  if (results.skipped > 0) {
    details.push(`${results.skipped} test(s) skipped`);
  }

  return {
    valid: true,
    testResults: results,
    coverage: coverage || undefined,
    details
  };
}

/**
 * Format validation result as human-readable message
 * @param validation Validation result
 * @returns Formatted message
 */
export function formatValidationMessage(validation: ValidationResult): string {
  const lines: string[] = [];

  if (validation.valid) {
    lines.push('✅ **Test Validation Passed**');
    lines.push('');
    if (validation.testResults) {
      lines.push(`**Tests:** ${validation.testResults.passed}/${validation.testResults.total} passed`);
      if (validation.testResults.skipped > 0) {
        lines.push(`${validation.testResults.skipped} skipped`);
      }
    }
    if (validation.coverage) {
      lines.push('');
      lines.push('**Coverage:**');
      lines.push(`- Overall: ${validation.coverage.overall.toFixed(1)}%`);
      lines.push(`- Statements: ${validation.coverage.statements.toFixed(1)}%`);
      lines.push(`- Branches: ${validation.coverage.branches.toFixed(1)}%`);
      lines.push(`- Functions: ${validation.coverage.functions.toFixed(1)}%`);
      lines.push(`- Lines: ${validation.coverage.lines.toFixed(1)}%`);
    }
  } else {
    lines.push('❌ **Test Validation Failed**');
    lines.push('');
    lines.push(`**Reason:** ${validation.reason}`);
    lines.push('');

    if (validation.testResults) {
      lines.push('**Test Results:**');
      lines.push(`- Total: ${validation.testResults.total}`);
      lines.push(`- Passed: ${validation.testResults.passed}`);
      lines.push(`- Failed: ${validation.testResults.failed}`);
      lines.push(`- Skipped: ${validation.testResults.skipped}`);
      lines.push('');
    }

    if (validation.coverage) {
      lines.push('**Coverage:**');
      lines.push(`- Overall: ${validation.coverage.overall.toFixed(1)}%`);
      lines.push(`- Statements: ${validation.coverage.statements.toFixed(1)}%`);
      lines.push(`- Branches: ${validation.coverage.branches.toFixed(1)}%`);
      lines.push(`- Functions: ${validation.coverage.functions.toFixed(1)}%`);
      lines.push(`- Lines: ${validation.coverage.lines.toFixed(1)}%`);
      lines.push('');
    }

    if (validation.details && validation.details.length > 0) {
      lines.push('**Details:**');
      validation.details.forEach(detail => lines.push(`- ${detail}`));
    }
  }

  return lines.join('\n');
}



