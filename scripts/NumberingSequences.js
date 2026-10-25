'use strict';

/*
 * Numbering-Sequences v5
 * -----------------------
 * Changes compared to v4c:
 *  - GUI converted to tabs (pages), following the pattern of "Transform Objects v8":
 *    on the left, permanently visible: tab selection, preview (text list + status) and presets;
 *    on the right, two content columns per page. When switching tabs, the groups of the active
 *    page are shown and all other groups are hidden.
 *      Tab 1  Sequence            (sequence parameters; date fields in their own group "Date")
 *      Tab 2  Text & Arrangement  (prefix/suffix/text mode | reading direction/reset)
 *      Tab 3  Row × Column        (combined labelling, row and column sequence)
 *  - Date fields (start date, end date, format, placeholder note) now live in their own
 *    group "Date", which only appears for type "Date".
 *  - When "Combine Row × Column" is active, tab 1 shows a note instead of the sequence fields.
 *  Functions/calculation unchanged from v4c (robust history rollback, File.create).
 *
 * Replaces the text objects inside the selected group(s) with an
 * automatically generated sequence. The text attributes (font, size,
 * colour, ...) of the placeholder objects are fully preserved.
 *
 * Features:
 *  - End value (sequence repeats cyclically between start and end)
 *  - Prefix / Suffix
 *  - Uppercase/lowercase selectable (Letters, Roman Numerals)
 *  - Repeat per value
 *  - Reset per row/column
 *  - Combined row×column labelling (e.g. A1, A2, B1, B2)
 *  - Replace a placeholder inside existing text instead of full replacement
 *  - Sort mode "Snake" (row-wise/column-wise)
 *  - Sort by layer order
 *  - Preset system (save/load as JSON on the Desktop)
 *  - Text preview list in the dialog
 *  - Weekday/Month types in German AND English abbreviations
 *  - Date sequences with freely definable format (token system D/M/Y/W),
 *    including cyclic date ranges, also usable in the combined
 *    row×column labelling
 */

const { app } = require('/application');
const doc = app.documents.current;

if (!doc) {
    app.alert('No document is open.', 'Numbering-Sequences');
} else {

const { Selection, TextSelection } = require('/selections');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
const { Dialog, DialogResult } = require('/dialog');
const { File, FileSystemApi } = require('/fs');

// ============================================================
// Robust history rollback (v4c)
// ============================================================
// 1) Jump via doc.history.position; 2) if that fails (e.g. COMMAND_FAILED when the
// start position is 0 — document without history) or does not reach the target, step back
// with history.undo(); 3) warning if the target is not reached.
function rollbackToPosition(pos) {
    try {
        if (doc.history.position !== pos) doc.history.position = pos;
    } catch (e) {
        console.log('History jump failed (' + e.message + ') - falling back to step-by-step undo.');
    }
    let guard = 0;
    while (doc.history.position > pos && doc.history.canUndo && guard < 10000) {
        try { doc.history.undo(); } catch (e) { console.log('Undo error: ' + e.message); break; }
        guard++;
    }
    if (doc.history.position !== pos) {
        console.log('Warning: history rollback incomplete (position ' + doc.history.position + ' instead of ' + pos + ').');
    }
}

// ============================================================
// Sequence generation
// ============================================================

const WEEKDAYS_DE = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const MONTHS_DE = ['Jan', 'Feb', 'März', 'Apr', 'Mai', 'Juni', 'Juli', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const WEEKDAYS_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS_FULL_EN = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS_FULL_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const TYPE_ITEMS = [
    'Numeric (1, 2, 3, ...)',
    'Letters (a, b, ..., z, aa, ...)',
    'Roman Numerals (I, II, III, ...)',
    'Weekdays German (Mo, Di, ...)',
    'Months German (Jan, Feb, ...)',
    'Weekdays (Mon, Tue, ...)',
    'Months (Jan, Feb, ...)',
    'Custom (List)',
    'Date (freely formattable)'
];
const DATE_SEQ_TYPE = 8;

// Format placeholders for the date format (longest first = correct detection of e.g. "MMMM" before "MM")
const DATE_TOKENS_EN = [
    ['WWWW', d => WEEKDAYS_FULL_EN[(d.getUTCDay() + 6) % 7]],
    ['WWW', d => WEEKDAYS_EN[(d.getUTCDay() + 6) % 7]],
    ['YYYY', d => String(d.getUTCFullYear())],
    ['YY', d => String(d.getUTCFullYear() % 100).padStart(2, '0')],
    ['MMMM', d => MONTHS_FULL_EN[d.getUTCMonth()]],
    ['MMM', d => MONTHS_EN[d.getUTCMonth()]],
    ['MM', d => String(d.getUTCMonth() + 1).padStart(2, '0')],
    ['M', d => String(d.getUTCMonth() + 1)],
    ['DD', d => String(d.getUTCDate()).padStart(2, '0')],
    ['D', d => String(d.getUTCDate())]
];

function parseDateDDMMYYYY(str) {
    const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(String(str).trim());
    if (!m) return null;
    const day = parseInt(m[1], 10), month = parseInt(m[2], 10), year = parseInt(m[3], 10);
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
    return d;
}

function addDays(date, days) {
    return new Date(date.getTime() + days * 86400000);
}

function daysBetween(a, b) {
    return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function formatDate(date, pattern, tokens) {
    let out = '', i = 0;
    while (i < pattern.length) {
        let matched = false;
        for (const [tok, fn] of tokens) {
            if (pattern.startsWith(tok, i)) { out += fn(date); i += tok.length; matched = true; break; }
        }
        if (!matched) { out += pattern[i]; i += 1; }
    }
    return out;
}

function todayDDMMYYYY() {
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    return dd + '.' + mm + '.' + now.getFullYear();
}
const ARRANGE_ITEMS = [
    'Row-wise',
    'Column-wise',
    'Snake (row-wise)',
    'Snake (column-wise)',
    'Layer order'
];
const ARRANGE_MODES = ['row', 'col', 'snake-row', 'snake-col', 'layer'];

function toBijectiveBase26(num) {
    num = Math.max(1, Math.round(num));
    let s = '';
    while (num > 0) {
        num -= 1;
        const rem = num % 26;
        s = String.fromCharCode(97 + rem) + s;
        num = Math.floor(num / 26);
    }
    return s;
}

function toRoman(num) {
    num = Math.max(1, Math.min(3999, Math.round(num)));
    const vals = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
    const syms = ['M', 'CM', 'D', 'CD', 'C', 'XC', 'L', 'XL', 'X', 'IX', 'V', 'IV', 'I'];
    let res = '';
    for (let i = 0; i < vals.length; i++) {
        while (num >= vals[i]) { res += syms[i]; num -= vals[i]; }
    }
    return res;
}

function formatNumber(num, digits) {
    num = Math.round(num);
    const sign = num < 0 ? '-' : '';
    let s = String(Math.abs(num));
    if (digits > 0 && s.length < digits) s = '0'.repeat(digits - s.length) + s;
    return sign + s;
}

function cyclicValue(list, idx1based) {
    const n = list.length;
    if (n === 0) return '';
    const i = ((Math.round(idx1based) - 1) % n + n) % n;
    return list[i];
}

// seqType: 0=Numeric, 1=Letters, 2=Roman, 3=Weekdays German, 4=Months German,
//          5=Weekdays English, 6=Months English, 7=Custom
function generateValue(seqType, index, digits, customList) {
    switch (seqType) {
        case 0: return formatNumber(index, digits);
        case 1: return toBijectiveBase26(index);
        case 2: return toRoman(index);
        case 3: return cyclicValue(WEEKDAYS_DE, index);
        case 4: return cyclicValue(MONTHS_DE, index);
        case 5: return cyclicValue(WEEKDAYS_EN, index);
        case 6: return cyclicValue(MONTHS_EN, index);
        case 7: return customList.length ? cyclicValue(customList, index) : formatNumber(index, digits);
        default: return formatNumber(index, digits);
    }
}

function applyCase(v, seqType, upperCase) {
    if (seqType === 1 || seqType === 2) return upperCase ? v.toUpperCase() : v.toLowerCase();
    return v;
}

// Start/End-value cycle + repeat per value
function computeIndexForPosition(pos, p) {
    const logicalStep = Math.floor(pos / p.repeat);
    let idx = p.start + p.dir * logicalStep * p.inc;
    if (p.useEnd) {
        const range = p.end - p.start + 1;
        if (range > 0) idx = p.start + (((idx - p.start) % range) + range) % range;
    }
    return idx;
}

function readCustomList(text) {
    return text.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

// ============================================================
// Collect text objects in the selection (recursively, document order)
// ============================================================

function collectTextNodes(node, out) {
    if (node.children && node.children.length > 0) {
        for (const ch of node.children) collectTextNodes(ch, out);
    } else if (node.isTextNode && !node.isTableTextNode) {
        out.push(node);
    }
}

const rootNodes = doc.selection.nodes.toArray();

const textNodesRaw = [];
for (const r of rootNodes) {
    if (r.isTextNode && !r.isTableTextNode) textNodesRaw.push(r);
    else collectTextNodes(r, textNodesRaw);
}

if (rootNodes.length === 0) {
    app.alert('Please select a group (or text objects) first.', 'Numbering-Sequences');
} else if (textNodesRaw.length === 0) {
    app.alert('No text objects were found in the selection.', 'Numbering-Sequences');
} else {

// ============================================================
// Reading order: cluster by bounding-box overlap
// ============================================================

function clusterByOverlap(arr, getRange) {
    const groups = [];
    for (const it of arr) {
        const [s, e] = getRange(it);
        const overlapping = [];
        for (const g of groups) if (s <= g.end && e >= g.start) overlapping.push(g);
        if (overlapping.length === 0) {
            groups.push({ start: s, end: e, items: [it] });
        } else {
            const base = overlapping[0];
            base.items.push(it);
            base.start = Math.min(base.start, s);
            base.end = Math.max(base.end, e);
            for (let k = 1; k < overlapping.length; k++) {
                const g = overlapping[k];
                base.items.push(...g.items);
                base.start = Math.min(base.start, g.start);
                base.end = Math.max(base.end, g.end);
                groups.splice(groups.indexOf(g), 1);
            }
        }
    }
    return groups;
}

// Returns a list of GROUPS (each group: ordered array of items).
// mode: 'row' | 'col' | 'snake-row' | 'snake-col' | 'layer'
function sortReadingOrder(items, opts) {
    if (opts.mode === 'layer') {
        const arr = [...items];
        if (opts.vDir === 'btt') arr.reverse();
        return [arr];
    }
    if (opts.mode === 'row' || opts.mode === 'snake-row') {
        const arr = [...items].sort((a, b) => a.ys - b.ys);
        const rows = clusterByOverlap(arr, it => [it.ys, it.ye]);
        rows.sort((a, b) => opts.vDir === 'ttb' ? a.start - b.start : b.start - a.start);
        rows.forEach((row, ri) => {
            const reverse = opts.mode === 'snake-row' && (ri % 2 === 1);
            const useHDir = reverse ? (opts.hDir === 'ltr' ? 'rtl' : 'ltr') : opts.hDir;
            row.items.sort((a, b) => useHDir === 'ltr' ? a.cx - b.cx : b.cx - a.cx);
        });
        return rows.map(r => r.items);
    }
    const arr = [...items].sort((a, b) => a.xs - b.xs);
    const cols = clusterByOverlap(arr, it => [it.xs, it.xe]);
    cols.sort((a, b) => opts.hDir === 'ltr' ? a.start - b.start : b.start - a.start);
    cols.forEach((col, ci) => {
        const reverse = opts.mode === 'snake-col' && (ci % 2 === 1);
        const useVDir = reverse ? (opts.vDir === 'ttb' ? 'btt' : 'ttb') : opts.vDir;
        col.items.sort((a, b) => useVDir === 'ttb' ? a.cy - b.cy : b.cy - a.cy);
    });
    return cols.map(c => c.items);
}

// For the combined row×column labelling: assign each item a
// (rowIndex, colIndex), independent of the chosen arrangement.
function computeRowColIndices(items, hDir, vDir) {
    const rowGroups = clusterByOverlap([...items].sort((a, b) => a.ys - b.ys), it => [it.ys, it.ye]);
    rowGroups.sort((a, b) => vDir === 'ttb' ? a.start - b.start : b.start - a.start);
    const colGroups = clusterByOverlap([...items].sort((a, b) => a.xs - b.xs), it => [it.xs, it.xe]);
    colGroups.sort((a, b) => hDir === 'ltr' ? a.start - b.start : b.start - a.start);
    const map = new Map();
    rowGroups.forEach((g, ri) => g.items.forEach(it => { const c = map.get(it) || {}; c.rowIndex = ri; map.set(it, c); }));
    colGroups.forEach((g, ci) => g.items.forEach(it => { const c = map.get(it) || {}; c.colIndex = ci; map.set(it, c); }));
    return map;
}

function buildItems() {
    return textNodesRaw.map(n => {
        const bb = n.getSpreadBaseBox(false);
        return {
            node: n,
            cx: bb.x + bb.width / 2, cy: bb.y + bb.height / 2,
            xs: bb.x, xe: bb.x + bb.width, ys: bb.y, ye: bb.y + bb.height
        };
    });
}

// ============================================================
// Label calculation
// ============================================================

function computeAxisIndex(clusterIndex, axis) {
    return axis.start + axis.dir * clusterIndex * axis.inc;
}

function formatAxisValue(axis, clusterIndex) {
    if (axis.seqType === DATE_SEQ_TYPE) {
        if (!axis.dateStart) throw new Error('Invalid start date (axis) - format DD.MM.YYYY expected');
        const idx = computeAxisIndex(clusterIndex, axis);
        return formatDate(addDays(axis.dateStart, idx), axis.dateFormat, DATE_TOKENS_EN);
    }
    const idx = computeAxisIndex(clusterIndex, axis);
    let v = generateValue(axis.seqType, idx, axis.digits, axis.customList);
    return applyCase(v, axis.seqType, axis.upperCase);
}

function computeLabelForPosition(pos, params) {
    const p = params.single;
    if (p.seqType === DATE_SEQ_TYPE) {
        if (!p.dateStart) throw new Error('Invalid start date - format DD.MM.YYYY expected');
        const idx = computeIndexForPosition(pos, p);
        const v = formatDate(addDays(p.dateStart, idx), p.dateFormat, DATE_TOKENS_EN);
        return params.prefix + v + params.suffix;
    }
    const idx = computeIndexForPosition(pos, p);
    let v = generateValue(p.seqType, idx, p.digits, p.customList);
    v = applyCase(v, p.seqType, p.upperCase);
    return params.prefix + v + params.suffix;
}

function computeCombinedLabel(item, rowColMap, params) {
    const rc = rowColMap.get(item);
    const rowVal = formatAxisValue(params.rowSeq, rc.rowIndex);
    const colVal = formatAxisValue(params.colSeq, rc.colIndex);
    return params.prefix + rowVal + params.separator + colVal + params.suffix;
}

// ============================================================
// Apply text
// ============================================================

function applyLabelToNode(node, label, params, builder) {
    if (params.textMode === 'placeholder') {
        const token = params.placeholder;
        if (!token) return false;
        const text = node.text;
        const positions = [];
        let searchFrom = 0, idx;
        while ((idx = text.indexOf(token, searchFrom)) !== -1) {
            positions.push(idx);
            searchFrom = idx + token.length;
        }
        if (positions.length === 0) return false;
        positions.sort((a, b) => b - a); // replace right to left
        for (const pos of positions) {
            const sel = Selection.create(doc, node);
            const textSel = TextSelection.create([{ begin: pos, end: pos + token.length }]);
            sel.addSubSelectionForNode(node, textSel);
            builder.addCommand(DocumentCommand.createSetText(sel, label));
        }
        return true;
    } else {
        const len = node.text.length;
        const sel = Selection.create(doc, node);
        const textSel = TextSelection.create([{ begin: 0, end: len }]);
        sel.addSubSelectionForNode(node, textSel);
        builder.addCommand(DocumentCommand.createSetText(sel, label));
        return true;
    }
}

function applySequence(params) {
    const items = buildItems();
    const groups = sortReadingOrder(items, { mode: params.arrangeMode, hDir: params.hDir, vDir: params.vDir });
    let rowColMap = null;
    if (params.combined) rowColMap = computeRowColIndices(items, params.hDir, params.vDir);

    const builder = CompoundCommandBuilder.create();
    let anyCmd = false;
    let globalPos = 0;
    const previewList = [];

    for (const group of groups) {
        let localPos = 0;
        for (const it of group) {
            const label = params.combined
                ? computeCombinedLabel(it, rowColMap, params)
                : computeLabelForPosition(params.resetPerGroup ? localPos : globalPos, params);
            previewList.push(label);
            if (applyLabelToNode(it.node, label, params, builder)) anyCmd = true;
            localPos++; globalPos++;
        }
    }
    if (anyCmd) doc.executeCommand(builder.createCommand());
    return previewList;
}

// ============================================================
// Dialog (v5: tab layout like "Transform Objects v8")
// ============================================================
// Left: narrow, permanently visible column (tab selection, preview, presets).
// Right: two content columns (cA, cB). Each page consists of groups in these two
// columns; updateFieldVisibility() shows the groups of the active page and hides all others
// (in addition to the type-/mode-dependent showing/hiding of individual fields).

const PAGE_TITLES = ['1  Sequence', '2  Text & Arrangement', '3  Row × Column'];
let curPage = 0;

const dlg = Dialog.create('Numbering-Sequences');
dlg.initialWidth = 1100;
dlg.setIsResizable(true);

const cNav = dlg.addColumn(); cNav.widthProportion = 1;
const cA = dlg.addColumn(); cA.widthProportion = 1;
const cB = dlg.addColumn(); cB.widthProportion = 1;

// -- Left column (always visible): tabs, preview, presets --
const presetDir = app.userDesktopPath + '/AffinityScriptPresets';

const gNav = cNav.addGroup('Tabs');
const rNav = gNav.addRadioGroup('', PAGE_TITLES, 0);
rNav.selectedIndex = 0;
gNav.addStaticText('', 'Text objects found: ' + textNodesRaw.length);

const gPreview = cNav.addGroup('Preview');
const previewText = gPreview.addStaticText('', '');
const statusText = gPreview.addStaticText('', '');

const gPreset = cNav.addGroup('Presets');
const btnSave = gPreset.addButton('Save Preset');
const btnLoad = gPreset.addButton('Load Preset');

// -- Tab 1 "Sequence", column A: sequence --
const gSeq = cA.addGroup('Sequence');
const typeCombo = gSeq.addComboBox('Type', TYPE_ITEMS, 0);
typeCombo.selectedIndex = 0;

const startEd = gSeq.addUnitValueEditor('Start Value', 'none', 'none', 1, -99999, 99999);
startEd.value = 1; startEd.precision = 0; startEd.setIsFullWidth(true);

const endCheck = gSeq.addCheckBox('Use End', false);
endCheck.value = false;

const endEd = gSeq.addUnitValueEditor('End Value', 'none', 'none', 10, -99999, 99999);
endEd.value = 10; endEd.precision = 0; endEd.setIsFullWidth(true);

const incEd = gSeq.addUnitValueEditor('Increment', 'none', 'none', 1, 1, 9999);
incEd.value = 1; incEd.precision = 0; incEd.setIsFullWidth(true);

const dirRadio = gSeq.addRadioGroup('Counting Direction', ['Forward', 'Backward'], 0);
dirRadio.selectedIndex = 0;

const repeatEd = gSeq.addUnitValueEditor('Repeat', 'none', 'none', 1, 1, 999);
repeatEd.value = 1; repeatEd.precision = 0; repeatEd.setIsFullWidth(true);

const digitsEd = gSeq.addUnitValueEditor('Digits (0=none)', 'none', 'none', 0, 0, 10);
digitsEd.value = 0; digitsEd.precision = 0; digitsEd.setIsFullWidth(true);

const caseCheck = gSeq.addCheckBox('Uppercase', false);
caseCheck.value = false;

const customTB = gSeq.addTextBox('Custom List (comma-separated)', '');
customTB.text = ''; customTB.setIsFullWidth(true);

// -- Tab 1, column B: date (only for type "Date"), notes, mode note --
const gDate = cB.addGroup('Date');
const startDateTB = gDate.addTextBox('Start Date (DD.MM.YYYY)', '');
startDateTB.text = todayDDMMYYYY(); startDateTB.setIsFullWidth(true);
const endDateTB = gDate.addTextBox('End Date (DD.MM.YYYY)', '');
endDateTB.text = todayDDMMYYYY(); endDateTB.setIsFullWidth(true);
const formatTB = gDate.addTextBox('Format', 'DD.MM.YYYY');
formatTB.text = 'DD.MM.YYYY'; formatTB.setIsFullWidth(true);
gDate.addStaticText('', 'Date format placeholders: D/DD=Day, M/MM=Month (number), MMM=Month short, MMMM=Month full, YY/YYYY=Year, WWW=Weekday short, WWWW=Weekday full. Examples: DD.MM.YYYY · YYYY.MM.DD · DD.MMM.YYYY · WWW.DD.MMM.YYYY. The increment counts in days here.');

const gHint = cB.addGroup('Note');
gHint.addStaticText('', 'For Letters/Weekdays/Months/custom list, the start value is the position (1=a resp. Mon resp. Jan). "Use End" makes the sequence repeat cyclically (e.g. 1,2,3,1,2,3,...). "Repeat" repeats each value n times in a row.');

const gCombNote = cB.addGroup('Row × Column mode');
gCombNote.addStaticText('', 'The mode "Combine Row × Column" is active. Row and column sequences are set in the tab "3  Row × Column".');

// -- Tab 2 "Text & Arrangement": column A = text, column B = arrangement --
const gText = cA.addGroup('Text');
const prefixTB = gText.addTextBox('Prefix', '');
prefixTB.text = ''; prefixTB.setIsFullWidth(true);
const suffixTB = gText.addTextBox('Suffix', '');
suffixTB.text = ''; suffixTB.setIsFullWidth(true);
const textModeRadio = gText.addRadioGroup('Text Mode', ['Replace entire text', 'Replace placeholder'], 0);
textModeRadio.selectedIndex = 0;
const placeholderTB = gText.addTextBox('Placeholder', '{{N}}');
placeholderTB.text = '{{N}}'; placeholderTB.setIsFullWidth(true);

const gArrange = cB.addGroup('Arrangement (Reading Direction)');
const arrangeCombo = gArrange.addComboBox('Orientation', ARRANGE_ITEMS, 0);
arrangeCombo.selectedIndex = 0;
const hRadio = gArrange.addRadioGroup('Horizontal', ['Left → Right', 'Right → Left'], 0);
hRadio.selectedIndex = 0;
const vRadio = gArrange.addRadioGroup('Vertical', ['Top → Bottom', 'Bottom → Top'], 0);
vRadio.selectedIndex = 0;
const resetCheck = gArrange.addCheckBox('Reset per Row/Column', false);
resetCheck.value = false;

// -- Tab 3 "Row × Column": column A = mode + row sequence, column B = column sequence --
const gCombine = cA.addGroup('Row × Column');
const combinedCheck = gCombine.addCheckBox('Combine Row × Column', false);
combinedCheck.value = false;
const sepTB = gCombine.addTextBox('Separator', '');
sepTB.text = ''; sepTB.setIsFullWidth(true);

function buildAxisGroup(col, title) {
    const g = col.addGroup(title);
    const typeC = g.addComboBox('Type', TYPE_ITEMS, 0);
    typeC.selectedIndex = 0;
    const startE = g.addUnitValueEditor('Start', 'none', 'none', 1, -99999, 99999);
    startE.value = 1; startE.precision = 0; startE.setIsFullWidth(true);
    const startDateB = g.addTextBox('Start Date (DD.MM.YYYY)', '');
    startDateB.text = todayDDMMYYYY(); startDateB.setIsFullWidth(true);
    const formatB = g.addTextBox('Format', 'DD.MM.YYYY');
    formatB.text = 'DD.MM.YYYY'; formatB.setIsFullWidth(true);
    const incE = g.addUnitValueEditor('Increment', 'none', 'none', 1, 1, 9999);
    incE.value = 1; incE.precision = 0; incE.setIsFullWidth(true);
    const dirR = g.addRadioGroup('Direction', ['Forward', 'Backward'], 0);
    dirR.selectedIndex = 0;
    const digitsE = g.addUnitValueEditor('Digits (0=none)', 'none', 'none', 0, 0, 10);
    digitsE.value = 0; digitsE.precision = 0; digitsE.setIsFullWidth(true);
    const caseC = g.addCheckBox('Uppercase', false);
    caseC.value = false;
    const customB = g.addTextBox('Custom List', '');
    customB.text = ''; customB.setIsFullWidth(true);
    return { group: g, typeCombo: typeC, startEd: startE, startDateTB: startDateB, formatTB: formatB, incEd: incE, dirRadio: dirR, digitsEd: digitsE, caseCheck: caseC, customTB: customB };
}

const rowCtrls = buildAxisGroup(cA, 'Row Sequence');
const colCtrls = buildAxisGroup(cB, 'Column Sequence');

// ============================================================
// Live preview
// ============================================================

let posBeforePreview = null;
let hasPreview = false;

function axisParamsFrom(ctrls) {
    const isDate = ctrls.typeCombo.selectedIndex === DATE_SEQ_TYPE;
    return {
        seqType: ctrls.typeCombo.selectedIndex,
        start: isDate ? 0 : ctrls.startEd.value,
        inc: Math.max(1, ctrls.incEd.value),
        dir: ctrls.dirRadio.selectedIndex === 0 ? 1 : -1,
        digits: ctrls.digitsEd.value,
        upperCase: ctrls.caseCheck.value,
        customList: readCustomList(ctrls.customTB.text),
        dateStart: isDate ? parseDateDDMMYYYY(ctrls.startDateTB.text) : null,
        dateFormat: ctrls.formatTB.text
    };
}

function currentParams() {
    const t = typeCombo.selectedIndex;
    const isDate = t === DATE_SEQ_TYPE;
    const dateStart = isDate ? parseDateDDMMYYYY(startDateTB.text) : null;
    const dateEnd = (isDate && endCheck.value) ? parseDateDDMMYYYY(endDateTB.text) : null;
    return {
        single: {
            seqType: t,
            start: isDate ? 0 : startEd.value,
            end: isDate ? ((dateStart && dateEnd) ? daysBetween(dateStart, dateEnd) : 0) : endEd.value,
            useEnd: endCheck.value,
            inc: Math.max(1, incEd.value),
            dir: dirRadio.selectedIndex === 0 ? 1 : -1,
            repeat: Math.max(1, repeatEd.value),
            digits: digitsEd.value,
            upperCase: caseCheck.value,
            customList: readCustomList(customTB.text),
            dateStart: dateStart,
            dateFormat: formatTB.text
        },
        prefix: prefixTB.text,
        suffix: suffixTB.text,
        textMode: textModeRadio.selectedIndex === 0 ? 'full' : 'placeholder',
        placeholder: placeholderTB.text,
        arrangeMode: ARRANGE_MODES[arrangeCombo.selectedIndex],
        hDir: hRadio.selectedIndex === 0 ? 'ltr' : 'rtl',
        vDir: vRadio.selectedIndex === 0 ? 'ttb' : 'btt',
        resetPerGroup: resetCheck.value,
        combined: combinedCheck.value,
        rowSeq: axisParamsFrom(rowCtrls),
        colSeq: axisParamsFrom(colCtrls),
        separator: sepTB.text
    };
}

function defaultCaseForType(t, checkCtrl) {
    if (t === 1) checkCtrl.value = false;
    else if (t === 2) checkCtrl.value = true;
}

function updateAxisVisibility(ctrls) {
    const t = ctrls.typeCombo.selectedIndex;
    const isDate = (t === DATE_SEQ_TYPE);
    ctrls.startEd.isVisible = !isDate;
    ctrls.startDateTB.isVisible = isDate;
    ctrls.formatTB.isVisible = isDate;
    ctrls.digitsEd.isVisible = (t === 0);
    ctrls.customTB.isVisible = (t === 7);
    ctrls.caseCheck.isVisible = (t === 1 || t === 2);
}

// Visibility = active tab AND functional condition (type/mode)
function updateFieldVisibility() {
    const combined = combinedCheck.value;
    const t = typeCombo.selectedIndex;
    const isDate = (t === DATE_SEQ_TYPE);
    const pg = curPage;

    // Groups per tab
    gSeq.isVisible = (pg === 0) && !combined;
    gDate.isVisible = (pg === 0) && !combined && isDate;
    gHint.isVisible = (pg === 0) && !combined;
    gCombNote.isVisible = (pg === 0) && combined;
    gText.isVisible = (pg === 1);
    gArrange.isVisible = (pg === 1);
    gCombine.isVisible = (pg === 2);
    rowCtrls.group.isVisible = (pg === 2) && combined;
    colCtrls.group.isVisible = (pg === 2) && combined;

    // Fields within the groups
    sepTB.isVisible = combined;
    startEd.isVisible = !isDate;
    endDateTB.isVisible = isDate && endCheck.value;
    digitsEd.isVisible = (t === 0);
    customTB.isVisible = (t === 7);
    caseCheck.isVisible = (t === 1 || t === 2);
    endEd.isVisible = endCheck.value && !isDate;

    updateAxisVisibility(rowCtrls);
    updateAxisVisibility(colCtrls);

    const am = arrangeCombo.selectedIndex;
    resetCheck.isVisible = (!combined) && (am !== 4);
    repeatEd.isVisible = !combined;

    placeholderTB.isVisible = (textModeRadio.selectedIndex === 1);
}

function updatePreview() {
    if (hasPreview) {
        rollbackToPosition(posBeforePreview);   // v4c: robust (undo fallback)
    } else {
        posBeforePreview = doc.history.position;
    }
    try {
        const list = applySequence(currentParams());
        hasPreview = true;
        const shown = list.length > 40
            ? list.slice(0, 40).join(', ') + ', ... (' + list.length + ' total)'
            : list.join(', ');
        previewText.setText(shown);
        statusText.setText('Preview active - OK applies it, Cancel/ESC discards it.');
    } catch (e) {
        statusText.setText('Preview error: ' + e.message);
    }
}

const onChange = () => { updateFieldVisibility(); updatePreview(); };

function attachAxisHandlers(ctrls) {
    ctrls.typeCombo.setOnValueChangedHandler(() => { defaultCaseForType(ctrls.typeCombo.selectedIndex, ctrls.caseCheck); onChange(); });
    ctrls.startEd.setOnValueChangedHandler(onChange);
    ctrls.startDateTB.setOnValueChangedHandler(onChange);
    ctrls.formatTB.setOnValueChangedHandler(onChange);
    ctrls.incEd.setOnValueChangedHandler(onChange);
    ctrls.dirRadio.setOnValueChangedHandler(onChange);
    ctrls.digitsEd.setOnValueChangedHandler(onChange);
    ctrls.caseCheck.setOnValueChangedHandler(onChange);
    ctrls.customTB.setOnValueChangedHandler(onChange);
}

updateFieldVisibility();

// Tab switch: only toggle visibility, no new preview needed
rNav.setOnValueChangedHandler(() => { curPage = rNav.selectedIndex; updateFieldVisibility(); });

typeCombo.setOnValueChangedHandler(() => { defaultCaseForType(typeCombo.selectedIndex, caseCheck); onChange(); });
startEd.setOnValueChangedHandler(onChange);
endCheck.setOnValueChangedHandler(onChange);
endEd.setOnValueChangedHandler(onChange);
startDateTB.setOnValueChangedHandler(onChange);
endDateTB.setOnValueChangedHandler(onChange);
formatTB.setOnValueChangedHandler(onChange);
incEd.setOnValueChangedHandler(onChange);
dirRadio.setOnValueChangedHandler(onChange);
repeatEd.setOnValueChangedHandler(onChange);
digitsEd.setOnValueChangedHandler(onChange);
caseCheck.setOnValueChangedHandler(onChange);
customTB.setOnValueChangedHandler(onChange);
prefixTB.setOnValueChangedHandler(onChange);
suffixTB.setOnValueChangedHandler(onChange);
textModeRadio.setOnValueChangedHandler(onChange);
placeholderTB.setOnValueChangedHandler(onChange);
arrangeCombo.setOnValueChangedHandler(onChange);
hRadio.setOnValueChangedHandler(onChange);
vRadio.setOnValueChangedHandler(onChange);
resetCheck.setOnValueChangedHandler(onChange);
combinedCheck.setOnValueChangedHandler(onChange);
sepTB.setOnValueChangedHandler(onChange);
attachAxisHandlers(rowCtrls);
attachAxisHandlers(colCtrls);

// ============================================================
// Presets
// ============================================================

function axisState(ctrls) {
    return {
        seqType: ctrls.typeCombo.selectedIndex,
        start: ctrls.startEd.value,
        inc: ctrls.incEd.value,
        dir: ctrls.dirRadio.selectedIndex,
        digits: ctrls.digitsEd.value,
        upperCase: ctrls.caseCheck.value,
        customList: ctrls.customTB.text,
        dateStart: ctrls.startDateTB.text,
        dateFormat: ctrls.formatTB.text
    };
}

function applyAxisState(ctrls, s) {
    if (!s) return;
    if (s.seqType !== undefined) ctrls.typeCombo.selectedIndex = s.seqType;
    if (s.start !== undefined) ctrls.startEd.value = s.start;
    if (s.inc !== undefined) ctrls.incEd.value = s.inc;
    if (s.dir !== undefined) ctrls.dirRadio.selectedIndex = s.dir;
    if (s.digits !== undefined) ctrls.digitsEd.value = s.digits;
    if (s.upperCase !== undefined) ctrls.caseCheck.value = s.upperCase;
    if (s.customList !== undefined) ctrls.customTB.text = s.customList;
    if (s.dateStart !== undefined) ctrls.startDateTB.text = s.dateStart;
    if (s.dateFormat !== undefined) ctrls.formatTB.text = s.dateFormat;
}

function collectState() {
    return {
        seqType: typeCombo.selectedIndex,
        start: startEd.value,
        end: endEd.value,
        useEnd: endCheck.value,
        inc: incEd.value,
        dir: dirRadio.selectedIndex,
        repeat: repeatEd.value,
        digits: digitsEd.value,
        upperCase: caseCheck.value,
        customList: customTB.text,
        dateStart: startDateTB.text,
        dateEnd: endDateTB.text,
        dateFormat: formatTB.text,
        prefix: prefixTB.text,
        suffix: suffixTB.text,
        textMode: textModeRadio.selectedIndex,
        placeholder: placeholderTB.text,
        arrangeMode: arrangeCombo.selectedIndex,
        hDir: hRadio.selectedIndex,
        vDir: vRadio.selectedIndex,
        resetPerGroup: resetCheck.value,
        combined: combinedCheck.value,
        separator: sepTB.text,
        rowAxis: axisState(rowCtrls),
        colAxis: axisState(colCtrls)
    };
}

function applyState(s) {
    if (s.seqType !== undefined) typeCombo.selectedIndex = s.seqType;
    if (s.start !== undefined) startEd.value = s.start;
    if (s.end !== undefined) endEd.value = s.end;
    if (s.useEnd !== undefined) endCheck.value = s.useEnd;
    if (s.inc !== undefined) incEd.value = s.inc;
    if (s.dir !== undefined) dirRadio.selectedIndex = s.dir;
    if (s.repeat !== undefined) repeatEd.value = s.repeat;
    if (s.digits !== undefined) digitsEd.value = s.digits;
    if (s.upperCase !== undefined) caseCheck.value = s.upperCase;
    if (s.customList !== undefined) customTB.text = s.customList;
    if (s.dateStart !== undefined) startDateTB.text = s.dateStart;
    if (s.dateEnd !== undefined) endDateTB.text = s.dateEnd;
    if (s.dateFormat !== undefined) formatTB.text = s.dateFormat;
    if (s.prefix !== undefined) prefixTB.text = s.prefix;
    if (s.suffix !== undefined) suffixTB.text = s.suffix;
    if (s.textMode !== undefined) textModeRadio.selectedIndex = s.textMode;
    if (s.placeholder !== undefined) placeholderTB.text = s.placeholder;
    if (s.arrangeMode !== undefined) arrangeCombo.selectedIndex = s.arrangeMode;
    if (s.hDir !== undefined) hRadio.selectedIndex = s.hDir;
    if (s.vDir !== undefined) vRadio.selectedIndex = s.vDir;
    if (s.resetPerGroup !== undefined) resetCheck.value = s.resetPerGroup;
    if (s.combined !== undefined) combinedCheck.value = s.combined;
    if (s.separator !== undefined) sepTB.text = s.separator;
    applyAxisState(rowCtrls, s.rowAxis);
    applyAxisState(colCtrls, s.colAxis);
    updateFieldVisibility();
    updatePreview();
}

btnSave.setOnClickHandler(() => {
    const name = app.prompt('Name for the preset:', 'Save Preset', 'Preset1');
    if (name && name.trim()) {
        try {
            FileSystemApi.createDirectories(presetDir);
            const path = presetDir + '/' + name.trim() + '.json';
            const f = File.create(path, 'wb');
            f.writeStringAsUtf8(JSON.stringify(collectState(), null, 2));
            f.close();
            app.alert('Preset saved:\n' + path, 'Numbering-Sequences');
        } catch (e) {
            app.alert('Error while saving: ' + e.message, 'Numbering-Sequences');
        }
    }
});

btnLoad.setOnClickHandler(() => {
    const path = app.chooseFile();
    if (path) {
        try {
            const buf = File.readAll(path);
            const state = JSON.parse(buf.toString());
            applyState(state);
        } catch (e) {
            app.alert('Error while loading: ' + e.message, 'Numbering-Sequences');
        }
    }
});

// Show a first preview as soon as the dialog opens
updatePreview();

const result = dlg.runModal();

if (!result || result.value === DialogResult.Cancel.value) {
    if (hasPreview) {
        rollbackToPosition(posBeforePreview);   // v4c: robust (undo fallback)
    }
}
// On OK, the last applied preview remains as the final result.

}
}
