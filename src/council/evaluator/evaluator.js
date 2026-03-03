/**
 * Evaluator - final quality gate for council output.
 *
 * Responsibility:
 * - Run structural checks and evaluator agents in deterministic order.
 * - Read verdict from JSON contract instead of free-form model prose.
 *
 * Contract:
 * - Returns { passed, feedback, output } only.
 * - In non-forced mode, structural failure rejects immediately.
 * - In forced mode, may approve best-effort output after evaluator failures.
 */

import fs from 'fs';
import path from 'path';
import { runAI } from '../../ai-provider/index.js';
import { isGarbageOutput } from '../../ai-provider/provider.js';
import { buildEvaluationContractPrompt, readEvaluationContract } from '../contract/index.js';
import {
  defaultStructuralCheck,
  DEFAULT_APPROVAL_KEYWORD,
  DEFAULT_REJECTION_KEYWORD,
} from '../config/defaults.js';
import { log, warn } from '../../utils/logger.js';

const DEFAULT_EVALUATOR = Object.freeze({
  provider: 'claude',
  model: 'sonnet',
  maxTurns: 5,
  timeoutMinutes: 5,
  allowedTools: 'Read,Glob,Grep',
});

const approve = (output, feedback = '') => ({ passed: true, feedback, output });
const reject = (feedback) => ({ passed: false, feedback, output: null });
const addWriteTool = (allowedTools) => (!allowedTools ? 'Read,Write,Glob,Grep' : (allowedTools.includes('Write') ? allowedTools : `${allowedTools},Write`));
const normalizeEvaluators = (evalConfig) => (Array.isArray(evalConfig) && evalConfig.length ? evalConfig : (evalConfig && typeof evalConfig === 'object' ? [evalConfig] : [DEFAULT_EVALUATOR]));

const resolveContractPath = ({ workspace, round }) => {
  const safeRound = Number.isInteger(round) && round > 0 ? round : 0;
  return path.join(workspace, `rounds/round-${safeRound}/evaluation-contract.json`);
};

const clearContract = (contractPath) => {
  try { fs.unlinkSync(contractPath); } catch { /* ignore */ }
};

const extractByMarkers = (output, markers) => {
  if (!markers?.start || !markers?.end) return null;
  const startIdx = output.indexOf(markers.start);
  const endIdx = output.indexOf(markers.end);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return null;
  return output.substring(startIdx + markers.start.length, endIdx).trim();
};

const buildRuntime = (councilOutput, evalOpts, force) => {
  const {
    structural = defaultStructuralCheck,
    buildAiPrompt,
    outputMarkers,
    approvalKeyword = DEFAULT_APPROVAL_KEYWORD,
    rejectionKeyword = DEFAULT_REJECTION_KEYWORD,
    context,
    config,
    label = 'eval',
    workspace = null,
    round = null,
    workingDir = process.cwd(),
  } = evalOpts;

  return {
    councilOutput,
    structural,
    buildAiPrompt,
    outputMarkers,
    context,
    config,
    label,
    force,
    keywords: {
      approval: approvalKeyword.toUpperCase(),
      rejection: rejectionKeyword.toUpperCase(),
    },
    evaluators: normalizeEvaluators(config?.council?.evaluator || null),
    contractPath: resolveContractPath({ workspace, round }),
    workingDir,
  };
};

const runOneEvaluator = async (runtime, evaluator, index, prompt) => {
  const evLabel = `evaluator-${index}${runtime.force ? '-force' : ''}`;
  log(`[${evLabel}] provider=${evaluator.provider}, model=${evaluator.model || 'default'}`);
  clearContract(runtime.contractPath);

  try {
    const providerConfig = { ...evaluator, allowedTools: addWriteTool(evaluator.allowedTools) };
    const result = await runAI({
      prompt,
      workingDir: runtime.workingDir,
      mode: 'evaluate',
      label: evLabel,
      logDir: runtime.config.agent.logDir,
      ticketKey: runtime.label,
      config: runtime.config,
      providerConfig,
    });
    const output = result.output || '';
    if (isGarbageOutput(output)) return { status: 'retry', reason: 'garbage output' };

    const contract = readEvaluationContract(runtime.contractPath, {
      approvalKeyword: runtime.keywords.approval,
      rejectionKeyword: runtime.keywords.rejection,
    });
    if (!contract.valid) return { status: 'retry', reason: `invalid contract: ${contract.reason}` };

    switch (contract.verdict) {
      case runtime.keywords.approval: {
        // Try evaluator output first (may contain a curated cheatsheet),
        // then fall back to council output (proposer wrote markers there).
        // This avoids requiring the evaluator to re-emit large cheatsheets.
        const fromEvaluator = extractByMarkers(output, runtime.outputMarkers);
        const fromCouncil = extractByMarkers(runtime.councilOutput, runtime.outputMarkers);
        const extracted = (fromEvaluator && fromEvaluator.length > 100) ? fromEvaluator
          : (fromCouncil && fromCouncil.length > 100) ? fromCouncil
          : null;
        return { status: 'approved', output: extracted || runtime.councilOutput };
      }
      default: {
        const feedback = contract.feedback || contract.issues?.join('; ') || 'Evaluator rejected without specific feedback';
        return runtime.force ? { status: 'retry', reason: 'rejected during forced mode' } : { status: 'rejected', feedback };
      }
    }
  } catch (err) {
    return { status: 'retry', reason: err.message };
  }
};

/**
 * Evaluate council output with strict contract-driven verdict parsing.
 *
 * @param {string} councilOutput
 * @param {object} evalOpts
 * @param {boolean} [force=false]
 * @returns {Promise<{passed: boolean, feedback: string, output: string|null}>}
 */
export async function evaluate(councilOutput, evalOpts, force = false) {
  const runtime = buildRuntime(councilOutput, evalOpts, force);

  // Structural gate prevents wasted evaluator calls in normal mode.
  const structuralResult = runtime.structural(councilOutput);
  if (!runtime.force && !structuralResult.passed) return reject(structuralResult.feedback);

  fs.mkdirSync(path.dirname(runtime.contractPath), { recursive: true });
  const prompt = `${runtime.buildAiPrompt(runtime.councilOutput, runtime.context, runtime.force)}${buildEvaluationContractPrompt(runtime.contractPath, {
    approvalKeyword: runtime.keywords.approval,
    rejectionKeyword: runtime.keywords.rejection,
  })}`;

  for (let index = 0; index < runtime.evaluators.length; index++) {
    const outcome = await runOneEvaluator(runtime, runtime.evaluators[index], index, prompt);
    // Single status switch keeps evaluator loop deterministic and linear.
    switch (outcome.status) {
      case 'approved':
        return approve(outcome.output);
      case 'rejected':
        return reject(outcome.feedback);
      default:
        warn(`[evaluator-${index}] Skipping outcome: ${outcome.reason}`);
    }
  }

  if (runtime.force) {
    const fallback = extractByMarkers(runtime.councilOutput, runtime.outputMarkers);
    return approve(fallback || runtime.councilOutput, 'Forced pass: all evaluators failed or were inconclusive');
  }
  return reject('All evaluators failed or returned inconclusive contracts');
}
