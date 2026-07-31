// Plotter Declutter (Native) — v4
// Computes what's actually visible in a stack of overlapping vector shapes by
// subtracting everything drawn on top of each shape from that shape.
// Native Affinity Script version of the Plotter Declutter web app
// (https://3dvic.com/apps/plotter-declutter/), for shapes already imported
// into the document.
//
// HOW TO USE:
// 1. Import/paste your plotter/generative-art SVG into an Affinity document.
// 2. Select ALL the shapes that make up the artwork (Edit > Select All works
//    even if the shapes are nested inside a group, as SVG imports usually are).
// 3. Run this script.
// 4. Each shape is clipped to only the portion not covered by shapes drawn
//    after it. Shapes fully hidden behind later shapes are removed entirely.
//
// KNOWN LIMITATION: this works on CLOSED shapes (real filled/fillable areas).
// If your source shapes are OPEN strokes (plain lines with no closed area --
// e.g. straight from Cavalry as raw paths), this script won't clip them
// correctly yet. If you hit that, let us know what you see and we'll take it
// from there.

const { Document } = require('/document');
const { DocumentCommand } = require('/commands');
const { DocumentCommandApi } = require('affinity:commands');
const { Selection } = require('/selections');
const { Dialog } = require('/dialog');

function showMessage(title, lines) {
    const dlg = Dialog.create(title);
    dlg.initialWidth = 420;
    const col = dlg.addColumn();
    const grp = col.addGroup("");
    for (const line of lines) {
        if (line === "") continue;
        const label = grp.addStaticText(line, "");
        label.isFullWidth = true;
    }
    dlg.runModal();
}

(function plotterDeclutterNative() {
    const doc = Document.current;
    if (!doc) {
        console.log("Plotter Declutter: no active document.");
        return;
    }
    const spread = doc.currentSpread;
    const sel = doc.selection;

    if (!sel || sel.length < 2) {
        showMessage("Plotter Declutter", [
            "Select at least 2 overlapping shapes before running this script.",
            "Import your SVG, select all the shapes that make up the artwork, then run this again."
        ]);
        return;
    }

    const selectedNodes = Array.from(sel.nodes);

    const allLayers = Array.from(spread.layers.all);
    const withZ = selectedNodes
        .map(n => ({ node: n, z: allLayers.findIndex(l => l.isSameNode(n)) }))
        .filter(o => o.z >= 0);
    withZ.sort((a, b) => a.z - b.z);

    if (withZ.length < 2) {
        showMessage("Plotter Declutter", ["Could not resolve the stacking order of the selected shapes.", "Make sure they're all on the current spread."]);
        return;
    }

    const t0 = Date.now();
    let runningUnion = null;
    const results = new Array(withZ.length);
    let hiddenCount = 0;

    for (let i = withZ.length - 1; i >= 0; i--) {
        const shape = withZ[i].node;

        if (runningUnion) {
            const dupForMask = shape.duplicate();
            const maskCopyForSubtract = runningUnion.duplicate();

            const selSub = Selection.create(doc, [shape, maskCopyForSubtract], true);
            const cmdSub = new DocumentCommand(DocumentCommandApi.createBoolOpSubtractCommand(selSub.handle));
            doc.executeCommand(cmdSub);

            if (doc.selection.length > 0) {
                results[i] = doc.selection.at(0).node;
            } else {
                results[i] = null;
                hiddenCount++;
            }

            const selUnion = Selection.create(doc, [runningUnion, dupForMask], true);
            const cmdUnion = new DocumentCommand(DocumentCommandApi.createBoolOpUnionCommand(selUnion.handle));
            doc.executeCommand(cmdUnion);
            runningUnion = doc.selection.at(0).node;
        } else {
            results[i] = shape;
            runningUnion = shape.duplicate();
        }
    }

    const elapsedMs = Date.now() - t0;

    doc.deleteSelection(runningUnion);

    const visibleResults = results.filter(r => r !== null);
    if (visibleResults.length > 0) {
        doc.selection = Selection.create(doc, visibleResults, true);
    }

    const seconds = (elapsedMs / 1000).toFixed(1);
    showMessage("Plotter Declutter — Done", [
        withZ.length + " shapes processed in " + seconds + "s.",
        visibleResults.length + " shapes are now visible" +
            (hiddenCount > 0 ? " (" + hiddenCount + " were fully hidden and removed)." : "."),
        "Export as SVG/DXF from here as usual."
    ]);
})();
