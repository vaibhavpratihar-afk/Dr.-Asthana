/**
 * Configuration loader and validator
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { err } from './logger.js';

const CONFIG_PATH = path.join(process.cwd(), 'config.json');

const REQUIRED_FIELDS = [
  'jira.baseUrl',
  'jira.email',
  'jira.apiToken',
  'jira.label',
  'azureDevOps.org',
  'azureDevOps.project',
  'azureDevOps.repoBaseUrl',
];
const SUPPORTED_PROVIDERS = ['claude'];

/**
 * Get a nested property from an object using dot notation
 */
function getNestedValue(obj, path) {
  return path.split('.').reduce((acc, part) => acc?.[part], obj);
}

export function loadConfig() {
  // Load config.json
  if (!fs.existsSync(CONFIG_PATH)) {
    err(`Config file not found: ${CONFIG_PATH}`);
    err('Please create a config.json file.');
    process.exit(1);
  }

  let rawConfig;
  try {
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    rawConfig = JSON.parse(content);
  } catch (e) {
    err(`Failed to parse config.json: ${e.message}`);
    process.exit(1);
  }

  // Validate required fields
  const missing = REQUIRED_FIELDS.filter((field) => {
    const value = getNestedValue(rawConfig, field);
    return !value || value === '';
  });

  if (missing.length > 0) {
    err('Missing required configuration fields:');
    missing.forEach((field) => err(`  - ${field}`));
    process.exit(1);
  }

  // Provider selection
  const provider = String(rawConfig.provider || 'claude').toLowerCase().trim();
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    err(`Unsupported provider "${provider}". Supported providers: ${SUPPORTED_PROVIDERS.join(', ')}`);
    process.exit(1);
  }

  const providerSection = rawConfig[provider] || {};
  const fallbackSection = rawConfig.claude || {};

  // Flatten config to the format used throughout the app
  const config = {
    // AI provider switch (top-level)
    PROVIDER: provider,
    AGENT_PROVIDER: provider,
    AGENT_PROVIDER_LABEL: 'Claude',
    AGENT_INSTRUCTIONS_FILE: 'CLAUDE.md',
    AGENT_CLI_COMMAND: providerSection.command || provider,
    AGENT_MAX_TURNS: providerSection.maxTurns || fallbackSection.maxTurns || 250,
    AGENT_ALLOWED_TOOLS: providerSection.allowedTools || fallbackSection.allowedTools || 'Read,Write,Edit,Bash,Glob,Grep',
    AGENT_TIMEOUT_MINUTES: providerSection.timeoutMinutes || fallbackSection.timeoutMinutes || 30,
    AGENT_RUN_TESTS: providerSection.runTests ?? fallbackSection.runTests ?? true,
    AGENT_PLAN_TURNS: providerSection.planTurns || fallbackSection.planTurns || 20,
    AGENT_PLAN_TIMEOUT_MINUTES: providerSection.planTimeoutMinutes || fallbackSection.planTimeoutMinutes || 10,
    AGENT_VALIDATION_TURNS: providerSection.validationTurns || fallbackSection.validationTurns || 30,
    AGENT_CONTINUATION_TURNS: providerSection.continuationTurns || fallbackSection.continuationTurns || null,
    AGENT_MAX_CONTINUATIONS: providerSection.maxContinuations || fallbackSection.maxContinuations || 0,
    AGENT_CONTINUATION_TIMEOUT_MINUTES: providerSection.continuationTimeoutMinutes || fallbackSection.continuationTimeoutMinutes || null,
    AGENT_COMPLEXITY_SCALING: providerSection.complexityScaling ?? fallbackSection.complexityScaling ?? true,

    // JIRA
    JIRA_BASE_URL: rawConfig.jira.baseUrl.replace(/\/$/, ''),
    JIRA_EMAIL: rawConfig.jira.email,
    JIRA_API_TOKEN: rawConfig.jira.apiToken,
    JIRA_LABEL: rawConfig.jira.label,
    JIRA_LABEL_PROCESSED: rawConfig.jira.labelProcessed || `${rawConfig.jira.label}-done`,
    JIRA_MAX_COMMENTS: rawConfig.jira?.maxComments || 100,
    JIRA_FIELDS: rawConfig.jira.fields || {
      affectedSystems: 'customfield_10056',
      fixVersions: 'fixVersions',
    },

    // Azure DevOps
    AZDO_ORG: rawConfig.azureDevOps.org,
    AZDO_PROJECT: rawConfig.azureDevOps.project,
    AZDO_REPO_BASE_URL: rawConfig.azureDevOps.repoBaseUrl,

    // Services mapping
    SERVICES: rawConfig.services || {},

    // Slack
    SLACK_BOT_TOKEN: rawConfig.slack?.botToken || null,
    SLACK_USER_ID: rawConfig.slack?.userId || null,

    // Agent behavior
    POLL_INTERVAL: rawConfig.agent?.pollInterval || 300,
    MAX_TICKETS_PER_CYCLE: rawConfig.agent?.maxTicketsPerCycle || 1,
    LOG_DIR: rawConfig.agent?.logDir || './logs',

    // Claude Code
    CLAUDE_MAX_TURNS: rawConfig.claude?.maxTurns || 250,
    CLAUDE_ALLOWED_TOOLS: rawConfig.claude?.allowedTools || 'Read,Write,Edit,Bash,Glob,Grep',
    CLAUDE_TIMEOUT_MINUTES: rawConfig.claude?.timeoutMinutes || 30,
    CLAUDE_RUN_TESTS: rawConfig.claude?.runTests ?? true,
    CLAUDE_PLAN_TURNS: rawConfig.claude?.planTurns || 20,
    CLAUDE_PLAN_TIMEOUT_MINUTES: rawConfig.claude?.planTimeoutMinutes || 10,
    CLAUDE_VALIDATION_TURNS: rawConfig.claude?.validationTurns || 30,
    CLAUDE_CONTINUATION_TURNS: rawConfig.claude?.continuationTurns || null,
    CLAUDE_MAX_CONTINUATIONS: rawConfig.claude?.maxContinuations || 0,
    CLAUDE_CONTINUATION_TIMEOUT_MINUTES: rawConfig.claude?.continuationTimeoutMinutes || null,
    CLAUDE_COMPLEXITY_SCALING: rawConfig.claude?.complexityScaling ?? true,

    // Infrastructure
    INFRA_ENABLED: rawConfig.infra?.enabled ?? true,
    INFRA_SCRIPTS_DIR: rawConfig.infra?.scriptsDir || path.join(os.homedir(), 'local-resource-running'),
    INFRA_STOP_AFTER: rawConfig.infra?.stopAfterProcessing ?? false,
  };

  return config;
}

export function getAuthHeader(config) {
  const auth = Buffer.from(`${config.JIRA_EMAIL}:${config.JIRA_API_TOKEN}`).toString('base64');
  return `Basic ${auth}`;
}

/**
 * Get repo URL for a service
 */
export function getRepoUrl(config, serviceName) {
  const service = config.SERVICES[serviceName];
  if (!service) {
    return null;
  }
  return `${config.AZDO_REPO_BASE_URL}/${service.repo}`;
}

/**
 * Get service config by name (case-insensitive)
 */
export function getServiceConfig(config, serviceName) {
  // Try exact match first
  if (config.SERVICES[serviceName]) {
    return { name: serviceName, ...config.SERVICES[serviceName] };
  }

  // Try case-insensitive match
  const lowerName = serviceName.toLowerCase();
  for (const [name, serviceConfig] of Object.entries(config.SERVICES)) {
    if (name.toLowerCase() === lowerName) {
      return { name, ...serviceConfig };
    }
  }

  return null;
}

export default { loadConfig, getAuthHeader, getRepoUrl, getServiceConfig };
