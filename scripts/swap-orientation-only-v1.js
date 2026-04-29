'use strict';

const { Document }                    = require('/document');
const { DocumentCommand,
        CompoundCommandBuilder,
        NodeMoveType, NodeChildType } = require('/commands');
const { TransformBuilder }            = require('/geometry');

const doc = Document.current;
if (!doc) { console.log('No document open.'); return; }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getVisualRotation(node) {
    if (node[Symbol.toStringTag] === 'GroupNode') {
        for (const child of node.children)
            return child.baseToSpreadTransform.decompose().rotation;
    }
    return node.baseToSpreadTransform.decompose().rotation;
}

// ─── Capture selection ────────────────────────────────────────────────────────

const allNodes = [], seen = [];
for (const n of doc.selection.nodes) {
    if (!seen.some(s => s.isSameNode(n))) { seen.push(n); allNodes.push(n); }
}
const topLevel = allNodes.filter(n => {
    let p = n.parent;
    while (p) { if (allNodes.some(s => s.isSameNode(p))) return false; p = p.parent; }
    return true;
});

if (topLevel.length !== 2) {
    console.log('Select exactly 2 objects or groups.');
    return;
}

// ─── Snapshot BEFORE any mutation ────────────────────────────────────────────

const snap = topLevel.map(n => {
    const bb = n.getSpreadBaseBox(false);
    return {
        node : n,
        cx   : bb.x + bb.width  / 2,
        cy   : bb.y + bb.height / 2,
        rot  : getVisualRotation(n)
    };
});

// mapping: object 0 → goes to position of 1, object 1 → goes to position of 0
const mapping = [1, 0];

// ─── Duplicate both objects ───────────────────────────────────────────────────

const dups = [];
for (const i of [0, 1]) {
    const dup = snap[i].node.duplicate(null);
    if (!dup) { console.log('Duplication failed.'); return; }
    dups.push({ i, dup });
}

const cb = CompoundCommandBuilder.create();

for (const { i, dup } of dups) {
    const j   = mapping[i];   // destination index
    const src = snap[i];
    const dst = snap[j];

    // 1. Translate centre to destination centre
    const t1 = new TransformBuilder();
    t1.translate(dst.cx - src.cx, dst.cy - src.cy);
    cb.addCommand(DocumentCommand.createTransform(dup.selfSelection, t1.transform));

    // 2. Rotate to match destination orientation (NO size change)
    const delta = dst.rot - src.rot;
    if (Math.abs(delta) > 0.001) {
        const t2 = new TransformBuilder();
        t2.translate(-dst.cx, -dst.cy);
        t2.rotate(delta);
        t2.translate(dst.cx, dst.cy);
        cb.addCommand(DocumentCommand.createTransform(dup.selfSelection, t2.transform));
    }

    // 3. Z-order: place beside destination node
    cb.addCommand(DocumentCommand.createMoveNodes(
        dup.selfSelection, dst.node, NodeMoveType.After, NodeChildType.Main
    ));
}

// 4. Delete originals
for (const i of [0, 1]) {
    cb.addCommand(DocumentCommand.createDeleteSelection(snap[i].node.selfSelection, true));
}

// 5. Restore selection on both new duplicates
const newSel = dups[0].dup.selfSelection;
newSel.addNode(dups[1].dup);
cb.addCommand(DocumentCommand.createSetSelection(newSel));

doc.executeCommand(cb.createCommand());
console.log('Orientation swapped (position + rotation). Size unchanged.');
