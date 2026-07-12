/**
 * Base Test Runner
 * Abstract base class for all test framework runners
 */

import { spawn } from 'child_process';
import { TestFramework, ITestRunner, TestExecutionConfig, TestExecutionResult, TestResults, CoverageReport } from '../types.js';

/**
 * Abstract base test runner
 */
export abstract class BaseTestRunner implements ITestRunner {
  abstract readonly framework: TestFramework;

  /**
   * Execute tests
   */
  async execute(workspacePath: string, config: TestExecutionConfig): Promise<TestExecutionResult> {
    const command = this.buildTestCommand(config);
    const startTime = Date.now();

    try {
      const result = await this.runCommand(command, workspacePath, config.timeoutMs);
      const durationMs = Date.now() - startTime;

      return {
        ...result,
        durationMs,
        command: command.join(' ')
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;

      if (error instanceof Error && error.message.includes('timeout')) {
        return {
          exitCode: -1,
          stdout: '',
          stderr: error.message,
          durationMs,
          timedOut: true,
          command: command.join(' ')
        };
      }

      throw error;
    }
  }

  /**
   * Parse test results - must be implemented by subclass
   */
  abstract parseResults(executionResult: TestExecutionResult): Promise<TestResults>;

  /**
   * Parse coverage report - must be implemented by subclass
   */
  abstract parseCoverage(workspacePath: string, config: TestExecutionConfig): Promise<CoverageReport | null>;

  /**
   * Build test command - must be implemented by subclass
   */
  protected abstract buildTestCommand(config: TestExecutionConfig): string[];

  /**
   * Run a shell command with timeout
   */
  protected runCommand(
    command: string[],
    cwd: string,
    timeoutMs: number
  ): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
    return new Promise((resolve, reject) => {
      const [cmd, ...args] = command;
      const child = spawn(cmd, args, {
        cwd,
        shell: true,
        env: { ...process.env, CI: 'true' }
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      child.on('close', (exitCode) => {
        clearTimeout(timeout);
        resolve({
          exitCode: exitCode ?? -1,
          stdout,
          stderr,
          timedOut
        });
      });
    });
  }

  /**
   * Check if a command exists in PATH
   */
  protected async commandExists(command: string): Promise<boolean> {
    try {
      const result = await this.runCommand(
        ['which', command],
        process.cwd(),
        5000
      );
      return result.exitCode === 0;
    } catch (error) {
      return false;
    }
  }
}

