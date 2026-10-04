/**
 * name: Gridify
 * description: Spread selected objects into a grid with various options of spacing, scaling and jitter.
 * version: 1.2.0
 * author: Nic Kraneis
 *
 * 1.2.0
 *  - Jitter: position X/Y (px), rotation (°), size (%) with seed and
 *    "New seed" button. Every object always draws the same four random
 *    numbers, so changing one amount does not reshuffle the others.
 *  - Cell size: "Uniform" (largest object, as before) or "Per column /
 *    per row" (each column as wide as its widest object, each row as high
 *    as its tallest one) – keeps mixed widths (e.g. text) compact.
 * 1.1.1 – checked against current Affinity SDK (3.3):
 *  - Dialog.show() -> runModal(); dialog result compared via .value;
 *    resizeMode initialised; unit editor start values set explicitly.
 */

'use strict';
const { Document } = require('/document');
const { Dialog, DialogResult } = require('/dialog');
const { Selection } = require('/selections');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
const { Transform } = require('/geometry');
const { UnitType } = require('/units');

const doc = Document.current;

// ---- helpers -------------------------------------------------------------

function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function randomSeed() {
    return 1 + Math.floor(Math.random() * 99999);
}

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
            x: b.x, y: b.y, w: b.width, h: b.height,
            cx: b.x + b.width / 2,
            cy: b.y + b.height / 2
        });
    }

    const objs = readingOrder(rawObjs);

    let minX = Infinity, minY = Infinity;
    let sumW = 0, sumH = 0, maxW = 0, maxH = 0;
    for (const o of objs) {
        if (o.x < minX) minX = o.x;
        if (o.y < minY) minY = o.y;
        sumW += o.w; sumH += o.h;
        if (o.w > maxW) maxW = o.w;
        if (o.h > maxH) maxH = o.h;
    }

    return {
        objs,
        startX: minX, startY: minY,
        avgW: sumW / objs.length, avgH: sumH / objs.length,
        maxW, maxH
    };
}

// ---- grid ----------------------------------------------------------------

function buildGridCommand(data, state) {
    const { objs, startX, startY, avgW, avgH, maxW, maxH } = data;
    const n = objs.length;
    if (n === 0) return null;

    const cols = Math.max(1, state.cols);
    const rows = Math.ceil(n / cols);

    const scaledObjs = objs.map(o => {
        let scale = 1;
        if (state.resizeMode === 1) scale = avgW / o.w;
        else if (state.resizeMode === 2) scale = avgH / o.h;
        else if (state.resizeMode === 3) scale = maxW / o.w;
        else if (state.resizeMode === 4) scale = maxH / o.h;
        if (!isFinite(scale) || scale <= 0) scale = 1;
        return { ...o, scale, newW: o.w * scale, newH: o.h * scale };
    });

    // Cell sizes: uniform, or per column / per row
    const colW = new Array(cols).fill(0);
    const rowH = new Array(rows).fill(0);
    if (state.cellMode === 1) {
        scaledObjs.forEach((o, i) => {
            const c = i % cols, r = Math.floor(i / cols);
            if (o.newW > colW[c]) colW[c] = o.newW;
            if (o.newH > rowH[r]) rowH[r] = o.newH;
        });
    } else {
        const cw = Math.max(...scaledObjs.map(o => o.newW));
        const ch = Math.max(...scaledObjs.map(o => o.newH));
        colW.fill(cw);
        rowH.fill(ch);
    }

    // Left / top edge of each column / row
    const colX = [], rowY = [];
    let acc = startX;
    for (let c = 0; c < cols; c++) { colX.push(acc); acc += colW[c] + state.gapX; }
    acc = startY;
    for (let r = 0; r < rows; r++) { rowY.push(acc); acc += rowH[r] + state.gapY; }

    const rng = mulberry32(state.seed);
    const builder = CompoundCommandBuilder.create();

    for (let i = 0; i < n; i++) {
        const o = scaledObjs[i];
        const c = i % cols, r = Math.floor(i / cols);

        // Always draw all four values (stable jitter per object)
        const jx = rng() * 2 - 1;
        const jy = rng() * 2 - 1;
        const jr = rng() * 2 - 1;
        const js = rng() * 2 - 1;

        const targetCX = colX[c] + colW[c] / 2 + jx * state.jitterX;
        const targetCY = rowY[r] + rowH[r] / 2 + jy * state.jitterY;
        const rot = jr * state.jitterRot * Math.PI / 180;
        const scale = o.scale * Math.max(0.01, 1 + js * state.jitterScale / 100);

        // B applied before A in A.multiply(B):
        // move centre to origin -> scale -> rotate -> move to target centre
        let xform = Transform.createTranslate(targetCX, targetCY);
        if (Math.abs(rot) > 1e-6) xform = xform.multiply(Transform.createRotate(rot));
        if (Math.abs(scale - 1) > 1e-4) xform = xform.multiply(Transform.createScale(scale, scale));
        xform = xform.multiply(Transform.createTranslate(-o.cx, -o.cy));

        builder.addCommand(DocumentCommand.createTransform(Selection.create(doc, o.n, false), xform));
    }

    return builder.createCommand();
}

// ---- main ----------------------------------------------------------------

function message(text) {
    const dlg = Dialog.create("Fehler");
    dlg.addColumn().addGroup("").addStaticText("", text);
    dlg.runModal();
}

function main() {
    if (!doc) { message("Es muss ein Dokument geöffnet sein."); return; }
    if (doc.selection.length < 2) { message("Bitte wähle mindestens zwei Objekte aus."); return; }

    const data = snapshotSelection();
    const n = data.objs.length;
    const startCols = Math.ceil(Math.sqrt(n));

    const state = {
        cols: startCols,
        rows: Math.ceil(n / startCols),
        gapX: 20,
        gapY: 20,
        resizeMode: 0,
        cellMode: 0,
        jitterX: 0,
        jitterY: 0,
        jitterRot: 0,
        jitterScale: 0,
        seed: randomSeed(),
    };

    const dlg = Dialog.create("Gridify");
    const colL = dlg.addColumn();
    const colR = dlg.addColumn();

    // Left column: grid, margin, scaling
    const gridG = colL.addGroup("Grid");
    const colsCtrl = gridG.addUnitValueEditor("Columns", UnitType.Number, UnitType.Number, state.cols, 1, n).setPrecision(0);
    const rowsCtrl = gridG.addUnitValueEditor("Rows", UnitType.Number, UnitType.Number, state.rows, 1, n).setPrecision(0);
    const cellCtrl = gridG.addComboBox("Cell size", [
        "Uniform (largest object)",
        "Per column / per row"
    ], state.cellMode);

    const spaceG = colL.addGroup("Margin");
    const gapXCtrl = spaceG.addUnitValueEditor("Horizontal Margin", UnitType.Pixel, doc.units, state.gapX, 0, 2000).setNoMaxValue();
    const gapYCtrl = spaceG.addUnitValueEditor("Vertical Margin", UnitType.Pixel, doc.units, state.gapY, 0, 2000).setNoMaxValue();

    const sizeG = colL.addGroup("Scaling");
    const sizeCtrl = sizeG.addComboBox("Scale to...", [
        "No adjustment",
        "Average width",
        "Average height",
        "Max width",
        "Max height"
    ], state.resizeMode);

    // Right column: jitter
    const jitG = colR.addGroup("Jitter");
    const jxCtrl = jitG.addUnitValueEditor("Position X (±)", UnitType.Pixel, doc.units, state.jitterX, 0, 2000).setNoMaxValue();
    const jyCtrl = jitG.addUnitValueEditor("Position Y (±)", UnitType.Pixel, doc.units, state.jitterY, 0, 2000).setNoMaxValue();
    const jrCtrl = jitG.addUnitValueEditor("Rotation (±°)", UnitType.Number, UnitType.Number, state.jitterRot, 0, 180);
    const jsCtrl = jitG.addUnitValueEditor("Size (±%)", UnitType.Number, UnitType.Number, state.jitterScale, 0, 90);
    jrCtrl.showPopupSlider = true;
    jsCtrl.showPopupSlider = true;

    const seedG = colR.addGroup("Random");
    const seedCtrl = seedG.addUnitValueEditor("Seed", UnitType.Number, UnitType.Number, state.seed, 1, 99999).setPrecision(0);
    const seedBtn = seedG.addButton("New seed");

    // Start values explicitly (initial values are not reliably taken over)
    colsCtrl.value = state.cols;
    rowsCtrl.value = state.rows;
    cellCtrl.selectedIndex = state.cellMode;
    gapXCtrl.value = state.gapX;
    gapYCtrl.value = state.gapY;
    sizeCtrl.selectedIndex = state.resizeMode;
    jxCtrl.value = state.jitterX;
    jyCtrl.value = state.jitterY;
    jrCtrl.value = state.jitterRot;
    jsCtrl.value = state.jitterScale;
    seedCtrl.value = state.seed;

    let syncing = false;

    const render = (preview) => {
        const cmd = buildGridCommand(data, state);
        if (cmd) doc.executeCommand(cmd, preview);
        else doc.clearPreviews();
    };

    const num = (v, fallback) => (isFinite(Number(v)) ? Number(v) : fallback);

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

    // Simple controls: read value into state, re-render
    const bind = (ctrl, read) => {
        ctrl.onValueChangedHandler = () => {
            if (syncing) return;
            read();
            render(true);
        };
    };

    bind(cellCtrl, () => { state.cellMode = cellCtrl.selectedIndex; });
    bind(gapXCtrl, () => { state.gapX = num(gapXCtrl.value, 0); });
    bind(gapYCtrl, () => { state.gapY = num(gapYCtrl.value, 0); });
    bind(sizeCtrl, () => { state.resizeMode = sizeCtrl.selectedIndex; });
    bind(jxCtrl, () => { state.jitterX = Math.max(0, num(jxCtrl.value, 0)); });
    bind(jyCtrl, () => { state.jitterY = Math.max(0, num(jyCtrl.value, 0)); });
    bind(jrCtrl, () => { state.jitterRot = Math.max(0, num(jrCtrl.value, 0)); });
    bind(jsCtrl, () => { state.jitterScale = Math.max(0, Math.min(90, num(jsCtrl.value, 0))); });
    bind(seedCtrl, () => { state.seed = Math.max(1, Math.round(num(seedCtrl.value, 1))); });

    seedBtn.setOnClickHandler(() => {
        state.seed = randomSeed();
        syncing = true;
        seedCtrl.value = state.seed;
        syncing = false;
        render(true);
    });

    render(true);

    const result = dlg.runModal();
    if (result && result.value === DialogResult.Ok.value) {
        render(false);
    } else {
        doc.clearPreviews();
    }
}

main();
