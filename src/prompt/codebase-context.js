/**
 * Reads the cloned repo directory to build codebase context.
 */

import fs from 'fs';
import path from 'path';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.tmp', '.pipeline-state', 'dist', 'build',
  'coverage', '.nyc_output', '.cache', '__pycache__', '.next',
]);

/**
 * Build a file tree N levels deep.
 */
function buildFileTree(dir, depth = 2, prefix = '') {
  if (depth <= 0) return '';

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return '';
  }

  const lines = [];
  const filtered = entries.filter(e => !IGNORE_DIRS.has(e.name) && !e.name.startsWith('.'));
  filtered.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of filtered) {
    if (entry.isDirectory()) {
      lines.push(`${prefix}${entry.name}/`);
      lines.push(buildFileTree(path.join(dir, entry.name), depth - 1, prefix + '  '));
    } else {
      lines.push(`${prefix}${entry.name}`);
    }
  }

  return lines.filter(Boolean).join('\n');
}

/**
 * Read a file if it exists, return contents or null.
 */
function readFileIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Build codebase context from a cloned repo directory.
 *
 * @param {string} cloneDir - Path to cloned repo
 * @returns {string} Markdown string with codebase context
 */
export function buildCodebaseContext(cloneDir) {
  const lines = [];

  // Read instruction files
  for (const f of ['CLAUDE.md', 'CODEX.md', 'codex.md']) {
    const content = readFileIfExists(path.join(cloneDir, f));
    if (content) {
      lines.push(`## ${f} (Service Rules)`);
      lines.push('```');
      lines.push(content.substring(0, 3000));
      lines.push('```');
      lines.push('');
    }
  }

  // File tree (2 levels deep)
  lines.push('## File Tree');
  lines.push('```');
  lines.push(buildFileTree(cloneDir, 2));
  lines.push('```');
  lines.push('');

  // package.json highlights
  const pkgContent = readFileIfExists(path.join(cloneDir, 'package.json'));
  if (pkgContent) {
    try {
      const pkg = JSON.parse(pkgContent);
      lines.push('## package.json');
      lines.push('');
      if (pkg.scripts) {
        lines.push('### Scripts');
        lines.push('```json');
        lines.push(JSON.stringify(pkg.scripts, null, 2));
        lines.push('```');
        lines.push('');
      }
      if (pkg.dependencies) {
        lines.push('### Dependencies');
        lines.push(Object.keys(pkg.dependencies).join(', '));
        lines.push('');
      }
      if (pkg.devDependencies) {
        lines.push('### Dev Dependencies');
        lines.push(Object.keys(pkg.devDependencies).join(', '));
        lines.push('');
      }
    } catch { /* invalid JSON */ }
  }

  return lines.join('\n');
}
