/**
 * Configuration loader and validator.
 *
 * Reads config.json from project root, validates required fields,
 * returns a structured config object matching the v2 schema.
 */

import fs from 'fs';
import path from 'path';

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

function getNestedValue(obj, dotPath) {
  return dotPath.split('.').reduce((acc, part) => acc?.[part], obj);
}

export function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Config file not found: ${CONFIG_PATH}`);
    process.exit(1);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (e) {
    console.error(`Failed to parse config.json: ${e.message}`);
    process.exit(1);
  }

  const missing = REQUIRED_FIELDS.filter(f => {
    const v = getNestedValue(raw, f);
    return !v || v === '';
  });
  if (missing.length > 0) {
    console.error('Missing required configuration fields:');
    missing.forEach(f => console.error(`  - ${f}`));
    process.exit(1);
  }

  // Build structured config
  const config = {
    jira: {
      baseUrl: raw.jira.baseUrl.replace(/\/$/, ''),
      email: raw.jira.email,
      apiToken: raw.jira.apiToken,
      label: raw.jira.label,
      labelProcessed: raw.jira.labelProcessed || `${raw.jira.label}-done`,
      maxComments: raw.jira?.maxComments || 100,
      muteComments: raw.jira?.muteComments ?? false,
      fields: raw.jira.fields || {
        affectedSystems: 'customfield_10056',
        fixVersions: 'fixVersions',
      },
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
      pollInterval: raw.agent?.pollInterval || 300,
      maxTicketsPerCycle: raw.agent?.maxTicketsPerCycle || 1,
      logDir: raw.agent?.logDir || './logs',
    },
    diffReview: { maxRetries: raw.diffReview?.maxRetries ?? 5 },
    aiProvider: buildAiProviderConfig(raw),
  };

  return config;
}

function buildAiProviderConfig(raw) {
  const ai = raw.aiProvider || {};
  const codexRaw = ai.execute?.codex || {};
  return {
    execute: {
      provider: ai.execute?.provider || 'codex',
      allowedTools: ai.execute?.allowedTools || 'Read,Write,Edit,Bash,Glob,Grep',
      codex: {
        model: codexRaw.model || null,
        timeoutMinutes: codexRaw.timeoutMinutes || 30,
      },
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
  if (config.services[serviceName]) {
    return { name: serviceName, ...config.services[serviceName] };
  }
  const lowerName = serviceName.toLowerCase();
  for (const [name, svc] of Object.entries(config.services)) {
    if (name.toLowerCase() === lowerName) {
      return { name, ...svc };
    }
  }
  return null;
}
