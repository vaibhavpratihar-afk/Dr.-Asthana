const MRKDWN_LIMIT = 3000;

function truncate(text, limit = MRKDWN_LIMIT) {
  if (!text) return '';
  return text.length > limit ? text.substring(0, limit - 3) + '...' : text;
}

function section(text) {
  return { type: 'section', text: { type: 'mrkdwn', text: truncate(text) } };
}

export function buildSuccessBlocks({ ticketKey, ticketUrl, summary, prUrl }) {
  return [
    { type: 'header', text: { type: 'plain_text', text: 'PR ready for review', emoji: true } },
    section(`*Ticket:* <${ticketUrl}|${ticketKey}> — ${summary}`),
    section(`*PR:* <${prUrl}|View Pull Request>`),
    { type: 'context', elements: [{ type: 'mrkdwn', text: '_Please review before merging_' }] },
  ];
}

export function buildBailoutBlocks({ ticketKey, ticketUrl, summary, reason, explored, suggestion }) {
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Needs human intervention', emoji: true } },
    section(`*Ticket:* <${ticketUrl}|${ticketKey}> — ${summary}`),
    section(`*Why:* ${reason}`),
  ];
  if (explored) blocks.push(section(`*Explored:* ${explored}`));
  if (suggestion) blocks.push(section(`*Suggestion:* ${suggestion}`));
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_Agent explored the codebase and determined this needs a human_' }] });
  return blocks;
}

export function buildFailureBlocks({ ticketKey, ticketUrl, reason }) {
  return [
    { type: 'header', text: { type: 'plain_text', text: 'Could not complete ticket', emoji: true } },
    section(`*Ticket:* <${ticketUrl}|${ticketKey}> — ${reason}`),
    { type: 'context', elements: [{ type: 'mrkdwn', text: '_May need manual intervention_' }] },
  ];
}

export async function sendDM({ botToken, userId }, blocks, fallbackText) {
  if (!botToken || !userId) {
    console.log('[slack] Not configured, skipping notification');
    return;
  }

  const headers = { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json' };

  try {
    const openRes = await fetch('https://slack.com/api/conversations.open', {
      method: 'POST', headers, body: JSON.stringify({ users: userId }),
    });
    const openData = await openRes.json();
    const channel = openData.channel?.id;
    if (!channel) throw new Error('Could not resolve DM channel');

    const msgRes = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST', headers,
      body: JSON.stringify({ channel, text: fallbackText, blocks }),
    });
    const msgData = await msgRes.json();

    if (msgData.error === 'invalid_blocks') {
      await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST', headers,
        body: JSON.stringify({ channel, text: fallbackText }),
      });
      console.log('[slack] Sent (plain text fallback)');
    } else {
      console.log('[slack] Notification sent');
    }
  } catch (e) {
    console.error(`[slack] Failed: ${e.message}`);
  }
}
