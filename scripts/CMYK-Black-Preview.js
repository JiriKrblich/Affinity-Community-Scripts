// Black Preview
// Shows CMYK blacks on screen the way Adobe apps do with
// "Appearance of Black: Display All Blacks as Rich Black".
//
// Affinity displays 100 K accurately – in uncoated profiles that is a brownish dark grey.
// Run the script: the preview appears immediately and a dialog asks whether to keep it
// (OK adds locked "Black Preview" layers on top of each spread / artboard) or discard it (Cancel).
// Running the script in a document that already has the preview offers to remove it.
//
// The preview is calibrated automatically for the document's CMYK profile: it renders test
// swatches in memory and tunes the layers like Illustrator's "Display All Blacks as Rich Black":
// 100 K shows as the deepest black (steep blend range, so 90 K and lighter are untouched) and
// K tints show as neutral grey at their original brightness. Colours are not affected.
//
// IMPORTANT: the preview layers change the output too – remove them (run the script again)
// before exporting or printing.

// ===== Black preview calibration engine =====
const BP = {};
// K tints, dark colours that must stay unchanged ([c, m, y, k]) and the darkest rich black (-1, keep last)
BP.SWATCH_K = [100, 95, 90, 80, 70, 60, 50, [0, 50, 100, 80], [100, 100, 0, 60], [0, 100, 100, 60], [100, 0, 100, 70], -1];

BP.layerDefinition = function (L) {
    const { SelectiveColourAdjustmentRasterNodeDefinition } = require('/nodes');
    const p = SelectiveColourAdjustmentRasterNodeDefinition.createDefault().parameters;
    p.isRelative = false;
    for (const idx of (L.ranges || [8])) p.weights[idx] = { cyanWeight: L.c, magentaWeight: L.m, yellowWeight: L.y, blackWeight: L.k || 0 };
    return SelectiveColourAdjustmentRasterNodeDefinition.create(p);
};

// blend range on the underlying composition: { pts } for master, { channel, pts } or { channels: { index: pts } }; pts = [[x, opacity], ...]
BP.rangeCommand = function (doc, node, range) {
    const { DocumentCommand } = require('/commands');
    const { Selection } = require('/selections');
    const { Spline } = require('/geometry');
    const bo = node.blendModeInterface.blendOptions;
    const sp = range.pts ? Spline.createFromPoints(range.pts.map(p => ({ x: p[0], y: p[1] }))) : null;
    if (range.channels) {
        // channels of the underlying composite in display RGB (0 = R, 1 = G, 2 = B); all must be dark
        for (const ch of Object.keys(range.channels)) bo.setChannelUnderlyingCompositionRanges(Number(ch), Spline.createFromPoints(range.channels[ch].map(p => ({ x: p[0], y: p[1] }))));
    } else if (range.channel === null || range.channel === undefined) bo.masterUnderlyingCompositionRanges = sp;
    else bo.setChannelUnderlyingCompositionRanges(range.channel, sp);
    return DocumentCommand.createSetBlendRanges(Selection.create(doc, node), bo);
};

// renders groups of K swatches, each with its own Selective Colour variant, returns RGB per variant
BP.evaluate = function (doc, variants) {
    const { AddChildNodesCommandBuilder, CompoundCommandBuilder } = require('/commands');
    const { ShapeNodeDefinition, ContainerNodeDefinition } = require('/nodes');
    const { ShapeRectangle } = require('/shapes');
    const { Colour } = require('/colours');
    const { FillDescriptor } = require('/fills');
    const { DocumentCommand } = require('/commands');
    const { Selection } = require('/selections');
    const R = require('/rasterobject');
    const spread = doc.currentSpread;
    const S = 12, X0 = -400000, Y0 = -400000;
    const undoMark = doc.undoDescription;
    let executed = 0;
    const exec = (cmd) => { doc.executeCommand(cmd); executed++; };

    const b1 = AddChildNodesCommandBuilder.create();
    b1.setInsertionTarget(spread);
    for (let i = 0; i < variants.length; i++) b1.addContainerNode(ContainerNodeDefinition.create('bp-cal'));
    const c1 = b1.createCommand();
    exec(c1);
    const groups = [];
    for (const n of c1.newNodes) groups.push(n);

    const comp = CompoundCommandBuilder.create();
    variants.forEach((v, i) => {
        const b = AddChildNodesCommandBuilder.create();
        b.setInsertionTarget(groups[i]);
        const bg = ShapeNodeDefinition.createDefault();
        bg.shape = ShapeRectangle.create();
        bg.setBoundingRectangle({ x: X0 - S, y: Y0 + i * S * 2 - S / 2, width: (BP.SWATCH_K.length + 2) * S, height: S * 2 });
        b.addShapeNode(bg);
        BP.SWATCH_K.forEach((k, j) => {
            const def = ShapeNodeDefinition.createDefault();
            def.shape = ShapeRectangle.create();
            def.setBoundingRectangle({ x: X0 + j * S, y: Y0 + i * S * 2, width: S, height: S });
            b.addShapeNode(def);
        });
        for (const L of (v ? (Array.isArray(v) ? v : [v]) : [])) b.addSelectiveColourAdjustmentRasterNode(BP.layerDefinition(L));
        comp.addCommand(b.createCommand());
    });
    exec(comp.createCommand());
    // fill the swatches (fills passed to definitions are dropped)
    const comp2 = CompoundCommandBuilder.create();
    for (const g of groups) {
        const rects = [...g.children].filter(n => n.brushFillInterface);
        rects.forEach((r, idx) => {
            const j = idx - 1;
            const sw = j < 0 ? 0 : BP.SWATCH_K[j];
            const cmyk = Array.isArray(sw) ? sw.map(v => v / 100) : sw === -1 ? [1, 1, 1, 1] : [0, 0, 0, sw / 100];
            comp2.addCommand(DocumentCommand.createSetBrushFill(Selection.create(doc, r), FillDescriptor.createSolid(Colour.createCMYKAf({ c: cmyk[0], m: cmyk[1], y: cmyk[2], k: cmyk[3], alpha: 1 }))));
        });
    }
    exec(comp2.createCommand());

    // blend ranges for layers that have them
    const comp3 = CompoundCommandBuilder.create();
    let nRanges = 0;
    groups.forEach((g, i) => {
        const v = variants[i];
        const L = v ? (Array.isArray(v) ? v : [v]) : [];
        const adj = [...g.children].filter(n => /selective/i.test(String(n.description)));
        L.forEach((layer, li) => { if (layer.range && adj[li]) { comp3.addCommand(BP.rangeCommand(doc, adj[li], layer.range)); nRanges++; } });
    });
    if (nRanges) exec(comp3.createCommand());

    const results = groups.map(g => {
        const eng = R.NodeRenderingEngine.createDefault(g, R.RasterFormat.RGBA8);
        const buf = R.PixelBuffer.create(1, 1, R.RasterFormat.RGBA8);
        return BP.SWATCH_K.map((k, j) => {
            eng.copyTo(buf, { x: 0, y: 0, width: 1, height: 1 }, Math.floor((j + 1) * S + S / 2), Math.floor(S));
            const a = new Uint8Array(buf.buffer);
            return [a[0], a[1], a[2]];
        });
    });
    // roll back exactly our own steps (history can also contain selection changes)
    for (let i = 0; i < executed + 6 && doc.canUndo; i++) {
        doc.undo();
        if (i + 1 >= executed && doc.undoDescription === undoMark) break;
    }
    return results;
};

BP.WARM = [1, 2];
BP.lum = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
BP.hueErr = (p) => Math.abs((p[0] - p[1]) - BP.WARM[0]) + Math.abs((p[1] - p[2]) - BP.WARM[1]);

// Matches Illustrator's "Display All Blacks as Rich Black":
//  - K tints keep their brightness but show as neutral grey   -> "neutral" layer
//  - 100 K jumps to the deepest black, 90 K and lighter stay  -> "black" layers limited by blend ranges
BP.scoreNeutral = function (base, res) {
    let e = 0;
    BP.SWATCH_K.forEach((k, j) => {
        if (Array.isArray(k)) { e += 0.5 * (Math.abs(BP.lum(res[j]) - BP.lum(base[j])) + Math.abs(res[j][0] - base[j][0]) + Math.abs(res[j][2] - base[j][2])); return; }
        if (k < 50 || k > 95) return;
        e += Math.abs(BP.lum(res[j]) - BP.lum(base[j])) + BP.hueErr(res[j]);
    });
    return e;
};
BP.scoreBlack = function (base, neutral, res) {
    const n = BP.SWATCH_K.length - 1;
    const dark = BP.lum(base[n]);
    let e = 0;
    BP.SWATCH_K.forEach((k, j) => {
        const l = BP.lum(res[j]);
        if (Array.isArray(k)) e += 2 * (Math.abs(l - BP.lum(neutral[j])) + Math.abs(res[j][0] - neutral[j][0]) + Math.abs(res[j][2] - neutral[j][2]));
        else if (k === 100) e += 4 * Math.abs(l - dark) + 0.3 * BP.hueErr(res[j]);
        else if (k === 95) e += 0.5 * Math.abs(l - (dark + BP.lum(neutral[j])) / 2);
        else if (k === -1) e += Math.abs(l - dark);
        else e += 2 * Math.abs(l - BP.lum(neutral[j]));
    });
    return e;
};

BP.calibrate = function (doc) {
    const pick = (cands, scoreFn) => {
        const res = BP.evaluate(doc, [null].concat(cands));
        let best = 0, bestScore = Infinity;
        cands.forEach((v, i) => { const sc = scoreFn(res[0], res[i + 1]); if (sc < bestScore) { bestScore = sc; best = i; } });
        return { layers: cands[best], result: res[best + 1], base: res[0], score: bestScore };
    };
    // 1) neutral layer
    let cands = [];
    for (const c of [0, 0.04, 0.08, 0.12, 0.16, 0.2]) for (const m of [0, 0.03, 0.06, 0.1]) for (const k of [0, -0.03, -0.06, -0.1, -0.14])
        cands.push([{ c, m, y: 0, k, ranges: [8] }]);
    let nb = pick(cands, BP.scoreNeutral);
    const n0 = nb.layers[0];
    cands = [];
    for (const c of [-0.02, 0, 0.02]) for (const m of [-0.015, 0, 0.015]) for (const k of [-0.015, 0, 0.015])
        cands.push([{ c: Math.max(0, n0.c + c), m: Math.max(0, n0.m + m), y: 0, k: Math.min(0, n0.k + k), ranges: [8] }]);
    nb = pick(cands, BP.scoreNeutral);
    const neutralLayer = nb.layers[0];
    const neutralRes = nb.result;
    // 2) black layers limited by steep blend ranges to pixels that are dark in R, G and B (100 K, rich black)
    const strong = { c: 1, m: 0.6, y: 0.45 };
    const r3 = (x) => Math.round(Math.min(1, Math.max(0.001, x)) * 1000) / 1000;
    const withRange = (f, gap) => {
        const channels = {};
        for (let ch = 0; ch < 3; ch++) {
            const x0 = r3(neutralRes[0][ch] / 255 * f + 0.01);
            channels[ch] = [[0, 1], [x0, 1], [r3(x0 + gap), 0], [1, 0]];
        }
        return { c: strong.c, m: strong.m, y: strong.y, range: { channels } };
    };
    cands = [];
    for (const f of [1, 1.2, 1.5, 2])
        for (const gap of [0.03, 0.06, 0.1])
            for (const nStack of [1, 2]) cands.push([neutralLayer].concat(new Array(nStack).fill(withRange(f, gap))));
    const bb = pick(cands, (base, res) => BP.scoreBlack(base, neutralRes, res));
    return { layers: bb.layers, score: bb.score, base: bb.base, neutral: neutralRes, result: bb.result };
};

BP.NAME = '⚠ Black Preview – remove before export';

BP.isPreviewNode = (n) => { try { return String(n.userDescription || n.description || '').indexOf('Black Preview') >= 0; } catch (e) { return false; } };

BP.containers = function (doc) {
    const out = [];
    for (const spread of doc.spreads) {
        let artboards = [];
        try { artboards = [...spread.children].filter(n => n.artboardInterface && n.artboardInterface.isArtboardEnabled); } catch (e) { /* none */ }
        if (artboards.length) for (const ab of artboards) out.push({ node: ab, artboard: true });
        else out.push({ node: spread, artboard: false });
    }
    return out;
};

BP.findPreviewNodes = function (doc) {
    const found = [];
    for (const c of BP.containers(doc)) {
        try { for (const n of c.node.children) if (BP.isPreviewNode(n)) found.push(n); } catch (e) { /* leaf */ }
    }
    return found;
};

BP.message = function (text) {
    const { Dialog } = require('/dialog');
    const dlg = Dialog.create('Black Preview');
    dlg.addColumn().addGroup('').addStaticText('', text);
    try { dlg.runModal(); } catch (e) { /* closed */ }
};

// adds the calibrated preview layers on top of every spread / artboard, returns the new nodes
BP.addPreview = function (doc, layers) {
    const { AddChildNodesCommandBuilder, CompoundCommandBuilder, DocumentCommand, InsertionMode } = require('/commands');
    const { Selection } = require('/selections');
    const containers = BP.containers(doc);
    const comp = CompoundCommandBuilder.create();
    for (const c of containers) {
        const b = AddChildNodesCommandBuilder.create();
        b.setInsertionTarget(c.node);
        if (c.artboard) b.setInsertionMode(InsertionMode.Inside_AtFront);
        for (const L of layers) b.addSelectiveColourAdjustmentRasterNode(BP.layerDefinition(L));
        comp.addCommand(b.createCommand());
    }
    doc.executeCommand(comp.createCommand());
    // the new layers are the last unnamed Selective Colour nodes of each container (children are listed back to front)
    const added = [];
    const ranges = CompoundCommandBuilder.create();
    let nRanges = 0;
    for (const c of containers) {
        const fresh = [...c.node.children].filter(n => /selective/i.test(String(n.description)) && !String(n.userDescription || '')).slice(-layers.length);
        fresh.forEach((node, i) => {
            added.push(node);
            if (layers[i] && layers[i].range) { ranges.addCommand(BP.rangeCommand(doc, node, layers[i].range)); nRanges++; }
        });
    }
    if (nRanges) doc.executeCommand(ranges.createCommand());
    if (added.length) {
        const comp2 = CompoundCommandBuilder.create();
        const sel = Selection.create(doc, added);
        comp2.addCommand(DocumentCommand.createSetDescription(sel, BP.NAME));
        comp2.addCommand(DocumentCommand.createSetEditable(sel, false));
        doc.executeCommand(comp2.createCommand());
    }
    return added;
};

function main() {
    const { Document } = require('/document');
    const { DocumentCommand } = require('/commands');
    const { Selection } = require('/selections');
    const { RasterFormat } = require('/colours');
    const { Dialog, DialogResult } = require('/dialog');
    const doc = Document.current;
    if (!doc) return;
    if (doc.format.value !== RasterFormat.CMYKA8.value) {
        BP.message('Black Preview only works in CMYK documents.');
        return;
    }

    // preview already in the document: offer to remove it
    const existing = BP.findPreviewNodes(doc);
    if (existing.length) {
        const dlg = Dialog.create('Black Preview');
        const g = dlg.addColumn().addGroup('');
        g.addStaticText('', 'Black Preview layers are in this document.');
        g.addStaticText('', 'OK removes them. Cancel keeps them.');
        let ok = false;
        try { ok = dlg.runModal().value === DialogResult.Ok.value; } catch (e) { ok = false; }
        if (ok) doc.executeCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, existing)));
        return;
    }

    // show the preview right away, then ask
    const mark = doc.undoDescription;
    const cal = BP.calibrate(doc);
    const added = BP.addPreview(doc, cal.layers);
    if (!added.length) { BP.message('Could not add the preview layers.'); return; }

    const dlg = Dialog.create('Black Preview');
    dlg.initialWidth = 380;
    const col = dlg.addColumn();
    const g1 = col.addGroup('');
    g1.addStaticText('', 'Blacks are shown like Illustrator / InDesign with “Display All Blacks as Rich Black”: 100 K as deep black, K tints as neutral grey.');
    const show = g1.addSwitch('Show preview', true);
    const g2 = col.addGroup('');
    g2.enableSeparator = true;
    g2.addStaticText('', 'OK – keep the preview layers.');
    g2.addStaticText('', 'Cancel – remove them.');
    g2.addStaticText('', '⚠ The layers also affect export and print. Run the script again to remove them before exporting.');

    let visible = true, busy = false;
    show.onValueChangedHandler = () => {
        if (busy) return;
        busy = true;
        try {
            if (show.value !== visible) {
                visible = show.value;
                doc.executeCommand(DocumentCommand.createSetVisibility(Selection.create(doc, added), visible));
            }
        } finally { busy = false; }
    };

    let ok = false;
    try { ok = dlg.runModal().value === DialogResult.Ok.value; } catch (e) { ok = false; }

    if (ok) {
        if (!visible) doc.executeCommand(DocumentCommand.createSetVisibility(Selection.create(doc, added), true));
        return;
    }
    // Cancel: roll back to the state before the script ran
    for (let i = 0; i < 20 && doc.canUndo && doc.undoDescription !== mark; i++) doc.undo();
    if (BP.findPreviewNodes(doc).length) {
        doc.executeCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, BP.findPreviewNodes(doc))));
    }
}

main();
