/**
 * name: Data Merge Tag Formatter
 * category: Text Formatting
 * author: wunditta
 * description: Formats all text in a document between tags with associated text styles. Especially useful for documents generated with Data Merge.
 * compatibility: Affinity Suite 3.2
 * version: 1.00.001 (13.09.2026)
 */

/*------------------------------------------------------------
V1.00.001
Assigns text styles to text between tag pairs, formatted as markup <tag>...</tag> or markdown **...**. The main use case is to format a document after generating it with Data Merge. Any found markup syntax is being processed. For markdown, you can specify, which characters (and how often repeated) should be interpreted as such (e.g. markdown characters "*#" from 2 to 3 means all these tags are processed: **, ***, ##, ###).

Formatting of markup and markdown tags is done in two ways:
(a) Assigned: You explicitly associate tags with text styles, which are strictly applied to text, and
(b) Automatically: The first text style matching either "tag", "tag=foobar", or "foobar=tag" will be applied (e.g. text style "Bold=**" would be applied to **...**). IMPORTANT NOTE: Due to script limitations, only text styles USED somewhere in the document can/will be applied like this!

In addition \m and \n can be replaced by line and paragraph breaks (e.g. Data Merge will convert line breaks to paragraph breaks).
You can also specify how a separator line marked as --- should be replaced.
//--------------------------------------------------------------
*/

'use strict';
const { Document } = require('/document.js');
const SelectionsModule = require('/selections.js');
const { DocumentCommand, AddChildNodesCommandBuilder, InsertionMode } = require('/commands.js');
const { StoryDelta } = require('/storydelta.js');
const { GlyphAttStringType, GlyphAttDoubleType, ParagraphAttStringType, StoryIoFormat, GlyphType } = require('affinity:story');
const { app } = require('/application.js');
const { StoryBuilder } = require('/storybuilder.js');
const { GlyphAtts } = require('/glyphatts.js');
const { ParagraphAtts } = require('/paragraphatts.js');
const { FrameTextNodeDefinition } = require('/nodes.js');
const { Rectangle } = require('/geometry.js');
const { Dialog, DialogResult } = require('/dialog.js');
const { TagInterface } = require('/taginterface.js');
const { TagInterfaceApi } = require('affinity:dom');

// ============================================================
// Constants
// ============================================================
const STORAGE_NODE_NAME = "*DON'T DELETE* Data Merge Formatter";
const TAG_DONOTFORMAT = 'DoNotFormat';
const TAG_REPLACEBREAKS = 'ReplaceBreaks';
const TAG_TAGCHARACTERS = 'TagCharacters';
const TAG_REPEATMIN = 'RepeatMin';
const TAG_REPEATMAX = 'RepeatMax';
const TAG_REPLACESEPARATOR = 'ReplaceSeparator';
const TAG_SEPARATORCHARS = 'SeparatorChars';
const TAG_SEPARATORSTYLE = 'SeparatorStyle';
const TAG_RUNMODE = 'RunMode';
const NO_STYLE = '[No Style]';
const MAX_PAIRS = 80;
const PAGE_SIZE = 8;
const PAGE_COUNT = MAX_PAIRS / PAGE_SIZE;
const DEFAULT_TAG_CHARS = '*#~';
const DEFAULT_REPEAT_MIN = 2;
const DEFAULT_REPEAT_MAX = 5;
const DEFAULT_SEPARATOR_CHARS = '\\t ';
const DEFAULT_SEPARATOR_STYLE = 'Separating Line';
const DEFAULT_RUN_MODE = 1;
const DIALOG_WIDTH = 700;
const DEBUG_READ = false;
const STORAGE_FONT_SIZE_PT = 12;

function ptToDpiUnits(doc, pt) {
    return pt * doc.dpi / 72;
}

// ============================================================
// Node tag helpers
// ============================================================
function getTagInterface(node) {
    const h = TagInterfaceApi.fromNode(node.handle);
    return h ? new TagInterface(h) : null;
}

function getTagValue(node, key, fallback) {
    if (!node) return fallback;
    const iface = getTagInterface(node);
    if (!iface || !iface.hasKey(key)) return fallback;
    const v = iface.getValueForKey(key);
    return (v === null || v === undefined) ? fallback : v;
}

function setTagValue(doc, node, key, value) {
    const sel = SelectionsModule.Selection.create(doc, node);
    doc.executeCommand(DocumentCommand.createSetTagValueForKey(sel, key, value));
}

function hasDoNotFormatTag(node) {
    const iface = getTagInterface(node);
    return !!(iface && iface.hasKey(TAG_DONOTFORMAT) && iface.getValueForKey(TAG_DONOTFORMAT) === 'true');
}

// ============================================================
// Node discovery / naming
// ============================================================
function getNodeName(node) {
    return node.description;
}

function setNodeName(doc, node, name) {
    doc.setLayerDescription(name, node);
}

function findStorageNode(doc) {
    for (const n of doc.layers.all.toArray()) {
        if (getNodeName(n) === STORAGE_NODE_NAME) return n;
    }
    return null;
}

// ============================================================
// Storage node creation / deletion.
// ============================================================
function ensureCurrentSpread(doc, spread) {
    if (!doc.currentSpread || !doc.currentSpread.isSameNode(spread)) {
        doc.executeCommand(DocumentCommand.createSetCurrentSpread(spread));
    }
}

function ensureSpreadForNode(doc, node) {
    const nodeSpread = node.spread;
    if (nodeSpread) ensureCurrentSpread(doc, nodeSpread);
}

function deleteStorageNodeIfExists(doc) {
    const node = findStorageNode(doc);
    if (!node) return;
    ensureSpreadForNode(doc, node);
    const sel = SelectionsModule.Selection.create(doc, node);
    doc.executeCommand(DocumentCommand.createDeleteSelection(sel, true));
}

function createStorageNode(doc, storyBuilder) {
    const spread = doc.spreads.at(0);
    ensureCurrentSpread(doc, spread);

    const box = spread.baseBoxInterface.baseBox;
    const rect = new Rectangle(box.x, box.y, box.width, box.height);

    const def = FrameTextNodeDefinition.createFromStoryBuilder(rect, storyBuilder);

    const builder = AddChildNodesCommandBuilder.create();
    builder.addNode(def);

    const existingLayers = spread.layers;
    if (existingLayers && existingLayers.length > 0) {
        builder.setInsertionTarget(existingLayers.at(0));
        builder.setInsertionMode(InsertionMode.Behind);
    }

    const cmd = builder.createCommand();
    doc.executeCommand(cmd);
    const node = cmd.newNodes[0];

    setNodeName(doc, node, STORAGE_NODE_NAME);
    const sel = SelectionsModule.Selection.create(doc, node);
    doc.executeCommand(DocumentCommand.createSetVisibility(sel, false));
    doc.executeCommand(DocumentCommand.createSetTagValueForKey(sel, TAG_DONOTFORMAT, 'true'));

    return node;
}

// ============================================================
// Shared de-duplication
// ============================================================
function dedupeByTagLatestWins(pairsList) {
    const map = new Map();
    for (const p of pairsList) {
        if (p.tag.length > 0 && p.style.length > 0) map.set(p.tag, p.style);
    }
    return [...map.entries()].map(([tag, style]) => ({ tag, style }));
}

function sortPairsByTag(pairsList) {
    return pairsList.slice().sort((a, b) => {
        if (a.tag < b.tag) return -1;
        if (a.tag > b.tag) return 1;
        return 0;
    });
}

// ============================================================
// Reading the pairing list out of the storage node.
// ============================================================
function getRawText(node) {
    return node.getText(0, -1, StoryIoFormat.Raw);
}

function styleAtPosition(story, pos) {
    try {
        const g = story.getGlyphAtts(pos);
        if (g && g.styleName) return { type: 'character', name: g.styleName };
    } catch (e) { /* fall through to paragraph style */ }
    try {
        const p = story.getParagraphAtts(pos);
        if (p && p.styleName) return { type: 'paragraph', name: p.styleName };
    } catch (e) { /* no style resolvable at this position */ }
    return null;
}

function readPairsFromStorageNode(node) {
    const raw = [];
    if (!node || node.story.length === 0) return raw;
    const story = node.story;
    for (const range of story.paragraphRanges) {
        const length = range.end - range.begin;
        let text = node.getText(range.begin, length, StoryIoFormat.Raw);
        text = text.replace(/[\r\n\u2028]+$/, '');
        if (text.length > 0) {
            const info = styleAtPosition(story, range.begin);
            if (DEBUG_READ) console.log('raw pair', JSON.stringify(text), info);
            if (info) raw.push({ tag: text, style: info.name, type: info.type });
        }
    }
    return raw;
}

// ============================================================
// Building the storage node's story.
// ============================================================
function freshGlyphAtts(doc, styleName) {
    const atts = GlyphAtts.create();
    atts.styleName = styleName;
    atts.height = ptToDpiUnits(doc, STORAGE_FONT_SIZE_PT);
    return atts;
}

function freshParagraphAtts(styleName) {
    const atts = ParagraphAtts.create();
    atts.styleName = styleName;
    return atts;
}

function buildPairsStoryBuilder(doc, pairs) {
    const sb = StoryBuilder.create();
    sb.setToFrameTextDefaultStyle(doc.dpi, doc.rasterFormat);
    if (pairs.length === 0) {
        sb.addText('');
        return sb;
    }
    for (let i = 0; i < pairs.length; i++) {
        const p = pairs[i];
        if (p.type === 'character') {
            sb.setParagraphAtts(freshParagraphAtts(''));
            sb.setGlyphAtts(freshGlyphAtts(doc, p.style));
        } else {
            sb.setParagraphAtts(freshParagraphAtts(p.style));
            sb.setGlyphAtts(freshGlyphAtts(doc, ''));
        }
        sb.addText(p.tag);
        if (i < pairs.length - 1) sb.addParagraphBreak();
    }
    return sb;
}

function saveStorageNode(doc, paraPairs, charPairs, replaceBreaks, tagChars, runMode, repeatMin, repeatMax, replaceSeparator, separatorChars, separatorStyle) {
    deleteStorageNodeIfExists(doc);
    const combined = [
        ...paraPairs.map(p => ({ tag: p.tag, style: p.style, type: 'paragraph' })),
        ...charPairs.map(p => ({ tag: p.tag, style: p.style, type: 'character' }))
    ];
    const sb = buildPairsStoryBuilder(doc, combined);
    const node = createStorageNode(doc, sb);
    setTagValue(doc, node, TAG_REPLACEBREAKS, replaceBreaks ? 'true' : 'false');
    setTagValue(doc, node, TAG_TAGCHARACTERS, tagChars);
    setTagValue(doc, node, TAG_RUNMODE, String(runMode));
    setTagValue(doc, node, TAG_REPEATMIN, String(repeatMin));
    setTagValue(doc, node, TAG_REPEATMAX, String(repeatMax));
    setTagValue(doc, node, TAG_REPLACESEPARATOR, replaceSeparator ? 'true' : 'false');
    setTagValue(doc, node, TAG_SEPARATORCHARS, separatorChars);
    setTagValue(doc, node, TAG_SEPARATORSTYLE, separatorStyle);
}

// ============================================================
// Style collection.
// ============================================================
function getAllTextNodes(doc) {
    return doc.layers.all.toArray().filter(n => n.isFrameTextNode || n.isArtTextNode);
}

function collectKnownStyles(textNodes) {
    const paraStyles = new Set();
    const charStyles = new Set();
    for (const n of textNodes) {
        const story = n.story;
        if (story.length === 0) continue;
        for (const run of story.paragraphAttRuns) {
            const name = run.paragraphAtts.styleName;
            if (name && name !== NO_STYLE) paraStyles.add(name);
        }
        for (const run of story.glyphAttRuns) {
            const name = run.glyphAtts.styleName;
            if (name && name !== NO_STYLE) charStyles.add(name);
        }
    }
    return { paraStyles, charStyles };
}

function buildSuffixMap(styleSet) {
    const map = new Map();
    for (const name of styleSet) {
        const idx = name.indexOf('=');
        if (idx >= 0) {
            const suffix = name.slice(idx + 1).trim();
            if (!map.has(suffix)) map.set(suffix, name);
        }
    }
    return map;
}

function buildPrefixMap(styleSet) {
    const map = new Map();
    for (const name of styleSet) {
        const idx = name.indexOf('=');
        if (idx >= 0) {
            const prefix = name.slice(0, idx).trim();
            if (!map.has(prefix)) map.set(prefix, name);
        }
    }
    return map;
}

function makeAutoResolver(paraStyles, charStyles) {
    const paraSuffixMap = buildSuffixMap(paraStyles);
    const charSuffixMap = buildSuffixMap(charStyles);
    const paraPrefixMap = buildPrefixMap(paraStyles);
    const charPrefixMap = buildPrefixMap(charStyles);
    return function resolveAuto(tagName) {
        if (paraStyles.has(tagName)) return { type: 'paragraph', name: tagName };
        if (charStyles.has(tagName)) return { type: 'character', name: tagName };
        if (paraSuffixMap.has(tagName)) return { type: 'paragraph', name: paraSuffixMap.get(tagName) };
        if (charSuffixMap.has(tagName)) return { type: 'character', name: charSuffixMap.get(tagName) };
        if (paraPrefixMap.has(tagName)) return { type: 'paragraph', name: paraPrefixMap.get(tagName) };
        if (charPrefixMap.has(tagName)) return { type: 'character', name: charPrefixMap.get(tagName) };
        return null;
    };
}

function makeResolver(paraStyles, charStyles, manualParaPairs, manualCharPairs, runMode) {
    const auto = makeAutoResolver(paraStyles, charStyles);
    return function resolveStyle(tagName) {
        if (manualCharPairs.has(tagName)) {
            return { type: 'character', name: manualCharPairs.get(tagName) };
        }
        if (manualParaPairs.has(tagName)) {
            return { type: 'paragraph', name: manualParaPairs.get(tagName) };
        }
        if (runMode === 3) return null;
        const autoMatch = auto(tagName);
        if (autoMatch) return autoMatch;
        if (runMode === 2) {
            return { type: 'character', name: tagName };
        }
        return null;
    };
}

// ============================================================
// Report
// ============================================================
function createReport() {
    const found = new Map();
    const notFound = new Set();
    return {
        record(tagDisplay, styleType, styleName) {
            const key = tagDisplay + '|' + styleType + '|' + styleName;
            if (!found.has(key)) found.set(key, { tagDisplay, styleType, styleName, count: 0 });
            found.get(key).count++;
        },
        recordNotFound(tagDisplay) { notFound.add(tagDisplay); },
        buildMessage() {
            const lines = [];
            if (found.size === 0) {
                lines.push('No tags were replaced.');
            } else {
                for (const { tagDisplay, styleType, styleName, count } of found.values()) {
                    lines.push('"' + tagDisplay + '" -> ' + styleType + ' style "' + styleName + '" (x' + count + ')');
                }
            }
            if (notFound.size > 0) {
                lines.push('');
                lines.push('No matching style found for: ' + [...notFound].join(', '));
            }
            return lines.join('\n');
        }
    };
}

// ============================================================
// Position mapping
// ============================================================
function buildRawToStoryPositionMap(story) {
    const map = [];
    for (let pos = 0; pos < story.length; pos++) {
        const t = story.getGlyphType(pos);
        if (t.equals(GlyphType.Char)) {
            map.push(pos);
        }
    }
    return map;
}

function rawBeginToStoryPos(map, rawIndex) {
    if (rawIndex < map.length) return map[rawIndex];
    if (map.length === 0) return 0;
    return map[map.length - 1] + 1;
}

function rawEndToStoryPos(map, rawEnd) {
    if (rawEnd <= 0) {
        return map.length > 0 ? map[0] : 0;
    }
    if (rawEnd - 1 < map.length) return map[rawEnd - 1] + 1;
    if (map.length === 0) return 0;
    return map[map.length - 1] + 1;
}

// ============================================================
// Formatting passes
// ============================================================
function buildResetDeltas() {
    return [
        StoryDelta.createWeight(400),
        StoryDelta.createItalic(false),
        StoryDelta.createSuperSubType(0),
        StoryDelta.createCapsType(0),
        StoryDelta.createGlyphDouble(GlyphAttDoubleType.CharacterSpacing, 0),
        StoryDelta.createGlyphDouble(GlyphAttDoubleType.OffsetX, 0),
        StoryDelta.createGlyphDouble(GlyphAttDoubleType.OffsetY, 0),
        StoryDelta.createGlyphDouble(GlyphAttDoubleType.ScaleX, 1),
        StoryDelta.createGlyphDouble(GlyphAttDoubleType.ScaleY, 1),
        StoryDelta.createGlyphDouble(GlyphAttDoubleType.ShearX, 0)
    ];
}

function makeRangeSelection(doc, node, start, end) {
    const sel = SelectionsModule.Selection.create(doc, node);
    sel.addSubSelectionForNode(node, SelectionsModule.TextSelection.create({ begin: start, end: end }));
    return sel;
}

function applyStyleToRange(doc, node, start, end, styleType, styleName) {
    doc.executeCommand(DocumentCommand.createFormatText(
        makeRangeSelection(doc, node, start, end),
        StoryDelta.createComposite(buildResetDeltas())
    ));
    const styleDelta = styleType === 'paragraph'
        ? StoryDelta.createParagraphString(ParagraphAttStringType.StyleName, styleName)
        : StoryDelta.createGlyphString(GlyphAttStringType.StyleName, styleName);
    doc.executeCommand(DocumentCommand.createFormatText(
        makeRangeSelection(doc, node, start, end),
        styleDelta
    ));
}

function applyStyle(doc, node, start, end, styleType, styleName) {
    applyStyleToRange(doc, node, start, end, styleType, styleName);
}

function ensureSpread(doc, node) {
    const nodeSpread = node.spread;
    if (nodeSpread && !doc.currentSpread.isSameNode(nodeSpread)) {
        doc.executeCommand(DocumentCommand.createSetCurrentSpread(nodeSpread));
    }
}

function replaceRange(doc, node, start, end, newText) {
    const sel = SelectionsModule.Selection.create(doc, node);
    sel.addSubSelectionForNode(node, SelectionsModule.TextSelection.create({ begin: start, end: end }));
    doc.executeCommand(DocumentCommand.createSetText(sel, newText));
}

function processBreaks(doc, node) {
    while (true) {
        const text = getRawText(node);
        const mIdx = text.indexOf('\\m');
        const nIdx = text.indexOf('\\n');
        if (mIdx === -1 && nIdx === -1) break;
        let idx, repl;
        if (mIdx !== -1 && (nIdx === -1 || mIdx < nIdx)) { idx = mIdx; repl = '\u2028'; }
        else { idx = nIdx; repl = '\r'; }
        const map = buildRawToStoryPositionMap(node.story);
        const storyStart = rawBeginToStoryPos(map, idx);
        const storyEnd = rawEndToStoryPos(map, idx + 2);
        replaceRange(doc, node, storyStart, storyEnd, repl);
    }
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findSpecialRun(text, ch, n, fromIndex) {
    const e = escapeRegExp(ch);
    const re = new RegExp('(?<!' + e + ')' + e + '{' + n + '}(?!' + e + ')');
    const sub = fromIndex ? text.slice(fromIndex) : text;
    const m = re.exec(sub);
    return m ? m.index + (fromIndex || 0) : -1;
}

function processSpecialTags(doc, node, tagChars, repeatMin, repeatMax, resolveFn, report) {
    for (const ch of tagChars) {
        for (let n = repeatMax; n >= repeatMin; n--) {
            while (true) {
                const text = getRawText(node);
                const openIdx = findSpecialRun(text, ch, n, 0);
                if (openIdx === -1) break;
                const closeIdx = findSpecialRun(text, ch, n, openIdx + n);
                if (closeIdx === -1) break;
                const tagName = ch.repeat(n);
                const styleMatch = resolveFn(tagName);
                if (styleMatch) {
                    const map = buildRawToStoryPositionMap(node.story);
                    const openStart = rawBeginToStoryPos(map, openIdx);
                    const openEnd = rawEndToStoryPos(map, openIdx + n);
                    const closeStart = rawBeginToStoryPos(map, closeIdx);
                    const closeEnd = rawEndToStoryPos(map, closeIdx + n);
                    replaceRange(doc, node, closeStart, closeEnd, '');
                    applyStyle(doc, node, openEnd, closeStart, styleMatch.type, styleMatch.name);
                    replaceRange(doc, node, openStart, openEnd, '');
                    report.record(tagName, styleMatch.type, styleMatch.name);
                } else {
                    report.recordNotFound(tagName);
                    break;
                }
            }
        }
    }
}

function processAngleTags(doc, node, resolveFn, report) {
    let searchFrom = 0;
    while (true) {
        const text = getRawText(node);
        const re = /<([^<>]+)>/g;
        re.lastIndex = searchFrom;
        const openMatch = re.exec(text);
        if (!openMatch) break;
        const tagName = openMatch[1].trim();
        const openStart = openMatch.index;
        const openEnd = openStart + openMatch[0].length;
        const closeTag = '</' + openMatch[1] + '>';
        const closeStart = text.indexOf(closeTag, openEnd);
        if (closeStart === -1) { searchFrom = openEnd; continue; }
        const closeEnd = closeStart + closeTag.length;
        const styleMatch = resolveFn(tagName);
        if (styleMatch) {
            const map = buildRawToStoryPositionMap(node.story);
            const sOpenStart = rawBeginToStoryPos(map, openStart);
            const sOpenEnd = rawEndToStoryPos(map, openEnd);
            const sCloseStart = rawBeginToStoryPos(map, closeStart);
            const sCloseEnd = rawEndToStoryPos(map, closeEnd);
            replaceRange(doc, node, sCloseStart, sCloseEnd, '');
            applyStyle(doc, node, sOpenEnd, sCloseStart, styleMatch.type, styleMatch.name);
            replaceRange(doc, node, sOpenStart, sOpenEnd, '');
            report.record(tagName, styleMatch.type, styleMatch.name);
            searchFrom = 0;
        } else {
            report.recordNotFound(tagName);
            searchFrom = openEnd;
        }
    }
}

// ============================================================
// Separator (---) replacement.
// ============================================================
function parseSeparatorReplacement(raw) {
    const chars = [];
    const styled = [];
    for (let i = 0; i < raw.length; i++) {
        if (raw[i] === '\\' && i + 1 < raw.length) {
            const c = raw[i + 1];
            if (c === 't') { chars.push('\t'); styled.push(false); i++; continue; }
            if (c === 'm') { chars.push('\u2028'); styled.push(false); i++; continue; }
            if (c === 'n') { chars.push('\r'); styled.push(false); i++; continue; }
        }
        chars.push(raw[i]);
        styled.push(true);
    }
    return { text: chars.join(''), styledMask: styled };
}

function countStylableChars(raw) {
    return parseSeparatorReplacement(raw).styledMask.filter(s => s).length;
}

function processDashes(doc, node, report, separatorChars, separatorStyle) {
    const { text: replacementText, styledMask } = parseSeparatorReplacement(separatorChars);
    while (true) {
        const rawText = getRawText(node);
        const idx = rawText.indexOf('---');
        if (idx === -1) break;
        const map = buildRawToStoryPositionMap(node.story);
        const storyStart = rawBeginToStoryPos(map, idx);
        const storyEnd = rawEndToStoryPos(map, idx + 3);
        replaceRange(doc, node, storyStart, storyEnd, replacementText);
        let i = 0;
        while (i < styledMask.length) {
            if (styledMask[i]) {
                let j = i;
                while (j < styledMask.length && styledMask[j]) j++;
                applyStyle(doc, node, storyStart + i, storyStart + j, 'paragraph', separatorStyle);
                i = j;
            } else {
                i++;
            }
        }
        report.record('---', 'paragraph', separatorStyle);
    }
}

function processNode(doc, node, tagChars, repeatMin, repeatMax, replaceBreaks, replaceSeparator, separatorChars, separatorStyle, resolveFn, report) {
    if (node.story.length === 0) return;
    ensureSpread(doc, node);
    if (replaceBreaks) processBreaks(doc, node);
    processSpecialTags(doc, node, tagChars, repeatMin, repeatMax, resolveFn, report);
    processAngleTags(doc, node, resolveFn, report);
    if (replaceSeparator) processDashes(doc, node, report, separatorChars, separatorStyle);
}

function runFormatter(doc, tagChars, repeatMin, repeatMax, replaceBreaks, replaceSeparator, separatorChars, separatorStyle, manualParaPairs, manualCharPairs, runMode) {
    const allTextNodes = getAllTextNodes(doc);
    const textNodes = allTextNodes.filter(n => !hasDoNotFormatTag(n));
    const { paraStyles, charStyles } = collectKnownStyles(allTextNodes);
    const resolveFn = makeResolver(paraStyles, charStyles, manualParaPairs, manualCharPairs, runMode);
    const report = createReport();
    for (const node of textNodes) {
        processNode(doc, node, tagChars, repeatMin, repeatMax, replaceBreaks, replaceSeparator, separatorChars, separatorStyle, resolveFn, report);
    }
    app.alert(report.buildMessage(), 'Data Merge Formatter - Results');
}

// ============================================================
// Dialog
// ============================================================
const HELP_TEXT =
`Assigns text styles to text between tag pairs, formatted as markup <tag>...</tag> or markdown **...**. The main use case is to format a document after generating it with Data Merge. Any found markup syntax is being processed. For markdown, you can specify, which characters (and how often repeated) should be interpreted as such (e.g. markdown characters "*#" from 2 to 3 means all these tags are processed: **, ***, ##, ###).

Formatting of markup and markdown tags is done in two ways:
(a) Assigned: In the assignment list you can associate tags with text styles. Those tags will strictly be formatted that way (always forced, i.e. even if the text styles do not exist!), and
(b) Automatically: The first text style matching either "tag", "tag=foobar", or "foobar=tag" will be applied (e.g. text style "Bold=**" would be applied to **...**). IMPORTANT NOTE: Due to script limitations, only text styles USED somewhere in the document can/will be applied like this!

Modes:
1) Assigned* & Auto: Runs (a) forced*. Runs (b), but only if a matching style is USED somewhere in the document.
2) Assigned* & Auto*: Runs (a) forced*. Runs (b) forced*, i.e. assigns a character(!) style named like the tag (e.g. <foo>...</foo> or ***...*** will apply character style "foo" or "***" (even if they do not exist).
3) Assigned* only: Runs (a), but not (b).
4) Save only: settings and assignments are saved, but the formatter is not run.

Dialog:
* [Read Styles]: Reads all text styles USED in the document and populates the list (does not overwrite existing).
* Breaks: During Data Merge import (from e.g. an Excel file), the difference between line and paragraph breaks gets lost.
  Use the escaped breaks \\m and \\n for line and paragraph breaks (no need to have spaces before or after, e.g. "old line\\nnew line" would work).
* Separator/Horizontal Line: Specify the string with which --- will be replaced.
  Use \\t for tabulator and \\m and\\n for line/paragraph breaks.
  Since the style needs some real text (e.g. a space) to be applied to, the number of real chars is shown.`;

const REPEAT_INFO_TEXT =
`Any character here, repeated as often as set by the limits (default: 2 to 5), is interpreted as a markdown tag and must be used like **...** (and cannot be used like <**>...</**>). NOTE: In case you assign a text style to a markdown tag in the list assignment, make sure they match the definition here too.`;

const READ_STYLES_INFO_TEXT =
``;

const RUN_MODE_INFO_TEXT =
`Assigned* & Auto: assigned tags are always applied (*forced, even if unused); other tags are matched automatically against styles already used in the document.
Assigned* & Auto*: as before, but tags matching neither are still forced as a character style named after the tag.
Assigned* only: automatic matching is skipped; only assigned tags are applied.
Save only: settings and assignments are saved, but the formatter is not run - the previously saved mode is kept.`;

function addReadOnlyText(group, text, rowSpan, visiblefalse) {
    const box = group.addTextBox('', text);
    box.isEnabled = false;
    if (rowSpan && rowSpan > 1) {
        box.isMultiLine = true;
        box.rowSpan = rowSpan;
        box.isFullWidth = true;
    }
    if (visiblefalse) { box.isVisible = false; }
    return box;
}

function parseIntWithFallback(text, fallback) {
    const n = parseInt((text || '').trim(), 10);
    return Number.isFinite(n) ? n : fallback;
}

function formatCharCountLabel(count) {
    return '(real chars: ' + count + (count === 0 ? ('!!!') : ('')) + ')';
}

function runDialog(doc) {
    const storageNode = findStorageNode(doc);

    const rawPairs = readPairsFromStorageNode(storageNode);
    const initialParaPairs = dedupeByTagLatestWins(rawPairs.filter(p => p.type === 'paragraph'));
    const initialCharPairs = dedupeByTagLatestWins(rawPairs.filter(p => p.type === 'character'));

    const initialReplaceBreaks = getTagValue(storageNode, TAG_REPLACEBREAKS, 'true') === 'true';
    const initialTagChars = getTagValue(storageNode, TAG_TAGCHARACTERS, DEFAULT_TAG_CHARS);
    const initialRepeatMin = getTagValue(storageNode, TAG_REPEATMIN, String(DEFAULT_REPEAT_MIN));
    const initialRepeatMax = getTagValue(storageNode, TAG_REPEATMAX, String(DEFAULT_REPEAT_MAX));
    const initialReplaceSeparator = getTagValue(storageNode, TAG_REPLACESEPARATOR, 'true') === 'true';
    const initialSeparatorChars = getTagValue(storageNode, TAG_SEPARATORCHARS, DEFAULT_SEPARATOR_CHARS);
    const initialSeparatorStyle = getTagValue(storageNode, TAG_SEPARATORSTYLE, DEFAULT_SEPARATOR_STYLE);
    const savedRunMode = parseIntWithFallback(getTagValue(storageNode, TAG_RUNMODE, String(DEFAULT_RUN_MODE)), DEFAULT_RUN_MODE);
    const initialRunMode = (savedRunMode >= 1 && savedRunMode <= 3) ? savedRunMode : DEFAULT_RUN_MODE;

    const paraPairsData = [];
    const charPairsData = [];
    for (let i = 0; i < MAX_PAIRS; i++) {
        paraPairsData.push({ tag: '', style: '' });
        charPairsData.push({ tag: '', style: '' });
    }
    for (let i = 0; i < Math.min(initialParaPairs.length, MAX_PAIRS); i++) paraPairsData[i] = initialParaPairs[i];
    for (let i = 0; i < Math.min(initialCharPairs.length, MAX_PAIRS); i++) charPairsData[i] = initialCharPairs[i];
    let currentPage = 0;

    const dlg = Dialog.create('Data Merge Tag Formatter');
    dlg.initialWidth = DIALOG_WIDTH;
    const col = dlg.addColumn();

    const helpGroup = col.addGroup('');
    const helpBtn = helpGroup.addButton(' Help ');
    helpBtn.setOnClickHandler(function () {
        app.alert(HELP_TEXT, 'Data Merge Tag Formatter - Help');
    });

    const settingsGroup = col.addGroup('Markdown Tag Definition');
    settingsGroup.enableSeparator = false;
    addReadOnlyText(settingsGroup, REPEAT_INFO_TEXT, 2);
    const repeatStack = settingsGroup.addColumnStack();
    const tagCharsCtrl = repeatStack.addColumn().addGroup('').addTextBox('Markdown Chars', initialTagChars);
    const repeatMinCtrl = repeatStack.addColumn().addGroup('').addTextBox('repeated from', initialRepeatMin);
    const repeatMaxCtrl = repeatStack.addColumn().addGroup('').addTextBox('to', initialRepeatMax);
    settingsGroup.addStaticText('', '');

    const listGroup = col.addGroup('Assign Tags to Styles Explicitely');
    listGroup.enableSeparator = false;

    const superStack = listGroup.addColumnStack();
    const paraSuperCol = superStack.addColumn();
    const charSuperCol = superStack.addColumn();
    charSuperCol.enableSeparator = true;

    const paraRowsGroup = paraSuperCol.addGroup('');
    const paraTagCtrls = [];
    const paraStyleCtrls = [];
    for (let i = 0; i < PAGE_SIZE; i++) {
        var col1title = '';
        var col2title = '';
        if (i == 0) { col1title = 'Paragraph Tag'; col2title = 'Paragraph Style'; }
        const rowStack = paraRowsGroup.addColumnStack();
        const tagCtrl = rowStack.addColumn().addGroup(col1title).addTextBox('', '');
        tagCtrl.isFullWidth = true;
        const styleCtrl = rowStack.addColumn().addGroup(col2title).addTextBox('', '');
        styleCtrl.isFullWidth = true;
        paraTagCtrls.push(tagCtrl);
        paraStyleCtrls.push(styleCtrl);
    }

    const charRowsGroup = charSuperCol.addGroup('');
    const charTagCtrls = [];
    const charStyleCtrls = [];
    for (let i = 0; i < PAGE_SIZE; i++) {
        var col1title = '';
        var col2title = '';
        if (i == 0) { col1title = 'Character Tag'; col2title = 'Character Style'; }
        const rowStack = charRowsGroup.addColumnStack();
        const tagCtrl = rowStack.addColumn().addGroup(col1title).addTextBox('', '');
        tagCtrl.isFullWidth = true;
        const styleCtrl = rowStack.addColumn().addGroup(col2title).addTextBox('', '');
        styleCtrl.isFullWidth = true;
        charTagCtrls.push(tagCtrl);
        charStyleCtrls.push(styleCtrl);
    }

    const pageNavStack = listGroup.addColumnStack();
    //addReadOnlyText(pageNavStack.addColumn().addGroup(''), '', 0, true);
    const prevBtn = pageNavStack.addColumn().addGroup('').addButton('< Prev');
    prevBtn.isFullWidth = true;
    const pageLabelCtrl = addReadOnlyText(pageNavStack.addColumn().addGroup(''), 'Page 1 of 5');
    pageLabelCtrl.isFullWidth = true;
    const nextBtn = pageNavStack.addColumn().addGroup('').addButton('Next >');
    nextBtn.isFullWidth = true;
    addReadOnlyText(pageNavStack.addColumn().addGroup(''), '', 0, true);
    const readStylesBtn = pageNavStack.addColumn().addGroup('').addButton('Read Styles');
    readStylesBtn.isFullWidth = true;
    const clearListBtn = pageNavStack.addColumn().addGroup('').addButton('Clear List');
    clearListBtn.isFullWidth = true;

    /*
    const readClearGroup = col.addGroup('');
    readClearGroup.enableSeparator = false;
    const readClearStack = readClearGroup.addColumnStack();
    const readStylesBtn = readClearStack.addColumn().addGroup('').addButton('Read Styles');
    readStylesBtn.isFullWidth = true;
    const clearListBtn = readClearStack.addColumn().addGroup('').addButton('Clear List');
    clearListBtn.isFullWidth = true;
    //const readClearInfoGroup = col.addGroup('');
    addReadOnlyText(readClearGroup, READ_STYLES_INFO_TEXT, 2);
    */

    function updatePageLabel() {
        pageLabelCtrl.text = '       Page ' + (currentPage + 1) + ' of ' + PAGE_COUNT;
    }

    function loadPage(pageIdx) {
        const offset = pageIdx * PAGE_SIZE;
        for (let i = 0; i < PAGE_SIZE; i++) {
            paraTagCtrls[i].text = paraPairsData[offset + i].tag;
            paraStyleCtrls[i].text = paraPairsData[offset + i].style;
            charTagCtrls[i].text = charPairsData[offset + i].tag;
            charStyleCtrls[i].text = charPairsData[offset + i].style;
        }
        currentPage = pageIdx;
        updatePageLabel();
    }

    function savePage() {
        const offset = currentPage * PAGE_SIZE;
        for (let i = 0; i < PAGE_SIZE; i++) {
            paraPairsData[offset + i] = {
                tag: (paraTagCtrls[i].text || '').trim(),
                style: (paraStyleCtrls[i].text || '').trim()
            };
            charPairsData[offset + i] = {
                tag: (charTagCtrls[i].text || '').trim(),
                style: (charStyleCtrls[i].text || '').trim()
            };
        }
    }

    loadPage(0);

    prevBtn.setOnClickHandler(function () {
        savePage();
        if (currentPage > 0) loadPage(currentPage - 1);
    });
    nextBtn.setOnClickHandler(function () {
        savePage();
        if (currentPage < PAGE_COUNT - 1) loadPage(currentPage + 1);
    });

    readStylesBtn.setOnClickHandler(function () {
        savePage();
        const { paraStyles, charStyles } = collectKnownStyles(getAllTextNodes(doc));

        function addMissing(styleSet, dataArr) {
            const existing = new Set();
            for (const p of dataArr) {
                if (p.style.length > 0) existing.add(p.style);
            }
            let nextFree = 0;
            for (const styleName of styleSet) {
                if (existing.has(styleName)) continue;
                while (nextFree < MAX_PAIRS && (dataArr[nextFree].tag.length > 0 || dataArr[nextFree].style.length > 0)) {
                    nextFree++;
                }
                if (nextFree >= MAX_PAIRS) break;
                dataArr[nextFree] = { tag: styleName, style: styleName };
                existing.add(styleName);
                nextFree++;
            }
        }
        addMissing(paraStyles, paraPairsData);
        addMissing(charStyles, charPairsData);
        loadPage(currentPage);
    });

    clearListBtn.setOnClickHandler(function () {
        for (let i = 0; i < MAX_PAIRS; i++) {
            paraPairsData[i] = { tag: '', style: '' };
            charPairsData[i] = { tag: '', style: '' };
        }
        loadPage(currentPage);
    });

    // --- Options: line/paragraph break replacement + separator replacement ---
    const topCheckboxGrp = col.addGroup('Options');
    topCheckboxGrp.enableSeparator = false;
    const replaceBreaksCtrl = topCheckboxGrp.addCheckBox("Replace \\m with line and \\n with paragraph breaks", initialReplaceBreaks);
    replaceBreaksCtrl.isFullWidth = true;

    const separatorRowStack = topCheckboxGrp.addColumnStack();
    const replaceSeparatCtrlCol = separatorRowStack.addColumn();
    replaceSeparatCtrlCol.widthProportion = 3;
    const replaceSeparatCtrl = replaceSeparatCtrlCol.addGroup('').addCheckBox('Replace ---', initialReplaceSeparator);
    replaceSeparatCtrl.isFullWidth = true;
    const separatorCharsCtrlCol = separatorRowStack.addColumn();
    separatorCharsCtrlCol.widthProportion = 7;
    const separatorCharsCtrl = separatorCharsCtrlCol.addGroup('').addTextBox('with (special: \\t \\m \\n)', initialSeparatorChars);
    //separatorCharsCtrl.isFullWidth = true;
    const separatorStyleCtrlTxt = separatorRowStack.addColumn();
    separatorStyleCtrlTxt.widthProportion = 2.5;
    const separatorCharsGroup = separatorStyleCtrlTxt.addGroup('');
    const separatorCharsCountLabel = addReadOnlyText(separatorCharsGroup, formatCharCountLabel(countStylableChars(initialSeparatorChars)));
    separatorCharsCountLabel.isFullWidth = true;
    const separatorStyleCtrlCol = separatorRowStack.addColumn();
    separatorStyleCtrlCol.widthProportion = 6;
    const separatorStyleCtrl = separatorStyleCtrlCol.addGroup('').addTextBox('and apply style', initialSeparatorStyle);

    // Textboxes have no per-control change event, so a dialog-wide
    // handler is used and simply re-reads the current text directly
    // (rather than trusting the callback's own value/identity), which
    // is correct regardless of which control actually triggered it.
    dlg.setOnControlValueChangedHandler(function () {
        separatorCharsCountLabel.text = formatCharCountLabel(countStylableChars(separatorCharsCtrl.text));
    });

    // --- Run mode: four-way mutually-exclusive button set ---
    const runModeGroup = col.addGroup('Run Mode');
    runModeGroup.enableSeparator = true;
    const modeLabels = ['\n1) Assigned* & Auto\n', '\n2) Assigned* & Auto*\n', '\n3) Assigned* only\n', '\n4) Save only\n'];
    const runModeBtnSet = runModeGroup.addButtonSet('', modeLabels);
    runModeBtnSet.isFullWidth = true;
    runModeBtnSet.selectedIndex = initialRunMode - 1;

    //const runModeInfoGroup = col.addGroup('');
    //addReadOnlyText(runModeInfoGroup, RUN_MODE_INFO_TEXT, 3);

    const result = dlg.runModal();
    if (!result || result.value !== DialogResult.Ok.value) {
        return;
    }

    savePage();
    const paraPairs = sortPairsByTag(dedupeByTagLatestWins(paraPairsData));
    const charPairs = sortPairsByTag(dedupeByTagLatestWins(charPairsData));
    const replaceBreaks = replaceBreaksCtrl.value;
    const tagChars = (tagCharsCtrl.text || DEFAULT_TAG_CHARS).trim() || DEFAULT_TAG_CHARS;
    const replaceSeparator = replaceSeparatCtrl.value;
    const separatorChars = separatorCharsCtrl.text || DEFAULT_SEPARATOR_CHARS;
    const separatorStyle = (separatorStyleCtrl.text || DEFAULT_SEPARATOR_STYLE).trim() || DEFAULT_SEPARATOR_STYLE;
    const currentRunMode = runModeBtnSet.selectedIndex + 1;

    let repeatMin = parseIntWithFallback(repeatMinCtrl.text, DEFAULT_REPEAT_MIN);
    let repeatMax = parseIntWithFallback(repeatMaxCtrl.text, DEFAULT_REPEAT_MAX);
    if (repeatMin < 1) repeatMin = 1;
    if (repeatMax < 1) repeatMax = 1;
    if (repeatMin > repeatMax) { const t = repeatMin; repeatMin = repeatMax; repeatMax = t; }

    // Mode 4 ("Save only") never overwrites the previously saved mode -
    // it's a one-off action, not a persisted preference.
    const runModeToSave = (currentRunMode === 4) ? initialRunMode : currentRunMode;

    saveStorageNode(doc, paraPairs, charPairs, replaceBreaks, tagChars, runModeToSave, repeatMin, repeatMax, replaceSeparator, separatorChars, separatorStyle);

    if (currentRunMode !== 4) {
        const manualParaPairs = new Map(paraPairs.map(p => [p.tag, p.style]));
        const manualCharPairs = new Map(charPairs.map(p => [p.tag, p.style]));
        runFormatter(doc, [...tagChars], repeatMin, repeatMax, replaceBreaks, replaceSeparator, separatorChars, separatorStyle, manualParaPairs, manualCharPairs, currentRunMode);
    }
}

// ============================================================
// Entry point
// ============================================================
function main() {
    const doc = Document.current;
    if (!doc) {
        app.alert('No document is open.', 'Data Merge Formatter');
        return;
    }
    runDialog(doc);
}

main();
