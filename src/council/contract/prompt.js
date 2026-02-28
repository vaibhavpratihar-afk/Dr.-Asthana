/**
 * Contract Prompt Builders - deterministic write-contract instructions.
 *
 * Responsibility:
 * - Produce prompt fragments that force agents to write JSON contracts.
 *
 * Contract:
 * - Output strings are append-only prompt sections.
 * - Decision/verdict enums are explicit so parser behavior is deterministic.
 */

const joinLines = (lines) => lines.join('\n');
const fencedJson = (json) => ['```json', json, '```'];

/**
 * Build instructions for the agreement contract.
 *
 * @param {string} contractPath - Absolute path where agent should write the JSON
 * @returns {string} Instruction block to append to the agreement prompt
 */
export function buildAgreementContractPrompt(contractPath) {
  return joinLines([
    '',
    '## Required: Write Decision Contract',
    '',
    'After your analysis, you MUST use the Write tool to create the following JSON file.',
    'This is how the system reads your decision — your markdown text is for discussion only.',
    '',
    `**File path:** \`${contractPath}\``,
    '',
    'If you AGREE (your existing plan already covers all valid critiques without changes):',
    ...fencedJson('{"decision": "AGREED"}'),
    '',
    'If you DISAGREE (at least one critique requires plan changes):',
    ...fencedJson('{"decision": "DISAGREE", "reasoning": "brief explanation of what changed"}'),
    '',
    'Write this file BEFORE your final response. The decision field must be exactly "AGREED" or "DISAGREE".',
  ]);
}

/**
 * Build instructions for the evaluation contract.
 *
 * @param {string} contractPath - Absolute path where evaluator should write the JSON
 * @param {{ approvalKeyword?: string, rejectionKeyword?: string }} [opts]
 * @returns {string} Instruction block to append to the evaluation prompt
 */
export function buildEvaluationContractPrompt(contractPath, opts = {}) {
  const approvalKeyword = opts.approvalKeyword || 'APPROVED';
  const rejectionKeyword = opts.rejectionKeyword || 'REJECTED';

  return joinLines([
    '',
    '## Required: Write Verdict Contract',
    '',
    'After your evaluation, you MUST use the Write tool to create the following JSON file.',
    'This is how the system reads your verdict — your markdown text is for discussion only.',
    '',
    `**File path:** \`${contractPath}\``,
    '',
    'If you approve:',
    ...fencedJson(`{"verdict": "${approvalKeyword}"}`),
    '',
    'If you reject:',
    ...fencedJson(`{"verdict": "${rejectionKeyword}", "feedback": "what needs fixing", "issues": ["issue 1", "issue 2"]}`),
    '',
    `Write this file BEFORE your final response. The verdict field must be exactly "${approvalKeyword}" or "${rejectionKeyword}".`,
  ]);
}
