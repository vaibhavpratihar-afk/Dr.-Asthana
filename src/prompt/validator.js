/**
 * Post-execution validation.
 *
 * After the Agent Module executes, this checks:
 * - Is the git diff non-empty?
 * - Do the changed files align with what the cheatsheet specified?
 * - Are there obvious issues (leftover debug logs, empty files)?
 * - Cheatsheet step completeness (test files, completion ratio)
 * - Broken imports from removed lines
 *
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { log, warn, debug } from '../utils/logger.js';

/**
 * Parse numbered steps from a cheatsheet, extracting file paths per step.
 *
 * @param {string} cheatsheet
 * @returns {Array<{stepNum: number, text: string, files: string[], hasTestFiles: boolean}>}
 */
function parseCheatsheetSteps(cheatsheet) {
  if (!cheatsheet) return [];

  const steps = [];
  // Match numbered steps like "1.", "2.", "Step 1:", "Step 2:" etc.
  const stepPattern = /(?:^|\n)\s*(?:(?:step\s+)?(\d+)[.):]\s*)/gi;
  const matches = [...cheatsheet.matchAll(stepPattern)];

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const stepNum = parseInt(match[1], 10);
    const startIdx = match.index + match[0].length;
    const endIdx = i + 1 < matches.length ? matches[i + 1].index : cheatsheet.length;
    const text = cheatsheet.substring(startIdx, endIdx).trim();

    // Extract file paths — common patterns: `path/to/file.js`, path/to/file.js, "path/to/file.js"
    const filePattern = /[`"']?((?:[\w.-]+\/)+[\w.-]+\.\w+)[`"']?/g;
    const files = [...new Set([...text.matchAll(filePattern)].map(m => m[1]))];

    // Flag test files
    const testFilePattern = /\.(spec|test)\.|__tests__\//;
    const hasTestFiles = files.some(f => testFilePattern.test(f));

    steps.push({ stepNum, text, files, hasTestFiles });
  }

  return steps;
}

/**
 * Cross-reference cheatsheet steps against actual diff.
 *
 * @param {Array} steps - From parseCheatsheetSteps
 * @param {string[]} changedFiles - Files actually changed in the diff
 * @returns {{completedSteps: number[], missingSteps: number[], missingTestFiles: string[], completionRatio: number}}
 */
function checkStepCompleteness(steps, changedFiles) {
  const changedSet = new Set(changedFiles);
  const completedSteps = [];
  const missingSteps = [];
  const missingTestFiles = [];

  for (const step of steps) {
    if (step.files.length === 0) {
      // Step has no file refs — can't verify, assume completed
      completedSteps.push(step.stepNum);
      continue;
    }

    const hasAnyFile = step.files.some(f => changedSet.has(f));
    if (hasAnyFile) {
      completedSteps.push(step.stepNum);
    } else {
      missingSteps.push(step.stepNum);
    }

    // Track missing test files specifically
    const testFilePattern = /\.(spec|test)\.|__tests__\//;
    for (const f of step.files) {
      if (testFilePattern.test(f) && !changedSet.has(f)) {
        missingTestFiles.push(f);
      }
    }
  }

  const total = completedSteps.length + missingSteps.length;
  const completionRatio = total > 0 ? completedSteps.length / total : 1;

  return { completedSteps, missingSteps, missingTestFiles, completionRatio };
}

/**
 * Check for broken imports in the diff — removed import/require where the
 * identifier is still referenced in the file.
 *
 * @param {string} cloneDir
 * @param {string[]} changedFiles
 * @returns {string[]} warnings
 */
function checkBrokenImports(cloneDir, changedFiles) {
  const warnings = [];

  for (const file of changedFiles) {
    if (!file.endsWith('.js') && !file.endsWith('.ts') && !file.endsWith('.mjs')) continue;

    let diff;
    try {
      diff = execSync(`git diff HEAD -- "${file}"`, {
        cwd: cloneDir,
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 10000,
      });
    } catch {
      // Also try staged diff
      try {
        diff = execSync(`git diff --cached -- "${file}"`, {
          cwd: cloneDir,
          encoding: 'utf-8',
          stdio: 'pipe',
          timeout: 10000,
        });
      } catch { continue; }
    }

    if (!diff) continue;

    // Find removed import/require lines
    const removedImports = [];
    for (const line of diff.split('\n')) {
      if (!line.startsWith('-') || line.startsWith('---')) continue;
      const importMatch = line.match(/(?:import\s+(?:\{([^}]+)\}|(\w+)).*from|(?:const|let|var)\s+(?:\{([^}]+)\}|(\w+))\s*=\s*require)/);
      if (importMatch) {
        const identifiers = (importMatch[1] || importMatch[2] || importMatch[3] || importMatch[4] || '')
          .split(',')
          .map(s => s.trim().split(/\s+as\s+/).pop().trim())
          .filter(Boolean);
        removedImports.push(...identifiers);
      }
    }

    if (removedImports.length === 0) continue;

    // Check if these identifiers are still referenced in the file (post-change)
    let fileContent;
    try {
      fileContent = fs.readFileSync(path.join(cloneDir, file), 'utf-8');
    } catch { continue; }

    for (const id of removedImports) {
      // Check if the identifier appears outside of import/require lines
      const usagePattern = new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
      const lines = fileContent.split('\n');
      const usages = lines.filter(l =>
        usagePattern.test(l) &&
        !l.match(/^\s*(import\s|.*require\()/)
      );
      if (usages.length > 0) {
        warnings.push(`Possibly broken import in ${file}: '${id}' was removed but is still referenced (${usages.length} usage(s))`);
      }
    }
  }

  return warnings;
}

/**
 * Validate execution results against the cheatsheet.
 *
 * @param {string} cheatsheet - The cheatsheet that was executed
 * @param {string} cloneDir - Path to the cloned repo (after execution)
 * @returns {Promise<{valid: boolean, issues: string[], critical: string[], warnings: string[]}>}
 */
export async function validateExecution(cheatsheet, cloneDir) {
  const critical = [];
  const warnings = [];

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
    critical.push('No changes detected after execution (empty diff)');
    return { valid: false, issues: [...critical], critical, warnings };
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

  // Check 3: Look for obvious issues (debug logs)
  for (const file of changedFiles) {
    try {
      const fullDiff = execSync(`git diff -- "${file}"`, {
        cwd: cloneDir,
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 10000,
      });

      const addedLines = fullDiff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
      const debugPatterns = /console\.(log|debug)\(['"`](?:DEBUG|TODO|FIXME|HACK|XXX)/i;
      for (const line of addedLines) {
        if (debugPatterns.test(line)) {
          warnings.push(`Possible debug log left in ${file}: ${line.substring(1, 80)}`);
        }
      }
    } catch { /* non-critical */ }
  }

  // Check 4: Cheatsheet step completeness
  const steps = parseCheatsheetSteps(cheatsheet);
  if (steps.length > 0) {
    const completeness = checkStepCompleteness(steps, changedFiles);

    if (completeness.missingTestFiles.length > 0) {
      critical.push(`Test files required by cheatsheet but not changed: ${completeness.missingTestFiles.join(', ')}`);
    }

    if (completeness.completionRatio < 0.5) {
      critical.push(`Low completion ratio: ${Math.round(completeness.completionRatio * 100)}% of cheatsheet steps have matching file changes (steps missing: ${completeness.missingSteps.join(', ')})`);
    } else if (completeness.missingSteps.length > 0) {
      warnings.push(`Cheatsheet steps with no matching file changes: ${completeness.missingSteps.join(', ')} (${Math.round(completeness.completionRatio * 100)}% complete)`);
    }

    debug(`Cheatsheet completeness: ${completeness.completedSteps.length}/${steps.length} steps, ratio ${(completeness.completionRatio * 100).toFixed(0)}%`);
  }

  // Check 5: Broken imports
  const importWarnings = checkBrokenImports(cloneDir, changedFiles);
  critical.push(...importWarnings);

  const issues = [...critical, ...warnings];

  if (issues.length === 0) {
    log('Execution validation passed');
  } else {
    if (critical.length > 0) warn(`Execution validation: ${critical.length} critical issue(s)`);
    if (warnings.length > 0) warn(`Execution validation: ${warnings.length} warning(s)`);
  }

  return {
    valid: critical.length === 0,
    issues,
    critical,
    warnings,
  };
}
