#!/usr/bin/env node
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { sendDM, buildSuccessBlocks, buildBailoutBlocks, buildFailureBlocks } from './slack.js';

// ── Config ──────────────────────────────────────────────────────────────────

const config = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config.json'), 'utf8'));
const PERSONA = fs.readFileSync(new URL('./agent.prompt.md', import.meta.url), 'utf8').trimEnd();
const TMP_BASE = path.join(process.cwd(), '.tmp');

// ── JIRA search (daemon needs this) ────────────────────────────────────────

async function searchTickets() {
  const { baseUrl, email, apiToken, label } = config.jira;
  const jql = `labels = "${label}" AND statusCategory != Done ORDER BY priority DESC`;
  const params = new URLSearchParams({ jql, maxResults: String(config.agent.maxTicketsPerCycle || 1), fields: 'summary' });
  const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');

  const res = await fetch(`${baseUrl}/rest/api/3/search/jql?${params}`, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`JIRA search ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.issues || []).map(i => ({ key: i.key, summary: i.fields?.summary || '' }));
}

// ── Prompt builder ─────────────────────────────────────────────────────────

function buildPrompt(ticketKey) {
  const serviceMap = Object.entries(config.services)
    .map(([name, svc]) => `  ${name} → ${svc.repo}`)
    .join('\n');

  const context = `
---

# Pipeline Context

**Ticket:** ${ticketKey}
**JIRA URL:** ${config.jira.baseUrl}/browse/${ticketKey}

## Service → Repository Mapping
${serviceMap}

**Repo base URL:** \`${config.azureDevOps.repoBaseUrl}\`

## Azure DevOps
- **Org:** ${config.azureDevOps.org}
- **Project:** ${config.azureDevOps.project}
`;

  return PERSONA + '\n' + context;
}

// ── Spawn Claude ───────────────────────────────────────────────────────────

function spawnClaude(prompt, cwd) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
    if (config.aiProvider?.execute?.model) args.push('--model', config.aiProvider.execute.model);
    if (config.aiProvider?.execute?.maxTurns) args.push('--max-turns', String(config.aiProvider.execute.maxTurns));

    const proc = spawn(config.aiProvider?.execute?.command || 'claude', args, {
      cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    proc.stdout.on('data', d => {
      const chunk = d.toString();
      stdout += chunk;
      // Live progress: log tool calls
      for (const line of chunk.split('\n')) {
        try {
          const e = JSON.parse(line.trim());
          if (e.type === 'assistant' && e.message?.content) {
            for (const b of e.message.content) {
              if (b.type === 'tool_use') {
                console.log(`  [tool] ${b.name}${b.input?.command ? ': ' + b.input.command.substring(0, 100) : ''}`);
              }
            }
          }
        } catch {}
      }
    });
    proc.stderr.on('data', d => {
      const msg = d.toString().trim();
      if (msg) console.log(`  [stderr] ${msg.substring(0, 200)}`);
    });

    proc.on('close', code => resolve({ stdout, exitCode: code }));
    proc.on('error', e => reject(new Error(`Failed to spawn claude: ${e.message}`)));
  });
}

// ── Parse Claude output ────────────────────────────────────────────────────

function extractAgentText(stdout) {
  const texts = [];
  let resultText = '';
  for (const line of (stdout || '').split('\n')) {
    try {
      const e = JSON.parse(line.trim());
      if (e.type === 'result' && e.result) resultText = e.result;
      if (e.type === 'assistant' && e.message?.content) {
        for (const b of e.message.content) {
          if (b.type === 'text' && b.text) texts.push(b.text);
        }
      }
    } catch {}
  }
  return resultText || texts.join('\n') || stdout || '';
}

function parseResult(text) {
  const match = text.match(/\*\*RESULT_JSON\*\*\s*\n([\s\S]*?)\n\*\*END_RESULT_JSON\*\*/);
  if (!match) return null;
  try { return JSON.parse(match[1].trim()); } catch { return null; }
}

// ── Slack notification ─────────────────────────────────────────────────────

async function notifySlack(ticketKey, result) {
  const ticketUrl = `${config.jira.baseUrl}/browse/${ticketKey}`;
  const summary = result?.summary || ticketKey;

  let blocks, fallback;
  if (result?.status === 'success') {
    blocks = buildSuccessBlocks({ ticketKey, ticketUrl, summary, prUrl: result.prUrl || 'N/A' });
    fallback = `PR created for ${ticketKey}: ${result.prUrl || 'unknown'}`;
  } else if (result?.status === 'bailout') {
    blocks = buildBailoutBlocks({ ticketKey, ticketUrl, summary, ...result });
    fallback = `Needs human: ${ticketKey} — ${result.reason}`;
  } else {
    blocks = buildFailureBlocks({ ticketKey, ticketUrl, reason: result?.reason || 'Agent produced no result' });
    fallback = `Failed: ${ticketKey} — ${result?.reason || 'unknown'}`;
  }

  await sendDM(config.slack, blocks, fallback);
}

// ── Pipeline ───────────────────────────────────────────────────────────────

function mkTmpDir() {
  if (!fs.existsSync(TMP_BASE)) fs.mkdirSync(TMP_BASE, { recursive: true });
  return fs.mkdtempSync(path.join(TMP_BASE, 'agent-'));
}

function cleanup(dir) {
  if (!dir || !path.resolve(dir).startsWith(path.resolve(TMP_BASE))) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

async function processTicket(ticketKey) {
  console.log(`\n=== Processing ${ticketKey} ===\n`);
  const tmpDir = mkTmpDir();
  console.log(`Working dir: ${tmpDir}`);

  try {
    const prompt = buildPrompt(ticketKey);
    console.log(`Prompt: ${prompt.length} chars`);

    const start = Date.now();
    const { stdout, exitCode } = await spawnClaude(prompt, tmpDir);
    const elapsed = Math.floor((Date.now() - start) / 1000);
    console.log(`\nClaude exited: code=${exitCode}, duration=${elapsed}s`);

    const text = extractAgentText(stdout);
    const result = parseResult(text);

    if (result) {
      console.log(`Result: ${JSON.stringify(result)}`);
    } else {
      console.log('No structured RESULT_JSON found in output');
    }

    await notifySlack(ticketKey, result || { status: 'failure', reason: 'No structured result from agent' });
    return result;
  } catch (e) {
    console.error(`Error: ${e.message}`);
    await notifySlack(ticketKey, { status: 'failure', reason: e.message });
    return null;
  } finally {
    cleanup(tmpDir);
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case 'single': {
    if (!args[0]) { console.error('Usage: single <TICKET-KEY>'); process.exit(1); }
    await processTicket(args[0]);
    break;
  }

  case 'dry-run': {
    console.log('DRY RUN — polling JIRA, no execution');
    const tickets = await searchTickets();
    if (tickets.length === 0) console.log('No tickets found');
    else tickets.forEach(t => console.log(`  ${t.key} — ${t.summary}`));
    break;
  }

  case 'daemon': {
    console.log('== Dr. Asthana v3 ==');
    console.log(`Poll: ${config.agent.pollInterval || 300}s | Services: ${Object.keys(config.services).join(', ')}`);
    let cycle = 0;
    while (true) {
      cycle++;
      try {
        console.log(`\n--- Cycle ${cycle} ---`);
        const tickets = await searchTickets();
        if (tickets.length === 0) { console.log('No tickets'); }
        else { for (const t of tickets) await processTicket(t.key); }
      } catch (e) { console.error(`Cycle failed: ${e.message}`); }
      await new Promise(r => setTimeout(r, (config.agent.pollInterval || 300) * 1000));
    }
  }

  default:
    console.log(`
== Dr. Asthana v3 ==

  daemon              Poll JIRA continuously, process tickets
  single <KEY>        Process one ticket
  dry-run             Poll once, show tickets, don't execute
`);
}
