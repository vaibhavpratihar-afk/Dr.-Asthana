/**
 * Prompt Builder
 * Constructs the ticket-context prompt sent to Claude Code.
 * Standing rules (instructions, restrictions, test procedures) live in
 * agent-rules-*.md and are injected into the clone's CLAUDE.md by processor.js.
 */

/**
 * Build the prompt for Claude Code — ticket context only.
 * Rules and restrictions are provided via CLAUDE.md in the working directory.
 */
export function buildPrompt(ticketKey, ticketSummary, ticketDescription, ticketComments = []) {
  let commentsSection = '';
  if (ticketComments && ticketComments.length > 0) {
    commentsSection = '\n## Comments\n';
    ticketComments.forEach((comment, i) => {
      commentsSection += `### Comment ${i + 1} by ${comment.author}\n${comment.text}\n\n`;
    });
  }

  return `You are working on JIRA ticket ${ticketKey}.

## Ticket Title
${ticketSummary}

## Ticket Description
${ticketDescription}
${commentsSection}`;
}

/**
 * Build a multi-branch master planning prompt.
 * Instructs Claude to explore all branches and produce per-branch plan sections
 * with mandatory `### BRANCH: <name>` headers.
 *
 * @param {string} ticketKey
 * @param {string} ticketSummary
 * @param {string} ticketDescription
 * @param {Array}  ticketComments - Array of { author, text }
 * @param {string[]} targetBranches - Branch names (e.g. ["version/1.10.5", "version/1.10.3"])
 * @returns {string}
 */
export function buildMultiBranchPlanPrompt(ticketKey, ticketSummary, ticketDescription, ticketComments = [], targetBranches = []) {
  const base = buildPrompt(ticketKey, ticketSummary, ticketDescription, ticketComments);

  const branchList = targetBranches.map(b => `- \`${b}\``).join('\n');

  return base +
    '\n\n## Multi-Branch Planning Task\n\n' +
    'You are producing a **master implementation plan** for multiple target branches. ' +
    'The changes described in the ticket must be applied to each of these branches:\n\n' +
    branchList +
    '\n\n' +
    'All branches are available as remote refs. Use these commands to explore:\n' +
    '- `git show origin/<branch>:<path>` — view a file on a specific branch\n' +
    '- `git diff origin/<branchA>..origin/<branchB>` — compare branches\n' +
    '- `git log origin/<branch> --oneline -20` — recent history on a branch\n\n' +
    'Your task: explore the codebase on ALL target branches and produce a detailed implementation plan. ' +
    'Do NOT make any code changes.\n\n' +
    '## Output Format (MANDATORY)\n\n' +
    'You MUST produce a separate plan section for EACH branch using this exact header format:\n\n' +
    '### BRANCH: <branch-name>\n\n' +
    'For example:\n\n' +
    '### BRANCH: version/1.10.5\n' +
    '<full plan for this branch>\n\n' +
    '### BRANCH: version/1.10.3\n' +
    '<full plan for this branch>\n\n' +
    '## Rules\n\n' +
    '1. Each branch section must be **fully self-contained**. Do NOT say "same as above" or reference other branch sections. ' +
    'A separate Claude session will read ONLY that one section with no context from other branches.\n' +
    '2. List every file to modify, every change to make, in order. Be explicit.\n' +
    '3. Do not say "as discussed" or "the plan is ready" — write the actual detailed plan.\n' +
    '4. Branches may differ significantly (different versions, different file contents). ' +
    'Examine each branch independently before writing its plan.\n' +
    '5. Your entire output will be parsed by regex looking for `### BRANCH:` headers. ' +
    'Do NOT use this header format for anything else.';
}
