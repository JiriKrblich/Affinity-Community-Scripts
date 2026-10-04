/**
 * Name: Universal RTL Fixer Pro
 * Description: Correction RTL visuelle universelle — Arabe/Persan/Ourdou (shaping complet + harakat) · Hébreu (inversion mot par mot) · Syriaque et autres RTL. Aligne à droite en option. Annuler : Ctrl+Z / Cmd+Z.
 * Version: 1.0.0
 * Author: Arabic engine — community (Arabic RTL Pro) · Hébreu + fusion — Kevin Blanchard
 */

'use strict';

const { Document }                          = require('/document');
const { Selection, TextSelection }          = require('/selections');
const { StoryDelta }                        = require('/storydelta');
const { ParagraphAlignXType }               = require('/paragraphatts');
const { Dialog, DialogResult }              = require('/dialog');
const { UnitType }                          = require('/units');
const { GlyphAttDoubleType }                = require('/glyphatts');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');

/* ================================================================
   OPTIONS GLOBALES
================================================================ */

let OPTIONS = {
    /* Langues */
    processArabic  : true,
    processHebrew  : true,
    processOther   : false,
    /* Arabe — shaping */
    markProfile    : 0,
    lamAlef        : true,
    rightAlign     : true,
    stripTatweel   : false,
    arabicOpenType : false,
    /* Arabe — raffinage harakat */
    refineMarks    : false,
    markScale      : 100,
    markOffsetX    : 0,
    markOffsetY    : 0,
    fathahOffsetX  : 0,
    fathahOffsetY  : 0,
    dhammahOffsetX : 0,
    dhammahOffsetY : 0,
    kasrahOffsetX  : 0,
    kasrahOffsetY  : 0,
    tanwinOffsetX  : 0,
    tanwinOffsetY  : 0,
    shaddaOffsetX  : 0,
    shaddaOffsetY  : 0,
    sukunOffsetX   : 0,
    sukunOffsetY   : 0,
};

/* ================================================================
   DÉTECTION DE LANGUE
   Compte les caractères RTL par script et retourne le dominant.
================================================================ */

function isHebrewCode(code) {
    return (code >= 0x0590 && code <= 0x05FF) ||
           (code >= 0xFB1D && code <= 0xFB4F);
}

function isArabicCode(code) {
    return (code >= 0x0600 && code <= 0x06FF) ||   /* Arabe de base + Persan + Ourdou */
           (code >= 0x0750 && code <= 0x077F) ||   /* Supplément arabe                */
           (code >= 0x08A0 && code <= 0x08FF) ||   /* Étendu arabe                    */
           (code >= 0xFB50 && code <= 0xFDFF) ||   /* Présentation A (Persan/Ourdou)  */
           (code >= 0xFE70 && code <= 0xFEFF);     /* Présentation B (formes visuelles)*/
}

function isOtherRTLCode(code) {
    return (code >= 0x0700 && code <= 0x074F) ||   /* Syriaque */
           (code >= 0x0780 && code <= 0x07BF) ||   /* Thaana   */
           (code >= 0x07C0 && code <= 0x07FF);     /* NKo      */
}

function detectLanguage(text) {
    let hebrew = 0, arabic = 0, other = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if      (isHebrewCode(code))   hebrew++;
        else if (isArabicCode(code))   arabic++;
        else if (isOtherRTLCode(code)) other++;
    }
    const total = hebrew + arabic + other;
    if (total === 0) return null;
    if (hebrew >= arabic && hebrew >= other) return 'Hebrew';
    if (arabic >= hebrew && arabic >= other) return 'Arabic';
    return 'Other';
}

/* ================================================================
   MOTEUR ARABE — shaping complet + RTL visuel
   Source : Arabic RTL Pro by Dimas Nirwan (adapté)
   Convertit les caractères Unicode arabes en formes de présentation
   (plage FE70-FEFF) puis inverse l'ordre visuel des clusters.
================================================================ */

const ARABIC_MARK_MIN         = 0x064b;
const ARABIC_MARK_MAX         = 0x065f;
const ARABIC_SUPERSCRIPT_ALEF = 0x0670;
const ARABIC_TATWEEL          = 0x0640;
const OFFSET_RESPONSE         = 1;

/* Formes isolée / finale / initiale / médiane pour chaque lettre */
const LETTERS = {
    0x0621: ['\ufe80', '\ufe80', null,    null   ],
    0x0622: ['\ufe81', '\ufe82', null,    null   ],
    0x0623: ['\ufe83', '\ufe84', null,    null   ],
    0x0624: ['\ufe85', '\ufe86', null,    null   ],
    0x0625: ['\ufe87', '\ufe88', null,    null   ],
    0x0626: ['\ufe89', '\ufe8a', '\ufe8b', '\ufe8c'],
    0x0627: ['\ufe8d', '\ufe8e', null,    null   ],
    0x0628: ['\ufe8f', '\ufe90', '\ufe91', '\ufe92'],
    0x0629: ['\ufe93', '\ufe94', null,    null   ],
    0x062a: ['\ufe95', '\ufe96', '\ufe97', '\ufe98'],
    0x062b: ['\ufe99', '\ufe9a', '\ufe9b', '\ufe9c'],
    0x062c: ['\ufe9d', '\ufe9e', '\ufe9f', '\ufea0'],
    0x062d: ['\ufea1', '\ufea2', '\ufea3', '\ufea4'],
    0x062e: ['\ufea5', '\ufea6', '\ufea7', '\ufea8'],
    0x062f: ['\ufea9', '\ufeaa', null,    null   ],
    0x0630: ['\ufeab', '\ufeac', null,    null   ],
    0x0631: ['\ufead', '\ufeae', null,    null   ],
    0x0632: ['\ufeaf', '\ufeb0', null,    null   ],
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
    0x0648: ['\ufeed', '\ufeee', null,    null   ],
    0x0649: ['\ufeef', '\ufef0', null,    null   ],
    0x064a: ['\ufef1', '\ufef2', '\ufef3', '\ufef4'],
    /* Persan / Ourdou / Dari */
    0x0671: ['\ufb50', '\ufb51', null,    null   ],
    0x067e: ['\ufb56', '\ufb57', '\ufb58', '\ufb59'],  /* پ pe    */
    0x0686: ['\ufb7a', '\ufb7b', '\ufb7c', '\ufb7d'],  /* چ che   */
    0x0698: ['\ufb8a', '\ufb8b', null,    null   ],    /* ژ zhe   */
    0x06a9: ['\ufb8e', '\ufb8f', '\ufb90', '\ufb91'],  /* ک kaf   */
    0x06af: ['\ufb92', '\ufb93', '\ufb94', '\ufb95'],  /* گ gaf   */
    0x06be: ['\ufbaa', '\ufbab', '\ufbac', '\ufbad'],  /* ہ he    */
    0x06c1: ['\ufba6', '\ufba7', '\ufba8', '\ufba9'],  /* ہ he2   */
    0x06cc: ['\ufbfc', '\ufbfd', '\ufbfe', '\ufbff'],  /* ی ye    */
    0x06d2: ['\ufbae', '\ufbaf', null,    null   ],    /* ے ye2   */
};

/* Ligatures lam-alef (formes spéciales isolée / finale) */
const LAM_ALEF = {
    0x0622: ['\ufef5', '\ufef6'],
    0x0623: ['\ufef7', '\ufef8'],
    0x0625: ['\ufef9', '\ufefa'],
    0x0627: ['\ufefb', '\ufefc'],
};

/* ── Helpers arabe ── */

function isArabicMark(ch) {
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
        if (!isArabicMark(chars[i])) return i;
    }
    return -1;
}

function previousLetter(chars, index) {
    for (let i = index - 1; i >= 0; i--) {
        if (!isArabicMark(chars[i])) return chars[i];
    }
    return '';
}

function markWeight(ch) {
    const code = ch.codePointAt(0);
    if (OPTIONS.markProfile === 1) {
        switch (code) {
            case 0x064e: return 10; case 0x064f: return 11;
            case 0x064b: return 12; case 0x064c: return 13;
            case 0x0650: return 14; case 0x064d: return 15;
            case 0x0651: return 20; case 0x0670: return 25;
            case 0x0652: return 26; default: return 50 + code;
        }
    }
    if (OPTIONS.markProfile === 2) {
        switch (code) {
            case 0x0651: return 5;  case 0x0652: return 10;
            case 0x064e: return 20; case 0x064f: return 21;
            case 0x0650: return 22; case 0x064b: return 23;
            case 0x064c: return 24; case 0x064d: return 25;
            case 0x0670: return 30; default: return 50 + code;
        }
    }
    switch (code) {
        case 0x0651: return 10; case 0x0670: return 15;
        case 0x064e: return 20; case 0x064f: return 21;
        case 0x064b: return 22; case 0x064c: return 23;
        case 0x0652: return 24; case 0x0650: return 30;
        case 0x064d: return 31; default: return 50 + code;
    }
}

function normalizeMarks(marks) {
    return Array.from(marks)
        .map((ch, i) => ({ ch, i }))
        .sort((a, b) => (markWeight(a.ch) - markWeight(b.ch)) || (a.i - b.i))
        .map(x => x.ch)
        .join('');
}

function collectMarks(chars, index) {
    let marks = '';
    let next = index + 1;
    while (next < chars.length && isArabicMark(chars[next])) {
        marks += chars[next];
        next++;
    }
    return { marks: normalizeMarks(marks), next };
}

function shapeArabicLine(line) {
    const chars    = Array.from(line);
    const clusters = [];

    for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];

        if (OPTIONS.stripTatweel && ch.codePointAt(0) === ARABIC_TATWEEL) continue;

        if (isArabicMark(ch)) {
            if (clusters.length) clusters[clusters.length - 1] += ch;
            else clusters.push(ch);
            continue;
        }

        const info = letterInfo(ch);
        if (!info) { clusters.push(ch); continue; }

        const prev            = previousLetter(chars, i);
        const nextData        = collectMarks(chars, i);
        const nextIdx         = nextLetterIndex(chars, nextData.next - 1);
        const next            = nextIdx >= 0 ? chars[nextIdx] : '';
        const connectsFromPrev = prev && joinsAfter(prev) && joinsBefore(ch);

        /* Ligature lam-alef */
        if (OPTIONS.lamAlef && ch.codePointAt(0) === 0x0644 && next && LAM_ALEF[next.codePointAt(0)]) {
            const pair     = LAM_ALEF[next.codePointAt(0)];
            const alefData = collectMarks(chars, nextIdx);
            clusters.push(pair[connectsFromPrev ? 1 : 0] + normalizeMarks(nextData.marks + alefData.marks));
            i = alefData.next - 1;
            continue;
        }

        const connectsToNext = next && joinsAfter(ch) && joinsBefore(next);
        let form = info[0];
        if (connectsFromPrev && connectsToNext && info[3]) form = info[3];
        else if (connectsFromPrev && info[1])               form = info[1];
        else if (connectsToNext  && info[2])                form = info[2];

        clusters.push(form + nextData.marks);
        i = nextData.next - 1;
    }

    return clusters;
}

function isAsciiToken(token) {
    return /^[A-Za-z0-9_.,:%/+()-]+$/.test(token);
}

function reverseForVisualRtl(clusters) {
    /* Les tokens ASCII contigus restent groupés dans leur ordre interne */
    const grouped = [];
    for (const cluster of clusters) {
        const prev = grouped[grouped.length - 1];
        if (prev && isAsciiToken(prev) && isAsciiToken(cluster)) {
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

function isAlreadyVisualArabic(text) {
    return /[\ufb50-\ufdff\ufe70-\ufeff]/.test(text);
}

/* ================================================================
   MOTEUR HÉBREU — inversion visuelle mot par mot
   L'hébreu n'a pas de formes connectées comme l'arabe.
   On inverse l'ordre des mots ET l'ordre des caractères dans
   chaque mot hébreu. Les segments LTR (chiffres, latin) gardent
   leur ordre interne mais voient leur position inversée dans la ligne.
================================================================ */

function tokenizeRTLLine(line, isRtlChar) {
    const tokens = [];
    let i = 0;
    while (i < line.length) {
        if (line[i] === ' ' || line[i] === '\t') {
            let s = '';
            while (i < line.length && (line[i] === ' ' || line[i] === '\t')) s += line[i++];
            tokens.push({ text: s, rtl: false, space: true });
        } else if (isRtlChar(line.charCodeAt(i))) {
            let w = '';
            while (i < line.length && isRtlChar(line.charCodeAt(i))) w += line[i++];
            tokens.push({ text: w, rtl: true, space: false });
        } else {
            let l = '';
            while (i < line.length && !isRtlChar(line.charCodeAt(i)) && line[i] !== ' ' && line[i] !== '\t') l += line[i++];
            tokens.push({ text: l, rtl: false, space: false });
        }
    }
    return tokens;
}

function fixRTLLine(line, isRtlChar) {
    if (!line.trim()) return line;

    const tokens = tokenizeRTLLine(line, isRtlChar);
    let leadingSpaces = '', trailingSpaces = '';
    const content = [];

    let s = 0;
    while (s < tokens.length && tokens[s].space) leadingSpaces += tokens[s++].text;
    let e = tokens.length - 1;
    while (e >= s && tokens[e].space) trailingSpaces = tokens[e--].text + trailingSpaces;
    for (let j = s; j <= e; j++) content.push(tokens[j]);

    content.reverse();

    const result = content.map(t =>
        t.rtl ? Array.from(t.text).reverse().join('') : t.text
    ).join('');

    return leadingSpaces + result + trailingSpaces;
}

function convertHebrewRtl(text) {
    return text.replace(/\r\n/g, '\n')
        .split('\n')
        .map(line => fixRTLLine(line, isHebrewCode))
        .join('\n');
}

/* ================================================================
   MOTEUR AUTRES RTL — inversion visuelle simple
   Même algorithme qu'hébreu, appliqué aux autres scripts RTL.
   Syriaque (0x0700-0x074F), Thaana, NKo.
================================================================ */

function convertOtherRtl(text) {
    return text.replace(/\r\n/g, '\n')
        .split('\n')
        .map(line => fixRTLLine(line, isOtherRTLCode))
        .join('\n');
}

/* ================================================================
   RAFFINAGE HARAKAT — helpers de classification et offsets
   (utilisé uniquement pour l'arabe, si OPTIONS.refineMarks = true)
================================================================ */

function isFathahMark(ch)  { const c = ch.codePointAt(0); return c === 0x064e || c === 0x0670; }
function isDhammahMark(ch) { return ch.codePointAt(0) === 0x064f; }
function isKasrahMark(ch)  { return ch.codePointAt(0) === 0x0650; }
function isShaddahMark(ch) { return ch.codePointAt(0) === 0x0651; }
function isSukunMark(ch)   { return ch.codePointAt(0) === 0x0652; }
function isTanwinMark(ch)  { const c = ch.codePointAt(0); return c === 0x064b || c === 0x064c || c === 0x064d; }

function categoryOffsetX(ch) {
    let v = OPTIONS.markOffsetX;
    if (isFathahMark(ch))  v += OPTIONS.fathahOffsetX;
    if (isDhammahMark(ch)) v += OPTIONS.dhammahOffsetX;
    if (isKasrahMark(ch))  v += OPTIONS.kasrahOffsetX;
    if (isTanwinMark(ch))  v += OPTIONS.tanwinOffsetX;
    if (isShaddahMark(ch)) v += OPTIONS.shaddaOffsetX;
    if (isSukunMark(ch))   v += OPTIONS.sukunOffsetX;
    return v;
}

function categoryOffsetY(ch) {
    let v = OPTIONS.markOffsetY;
    if (isFathahMark(ch))  v += OPTIONS.fathahOffsetY;
    if (isDhammahMark(ch)) v += OPTIONS.dhammahOffsetY;
    if (isKasrahMark(ch))  v += OPTIONS.kasrahOffsetY;
    if (isTanwinMark(ch))  v += OPTIONS.tanwinOffsetY;
    if (isShaddahMark(ch)) v += OPTIONS.shaddaOffsetY;
    if (isSukunMark(ch))   v += OPTIONS.sukunOffsetY;
    return v;
}

/* ================================================================
   COMMANDES AFFINITY
================================================================ */

function textRangeSelection(doc, node, begin, end) {
    const sel     = Selection.create(doc, node, true);
    const textSel = TextSelection.create([{ begin, end }]);
    sel.addSubSelectionForNode(node, textSel);
    return sel;
}

function currentGlyphDouble(node, begin, key) {
    try { return node.story.getGlyphAtts(begin).getDoubleValue(key) || 0; }
    catch { return 0; }
}

function addFormatRange(builder, doc, node, begin, end, delta) {
    builder.addCommand(DocumentCommand.createFormatText(
        textRangeSelection(doc, node, begin, end), delta
    ));
}

function addRefineMarkCommands(builder, doc, node, text) {
    if (!OPTIONS.refineMarks) return;
    const scale = OPTIONS.markScale / 100;
    const range = node.storyRange;
    for (let i = 0; i < text.length; i++) {
        if (!isArabicMark(text[i])) continue;
        const begin = range.begin + i;
        const end   = begin + 1;
        if (OPTIONS.markScale !== 100) {
            addFormatRange(builder, doc, node, begin, end, StoryDelta.createGlyphDouble(GlyphAttDoubleType.ScaleX, scale));
            addFormatRange(builder, doc, node, begin, end, StoryDelta.createGlyphDouble(GlyphAttDoubleType.ScaleY, scale));
        }
        const rawX = categoryOffsetX(text[i]);
        const rawY = categoryOffsetY(text[i]);
        if (rawX !== 0) {
            const nX = currentGlyphDouble(node, begin, GlyphAttDoubleType.OffsetX) + (-rawX * OFFSET_RESPONSE);
            addFormatRange(builder, doc, node, begin, end, StoryDelta.createGlyphDouble(GlyphAttDoubleType.OffsetX, nX));
        }
        if (rawY !== 0) {
            const nY = currentGlyphDouble(node, begin, GlyphAttDoubleType.OffsetY) + (-rawY * OFFSET_RESPONSE);
            addFormatRange(builder, doc, node, begin, end, StoryDelta.createGlyphDouble(GlyphAttDoubleType.OffsetY, nY));
        }
    }
}

function addArabicOpenTypeCommands(builder, selection) {
    if (!OPTIONS.arabicOpenType) return;
    builder.addCommand(DocumentCommand.createFormatText(selection, StoryDelta.createOpenTypeScriptTag(0x61726162)));
    builder.addCommand(DocumentCommand.createFormatText(selection, StoryDelta.createOpenTypeLanguageTag(0x41524120)));
}

/* ================================================================
   APPLICATION PAR NŒUD
   Détecte la langue du nœud et applique le bon moteur.
   Retourne : 'changed' | 'refined' | 'noChange' | 'skipped'
================================================================ */

function applyToNode(builder, doc, node, lang) {
    const original  = node.text;
    const range     = node.storyRange;
    const selection = textRangeSelection(doc, node, range.begin, range.end);

    function applyAlign() {
        if (OPTIONS.rightAlign) {
            builder.addCommand(DocumentCommand.createFormatText(
                selection, StoryDelta.createAlignX(ParagraphAlignXType.Right)
            ));
        }
    }

    /* ── Arabe / Persan / Ourdou ── */
    if (lang === 'Arabic') {
        /* Déjà en forme visuelle : raffinage uniquement */
        if (isAlreadyVisualArabic(original)) {
            if (OPTIONS.rightAlign || OPTIONS.refineMarks || OPTIONS.arabicOpenType) {
                applyAlign();
                addArabicOpenTypeCommands(builder, selection);
                addRefineMarkCommands(builder, doc, node, original);
                return 'refined';
            }
            return 'noChange';
        }
        const converted = convertArabicRtl(original);
        if (converted !== original) {
            builder.addCommand(DocumentCommand.createSetText(selection, converted), true);
            applyAlign();
            addArabicOpenTypeCommands(builder, selection);
            addRefineMarkCommands(builder, doc, node, converted);
            return 'changed';
        }
        return 'noChange';
    }

    /* ── Hébreu ── */
    if (lang === 'Hebrew') {
        const converted = convertHebrewRtl(original);
        if (converted !== original) {
            builder.addCommand(DocumentCommand.createSetText(selection, converted), true);
            applyAlign();
            return 'changed';
        }
        return 'noChange';
    }

    /* ── Autres RTL (Syriaque, Thaana, NKo…) ── */
    if (lang === 'Other') {
        const converted = convertOtherRtl(original);
        if (converted !== original) {
            builder.addCommand(DocumentCommand.createSetText(selection, converted), true);
            applyAlign();
            return 'changed';
        }
        return 'noChange';
    }

    return 'skipped';
}

/* ================================================================
   PANEL — 3 colonnes
   Col 1 : sélection des langues
   Col 2 : options de shaping arabe
   Col 3 : raffinage harakat (arabe uniquement)
================================================================ */

function showPanel() {
    const dlg = Dialog.create('Universal RTL Fixer Pro');
    dlg.initialWidth = 740;

    const colLang   = dlg.addColumn();
    const colArabic = dlg.addColumn();
    const colHarakat = dlg.addColumn();
    colLang.widthProportion    = 0.85;
    colArabic.widthProportion  = 1;
    colHarakat.widthProportion = 0.9;

    /* ── Langues ── */
    const grpLang  = colLang.addGroup('Langues RTL — détection automatique');
    const swArabic = grpLang.addSwitch('Arabe · Persan (Farsi) · Ourdou', OPTIONS.processArabic);
    const swHebrew = grpLang.addSwitch('Hébreu', OPTIONS.processHebrew);
    const swOther  = grpLang.addSwitch('Autres RTL : Syriaque · Thaana · NKo', OPTIONS.processOther);

    /* ── Options arabe ── */
    const grpArabic  = colArabic.addGroup('Options — Arabe / Persan / Ourdou');
    const btnProfile = grpArabic.addButtonSet('Ordre Harakat', ['Équilibré', 'Voyelles en 1er', 'Compact'], OPTIONS.markProfile);
    const swLamAlef  = grpArabic.addSwitch('Lam-Alef (ligature automatique)', OPTIONS.lamAlef);
    const swAlign    = grpArabic.addSwitch('Aligner à droite', OPTIONS.rightAlign);
    const swTatweel  = grpArabic.addSwitch('Supprimer Tatweel (ـ)', OPTIONS.stripTatweel);
    const swOT       = grpArabic.addSwitch('Tag OpenType arabe', OPTIONS.arabicOpenType);

    /* ── Raffinage Harakat ── */
    const grpRef    = colHarakat.addGroup('Raffinage Harakat (Arabe)');
    const swRefine  = grpRef.addSwitch('Activer', OPTIONS.refineMarks);
    const btnScale  = grpRef.addButtonSet('Taille', ['100%', '96%', '92%', '88%', '84%'], 0);
    const edAllX    = grpRef.addUnitValueEditor('Tous X', UnitType.Pixel, UnitType.Pixel, OPTIONS.markOffsetX, -40, 40);
    const edAllY    = grpRef.addUnitValueEditor('Tous Y', UnitType.Pixel, UnitType.Pixel, OPTIONS.markOffsetY, -40, 40);
    const edFathaX  = grpRef.addUnitValueEditor('Fatha X', UnitType.Pixel, UnitType.Pixel, OPTIONS.fathahOffsetX, -40, 40);
    const edFathaY  = grpRef.addUnitValueEditor('Fatha Y', UnitType.Pixel, UnitType.Pixel, OPTIONS.fathahOffsetY, -40, 40);
    const edDhammaX = grpRef.addUnitValueEditor('Damma X', UnitType.Pixel, UnitType.Pixel, OPTIONS.dhammahOffsetX, -40, 40);
    const edDhammaY = grpRef.addUnitValueEditor('Damma Y', UnitType.Pixel, UnitType.Pixel, OPTIONS.dhammahOffsetY, -40, 40);
    const edKasraX  = grpRef.addUnitValueEditor('Kasra X', UnitType.Pixel, UnitType.Pixel, OPTIONS.kasrahOffsetX, -40, 40);
    const edKasraY  = grpRef.addUnitValueEditor('Kasra Y', UnitType.Pixel, UnitType.Pixel, OPTIONS.kasrahOffsetY, -40, 40);
    const edSukunX  = grpRef.addUnitValueEditor('Sukun X', UnitType.Pixel, UnitType.Pixel, OPTIONS.sukunOffsetX, -40, 40);
    const edSukunY  = grpRef.addUnitValueEditor('Sukun Y', UnitType.Pixel, UnitType.Pixel, OPTIONS.sukunOffsetY, -40, 40);
    const edShaddaX = grpRef.addUnitValueEditor('Shadda X', UnitType.Pixel, UnitType.Pixel, OPTIONS.shaddaOffsetX, -40, 40);
    const edShaddaY = grpRef.addUnitValueEditor('Shadda Y', UnitType.Pixel, UnitType.Pixel, OPTIONS.shaddaOffsetY, -40, 40);

    const harakatEditors = [btnScale, edAllX, edAllY, edFathaX, edFathaY, edDhammaX, edDhammaY, edKasraX, edKasraY, edSukunX, edSukunY, edShaddaX, edShaddaY];
    harakatEditors.forEach(ed => ed.setIsEnabledBy(swRefine));

    const result = dlg.runModal();
    if (!result.equals(DialogResult.Ok)) return null;

    const markScales = [100, 96, 92, 88, 84];
    OPTIONS = {
        processArabic  : Boolean(swArabic.value),
        processHebrew  : Boolean(swHebrew.value),
        processOther   : Boolean(swOther.value),
        markProfile    : btnProfile.selectedIndex,
        lamAlef        : Boolean(swLamAlef.value),
        rightAlign     : Boolean(swAlign.value),
        stripTatweel   : Boolean(swTatweel.value),
        arabicOpenType : Boolean(swOT.value),
        refineMarks    : Boolean(swRefine.value),
        markScale      : markScales[btnScale.selectedIndex] || 100,
        markOffsetX    : edAllX.value,
        markOffsetY    : edAllY.value,
        fathahOffsetX  : edFathaX.value,
        fathahOffsetY  : edFathaY.value,
        dhammahOffsetX : edDhammaX.value,
        dhammahOffsetY : edDhammaY.value,
        kasrahOffsetX  : edKasraX.value,
        kasrahOffsetY  : edKasraY.value,
        sukunOffsetX   : edSukunX.value,
        sukunOffsetY   : edSukunY.value,
        shaddaOffsetX  : edShaddaX.value,
        shaddaOffsetY  : edShaddaY.value,
        tanwinOffsetX  : 0,
        tanwinOffsetY  : 0,
    };

    return true;
}

/* ================================================================
   MAIN
================================================================ */

function main() {
    const doc = Document.current;
    if (!doc) {
        alert('Ouvrez un document avant de lancer le script.');
        return;
    }

    /* Collecter les nœuds texte sélectionnés */
    const nodes = [];
    for (const node of doc.selection.nodes) {
        if (node && node.isTextNode) nodes.push(node);
    }
    if (!nodes.length) {
        alert('Sélectionnez au moins un bloc de texte, puis relancez.');
        return;
    }

    if (!showPanel()) return;

    const builder = CompoundCommandBuilder.create();
    const stats   = { changed: 0, refined: 0, noChange: 0, skipped: 0, langs: {} };

    for (const node of nodes) {
        const text = node.text;
        if (!text || !text.trim()) continue;

        const lang = detectLanguage(text);
        if (!lang) { stats.skipped++; continue; }

        const enabled =
            (lang === 'Arabic' && OPTIONS.processArabic) ||
            (lang === 'Hebrew' && OPTIONS.processHebrew) ||
            (lang === 'Other'  && OPTIONS.processOther);

        if (!enabled) { stats.skipped++; continue; }

        const outcome = applyToNode(builder, doc, node, lang);
        stats[outcome] = (stats[outcome] || 0) + 1;
        stats.langs[lang] = (stats.langs[lang] || 0) + 1;
    }

    if (stats.changed > 0 || stats.refined > 0) {
        doc.executeCommand(builder.createCommand());
    }

    /* ── Rapport ── */
    const langLines = Object.keys(stats.langs)
        .map(k => '  ' + k + ' : ' + stats.langs[k] + ' bloc(s)')
        .join('\n');

    alert(
        'Universal RTL Fixer Pro — Terminé\n\n' +
        'Modifiés    : ' + (stats.changed  || 0) + '\n' +
        'Raffinés    : ' + (stats.refined  || 0) + '\n' +
        'Déjà OK     : ' + (stats.noChange || 0) + '\n' +
        'Ignorés     : ' + (stats.skipped  || 0) + '\n' +
        (langLines
            ? '\nLangues détectées :\n' + langLines
            : '\nAucune langue RTL détectée dans la sélection.') +
        '\n\nAnnuler : Ctrl+Z / Cmd+Z'
    );
}

main();
