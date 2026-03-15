const SLACK_MRKDWN_LIMIT = 3000;
const FAILURE_MESSAGE_LIMIT = 300;

function sanitizeForSlack(text) {
  if (!text) return '';
  let clean = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  if (clean.length > SLACK_MRKDWN_LIMIT) clean = clean.substring(0, SLACK_MRKDWN_LIMIT - 3) + '...';
  return clean;
}

function safeTruncate(text, limit = 3000) {
  if (!text) return '';
  return text.length > limit ? text.substring(0, limit - 3) + '...' : text;
}

function joinContextParts(parts) {
  return parts.filter(Boolean).join('  ·  ');
}

function prUrl(config, pr) {
  if (pr.prUrl) return pr.prUrl;
  return `${config.azureDevOps.org}/${config.azureDevOps.project}/_git/${pr.service}/pullrequest/${pr.prId}`;
}

export function buildFinalReport(config, allPRs, allFailures, artifactUrl) {
  const blocks = [];

  blocks.push({ type: 'header', text: { type: 'plain_text', text: 'PR ready for review', emoji: true } });

  const prLines = allPRs.map(pr =>
    `<${prUrl(config, pr)}|PR #${pr.prId}> — ${pr.service} / \`${pr.baseBranch}\``
  );
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: sanitizeForSlack(prLines.join('\n')) } });

  if (allFailures.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: sanitizeForSlack(`:warning: Could not complete: ${allFailures.map(f => f.service).join(', ')}`) },
    });
  }

  const footerParts = [];
  if (artifactUrl) footerParts.push(`<${artifactUrl}|Full report>`);
  footerParts.push('_Please review before merging_');
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: joinContextParts(footerParts) }] });

  return blocks;
}

export function buildFailureReport(error, step, ticketData, artifactUrl) {
  const errorMsg = typeof error === 'string' ? error : error?.message || 'Unknown error';
  const briefError = safeTruncate(errorMsg, FAILURE_MESSAGE_LIMIT);

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Could not complete ticket', emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: sanitizeForSlack(`*${ticketData.key}* — ${ticketData.summary}\n\n${briefError}`) } },
  ];

  const footerParts = [];
  if (artifactUrl) footerParts.push(`<${artifactUrl}|Full report>`);
  if (step) footerParts.push(`Step: ${step}`);
  footerParts.push('_May need manual intervention_');
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: joinContextParts(footerParts) }] });

  return blocks;
}
