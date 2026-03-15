import { sendDM } from './slack.js';
import { buildFinalReport, buildFailureReport } from './report.js';

export async function notifySlackSuccess(config, ticketKey, summary, allPRs, allFailures, artifactUrl) {
  const report = buildFinalReport(config, allPRs, allFailures, artifactUrl);
  const ticketBlock = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Ticket:* <${config.jira.baseUrl}/browse/${ticketKey}|${ticketKey}> — ${summary}`,
    },
  };
  const blocks = [...report.slice(0, 1), ticketBlock, ...report.slice(1)];
  await sendDM(config, blocks, `${allPRs.length} PR(s) created for ${ticketKey}`);
}

export async function notifySlackFailure(config, ticketKey, ticketData, error, artifactUrl) {
  const blocks = buildFailureReport(error, 'pipeline', ticketData, artifactUrl);
  await sendDM(config, blocks, `Dr. Asthana failed for ${ticketKey}: ${typeof error === 'string' ? error : error.message}`);
}
