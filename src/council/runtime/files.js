/**
 * File Runtime - small deterministic filesystem helpers for council artifacts.
 *
 * Responsibility:
 * - Handle common read/write/append/json operations with safe defaults.
 * - Keep council stage code focused on workflow, not fs boilerplate.
 *
 * Contract:
 * - readText/readJson return fallback values when files do not exist.
 * - write helpers always create parent directories.
 */

import fs from 'fs';
import path from 'path';

const ensureDir = (filePath) => fs.mkdirSync(path.dirname(filePath), { recursive: true });
const fileExists = (filePath) => fs.existsSync(filePath);
export const readText = (filePath, fallback = '') => (fileExists(filePath) ? fs.readFileSync(filePath, 'utf8') : fallback);
export const writeText = (filePath, content) => (ensureDir(filePath), fs.writeFileSync(filePath, content), filePath);
export const appendText = (filePath, content) => (ensureDir(filePath), fs.appendFileSync(filePath, content), filePath);

export const readJson = (filePath, fallback = null) => {
  if (!fileExists(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
};

export const writeJson = (filePath, payload) => writeText(filePath, `${JSON.stringify(payload, null, 2)}\n`);
