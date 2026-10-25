'use strict';
/**
 * name: Join & Split Text
 * description: Splits text objects into one object per line or paragraph, or
 *              joins several text objects (or the lines of one) into a single
 *              paragraph. Keeps character formatting and the position of every
 *              line. Works with artistic text and text frames, including the
 *              lines a frame wraps on its own. One Ctrl+Z undoes everything.
 * version: 1.0.3
 * author: Victor Crespo (3dvic.com · github.com/vicc3d)
 * license: MIT
 *
 * Victor Crespo -- 3dvic.com -- github.com/vicc3d/affinity-join-split-text
 */

const { app } = require('/application.js');
const { Document } = require('/document.js');
const {
    DocumentCommand, CompoundCommandBuilder, AddChildNodesCommandBuilder, InsertionMode
} = require('/commands.js');
const { Selection, TextSelection } = require('/selections.js');
const { StoryBuilder } = require('/storybuilder.js');
const { ArtTextNodeDefinition, FrameTextNodeDefinition, NodeChildType } = require('/nodes.js');
const { Transform } = require('/geometry.js');
const { HardBreakType } = require('/story.js');
const { StoryDelta, ParagraphAttDoubleType } = require('/storydelta.js');
const { Dialog, DialogResult } = require('/dialog.js');

const LANG = 'en';

// ---------------------------------------------------------------------------
// UI strings
// ---------------------------------------------------------------------------

const STRINGS = {
    en: {
        title: 'Join & Split Text',
        noDocument: 'No document is open.',
        noText: 'Select one or more text objects (artistic text or text frames) first.',
        selectionInfo: (n) => n === 1 ? '1 text object selected.' : n + ' text objects selected.',

        modeLabel: 'Mode',
        modes: ['Split', 'Join'],

        splitGroup: 'Split',
        splitBy: 'Split by',
        splitByItems: ['Lines', 'Paragraphs'],
        splitByHelp: 'Lines: every line as you see it, including the lines a text frame wraps on its own.',
        output: 'Output',
        outputItems: ['Same as original', 'Artistic text', 'Text frames'],

        joinGroup: 'Join',
        order: 'Order',
        orderItems: ['Top to bottom', 'Left to right'],
        separator: 'Separator',
        separatorItems: ['Space', 'Line break', 'Paragraph break', 'Nothing'],
        joinInside: 'Also join the lines inside each text',
        rejoinHyphens: 'Rejoin words split with a hyphen',
        keepFormatting: "Keep each text's formatting",

        keepOriginals: 'Keep the original objects',

        nothingToSplit: 'There is nothing to split: every selected text has a single line.',
        nothingToJoin: 'There is nothing to join: the selected text has a single line.',
        splitDone: (lines, sources) => 'Created ' + lines + ' text object' + (lines === 1 ? '' : 's') +
            ' from ' + sources + ' original' + (sources === 1 ? '' : 's') + '.',
        joinDone: (pieces, nodes) => 'Joined ' + pieces + ' piece' + (pieces === 1 ? '' : 's') +
            ' of text from ' + nodes + ' object' + (nodes === 1 ? '' : 's') + ' into one.',
        skippedLinked: (n) => n + ' linked text frame(s) skipped: unlink them first.',
        skippedRotated: (n) => n + ' rotated, skewed or flipped text object(s) skipped: reset the rotation first.',
        undoHint: 'Ctrl+Z undoes everything in one step.',
        error: (msg) => 'Something went wrong:\n' + msg,
    },
};

const T = STRINGS[LANG];

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LINE_BREAK = String.fromCharCode(0x2028);     // Shift+Enter
const SOFT_HYPHEN = String.fromCharCode(0x00AD);
const SEPARATORS = [' ', LINE_BREAK, '\n', ''];     // space, line break, paragraph break, nothing
const SPLIT_BY_LINES = 0;
const OUTPUT_SAME = 0, OUTPUT_ART = 1, OUTPUT_FRAME = 2;
const ORDER_TOP_DOWN = 0;
// Absolute lengths in glyph and paragraph attributes. A StoryDelta reads them in UI units, while
// the story stores them divided by the node's text UI scale (its total scale; 300 / 72 for text
// inside a container imported at 72 dpi into a 300 dpi document), so they must be scaled up when
// formatting is copied. Ratios (tracking, kerning, relative leading,
// word and letter spacing) are left alone.
const GLYPH_LENGTH_ATTS = ['height', 'offsetX', 'offsetY', 'absoluteLeading', 'baselineAdvance',
    'autoKernMinHeight'];
const PARAGRAPH_LENGTH_ATTS = ['absoluteLeading', 'leftIndent', 'rightIndent', 'firstLineIndent',
    'spaceBefore', 'spaceAfter', 'defaultTabStops', 'lastLineOutdent', 'spaceBetweenSameStyles',
    'hyphenationZone', 'hyphenationZoneCapitals', 'hyphenationZoneParagraphEnd',
    'hyphenationZoneColumnEnd'];
// A line counts as new when the ink bottom drops by more than this share of the font height.
// Adding a word with a descender to the same line moves it by ~0.25.
const NEW_LINE_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function enumValue(x) {
    return x && typeof x === 'object' && 'value' in x ? x.value : x;
}

const HB_NONE = enumValue(HardBreakType.None);
const HB_LINE = enumValue(HardBreakType.Line);
const HB_STORY = enumValue(HardBreakType.Story);

function textSelection(doc, node, begin, end) {
    const selection = Selection.create(doc, node);
    selection.addSubSelectionForNode(node, TextSelection.create([{ begin, end }]));
    return selection;
}

function compound(commands) {
    if (commands.length === 1) return commands[0];
    const builder = CompoundCommandBuilder.create();
    for (const cmd of commands) builder.addCommand(cmd);
    return builder.createCommand();
}

function inkBox(node) {
    return node.getExactSpreadVisibleBox(false, false);
}

function bottom(box) {
    return box.y + box.height;
}

// The node's full transform to the spread. localToSpreadTransform covers only its parents
// (text inside an imported, scaled container gets its scale from there), so add its own.
function worldTransform(node) {
    return node.localToSpreadTransform.multiply(node.transform);
}

function isUprightTransform(t) {
    const d = t.data;
    return Math.abs(d[1]) < 1e-6 && Math.abs(d[3]) < 1e-6 && d[0] > 0 && d[4] > 0;
}

// Story units → UI units for this node's text (1 when nothing above it is scaled).
function textUiScale(node) {
    try {
        const s = node.storyInterface.textUiScale.data[0];
        if (typeof s === 'number' && isFinite(s) && s > 0) return s;
    } catch (_) { /* fall through */ }
    return 1;
}

function scaledCopy(atts, keys, factor) {
    const copy = atts.clone();
    if (factor === 1) return copy;
    for (const key of keys) {
        try {
            const v = copy[key];
            if (typeof v === 'number' && isFinite(v)) copy[key] = v * factor;
        } catch (_) { /* attribute not available in this version */ }
    }
    return copy;
}

// Deltas that reproduce atts read from a story whose node has the given text UI scale.
function glyphDelta(atts, uiScale) {
    return StoryDelta.createFromGlyphAtts(scaledCopy(atts, GLYPH_LENGTH_ATTS, uiScale));
}

function paragraphDelta(atts, uiScale) {
    return StoryDelta.createFromParagraphAtts(scaledCopy(atts, PARAGRAPH_LENGTH_ATTS, uiScale));
}

function isLetter(c) {
    return !!c && c.toLowerCase() !== c.toUpperCase();
}

function isLowerCaseLetter(c) {
    return isLetter(c) && c === c.toLowerCase();
}

// ---------------------------------------------------------------------------
// Reading a text node
// ---------------------------------------------------------------------------

// The story of a single (unlinked) text node, its content range without the end-of-story
// terminator, and one character per position, with hard breaks normalised.
function readText(node) {
    const story = node.storyInterface.story;
    const range = node.storyInterface.storyRange;
    const begin = range.begin;
    const end = Math.min(range.end, story.length);
    const chars = [];
    const breaks = [];
    for (let p = begin; p < end; p++) {
        const hb = enumValue(story.getHardBreakType(p));
        breaks.push(hb === HB_STORY ? HB_NONE : hb);
        if (hb === HB_LINE) chars.push(LINE_BREAK);
        else if (hb !== HB_NONE && hb !== HB_STORY) chars.push('\n');
        else chars.push(story.getText(p, 1));
    }
    return {
        node, story, begin, end, chars, breaks,
        charAt: (p) => chars[p - begin] || '',
        breakAt: (p) => breaks[p - begin] || HB_NONE,
    };
}

function isBlank(info, p) {
    return info.breakAt(p) !== HB_NONE || /^\s*$/.test(info.charAt(p));
}

// Shrinks [begin, end) so it starts and ends with a visible character; null when empty.
function trimRange(info, begin, end) {
    while (begin < end && isBlank(info, begin)) begin++;
    while (end > begin && isBlank(info, end - 1)) end--;
    return begin < end ? { begin, end } : null;
}

// Ranges between hard breaks. byParagraph keeps line breaks (Shift+Enter) inside a range.
function rangesBetweenBreaks(info, byParagraph) {
    const ranges = [];
    let start = info.begin;
    for (let p = info.begin; p < info.end; p++) {
        const hb = info.breakAt(p);
        if (hb === HB_NONE || (byParagraph && hb === HB_LINE)) continue;
        ranges.push({ begin: start, end: p });
        start = p + 1;
    }
    ranges.push({ begin: start, end: info.end });
    return ranges;
}

function fontHeightAt(info, p) {
    try {
        const h = info.story.getGlyphAtts(p).height;
        if (typeof h === 'number' && isFinite(h) && h > 0) return h;
    } catch (_) { /* fall through */ }
    return 12;
}

function maxFontHeight(info, range) {
    let h = 0;
    for (let p = range.begin; p < range.end; p++) h = Math.max(h, fontHeightAt(info, p));
    return h || 12;
}

// ---------------------------------------------------------------------------
// Measuring with previews (nothing reaches the undo history)
// ---------------------------------------------------------------------------

// Ink bottom of the node when only the text before position p is kept. Each preview costs a
// re-layout, so results are cached per node.
function inkBottomUpTo(doc, info, p) {
    p = Math.min(p, info.end);
    if (!info.bottoms) info.bottoms = new Map();
    if (info.bottoms.has(p)) return info.bottoms.get(p);
    let value;
    if (p >= info.end) {
        value = bottom(inkBox(info.node));
    } else {
        doc.executeCommand(DocumentCommand.createSetText(textSelection(doc, info.node, p, info.end), ''), true);
        try {
            value = bottom(inkBox(info.node));
        } finally {
            doc.clearPreviews();
        }
    }
    info.bottoms.set(p, value);
    return value;
}

// Splits one paragraph of a text frame into the lines the frame wraps it into, at word ends:
// a new line starts where the ink bottom jumps. Lines tend to hold a similar number of words,
// so the search first tries the previous line's word count, then gallops and bisects.
function wrapRange(doc, info, range) {
    const candidates = [];
    for (let p = range.begin + 1; p < range.end; p++) {
        if (!isBlank(info, p - 1) && isBlank(info, p)) candidates.push(p);
    }
    candidates.push(range.end);
    const last = candidates.length - 1;
    const uiScale = textUiScale(info.node);

    const lines = [];
    let start = range.begin;
    let i = 0;
    let wordsPerLine = 1;
    while (i <= last) {
        const ref = inkBottomUpTo(doc, info, candidates[i]);
        // Font heights are in story units; ink bottoms in spread units.
        const tolerance = fontHeightAt(info, Math.max(range.begin, candidates[i] - 1)) * uiScale *
            NEW_LINE_THRESHOLD;
        const sameLine = (k) => inkBottomUpTo(doc, info, candidates[k]) <= ref + tolerance;

        // [lo] is known to be on this line; [hi + 1] is known not to be (or does not exist).
        let lo = i;
        let hi = last;
        // Step sequence: the expected line end, then one word more (usually the next line's
        // first word, whose bottom is reused as the next reference), then doubling.
        let step = Math.max(1, wordsPerLine - 1);
        let first = true;
        while (lo < hi) {
            const probe = Math.min(hi, lo + step);
            if (sameLine(probe)) {
                lo = probe;
                step = first ? 1 : step * 2;
                first = false;
            } else {
                hi = probe - 1;
                break;
            }
        }
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (sameLine(mid)) lo = mid;
            else hi = mid - 1;
        }
        lines.push({ begin: start, end: candidates[lo] });
        wordsPerLine = lo - i + 1;
        start = candidates[lo];
        i = lo + 1;
    }
    return lines;
}

// Where the line [begin, end) sits on the spread, measured from its ink.
// The line is isolated in a preview (it moves to the top of the text), then shifted back down by
// the distance between its bottom in place and its bottom when isolated.
function measureLineBox(doc, info, range) {
    const inPlaceBottom = inkBottomUpTo(doc, info, range.end);
    const node = info.node;
    const commands = [];
    if (range.end < info.end) {
        commands.push(DocumentCommand.createSetText(textSelection(doc, node, range.end, info.end), ''));
    }
    if (range.begin > info.begin) {
        commands.push(DocumentCommand.createSetText(textSelection(doc, node, info.begin, range.begin), ''));
        // A line that did not start a paragraph must not pick up the first-line indent.
        if (info.breakAt(range.begin - 1) === HB_NONE || info.breakAt(range.begin - 1) === HB_LINE) {
            commands.push(DocumentCommand.createFormatText(
                textSelection(doc, node, info.begin, info.begin + (range.end - range.begin)),
                firstLineIndentDelta(0)));
        }
    }
    let box;
    if (commands.length) {
        doc.executeCommand(compound(commands), true);
        try {
            box = inkBox(node);
        } finally {
            doc.clearPreviews();
        }
    } else {
        box = inkBox(node);
    }
    return { x: box.x, y: inPlaceBottom - box.height, width: box.width, height: box.height };
}

function firstLineIndentDelta(value) {
    return StoryDelta.createParagraphDouble(ParagraphAttDoubleType.FirstLineIndent, value);
}

// ---------------------------------------------------------------------------
// Split
// ---------------------------------------------------------------------------

// The ranges one node splits into, trimmed and non-empty.
function splitRanges(doc, info, options) {
    const byParagraph = options.splitBy !== SPLIT_BY_LINES;
    let ranges = rangesBetweenBreaks(info, byParagraph)
        .map(r => trimRange(info, r.begin, r.end))
        .filter(Boolean);
    if (!byParagraph && info.node.isFrameTextNode) {
        const wrapped = [];
        for (const r of ranges) wrapped.push(...wrapRange(doc, info, r));
        ranges = wrapped.map(r => trimRange(info, r.begin, r.end)).filter(Boolean);
    }
    return ranges;
}

// Layers panel name for a new text object: its text on one line, shortened.
function layerName(text) {
    return text.split(LINE_BREAK).join(' ').split('\n').join(' ').slice(0, 60);
}

function lineText(info, range) {
    return info.chars.slice(range.begin - info.begin, range.end - info.begin).join('');
}

function makeStoryBuilder(doc, info, range, asFrame) {
    const builder = StoryBuilder.create();
    if (asFrame) builder.setToFrameTextDefaultStyle(doc.dpi, doc.rasterFormat);
    else builder.setToArtisticTextDefaultStyle(doc.dpi, doc.rasterFormat);

    const paragraphAtts = info.story.getParagraphAtts(range.begin).clone();
    paragraphAtts.firstLineIndent = 0;
    paragraphAtts.spaceBefore = 0;
    paragraphAtts.spaceAfter = 0;
    builder.setParagraphAtts(paragraphAtts);

    for (let p = range.begin; p < range.end; p++) {
        builder.setGlyphAtts(info.story.getGlyphAtts(p).clone());
        const hb = info.breakAt(p);
        if (hb === HB_NONE) builder.addText(info.charAt(p));
        else if (hb === HB_LINE) builder.addText(LINE_BREAK);
        else builder.addParagraphBreak();
    }
    return builder;
}

function makeDefinition(doc, plan, line, frameHeight, spreadTransform, description) {
    const builder = makeStoryBuilder(doc, plan.info, line.range, plan.asFrame);
    const definition = plan.asFrame
        ? FrameTextNodeDefinition.createFromStoryBuilder(
            { x: 0, y: 0, width: plan.frameWidth, height: frameHeight }, builder)
        : ArtTextNodeDefinition.createFromStoryBuilder({ x: 0, y: 0 }, builder);
    definition.transform = spreadTransform;   // spread space; Affinity maps it into the parent
    definition.userDescription = description;
    return definition;
}

function addCommandFor(doc, plan, definitions, andSelect) {
    const builder = AddChildNodesCommandBuilder.create();
    builder.setInsertionTarget(plan.node);
    builder.setInsertionMode(InsertionMode.Behind);
    for (const d of definitions) builder.addNode(d);
    return builder.createCommand(andSelect, NodeChildType.Main);
}

// Plans the split of one node: its lines, where each one sits, and the kind of output.
function planSplit(doc, node, options) {
    const info = readText(node);
    const ranges = splitRanges(doc, info, options);
    const asFrame = options.output === OUTPUT_FRAME ||
        (options.output === OUTPUT_SAME && node.isFrameTextNode);
    const lines = ranges.map(range => ({
        range,
        text: lineText(info, range),
        box: measureLineBox(doc, info, range),
        fontHeight: maxFontHeight(info, range),
    }));

    // Local units per spread unit, so frame sizes can be given in the node's own space.
    const scale = worldTransform(node).data[0] || 1;
    let frameWidth = 0;
    if (asFrame) {
        if (node.isFrameTextNode) {
            frameWidth = node.baseBox.width;
        } else {
            const widest = Math.max(...lines.map(l => l.box.width));
            const font = Math.max(...lines.map(l => l.fontHeight));
            frameWidth = widest / scale + font;
        }
    }
    return { node, info, lines, asFrame, frameWidth, scale };
}

function splitNodes(doc, nodes, options) {
    const plans = nodes.map(node => planSplit(doc, node, options));
    const toSplit = plans.filter(p => p.lines.length > 1 ||
        (p.lines.length === 1 && options.output !== OUTPUT_SAME &&
            p.asFrame !== !!p.node.isFrameTextNode));
    if (!toSplit.length) return { created: 0, sources: 0 };

    // Pass 1 (preview): create every line at the original's origin and measure its ink.
    const previewCommands = toSplit.map((plan, pi) => addCommandFor(doc, plan, plan.lines.map((line, li) => {
        const tallEnough = plan.node.isFrameTextNode
            ? plan.node.baseBox.height
            : (line.box.height / plan.scale) * 4 + line.fontHeight * 2;
        return makeDefinition(doc, plan, line, tallEnough, worldTransform(plan.node),
            '__tj_' + pi + '_' + li);
    }), false));
    const previewCommand = compound(previewCommands);
    doc.executeCommand(previewCommand, true);
    try {
        const byId = new Map(previewCommand.newNodes.map(n => [n.userDescription, n]));
        toSplit.forEach((plan, pi) => plan.lines.forEach((line, li) => {
            const node = byId.get('__tj_' + pi + '_' + li);
            if (!node) throw new Error('Affinity did not return the preview of a new text object.');
            const ink = inkBox(node);
            // Match the top-left of the ink. A word too long for its frame wraps mid-word and
            // spans two lines there but one here; this keeps it where the word starts.
            line.dx = line.box.x - ink.x;
            line.dy = line.box.y - ink.y;
            if (plan.asFrame) {
                const frameTop = node.getSpreadBaseBox(false).y;
                line.frameHeight = (bottom(ink) - frameTop) / plan.scale + line.fontHeight * 0.35;
            }
        }));
    } finally {
        doc.clearPreviews();
    }

    // Pass 2: the real thing, in one undoable step.
    const commands = [];
    for (const plan of toSplit) {
        commands.push(addCommandFor(doc, plan, plan.lines.map(line => makeDefinition(doc, plan, line,
            line.frameHeight,
            Transform.createTranslate(line.dx, line.dy).multiply(worldTransform(plan.node)),
            layerName(line.text))), true));
        if (!options.keepOriginals) {
            commands.push(DocumentCommand.createDeleteSelection(Selection.create(doc, plan.node), true));
        }
    }
    doc.executeCommand(compound(commands));
    return { created: toSplit.reduce((n, p) => n + p.lines.length, 0), sources: toSplit.length };
}

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------

function readingOrder(nodes, order) {
    const items = nodes.map(node => ({ node, box: node.getSpreadBaseBox(false) }));
    if (order === ORDER_TOP_DOWN) {
        // Rows first: two objects share a row when their vertical centres are within half the
        // smaller height; inside a row, left to right.
        items.sort((a, b) => {
            const ca = a.box.y + a.box.height / 2;
            const cb = b.box.y + b.box.height / 2;
            const sameRow = Math.abs(ca - cb) < Math.min(a.box.height, b.box.height) / 2;
            return sameRow ? a.box.x - b.box.x : ca - cb;
        });
    } else {
        items.sort((a, b) => {
            const ca = a.box.x + a.box.width / 2;
            const cb = b.box.x + b.box.width / 2;
            const sameColumn = Math.abs(ca - cb) < Math.min(a.box.width, b.box.width) / 2;
            return sameColumn ? a.box.y - b.box.y : ca - cb;
        });
    }
    return items.map(i => i.node);
}

// The pieces of text one node contributes, trimmed and non-empty.
function joinPieces(info, splitInside) {
    const ranges = splitInside ? rangesBetweenBreaks(info, false) : [{ begin: info.begin, end: info.end }];
    return ranges.map(r => trimRange(info, r.begin, r.end)).filter(Boolean).map(r => ({ info, ...r }));
}

// How piece a connects to piece b: the separator, and whether a's trailing hyphen goes.
function joint(a, b, options) {
    if (options.rejoinHyphens && a.end - a.begin >= 2) {
        const last = a.info.charAt(a.end - 1);
        const before = a.info.charAt(a.end - 2);
        const next = b.info.charAt(b.begin);
        if ((last === '-' || last === SOFT_HYPHEN) && isLetter(before) && isLowerCaseLetter(next)) {
            return { separator: '', dropHyphen: true };
        }
    }
    return { separator: SEPARATORS[options.separator], dropHyphen: false };
}

// Text of a piece for insertion, without the trailing hyphen when it is dropped.
function pieceText(piece, end) {
    return piece.info.chars.slice(piece.begin - piece.info.begin, end - piece.info.begin).join('');
}

function joinNodes(doc, nodes, options) {
    const ordered = readingOrder(nodes, options.order);
    const infos = ordered.map(readText);
    const splitInside = options.joinInside || ordered.length === 1;
    const pieces = [];
    for (const info of infos) pieces.push(...joinPieces(info, splitInside));
    if (pieces.length < 2) return { pieces: 0, nodes: 0 };

    // The first text with any content receives the rest (an empty one before it has nothing to give).
    const target = pieces[0].info;
    const targetNode = target.node;
    const own = pieces.filter(p => p.info === target);
    const appended = pieces.filter(p => p.info !== target);
    const commands = [];

    // 1. Append the other objects' pieces after the target's last piece. These positions are the
    //    highest in the target, so they are edited first and nothing below them moves.
    if (appended.length) {
        const lastOwn = own[own.length - 1];
        const firstJoint = joint(lastOwn, appended[0], options);
        let pos = firstJoint.dropHyphen ? lastOwn.end - 1 : lastOwn.end;
        if (pos < target.end) {
            commands.push(DocumentCommand.createSetText(textSelection(doc, targetNode, pos, target.end), ''));
        }
        let pendingJoint = firstJoint;
        appended.forEach((piece, i) => {
            const next = appended[i + 1];
            const j = next ? joint(piece, next, options) : null;
            const end = j && j.dropHyphen ? piece.end - 1 : piece.end;
            const text = pieceText(piece, end);
            const separator = pendingJoint.separator;
            commands.push(DocumentCommand.createSetText(
                textSelection(doc, targetNode, pos, pos), separator + text));
            const start = pos + separator.length;
            if (options.keepFormatting) {
                formatLike(doc, targetNode, piece, end, start, commands);
                if (separator === '\n') {
                    commands.push(DocumentCommand.createFormatText(
                        textSelection(doc, targetNode, start, start + text.length),
                        paragraphDelta(piece.info.story.getParagraphAtts(piece.begin), textUiScale(piece.info.node))));
                }
            }
            pos = start + text.length;
            pendingJoint = j;
        });
    }

    // 2. Join the target's own pieces, from the back so earlier positions stay valid.
    for (let i = own.length - 2; i >= 0; i--) {
        const a = own[i];
        const b = own[i + 1];
        const j = joint(a, b, options);
        const from = j.dropHyphen ? a.end - 1 : a.end;
        commands.push(DocumentCommand.createSetText(textSelection(doc, targetNode, from, b.begin), j.separator));
    }

    // 3. Remove the objects whose text moved into the target.
    if (!options.keepOriginals) {
        const others = infos.filter(i => i !== target).map(i => i.node);
        if (others.length) {
            commands.push(DocumentCommand.createDeleteSelection(Selection.create(doc, others), true));
        }
    }

    doc.executeCommand(compound(commands));
    return { pieces: pieces.length, nodes: ordered.length };
}

// Copies the character formatting of piece [begin, end) onto the target at targetStart.
function formatLike(doc, targetNode, piece, end, targetStart, commands) {
    const uiScale = textUiScale(piece.info.node);
    for (const run of piece.info.story.getGlyphAttRunsFrom(piece.begin)) {
        if (run.begin >= end) break;
        const b = Math.max(run.begin, piece.begin);
        const e = Math.min(run.end, end);
        if (e <= b) continue;
        commands.push(DocumentCommand.createFormatText(
            textSelection(doc, targetNode, targetStart + (b - piece.begin), targetStart + (e - piece.begin)),
            glyphDelta(run.glyphAtts, uiScale)));
    }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

// Artistic text and text frames in the selection, looking inside groups.
function collectTextNodes(doc) {
    const found = [];
    const skipped = { linked: 0, rotated: 0 };
    const visit = (node) => {
        if (node.isArtTextNode || node.isFrameTextNode) {
            if (node.isFrameTextNode && node.textFrameInterface.isMultiFrameTextFlow) skipped.linked++;
            else if (!isUprightTransform(worldTransform(node))) skipped.rotated++;
            else found.push(node);
            return;
        }
        let children = [];
        try { children = [...node.children]; } catch (_) { /* not a container */ }
        children.forEach(visit);
    };
    for (const node of doc.selection.nodes) visit(node);
    return { nodes: found, skipped };
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

function runModalSafe(dlg) {
    const t0 = Date.now();
    try {
        const r = dlg.runModal();
        return r === DialogResult.Ok || r === DialogResult.Ok.value || (r && r.value === DialogResult.Ok.value);
    } catch (e) {
        if (Date.now() - t0 < 500) throw e;
        return false; // window closed with the title-bar X
    }
}

function showDialog(count) {
    const dlg = Dialog.create(T.title);
    // No initialWidth: with 420 the dialog froze under Wine (Linux), re-laying itself out
    // endlessly. Affinity sizes it to its content instead.
    const col = dlg.addColumn();

    const gMode = col.addGroup('');
    const modeSet = gMode.addButtonSet(T.modeLabel, T.modes, count > 1 ? 1 : 0).setIsFullWidth();
    gMode.addStaticText('', T.selectionInfo(count)).setIsFullWidth();

    const gSplit = col.addGroup(T.splitGroup);
    const splitBy = gSplit.addButtonSet(T.splitBy, T.splitByItems, 0).setIsFullWidth();
    gSplit.addStaticText('', T.splitByHelp).setIsFullWidth();
    const output = gSplit.addComboBox(T.output, T.outputItems, OUTPUT_SAME);

    const gJoin = col.addGroup(T.joinGroup);
    const order = gJoin.addComboBox(T.order, T.orderItems, ORDER_TOP_DOWN);
    const separator = gJoin.addComboBox(T.separator, T.separatorItems, 0);
    const joinInside = gJoin.addCheckBox(T.joinInside, true).setIsFullWidth();
    const rejoinHyphens = gJoin.addCheckBox(T.rejoinHyphens, true).setIsFullWidth();
    const keepFormatting = gJoin.addCheckBox(T.keepFormatting, true).setIsFullWidth();

    const gCommon = col.addGroup('');
    const keepOriginals = gCommon.addCheckBox(T.keepOriginals, false).setIsFullWidth();

    const refresh = () => {
        const join = modeSet.selectedIndex === 1;
        gSplit.isVisible = !join;
        gJoin.isVisible = join;
    };
    modeSet.onValueChangedHandler = refresh;
    refresh();

    if (!runModalSafe(dlg)) return null;
    return {
        join: modeSet.selectedIndex === 1,
        splitBy: splitBy.selectedIndex,
        output: output.selectedIndex,
        order: order.selectedIndex,
        separator: separator.selectedIndex,
        joinInside: joinInside.value,
        rejoinHyphens: rejoinHyphens.value,
        keepFormatting: keepFormatting.value,
        keepOriginals: keepOriginals.value,
    };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function run(doc, nodes, options) {
    if (options.join) {
        const r = joinNodes(doc, nodes, options);
        return r.pieces ? T.joinDone(r.pieces, r.nodes) : T.nothingToJoin;
    }
    const r = splitNodes(doc, nodes, options);
    return r.sources ? T.splitDone(r.created, r.sources) : T.nothingToSplit;
}

function main() {
    const doc = Document.current;
    if (!doc) { app.alert(T.noDocument, T.title); return; }

    const { nodes, skipped } = collectTextNodes(doc);
    const notes = [];
    if (skipped.linked) notes.push(T.skippedLinked(skipped.linked));
    if (skipped.rotated) notes.push(T.skippedRotated(skipped.rotated));
    if (!nodes.length) { app.alert([T.noText, ...notes].join('\n\n'), T.title); return; }

    const options = showDialog(nodes.length);
    if (!options) return;

    let message;
    try {
        message = run(doc, nodes, options);
        if (message !== T.nothingToSplit && message !== T.nothingToJoin) message += '\n\n' + T.undoHint;
    } catch (e) {
        doc.clearPreviews();
        message = T.error(e && e.message ? e.message : String(e));
    }
    app.alert([message, ...notes].join('\n\n'), T.title);
}

main();
