/**
 * name: Split to grid
 * description: Split vector object into an adjustable grid with live preview
 * version: 1.6.0
 * author: JiriKrblich
 *
 * v1.5 fix: the knife cut operates in SPREAD coordinates, but the script used
 * node.baseBox (node-LOCAL). For any moved / rotated / nested object baseBox
 * differs from the spread position, so every cut line missed the object and it
 * produced a single un-cut piece (i.e. "no grid"). Now all cut geometry and the
 * gap-strip detection use spread coordinates (getSpreadVisibleBox). Also adds a
 * reentrancy guard around the live preview.
 * v1.6: detect an OPEN (un-closed) path and stop with a clear message — knife
 * cutting an open path cannot produce closed grid pieces.
 */

'use strict';
const { Document }             = require('/document');
const { Dialog, DialogResult } = require('/dialog');
const { UnitType }             = require('/units');
const { DocumentCommand }      = require('/commands');
const { CurveBuilder }         = require('/geometry');
const { Selection }            = require('/selections');

// State
let currentPieces = [];
let config = { cols: 3, rows: 3, gap: 10 };

// Object bounds in SPREAD coordinates (the space the knife cut works in).
function spreadBox(node) {
    try { return node.getSpreadVisibleBox ? node.getSpreadVisibleBox(true) : node.spreadVisibleBox; }
    catch (e) { return node.spreadVisibleBox; }
}

// True if the node is a curve with at least one OPEN (un-closed) sub-path.
// Shapes / images have no curvesInterface and are treated as closed/cuttable.
function hasOpenPath(node) {
    try {
        const ci = node.curvesInterface;
        if (!ci) return false;
        const pc = ci.polyCurve;
        if (!pc || pc.curveCount === 0) return false;
        for (let i = 0; i < pc.curveCount; i++) {
            let closed = true;
            try { closed = pc.at(i).isClosed !== false; } catch (e) {}
            if (!closed) return true;
        }
        return false;
    } catch (e) {
        return false; // can't tell -> let it proceed
    }
}

// Cleanup: remove slices from previous preview
function deletePieces() {
    const doc = Document.current;
    for (const p of currentPieces) {
        try { doc.executeCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, p), false)); }
        catch (e) { /* already gone */ }
    }
    currentPieces = [];
}

// Core: knife-cut grid with equal-size pieces
//
// Fit mode: pieces plus gaps keep the same outer bounds as the original.
// Formula:
//   pieceW = (W - (cols - 1) * gap) / cols
//   cols * pieceW + (cols - 1) * gap === W
//
// Stability fix: null-guard after ConvertToCurves (node ref is replaced by
// Affinity), try/catch around every knife call.
function generateGrid(origNode, origBox) {
    const doc  = Document.current;
    const { cols, rows, gap } = config;

    const pieceW = (origBox.width  - (cols - 1) * gap) / cols;
    const pieceH = (origBox.height - (rows - 1) * gap) / rows;
    const half   = gap / 2;

    if (pieceW <= 0 || pieceH <= 0) {
        throw new Error('Gap is too large for the selected object and grid size.');
    }

    // Duplicate hidden original, show & convert the duplicate
    const dupCmd = DocumentCommand.createTransform(
        origNode.selfSelection, null, { duplicateNodes: true });
    doc.executeCommand(dupCmd);

    if (!dupCmd.newNodes || dupCmd.newNodes.length === 0) {
        throw new Error(
            'Duplicate failed. Object must be a shape or image - not a group or text frame.');
    }

    const dup = dupCmd.newNodes[0];
    doc.executeCommand(DocumentCommand.createSetVisibility(dup.selfSelection, true));
    doc.executeCommand(DocumentCommand.createConvertToCurves(Selection.create(doc, dup)));

    // createConvertToCurves replaces the node; read result from selection
    const selAfter = doc.selection.nodes;
    const converted = (selAfter && selAfter.length > 0) ? selAfter.first : null;
    if (!converted) {
        throw new Error(
            'Convert to Curves produced no output. Try manually converting the object first.');
    }

    // Safety net: an open path cannot be split into closed grid pieces.
    if (hasOpenPath(converted)) {
        throw new Error('The selected path is not closed. Close the path before splitting to a grid.');
    }

    let pieces = [converted];

    function cutAll(line) {
        const next = [];
        for (const p of pieces) {
            try {
                const cmd = DocumentCommand.createKnifeCut(line, Selection.create(doc, p));
                doc.executeCommand(cmd);
                next.push(...(cmd.newNodes && cmd.newNodes.length === 2 ? cmd.newNodes : [p]));
            } catch (e) { next.push(p); }
        }
        pieces = next;
    }

    function deleteStrips(lo, hi, axis) {
        const keep = [], del = [];
        for (const p of pieces) {
            try {
                const bb = spreadBox(p);
                if (!bb) { keep.push(p); continue; }
                const mid = axis === 'x' ? bb.x + bb.width / 2 : bb.y + bb.height / 2;
                (mid > lo && mid < hi ? del : keep).push(p);
            } catch (e) { keep.push(p); }
        }
        for (const p of del) {
            try { doc.executeCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, p), false)); }
            catch (e) { /* already gone */ }
        }
        pieces = keep;
    }

    // Horizontal dividers
    for (let r = 1; r < rows; r++) {
        const midY = origBox.y + r * pieceH + (r - 0.5) * gap;
        if (gap > 0) {
            cutAll(new CurveBuilder().beginXY(origBox.x - 200, midY - half).lineToXY(origBox.x + origBox.width + 200, midY - half).createCurve());
            cutAll(new CurveBuilder().beginXY(origBox.x - 200, midY + half).lineToXY(origBox.x + origBox.width + 200, midY + half).createCurve());
            deleteStrips(midY - half, midY + half, 'y');
        } else {
            cutAll(new CurveBuilder().beginXY(origBox.x - 200, midY).lineToXY(origBox.x + origBox.width + 200, midY).createCurve());
        }
    }

    // Vertical dividers
    for (let c = 1; c < cols; c++) {
        const midX = origBox.x + c * pieceW + (c - 0.5) * gap;
        if (gap > 0) {
            cutAll(new CurveBuilder().beginXY(midX - half, origBox.y - 200).lineToXY(midX - half, origBox.y + origBox.height + 200).createCurve());
            cutAll(new CurveBuilder().beginXY(midX + half, origBox.y - 200).lineToXY(midX + half, origBox.y + origBox.height + 200).createCurve());
            deleteStrips(midX - half, midX + half, 'x');
        } else {
            cutAll(new CurveBuilder().beginXY(midX, origBox.y - 200).lineToXY(midX, origBox.y + origBox.height + 200).createCurve());
        }
    }

    currentPieces = pieces;
}

// Main
function run() {
    const doc = Document.current;
    const sel = doc.selection;

    if (!sel || sel.length === 0) {
        const dlg = Dialog.create('Split to Grid');
        dlg.addColumn().addGroup('').addStaticText('',
            'No object selected. Please select one object first.').isFullWidth = true;
        try { dlg.runModal(); } catch (eMsg) {}
        return;
    }

    const origNode = sel.nodes.first;

    let origBox;
    try {
        origBox = spreadBox(origNode);
        if (!origBox || origBox.width <= 0 || origBox.height <= 0) throw new Error();
    } catch (e) {
        const dlg = Dialog.create('Split to Grid');
        dlg.addColumn().addGroup('').addStaticText('',
            'Selected object has no valid dimensions.\n' +
            'Please select a shape or image (not a group or text frame).').isFullWidth = true;
        try { dlg.runModal(); } catch (eMsg) {}
        return;
    }

    // An open path can't be knife-cut into closed grid pieces — stop early.
    if (hasOpenPath(origNode)) {
        const dlg = Dialog.create('Split to Grid');
        dlg.addColumn().addGroup('').addStaticText('',
            'The selected path is not closed.\n' +
            'Close the path first (select its open end nodes and Close Curve),\n' +
            'then run Split to Grid again.').isFullWidth = true;
        try { dlg.runModal(); } catch (eMsg) {}
        return;
    }

    // Hide original; only the live-preview slices will be visible
    doc.executeCommand(DocumentCommand.createSetVisibility(origNode.selfSelection, false));

    // Build dialog once.
    const dialog = Dialog.create('Split to Grid');
    const col    = dialog.addColumn();

    col.addGroup('Selected Object').addStaticText('',
        `"${origNode.description}"  -  ${Math.round(origBox.width)} x ${Math.round(origBox.height)} px`
    ).isFullWidth = true;

    const sg = col.addGroup('Grid Settings');

    const colsCtrl = sg.addUnitValueEditor('Columns', UnitType.None, UnitType.None, config.cols, 1, 24);
    colsCtrl.showPopupSlider = true;
    colsCtrl.precision = 0;

    const rowsCtrl = sg.addUnitValueEditor('Rows', UnitType.None, UnitType.None, config.rows, 1, 24);
    rowsCtrl.showPopupSlider = true;
    rowsCtrl.precision = 0;

    const gapCtrl = sg.addUnitValueEditor('Gap', UnitType.Pixel, UnitType.Pixel, config.gap, 0, 200);
    gapCtrl.showPopupSlider = true;

    const statusGrp = col.addGroup('');
    statusGrp.enableSeparator = true;
    const statusTxt = statusGrp.addStaticText('', '');
    statusTxt.isFullWidth = true;

    function readConfig() {
        config.cols = Math.max(1, Math.round(colsCtrl.value));
        config.rows = Math.max(1, Math.round(rowsCtrl.value));
        config.gap  = Math.max(0, gapCtrl.value);
    }

    // Reentrancy guard: executeCommand can pump native events and re-enter this
    // handler mid-rebuild -> currentPieces clobbered / interleaved cuts -> crash.
    let updating = false;
    function updatePreview() {
        if (updating) return false;
        updating = true;
        try {
            readConfig();
            deletePieces();
            try {
                generateGrid(origNode, origBox);
                statusTxt.text = `Preview: ${config.cols} x ${config.rows}, gap ${Math.round(config.gap)} px`;
                return true;
            } catch (e) {
                deletePieces();
                statusTxt.text = `Could not split: ${e.message || e}`;
                return false;
            }
        } finally {
            updating = false;
        }
    }

    // Initial live preview.
    if (!updatePreview()) {
        try { doc.executeCommand(DocumentCommand.createSetVisibility(origNode.selfSelection, true)); } catch (_) {}
        const errDlg = Dialog.create('Split to Grid - Error');
        errDlg.addColumn().addGroup('').addStaticText('',
            `${statusTxt.text}\n\nTip: convert it to curves first via Layer > Convert to Curves.`
        ).isFullWidth = true;
        try { errDlg.runModal(); } catch (eMsg) {}
        return;
    }

    dialog.onControlValueChangedHandler = () => {
        updatePreview();
    };

    // runModal() throws ABORTED on Cancel; treat that as "not OK" so the
    // cancel-cleanup below (restore original, drop preview slices) still runs.
    let apply = false;
    try { apply = dialog.runModal().value === DialogResult.Ok.value; } catch (e) { apply = false; }

    if (apply) {
        if (currentPieces.length === 0 && !updatePreview()) {
            try { doc.executeCommand(DocumentCommand.createSetVisibility(origNode.selfSelection, true)); } catch (_) {}
            const errDlg = Dialog.create('Split to Grid - Error');
            errDlg.addColumn().addGroup('').addStaticText('', statusTxt.text).isFullWidth = true;
            try { errDlg.runModal(); } catch (eMsg) {}
            return;
        }

        // Apply: delete the hidden original and keep the live-preview slices.
        try {
            doc.executeCommand(
                DocumentCommand.createDeleteSelection(origNode.selfSelection, false));
        } catch (e) { /* already gone */ }
        currentPieces = [];
    } else {
        // Cancel: discard slices and restore the original object.
        deletePieces();
        try {
            doc.executeCommand(
                DocumentCommand.createSetVisibility(origNode.selfSelection, true));
        } catch (e) { /* already visible */ }
    }
}

run();