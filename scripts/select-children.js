/**
 * name: Select Children
 * version: 0.1.0
 * description: Replaces the selection with the direct children (depth 1) of every selected element: layers, groups, artboards, and objects with clipped content or nested masks/adjustments. Selected elements without children stay selected. Runs without a dialog. Only the selection changes; like any selection change in Affinity, it is merged into the current "Set selection" history step.
 * author: WaveF
 * email: wavef@live.com
 */
'use strict';

const { app } = require('/application');
const { Document } = require('/document');
const { DocumentCommand } = require('/commands');
const { Selection } = require('/selections');

const SCRIPT_NAME = 'Select Children';
const VERSION = '0.1.0';
const SCRIPT_TITLE = SCRIPT_NAME + ' v' + VERSION;

function selectedNodes(doc) {
    const selection = doc.selection;
    const nodes = [];
    for (let i = 0; i < selection.length; i++) {
        const node = selection.at(i).node;
        if (node) nodes.push(node);
    }
    return nodes;
}

// Direct (Main) children of each selected element, in selection order then layer order.
// Elements without children are kept. Duplicates (e.g. a selected child of another
// selected element) are added once.
function computeChildSelection(nodes) {
    const result = [];
    const seen = [];
    const add = node => {
        if (seen.some(n => n.isSameNode(node))) return;
        seen.push(node);
        result.push(node);
    };
    let parents = 0;
    let children = 0;
    let kept = 0;
    for (const node of nodes) {
        const kids = [...node.children];
        if (kids.length === 0) {
            add(node);
            kept++;
            continue;
        }
        parents++;
        for (const child of kids) {
            add(child);
            children++;
        }
    }
    return { nodes: result, parents, children, kept };
}

function compactError(error) {
    return String(error && error.message ? error.message : error).replace(/\s+/g, ' ').trim();
}

function main() {
    const doc = Document.current;
    if (!doc) { app.alert('Please open a document first.', SCRIPT_TITLE); return; }
    try {
        const nodes = selectedNodes(doc);
        if (!nodes.length) throw new Error('Select one or more elements first.');
        const result = computeChildSelection(nodes);
        if (!result.parents) {
            app.alert('The selected element(s) have no children. The selection was not changed.', SCRIPT_TITLE);
            return;
        }
        doc.executeCommand(DocumentCommand.createSetSelection(Selection.create(doc, result.nodes)));
    } catch (error) {
        app.alert(compactError(error), SCRIPT_TITLE);
    }
}

main();
