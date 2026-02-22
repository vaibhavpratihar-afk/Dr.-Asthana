/**
 * Notification Module.
 *
 * Calls JIRA module for JIRA comments. Calls Slack directly for Slack messages.
 * Fire-and-forget: JIRA failures never block the pipeline.
 */

import { postComment } from '../jira/index.js';
import { sendDM } from './slack.js';
import {
  buildStepReport,
  buildFinalReport,
  buildRejectionReport,
  buildFailureReport,
  buildInProgressComment,
  buildLeadReviewComment,
  uploadLogFile,
} from './report.js';
import { log, warn } from '../utils/logger.js';

/**
 * Post a step comment to JIRA (fire-and-forget).
 */
export async function postJiraStep(ticketKey, stepName, details) {
  try {
    const report = buildStepReport(stepName, details);
    await postComment(ticketKey, report.jira);
  } catch (error) {
    warn(`Failed to post step comment for ${ticketKey}: ${error.message}`);
  }
}

/**
 * Post the final JIRA report with PR table and summary.
 */
export async function postFinalJiraReport(config, ticketKey, allPRs, allFailures, cheatsheetSummary, logUrl) {
  try {
    const report = buildFinalReport(config, allPRs, allFailures, cheatsheetSummary, logUrl);
    await postComment(ticketKey, report.jira);
  } catch (error) {
    warn(`Failed to post final JIRA report for ${ticketKey}: ${error.message}`);
  }
}

/**
 * Send Slack success notification with all PRs.
 */
export async function notifySlackSuccess(config, ticketKey, summary, allPRs, allFailures, cheatsheetSummary, logUrl) {
  const report = buildFinalReport(config, allPRs, allFailures, cheatsheetSummary, logUrl);
  if (report.slack) {
    // Add ticket context to slack blocks
    const ticketBlock = {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Ticket:* <${config.jira.baseUrl}/browse/${ticketKey}|${ticketKey}> — ${summary}`,
      },
    };
    // Insert ticket block after header
    report.slack.splice(1, 0, ticketBlock);
    await sendDM(config, report.slack, `${allPRs.length} PR(s) created for ${ticketKey}`);
  }
}

/**
 * Send Slack failure notification.
 */
export async function notifySlackFailure(config, ticketKey, ticketData, error, logUrl) {
  const report = buildFailureReport(error, 'pipeline', ticketData, logUrl);
  if (report.slack) {
    await sendDM(config, report.slack, `Dr. Asthana failed for ${ticketKey}: ${typeof error === 'string' ? error : error.message}`);
  }
}

/**
 * Send Slack rejection notification.
 */
export async function notifySlackRejection(config, ticketKey, reason) {
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: ':no_entry: Dr. Asthana — Ticket Rejected', emoji: true },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Ticket:* <${config.jira.baseUrl}/browse/${ticketKey}|${ticketKey}>\n*Reason:* ${reason}` },
    },
  ];
  await sendDM(config, blocks, `Dr. Asthana rejected ${ticketKey}: ${reason}`);
}

/**
 * Post In-Progress JIRA comment.
 */
export async function postInProgressComment(config, ticketKey, ticket) {
  try {
    const report = buildInProgressComment(config, ticket);
    await postComment(ticketKey, report.jira);
  } catch (error) {
    warn(`Failed to post in-progress comment: ${error.message}`);
  }
}

/**
 * Post LEAD REVIEW JIRA comment.
 */
export async function postLeadReviewComment(config, ticketKey, allPRs, cheatsheetSummary) {
  try {
    const report = buildLeadReviewComment(config, allPRs, cheatsheetSummary);
    await postComment(ticketKey, report.jira);
  } catch (error) {
    warn(`Failed to post lead review comment: ${error.message}`);
  }
}

export { uploadLogFile } from './report.js';
