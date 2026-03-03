/**
 * Artifact Runtime - canonical council workspace layout and path resolver.
 *
 * Responsibility:
 * - Create shared/context/round directories.
 * - Provide deterministic file paths for all stages and prompts.
 *
 * Contract:
 * - Markdown files carry reasoning state across members.
 * - JSON files carry deterministic control decisions only.
 */

import path from 'path';
import { writeText } from './files.js';


const contextTemplate = ({ goal, context }) => `# Ticket Context\n\n${context}\n\n## Goal\n\n${goal}\n`;
const rolesTemplate = (roles) => `# Council Roles\n\n## Proposer\n${roles.proposer || ''}\n\n## Critic\n${roles.critic || ''}\n`;
const scopeTemplate = () => '# Scope Lock\n\nFill this with explicit in-scope and out-of-scope notes.\n';
const blockersTemplate = () => '# Blockers Ledger\n\n| ID | Status | Evidence | Owner |\n|---|---|---|---|\n';
const decisionsTemplate = () => '# Decisions\n\n';
const evaluatorFeedbackTemplate = () => '# Evaluator Feedback\n\n';
const protocolTemplate = () => '# Protocol\n\nRound rules and closure mode are written here each round.\n';

export function initArtifacts({ workspace, goal, context, roles }) {
  if (!workspace) return null;
  const contextDir = path.join(workspace, 'context');
  const sharedDir = path.join(workspace, 'shared');
  const roundsDir = path.join(workspace, 'rounds');

  const files = {
    ticketContext: path.join(contextDir, 'ticket-context.md'),
    roles: path.join(contextDir, 'roles.md'),
    scopeLock: path.join(sharedDir, 'scope-lock.md'),
    blockers: path.join(sharedDir, 'blockers.md'),
    decisions: path.join(sharedDir, 'decisions.md'),
    evaluatorFeedback: path.join(sharedDir, 'evaluator-feedback.md'),
    protocol: path.join(sharedDir, 'protocol.md'),
  };

  writeText(files.ticketContext, contextTemplate({ goal, context }));
  writeText(files.roles, rolesTemplate(roles));
  writeText(files.scopeLock, scopeTemplate());
  writeText(files.blockers, blockersTemplate());
  writeText(files.decisions, decisionsTemplate());
  writeText(files.evaluatorFeedback, evaluatorFeedbackTemplate());
  writeText(files.protocol, protocolTemplate());

  return { workspace, contextDir, sharedDir, roundsDir, files };
}

export function roundArtifacts(artifacts, round, criticCount) {
  const roundDir = path.join(artifacts.roundsDir, `round-${round}`);
  const files = {
    proposer: path.join(roundDir, 'proposer.md'),
    evaluation: path.join(roundDir, 'evaluation.md'),
    control: path.join(roundDir, 'control.json'),
    critics: Array.from({ length: criticCount }, (_, index) => path.join(roundDir, `critic-${index + 1}.md`)),
  };
  return { round, roundDir, files };
}
