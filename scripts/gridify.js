/**
 * name: Gridify
 * description: Rearrange selected objects into a grid with control over rows and columns, margins and sizes. Now with live preview!
 * version: 1.1.0
 * author: Nic Kraneis
 */

'use strict';
const { Document } = require('/document');
const { Dialog, DialogResult } = require('/dialog');
const { Selection } = require('/selections');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
const { Transform } = require('/geometry');
const { UnitType } = require('/units');

const doc = Document.current;

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

function snapshotSelection() {
    const s = doc.selection;
    const rawObjs = [];
    for (let i = 0; i < s.length; i++) {
        const n = s.at(i).node;
        const b = n.spreadBaseBox;
        rawObjs.push({
            n,
            x: b.x,
            y: b.y,
            w: b.width,
            h: b.height,
            cx: b.x + b.width / 2,
            cy: b.y + b.height / 2
        });
    }

    const objs = readingOrder(rawObjs);

    let minX = Infinity, minY = Infinity;
    let sumW = 0, sumH = 0;
    let maxW = 0, maxH = 0;

    for (const o of objs) {
        if (o.x < minX) minX = o.x;
        if (o.y < minY) minY = o.y;
        sumW += o.w;
        sumH += o.h;
        if (o.w > maxW) maxW = o.w;
        if (o.h > maxH) maxH = o.h;
    }

    return {
        objs,
        startX: minX,
        startY: minY,
        avgW: sumW / objs.length,
        avgH: sumH / objs.length,
        maxW,
        maxH
    };
}

function buildGridCommand(data, state) {
    const { objs, startX, startY, avgW, avgH, maxW, maxH } = data;
    const builder = CompoundCommandBuilder.create();
    const n = objs.length;

    const scaledObjs = objs.map(o => {
        let scale = 1;
        if (state.resizeMode === 1) scale = avgW / o.w;
        else if (state.resizeMode === 2) scale = avgH / o.h;
        else if (state.resizeMode === 3) scale = maxW / o.w;
        else if (state.resizeMode === 4) scale = maxH / o.h;

        return {
            ...o,
            scale,
            newW: o.w * scale,
            newH: o.h * scale
        };
    });

    const finalCellW = Math.max(...scaledObjs.map(o => o.newW));
    const finalCellH = Math.max(...scaledObjs.map(o => o.newH));

    let count = 0;
    for (let i = 0; i < n; i++) {
        const o = scaledObjs[i];
        const r = Math.floor(i / state.cols);
        const c = i % state.cols;

        const targetCX = startX + c * (finalCellW + state.gapX) + finalCellW / 2;
        const targetCY = startY + r * (finalCellH + state.gapY) + finalCellH / 2;

        const dx = targetCX - o.cx;
        const dy = targetCY - o.cy;

        let xform = Transform.createTranslate(dx, dy);

        if (Math.abs(o.scale - 1) > 0.0001) {
            const scaleXform = Transform.createTranslate(o.cx, o.cy)
                .multiply(Transform.createScale(o.scale, o.scale))
                .multiply(Transform.createTranslate(-o.cx, -o.cy));

            xform = xform.multiply(scaleXform);
        }

        const sel = Selection.create(doc, o.n, false);
        builder.addCommand(DocumentCommand.createTransform(sel, xform));
        count++;
    }

    return count === 0 ? null : builder.createCommand();
}

// ---- main ---------------------------------------------------------------

function main() {
    if (!doc) {
        const dlg = Dialog.create("Fehler");
        dlg.addColumn().addGroup("").addStaticText("", "Es muss ein Dokument geöffnet sein.");
        dlg.show();
        return;
    }

    if (doc.selection.length < 2) {
        const dlg = Dialog.create("Fehler");
        dlg.addColumn().addGroup("").addStaticText("", "Bitte wähle mindestens zwei Objekte aus.");
        dlg.show();
        return;
    }

    const data = snapshotSelection();
    const n = data.objs.length;
    const startCols = Math.ceil(Math.sqrt(n));

    const state = {
        cols: startCols,
        rows: Math.ceil(n / startCols),
        gapX: 20,
        gapY: 20,
    };

    const dlg = Dialog.create("Gridify");
    const col = dlg.addColumn();

    const gridG = col.addGroup("Grid");
    const colsCtrl = gridG.addUnitValueEditor("Columns", UnitType.Number, UnitType.Number, state.cols, 1, n).setPrecision(0);
    const rowsCtrl = gridG.addUnitValueEditor("Rows", UnitType.Number, UnitType.Number, state.rows, 1, n).setPrecision(0);

    const spaceG = col.addGroup("Margin");
    const gapXCtrl = spaceG.addUnitValueEditor("Horizontal Margin", UnitType.Pixel, doc.units, state.gapX, 0, 2000).setNoMaxValue();
    const gapYCtrl = spaceG.addUnitValueEditor("Vertical Margin", UnitType.Pixel, doc.units, state.gapY, 0, 2000).setNoMaxValue();

    const sizeG = col.addGroup("Scaling");
    const sizeCtrl = sizeG.addComboBox("Scale to...", [
        "No adjustment",
        "Average width",
        "Average height",
        "Max width",
        "Max height"
    ], state.resizeMode);

    let syncing = false;

    const render = (preview) => {
        const cmd = buildGridCommand(data, state);
        if (cmd) doc.executeCommand(cmd, preview);
        else doc.clearPreviews();
    };

    colsCtrl.onValueChangedHandler = () => {
        if (syncing) return;
        syncing = true;
        state.cols = Math.max(1, Math.min(Math.round(colsCtrl.value), n));
        state.rows = Math.ceil(n / state.cols);
        rowsCtrl.value = state.rows;
        colsCtrl.value = state.cols;
        syncing = false;
        render(true);
    };

    rowsCtrl.onValueChangedHandler = () => {
        if (syncing) return;
        syncing = true;
        const wantedRows = Math.max(1, Math.min(Math.round(rowsCtrl.value), n));
        state.cols = Math.max(1, Math.ceil(n / wantedRows));
        state.rows = Math.ceil(n / state.cols);
        colsCtrl.value = state.cols;
        rowsCtrl.value = state.rows;
        syncing = false;
        render(true);
    };

    gapXCtrl.onValueChangedHandler = () => {
        if (syncing) return;
        state.gapX = gapXCtrl.value;
        render(true);
    };

    gapYCtrl.onValueChangedHandler = () => {
        if (syncing) return;
        state.gapY = gapYCtrl.value;
        render(true);
    };

    sizeCtrl.onValueChangedHandler = () => {
        if (syncing) return;
        state.resizeMode = sizeCtrl.selectedIndex;
        render(true);
    };

    render(true);

    if (dlg.runModal() == DialogResult.Ok) {
        render(false);
    } else {
        doc.clearPreviews();
    }
}

main();
