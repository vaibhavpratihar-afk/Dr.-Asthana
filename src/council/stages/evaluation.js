/**
 * Evaluation Stage - final round gate recorded as markdown + deterministic JSON.
 *
 * Responsibility:
 * - Evaluate round artifacts.
 * - Persist evaluation feedback for next rounds.
 */

import { evaluate } from '../evaluator/evaluator.js';
import { updateStatus } from '../runtime/workspace.js';
import { appendText, readJson, readText, writeJson, writeText } from '../runtime/files.js';
import { log } from '../../utils/logger.js';

const stageSuccess = (reason, data = {}) => ({ ok: true, reason, data });
const appendDecisionLog = (shared, round, body) => appendText(shared.decisions, `\n## Round ${round} - evaluation\n\n${body}\n`);

export async function runEvaluationStage({ round, maxRounds, workspace, label, evalOpts, isLastRound, artifacts }) {
  const forceEval = isLastRound && (evalOpts.forceOnLastRound !== false);
  updateStatus(workspace, label, maxRounds, round, 'evaluating');

  // Include proposer + critic outputs; agreement stage has been removed.
  const proposerOutput = readText(artifacts.round.proposer, '');
  const criticOutputs = (artifacts.round.critics || []).map((file) => readText(file, '')).filter(Boolean);
  const debateOutput = [proposerOutput, ...criticOutputs].filter(Boolean).join('\n\n---\n\n');
  log(`[Round ${round}] Evaluating council output${forceEval ? ' (forced, last round)' : ''}...`);
  const evaluation = await evaluate(debateOutput, { ...evalOpts, round }, forceEval);
  const control = readJson(artifacts.round.control, {});

  writeText(artifacts.round.evaluation, `# Evaluation\n\n**Passed:** ${evaluation.passed}\n\n${evaluation.feedback || evaluation.output || ''}`);
  writeJson(artifacts.round.control, {
    ...control,
    round,
    evaluationVerdict: evaluation.passed ? 'APPROVED' : 'REJECTED',
    nextAction: evaluation.passed ? 'done' : 'next_round',
  });

  if (!evaluation.passed) {
    writeText(artifacts.shared.evaluatorFeedback, `# Evaluator Feedback (Round ${round})\n\n${evaluation.feedback || 'No feedback'}\n`);
    appendDecisionLog(artifacts.shared, round, `Verdict: REJECTED. Feedback recorded to \`${artifacts.shared.evaluatorFeedback}\`.`);
    return stageSuccess('evaluation_rejected', { evaluation });
  }

  appendDecisionLog(artifacts.shared, round, 'Verdict: APPROVED.');
  updateStatus(workspace, label, maxRounds, round, 'done', { result: 'passed' });
  return stageSuccess('evaluation_passed', { evaluation });
}
