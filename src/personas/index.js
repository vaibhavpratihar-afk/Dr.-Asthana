import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PERSONA_PATHS = Object.freeze({
  executorPrompt: path.join(__dirname, 'executor.prompt.md'),
  diffReviewer:   path.join(__dirname, 'diff-reviewer.persona.md'),
});

const cache = new Map();

function readPersona(filePath) {
  if (!cache.has(filePath)) {
    if (!fs.existsSync(filePath)) throw new Error(`Persona file not found: ${filePath}`);
    cache.set(filePath, fs.readFileSync(filePath, 'utf8').trimEnd());
  }
  return cache.get(filePath);
}

export function getPersona(name) {
  const filePath = PERSONA_PATHS[name];
  if (!filePath) throw new Error(`Unknown persona: ${name}`);
  return readPersona(filePath);
}
