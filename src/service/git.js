import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { log, warn } from '../utils/logger.js';

const CLONE_TIMEOUT = 15 * 60 * 1000;
const LOCAL_TMP_BASE = path.join(process.cwd(), '.tmp');
const CMD_TIMEOUT = 10 * 60 * 1000;

function sanitizeBranchName(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 40);
}

function execGit(args, cwd, timeout = CMD_TIMEOUT) {
  try {
    return execFileSync('git', args, {
      cwd,
      stdio: 'pipe',
      timeout,
      encoding: 'utf-8',
    });
  } catch (error) {
    const stderr = error.stderr?.toString() || '';
    const stdout = error.stdout?.toString() || '';
    throw new Error(`Git command failed: git ${args.join(' ')}\n${stderr || stdout || error.message}`);
  }
}

function buildFeatureBranchName(ticketKey, ticketSummary, version = null) {
  const sanitizedSummary = sanitizeBranchName(ticketSummary);
  return version
    ? `feature/${ticketKey}-${sanitizedSummary}-${version}`
    : `feature/${ticketKey}-${sanitizedSummary}`;
}

/**
 * Clone repo, checkout base branch, create feature branch.
 */
export async function cloneAndBranch(repoUrl, baseBranch, ticketKey, ticketSummary, version = null) {
  if (!fs.existsSync(LOCAL_TMP_BASE)) {
    fs.mkdirSync(LOCAL_TMP_BASE, { recursive: true });
  }
  const tmpDir = fs.mkdtempSync(path.join(LOCAL_TMP_BASE, 'agent-'));
  log(`Created temp directory: ${tmpDir}`);

  try {
    log(`Cloning: ${repoUrl}`);
    log(`Branch: ${baseBranch}`);
    execGit(['clone', '--depth=50', '--branch', baseBranch, repoUrl, '.'], tmpDir, CLONE_TIMEOUT);

    const featureBranch = buildFeatureBranchName(ticketKey, ticketSummary, version);
    log(`Creating branch: ${featureBranch}`);
    execGit(['checkout', '-b', featureBranch], tmpDir);

    return { tmpDir, featureBranch };
  } catch (error) {
    cleanup(tmpDir);
    throw error;
  }
}

/**
 * Clean up temp directory.
 */
export function cleanup(tmpDir) {
  if (!tmpDir) {
    warn('Refusing cleanup: empty path');
    return;
  }

  const resolvedTmp = path.resolve(tmpDir);
  const resolvedBase = path.resolve(LOCAL_TMP_BASE) + path.sep;
  if (!resolvedTmp.startsWith(resolvedBase)) {
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
