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
