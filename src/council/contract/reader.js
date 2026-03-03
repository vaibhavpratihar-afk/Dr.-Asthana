/**
 * Contract Reader - strict parser/validator for on-disk agent contracts.
 *
 * Responsibility:
 * - Read evaluation JSON files and validate allowed values.
 *
 * Contract:
 * - Never throws to caller for malformed/missing files.
 * - Always returns a typed shape with { valid, ... } and a reason on failure.
 */

import fs from 'fs';
import { warn, debug } from '../../utils/logger.js';

/**
 * Read and validate an evaluation contract file.
 *
 * Expected shape: { "verdict": "APPROVED" | "REJECTED", "feedback"?: string, "issues"?: string[] }
 *
 * @param {string} contractPath - Absolute path to evaluation-contract.json
 * @param {{ approvalKeyword?: string, rejectionKeyword?: string }} [opts]
 * @returns {{ valid: boolean, verdict?: string, feedback?: string, issues?: string[], reason?: string }}
 */
export function readEvaluationContract(contractPath, opts = {}) {
  const approvalKeyword = (opts.approvalKeyword || 'APPROVED').toUpperCase();
  const rejectionKeyword = (opts.rejectionKeyword || 'REJECTED').toUpperCase();

  const raw = readJsonFile(contractPath);
  if (!raw.valid) return raw;

  const upper = normalizeUpperString(raw.data.verdict);
  if (!upper) return { valid: false, reason: 'Missing or non-string verdict field' };
  if (upper !== approvalKeyword && upper !== rejectionKeyword) return invalidVerdict(raw.data.verdict, approvalKeyword, rejectionKeyword);

  debug(`Evaluation contract read: verdict=${upper}`);
  return {
    valid: true,
    verdict: upper,
    feedback: raw.data.feedback || null,
    issues: Array.isArray(raw.data.issues) ? raw.data.issues : null,
  };
}

/**
 * Read and parse a JSON file from disk. Returns { valid, data } or { valid: false, reason }.
 */
const readJsonFile = (filePath) => {
  try {
    if (!fs.existsSync(filePath)) {
      return { valid: false, reason: 'Contract file not found' };
    }
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    const data = JSON.parse(content);
    if (!data || typeof data !== 'object') {
      return { valid: false, reason: 'Contract file is not a JSON object' };
    }
    return { valid: true, data };
  } catch (err) {
    warn(`Failed to read contract file ${filePath}: ${err.message}`);
    return { valid: false, reason: `Parse error: ${err.message}` };
  }
};

const normalizeUpperString = (value) => (typeof value === 'string' ? value.toUpperCase() : null);
const invalidVerdict = (verdict, approvalKeyword, rejectionKeyword) => ({
  valid: false,
  reason: `Verdict "${verdict}" does not match ${approvalKeyword} or ${rejectionKeyword}`,
});
