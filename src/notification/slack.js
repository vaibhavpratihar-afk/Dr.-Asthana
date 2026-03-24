/**
 * File: src/notification/slack.js
 * Module: notification
 * Purpose: Slack DM transport wrapper with fallback behavior.
 * Key Exports: sendDM
 * Integration Points: Integrates with Jira comment APIs and Slack transport.
 * Data Flow: Keep side effects explicit; keep pure transformations isolated where possible.
 * Maintenance Notes: Header intentionally documents file intent for fast onboarding and review.
 */
import { log, warn, err } from '../utils/logger.js';
let slackClient = null;

function hasSlackConfig(config) {
  return Boolean(config?.slack?.botToken && config?.slack?.userId);
}

async function getSlackClient(botToken) {
  if (slackClient) return slackClient;
  const { WebClient } = await import('@slack/web-api');
  slackClient = new WebClient(botToken);
  return slackClient;
}

/**
 * Send a Slack DM using Block Kit.
 *
 * @param {object} config - Full config object
 * @param {object[]} blocks - Block Kit blocks array
 * @param {string} fallbackText - Fallback text for notifications
 */
export async function sendDM(config, blocks, fallbackText) {
  if (!hasSlackConfig(config)) {
    warn('Slack not configured, skipping notification');
    return;
  }

  try {
    const client = await getSlackClient(config.slack.botToken);

    const conversation = await client.conversations.open({ users: config.slack.userId });
    const dmChannelId = conversation.channel?.id;
    if (!dmChannelId) {
      throw new Error('Could not resolve DM channel ID from Slack conversations.open');
    }

    try {
      await client.chat.postMessage({
        channel: dmChannelId,
        text: fallbackText,
        blocks,
      });
      log('Slack notification sent');
    } catch (blockError) {
      // If Block Kit is invalid, retry with plain text only
      if (blockError.data?.error === 'invalid_blocks' || blockError.message?.includes('invalid_blocks')) {
        warn(`Slack invalid_blocks error — retrying with plain text fallback`);
        await client.chat.postMessage({
          channel: dmChannelId,
          text: fallbackText,
        });
        log('Slack notification sent (plain text fallback)');
      } else {
        throw blockError;
      }
    }
  } catch (error) {
    err(`Failed to send Slack notification: ${error.message}`);
  }
}
