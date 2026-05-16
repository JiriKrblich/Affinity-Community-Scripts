/**
 * Name: Arabic RTL Pro
 * Description: Converts selected Arabic text into visual RTL text for Affinity, with lam-alef shaping, right alignment, optional tatweel removal, harakat ordering, and precise global plus individual harakat size and X/Y offset controls.
 * Version: 1.1
 * Author: Dimas Nirwan
 */

'use strict';

const { Document } = require('/document');
const { Selection, TextSelection } = require('/selections');
const { StoryDelta } = require('/storydelta');
const { ParagraphAlignXType } = require('/paragraphatts');
const { Dialog, DialogResult } = require('/dialog');
const { UnitType } = require('/units');
const { GlyphAttDoubleType } = require('/glyphatts');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');

const ARABIC_MARK_MIN = 0x064b;
const ARABIC_MARK_MAX = 0x065f;
const ARABIC_SUPERSCRIPT_ALEF = 0x0670;
const ARABIC_TATWEEL = 0x0640;
const OFFSET_RESPONSE = 1;

let OPTIONS = {
    markProfile: 0,
    lamAlef: true,
    rightAlign: true,
    refineMarks: false,
    markScale: 100,
    markOffsetX: 0,
    markOffsetY: 0,
    fathahOffsetX: 0,
    fathahOffsetY: 0,
    dhammahOffsetX: 0,
    dhammahOffsetY: 0,
    kasrahOffsetX: 0,
    kasrahOffsetY: 0,
    tanwinOffsetX: 0,
    tanwinOffsetY: 0,
    shaddaOffsetX: 0,
    shaddaOffsetY: 0,
    sukunOffsetX: 0,
    sukunOffsetY: 0,
    arabicOpenType: false,
    stripTatweel: false
};

const LETTERS = {
    0x0621: ['\ufe80', '\ufe80', null, null],
    0x0622: ['\ufe81', '\ufe82', null, null],
    0x0623: ['\ufe83', '\ufe84', null, null],
    0x0624: ['\ufe85', '\ufe86', null, null],
    0x0625: ['\ufe87', '\ufe88', null, null],
    0x0626: ['\ufe89', '\ufe8a', '\ufe8b', '\ufe8c'],
    0x0627: ['\ufe8d', '\ufe8e', null, null],
    0x0628: ['\ufe8f', '\ufe90', '\ufe91', '\ufe92'],
    0x0629: ['\ufe93', '\ufe94', null, null],
    0x062a: ['\ufe95', '\ufe96', '\ufe97', '\ufe98'],
    0x062b: ['\ufe99', '\ufe9a', '\ufe9b', '\ufe9c'],
    0x062c: ['\ufe9d', '\ufe9e', '\ufe9f', '\ufea0'],
    0x062d: ['\ufea1', '\ufea2', '\ufea3', '\ufea4'],
    0x062e: ['\ufea5', '\ufea6', '\ufea7', '\ufea8'],
    0x062f: ['\ufea9', '\ufeaa', null, null],
    0x0630: ['\ufeab', '\ufeac', null, null],
    0x0631: ['\ufead', '\ufeae', null, null],
    0x0632: ['\ufeaf', '\ufeb0', null, null],
    0x0633: ['\ufeb1', '\ufeb2', '\ufeb3', '\ufeb4'],
    0x0634: ['\ufeb5', '\ufeb6', '\ufeb7', '\ufeb8'],
    0x0635: ['\ufeb9', '\ufeba', '\ufebb', '\ufebc'],
    0x0636: ['\ufebd', '\ufebe', '\ufebf', '\ufec0'],
    0x0637: ['\ufec1', '\ufec2', '\ufec3', '\ufec4'],
    0x0638: ['\ufec5', '\ufec6', '\ufec7', '\ufec8'],
    0x0639: ['\ufec9', '\ufeca', '\ufecb', '\ufecc'],
    0x063a: ['\ufecd', '\ufece', '\ufecf', '\ufed0'],
    0x0641: ['\ufed1', '\ufed2', '\ufed3', '\ufed4'],
    0x0642: ['\ufed5', '\ufed6', '\ufed7', '\ufed8'],
    0x0643: ['\ufed9', '\ufeda', '\ufedb', '\ufedc'],
    0x0644: ['\ufedd', '\ufede', '\ufedf', '\ufee0'],
    0x0645: ['\ufee1', '\ufee2', '\ufee3', '\ufee4'],
    0x0646: ['\ufee5', '\ufee6', '\ufee7', '\ufee8'],
    0x0647: ['\ufee9', '\ufeea', '\ufeeb', '\ufeec'],
    0x0648: ['\ufeed', '\ufeee', null, null],
    0x0649: ['\ufeef', '\ufef0', null, null],
    0x064a: ['\ufef1', '\ufef2', '\ufef3', '\ufef4'],
    0x0671: ['\ufb50', '\ufb51', null, null],
    0x067e: ['\ufb56', '\ufb57', '\ufb58', '\ufb59'],
    0x0686: ['\ufb7a', '\ufb7b', '\ufb7c', '\ufb7d'],
    0x0698: ['\ufb8a', '\ufb8b', null, null],
    0x06a9: ['\ufb8e', '\ufb8f', '\ufb90', '\ufb91'],
    0x06af: ['\ufb92', '\ufb93', '\ufb94', '\ufb95'],
    0x06be: ['\ufbaa', '\ufbab', '\ufbac', '\ufbad'],
    0x06c1: ['\ufba6', '\ufba7', '\ufba8', '\ufba9'],
    0x06cc: ['\ufbfc', '\ufbfd', '\ufbfe', '\ufbff'],
    0x06d2: ['\ufbae', '\ufbaf', null, null]
};

const LAM_ALEF = {
    0x0622: ['\ufef5', '\ufef6'],
    0x0623: ['\ufef7', '\ufef8'],
    0x0625: ['\ufef9', '\ufefa'],
    0x0627: ['\ufefb', '\ufefc']
};

function isMark(ch) {
    const code = ch.codePointAt(0);
    return (code >= ARABIC_MARK_MIN && code <= ARABIC_MARK_MAX)
        || code === ARABIC_SUPERSCRIPT_ALEF
        || (code >= 0x0610 && code <= 0x061a)
        || (code >= 0x06d6 && code <= 0x06ed)
        || (code >= 0x08d3 && code <= 0x08ff);
}

function letterInfo(ch) {
    return LETTERS[ch.codePointAt(0)] || null;
}

function joinsBefore(ch) {
    const info = letterInfo(ch);
    return !!(info && info[1]);
}

function joinsAfter(ch) {
    const info = letterInfo(ch);
    return !!(info && info[2]);
}

function nextLetterIndex(chars, index) {
    for (let i = index + 1; i < chars.length; i++) {
        if (!isMark(chars[i])) {
            return i;
        }
    }
    return -1;
}

function nextLetter(chars, index) {
    const idx = nextLetterIndex(chars, index);
    return idx >= 0 ? chars[idx] : '';
}

function previousLetter(chars, index) {
    for (let i = index - 1; i >= 0; i--) {
        if (!isMark(chars[i])) {
            return chars[i];
        }
    }
    return '';
}

function markWeight(ch) {
    const code = ch.codePointAt(0);
    if (OPTIONS.markProfile === 1) {
        switch (code) {
            case 0x064e: return 10;
            case 0x064f: return 11;
            case 0x064b: return 12;
            case 0x064c: return 13;
            case 0x0650: return 14;
            case 0x064d: return 15;
            case 0x0651: return 20;
            case 0x0670: return 25;
            case 0x0652: return 26;
            default: return 50 + code;
        }
    }
    if (OPTIONS.markProfile === 2) {
        switch (code) {
            case 0x0651: return 5;
            case 0x0652: return 10;
            case 0x064e: return 20;
            case 0x064f: return 21;
            case 0x0650: return 22;
            case 0x064b: return 23;
            case 0x064c: return 24;
            case 0x064d: return 25;
            case 0x0670: return 30;
            default: return 50 + code;
        }
    }
    switch (code) {
        case 0x0651: return 10;
        case 0x0670: return 15;
        case 0x064e: return 20;
        case 0x064f: return 21;
        case 0x064b: return 22;
        case 0x064c: return 23;
        case 0x0652: return 24;
        case 0x0650: return 30;
        case 0x064d: return 31;
        default: return 50 + code;
    }
}

function normalizeMarks(marks) {
    return Array.from(marks)
        .map((ch, index) => ({ ch, index }))
        .sort((a, b) => (markWeight(a.ch) - markWeight(b.ch)) || (a.index - b.index))
        .map(item => item.ch)
        .join("");
}

function collectMarks(chars, index) {
    let marks = '';
    let next = index + 1;
    while (next < chars.length && isMark(chars[next])) {
        marks += chars[next];
        next++;
    }
    return { marks: normalizeMarks(marks), next };
}

function shapeArabicLine(line) {
    const chars = Array.from(line);
    const clusters = [];

    for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];

        if (OPTIONS.stripTatweel && ch.codePointAt(0) === ARABIC_TATWEEL) {
            continue;
        }

        if (isMark(ch)) {
            if (clusters.length) {
                clusters[clusters.length - 1] += ch;
            } else {
                clusters.push(ch);
            }
            continue;
        }

        const info = letterInfo(ch);
        if (!info) {
            clusters.push(ch);
            continue;
        }

        const prev = previousLetter(chars, i);
        const nextData = collectMarks(chars, i);
        const nextIndex = nextLetterIndex(chars, nextData.next - 1);
        const next = nextIndex >= 0 ? chars[nextIndex] : "";
        const connectsFromPrev = prev && joinsAfter(prev) && joinsBefore(ch);

        if (OPTIONS.lamAlef && ch.codePointAt(0) === 0x0644 && next && LAM_ALEF[next.codePointAt(0)]) {
            const pair = LAM_ALEF[next.codePointAt(0)];
            const alefData = collectMarks(chars, nextIndex);
            clusters.push(pair[connectsFromPrev ? 1 : 0] + normalizeMarks(nextData.marks + alefData.marks));
            i = alefData.next - 1;
            continue;
        }

        const connectsToNext = next && joinsAfter(ch) && joinsBefore(next);
        let form = info[0];
        if (connectsFromPrev && connectsToNext && info[3]) {
            form = info[3];
        } else if (connectsFromPrev && info[1]) {
            form = info[1];
        } else if (connectsToNext && info[2]) {
            form = info[2];
        }

        clusters.push(form + nextData.marks);
        i = nextData.next - 1;
    }

    return clusters;
}

function isAsciiWord(token) {
    return /^[A-Za-z0-9_.,:%/+()-]+$/.test(token);
}

function reverseForVisualRtl(clusters) {
    const grouped = [];
    for (const cluster of clusters) {
        const prev = grouped[grouped.length - 1];
        if (prev && isAsciiWord(prev) && isAsciiWord(cluster)) {
            grouped[grouped.length - 1] += cluster;
        } else {
            grouped.push(cluster);
        }
    }
    return grouped.reverse().join('');
}

function convertArabicRtl(text) {
    return String(text)
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map(line => reverseForVisualRtl(shapeArabicLine(line)))
        .join('\n');
}

function buildOptionsDialog() {
    const dlg = Dialog.create("Arabic RTL Pro v1.1");
    dlg.initialWidth = 760;

    const col = dlg.addColumn();
    const harakatCol1 = dlg.addColumn();
    const harakatCol2 = dlg.addColumn();
    col.widthProportion = 1;
    harakatCol1.widthProportion = 0.72;
    harakatCol2.widthProportion = 0.72;
    const conversion = col.addGroup("Conversion");
    dlg.markProfile = conversion.addButtonSet("Harakat Order", ["Balanced", "Vowels First", "Compact"], OPTIONS.markProfile);
    dlg.lamAlef = conversion.addSwitch("Lam-alef", OPTIONS.lamAlef);
    dlg.rightAlign = conversion.addSwitch("Align Right", OPTIONS.rightAlign);
    dlg.stripTatweel = conversion.addSwitch("Remove Tatweel", OPTIONS.stripTatweel);
    dlg.arabicOpenType = conversion.addSwitch("Arabic OT tag", OPTIONS.arabicOpenType);

    const refine = col.addGroup("Refine Marks");
    dlg.refineMarks = refine.addSwitch("Enable", OPTIONS.refineMarks);
    dlg.markScale = refine.addButtonSet("Harakat Size", ["100%", "96%", "92%", "88%", "84%"], 0);
    dlg.markOffsetX = refine.addUnitValueEditor("All X", UnitType.Pixel, UnitType.Pixel, OPTIONS.markOffsetX, -40, 40);
    dlg.markOffsetY = refine.addUnitValueEditor("All Y", UnitType.Pixel, UnitType.Pixel, OPTIONS.markOffsetY, -40, 40);
    dlg.markScale.setIsEnabledBy(dlg.refineMarks);
    dlg.markOffsetX.setIsEnabledBy(dlg.refineMarks);
    dlg.markOffsetY.setIsEnabledBy(dlg.refineMarks);

    const category1 = harakatCol1.addGroup("Harakat Offsets");
    dlg.fathahOffsetX = category1.addUnitValueEditor("Fatha X", UnitType.Pixel, UnitType.Pixel, OPTIONS.fathahOffsetX, -40, 40);
    dlg.fathahOffsetY = category1.addUnitValueEditor("Fatha Y", UnitType.Pixel, UnitType.Pixel, OPTIONS.fathahOffsetY, -40, 40);
    dlg.dhammahOffsetX = category1.addUnitValueEditor("Damma X", UnitType.Pixel, UnitType.Pixel, OPTIONS.dhammahOffsetX, -40, 40);
    dlg.dhammahOffsetY = category1.addUnitValueEditor("Damma Y", UnitType.Pixel, UnitType.Pixel, OPTIONS.dhammahOffsetY, -40, 40);
    dlg.kasrahOffsetX = category1.addUnitValueEditor("Kasra X", UnitType.Pixel, UnitType.Pixel, OPTIONS.kasrahOffsetX, -40, 40);
    dlg.kasrahOffsetY = category1.addUnitValueEditor("Kasra Y", UnitType.Pixel, UnitType.Pixel, OPTIONS.kasrahOffsetY, -40, 40);

    const category2 = harakatCol2.addGroup("");
    dlg.sukunOffsetX = category2.addUnitValueEditor("Sukun X", UnitType.Pixel, UnitType.Pixel, OPTIONS.sukunOffsetX, -40, 40);
    dlg.sukunOffsetY = category2.addUnitValueEditor("Sukun Y", UnitType.Pixel, UnitType.Pixel, OPTIONS.sukunOffsetY, -40, 40);
    dlg.shaddaOffsetX = category2.addUnitValueEditor("Shadda X", UnitType.Pixel, UnitType.Pixel, OPTIONS.shaddaOffsetX, -40, 40);
    dlg.shaddaOffsetY = category2.addUnitValueEditor("Shadda Y", UnitType.Pixel, UnitType.Pixel, OPTIONS.shaddaOffsetY, -40, 40);
    dlg.tanwinOffsetX = category2.addUnitValueEditor("Tanween X", UnitType.Pixel, UnitType.Pixel, OPTIONS.tanwinOffsetX, -40, 40);
    dlg.tanwinOffsetY = category2.addUnitValueEditor("Tanween Y", UnitType.Pixel, UnitType.Pixel, OPTIONS.tanwinOffsetY, -40, 40);

    dlg.fathahOffsetX.setIsEnabledBy(dlg.refineMarks);
    dlg.fathahOffsetY.setIsEnabledBy(dlg.refineMarks);
    dlg.dhammahOffsetX.setIsEnabledBy(dlg.refineMarks);
    dlg.dhammahOffsetY.setIsEnabledBy(dlg.refineMarks);
    dlg.kasrahOffsetX.setIsEnabledBy(dlg.refineMarks);
    dlg.kasrahOffsetY.setIsEnabledBy(dlg.refineMarks);
    dlg.tanwinOffsetX.setIsEnabledBy(dlg.refineMarks);
    dlg.tanwinOffsetY.setIsEnabledBy(dlg.refineMarks);
    dlg.sukunOffsetX.setIsEnabledBy(dlg.refineMarks);
    dlg.sukunOffsetY.setIsEnabledBy(dlg.refineMarks);
    dlg.shaddaOffsetX.setIsEnabledBy(dlg.refineMarks);
    dlg.shaddaOffsetY.setIsEnabledBy(dlg.refineMarks);

    return dlg;
}

function readOptionsFromDialog() {
    const dlg = buildOptionsDialog();
    if (!dlg.runModal().equals(DialogResult.Ok)) {
        return false;
    }

    const markScales = [100, 96, 92, 88, 84];
    OPTIONS = {
        markProfile: dlg.markProfile.selectedIndex,
        lamAlef: dlg.lamAlef.value,
        rightAlign: dlg.rightAlign.value,
        refineMarks: dlg.refineMarks.value,
        markScale: markScales[dlg.markScale.selectedIndex] || 100,
        markOffsetX: dlg.markOffsetX.value,
        markOffsetY: dlg.markOffsetY.value,
        fathahOffsetX: dlg.fathahOffsetX.value,
        fathahOffsetY: dlg.fathahOffsetY.value,
        dhammahOffsetX: dlg.dhammahOffsetX.value,
        dhammahOffsetY: dlg.dhammahOffsetY.value,
        kasrahOffsetX: dlg.kasrahOffsetX.value,
        kasrahOffsetY: dlg.kasrahOffsetY.value,
        tanwinOffsetX: dlg.tanwinOffsetX.value,
        tanwinOffsetY: dlg.tanwinOffsetY.value,
        shaddaOffsetX: dlg.shaddaOffsetX.value,
        shaddaOffsetY: dlg.shaddaOffsetY.value,
        sukunOffsetX: dlg.sukunOffsetX.value,
        sukunOffsetY: dlg.sukunOffsetY.value,
        arabicOpenType: dlg.arabicOpenType.value,
        stripTatweel: dlg.stripTatweel.value
    };
    return true;
}

function isTanwinMark(ch) {
    const code = ch.codePointAt(0);
    return code === 0x064b || code === 0x064c || code === 0x064d;
}

function isFathahMark(ch) {
    const code = ch.codePointAt(0);
    return code === 0x064e || code === 0x0670;
}

function isDhammahMark(ch) {
    return ch.codePointAt(0) === 0x064f;
}

function isKasrahMark(ch) {
    return ch.codePointAt(0) === 0x0650;
}

function isShaddahMark(ch) {
    return ch.codePointAt(0) === 0x0651;
}

function isSukunMark(ch) {
    return ch.codePointAt(0) === 0x0652;
}

function categoryOffsetX(ch) {
    let value = OPTIONS.markOffsetX;
    if (isFathahMark(ch)) value += OPTIONS.fathahOffsetX;
    if (isDhammahMark(ch)) value += OPTIONS.dhammahOffsetX;
    if (isKasrahMark(ch)) value += OPTIONS.kasrahOffsetX;
    if (isTanwinMark(ch)) value += OPTIONS.tanwinOffsetX;
    if (isShaddahMark(ch)) value += OPTIONS.shaddaOffsetX;
    if (isSukunMark(ch)) value += OPTIONS.sukunOffsetX;
    return value;
}

function categoryOffsetY(ch) {
    let value = OPTIONS.markOffsetY;
    if (isFathahMark(ch)) value += OPTIONS.fathahOffsetY;
    if (isDhammahMark(ch)) value += OPTIONS.dhammahOffsetY;
    if (isKasrahMark(ch)) value += OPTIONS.kasrahOffsetY;
    if (isTanwinMark(ch)) value += OPTIONS.tanwinOffsetY;
    if (isShaddahMark(ch)) value += OPTIONS.shaddaOffsetY;
    if (isSukunMark(ch)) value += OPTIONS.sukunOffsetY;
    return value;
}

function applyOffsetX(value) {
    return -value * OFFSET_RESPONSE;
}

function applyOffsetY(value) {
    return -value * OFFSET_RESPONSE;
}

function selectedTextNodes(doc) {
    const nodes = [];
    for (const node of doc.selection.nodes) {
        if (node && node.isTextNode) {
            nodes.push(node);
        }
    }
    return nodes;
}

function textRangeSelection(doc, node, begin, end) {
    const selection = Selection.create(doc, node, true);
    const textSelection = TextSelection.create([{ begin, end }]);
    selection.addSubSelectionForNode(node, textSelection);
    return selection;
}

function addFormatTextRangeCommand(builder, doc, node, begin, end, delta) {
    builder.addCommand(DocumentCommand.createFormatText(textRangeSelection(doc, node, begin, end), delta));
}

function currentGlyphDouble(node, begin, key) {
    try {
        return node.story.getGlyphAtts(begin).getDoubleValue(key) || 0;
    } catch (error) {
        return 0;
    }
}

function addRefineMarkCommands(builder, doc, node, text) {
    if (!OPTIONS.refineMarks) {
        return;
    }

    const scale = OPTIONS.markScale / 100;
    const range = node.storyRange;
    for (let i = 0; i < text.length; i++) {
        if (isMark(text[i])) {
            const begin = range.begin + i;
            const end = begin + 1;
            if (OPTIONS.markScale !== 100) {
                addFormatTextRangeCommand(builder, doc, node, begin, end, StoryDelta.createGlyphDouble(GlyphAttDoubleType.ScaleX, scale));
                addFormatTextRangeCommand(builder, doc, node, begin, end, StoryDelta.createGlyphDouble(GlyphAttDoubleType.ScaleY, scale));
            }
            const rawOffsetX = categoryOffsetX(text[i]);
            const rawOffsetY = categoryOffsetY(text[i]);
            if (rawOffsetX !== 0) {
                const nextOffsetX = currentGlyphDouble(node, begin, GlyphAttDoubleType.OffsetX) + applyOffsetX(rawOffsetX);
                addFormatTextRangeCommand(builder, doc, node, begin, end, StoryDelta.createGlyphDouble(GlyphAttDoubleType.OffsetX, nextOffsetX));
            }
            if (rawOffsetY !== 0) {
                const nextOffsetY = currentGlyphDouble(node, begin, GlyphAttDoubleType.OffsetY) + applyOffsetY(rawOffsetY);
                addFormatTextRangeCommand(builder, doc, node, begin, end, StoryDelta.createGlyphDouble(GlyphAttDoubleType.OffsetY, nextOffsetY));
            }
        }
    }
}

function addArabicOpenTypeCommands(builder, selection) {
    if (!OPTIONS.arabicOpenType) {
        return;
    }
    builder.addCommand(DocumentCommand.createFormatText(selection, StoryDelta.createOpenTypeScriptTag(0x61726162)));
    builder.addCommand(DocumentCommand.createFormatText(selection, StoryDelta.createOpenTypeLanguageTag(0x41524120)));
}

function addSetNodeTextCommands(builder, doc, node, text) {
    const range = node.storyRange;
    const selection = textRangeSelection(doc, node, range.begin, range.end);
    builder.addCommand(DocumentCommand.createSetText(selection, text), true);
    if (OPTIONS.rightAlign) {
        builder.addCommand(DocumentCommand.createFormatText(selection, StoryDelta.createAlignX(ParagraphAlignXType.Right)));
    }
    addArabicOpenTypeCommands(builder, selection);
    addRefineMarkCommands(builder, doc, node, text);
}

function addRefineExistingCommands(builder, doc, node, text) {
    const selection = Selection.create(doc, node, true);
    if (OPTIONS.rightAlign) {
        builder.addCommand(DocumentCommand.createFormatText(selection, StoryDelta.createAlignX(ParagraphAlignXType.Right)), true);
    }
    addArabicOpenTypeCommands(builder, selection);
    addRefineMarkCommands(builder, doc, node, text);
}

function isAlreadyVisualArabic(text) {
    return /[\ufb50-\ufdff\ufe70-\ufeff]/.test(text);
}

function main() {
    const doc = Document.current;
    if (!doc) {
        alert('Open a document first.');
        return;
    }

    const nodes = selectedTextNodes(doc);
    if (!nodes.length) {
        alert('Select one or more text objects first.');
        return;
    }

    if (!readOptionsFromDialog()) {
        return;
    }

    const builder = CompoundCommandBuilder.create();
    let changed = 0;
    let skipped = 0;
    for (const node of nodes) {
        const original = node.text;
        if (isAlreadyVisualArabic(original)) {
            if (OPTIONS.rightAlign || OPTIONS.refineMarks) {
                addRefineExistingCommands(builder, doc, node, original);
                changed++;
            } else {
                skipped++;
            }
            continue;
        }
        const converted = convertArabicRtl(original);
        if (converted !== original) {
            addSetNodeTextCommands(builder, doc, node, converted);
            changed++;
        }
    }

    if (changed) {
        doc.executeCommand(builder.createCommand());
    } else {
        alert(skipped ? 'Selected text already looks converted.' : 'No Arabic text needed conversion.');
    }
}

main();
