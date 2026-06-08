import fs from 'fs';
import path from 'path';

const CONFIG_PATH = path.join(process.cwd(), 'config.json');

const REQUIRED = [
  'jira.baseUrl',
  'jira.email',
  'jira.apiToken',
  'jira.label',
  'cmsAi.path',
];

function get(obj, dotPath) {
  return dotPath.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

/**
 * Load and validate config.json. Throws on missing required fields.
 */
export function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Config file not found: ${CONFIG_PATH}`);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (e) {
    throw new Error(`Failed to parse config.json: ${e.message}`);
  }

  const missing = REQUIRED.filter((field) => !get(raw, field));
  if (missing.length > 0) {
    throw new Error(`Missing required config fields: ${missing.join(', ')}`);
  }

  const cmsAiPath = path.resolve(raw.cmsAi.path);
  if (!fs.existsSync(path.join(cmsAiPath, '.git'))) {
    throw new Error(`cms-ai path is not a git repo: ${cmsAiPath}`);
  }

  return {
    jira: {
      baseUrl: raw.jira.baseUrl.replace(/\/$/, ''),
      email: raw.jira.email,
      apiToken: raw.jira.apiToken,
      label: raw.jira.label,
      maxComments: Number(raw.jira.maxComments) || 50,
    },
    cmsAi: {
      path: cmsAiPath,
      baseBranch: raw.cmsAi.baseBranch || 'main',
    },
    claude: {
      command: raw.claude?.command || 'claude',
      model: raw.claude?.model || null,
      maxTurns: Number(raw.claude?.maxTurns) || 200,
    },
    slack: {
      botToken: raw.slack?.botToken || null,
      userId: raw.slack?.userId || null,
    },
    maxTickets: Number(raw.maxTickets) || 1,
  };
}

export function authHeader(config) {
  const token = Buffer.from(`${config.jira.email}:${config.jira.apiToken}`).toString('base64');
  return `Basic ${token}`;
}
