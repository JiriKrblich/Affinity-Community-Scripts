/**
 * name: Bento Box Generator
 * description: Generates Bento Grid/Box on the current page/artboard
 * version: 1.1.0
 * author: JiriKrblich
 * changelog:
 *   v1.1 – Fix corner radius (cornerType must be set before radius);
 *           add Preview/Apply workflow identical to Tile Generator
 */

'use strict';
const { Document } = require('/document');
const { Dialog, DialogResult } = require('/dialog');
const { DocumentCommand, AddChildNodesCommandBuilder, NodeChildType } = require('/commands');
const { UnitType } = require('/units');
const { Rectangle } = require('/geometry');
const { ShapeRectangle, ShapeCornerType } = require('/shapes');
const { Colour } = require('/colours');
const { FillDescriptor } = require('/fills');
const { ShapeNodeDefinition } = require('/nodes');

let config = { blockCount: 8, cornerRadius: 15, padding: 40, gap: 20, colorFill: true };

// ── Layout algorithm ──────────────────────────────────────────────────────────

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
        return [{ col: r.col,     row: r.row, w: s,       h: r.h },
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
        return [{ col: r.col, row: r.row,     w: r.w, h: s       },
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
        const pieces = splitRect(r, doH, minCells, maxSpan)
                    || splitRect(r, !doH, minCells, maxSpan);
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
        const valid =
            layout.length === n &&
            layout.reduce((s, [,, w, h]) => s + w * h, 0) === gridSize * gridSize &&
            layout.every(([,, w, h]) => w <= maxSpan && h <= maxSpan) &&
            layout.every(([,, w, h]) => {
                const ar = (w * canvasAspect) / h;
                return ar >= 0.25 && ar <= 4.0;
            });
        if (valid) return { layout, gridSize };
    }
    return { layout: tryGenerate(n, gridSize, maxSpan, minCells), gridSize };
}

// ── Target detection ──────────────────────────────────────────────────────────

function detectTarget() {
    const doc = Document.current;
    const spread = doc.currentSpread;
    const sel = doc.selection;

    if (sel.length > 0) {
        let node = sel.nodes.first;
        while (node && node[Symbol.toStringTag] !== 'SpreadNode') {
            const abi = node.artboardInterface;
            if (abi && abi.isArtboardEnabled) {
                return { node, box: abi.baseBox, label: abi.description };
            }
            node = node.parent;
        }
    }

    const box = spread.getSpreadExtents();
    return { node: spread, box, label: 'Spread' };
}

// ── Generation ────────────────────────────────────────────────────────────────

function createBentoBoxes(target) {
    const doc = Document.current;
    if (!doc) return 0;

    const { node: insertNode, box } = target;
    const canvasAspect = box.width / box.height;
    const { layout, gridSize } = generateControlledLayout(config.blockCount, canvasAspect);

    const cellW = (box.width  - 2 * config.padding - (gridSize - 1) * config.gap) / gridSize;
    const cellH = (box.height - 2 * config.padding - (gridSize - 1) * config.gap) / gridSize;

    const builder = AddChildNodesCommandBuilder.create();
    builder.setInsertionTarget(insertNode);

    layout.forEach(([c, r, w, h], i) => {
        const x = box.x + config.padding + c * (cellW + config.gap);
        const y = box.y + config.padding + r * (cellH + config.gap);
        const W = w * cellW + (w - 1) * config.gap;
        const H = h * cellH + (h - 1) * config.gap;

        const shape = ShapeRectangle.create();
        shape.setAbsoluteSizes(true, W, H);

        // cornerType must be set BEFORE radius — default cornerType is None
        // (value 4), and setRadius on a None corner silently does nothing.
        [shape.topLeft, shape.topRight, shape.bottomLeft, shape.bottomRight].forEach(corner => {
            corner.cornerType = ShapeCornerType.Round;
            corner.setRadius(config.cornerRadius, W, H);
        });

        let colour;
        if (config.colorFill) {
            colour = Colour.createRGBAuf({ r: Math.random(), g: Math.random(), b: Math.random(), alpha: 1.0 });
        } else {
            const v = 0.82 + (i / layout.length) * 0.14 + (Math.random() - 0.5) * 0.04;
            colour = Colour.createRGBAuf({ r: v, g: v, b: v, alpha: 1.0 });
        }

        builder.addShapeNode(ShapeNodeDefinition.create(
            shape, new Rectangle(x, y, W, H), FillDescriptor.createSolid(colour)
        ));
    });

    doc.executeCommand(builder.createCommand(true, NodeChildType.Main));
    return 1; // one compound undo step
}

// ── Dialog ────────────────────────────────────────────────────────────────────

function main() {
    const doc = Document.current;
    if (!doc) return;

    const target = detectTarget();

    const dlg = Dialog.create('Bento Box Generator');
    dlg.initialWidth = 360;
    const col = dlg.addColumn();

    // ── Target info ──
    const infoGrp = col.addGroup('Target');
    infoGrp.addStaticText('', `${target.label}  (${Math.round(target.box.width)} × ${Math.round(target.box.height)})`).isFullWidth = true;
    infoGrp.addStaticText('', 'Select an artboard or page before opening to change target.').isFullWidth = true;

    // ── Settings ──
    const grp = col.addGroup('Settings');

    const blockCtrl = grp.addUnitValueEditor('Block count', UnitType.None, UnitType.None, config.blockCount, 3, 16);
    blockCtrl.showPopupSlider = true;
    blockCtrl.precision = 0;

    const radiusCtrl = grp.addUnitValueEditor('Corner radius', UnitType.Pixel, UnitType.Pixel, config.cornerRadius, 0, 200);
    radiusCtrl.showPopupSlider = true;

    const paddingCtrl = grp.addUnitValueEditor('Padding', UnitType.Pixel, UnitType.Pixel, config.padding, 0, 200);
    paddingCtrl.showPopupSlider = true;

    const gapCtrl = grp.addUnitValueEditor('Gap', UnitType.Pixel, UnitType.Pixel, config.gap, 0, 100);
    gapCtrl.showPopupSlider = true;

    // ── Color fill — own group so it doesn't crowd the action buttons ──
    const fillGrp = col.addGroup('Fill');
    const colorSwitch = fillGrp.addSwitch('Color fill', config.colorFill);

    // ── Actions — separate group with breathing room above ──
    const actGrp = col.addGroup('Actions');
    const statusTxt = actGrp.addStaticText('', '');
    statusTxt.isFullWidth = true;
    const btns = actGrp.addButtonSet('', ['↺ Preview', '✓ Apply'], 0);
    btns.isFullWidth = true;
    // Extra spacer so native OK/Cancel don't overlap the button set
    actGrp.addStaticText('', '').isFullWidth = true;

    function readConfig() {
        config.blockCount   = Math.round(blockCtrl.value);
        config.cornerRadius = radiusCtrl.value;
        config.padding      = paddingCtrl.value;
        config.gap          = gapCtrl.value;
        config.colorFill    = colorSwitch.value;
    }

    let previewCmds = 0, previewActive = false;

    function clearPreview() {
        if (previewActive) {
            for (let i = 0; i < previewCmds; i++) {
                doc.executeCommand(DocumentCommand.createUndo());
            }
            previewActive = false;
            previewCmds = 0;
        }
    }

    function doPreview() {
        clearPreview();
        try {
            readConfig();
            previewCmds = createBentoBoxes(target);
            previewActive = true;
            statusTxt.text = `Previewing ${config.blockCount} blocks — adjust and preview again, or Apply to keep.`;
        } catch (e) {
            statusTxt.text = '✖ Error: ' + e.message;
        }
    }

    // Initial preview before dialog appears
    doPreview();

    let running = true;
    while (running) {
        btns.selectedIndex = 0;
        const result = dlg.runModal();
        const mode = btns.selectedIndex;

        if (result.value !== DialogResult.Ok.value) {
            // Cancel — undo preview
            clearPreview();
            running = false;
        } else if (mode === 1) {
            // ✓ Apply — keep result, close
            previewActive = false;
            running = false;
        } else {
            // ↺ Preview — regenerate
            doPreview();
        }
    }
}

main();
