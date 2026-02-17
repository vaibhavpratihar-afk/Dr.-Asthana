/**
 * Base Image Tagger
 *
 * Handles base image tag creation when dependencies change.
 * Auto-detects base image registry from each repo's Dockerfile.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { log, warn } from '../logger.js';

const CMD_TIMEOUT = 10 * 60 * 1000; // 10 minutes

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
 * Handle base tag creation when dependencies change.
 *
 * Per the service CLAUDE.md, the pipeline clones the tagged commit to build
 * the base image. Therefore, dependency changes MUST be committed and pushed
 * BEFORE this function is called. The tag is created on HEAD (the pushed
 * feature branch commit that contains the dependency changes).
 *
 * 1. Detect if package.json or package-lock.json changed (via committed diff)
 * 2. Parse version from branch name (version/1.10.6 → v1-10-6)
 * 3. Fetch tags and find highest existing build number for that version series
 * 4. Create annotated tag on HEAD (the pushed commit with dep changes)
 * 5. Push the tag
 * 6. Update Dockerfile FROM line (image tag strips the deploy.base. prefix)
 *
 * @param {string} tmpDir - Working directory (feature branch, already committed+pushed)
 * @param {string} baseBranch - The base branch name (e.g. version/1.10.6)
 * @param {string} repoName - The repo/service name (e.g. "convex", "highbrow")
 * @returns {{ tagged: boolean, tag?: string }} result
 */
export function handleBaseTag(tmpDir, baseBranch, repoName) {
  // Pre-flight: repo must have Dockerfile, Dockerfile.base, and azure-pipelines.yml
  const dockerfilePath = path.join(tmpDir, 'Dockerfile');
  const dockerfileBasePath = path.join(tmpDir, 'Dockerfile.base');
  const pipelinePath = path.join(tmpDir, 'azure-pipelines.yml');

  if (!fs.existsSync(dockerfilePath) || !fs.existsSync(dockerfileBasePath) || !fs.existsSync(pipelinePath)) {
    log('Missing Dockerfile, Dockerfile.base, or azure-pipelines.yml — skipping base tag');
    return { tagged: false };
  }

  // Verify Dockerfile FROM line references this service's base image
  const dockerfile = fs.readFileSync(dockerfilePath, 'utf-8');
  const fromMatch = dockerfile.match(/^FROM\s+(harbor-core\.fynd\.engineering\/base-images\/\S+?):\S+/m);
  if (!fromMatch || !fromMatch[1].endsWith(`/${repoName}`)) {
    log(`Dockerfile FROM line does not match base-images registry for ${repoName}, skipping base tag`);
    return { tagged: false };
  }

  const registry = fromMatch[1];
  const tagPrefix = 'deploy.base';

  // Check if dependency files changed in the committed diff against the base branch
  let changedFiles;
  try {
    changedFiles = execGit(`git diff "origin/${baseBranch}" HEAD --name-only`, tmpDir).trim();
  } catch {
    try {
      changedFiles = execGit(`git diff "${baseBranch}" HEAD --name-only`, tmpDir).trim();
    } catch {
      warn(`Cannot diff against ${baseBranch}, assuming no dependency changes`);
      changedFiles = '';
    }
  }

  const depFiles = ['package.json', 'package-lock.json'];
  const depsChanged = depFiles.some(f => changedFiles.split('\n').includes(f));

  if (!depsChanged) {
    log('No dependency changes detected, skipping base tag');
    return { tagged: false };
  }

  log('Dependency changes detected, creating base tag...');

  // Parse version from branch name: version/1.10.6 → v1-10-6
  const versionMatch = baseBranch.match(/version\/(.+)/);
  if (!versionMatch) {
    warn(`Cannot parse version from branch name: ${baseBranch}`);
    return { tagged: false };
  }
  const versionSlug = 'v' + versionMatch[1].replace(/\./g, '-');

  // Fetch tags to find highest build number
  execGit('git fetch origin --tags', tmpDir);

  // Tag format: deploy.base.v1-10-5-1 (hyphen before build number)
  const tagPattern = `${tagPrefix}.${versionSlug}-`;

  let existingTags;
  try {
    existingTags = execGit(`git tag -l "${tagPattern}*"`, tmpDir).trim();
  } catch {
    existingTags = '';
  }

  let nextBuild = 1;
  if (existingTags) {
    const escapedPattern = tagPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Only match simple build numbers (1-4 digits), ignore timestamp-format tags
    const buildNumbers = existingTags
      .split('\n')
      .map(tag => {
        const match = tag.match(new RegExp(`${escapedPattern}(\\d{1,4})$`));
        return match ? parseInt(match[1], 10) : 0;
      })
      .filter(n => n > 0);
    if (buildNumbers.length > 0) {
      nextBuild = Math.max(...buildNumbers) + 1;
    }
  }

  const newTag = `${tagPrefix}.${versionSlug}-${nextBuild}`;
  log(`Creating base tag: ${newTag}`);

  // Tag HEAD — the feature branch commit that already has dep changes committed+pushed
  execGit(`git tag -a "${newTag}" HEAD -m "Base image tag for ${baseBranch}"`, tmpDir);

  // Push the tag
  execGit(`git push origin "${newTag}"`, tmpDir);
  log(`Base tag pushed: ${newTag}`);

  // Update Dockerfile FROM line
  // The image tag strips the "deploy.base." prefix per the pipeline convention
  const imageTag = `${versionSlug}-${nextBuild}`;
  {
    let updatedDockerfile = fs.readFileSync(dockerfilePath, 'utf-8');
    const fromRegex = new RegExp(`^(FROM\\s+)${registry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\S+`, 'm');
    if (fromRegex.test(updatedDockerfile)) {
      updatedDockerfile = updatedDockerfile.replace(fromRegex, `$1${registry}:${imageTag}`);
      fs.writeFileSync(dockerfilePath, updatedDockerfile);
      log(`Dockerfile FROM updated to ${registry}:${imageTag}`);
    } else {
      warn('Dockerfile FROM line does not match expected registry, skipping update');
    }
  }

  return { tagged: true, tag: newTag };
}
