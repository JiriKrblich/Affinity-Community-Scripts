/**
 * name: Bento Box Generator
 * description: Generates a Bento Grid on the chosen artboard (or the whole spread) with live preview.
 * version: 2.9
 * author: JiriKrblich / Claude
 *
 * v2.8/2.9: artboard-aware.
 *  - Generates in SPREAD coordinates: an artboard's position comes from
 *    node.getSpreadVisibleBox(true), NOT artboardInterface.baseBox (which is the
 *    artboard-LOCAL 0,0 box). Using baseBox placed the grid at the spread origin,
 *    outside the artboard, for any artboard not at (0,0).
 *  - v2.9: inserts the blocks INTO the artboard's layer by using the artboard
 *    node as the insertion target (setInsertionTarget(artboardNode)) together
 *    with spread coordinates — artboard children use spread coords, so this both
 *    nests them under the artboard and positions them correctly.
 *  - Target dropdown: pick which artboard to fill (or the whole spread). Defaults
 *    to the artboard of the current selection. There is no API for the "active"
 *    artboard without a selection, so we ask.
 *  - Keeps the v2.6/2.7 reentrancy guard + geometry guard, no clearPreviews.
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

// Object bounds in SPREAD coordinates (the space nodes actually live in).
function spreadBox(node) {
    let b = null;
    try { b = node.getSpreadVisibleBox ? node.getSpreadVisibleBox(true) : node.spreadVisibleBox; }
    catch (e) { try { b = node.spreadVisibleBox; } catch (e2) {} }
    if (!b) return null;
    return { x: b.x || 0, y: b.y || 0, width: b.width, height: b.height };
}
function normBox(b) {
    if (!b) return null;
    return { x: b.x || 0, y: b.y || 0, width: b.width, height: b.height };
}
function sameNode(a, b) {
    if (!a || !b) return false;
    try { if (typeof a.isSameNode === 'function') return a.isSameNode(b); } catch (e) {}
    return a === b;
}

// Build the list of fill targets: one per artboard (spread coords) + whole spread.
function buildTargets() {
    const doc = Document.current;
    const spread = doc.currentSpread;
    const targets = [];

    let hasAb = false;
    try { hasAb = doc.hasArtboards; } catch (e) {}
    if (hasAb) {
        let abs = null;
        try { abs = doc.artboards; } catch (e) {}
        if (abs && abs.length) {
            const list = [];
            for (let i = 0; i < abs.length; i++) {
                const ab = abs.at ? abs.at(i) : abs[i];
                let name = 'Artboard';
                try { name = ab.description || 'Artboard'; } catch (e) {}
                const box = spreadBox(ab.node);
                if (!box) continue;
                // Insert INTO the artboard's layer (artboard children use spread coords),
                // so the blocks nest under the artboard yet keep the correct position.
                list.push({ name, box, artboardNode: ab.node, insertNode: ab.node });
            }
            const counts = {};
            for (const t of list) counts[t.name] = (counts[t.name] || 0) + 1;
            const seen = {};
            for (const t of list) {
                if (counts[t.name] > 1) { seen[t.name] = (seen[t.name] || 0) + 1; t.label = `${t.name} (#${seen[t.name]})`; }
                else t.label = t.name;
                targets.push(t);
            }
        }
    }

    let extents = null;
    try { extents = normBox(spread.getSpreadExtents()); } catch (e) {}
    if (extents) targets.push({ label: targets.length ? 'Whole spread' : 'Spread', box: extents, insertNode: spread, artboardNode: null });

    return targets;
}

// Default the picker to the artboard of the current selection (if any).
function defaultTargetIndex(targets) {
    const doc = Document.current;
    try {
        const sel = doc.selection;
        if (sel && sel.length > 0) {
            let node = sel.at(0).node;
            while (node && node[Symbol.toStringTag] !== 'SpreadNode') {
                let abNode = null;
                try { const abi = node.artboardInterface; if (abi && abi.isArtboardEnabled) abNode = abi.node || node; } catch (e) {}
                if (abNode) {
                    for (let i = 0; i < targets.length; i++) {
                        if (targets[i].artboardNode && sameNode(targets[i].artboardNode, abNode)) return i;
                    }
                    break;
                }
                node = node.parent;
            }
        }
    } catch (e) {}
    return 0;
}

function cellSizes(box, gridSize) {
    return {
        cellW: (box.width  - 2 * config.padding - (gridSize - 1) * config.gap) / gridSize,
        cellH: (box.height - 2 * config.padding - (gridSize - 1) * config.gap) / gridSize
    };
}
function createBentoCommand(target, plan) {
    const { box, insertNode } = target;
    const { layout, gridSize, swatches } = plan;
    const { cellW, cellH } = cellSizes(box, gridSize);
    const builder = AddChildNodesCommandBuilder.create();
    builder.setInsertionTarget(insertNode);      // artboard node (nest inside) or spread; coords are spread coords
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

    const targets = buildTargets();
    if (!targets.length) return;
    const defaultIdx = defaultTargetIndex(targets);

    const dlg = Dialog.create('Bento Box Generator');
    dlg.initialWidth = 380;
    const col = dlg.addColumn();

    // Target picker
    const tgtGrp = col.addGroup('Target');
    let targetCombo = null;
    if (targets.length > 1) {
        targetCombo = tgtGrp.addComboBox('Fill', targets.map(t => t.label), defaultIdx);
        targetCombo.isFullWidth = true;
    } else {
        tgtGrp.addStaticText('', targets[0].label).isFullWidth = true;
    }
    const targetInfo = tgtGrp.addStaticText('', '');
    targetInfo.isFullWidth = true;

    function currentTarget() {
        const i = targetCombo ? targetCombo.selectedIndex : 0;
        return targets[i] || targets[0];
    }

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
        const box = currentTarget().box;
        const canvasAspect = box.width / box.height;
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

    // Reentrancy guard (see v2.6/2.7 notes).
    let updating = false;
    function rebuild(forceNewLayout) {
        if (updating) return false;
        updating = true;
        try {
            readConfig();
            ensurePreviewPlan(forceNewLayout);
            const target = currentTarget();
            const { cellW, cellH } = cellSizes(target.box, previewPlan.gridSize);
            targetInfo.text = `${Math.round(target.box.width)} x ${Math.round(target.box.height)} px`;
            if (!(cellW > 0.5) || !(cellH > 0.5)) {
                statusTxt.text = 'Padding / gap too large for this target — reduce them.';
                return false;
            }
            deleteCurrent();
            const cmd = createBentoCommand(target, previewPlan);
            doc.executeCommand(cmd);
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

    [blockCtrl, radiusCtrl, paddingCtrl, gapCtrl].forEach(c =>
        c.setOnValueChangedHandler(() => rebuild(false)));
    modeCombo.setOnValueChangedHandler(() => rebuild(false));
    if (targetCombo) targetCombo.setOnValueChangedHandler(() => rebuild(true)); // new artboard -> fresh layout in it
    regenBtn.setOnClickHandler(() => rebuild(true));

    rebuild(true);

    let apply = false;
    try {
        const result = dlg.runModal();
        apply = (result.value === DialogResult.Ok.value);
    } catch (e) {
        apply = false;
    }

    if (apply) {
        // keep committed nodes
    } else {
        deleteCurrent();
    }
}

main();