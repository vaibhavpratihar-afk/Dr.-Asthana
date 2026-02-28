/**
 * Contract API - re-export surface for contract prompt/read utilities.
 *
 * Responsibility:
 * - Expose a minimal public entrypoint for contract features.
 *
 * Contract:
 * - Keep import paths stable for callers outside contract internals.
 */

export { buildAgreementContractPrompt, buildEvaluationContractPrompt } from './prompt.js';
export { readAgreementContract, readEvaluationContract } from './reader.js';
