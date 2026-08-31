/**
 * name: Split Art Text
 * description: Split multi-line text into single lines, split spaced single-line text into segments, and split unspaced single-line text into individual characters.
 * version: 2.2.0
 * author: OpenAI Codex
 */
'use strict';

const { app } = require('/application');
const { Document } = require('/document');
const { DocumentCommand } = require('/commands');
const { Selection, TextSelection } = require('/selections');
const { Transform } = require('/geometry');
const {
    StoryRange: AffinityStoryRange,
    StoryIoFormat: AffinityStoryIoFormat,
    HardBreakType: AffinityHardBreakType
} = require('/story');
const { ParagraphAlignXType, StoryDelta } = require('/storydelta');

function valueOfEnum(x) {
    return x && typeof x === 'object' && 'value' in x ? x.value : x;
}

function fail(message) {
    throw new Error(message);
}

function getCurrentDocument() {
    const document = Document.current;
    if (!document) fail('请先打开一个文档。');
    return document;
}

function getSelectedArtTextNodes(document) {
    const nodes = document.selection.nodes.toArray();
    if (!nodes.length) fail('请选择至少一个艺术文本对象。');
    if (nodes.some((node) => node.isFrameTextNode)) {
        fail('检测到文本框。请先将文本框转换为艺术文本，再进行拆分。');
    }
    if (nodes.some((node) => !node.isArtTextNode)) {
        fail('请选择艺术文本对象，不要包含其他类型的图层。');
    }
    return nodes;
}

function createNodeSelection(document, node) {
    return Selection.create(document, node);
}

function createTextSubSelection(document, node, begin, end) {
    const selection = createNodeSelection(document, node);
    selection.addSubSelectionForNode(node, TextSelection.create(new AffinityStoryRange(begin, end)));
    return selection;
}

function setTextRange(document, node, begin, end, text) {
    if (end <= begin) return;
    document.executeCommand(
        DocumentCommand.createSetText(createTextSubSelection(document, node, begin, end), text)
    );
}

function duplicateNode(document, node) {
    const command = DocumentCommand.createTransform(
        createNodeSelection(document, node),
        Transform.createIdentity(),
        { duplicateNodes: true }
    );
    document.executeCommand(command);
    return command.newNodes[0];
}

function translateNode(document, node, dx, dy) {
    if (Math.abs(dx) < 0.0001 && Math.abs(dy) < 0.0001) return;
    document.executeCommand(
        DocumentCommand.createTransform(
            createNodeSelection(document, node),
            Transform.createTranslate(dx, dy)
        )
    );
}

function storyText(story, begin, end) {
    return story.getText(begin, end - begin, AffinityStoryIoFormat.ClipboardDescriptions);
}

function isHardBreak(story, pos) {
    var breakType = valueOfEnum(story.getHardBreakType(pos));
    return (
        breakType === valueOfEnum(AffinityHardBreakType.Line) ||
        breakType === valueOfEnum(AffinityHardBreakType.Paragraph)
    );
}

function getLineRanges(node) {
    const story = node.storyInterface.story;
    const range = node.storyInterface.storyRange;
    const result = [];
    let begin = range.begin;
    for (let pos = range.begin; pos < range.end; pos++) {
        if (!isHardBreak(story, pos)) continue;
        result.push([begin, pos]);
        begin = pos + 1;
    }
    result.push([begin, range.end]);
    return result.filter(([lineBegin, lineEnd]) => /\S/.test(storyText(story, lineBegin, lineEnd)));
}

function getCharacterGlyphRanges(node) {
    const story = node.storyInterface.story;
    const range = node.storyInterface.storyRange;
    const glyphRanges = [];
    for (let pos = range.begin; pos < range.end; pos++) {
        if (isHardBreak(story, pos)) continue;
        const text = storyText(story, pos, pos + 1);
        if (!text.length) continue;
        if (/^\s+$/.test(text)) continue;
        glyphRanges.push([pos, pos + 1]);
    }
    if (!glyphRanges.length) fail('当前对象没有可拆分的可见字符。');
    return glyphRanges;
}

function getWordRanges(node) {
    const story = node.storyInterface.story;
    const range = node.storyInterface.storyRange;
    const wordRanges = story.wordRanges
        .toArray()
        .filter((wordRange) => wordRange.begin >= range.begin && wordRange.end <= range.end)
        .map((wordRange) => [wordRange.begin, wordRange.end]);
    if (wordRanges.length < 2) {
        fail('单行文字至少需要包含一个空格，才能拆分成多个对象。');
    }
    return wordRanges;
}

function extractSpanAsNode(document, sourceNode, sourceRange, spanRange, targetLeftX) {
    const duplicate = duplicateNode(document, sourceNode);
    let storyRange = duplicate.storyInterface.storyRange;
    const startOffset = spanRange[0] - sourceRange.begin;
    const endOffset = spanRange[1] - sourceRange.begin;
    setTextRange(document, duplicate, storyRange.begin + endOffset, storyRange.end, '');
    const anchoredBox = duplicate.getSpreadBaseBox(false);

    storyRange = duplicate.storyInterface.storyRange;
    setTextRange(document, duplicate, storyRange.begin, storyRange.begin + startOffset, '');

    const currentBox = duplicate.getSpreadBaseBox(false);
    // The split result follows the source text area's left edge. This avoids
    // short lines drifting right because of the temporary node's width.
    const dx = typeof targetLeftX === 'number'
        ? targetLeftX - currentBox.x
        : anchoredBox.x + anchoredBox.width - (currentBox.x + currentBox.width);
    const dy = anchoredBox.y + anchoredBox.height - (currentBox.y + currentBox.height);
    translateNode(document, duplicate, dx, dy);

    // Preserve the extracted text's visual position while changing its paragraph alignment.
    const positionedContentBox = getTextContentBox(duplicate);
    document.executeCommand(
        DocumentCommand.createFormatText(
            createNodeSelection(document, duplicate),
            StoryDelta.createAlignX(ParagraphAlignXType.Left)
        )
    );
    const alignedContentBox = getTextContentBox(duplicate);
    translateNode(
        document,
        duplicate,
        positionedContentBox.x - alignedContentBox.x,
        positionedContentBox.y - alignedContentBox.y
    );
    return duplicate;
}

function finishSplit(document, sourceNode) {
    const sourceSelection = createNodeSelection(document, sourceNode);
    document.executeCommand(DocumentCommand.createDeleteSelection(sourceSelection));
}

function splitByRanges(document, node, ranges, targetLeftX) {
    const sourceRange = node.storyInterface.storyRange;
    const nodes = ranges.map((range) =>
        extractSpanAsNode(document, node, sourceRange, range, targetLeftX)
    );
    finishSplit(document, node);
    return nodes;
}

function getTextContentBox(node) {
    return node.getContentExtentsBox(false, false);
}

function classifySplit(node) {
    const lineRanges = getLineRanges(node);
    if (lineRanges.length > 1) {
        return { mode: 'lines', node, ranges: lineRanges };
    }
    try {
        return { mode: 'words', node, ranges: getWordRanges(node) };
    } catch (error) {
        return { mode: 'characters', node, ranges: getCharacterGlyphRanges(node) };
    }
}

function executePreparedSplit(document, split) {
    if (split.mode === 'lines') {
        return splitByRanges(
            document,
            split.node,
            split.ranges,
            getTextContentBox(split.node).x
        );
    }

    if (split.mode === 'words') {
        return splitByRanges(document, split.node, split.ranges, undefined);
    }
    return splitByRanges(document, split.node, split.ranges, undefined);
}

function main() {
    const document = getCurrentDocument();
    const nodes = getSelectedArtTextNodes(document);
    const splits = nodes
        .map((node) => classifySplit(node));
    const resultNodes = [];
    for (const split of splits) {
        resultNodes.push(...executePreparedSplit(document, split));
    }
    document.executeCommand(DocumentCommand.createSetSelection(Selection.create(document, resultNodes)));
    console.log(`拆分完成，共生成 ${resultNodes.length} 个对象。`);
}

try {
    main();
} catch (error) {
    app.alert(error && error.message ? error.message : String(error), 'Split Art Text');
}
