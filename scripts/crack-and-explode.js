'use strict';
const { Document }             = require('/document');
const { Dialog, DialogResult } = require('/dialog');
const { UnitType }             = require('/units');
const { DocumentCommand }      = require('/commands');
const { NodeMoveType, NodeChildType } = require('/commands');
const { CurveBuilder }         = require('/geometry');
const { Selection }            = require('/selections');
const { Transform }            = require('/geometry');

// ── State ─────────────────────────────────────────────────────────────────────
let currentPieces  = [];
let groupToCleanup = null;

let config = { shards: 12, force: 80, scatter: 60, rotation: 25, noOverlap: false, seed: 42 };

// ── Helper: bounding box in spread space (compatible with knife/transform) ────
function spreadBox(node) {
    return node.getSpreadBaseBox(false);
}

// ── Seeded pseudo-random (LCG) ────────────────────────────────────────────────
function makeRng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(1664525, s) + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

// ── Move pieces out of parent group before deleting it ───────────────────────
function emancipatePieces(doc, pieces, group) {
    if (!group) return;
    try {
        doc.executeCommand(DocumentCommand.createMoveNodes(
            Selection.create(doc, pieces),
            group,
            NodeMoveType.After,
            NodeChildType.Main
        ));
    } catch (e) {
        for (const p of pieces) {
            try {
                doc.executeCommand(DocumentCommand.createMoveNodes(
                    Selection.create(doc, p),
                    group,
                    NodeMoveType.After,
                    NodeChildType.Main
                ));
            } catch (_) {}
        }
    }
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
function deletePieces() {
    const doc = Document.current;
    if (groupToCleanup && currentPieces.length > 0) {
        emancipatePieces(doc, currentPieces, groupToCleanup);
    }
    for (const p of currentPieces) {
        try { doc.executeCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, p), false)); }
        catch (e) {}
    }
    currentPieces = [];
    if (groupToCleanup) {
        try { doc.executeCommand(DocumentCommand.createDeleteSelection(groupToCleanup.selfSelection, false)); }
        catch (e) {}
        groupToCleanup = null;
    }
}

// ── Prepare node ─────────────────────────────────────────────────────────────
function prepareNode(origNode) {
    const doc = Document.current;

    const dupCmd = DocumentCommand.createTransform(
        origNode.selfSelection, null, { duplicateNodes: true });
    doc.executeCommand(dupCmd);

    if (!dupCmd.newNodes || dupCmd.newNodes.length === 0)
        throw new Error('Duplicate failed. Object must be a shape, image or text - not a group.');

    const dup = dupCmd.newNodes[0];
    doc.executeCommand(DocumentCommand.createSetVisibility(dup.selfSelection, true));
    doc.executeCommand(DocumentCommand.createConvertToCurves(Selection.create(doc, dup)));

    const selAfter = doc.selection.nodes;
    const converted = (selAfter && selAfter.length > 0) ? selAfter.first : null;
    if (!converted)
        throw new Error('Convert to Curves produced no output. Try converting the object manually first.');

    if (converted.isGroupNode) {
        const glyphs = [];
        for (const child of converted.children) glyphs.push(child);
        if (glyphs.length === 0)
            throw new Error('Glyph group is empty after conversion.');
        return { pieces: glyphs, group: converted };
    }

    return { pieces: [converted], group: null };
}

// ── No-overlap separation ─────────────────────────────────────────────────────
function separatePieces(doc, pieces, maxIter = 30) {
    const padding = 2;
    for (let iter = 0; iter < maxIter; iter++) {
        let anyOverlap = false;
        for (let i = 0; i < pieces.length; i++) {
            for (let j = i + 1; j < pieces.length; j++) {
                let bbA, bbB;
                try { bbA = spreadBox(pieces[i]); } catch (e) { continue; }
                try { bbB = spreadBox(pieces[j]); } catch (e) { continue; }
                if (!bbA || !bbB) continue;
                const p = padding / 2;
                const overlapX = (bbA.x - p) < (bbB.x + bbB.width  + p) && (bbA.x + bbA.width  + p) > (bbB.x - p);
                const overlapY = (bbA.y - p) < (bbB.y + bbB.height + p) && (bbA.y + bbA.height + p) > (bbB.y - p);
                if (!overlapX || !overlapY) continue;
                anyOverlap = true;
                const acx = bbA.x + bbA.width  / 2, acy = bbA.y + bbA.height / 2;
                const bcx = bbB.x + bbB.width  / 2, bcy = bbB.y + bbB.height / 2;
                let dx = bcx - acx, dy = bcy - acy;
                const len = Math.sqrt(dx * dx + dy * dy) || 1;
                dx /= len; dy /= len;
                const depthX = (bbA.width  / 2 + bbB.width  / 2 + padding) - Math.abs(bcx - acx);
                const depthY = (bbA.height / 2 + bbB.height / 2 + padding) - Math.abs(bcy - acy);
                const push = Math.min(depthX, depthY) / 2;
                try { doc.executeCommand(DocumentCommand.createTransform(Selection.create(doc, pieces[i]), Transform.createTranslate(-dx * push, -dy * push), { mergeable: false })); } catch (e) {}
                try { doc.executeCommand(DocumentCommand.createTransform(Selection.create(doc, pieces[j]), Transform.createTranslate( dx * push,  dy * push), { mergeable: false })); } catch (e) {}
            }
        }
        if (!anyOverlap) break;
    }
}

// ── Core: radial knife-cut + scatter ─────────────────────────────────────────
function generateExplosion(origNode, origBox) {
    const doc = Document.current;
    const { shards, force, scatter, rotation, noOverlap, seed } = config;
    const rng = makeRng(seed);

    const cx = origBox.x + origBox.width  / 2;
    const cy = origBox.y + origBox.height / 2;
    const R  = Math.max(origBox.width, origBox.height) * 1.5;

    const { pieces: initialPieces, group } = prepareNode(origNode);
    groupToCleanup = group;
    let pieces = initialPieces;

    // Radial cuts across all pieces
    const angleStep       = (Math.PI * 2) / shards;
    const maxWobble       = angleStep * 0.45;
    const maxImpactJitter = Math.min(origBox.width, origBox.height) * 0.15;

    for (let i = 0; i < shards; i++) {
        const angle = i * angleStep + (rng() - 0.5) * 2 * maxWobble;
        const ox = cx + (rng() - 0.5) * 2 * maxImpactJitter;
        const oy = cy + (rng() - 0.5) * 2 * maxImpactJitter;
        const cutLine = new CurveBuilder()
            .beginXY(ox + Math.cos(angle) * R, oy + Math.sin(angle) * R)
            .lineToXY( ox - Math.cos(angle) * R, oy - Math.sin(angle) * R)
            .createCurve();

        const next = [];
        for (const p of pieces) {
            try {
                const cmd = DocumentCommand.createKnifeCut(cutLine, Selection.create(doc, p));
                doc.executeCommand(cmd);
                next.push(...(cmd.newNodes && cmd.newNodes.length >= 2 ? cmd.newNodes : [p]));
            } catch (e) { next.push(p); }
        }
        pieces = next;
    }

    // Scatter pieces outward
    for (const p of pieces) {
        try {
            const bb = spreadBox(p);
            if (!bb) continue;
            const pcx = bb.x + bb.width  / 2;
            const pcy = bb.y + bb.height / 2;
            let dx = pcx - cx, dy = pcy - cy;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            dx /= dist; dy /= dist;
            const radialDist = force * (0.6 + rng() * 0.8);
            const perp = (rng() - 0.5) * 2 * scatter;
            const tx = dx * radialDist + (-dy) * perp;
            const ty = dy * radialDist + (  dx) * perp;
            const rotRad = (rng() - 0.5) * 2 * rotation * Math.PI / 180;
            const xf = Transform.createIdentity()
                .multiply(Transform.createTranslate(pcx + tx, pcy + ty))
                .multiply(Transform.createRotate(rotRad))
                .multiply(Transform.createTranslate(-(pcx + tx), -(pcy + ty)))
                .multiply(Transform.createTranslate(tx, ty));
            doc.executeCommand(DocumentCommand.createTransform(Selection.create(doc, p), xf, { mergeable: false }));
        } catch (e) {}
    }

    if (noOverlap) separatePieces(doc, pieces);

    currentPieces = pieces;
}

// ── Apply ─────────────────────────────────────────────────────────────────────
function applyExplosion(doc, origNode) {
    if (groupToCleanup && currentPieces.length > 0) {
        emancipatePieces(doc, currentPieces, groupToCleanup);
    }
    try { doc.executeCommand(DocumentCommand.createDeleteSelection(origNode.selfSelection, false)); } catch (e) {}
    if (groupToCleanup) {
        try { doc.executeCommand(DocumentCommand.createDeleteSelection(groupToCleanup.selfSelection, false)); } catch (e) {}
        groupToCleanup = null;
    }
    currentPieces = [];
}

// ── Main ──────────────────────────────────────────────────────────────────────
function run() {
    const doc = Document.current;
    const sel = doc.selection;

    if (!sel || sel.length === 0) {
        const dlg = Dialog.create('Crack and Explode');
        dlg.addColumn().addGroup('').addStaticText('',
            'No object selected. Please select an object first.').isFullWidth = true;
        dlg.show();
        return;
    }

    const origNode = sel.nodes.first;

    let origBox;
    try {
        origBox = origNode.getSpreadBaseBox(false);
        if (!origBox || origBox.width <= 0 || origBox.height <= 0) throw new Error();
    } catch (e) {
        const dlg = Dialog.create('Crack and Explode');
        dlg.addColumn().addGroup('').addStaticText('',
            'Selected object has no valid dimensions.\n' +
            'Please select a shape, image or text - not a group.').isFullWidth = true;
        dlg.show();
        return;
    }

    doc.executeCommand(DocumentCommand.createSetVisibility(origNode.selfSelection, false));

    const dialog   = Dialog.create('Crack and Explode');
    const col      = dialog.addColumn();
    const typeNote = (origNode.isTextNode ?? false) ? ' (text)' : '';

    col.addGroup('Selected Object').addStaticText('',
        `"${origNode.description}"${typeNote}  -  ${Math.round(origBox.width)} x ${Math.round(origBox.height)} px`
    ).isFullWidth = true;

    const sg = col.addGroup('Settings');

    const shardsCtrl    = sg.addUnitValueEditor('Shards',            UnitType.None,  UnitType.None,  config.shards,   3,   64);
    shardsCtrl.showPopupSlider = true; shardsCtrl.precision = 0;

    const forceCtrl     = sg.addUnitValueEditor('Force (px)',        UnitType.Pixel, UnitType.Pixel, config.force,    0,  500);
    forceCtrl.showPopupSlider = true;

    const scatterCtrl   = sg.addUnitValueEditor('Scatter (px)',      UnitType.Pixel, UnitType.Pixel, config.scatter,  0,  300);
    scatterCtrl.showPopupSlider = true;

    const rotationCtrl  = sg.addUnitValueEditor('Max Rotation (deg)', UnitType.None, UnitType.None,  config.rotation, 0,  180);
    rotationCtrl.showPopupSlider = true; rotationCtrl.precision = 0;

    const noOverlapCtrl = sg.addCheckBox('Prevent Overlap', config.noOverlap);

    const seedCtrl      = sg.addUnitValueEditor('Random Seed',       UnitType.None,  UnitType.None,  config.seed,     1, 9999);
    seedCtrl.showPopupSlider = true; seedCtrl.precision = 0;

    const sepGrp = col.addGroup('');
    sepGrp.enableSeparator = true;
    const btns = sepGrp.addButtonSet('', ['Preview', 'Apply'], 0);

    try {
        generateExplosion(origNode, origBox);
    } catch (e) {
        try { doc.executeCommand(DocumentCommand.createSetVisibility(origNode.selfSelection, true)); } catch (_) {}
        const errDlg = Dialog.create('Crack and Explode - Error');
        errDlg.addColumn().addGroup('').addStaticText('',
            `Could not fragment the object:\n${e.message || e}`
        ).isFullWidth = true;
        errDlg.show();
        return;
    }

    let running = true;
    while (running) {
        btns.selectedIndex = 0;
        const result = dialog.show();

        config.shards    = Math.max(3,   Math.round(shardsCtrl.value));
        config.force     = Math.max(0,   forceCtrl.value);
        config.scatter   = Math.max(0,   scatterCtrl.value);
        config.rotation  = Math.max(0,   Math.min(180, Math.round(rotationCtrl.value)));
        config.noOverlap = noOverlapCtrl.checked;
        config.seed      = Math.max(1,   Math.round(seedCtrl.value));
        const mode       = btns.selectedIndex;

        if (result.value === DialogResult.Ok.value) {
            deletePieces();
            try {
                generateExplosion(origNode, origBox);
            } catch (e) {
                try { doc.executeCommand(DocumentCommand.createSetVisibility(origNode.selfSelection, true)); } catch (_) {}
                const errDlg = Dialog.create('Crack and Explode - Error');
                errDlg.addColumn().addGroup('').addStaticText('',
                    `Could not fragment the object:\n${e.message || e}`
                ).isFullWidth = true;
                errDlg.show();
                running = false;
                return;
            }
            if (mode === 1) {
                applyExplosion(doc, origNode);
                running = false;
            }
        } else {
            deletePieces();
            try { doc.executeCommand(DocumentCommand.createSetVisibility(origNode.selfSelection, true)); } catch (e) {}
            running = false;
        }
    }
}

run();
