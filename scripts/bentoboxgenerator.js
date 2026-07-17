/**
 * name: Bento Box Generator
 * description: Generates a Bento Grid on the current page/artboard with live preview.
 * version: 2.7
 * author: JiriKrblich / Claude
 *
 * v2.7 crash fixes:
 *  - Reentrancy guard around rebuild(): a value-changed handler can be re-entered
 *    while executeCommand pumps native events; without a guard the shared
 *    currentNodes list gets clobbered and delete/add interleave -> native crash
 *    (typically on commit/Apply). The guard serialises all preview updates.
 *  - Geometry guard: skip building when padding/gap make a cell <= 0 px.
 *  - v2.6 tried to restore the current spread with createSetCurrentSpread() on
 *    Cancel; that itself crashed (setting the spread to the already-current spread
 *    right after an aborted modal). Removed — Cancel just deletes the preview nodes,
 *    exactly like v2.5 which was stable on Cancel.
 */
'use strict';
const { Document } = require('/document');
const { Dialog, DialogResult } = require('/dialog');
const { AddChildNodesCommandBuilder, NodeChildType, DocumentCommand } = require('/commands');
const { Selection } = require('/selections');
const { UnitType } = require('/units');
const { Rectangle } = require('/geometry');
const { ShapeRectangle, ShapeCornerType } = require('/shapes');
const { Colour } = require('/colours');
const { FillDescriptor } = require('/fills');
const { ShapeNodeDefinition } = require('/nodes');

let config = { blockCount: 8, cornerRadius: 15, padding: 40, gap: 20, fillMode: 0 };

function computeParams(n) {
    if (n <= 3) return { gridSize: Math.max(6, n * 2), maxSpan: 999, minCells: 1 };
    const gs = Math.max(n + 4, 12);
    return { gridSize: gs, maxSpan: Math.floor(gs * 0.65), minCells: 2 };
}
function splitRect(r, doH, minCells, maxSpan) {
    if (doH) {
        const lo = Math.max(minCells, r.w - maxSpan);
        const hi = Math.min(r.w - minCells, maxSpan);
        const slo = Math.max(lo, Math.floor(r.w * 0.25));
        const shi = Math.min(hi, Math.floor(r.w * 0.75));
        const flo = slo <= shi ? slo : lo;
        const fhi = slo <= shi ? shi : hi;
        if (flo > fhi) return null;
        const s = flo + Math.floor(Math.random() * (fhi - flo + 1));
        return [{ col: r.col, row: r.row, w: s, h: r.h },
                { col: r.col + s, row: r.row, w: r.w - s, h: r.h }];
    } else {
        const lo = Math.max(minCells, r.h - maxSpan);
        const hi = Math.min(r.h - minCells, maxSpan);
        const slo = Math.max(lo, Math.floor(r.h * 0.25));
        const shi = Math.min(hi, Math.floor(r.h * 0.75));
        const flo = slo <= shi ? slo : lo;
        const fhi = slo <= shi ? shi : hi;
        if (flo > fhi) return null;
        const s = flo + Math.floor(Math.random() * (fhi - flo + 1));
        return [{ col: r.col, row: r.row, w: r.w, h: s },
                { col: r.col, row: r.row + s, w: r.w, h: r.h - s }];
    }
}
function tryGenerate(n, gridSize, maxSpan, minCells) {
    let rects = [{ col: 0, row: 0, w: gridSize, h: gridSize }];
    for (let i = 0; i < 500; i++) {
        const idx = rects.findIndex(r => r.w > maxSpan || r.h > maxSpan);
        if (idx < 0) break;
        const r = rects.splice(idx, 1)[0];
        const overH = r.w > maxSpan, overV = r.h > maxSpan;
        const doH = overH && !overV ? true : !overH && overV ? false : Math.random() < 0.5;
        const pieces = splitRect(r, doH, minCells, maxSpan) || splitRect(r, !doH, minCells, maxSpan);
        if (!pieces) { rects.push(r); break; }
        rects.push(...pieces);
    }
    while (rects.length < n) {
        const eligible = rects.filter(r => r.w >= 2 * minCells || r.h >= 2 * minCells);
        if (!eligible.length) break;
        const total = eligible.reduce((s, r) => s + r.w * r.h, 0);
        let pick = Math.random() * total, chosen = eligible[eligible.length - 1];
        for (const r of eligible) { pick -= r.w * r.h; if (pick <= 0) { chosen = r; break; } }
        rects.splice(rects.indexOf(chosen), 1);
        const cH = chosen.w >= 2 * minCells, cV = chosen.h >= 2 * minCells;
        const doH = cH && cV ? Math.random() < chosen.w / (chosen.w + chosen.h) : cH;
        const pieces = splitRect(chosen, doH, minCells, 9999);
        if (!pieces) { rects.push(chosen); break; }
        rects.push(...pieces);
    }
    return rects.map(r => [r.col, r.row, r.w, r.h]);
}
function generateControlledLayout(n, canvasAspect) {
    const { gridSize, maxSpan, minCells } = computeParams(n);
    for (let attempt = 0; attempt < 200; attempt++) {
        const layout = tryGenerate(n, gridSize, maxSpan, minCells);
        const valid = layout.length === n &&
            layout.reduce((s, [,, w, h]) => s + w * h, 0) === gridSize * gridSize &&
            layout.every(([,, w, h]) => w <= maxSpan && h <= maxSpan) &&
            layout.every(([,, w, h]) => { const ar = (w * canvasAspect) / h; return ar >= 0.25 && ar <= 4.0; });
        if (valid) return { layout, gridSize };
    }
    return { layout: tryGenerate(n, gridSize, maxSpan, minCells), gridSize };
}
function createPreviewPlan(blockCount, canvasAspect) {
    const generated = generateControlledLayout(blockCount, canvasAspect);
    generated.swatches = generated.layout.map(() => ({ r: Math.random(), g: Math.random(), b: Math.random(), shade: Math.random() }));
    return generated;
}
function detectTarget() {
    const doc = Document.current;
    const spread = doc.currentSpread;
    const sel = doc.selection;
    if (sel.length > 0) {
        let node = sel.at(0).node;
        while (node && node[Symbol.toStringTag] !== 'SpreadNode') {
            try {
                const abi = node.artboardInterface;
                if (abi && abi.isArtboardEnabled) {
                    const artboardNode = abi.node || node;
                    return { node: artboardNode, box: abi.baseBox, label: abi.description };
                }
            } catch (e) {}
            node = node.parent;
        }
    }
    const box = spread.getSpreadExtents();
    return { node: spread, box, label: 'Spread' };
}
function cellSizes(box, gridSize) {
    return {
        cellW: (box.width  - 2 * config.padding - (gridSize - 1) * config.gap) / gridSize,
        cellH: (box.height - 2 * config.padding - (gridSize - 1) * config.gap) / gridSize
    };
}
function createBentoCommand(target, plan) {
    const { node: insertNode, box } = target;
    const { layout, gridSize, swatches } = plan;
    const { cellW, cellH } = cellSizes(box, gridSize);
    const builder = AddChildNodesCommandBuilder.create();
    builder.setInsertionTarget(insertNode);
    const isGrayscale = config.fillMode === 1;
    layout.forEach(([c, r, w, h], i) => {
        const x = box.x + config.padding + c * (cellW + config.gap);
        const y = box.y + config.padding + r * (cellH + config.gap);
        const W = w * cellW + (w - 1) * config.gap;
        const H = h * cellH + (h - 1) * config.gap;
        const shape = ShapeRectangle.create();
        shape.setAbsoluteSizes(true, W, H);
        [shape.topLeft, shape.topRight, shape.bottomLeft, shape.bottomRight].forEach(corner => {
            corner.cornerType = ShapeCornerType.Round;
            corner.setRadius(Math.min(config.cornerRadius, W / 2, H / 2), W, H);
        });
        let colour;
        const swatch = swatches[i] || { r: 0.5, g: 0.5, b: 0.5, shade: 0.5 };
        if (isGrayscale) {
            const v = 0.82 + (i / layout.length) * 0.14 + (swatch.shade - 0.5) * 0.04;
            colour = Colour.createRGBAuf({ r: v, g: v, b: v, alpha: 1.0 });
        } else {
            colour = Colour.createRGBAuf({ r: swatch.r, g: swatch.g, b: swatch.b, alpha: 1.0 });
        }
        const nodeDef = ShapeNodeDefinition.create(shape, new Rectangle(x, y, W, H), FillDescriptor.createSolid(colour));
        builder.addShapeNode(nodeDef);
    });
    return builder.createCommand(true, NodeChildType.Main);
}

function main() {
    const doc = Document.current;
    if (!doc) return;

    const target = detectTarget();
    const dlg = Dialog.create('Bento Box Generator');
    dlg.initialWidth = 380;
    const col = dlg.addColumn();

    const infoGrp = col.addGroup('Target');
    infoGrp.addStaticText('', `${target.label}  (${Math.round(target.box.width)} x ${Math.round(target.box.height)} px)`).isFullWidth = true;

    const grp = col.addGroup('Settings');
    const blockCtrl = grp.addUnitValueEditor('Block count', UnitType.None, UnitType.None, config.blockCount, 3, 16);
    blockCtrl.showPopupSlider = true; blockCtrl.precision = 0;
    const radiusCtrl = grp.addUnitValueEditor('Corner radius', UnitType.Pixel, UnitType.Pixel, config.cornerRadius, 0, 200);
    radiusCtrl.showPopupSlider = true;
    const paddingCtrl = grp.addUnitValueEditor('Padding', UnitType.Pixel, UnitType.Pixel, config.padding, 0, 200);
    paddingCtrl.showPopupSlider = true;
    const gapCtrl = grp.addUnitValueEditor('Gap', UnitType.Pixel, UnitType.Pixel, config.gap, 0, 100);
    gapCtrl.showPopupSlider = true;

    const fillGrp = col.addGroup('Fill');
    const modeLabels = ['Color', 'Grayscale'];
    const modeCombo = fillGrp.addComboBox('Mode', modeLabels, config.fillMode);
    modeCombo.isFullWidth = true;

    const actGrp = col.addGroup('Actions');
    const statusTxt = actGrp.addStaticText('', '');
    statusTxt.isFullWidth = true;
    const regenBtn = actGrp.addButton('Regenerate layout');
    regenBtn.isFullWidth = true;

    function readConfig() {
        config.blockCount = Math.round(blockCtrl.value);
        config.cornerRadius = radiusCtrl.value;
        config.padding = paddingCtrl.value;
        config.gap = gapCtrl.value;
        config.fillMode = modeCombo.selectedIndex;
    }

    let previewPlan = null;
    function ensurePreviewPlan(forceNewLayout) {
        const canvasAspect = target.box.width / target.box.height;
        if (forceNewLayout || !previewPlan || previewPlan.layout.length !== config.blockCount) {
            previewPlan = createPreviewPlan(config.blockCount, canvasAspect);
        }
    }

    // Track committed nodes so we can remove them explicitly (no clearPreviews()).
    let currentNodes = [];
    function deleteCurrent() {
        if (currentNodes.length > 0) {
            const sel = Selection.create(doc, currentNodes);
            doc.executeCommand(DocumentCommand.createDeleteSelection(sel));
            currentNodes = [];
        }
    }

    // Reentrancy guard: executeCommand can pump native events and re-enter a
    // value-changed handler mid-rebuild; without this, currentNodes is clobbered
    // and delete/add interleave -> native crash (often on Apply).
    let updating = false;
    function rebuild(forceNewLayout) {
        if (updating) return false;
        updating = true;
        try {
            readConfig();
            ensurePreviewPlan(forceNewLayout);
            const { cellW, cellH } = cellSizes(target.box, previewPlan.gridSize);
            if (!(cellW > 0.5) || !(cellH > 0.5)) {
                statusTxt.text = 'Padding / gap too large for this canvas — reduce them.';
                return false; // keep the last valid grid on canvas
            }
            deleteCurrent();
            const cmd = createBentoCommand(target, previewPlan);
            doc.executeCommand(cmd);            // commit (no preview flag)
            currentNodes = cmd.newNodes || [];
            statusTxt.text = `${config.blockCount} blocks - ${modeLabels[config.fillMode]}`;
            return true;
        } catch (e) {
            statusTxt.text = 'Error: ' + e.message;
            return false;
        } finally {
            updating = false;
        }
    }

    // Event-driven wiring (new Dialog API).
    [blockCtrl, radiusCtrl, paddingCtrl, gapCtrl].forEach(c =>
        c.setOnValueChangedHandler(() => rebuild(false)));
    modeCombo.setOnValueChangedHandler(() => rebuild(false));
    regenBtn.setOnClickHandler(() => rebuild(true));

    rebuild(true);                              // initial layout

    // runModal() THROWS 'ABORTED' when the user cancels. Treat non-OK as Cancel.
    let apply = false;
    try {
        const result = dlg.runModal();
        apply = (result.value === DialogResult.Ok.value);
    } catch (e) {
        apply = false;
    }

    if (apply) {
        // Apply: keep the committed nodes as-is.
    } else {
        // Cancel: just remove the preview nodes (no clearPreviews, no spread reset).
        deleteCurrent();
    }
}

main();