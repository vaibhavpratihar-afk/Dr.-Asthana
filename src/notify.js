function hasSlack(config) {
  return Boolean(config.slack.botToken && config.slack.userId);
}

async function sendDM(config, text) {
  const { WebClient } = await import('@slack/web-api');
  const client = new WebClient(config.slack.botToken);
  const convo = await client.conversations.open({ users: config.slack.userId });
  const channel = convo.channel?.id;
  if (!channel) throw new Error('Could not resolve Slack DM channel');
  await client.chat.postMessage({ channel, text });
}

function messageFor(ticket, outcome) {
  const head = `*${ticket.key}* — ${ticket.summary}`;
  if (outcome.status === 'shipped') {
    return `:white_check_mark: ${head}\nPR: ${outcome.prUrl}${outcome.summary ? `\n${outcome.summary}` : ''}`;
  }
  if (outcome.status === 'bailout') {
    return `:warning: ${head}\nBailed out: ${outcome.reason}${outcome.suggestion ? `\nSuggestion: ${outcome.suggestion}` : ''}`;
  }
  if (outcome.status === 'rejected') {
    return `:no_entry: ${head}\nRejected: ${outcome.reason}`;
  }
  return `:x: ${head}\nFailed: ${outcome.summary || 'unknown error'}`;
}

/**
 * Report a ticket outcome to Slack if configured, otherwise to stdout.
 */
export async function notify(config, ticket, outcome) {
  const text = messageFor(ticket, outcome);
  console.log(text.replace(/:[a-z_]+:/g, '').trim());

  if (!hasSlack(config)) return;
  try {
    await sendDM(config, text);
  } catch (e) {
    console.error(`Slack notification failed: ${e.message}`);
  }
}
