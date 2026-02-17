/**
 * Ticket complexity scoring
 *
 * Scores ticket complexity to determine turn budgets and whether to activate
 * phase splitting. Pure function — no external dependencies.
 */

const COMPLEXITY_KEYWORDS = [
  'refactor', 'rewrite', 'split', 'modular', 'god file',
  'migrate', 'new module', 'redesign', 'overhaul', 'restructure',
];

const FILE_EXTENSION_PATTERN = /\b[\w\-/]+\.(js|ts|jsx|tsx|mjs|cjs|json|yaml|yml)\b/g;

/**
 * Score ticket complexity based on description, comments, and metadata.
 *
 * @param {object} ticket - Parsed ticket from parseTicket()
 * @param {object} baseConfig - Base config values (AGENT_MAX_TURNS, AGENT_PLAN_TURNS, etc.)
 * @returns {{ level: string, score: number, signals: object, recommendedMaxTurns: number, recommendedMaxContinuations: number, recommendedPlanTurns: number, enablePhases: boolean }}
 */
export function scoreComplexity(ticket, baseConfig = {}) {
  const signals = {};
  let score = 0;

  const descriptionText = ticket.description || '';
  const comments = ticket.comments || [];

  // Signal 1: Description length
  const descLen = descriptionText.length;
  if (descLen > 5000) {
    score += 3;
    signals.descriptionLength = { value: descLen, points: 3 };
  } else if (descLen > 2000) {
    score += 1;
    signals.descriptionLength = { value: descLen, points: 1 };
  }

  // Signal 2: Human comment count (exclude bot comments)
  const humanComments = comments.filter(
    (c) => !c.author?.toLowerCase().includes('automation')
  );
  const humanCount = humanComments.length;
  if (humanCount >= 5) {
    score += 3;
    signals.humanCommentCount = { value: humanCount, points: 3 };
  } else if (humanCount >= 3) {
    score += 1;
    signals.humanCommentCount = { value: humanCount, points: 1 };
  }

  // Signal 3: Total comment text length
  const totalCommentLen = comments.reduce((sum, c) => sum + (c.text || '').length, 0);
  if (totalCommentLen > 10000) {
    score += 2;
    signals.commentTextLength = { value: totalCommentLen, points: 2 };
  }

  // Signal 4: Complexity keywords
  const allText = (descriptionText + ' ' + comments.map((c) => c.text || '').join(' ')).toLowerCase();
  const matchedKeywords = COMPLEXITY_KEYWORDS.filter((kw) => allText.includes(kw));
  if (matchedKeywords.length >= 3) {
    score += 3;
    signals.complexityKeywords = { value: matchedKeywords, points: 3 };
  } else if (matchedKeywords.length >= 1) {
    score += 1;
    signals.complexityKeywords = { value: matchedKeywords, points: 1 };
  }

  // Signal 5: Files mentioned in text
  const fileMatches = allText.match(FILE_EXTENSION_PATTERN) || [];
  const uniqueFiles = [...new Set(fileMatches)];
  if (uniqueFiles.length >= 8) {
    score += 3;
    signals.filesMentioned = { value: uniqueFiles.length, points: 3 };
  } else if (uniqueFiles.length >= 4) {
    score += 1;
    signals.filesMentioned = { value: uniqueFiles.length, points: 1 };
  }

  // Signal 6: Multiple affected systems
  if (ticket.affectedSystems && ticket.affectedSystems.length > 1) {
    score += 1;
    signals.multipleAffectedSystems = { value: ticket.affectedSystems.length, points: 1 };
  }

  // Classification
  let level, recommendedMaxTurns, recommendedMaxContinuations, recommendedPlanTurns, enablePhases;

  const baseTurns = baseConfig.AGENT_MAX_TURNS || baseConfig.CLAUDE_MAX_TURNS || 75;
  const basePlanTurns = baseConfig.AGENT_PLAN_TURNS || baseConfig.CLAUDE_PLAN_TURNS || 20;

  if (score >= 8) {
    level = 'complex';
    recommendedMaxTurns = Math.max(baseTurns, 200);
    recommendedMaxContinuations = 3;
    recommendedPlanTurns = Math.max(basePlanTurns, 30);
    enablePhases = true;
  } else if (score >= 4) {
    level = 'moderate';
    recommendedMaxTurns = Math.max(baseTurns, 150);
    recommendedMaxContinuations = 1;
    recommendedPlanTurns = Math.max(basePlanTurns, 25);
    enablePhases = false;
  } else {
    level = 'simple';
    recommendedMaxTurns = baseTurns;
    recommendedMaxContinuations = 0;
    recommendedPlanTurns = basePlanTurns;
    enablePhases = false;
  }

  return {
    level,
    score,
    signals,
    recommendedMaxTurns,
    recommendedMaxContinuations,
    recommendedPlanTurns,
    enablePhases,
  };
}

export default { scoreComplexity };
