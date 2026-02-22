/**
 * Post-execution validation.
 *
 * After the Agent Module executes, this checks:
 * - Is the git diff non-empty?
 * - Do the changed files align with what the cheatsheet specified?
 * - Are there obvious issues (leftover debug logs, empty files)?
 */

import { execSync } from 'child_process';
import { log, warn, debug } from '../utils/logger.js';

/**
 * Validate execution results against the cheatsheet.
 *
 * @param {string} cheatsheet - The cheatsheet that was executed
 * @param {string} cloneDir - Path to the cloned repo (after execution)
 * @returns {Promise<{valid: boolean, issues: string[]}>}
 */
export async function validateExecution(cheatsheet, cloneDir) {
  const issues = [];

  // Check 1: Is the git diff non-empty?
  let diffOutput;
  try {
    diffOutput = execSync('git diff --stat', {
      cwd: cloneDir,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 30000,
    }).trim();
  } catch {
    diffOutput = '';
  }

  // Also check staged changes
  let stagedDiff;
  try {
    stagedDiff = execSync('git diff --cached --stat', {
      cwd: cloneDir,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 30000,
    }).trim();
  } catch {
    stagedDiff = '';
  }

  // Check for untracked files
  let untrackedFiles;
  try {
    untrackedFiles = execSync('git ls-files --others --exclude-standard', {
      cwd: cloneDir,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 30000,
    }).trim();
  } catch {
    untrackedFiles = '';
  }

  const hasChanges = Boolean(diffOutput || stagedDiff || untrackedFiles);
  if (!hasChanges) {
    issues.push('No changes detected after execution (empty diff)');
    return { valid: false, issues };
  }

  // Check 2: Extract changed files and compare with cheatsheet
  let changedFiles = [];
  try {
    const nameOnly = execSync('git diff --name-only', {
      cwd: cloneDir,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 30000,
    }).trim();
    const cachedNameOnly = execSync('git diff --cached --name-only', {
      cwd: cloneDir,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 30000,
    }).trim();

    changedFiles = [...new Set([
      ...nameOnly.split('\n').filter(Boolean),
      ...cachedNameOnly.split('\n').filter(Boolean),
      ...untrackedFiles.split('\n').filter(Boolean),
    ])];
  } catch {
    changedFiles = [];
  }

  if (changedFiles.length > 0) {
    log(`Execution changed ${changedFiles.length} file(s): ${changedFiles.join(', ')}`);
  }

  // Check 3: Look for obvious issues
  for (const file of changedFiles) {
    // Check for leftover debug statements (common patterns)
    try {
      const fullDiff = execSync(`git diff -- "${file}"`, {
        cwd: cloneDir,
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 10000,
      });

      // Check for console.log debug statements in added lines
      const addedLines = fullDiff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
      const debugPatterns = /console\.(log|debug)\(['"`](?:DEBUG|TODO|FIXME|HACK|XXX)/i;
      for (const line of addedLines) {
        if (debugPatterns.test(line)) {
          issues.push(`Possible debug log left in ${file}: ${line.substring(1, 80)}`);
        }
      }
    } catch { /* non-critical */ }
  }

  if (issues.length === 0) {
    log('Execution validation passed');
  } else {
    warn(`Execution validation found ${issues.length} issue(s)`);
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}
