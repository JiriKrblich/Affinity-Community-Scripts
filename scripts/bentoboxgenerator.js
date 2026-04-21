/**
 * name: Bento Box generator
 * description: Generates Bento Grid/Box on the current page/artboard
 * version: 1.0.0
 * author: JiriKrblich
 */

'use strict';
const { Document } = require('/document');
const { Dialog, DialogResult } = require('/dialog');
const { UnitType } = require('/units');
const { Rectangle } = require('/geometry');
const { ShapeRectangle, ShapeCornerType } = require('/shapes');
const { Colour } = require('/colours');
const { FillDescriptor } = require('/fills');
const { AddChildNodesCommandBuilder, NodeChildType } = require('/commands');
const { ShapeNodeDefinition } = require('/nodes');

let hasGenerated = false;
let config = { blockCount: 8, cornerRadius: 30, padding: 40, gap: 20, colorFill: true };

// ── Layout algorithm ──────────────────────────────────────────────────────────
//
// Two-phase guillotine cut with design constraints:
//   Phase 1  — mandatory splits until every rect is within maxSpan
//               (prevents full-width / full-height strips)
//   Phase 2  — area-weighted random splits until targetBlocks reached
//   Retry    — regenerate up to 200×; accept only when pixel AR ∈ [0.25, 4.0]
//               (prevents boxes that are too narrow or too flat for content)
//
// For n < 4 the maxSpan constraint is relaxed — a 3-box bento will always
// contain one large "hero" box, and that is intentional.

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

    // Phase 1: mandatory splits — bring all rects within maxSpan
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

    // Phase 2: random area-weighted splits until n reached
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
    // Fallback: return any valid-coverage layout
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
    if (!doc) return;
    if (hasGenerated) { doc.undo(); hasGenerated = false; }

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
        shape.useSingleRadius = true;
        shape.setAbsoluteSizes(true, W, H); // must come before setCornerRadius
        const corner = { radius: config.cornerRadius, cornerType: ShapeCornerType.Round };
        shape.setTopLeft(corner, W, H);
        shape.setTopRight(corner, W, H);
        shape.setBottomLeft(corner, W, H);
        shape.setBottomRight(corner, W, H);

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
    hasGenerated = true;
}

// ── Dialog ────────────────────────────────────────────────────────────────────

function showDialog(savedTarget) {
    const target = savedTarget || detectTarget();

    const dialog = Dialog.create('Bento Box Generator');
    const col = dialog.addColumn();

    const infoGrp = col.addGroup('Target');
    infoGrp.addStaticText('', `${target.label}  (${Math.round(target.box.width)} × ${Math.round(target.box.height)})`).isFullWidth = true;
    infoGrp.addStaticText('', 'Select an artboard or page before opening to change target.');

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

    const colorSwitch = grp.addSwitch('Color fill', config.colorFill);

    col.addGroup('').addStaticText('', 'OK = Generate   ·   Cancel = Close');

    const result = dialog.show();

    if (result.value === DialogResult.Ok.value) {
        config.blockCount   = Math.round(blockCtrl.value);
        config.cornerRadius = radiusCtrl.value;
        config.padding      = paddingCtrl.value;
        config.gap          = gapCtrl.value;
        config.colorFill    = colorSwitch.value;
        createBentoBoxes(target);
        showDialog(target);
    }
}

showDialog();
