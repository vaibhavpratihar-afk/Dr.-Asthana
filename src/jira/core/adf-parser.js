/**
 * File: src/jira/core/adf-parser.js
 * Module: jira
 * Purpose: Atlassian Document Format (ADF) to markdown/plain-text conversion.
 * Key Exports: extractTextFromADF
 * Integration Points: Used by Jira parser and comment/description extraction flows.
 * Data Flow: Walks nested ADF nodes and emits normalized text fragments.
 * Maintenance Notes: Keep node handling deterministic and side-effect free.
 */

const ADF_TYPE = Object.freeze({
  TEXT: 'text',
  HARD_BREAK: 'hardBreak',
  PARAGRAPH: 'paragraph',
  BULLET_LIST: 'bulletList',
  ORDERED_LIST: 'orderedList',
  TABLE: 'table',
  TABLE_ROW: 'tableRow',
  BLOCKQUOTE: 'blockquote',
  PANEL: 'panel',
  INLINE_CARD: 'inlineCard',
  MENTION: 'mention',
  CODE_BLOCK: 'codeBlock',
  HEADING: 'heading',
});

const DEFAULT_PANEL_TYPE = 'info';

function nodeContent(node) {
  return Array.isArray(node?.content) ? node.content : [];
}

function applyMarks(text, marks) {
  if (!marks || !Array.isArray(marks) || marks.length === 0) {
    return text;
  }

  let result = text;
  for (let index = 0; index < marks.length; index += 1) {
    const mark = marks[index];
    switch (mark.type) {
      case 'strong':
        result = `**${result}**`;
        break;
      case 'em':
        result = `*${result}*`;
        break;
      case 'code':
        result = `\`${result}\``;
        break;
      case 'strike':
        result = `~~${result}~~`;
        break;
      case 'link':
        result = mark.attrs?.href ? `[${result}](${mark.attrs.href})` : result;
        break;
      default:
        break;
    }
  }

  return result;
}

export function extractTextFromADF(content) {
  if (!Array.isArray(content)) {
    return '';
  }

  const textParts = [];

  for (let nodeIndex = 0; nodeIndex < content.length; nodeIndex += 1) {
    const node = content[nodeIndex];

    switch (node.type) {
      case ADF_TYPE.TEXT:
        if (node.text) textParts.push(applyMarks(node.text, node.marks));
        break;
      case ADF_TYPE.HARD_BREAK:
        textParts.push('\n');
        break;
      case ADF_TYPE.PARAGRAPH: {
        const nestedContent = nodeContent(node);
        if (nestedContent.length > 0) {
          textParts.push(extractTextFromADF(nestedContent));
          textParts.push('\n');
        }
        break;
      }
      case ADF_TYPE.BULLET_LIST: {
        const items = nodeContent(node);
        for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
          const listItem = items[itemIndex];
          textParts.push('- ');
          textParts.push(extractTextFromADF(nodeContent(listItem)));
          textParts.push('\n');
        }
        break;
      }
      case ADF_TYPE.ORDERED_LIST: {
        const items = nodeContent(node);
        for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
          textParts.push(`${itemIndex + 1}. `);
          textParts.push(extractTextFromADF(nodeContent(items[itemIndex])));
          textParts.push('\n');
        }
        break;
      }
      case ADF_TYPE.TABLE: {
        const rowsContent = nodeContent(node);
        const rows = [];
        let isFirstRow = true;

        for (let rowIndex = 0; rowIndex < rowsContent.length; rowIndex += 1) {
          const row = rowsContent[rowIndex];
          const cellsContent = nodeContent(row);
          if (row.type !== ADF_TYPE.TABLE_ROW || cellsContent.length === 0) continue;

          const cells = cellsContent.map((cell) => extractTextFromADF(nodeContent(cell)).replace(/\n/g, ' ').trim());
          rows.push(`| ${cells.join(' | ')} |`);

          if (isFirstRow) {
            rows.push(`| ${cells.map(() => '---').join(' | ')} |`);
            isFirstRow = false;
          }
        }

        if (rows.length > 0) {
          textParts.push(rows.join('\n'));
          textParts.push('\n');
        }
        break;
      }
      case ADF_TYPE.BLOCKQUOTE:
        textParts.push(extractTextFromADF(nodeContent(node)).split('\n').map((line) => `> ${line}`).join('\n'));
        textParts.push('\n');
        break;
      case ADF_TYPE.PANEL: {
        const panelType = (node.attrs?.panelType || DEFAULT_PANEL_TYPE).toUpperCase();
        textParts.push(`[${panelType}] `);
        textParts.push(extractTextFromADF(nodeContent(node)));
        textParts.push('\n');
        break;
      }
      case ADF_TYPE.INLINE_CARD:
        textParts.push(node.attrs?.url || '');
        break;
      case ADF_TYPE.MENTION:
        textParts.push(`@${node.attrs?.text || node.attrs?.id || 'unknown'}`);
        break;
      case ADF_TYPE.CODE_BLOCK: {
        const codeContent = nodeContent(node);
        if (codeContent.length > 0) {
          textParts.push('```\n');
          textParts.push(extractTextFromADF(codeContent));
          textParts.push('\n```\n');
        }
        break;
      }
      case ADF_TYPE.HEADING: {
        const headingContent = nodeContent(node);
        if (headingContent.length > 0) {
          const level = node.attrs?.level || 1;
          textParts.push('#'.repeat(level) + ' ');
          textParts.push(extractTextFromADF(headingContent));
          textParts.push('\n');
        }
        break;
      }
      default:
        if (nodeContent(node).length > 0) {
          textParts.push(extractTextFromADF(nodeContent(node)));
        }
        break;
    }
  }

  return textParts.join('').trim();
}
