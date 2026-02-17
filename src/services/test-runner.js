/**
 * Test Runner Service
 * Runs test cases for the service being modified
 *
 * Reads test commands from the service's instruction file (CLAUDE.md) if available,
 * otherwise falls back to detecting from package.json
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { log, ok, warn, err, debug, logCmd } from '../logger.js';

const TEST_TIMEOUT = 30 * 60 * 1000; // 30 minutes

/**
 * Parse instruction markdown to extract test commands
 * Looks for sections like "## Testing", "## Test Commands", "## Run Tests", etc.
 */
function parseInstructionMdForTests(tmpDir, instructionFile = 'CLAUDE.md') {
  const instructionPath = path.join(tmpDir, instructionFile);

  if (!fs.existsSync(instructionPath)) {
    debug(`No ${instructionFile} found in service`);
    return { found: false, commands: [] };
  }

  try {
    const content = fs.readFileSync(instructionPath, 'utf-8');
    const commands = [];

    // Look for test-related sections in instruction markdown
    // Common patterns: ## Testing, ## Tests, ## Test Commands, ## Run Tests
    const testSectionPatterns = [
      /##\s*(?:Testing|Tests|Test Commands?|Run Tests?|How to Test)\s*\n([\s\S]*?)(?=\n##|\n$|$)/gi,
      /###\s*(?:Testing|Tests|Test Commands?|Run Tests?)\s*\n([\s\S]*?)(?=\n###|\n##|\n$|$)/gi,
    ];

    let testSection = '';
    for (const pattern of testSectionPatterns) {
      const match = pattern.exec(content);
      if (match) {
        testSection = match[1];
        break;
      }
    }

    if (!testSection) {
      // Also look for inline test commands in code blocks
      const codeBlockPattern = /```(?:bash|sh|shell)?\n([^`]*(?:npm\s+(?:test|run\s+test)|jest|mocha|pytest|go\s+test)[^`]*)\n```/gi;
      const codeMatch = codeBlockPattern.exec(content);
      if (codeMatch) {
        testSection = codeMatch[1];
      }
    }

    if (testSection) {
      // First, extract commands from code blocks in the test section
      // Match ```bash or ```sh blocks and extract lines inside
      const codeBlockRegex = /```(?:bash|sh|shell|zsh)?\n([\s\S]*?)```/g;
      let cbMatch;
      while ((cbMatch = codeBlockRegex.exec(testSection)) !== null) {
        const blockContent = cbMatch[1].trim();
        // Each non-empty, non-comment line in a code block is a command
        const lines = blockContent.split('\n')
          .map(l => l.trim())
          .filter(l => l && !l.startsWith('#'));
        for (const line of lines) {
          const cmd = line.replace(/^\$\s*/, ''); // strip leading $
          if (cmd && !commands.some(c => c.cmd === cmd)) {
            const name = cmd.split(/\s/)[0].replace('./', '');
            commands.push({ name, cmd, source: instructionFile });
          }
        }
      }

      // Also look for inline backtick commands like `npm test`, `./run.test.sh`
      const backtickPattern = /`([^`\n]+)`/g;
      let btMatch;
      while ((btMatch = backtickPattern.exec(testSection)) !== null) {
        const cmd = btMatch[1].trim();
        // Only include single-line things that look like actual commands
        const looksLikeCommand = /^(npm|yarn|pnpm|make|jest|mocha|pytest|go\s+test|\.\/\S)/.test(cmd);
        if (cmd && looksLikeCommand && !commands.some(c => c.cmd === cmd)) {
          const name = cmd.split(/\s/)[0].replace('./', '');
          commands.push({ name, cmd, source: instructionFile });
        }
      }

      // Fallback: look for command-like lines (starting with npm, yarn, ./, etc.)
      if (commands.length === 0) {
        const linePatterns = [
          /(?:^|\n)\s*(?:\$\s*)?(npm\s+(?:test|run\s+\S+))/g,
          /(?:^|\n)\s*(?:\$\s*)?(yarn\s+(?:test|run\s+\S+))/g,
          /(?:^|\n)\s*(?:\$\s*)?(\.\/\S+)/g,
          /(?:^|\n)\s*(?:\$\s*)?(make\s+\S+)/g,
        ];
        for (const pattern of linePatterns) {
          let match;
          while ((match = pattern.exec(testSection)) !== null) {
            const cmd = match[1].trim();
            if (cmd && !commands.some(c => c.cmd === cmd)) {
              const name = cmd.split(/\s/)[0].replace('./', '');
              commands.push({ name, cmd, source: instructionFile });
            }
          }
        }
      }
    }

    if (commands.length > 0) {
      log(`Found ${commands.length} test command(s) in ${instructionFile}`);
      return { found: true, commands };
    }

    debug(`No test commands found in ${instructionFile}`);
    return { found: false, commands: [] };

  } catch (error) {
    warn(`Failed to parse ${instructionFile}: ${error.message}`);
    return { found: false, commands: [] };
  }
}

/**
 * Detect available test commands from package.json
 * Fallback if CLAUDE.md doesn't specify test commands
 */
function detectTestCommandsFromPackageJson(tmpDir) {
  const packageJsonPath = path.join(tmpDir, 'package.json');

  if (!fs.existsSync(packageJsonPath)) {
    return { hasTests: false, commands: [] };
  }

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    const scripts = packageJson.scripts || {};
    const commands = [];

    // Check for common test scripts
    if (scripts.test && scripts.test !== 'echo "Error: no test specified" && exit 1') {
      commands.push({ name: 'test', cmd: 'npm test', source: 'package.json' });
    }
    if (scripts.lint) {
      commands.push({ name: 'lint', cmd: 'npm run lint', source: 'package.json' });
    }
    if (scripts['test:unit']) {
      commands.push({ name: 'test:unit', cmd: 'npm run test:unit', source: 'package.json' });
    }
    if (scripts['test:integration']) {
      commands.push({ name: 'test:integration', cmd: 'npm run test:integration', source: 'package.json' });
    }

    return {
      hasTests: commands.length > 0,
      commands,
    };
  } catch (error) {
    warn(`Failed to parse package.json: ${error.message}`);
    return { hasTests: false, commands: [] };
  }
}

/**
 * Run a single test command.
 * Output is redirected to a temp file to avoid maxBuffer overflow on large test suites.
 */
function runCommand(cmd, tmpDir, customEnv = null) {
  const startTime = Date.now();
  const outputFile = path.join(tmpDir, '.test-output.log');

  // Wrap command to redirect stdout+stderr to file, avoiding maxBuffer limits
  const wrappedCmd = `(${cmd}) > "${outputFile}" 2>&1`;
  let exitCode = 0;
  let signal = null;

  try {
    execSync(wrappedCmd, {
      cwd: tmpDir,
      stdio: 'ignore', // all output goes to file
      timeout: TEST_TIMEOUT,
      env: customEnv || { ...process.env },
      shell: true,
    });
  } catch (error) {
    exitCode = error.status || 1;
    signal = error.signal || null;
    if (signal) {
      warn(`Process killed by signal ${signal}`);
    }
  }

  const duration = Date.now() - startTime;
  logCmd(cmd, exitCode, duration);

  // Read output from file
  let output = '';
  try {
    output = fs.readFileSync(outputFile, 'utf-8');
  } catch { /* file may not exist if command failed very early */ }

  if (exitCode === 0) {
    return { success: true, output, duration };
  }
  return {
    success: false,
    output,
    error: '', // stderr is merged into output file
    exitCode,
    duration,
  };
}

/**
 * Check if the changes made by the provider require running tests.
 * Only source code changes need tests — dependency updates, docs, config, and
 * Docker/CI changes don't.
 */
export function shouldRunTests(tmpDir) {
  let changedFiles;
  try {
    // Get list of all modified/added/deleted files (unstaged + staged)
    changedFiles = execSync('git diff --name-only HEAD', {
      cwd: tmpDir,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
  } catch {
    // If diff fails (e.g. no commits yet), fall back to checking untracked files
    try {
      changedFiles = execSync('git status --porcelain', {
        cwd: tmpDir,
        encoding: 'utf-8',
        stdio: 'pipe',
      }).trim();
    } catch {
      // Can't determine changes — run tests to be safe
      return { needed: true, reason: 'cannot determine changed files' };
    }
  }

  if (!changedFiles) {
    return { needed: false, reason: 'no changes detected' };
  }

  const files = changedFiles.split('\n').map(f => f.trim().replace(/^.\s+/, ''));

  // Files that never need tests
  const noTestPatterns = [
    /^package\.json$/,
    /^package-lock\.json$/,
    /^yarn\.lock$/,
    /^\..*/, // dotfiles (.gitignore, .eslintrc, .env, etc.)
    /\.md$/i,
    /^Dockerfile/,
    /^docker-compose/,
    /^azure-pipelines/,
    /^CLAUDE\.md$/,
    /^CODEX\.md$/,
    /^\.cursor/,
  ];

  const codeFiles = files.filter(f => !noTestPatterns.some(p => p.test(f)));

  if (codeFiles.length === 0) {
    return { needed: false, reason: `only non-code files changed: ${files.join(', ')}` };
  }

  return { needed: true, reason: `source code changed: ${codeFiles.join(', ')}` };
}

/**
 * Run all available tests
 * Returns { passed, results: [{ name, success, output, error }] }
 */
export async function runTests(tmpDir, options = {}) {
  log('Detecting test commands...');

  // Build custom env with nvm bin dir prepended to PATH if provided
  const { nvmBinDir, instructionFile = 'CLAUDE.md' } = options;
  const customEnv = nvmBinDir
    ? { ...process.env, PATH: `${nvmBinDir}:${process.env.PATH}` }
    : null;
  if (nvmBinDir) {
    log(`Tests will use Node from: ${nvmBinDir}`);
  }

  // First try selected instruction file, then legacy CLAUDE.md for compatibility.
  const preferredMdTests = parseInstructionMdForTests(tmpDir, instructionFile);
  const fallbackClaudeMdTests = instructionFile !== 'CLAUDE.md'
    ? parseInstructionMdForTests(tmpDir, 'CLAUDE.md')
    : { found: false, commands: [] };

  let commands = [];
  let source = '';

  if (preferredMdTests.found && preferredMdTests.commands.length > 0) {
    commands = preferredMdTests.commands;
    source = instructionFile;
  } else if (fallbackClaudeMdTests.found && fallbackClaudeMdTests.commands.length > 0) {
    commands = fallbackClaudeMdTests.commands;
    source = 'CLAUDE.md';
  }

  if (commands.length > 0 && (source === instructionFile || source === 'CLAUDE.md')) {
    // If a shell script is present, drop bare npm/yarn commands — the script likely wraps them
    const hasShellScript = commands.some(c => c.cmd.startsWith('./') || c.cmd.endsWith('.sh'));
    if (hasShellScript && commands.length > 1) {
      const before = commands.length;
      commands = commands.filter(c => c.cmd.startsWith('./') || c.cmd.endsWith('.sh'));
      if (commands.length < before) {
        log(`Filtered ${before - commands.length} redundant command(s) — shell script already wraps them`);
      }
    }

    log(`Using test commands from ${source}`);
  } else {
    // Check for test shell scripts in repo root
    const testScripts = ['run.test.sh', 'test.sh'];
    for (const script of testScripts) {
      const scriptPath = path.join(tmpDir, script);
      if (fs.existsSync(scriptPath)) {
        commands = [{ name: script, cmd: `./${script}`, source: 'repo-script' }];
        source = 'repo-script';
        log(`Using test script: ${script}`);
        break;
      }
    }

    // Fall back to package.json
    if (commands.length === 0) {
      const pkgTests = detectTestCommandsFromPackageJson(tmpDir);
      if (pkgTests.hasTests) {
        commands = pkgTests.commands;
        source = 'package.json';
        log(`Using test commands from package.json`);
      }
    }
  }

  if (commands.length === 0) {
    log('No test commands found in instruction markdown or package.json');
    return { passed: true, skipped: true, results: [], source: 'none' };
  }

  log(`Found ${commands.length} test command(s): ${commands.map(c => c.name).join(', ')}`);
  commands.forEach(c => debug(`  ${c.name}: ${c.cmd} (from ${c.source})`));

  // Install dependencies first (if Node.js project)
  const packageJsonPath = path.join(tmpDir, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    log('Installing dependencies...');
    const installStart = Date.now();
    const installLog = path.join(tmpDir, '.npm-install.log');
    try {
      execSync(`npm install > "${installLog}" 2>&1`, {
        cwd: tmpDir,
        stdio: 'ignore',
        timeout: 15 * 60 * 1000, // 15 minutes for install
        env: customEnv || { ...process.env },
        shell: true,
      });
      logCmd('npm install', 0, Date.now() - installStart);
      ok('Dependencies installed');
    } catch (error) {
      logCmd('npm install', error.status || 1, Date.now() - installStart);
      let installError = '';
      try { installError = fs.readFileSync(installLog, 'utf-8').split('\n').slice(-10).join('\n'); } catch { /* */ }
      warn(`npm install failed (exit ${error.status}): ${installError || error.message}`);
      // Continue anyway - deps might already be there
    }
  }

  const results = [];
  let allPassed = true;

  for (const { name, cmd } of commands) {
    log(`Running ${name}...`);
    debug(`Command: ${cmd}`);
    const result = runCommand(cmd, tmpDir, customEnv);
    results.push({ name, cmd, ...result });

    if (result.success) {
      ok(`${name} passed (${(result.duration / 1000).toFixed(1)}s)`);
    } else {
      err(`${name} failed (exit code ${result.exitCode})`);

      // Save full test output to logs directory for post-mortem debugging (tmpDir gets cleaned up)
      const logsDir = path.join(process.cwd(), 'logs');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const sanitizedName = name.replace(/[^a-z0-9]/gi, '-');
      const outputFile = path.join(logsDir, `test-${sanitizedName}-${timestamp}.log`);
      try {
        if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
        const fullOutput = `=== STDOUT ===\n${result.output || '(empty)'}\n\n=== STDERR ===\n${result.error || '(empty)'}`;
        fs.writeFileSync(outputFile, fullOutput);
        log(`Full test output saved to ${outputFile}`);
      } catch { /* best-effort */ }

      // Log the tail of stdout — that's where test frameworks print failure summaries
      if (result.output) {
        const stdoutLines = result.output.split('\n').filter(l => l.trim());
        const tail = stdoutLines.slice(-30).join('\n');
        err(`Test output (last 30 lines):\n${tail}`);
      }
      if (result.error) {
        const stderrLines = result.error.split('\n').filter(l => l.trim());
        const tail = stderrLines.slice(-15).join('\n');
        debug(`Stderr (last 15 lines):\n${tail}`);
      }
      allPassed = false;
    }
  }

  return {
    passed: allPassed,
    skipped: false,
    results,
    source,
  };
}

/**
 * Format test results for display/logging
 */
export function formatTestResults(testResults) {
  if (testResults.skipped) {
    return 'Tests: Skipped (no test commands found)';
  }

  const lines = [`Test Results (from ${testResults.source || 'unknown'}):`];
  for (const result of testResults.results) {
    const status = result.success ? '✓' : '✗';
    const duration = result.duration ? ` (${(result.duration / 1000).toFixed(1)}s)` : '';
    lines.push(`  ${status} ${result.name}${duration}`);
    if (!result.success) {
      // Include tail of stdout — test frameworks print failure summaries at the end
      if (result.output) {
        const stdoutLines = result.output.split('\n').filter(l => l.trim());
        const tail = stdoutLines.slice(-15);
        tail.forEach(line => lines.push(`      ${line}`));
      } else if (result.error) {
        // Fall back to stderr tail if no stdout
        const stderrLines = result.error.split('\n').filter(l => l.trim());
        const tail = stderrLines.slice(-10);
        tail.forEach(line => lines.push(`      ${line}`));
      }
    }
  }
  return lines.join('\n');
}

export default {
  shouldRunTests,
  runTests,
  formatTestResults,
};
