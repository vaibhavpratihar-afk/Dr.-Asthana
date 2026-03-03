/**
 * Council Prompt Builders - file-protocol prompts for proposer/critic.
 *
 * Responsibility:
 * - Build stage prompts that reference shared artifact paths.
 * - Avoid semantic summarization in JS; transfer happens through files.
 *
 * Contract:
 * - All prompts include Required Reads and Required Writes sections.
 * - JSON files are reserved for deterministic control contracts.
 */

import fs from 'fs';
import { getPersona, renderPersonaTemplate } from '../personas/index.js';

const roundMode = (roundMeta = {}) => ((roundMeta.round || 1) <= 2 ? 'DISCOVERY' : 'CLOSURE');
const fileList = (paths = []) => paths.filter(Boolean).map((p) => `- \`${p}\``).join('\n') || '- (none)';

const buildRoundBudgetHeader = (roundMeta = {}) => {
  const round = roundMeta.round || 1;
  const maxRounds = roundMeta.maxRounds || 1;
  const roundsLeft = typeof roundMeta.roundsLeft === 'number' ? roundMeta.roundsLeft : Math.max(maxRounds - round, 0);
  const finalRound = roundsLeft === 0;
  return renderPersonaTemplate('councilBudgetHeaderTemplate', {
    ROUND: round,
    MAX_ROUNDS: maxRounds,
    ROUNDS_LEFT: roundsLeft,
    URGENCY_LINE: finalRound
      ? 'FINAL ROUND: produce a decision-ready artifact now.'
      : 'Use budget carefully. Converge; avoid exploratory rescans.',
    POLICY_LINE: finalRound
      ? 'No further rounds exist. Mark unresolved items explicitly.'
      : 'No reopen without new file evidence.',
  });
};

const buildProtocolHeader = (roundMeta = {}) => {
  const mode = roundMode(roundMeta);
  const round = roundMeta.round || 1;
  const maxRounds = roundMeta.maxRounds || 1;
  const roundsLeft = typeof roundMeta.roundsLeft === 'number' ? roundMeta.roundsLeft : Math.max(maxRounds - round, 0);
  return renderPersonaTemplate('councilProtocolHeaderTemplate', {
    MODE: mode,
    ROUND: round,
    MAX_ROUNDS: maxRounds,
    ROUNDS_LEFT: roundsLeft,
    OPEN_BLOCKERS: '- Read `shared/blockers.md` and update only with file-backed evidence.',
    ALLOWED_MOVES: mode === 'DISCOVERY'
      ? '- Add net-new blocker classes with evidence.\n- Mark NO_NEW_BLOCKERS when applicable.'
      : '- Verify unresolved blockers and close them.\n- Prefer READY_FOR_AGREEMENT when no blocker remains.',
    FORBIDDEN_MOVES: mode === 'DISCOVERY'
      ? '- No speculative blockers.\n- No style-only objections.'
      : '- No broad rescans.\n- No reopen without new evidence.',
    DECISION_RULE: mode === 'DISCOVERY'
      ? 'Build high-signal blocker inventory.'
      : 'Close blockers and converge to final decision.',
  });
};

const buildArtifactBlock = (title, paths) => `## ${title}\n${fileList(paths)}`;

const existsOnDisk = (p) => p && fs.existsSync(p);

const artifactSections = (roundMeta = {}, stage) => {
  const artifacts = roundMeta.artifacts || {};

  // Shared files are always seeded by initArtifacts; round files may not exist yet.
  const sharedReads = [
    artifacts?.shared?.ticketContext,
    artifacts?.shared?.roles,
    artifacts?.shared?.scopeLock,
    artifacts?.shared?.blockers,
    artifacts?.shared?.decisions,
    artifacts?.shared?.evaluatorFeedback,
    artifacts?.shared?.protocol,
  ];
  const roundReads = [
    artifacts?.round?.proposer,
    ...(artifacts?.round?.critics || []),
    artifacts?.round?.evaluation,
  ].filter(existsOnDisk);

  const reads = [...sharedReads, ...roundReads];

  const writesByStage = {
    proposer: [artifacts?.round?.proposer, artifacts?.shared?.scopeLock, artifacts?.shared?.decisions],
    critic: [artifacts?.round?.criticCurrent, artifacts?.shared?.blockers, artifacts?.shared?.decisions],
  };

  return `${buildArtifactBlock('Required Reads', reads)}\n\n${buildArtifactBlock('Writable Artifacts', writesByStage[stage] || [])}\nYour main response will be captured and saved by the orchestrator. You may also write directly to shared artifacts (blockers, decisions, scope-lock) to update them.`;
};

export function buildProposerPrompt(round, baseContext, proposerOutput, criticOutputs, proposerRole, initialFeedback, roundMeta) {
  const budget = buildRoundBudgetHeader(roundMeta);
  const protocol = buildProtocolHeader(roundMeta);
  const artifacts = artifactSections(roundMeta, 'proposer');
  if (round === 1) {
    return renderPersonaTemplate('councilProposerRound1Template', {
      BASE_CONTEXT: baseContext,
      BUDGET_HEADER: budget,
      PROTOCOL_HEADER: `${protocol}\n\n${artifacts}`,
      PROPOSER_ROLE: proposerRole,
      PREVIOUS_FEEDBACK_BLOCK: initialFeedback ? `## Previous Feedback\n${initialFeedback}` : '',
    });
  }

  return renderPersonaTemplate('councilProposerRoundNTemplate', {
    BASE_CONTEXT: baseContext,
    BUDGET_HEADER: budget,
    PROTOCOL_HEADER: `${protocol}\n\n${artifacts}`,
    PROPOSER_OUTPUT: 'Use `rounds/round-(N-1)/proposer.md` and shared files as source of truth.',
    CRITIC_COUNT: 0,
    CRITIQUE_SUMMARY: 'Read critic files directly from `rounds/round-(N-1)/critic-*.md`.',
  });
}

export function buildCriticPrompt(round, baseContext, proposerOutput, criticOutputs, criticIndex, criticRole, roundMeta) {
  const budget = buildRoundBudgetHeader(roundMeta);
  const protocol = buildProtocolHeader(roundMeta);
  const modePersona = roundMode(roundMeta) === 'DISCOVERY' ? getPersona('councilCriticDiscovery') : getPersona('councilCriticClosure');
  const artifacts = artifactSections(roundMeta, 'critic');
  const vars = {
    BASE_CONTEXT: baseContext,
    BUDGET_HEADER: budget,
    PROTOCOL_HEADER: `${protocol}\n\n${artifacts}`,
    PROPOSER_OUTPUT: 'Read current proposer artifact from this round.',
    PRIOR_CRITIQUES_BLOCK: 'Read prior critic artifacts from this round.',
    CRITIC_INDEX: criticIndex,
    CRITIC_ROLE: modePersona || criticRole,
  };

  return round === 1
    ? renderPersonaTemplate('councilCriticRound1Template', vars)
    : renderPersonaTemplate('councilCriticRoundNTemplate', vars);
}
