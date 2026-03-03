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
