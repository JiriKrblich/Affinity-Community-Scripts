'use strict';
const { Document } = require('/document');
const { Dialog, DialogResult } = require('/dialog');
const { Selection } = require('/selections');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
const { Transform } = require('/geometry');
const { UnitType } = require('/units');

const doc = Document.current;

// ---- helpers -------------------------------------------------------------

function cluster(items, key, tol) {
    const sorted = [...items].sort((a, b) => key(a) - key(b));
    const groups = [];
    for (const it of sorted) {
        const v = key(it);
        let g = groups.find(g => Math.abs(g.center - v) <= tol);
        if (g) { g.items.push(it); g.sum += v; g.center = g.sum / g.items.length; }
        else groups.push({ center: v, sum: v, items: [it] });
    }
    return groups;
}

function median(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function snapshotSelection() {
    const s = doc.selection;
    const objs = [];
    for (let i = 0; i < s.length; i++) {
        const n = s.at(i).node;
        const b = n.spreadBaseBox;
        objs.push({ n, x: b.x, y: b.y, w: b.width, h: b.height, cx: b.x + b.width / 2, cy: b.y + b.height / 2 });
    }
    return objs;
}

function tolFor(objs) {
    const minDim = Math.min(...objs.map(o => Math.min(o.w, o.h)));
    return Math.max(minDim * 0.5, 1);
}

function readingOrder(objs) {
    const rows = cluster(objs, o => o.cy, tolFor(objs)).sort((a, b) => a.center - b.center);
    const ordered = [];
    for (const row of rows) {
        row.items.sort((a, b) => a.cx - b.cx);
        for (const o of row.items) ordered.push(o);
    }
    return ordered;
}

function detectColumns(objs) {
    return cluster(objs, o => o.cx, tolFor(objs)).length;
}

function detectSpacing(objs) {
    const tol = tolFor(objs);
    const rows = cluster(objs, o => o.cy, tol).sort((a, b) => a.center - b.center);
    const cols = cluster(objs, o => o.cx, tol).sort((a, b) => a.center - b.center);
    const hGaps = [];
    for (const row of rows) {
        const its = [...row.items].sort((a, b) => a.x - b.x);
        for (let i = 1; i < its.length; i++) hGaps.push(its[i].x - (its[i - 1].x + its[i - 1].w));
    }
    const vGaps = [];
    for (const col of cols) {
        const its = [...col.items].sort((a, b) => a.y - b.y);
        for (let i = 1; i < its.length; i++) vGaps.push(its[i].y - (its[i - 1].y + its[i - 1].h));
    }
    return { h: Math.max(0, hGaps.length ? median(hGaps) : 0), v: Math.max(0, vGaps.length ? median(vGaps) : 0) };
}

function placementsToCommand(placements) {
    const builder = CompoundCommandBuilder.create();
    let count = 0;
    for (const p of placements) {
        const dx = p.targetX - p.o.x, dy = p.targetY - p.o.y;
        if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6) {
            const sel = Selection.create(doc, p.o.n, false);
            builder.addCommand(DocumentCommand.createTransform(sel, Transform.createTranslate(dx, dy)));
            count++;
        }
    }
    return count === 0 ? null : builder.createCommand();
}

// MODE A — keep the existing grid shape, just retidy positions & spacing.
function buildKeepShape(objs, hSpace, vSpace, align) {
    const tol = tolFor(objs);
    const rowGroups = cluster(objs, o => o.cy, tol).sort((a, b) => a.center - b.center);
    const colGroups = cluster(objs, o => o.cx, tol).sort((a, b) => a.center - b.center);
    const colIndexOf = (o) => colGroups.findIndex(g => g.items.includes(o));
    const originX = Math.min(...objs.map(o => o.x));
    const originY = Math.min(...objs.map(o => o.y));
    const colWidth = colGroups.map(g => Math.max(...g.items.map(o => o.w)));
    const rowHeight = rowGroups.map(g => Math.max(...g.items.map(o => o.h)));
    const colX = []; let cx = originX;
    for (let c = 0; c < colGroups.length; c++) { colX[c] = cx; cx += colWidth[c] + hSpace; }
    const rowY = []; let cy = originY;
    for (let r = 0; r < rowGroups.length; r++) { rowY[r] = cy; cy += rowHeight[r] + vSpace; }

    const placements = [];
    for (let r = 0; r < rowGroups.length; r++) {
        for (const o of rowGroups[r].items) {
            const c = colIndexOf(o);
            let targetX = colX[c];
            let targetY = rowY[r] + (rowHeight[r] - o.h) / 2;
            if (align === 1) targetX += (colWidth[c] - o.w) / 2;
            else if (align === 2) targetX += (colWidth[c] - o.w);
            placements.push({ o, targetX, targetY });
        }
    }
    return placementsToCommand(placements);
}

// MODE B — reflow into an explicit column count (rows follow automatically).
function buildReflow(objs, cols, hSpace, vSpace, align) {
    const ordered = readingOrder(objs);
    const n = ordered.length;
    cols = Math.max(1, Math.min(Math.round(cols), n));
    const cellW = Math.max(...objs.map(o => o.w));
    const cellH = Math.max(...objs.map(o => o.h));
    const originX = Math.min(...objs.map(o => o.x));
    const originY = Math.min(...objs.map(o => o.y));

    const placements = [];
    for (let i = 0; i < n; i++) {
        const r = Math.floor(i / cols), c = i % cols;
        const cellX = originX + c * (cellW + hSpace);
        const cellY = originY + r * (cellH + vSpace);
        const o = ordered[i];
        let targetX = cellX;
        let targetY = cellY + (cellH - o.h) / 2;
        if (align === 1) targetX += (cellW - o.w) / 2;
        else if (align === 2) targetX += (cellW - o.w);
        placements.push({ o, targetX, targetY });
    }
    return placementsToCommand(placements);
}

// ---- main ---------------------------------------------------------------

function main() {
    if (!doc) { alert("This script requires an open document"); return; }
    if (doc.selection.length < 2) { alert("Select at least two objects or artboards to arrange into a grid."); return; }

    const objs = snapshotSelection();
    const n = objs.length;
    const detectedCols = Math.max(1, Math.min(detectColumns(objs), n));
    const spacing = detectSpacing(objs);

    // Single source of truth for the desired layout. Handlers mutate this, never
    // relying on reading values back out of sibling controls.
    const state = {
        mode: 0,                         // 0 = keep shape, 1 = reflow
        cols: detectedCols,
        rows: Math.ceil(n / detectedCols),
        h: spacing.h,
        v: spacing.v,
        link: false,
        align: 0
    };

    const dlg = Dialog.create("Grid Arrange");
    const col = dlg.addColumn();

    const layoutG = col.addGroup("Layout");
    dlg.mode = layoutG.addComboBox("Mode", ["Keep current shape", "Set rows & columns"], 0);
    dlg.cols = layoutG.addUnitValueEditor("Columns", UnitType.Number, UnitType.Number, state.cols, 1, n).setPrecision(0);
    dlg.rows = layoutG.addUnitValueEditor("Rows", UnitType.Number, UnitType.Number, state.rows, 1, n).setPrecision(0);

    const spaceG = col.addGroup("Spacing");
    dlg.h = spaceG.addUnitValueEditor("Horizontal", UnitType.Pixel, doc.units, state.h, 0, state.h).setNoMaxValue();
    dlg.v = spaceG.addUnitValueEditor("Vertical", UnitType.Pixel, doc.units, state.v, 0, state.v).setNoMaxValue();
    dlg.link = spaceG.addSwitch("Link horizontal & vertical", false);

    const alignG = col.addGroup("Alignment within cell");
    dlg.align = alignG.addComboBox("Horizontal", ["Left", "Centre", "Right"], 0);

    let syncing = false;

    const render = (preview) => {
        const hv = state.h;
        const vv = state.link ? state.h : state.v;
        const cmd = state.mode === 1
            ? buildReflow(objs, state.cols, hv, vv, state.align)
            : buildKeepShape(objs, hv, vv, state.align);
        if (cmd) doc.executeCommand(cmd, preview);
        else doc.clearPreviews();
    };

    // Per-control handlers: each knows exactly which control fired, so there is no
    // dependence on a ctrl argument being passed to a dialog-level handler.
    dlg.mode.onValueChangedHandler = () => {
        if (syncing) return;
        state.mode = dlg.mode.selectedIndex;
        render(true);
    };

    dlg.cols.onValueChangedHandler = () => {
        if (syncing) return;
        syncing = true;
        const c = Math.max(1, Math.min(Math.round(dlg.cols.value), n));
        state.cols = c;
        state.rows = Math.ceil(n / c);
        state.mode = 1;
        // reflect back into the UI
        dlg.cols.value = c;
        dlg.rows.value = state.rows;
        dlg.mode.selectedIndex = 1;
        syncing = false;
        render(true);
    };

    dlg.rows.onValueChangedHandler = () => {
        if (syncing) return;
        syncing = true;
        const wantedRows = Math.max(1, Math.min(Math.round(dlg.rows.value), n));
        const c = Math.max(1, Math.ceil(n / wantedRows));
        state.cols = c;
        state.rows = Math.ceil(n / c);   // actual achievable rows for that column count
        state.mode = 1;
        dlg.cols.value = c;
        dlg.rows.value = state.rows;
        dlg.mode.selectedIndex = 1;
        syncing = false;
        render(true);
    };

    dlg.h.onValueChangedHandler = () => {
        if (syncing) return;
        syncing = true;
        state.h = dlg.h.value;
        if (state.link) { state.v = state.h; dlg.v.value = state.h; }
        syncing = false;
        render(true);
    };

    dlg.v.onValueChangedHandler = () => {
        if (syncing) return;
        syncing = true;
        state.v = dlg.v.value;
        if (state.link) { state.h = state.v; dlg.h.value = state.v; }
        syncing = false;
        render(true);
    };

    dlg.link.onValueChangedHandler = () => {
        if (syncing) return;
        syncing = true;
        state.link = dlg.link.value;
        if (state.link) { state.v = state.h; dlg.v.value = state.h; }
        syncing = false;
        render(true);
    };

    dlg.align.onValueChangedHandler = () => {
        if (syncing) return;
        state.align = dlg.align.selectedIndex;
        render(true);
    };

    render(true);
    if (dlg.runModal() == DialogResult.Ok) render(false);
    else doc.clearPreviews();
}

main();
