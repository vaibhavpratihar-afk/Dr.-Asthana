import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXECUTOR_PROMPT = path.join(HERE, '..', 'executor.prompt.md');

function slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function git(cmsAi, args) {
  return execFileSync('git', ['-C', cmsAi, ...args], { encoding: 'utf-8', stdio: 'pipe' });
}

/**
 * Create a clean, throwaway worktree of cms-ai on a fresh feature branch.
 * The live workspace is never touched.
 */
function makeWorktree(config, ticketKey, summary) {
  const { path: cmsAi, baseBranch } = config.cmsAi;
  const branch = `feature/${ticketKey}-${slug(summary)}-${Date.now().toString(36)}`;
  const dir = path.join(os.tmpdir(), `cms-ai-${ticketKey}-${Date.now().toString(36)}`);

  try {
    git(cmsAi, ['fetch', 'origin', baseBranch, '--quiet']);
  } catch (e) {
    console.warn(`  warn: fetch failed, using last-known origin/${baseBranch}: ${e.message.split('\n')[0]}`);
  }
  git(cmsAi, ['worktree', 'add', '-b', branch, dir, `origin/${baseBranch}`]);
  return { dir, branch };
}

function removeWorktree(config, wt) {
  const cmsAi = config.cmsAi.path;
  try {
    git(cmsAi, ['worktree', 'remove', '--force', wt.dir]);
  } catch {
    fs.rmSync(wt.dir, { recursive: true, force: true });
  }
  try {
    git(cmsAi, ['branch', '-D', wt.branch]);
  } catch {
    // branch may have been consumed/renamed by the agent; ignore
  }
}

function buildUserPrompt(ticket, branch) {
  const lines = [
    `# JIRA Ticket: ${ticket.key}`,
    '',
    `**Summary:** ${ticket.summary}`,
    `**Type:** ${ticket.type}    **Priority:** ${ticket.priority}    **Status:** ${ticket.status}`,
    '',
    '## Description',
    ticket.description || '_No description provided._',
  ];
  if (ticket.comments.length > 0) {
    lines.push('', '## Comments');
    ticket.comments.forEach((c, i) => {
      lines.push('', `### Comment ${i + 1} — ${c.author}`, c.text || '');
    });
  }
  lines.push(
    '',
    '---',
    '',
    `You are in a fresh git worktree of the cms-ai workspace, on branch \`${branch}\`.`,
    'Read the workspace instruction files, decide whether this is a knowledge-base task or a',
    'platform-service task, implement it completely, and ship a PR. Follow your system instructions.',
  );
  return lines.join('\n');
}

function parseResult(text) {
  if (!text) return { status: 'failed', summary: 'Agent produced no output' };

  const bail = text.match(/\*\*BAILOUT:\*\*\s*(.+)/);
  if (bail) {
    return {
      status: 'bailout',
      reason: bail[1].trim(),
      suggestion: text.match(/\*\*SUGGESTION:\*\*\s*(.+)/)?.[1]?.trim() || null,
    };
  }

  const pr = text.match(/\*\*PR URL:\*\*\s*(https?:\/\/\S+)/);
  const summary = text.match(/\*\*SUMMARY:\*\*\s*([\s\S]+?)(?:\n\*\*|$)/)?.[1]?.trim() || null;
  if (pr) return { status: 'shipped', prUrl: pr[1].trim(), summary };
  return { status: 'failed', summary: summary || 'No PR URL found in agent output' };
}

function spawnClaude(config, cwd, userPrompt) {
  const args = [
    '-p', userPrompt,
    '--output-format', 'json',
    '--append-system-prompt', fs.readFileSync(EXECUTOR_PROMPT, 'utf-8'),
    '--max-turns', String(config.claude.maxTurns),
    '--dangerously-skip-permissions',
  ];
  if (config.claude.model) args.push('--model', config.claude.model);

  return new Promise((resolve, reject) => {
    const proc = spawn(config.claude.command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const beat = setInterval(() => process.stdout.write('.'), 30_000);

    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', (e) => {
      clearInterval(beat);
      reject(new Error(`Failed to spawn ${config.claude.command}: ${e.message}`));
    });
    proc.on('close', (code) => {
      clearInterval(beat);
      process.stdout.write('\n');
      resolve({ stdout, stderr, code });
    });
  });
}

/**
 * Run one ticket end-to-end through Claude in a fresh cms-ai worktree.
 * Returns { status: 'shipped'|'bailout'|'failed', prUrl?, summary?, reason?, suggestion? }.
 */
export async function runTicket(config, ticket) {
  const wt = makeWorktree(config, ticket.key, ticket.summary);
  console.log(`  worktree: ${wt.dir} (branch ${wt.branch})`);

  try {
    const { stdout, code } = await spawnClaude(config, wt.dir, buildUserPrompt(ticket, wt.branch));

    let result = '';
    try {
      result = JSON.parse(stdout.trim()).result || '';
    } catch {
      result = stdout; // fall back to raw output if not valid JSON
    }

    const outcome = parseResult(result);
    if (code !== 0 && outcome.status === 'failed') {
      outcome.summary = `claude exited ${code}: ${outcome.summary}`;
    }
    return outcome;
  } finally {
    removeWorktree(config, wt);
  }
}
