/**
 * Git Service
 * Handles git operations in isolated temp directories:
 * clone, branch, commit, push, and cleanup.
 *
 * Base image tagging is in base-tagger.js.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { log, warn } from '../logger.js';

const CLONE_TIMEOUT = 15 * 60 * 1000; // 15 minutes
const LOCAL_TMP_BASE = path.join(process.cwd(), '.tmp');
const CMD_TIMEOUT = 10 * 60 * 1000; // 10 minutes

/**
 * Sanitize a string for use in branch names
 */
function sanitizeBranchName(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 40);
}

/**
 * Execute a git command in a directory
 */
function execGit(cmd, cwd, timeout = CMD_TIMEOUT) {
  try {
    return execSync(cmd, {
      cwd,
      stdio: 'pipe',
      timeout,
      encoding: 'utf-8',
    });
  } catch (error) {
    const stderr = error.stderr?.toString() || '';
    const stdout = error.stdout?.toString() || '';
    throw new Error(`Git command failed: ${cmd}\n${stderr || stdout || error.message}`);
  }
}

/**
 * Check if a file is tracked by git
 */
function isTrackedByGit(tmpDir, filePath) {
  try {
    execGit(`git ls-files --error-unmatch "${filePath}"`, tmpDir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clone repo, checkout base branch, create feature branch
 */
export async function cloneAndBranch(config, repoUrl, baseBranch, ticketKey, ticketSummary, version = null) {
  if (!fs.existsSync(LOCAL_TMP_BASE)) {
    fs.mkdirSync(LOCAL_TMP_BASE, { recursive: true });
  }
  const tmpDir = fs.mkdtempSync(path.join(LOCAL_TMP_BASE, 'agent-'));
  log(`Created temp directory: ${tmpDir}`);

  try {
    // Clone the repository
    log(`Cloning: ${repoUrl}`);
    log(`Branch: ${baseBranch}`);
    execGit(
      `git clone --depth=50 --branch "${baseBranch}" "${repoUrl}" .`,
      tmpDir,
      CLONE_TIMEOUT
    );

    // Create feature branch (append version suffix for multi-branch to avoid collisions)
    const sanitizedSummary = sanitizeBranchName(ticketSummary);
    const featureBranch = version
      ? `feature/${ticketKey}-${sanitizedSummary}-${version}`
      : `feature/${ticketKey}-${sanitizedSummary}`;
    log(`Creating branch: ${featureBranch}`);
    execGit(`git checkout -b "${featureBranch}"`, tmpDir);

    const instructionFile = config.AGENT_INSTRUCTIONS_FILE || 'CLAUDE.md';
    const instructionPath = path.join(tmpDir, instructionFile);
    const serviceHasInstructionFile = fs.existsSync(instructionPath);

    if (serviceHasInstructionFile) {
      log(`✓ Service has its own ${instructionFile} - honoring it`);
    } else {
      // Copy default instruction file from project root.
      const defaultInstruction = path.join(process.cwd(), instructionFile);
      const fallbackInstruction = path.join(process.cwd(), 'CLAUDE.md');
      if (fs.existsSync(defaultInstruction)) {
        fs.copyFileSync(defaultInstruction, instructionPath);
        log(`Copied default ${instructionFile} (service has none)`);
      } else if (instructionFile !== 'CLAUDE.md' && fs.existsSync(fallbackInstruction)) {
        fs.copyFileSync(fallbackInstruction, instructionPath);
        log(`Copied fallback CLAUDE.md to ${instructionFile} (service has none)`);
      }
    }

    return {
      tmpDir,
      featureBranch,
      baseBranch,
      serviceHasInstructionFile,
      instructionFile,
    };
  } catch (error) {
    cleanup(tmpDir);
    throw error;
  }
}

/**
 * Create a planning-only clone with multiple branches available as remote refs.
 * Used for multi-branch master planning — a single Claude session explores all
 * branches via `git show origin/<branch>:<path>` and `git diff origin/A..origin/B`.
 *
 * @param {string} repoUrl - Repository URL (SSH)
 * @param {string[]} branches - Array of branch names to fetch
 * @returns {{ tmpDir: string }}
 */
export async function cloneForPlanning(repoUrl, branches) {
  if (!branches || branches.length === 0) {
    throw new Error('cloneForPlanning requires at least one branch');
  }

  if (!fs.existsSync(LOCAL_TMP_BASE)) {
    fs.mkdirSync(LOCAL_TMP_BASE, { recursive: true });
  }
  const tmpDir = fs.mkdtempSync(path.join(LOCAL_TMP_BASE, 'plan-'));
  log(`Created planning directory: ${tmpDir}`);

  try {
    // Clone with the first branch as the initial checkout
    const primaryBranch = branches[0];
    log(`Planning clone: ${repoUrl} (primary: ${primaryBranch})`);
    execGit(
      `git clone --depth=100 --branch "${primaryBranch}" "${repoUrl}" .`,
      tmpDir,
      CLONE_TIMEOUT
    );

    // Fetch remaining branches as remote refs (non-fatal per branch)
    for (let i = 1; i < branches.length; i++) {
      const branch = branches[i];
      try {
        log(`Fetching additional branch for planning: ${branch}`);
        execGit(`git fetch origin "${branch}" --depth=100`, tmpDir, CLONE_TIMEOUT);
      } catch (fetchError) {
        warn(`Could not fetch branch ${branch} for planning: ${fetchError.message}`);
      }
    }

    return { tmpDir };
  } catch (error) {
    cleanup(tmpDir);
    throw error;
  }
}

/**
 * Stage, commit, and push changes
 */
export async function commitAndPush(tmpDir, featureBranch, ticketKey, ticketSummary, serviceHasInstructionFile = false, instructionFile = 'CLAUDE.md') {
  // Stage all changes
  execGit('git add -A', tmpDir);

  // Always restore provider instructions file to its original state before committing.
  // The agent injects rules into this file at runtime — those changes
  // must never be pushed. For tracked files, reset to HEAD; for untracked
  // files (copied default), unstage them.
  if (serviceHasInstructionFile) {
    try {
      execGit(`git checkout HEAD -- "${instructionFile}"`, tmpDir);
    } catch {
      // Ignore - file might not have changes
    }
  } else {
    try {
      execGit(`git reset HEAD "${instructionFile}"`, tmpDir);
    } catch {
      // Ignore - file might not be staged
    }
  }

  // Check if there are staged changes
  try {
    execGit('git diff --cached --quiet', tmpDir);
    log('No changes to commit');
    return { pushed: false };
  } catch {
    // Exit code non-zero means there are changes - this is expected
  }

  // Commit
  const commitMessage = `ID:${ticketKey}; ${ticketSummary}`;

  const commitMsgFile = path.join(tmpDir, '.commit-msg-tmp');
  fs.writeFileSync(commitMsgFile, commitMessage);

  try {
    execGit(`git commit -F "${commitMsgFile}"`, tmpDir);
  } finally {
    if (fs.existsSync(commitMsgFile)) {
      fs.unlinkSync(commitMsgFile);
    }
  }

  // Push (force push if branch already exists from a previous run)
  log(`Pushing ${featureBranch}...`);
  try {
    execGit(`git push -u origin "${featureBranch}"`, tmpDir);
  } catch (error) {
    if (error.message.includes('rejected') || error.message.includes('fetch first')) {
      log('Remote branch exists from previous run, force pushing...');
      execGit(`git push -u origin "${featureBranch}" --force`, tmpDir);
    } else {
      throw error;
    }
  }

  return { pushed: true };
}

/**
 * Clean up temp directory
 */
export function cleanup(tmpDir) {
  if (!tmpDir || !tmpDir.includes(LOCAL_TMP_BASE)) {
    warn(`Refusing to clean up suspicious path: ${tmpDir}`);
    return;
  }

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    log(`Cleaned up: ${tmpDir}`);
  } catch (error) {
    warn(`Cleanup failed: ${error.message}`);
  }
}

export default {
  cloneAndBranch,
  cloneForPlanning,
  commitAndPush,
  cleanup,
};
