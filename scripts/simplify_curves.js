'use strict';
const { Document }             = require('/document');
const { Dialog, DialogResult } = require('/dialog');
const { UnitType }             = require('/units');
const { DocumentCommand }      = require('/commands');
const { CurveBuilder, PolyCurve } = require('/geometry');
const { Selection }            = require('/selections');

// ── Geometry helpers ──────────────────────────────────────────────────────────

function parseAnchors(curve) {
    const n = curve.nodeCount;
    const anchors = [];

    for (let i = 0; i < n; i++) {
        if (curve.getNode(i).type.value === 0) {
            const nd = curve.getNode(i);
            anchors.push({ idx: i, x: nd.position.x, y: nd.position.y,
                           inHandle: null, outHandle: null });
        }
    }

    for (let i = 0; i < n; i++) {
        const nd = curve.getNode(i);
        if (nd.type.value === 1) {
            for (let a = anchors.length - 1; a >= 0; a--) {
                if (anchors[a].idx < i) {
                    anchors[a].outHandle = { x: nd.position.x, y: nd.position.y };
                    break;
                }
            }
        } else if (nd.type.value === 2) {
            for (let a = 0; a < anchors.length; a++) {
                if (anchors[a].idx > i) {
                    anchors[a].inHandle = { x: nd.position.x, y: nd.position.y };
                    break;
                }
            }
        }
    }
    return anchors;
}

function simplifyAnchors(anchors, targetCount, isClosed) {
    if (anchors.length <= targetCount) return anchors.map((_, i) => i);

    let active = anchors.map((_, i) => i);

    function area(pos) {
        const len  = active.length;
        const prev = active[(pos - 1 + len) % len];
        const next = active[(pos + 1) % len];
        const a = anchors[prev], b = anchors[active[pos]], c = anchors[next];
        return Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
    }

    while (active.length > targetCount) {
        const start = isClosed ? 0 : 1;
        const end   = isClosed ? active.length : active.length - 1;
        let minA = Infinity, minPos = start;
        for (let i = start; i < end; i++) {
            const a = area(i);
            if (a < minA) { minA = a; minPos = i; }
        }
        active.splice(minPos, 1);
    }
    return active;
}

function buildCurve(anchors, keepIndices, isClosed) {
    const cb   = new CurveBuilder();
    const kept = keepIndices.map(i => anchors[i]);
    cb.beginXY(kept[0].x, kept[0].y);

    for (let i = 0; i < kept.length - 1; i++) {
        const from = kept[i], to = kept[i + 1];
        cb.addBezierXY(
            from.outHandle ? from.outHandle.x : from.x,
            from.outHandle ? from.outHandle.y : from.y,
            to.inHandle    ? to.inHandle.x    : to.x,
            to.inHandle    ? to.inHandle.y    : to.y,
            to.x, to.y
        );
    }

    if (isClosed) {
        const from = kept[kept.length - 1], to = kept[0];
        cb.addBezierXY(
            from.outHandle ? from.outHandle.x : from.x,
            from.outHandle ? from.outHandle.y : from.y,
            to.inHandle    ? to.inHandle.x    : to.x,
            to.inHandle    ? to.inHandle.y    : to.y,
            to.x, to.y
        );
        cb.close();
    }
    return cb.createCurve();
}

function buildSimplifiedPolyCurve(subAnchorSets, targetCount, totalAnchors) {
    const newPoly = new PolyCurve();
    for (const sub of subAnchorSets) {
        const subTarget = Math.max(2, Math.round(targetCount * (sub.anchors.length / totalAnchors)));
        const keepIdx   = simplifyAnchors(sub.anchors, subTarget, sub.isClosed);
        newPoly.addCurve(buildCurve(sub.anchors, keepIdx, sub.isClosed));
    }
    return newPoly;
}

function countAnchors(polyCurve) {
    let n = 0;
    for (let i = 0; i < polyCurve.curveCount; i++) {
        const c = polyCurve.at(i);
        for (let j = 0; j < c.nodeCount; j++)
            if (c.getNode(j).type.value === 0) n++;
    }
    return n;
}

// ── State ─────────────────────────────────────────────────────────────────────

let previewNode   = null;
let subAnchorSets = [];
let totalAnchors  = 0;

function deletePreview() {
    if (!previewNode) return;
    try {
        Document.current.executeCommand(
            DocumentCommand.createDeleteSelection(previewNode.selfSelection, false));
    } catch (e) { /* already gone */ }
    previewNode = null;
}

function updatePreview(targetCount) {
    if (!previewNode) return;
    const ci = previewNode.curvesInterface;
    if (!ci) return;
    Document.current.executeCommand(
        DocumentCommand.createSetCurves(ci,
            buildSimplifiedPolyCurve(subAnchorSets, targetCount, totalAnchors)));
}

function createPreview(origNode) {
    const doc    = Document.current;
    const dupCmd = DocumentCommand.createTransform(
        origNode.selfSelection, null, { duplicateNodes: true });
    doc.executeCommand(dupCmd);

    if (!dupCmd.newNodes || dupCmd.newNodes.length === 0)
        throw new Error('Duplicate failed. Select a shape or curve (not a group or text frame).');

    let dup = dupCmd.newNodes[0];
    doc.executeCommand(DocumentCommand.createSetVisibility(dup.selfSelection, true));

    if (!dup.curvesInterface) {
        doc.executeCommand(DocumentCommand.createConvertToCurves(Selection.create(doc, dup)));
        const after = doc.selection.firstNode;
        if (!after) throw new Error('Convert to curves failed.');
        dup = after;
    }

    const pc = dup.curvesInterface.polyCurve;
    subAnchorSets = [];
    totalAnchors  = 0;
    for (let i = 0; i < pc.curveCount; i++) {
        const c       = pc.at(i);
        const anchors = parseAnchors(c);
        subAnchorSets.push({ anchors, isClosed: c.isClosed });
        totalAnchors += anchors.length;
    }

    previewNode = dup;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function run() {
    const doc = Document.current;
    const sel = doc.selection;

    if (!sel || sel.length === 0) {
        const d = Dialog.create('Simplify Curves');
        d.addColumn().addGroup('').addStaticText('',
            'No object selected. Please select a curve or shape first.').isFullWidth = true;
        d.show();
        return;
    }

    const origNode = sel.firstNode;

    // Probe anchor count (temporarily convert if needed)
    let probeNode = origNode, tempConverted = false;
    if (!origNode.curvesInterface) {
        doc.executeCommand(DocumentCommand.createConvertToCurves(Selection.create(doc, origNode)));
        const after = doc.selection.firstNode;
        if (!after || !after.curvesInterface) {
            const d = Dialog.create('Simplify Curves');
            d.addColumn().addGroup('').addStaticText('',
                'Could not convert to curves.\n' +
                'Please select a shape or curve (not a group or text frame).').isFullWidth = true;
            d.show();
            return;
        }
        probeNode = after; tempConverted = true;
    }

    const origCount = countAnchors(probeNode.curvesInterface.polyCurve);
    if (tempConverted) doc.executeCommand(DocumentCommand.createUndo());

    if (origCount < 3) {
        const d = Dialog.create('Simplify Curves');
        d.addColumn().addGroup('').addStaticText('',
            `Curve has only ${origCount} nodes — nothing to simplify.`).isFullWidth = true;
        d.show();
        return;
    }

    // Hide original and spin up the preview
    doc.executeCommand(DocumentCommand.createSetVisibility(origNode.selfSelection, false));
    try {
        createPreview(origNode);
    } catch (e) {
        doc.executeCommand(DocumentCommand.createSetVisibility(origNode.selfSelection, true));
        const d = Dialog.create('Simplify Curves – Error');
        d.addColumn().addGroup('').addStaticText('', `Error: ${e.message || e}`).isFullWidth = true;
        d.show();
        return;
    }

    const initialTarget = Math.max(2, Math.round(origCount * 0.5));
    updatePreview(initialTarget);

    // ── Dialog ───────────────────────────────────────────────────────────────
    const dialog = Dialog.create('Simplify Curves');
    const col    = dialog.addColumn();

    col.addGroup('Selected Object').addStaticText('',
        `"${origNode.description}"  —  ${origCount} nodes`).isFullWidth = true;

    const sg       = col.addGroup('Simplification');
    const nodeCtrl = sg.addUnitValueEditor(
        'Node count', UnitType.None, UnitType.None,
        initialTarget, 2, origCount);
    nodeCtrl.showPopupSlider = true;
    nodeCtrl.precision       = 0;
    nodeCtrl.isFullWidth     = true;

    const infoText = sg.addStaticText('',
        `${initialTarget} of ${origCount} nodes kept`);
    infoText.isFullWidth = true;

    nodeCtrl.onValueChangedHandler = () => {
        const target = Math.max(2, Math.min(origCount, Math.round(nodeCtrl.value)));
        infoText.text = `${target} of ${origCount} nodes kept`;
        updatePreview(target);
    };

    // No custom button set — the dialog's native OK / Cancel is all we need
    const result = dialog.show();

    if (result.value === DialogResult.Ok.value) {
        // Confirm: delete hidden original, keep the simplified preview
        try {
            doc.executeCommand(
                DocumentCommand.createDeleteSelection(origNode.selfSelection, false));
        } catch (e) { /* already gone */ }
        previewNode = null;
    } else {
        // Cancel: remove preview, restore original
        deletePreview();
        try {
            doc.executeCommand(
                DocumentCommand.createSetVisibility(origNode.selfSelection, true));
        } catch (e) { /* already visible */ }
    }
}

run();
