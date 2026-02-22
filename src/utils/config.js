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
      executionRetries: raw.agent?.executionRetries ?? 1,
    },
    aiProvider: {
      strategy: raw.aiProvider?.strategy || 'single',
      execute: {
        provider: raw.aiProvider?.execute?.provider || 'claude',
        fallbackProvider: raw.aiProvider?.execute?.fallbackProvider || null,
        claude: {
          model: raw.aiProvider?.execute?.claude?.model || 'haiku',
          maxTurns: raw.aiProvider?.execute?.claude?.maxTurns || 30,
          timeoutMinutes: raw.aiProvider?.execute?.claude?.timeoutMinutes || 15,
          allowedTools: raw.aiProvider?.execute?.claude?.allowedTools || 'Read,Write,Edit,Bash,Glob,Grep',
        },
        codex: {
          model: raw.aiProvider?.execute?.codex?.model || null,
          timeoutMinutes: raw.aiProvider?.execute?.codex?.timeoutMinutes || 15,
        },
      },
      debate: {
        provider: raw.aiProvider?.debate?.provider || 'claude',
        maxRounds: raw.aiProvider?.debate?.maxRounds || 3,
        claude: {
          model: raw.aiProvider?.debate?.claude?.model || 'sonnet',
          maxTurns: raw.aiProvider?.debate?.claude?.maxTurns || 15,
          timeoutMinutes: raw.aiProvider?.debate?.claude?.timeoutMinutes || 10,
          allowedTools: raw.aiProvider?.debate?.claude?.allowedTools || 'Read,Glob,Grep',
        },
        codex: {
          model: raw.aiProvider?.debate?.codex?.model || null,
          timeoutMinutes: raw.aiProvider?.debate?.codex?.timeoutMinutes || 10,
        },
      },
      evaluate: {
        provider: raw.aiProvider?.evaluate?.provider || 'claude',
        claude: {
          model: raw.aiProvider?.evaluate?.claude?.model || 'sonnet',
          maxTurns: raw.aiProvider?.evaluate?.claude?.maxTurns || 5,
          timeoutMinutes: raw.aiProvider?.evaluate?.claude?.timeoutMinutes || 5,
          allowedTools: raw.aiProvider?.evaluate?.claude?.allowedTools || 'Read,Glob,Grep',
        },
      },
    },
    infra: {
      enabled: raw.infra?.enabled ?? false,
      scriptsDir: raw.infra?.scriptsDir || '',
      stopAfterProcessing: raw.infra?.stopAfterProcessing ?? false,
    },
    tests: {
      enabled: raw.tests?.enabled ?? false,
    },
  };

  return config;
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
