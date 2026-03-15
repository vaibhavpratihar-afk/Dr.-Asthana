/**
 * File: src/utils/config.js
 * Module: utils
 * Purpose: Configuration loader with normalization and validation rules.
 * Key Exports: loadConfig, getAuthHeader, getRepoUrl, getServiceConfig
 * Integration Points: Integrates as shared infrastructure across all modules.
 * Data Flow: Keep side effects explicit; keep pure transformations isolated where possible.
 * Maintenance Notes: Header intentionally documents file intent for fast onboarding and review.
 */
import fs from 'fs';
import path from 'path';

const CONFIG_PATH = path.join(process.cwd(), 'config.json');
const DEFAULT_FIELDS = {
  affectedSystems: 'customfield_10056',
  fixVersions: 'fixVersions',
};

const REQUIRED_FIELDS = Object.freeze([
  'jira.baseUrl',
  'jira.email',
  'jira.apiToken',
  'jira.label',
  'azureDevOps.org',
  'azureDevOps.project',
  'azureDevOps.repoBaseUrl',
]);

const NUMERIC_DEFAULTS = Object.freeze({
  jiraMaxComments: 100,
  pollInterval: 300,
  maxTicketsPerCycle: 1,
});

function getNestedValue(obj, dotPath) {
  return dotPath.split('.').reduce((acc, part) => acc?.[part], obj);
}

function collectMissingRequiredFields(rawConfig) {
  const missing = [];
  for (let index = 0; index < REQUIRED_FIELDS.length; index += 1) {
    const field = REQUIRED_FIELDS[index];
    const value = getNestedValue(rawConfig, field);
    if (!value || value === '') {
      missing.push(field);
    }
  }
  return missing;
}

function toPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new ConfigError(`Config file not found: ${CONFIG_PATH}`);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (e) {
    throw new ConfigError(`Failed to parse config.json: ${e.message}`);
  }

  const missing = collectMissingRequiredFields(raw);
  if (missing.length > 0) {
    throw new ConfigError(`Missing required configuration fields: ${missing.join(', ')}`);
  }

  // Build structured config
  const jiraFields = { ...DEFAULT_FIELDS, ...(raw.jira.fields || {}) };
  const config = {
    jira: {
      baseUrl: raw.jira.baseUrl.replace(/\/$/, ''),
      email: raw.jira.email,
      apiToken: raw.jira.apiToken,
      label: raw.jira.label,
      maxComments: toPositiveInteger(raw.jira?.maxComments, NUMERIC_DEFAULTS.jiraMaxComments),
      fields: jiraFields,
    },
    azureDevOps: {
      org: raw.azureDevOps.org,
      project: raw.azureDevOps.project,
      repoBaseUrl: raw.azureDevOps.repoBaseUrl,
    },
    services: raw.services || {},
    slack: {
      botToken: raw.slack?.botToken || null,
      userId: raw.slack?.userId || null,
    },
    agent: {
      pollInterval: toPositiveInteger(raw.agent?.pollInterval, NUMERIC_DEFAULTS.pollInterval),
      maxTicketsPerCycle: toPositiveInteger(raw.agent?.maxTicketsPerCycle, NUMERIC_DEFAULTS.maxTicketsPerCycle),
      logDir: raw.agent?.logDir || './logs',
    },
    aiProvider: buildAiProviderConfig(raw),
  };

  return config;
}

function buildAiProviderConfig(raw) {
  const ai = raw.aiProvider || {};
  const execute = ai.execute || {};
  const provider = execute.provider;
  if (!provider) {
    throw new ConfigError('Missing required configuration field: aiProvider.execute.provider');
  }
  const providerConfig = execute[provider];
  if (!providerConfig || typeof providerConfig !== 'object') {
    throw new ConfigError(`Missing provider section for aiProvider.execute.${provider}`);
  }
  if (!providerConfig.command) {
    throw new ConfigError(`Missing required configuration field: aiProvider.execute.${provider}.command`);
  }

  return {
    execute: {
      provider,
      [provider]: { ...providerConfig },
    },
  };
}

/**
 * Get JIRA Basic auth header
 */
export function getAuthHeader(config) {
  const auth = Buffer.from(`${config.jira.email}:${config.jira.apiToken}`).toString('base64');
  return `Basic ${auth}`;
}

/**
 * Get repo URL for a service
 */
export function getRepoUrl(config, serviceName) {
  const service = config.services[serviceName];
  if (!service) return null;
  return `${config.azureDevOps.repoBaseUrl}/${service.repo}`;
}

/**
 * Get service config by name (case-insensitive)
 */
export function getServiceConfig(config, serviceName) {
  if (!serviceName || typeof serviceName !== 'string') {
    return null;
  }

  if (config.services[serviceName]) {
    return { name: serviceName, ...config.services[serviceName] };
  }
  const lowerName = serviceName.toLowerCase();
  const serviceEntries = Object.entries(config.services);
  for (let index = 0; index < serviceEntries.length; index += 1) {
    const [name, svc] = serviceEntries[index];
    if (name.toLowerCase() === lowerName) {
      return { name, ...svc };
    }
  }
  return null;
}
