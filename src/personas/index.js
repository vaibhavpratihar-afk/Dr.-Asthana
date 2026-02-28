import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PERSONA_PATHS = Object.freeze({
  councilProposer: path.join(__dirname, 'council', 'proposer.persona.md'),
  councilCritic: path.join(__dirname, 'council', 'critic.persona.md'),
  councilCriticDiscovery: path.join(__dirname, 'council', 'critic.discovery.persona.md'),
  councilCriticClosure: path.join(__dirname, 'council', 'critic.closure.persona.md'),
  councilAgreement: path.join(__dirname, 'council', 'agreement.persona.md'),
  councilAgreementArbiter: path.join(__dirname, 'council', 'agreement.arbiter.persona.md'),
  councilEvaluator: path.join(__dirname, 'council', 'evaluator.persona.md'),
  councilEvaluatorClosure: path.join(__dirname, 'council', 'evaluator.closure.persona.md'),
  councilProtocolManager: path.join(__dirname, 'council', 'protocol-manager.persona.md'),
  councilBudgetHeaderTemplate: path.join(__dirname, 'council', 'templates', 'budget.header.md'),
  councilProtocolHeaderTemplate: path.join(__dirname, 'council', 'templates', 'protocol.header.md'),
  councilProposerRound1Template: path.join(__dirname, 'council', 'templates', 'proposer.round1.prompt.md'),
  councilProposerRoundNTemplate: path.join(__dirname, 'council', 'templates', 'proposer.roundN.prompt.md'),
  councilCriticRound1Template: path.join(__dirname, 'council', 'templates', 'critic.round1.prompt.md'),
  councilCriticRoundNTemplate: path.join(__dirname, 'council', 'templates', 'critic.roundN.prompt.md'),
  councilAgreementTemplate: path.join(__dirname, 'council', 'templates', 'agreement.prompt.md'),
  reviewProposer: path.join(__dirname, 'review', 'proposer.persona.md'),
  reviewCritic: path.join(__dirname, 'review', 'critic.persona.md'),
  reviewEvaluatorTemplate: path.join(__dirname, 'review', 'evaluator.prompt.md'),
  executorPrompt: path.join(__dirname, 'executor.prompt.md'),
});

const cache = new Map();
const TOKEN_PATTERN = /\{\{([A-Z0-9_]+)\}\}/g;

function readPersona(filePath) {
  if (!cache.has(filePath)) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Persona file not found: ${filePath}`);
    }
    const content = fs.readFileSync(filePath, 'utf8').trimEnd();
    cache.set(filePath, content);
  }
  return cache.get(filePath);
}

export function getPersona(name) {
  const filePath = PERSONA_PATHS[name];
  if (!filePath) throw new Error(`Unknown persona: ${name}`);
  return readPersona(filePath);
}

function findUnresolvedTokens(content) {
  TOKEN_PATTERN.lastIndex = 0;
  const unresolved = new Set();
  let match;
  while ((match = TOKEN_PATTERN.exec(content)) !== null) {
    unresolved.add(match[1]);
  }
  return [...unresolved];
}

export function renderPersonaTemplate(name, values = {}, options = {}) {
  const strict = options.strict !== false;
  let output = getPersona(name);

  for (const tokenName of findUnresolvedTokens(output)) {
    if (!(tokenName in values)) {
      if (strict) {
        throw new Error(`Missing template value for token ${tokenName} in persona ${name}`);
      }
      continue;
    }
    const value = values[tokenName];
    output = output.split(`{{${tokenName}}}`).join(String(value ?? ''));
  }

  const unresolved = findUnresolvedTokens(output);
  if (strict && unresolved.length > 0) {
    throw new Error(`Unresolved tokens in persona ${name}: ${unresolved.join(', ')}`);
  }
  return output;
}

export function buildCouncilEvaluatorPrompt({ ticketContext, councilOutput, force }) {
  const modeInstruction = force
    ? 'You MUST produce a cheatsheet even if the debate output is imperfect. Do your best.'
    : 'Only approve if the debate output contains a clear, actionable implementation plan.';

  return renderPersonaTemplate('councilEvaluatorClosure', {
    TICKET_CONTEXT: ticketContext || '',
    DEBATE_OUTPUT: councilOutput || '',
    MODE_INSTRUCTION: modeInstruction,
  });
}
