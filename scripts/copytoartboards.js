'use strict';

const { Document } = require('/document');
const { Selection } = require('/selections');
const { DocumentCommand, NodeMoveType, NodeChildType } = require('/commands');
const { Transform } = require('/geometry');

const doc = Document.current;
if (!doc) {
    console.log('Error: No document open.');
    return;
}

// 1. Capture selection BEFORE anything else
const selectedNodes = [];
const sel = doc.selection;

for (let i = 0; i < sel.length; i++) {
    const n = sel.at(i).node;
    if (n) selectedNodes.push(n);
}

if (selectedNodes.length === 0) {
    console.log('Nothing selected. Select objects on an artboard and run again.');
    return;
}

// 2. Get all artboards on the current spread
const spread = doc.currentSpread;
const artboards = spread.artboards;

if (artboards.length < 2) {
    console.log('Need at least 2 artboards to copy between them.');
    return;
}

// Helper: find which artboard a node lives in
function findParentArtboard(node) {
    const parent = node.parent;
    if (!parent) return null;

    try {
        const abIface = parent.artboardInterface;
        if (abIface && abIface.isArtboardEnabled) {
            return { abNode: parent, box: abIface.spreadBaseBox };
        }
    } catch (e) {}

    return null;
}

// 3. Copy each selected node to every other artboard
let copiedCount = 0;
let skippedCount = 0;

for (const sourceNode of selectedNodes) {
    const sourceArtboard = findParentArtboard(sourceNode);

    if (!sourceArtboard) {
        console.log(
            'Skipping "' +
            (sourceNode.userDescription || 'unnamed') +
            '" - not inside an artboard.'
        );
        skippedCount++;
        continue;
    }

    // Position of the node relative to its artboard's origin
    const nodeBox = sourceNode.getSpreadBaseBox(false);
    const srcAbBox = sourceArtboard.box;

    const relX = nodeBox.x - srcAbBox.x;
    const relY = nodeBox.y - srcAbBox.y;

    for (const targetAb of artboards) {
        // Skip the artboard the node already lives on
        if (targetAb.node.isSameNode(sourceArtboard.abNode)) continue;

        const tgtBox = targetAb.spreadBaseBox;

        // Translate so the copy lands at the same relative position on the target
        const dx = tgtBox.x - srcAbBox.x;
        const dy = tgtBox.y - srcAbBox.y;

        // Duplicate (with translation)
        const xf = Transform.createTranslate(dx, dy);
        const dup = sourceNode.duplicate(xf);

        if (!dup) {
            console.log('Duplicate failed for node on "' + targetAb.description + '"');
            continue;
        }

        // Move the duplicate inside the target artboard
        const dupSel = Selection.create(doc, dup);
        const moveCmd = DocumentCommand.createMoveNodes(
            dupSel,
            targetAb.node,
            NodeMoveType.Inside,
            NodeChildType.Main
        );

        doc.executeCommand(moveCmd);

        copiedCount++;
        console.log('✓ Copied to "' + targetAb.description + '"');
    }
}

console.log(
    '\nDone - ' +
    copiedCount +
    ' cop' +
    (copiedCount === 1 ? 'y' : 'ies') +
    ' made.' +
    (skippedCount > 0
        ? ' (' + skippedCount + ' skipped - not on an artboard)'
        : '')
);