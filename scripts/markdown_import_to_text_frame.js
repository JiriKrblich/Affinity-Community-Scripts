'use strict';

const { app } = require('/application');
const { File } = require('/fs');
const { Document } = require('/document');
const { Selection, TextSelection } = require('/selections');
const { StoryRange } = require('affinity:story');
const { DocumentCommand } = require('/commands');
const { StoryDelta } = require('/storydelta');
const { ParagraphAttStringType } = require('/paragraphatts');
const { GlyphAttStringType } = require('/glyphatts');

const PARAGRAPH_STYLE = {
  body: 'Body',
  quote: 'Quote',
  bullet: 'Bullet 1',
  numbered: 'Numbered 1',
};

const INLINE_STYLE = {
  strong: 'Strong',
  emphasis: 'Emphasis',
  strongEmphasis: 'Strong Emphasis',
};

function isTextFrameNode(node) {
  return Boolean(node && node.isFrameTextNode && node.storyInterface && node.storyInterface.story);
}

function getSelectedFrameNode(doc) {
  const nodes = doc.selection.nodes;
  if (!nodes || nodes.length !== 1) {
    throw new Error('Select exactly one text frame before running this script.');
  }

  const node = nodes.first;
  if (!isTextFrameNode(node)) {
    throw new Error('Selected object is not a frame text node.');
  }

  return node;
}

function readUtf8File(path) {
  try {
    const buffer = File.readAll(path);
    if (!buffer) {
      throw new Error('Failed to read file.');
    }
    return String(buffer.toString());
  } catch (error) {
    const message = (error && error.message) ? error.message : String(error);
    if (message.includes('PERMISSION_DENIED')) {
      const desktopPath = app.getUserDesktopPath;
      throw new Error(
        `Affinity scripting cannot read this file (PERMISSION_DENIED).\n\n` +
        `Do one of the following:\n` +
        `1) Enable filesystem access for scripts in Affinity settings.\n` +
        `2) Move/copy the markdown file to your Desktop and select it from there.\n\n` +
        `Desktop path: ${desktopPath}`
      );
    }
    throw error;
  }
}

function normalizeNewlines(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function parseInline(text) {
  const spans = [];
  const out = [];
  const stack = [];
  let i = 0;

  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length && text[i + 1] === '*') {
      out.push('*');
      i += 2;
      continue;
    }

    let marker = null;
    if (text.startsWith('***', i)) marker = '***';
    else if (text.startsWith('**', i)) marker = '**';
    else if (text[i] === '*') marker = '*';

    if (!marker) {
      out.push(text[i]);
      i += 1;
      continue;
    }

    const top = stack.length > 0 ? stack[stack.length - 1] : null;
    if (top && top.marker === marker) {
      stack.pop();
      if (top.start < out.length) {
        const styleType = marker === '***' ? 'strongEmphasis' : marker === '**' ? 'strong' : 'emphasis';
        spans.push({ start: top.start, end: out.length, styleType });
      }
    } else {
      stack.push({ marker, start: out.length });
    }

    i += marker.length;
  }

  for (let j = stack.length - 1; j >= 0; j -= 1) {
    const unclosed = stack[j];
    out.splice(unclosed.start, 0, unclosed.marker);
    for (let k = 0; k < spans.length; k += 1) {
      if (spans[k].start >= unclosed.start) spans[k].start += unclosed.marker.length;
      if (spans[k].end >= unclosed.start) spans[k].end += unclosed.marker.length;
    }
  }

  return { text: out.join(''), spans };
}

function parseMarkdown(markdownText) {
  const lines = normalizeNewlines(markdownText).split('\n');
  const blocks = [];
  let paragraphLines = [];

  function flushParagraph() {
    if (paragraphLines.length === 0) return;
    const paragraphText = paragraphLines.join(' ').trim();
    if (paragraphText.length > 0) {
      blocks.push({ type: 'paragraph', level: 0, text: paragraphText });
    }
    paragraphLines = [];
  }

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      flushParagraph();
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      continue;
    }

    const bullet = line.match(/^\s*[-+*]\s+(.*)$/);
    if (bullet) {
      flushParagraph();
      blocks.push({ type: 'bullet', level: 0, text: bullet[1].trim() });
      continue;
    }

    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (numbered) {
      flushParagraph();
      blocks.push({ type: 'numbered', level: 0, text: numbered[1].trim() });
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      blocks.push({ type: 'quote', level: 0, text: quote[1].trim() });
      continue;
    }

    paragraphLines.push(trimmed);
  }

  flushParagraph();

  const processed = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const parsed = parseInline(blocks[i].text);
    processed.push({
      type: blocks[i].type,
      level: blocks[i].level,
      text: parsed.text,
      inlineSpans: parsed.spans,
    });
  }

  const paragraphPlan = [];
  const inlinePlan = [];
  const textParts = [];
  let cursor = 0;

  for (let i = 0; i < processed.length; i += 1) {
    const block = processed[i];
    if (block.text.length === 0) continue;

    if (textParts.length > 0) {
      textParts.push('\n');
      cursor += 1;
    }

    const begin = cursor;
    textParts.push(block.text);
    cursor += block.text.length;
    const end = cursor;

    paragraphPlan.push({ begin, end, blockType: block.type, level: block.level });

    for (let j = 0; j < block.inlineSpans.length; j += 1) {
      const span = block.inlineSpans[j];
      if (span.end > span.start) {
        inlinePlan.push({
          begin: begin + span.start,
          end: begin + span.end,
          styleType: span.styleType,
        });
      }
    }
  }

  return {
    text: textParts.join(''),
    paragraphPlan,
    inlinePlan,
  };
}

function createRangeSelection(doc, frameNode, begin, end) {
  const selection = Selection.create(doc, frameNode);
  const textSelection = TextSelection.create(new StoryRange(begin, end));
  selection.addSubSelectionForNode(frameNode, textSelection);
  return selection;
}

function executeFormatCommand(doc, selection, delta) {
  const command = DocumentCommand.createFormatText(selection, delta);
  doc.executeCommand(command);
}

function tryApplyParagraphStyle(doc, frameNode, begin, end, styleName) {
  const selection = createRangeSelection(doc, frameNode, begin, end);
  const delta = StoryDelta.createParagraphString(ParagraphAttStringType.StyleName, styleName);
  executeFormatCommand(doc, selection, delta);
}

function tryApplyGlyphStyle(doc, frameNode, begin, end, styleName) {
  const selection = createRangeSelection(doc, frameNode, begin, end);
  const delta = StoryDelta.createGlyphString(GlyphAttStringType.StyleName, styleName);
  executeFormatCommand(doc, selection, delta);
}

function applyParagraphStyleWithFallback(doc, frameNode, begin, end, candidates) {
  for (let i = 0; i < candidates.length; i += 1) {
    const styleName = candidates[i];
    if (!styleName) continue;
    try {
      tryApplyParagraphStyle(doc, frameNode, begin, end, styleName);
      return styleName;
    } catch (error) {
      // Try next fallback style.
    }
  }
  return null;
}

function applyGlyphStyleWithFallback(doc, frameNode, begin, end, candidates) {
  for (let i = 0; i < candidates.length; i += 1) {
    const styleName = candidates[i];
    if (!styleName) continue;
    try {
      tryApplyGlyphStyle(doc, frameNode, begin, end, styleName);
      return styleName;
    } catch (error) {
      // Try next fallback style.
    }
  }
  return null;
}

function paragraphStyleCandidates(blockType, headingLevel) {
  if (blockType === 'heading') {
    if (headingLevel <= 1) return ['Heading 1', PARAGRAPH_STYLE.body];
    if (headingLevel === 2) return ['Heading 2', PARAGRAPH_STYLE.body];
    return [`Heading ${headingLevel}`, 'Heading 2', PARAGRAPH_STYLE.body];
  }

  if (blockType === 'bullet') return [PARAGRAPH_STYLE.bullet, PARAGRAPH_STYLE.body];
  if (blockType === 'numbered') return [PARAGRAPH_STYLE.numbered, PARAGRAPH_STYLE.body];
  if (blockType === 'quote') return [PARAGRAPH_STYLE.quote, PARAGRAPH_STYLE.body];
  return [PARAGRAPH_STYLE.body];
}

function inlineStyleCandidates(styleType) {
  if (styleType === 'strong') return [INLINE_STYLE.strong];
  if (styleType === 'emphasis') return [INLINE_STYLE.emphasis];
  if (styleType === 'strongEmphasis') return [INLINE_STYLE.strongEmphasis, INLINE_STYLE.strong, INLINE_STYLE.emphasis];
  return [];
}

function setFrameText(doc, frameNode, text) {
  const selection = Selection.create(doc, frameNode);
  const command = DocumentCommand.createSetText(selection, text);
  doc.executeCommand(command);
}

function importMarkdownIntoSelectedFrame(pathOverride) {
  const doc = Document.current;
  if (!doc) {
    throw new Error('No open document.');
  }

  const frameNode = getSelectedFrameNode(doc);

  const path = pathOverride || app.chooseFile();
  if (!path) {
    throw new Error('No markdown file selected.');
  }

  const markdown = readUtf8File(path);
  const parsed = parseMarkdown(markdown);

  setFrameText(doc, frameNode, parsed.text);

  for (let i = 0; i < parsed.paragraphPlan.length; i += 1) {
    const entry = parsed.paragraphPlan[i];
    if (entry.end <= entry.begin) continue;
    const candidates = paragraphStyleCandidates(entry.blockType, entry.level);
    applyParagraphStyleWithFallback(doc, frameNode, entry.begin, entry.end, candidates);
  }

  for (let i = 0; i < parsed.inlinePlan.length; i += 1) {
    const entry = parsed.inlinePlan[i];
    if (entry.end <= entry.begin) continue;
    const candidates = inlineStyleCandidates(entry.styleType);
    applyGlyphStyleWithFallback(doc, frameNode, entry.begin, entry.end, candidates);
  }

  return {
    path,
    characters: parsed.text.length,
    paragraphCount: parsed.paragraphPlan.length,
    inlineCount: parsed.inlinePlan.length,
  };
}

function main() {
  try {
    const result = importMarkdownIntoSelectedFrame();
    app.alert(`Imported markdown from:\n${result.path}\n\nParagraphs: ${result.paragraphCount}\nInline styles: ${result.inlineCount}`);
  } catch (error) {
    app.alert(error.message || String(error), 'Markdown Import Failed');
  }
}

module.exports.main = main;
module.exports.importMarkdownIntoSelectedFrame = importMarkdownIntoSelectedFrame;

// Execute immediately when run from Affinity Script Library.
main();
