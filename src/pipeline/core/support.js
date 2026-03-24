/**
 * File: src/pipeline/core/support.js
 * Module: pipeline
 * Purpose: Shared pipeline rules, formatting helpers, and reusable guardrail utilities.
 * Key Exports: getTicketKey, formatValidationComment, formatNoPrComment, formatFailureComment, toServiceFailure, ensureArtifactDir, runNonBlocking ...
 * Integration Points: Integrates with Jira, service, prompt, notification, and logger modules.
 * Data Flow: Keep side effects explicit; keep pure transformations isolated where possible.
 * Maintenance Notes: Header intentionally documents file intent for fast onboarding and review.
 */
import fs from 'fs';
import path from 'path';
import { getServiceConfig, getRepoUrl } from '../../utils/config.js';
import { getCheckpointPath } from './checkpoint.js';
import { warn } from '../../utils/logger.js';

export const STEP_NUMBER_BY_PHASE = Object.freeze({
  FETCH_TICKET: 1,
  VALIDATE_TICKET: 2,
  CLONE_REPO: 3,
  EXECUTE: 4,
  NOTIFY: 5,
});

/** Accepts either a string key or a `{ key }` search result object. */
export function getTicketKey(ticketOrKey) {
  return typeof ticketOrKey === 'string' ? ticketOrKey : ticketOrKey?.key;
}

export function toServiceFailure(serviceName, baseBranch, message) {
  return { service: serviceName, baseBranch, error: message };
}

/**
 * Reserve the per-ticket artifact directory early so every downstream module can
 * reliably write files under `config._artifactDir`.
 */
export function ensureArtifactDir(ticketKey, config) {
  const artifactDir = getCheckpointPath(ticketKey);
  const aiCallsDir = path.join(artifactDir, 'ai-calls');

  config._artifactDir = artifactDir;
  if (!fs.existsSync(aiCallsDir)) {
    fs.mkdirSync(aiCallsDir, { recursive: true });
  }

  return artifactDir;
}

/**
 * Execute side-effect operations that should not block the main pipeline
 * outcome (comments, transitions, cleanup).
 */
export async function runNonBlocking(label, task) {
  try {
    await task();
  } catch (error) {
    warn(`${label} (non-blocking): ${error.message}`);
  }
}

export function resolveServiceTarget(config, ticket) {
  const serviceName = ticket.affectedSystems?.[0];
  const serviceConfig = getServiceConfig(config, serviceName);
  const repoUrl = getRepoUrl(config, serviceName);

  if (!serviceName || !serviceConfig || !repoUrl) {
    return {
      ok: false,
      reason: `Service configuration is invalid for "${serviceName || 'unknown'}"`,
    };
  }

  return {
    ok: true,
    serviceName,
    serviceConfig,
    repoUrl,
    baseBranch: ticket.targetBranch,
    version: ticket.targetBranches?.[0]?.version || null,
  };
}

