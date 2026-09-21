/**
 * name: Reverse Order
 * description: Reverses selected layers within each parent, preserving unselected layer slots and group membership.
 * version: 1.0.1
  * author: WaveF
 * email: wavef@live.com
 * website: https://minicg.com
*/
'use strict';

const { app } = require('/application');
const { Document } = require('/document');
const { Selection } = require('/selections');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
const { NodeMoveType, NodeChildType } = require('affinity:dom');

function reverseOrder(doc) {
    if (!doc) throw new Error('Please open a document first.');
    const selected = [];
    for (let i = 0; i < doc.selection.length; i++) {
        const node = doc.selection.at(i).node;
        if (node) selected.push(node);
    }
    if (selected.length < 2) throw new Error('Please select at least two layers.');
    const groups = [];
    for (const node of selected) {
        const parent = node.parent;
        if (!parent) continue;
        let group = groups.find(g => g.parent.isSameNode(parent));
        if (!group) {
            group = { parent, selected: [] };
            groups.push(group);
        }
        group.selected.push(node);
    }
    const builder = CompoundCommandBuilder.create();
    let reversed = 0;
    const expected = [];
    for (const group of groups) {
        const siblings = Array.from(group.parent.children);
        const slots = [];
        siblings.forEach((node, index) => {
            if (group.selected.some(s => s.isSameNode(node))) slots.push(index);
        });
        // Enclosures/masks are not ordinary layers: never move them into Main.
        if (slots.length < 2) continue;
        const spread = group.parent.isSpreadNode ? group.parent : group.parent.spread;
        if (!spread || !spread.isSameNode(doc.currentSpread)) {
            throw new Error('Please select layers on the current spread only.');
        }
        for (let i = 0; i < Math.floor(slots.length / 2); i++) {
            const leftIndex = slots[i];
            const rightIndex = slots[slots.length - 1 - i];
            const left = siblings[leftIndex];
            const right = siblings[rightIndex];
            const previous = siblings[rightIndex - 1];
            builder.addCommand(DocumentCommand.createMoveNodes(
                Selection.create(doc, right), left, NodeMoveType.Before, NodeChildType.Main));
            builder.addCommand(DocumentCommand.createMoveNodes(
                Selection.create(doc, left), previous.isSameNode(left) ? right : previous,
                NodeMoveType.After, NodeChildType.Main));
            siblings[leftIndex] = right;
            siblings[rightIndex] = left;
        }
        expected.push({ parent: group.parent, nodes: siblings });
        reversed += slots.length;
    }
    if (!reversed) throw new Error('Select at least two ordinary layers within the same parent.');
    builder.addCommand(DocumentCommand.createSetSelection(Selection.create(doc, selected)));
    const start = doc.history.position;
    try {
        doc.executeCommand(builder.createCommand());
        for (const group of expected) {
            const actual = Array.from(group.parent.children);
            if (actual.length !== group.nodes.length || actual.some((n, i) => !n.isSameNode(group.nodes[i]))) {
                throw new Error('Affinity could not reorder these layers. The changes have been rolled back.');
            }
        }
    } catch (error) {
        if (doc.history.position !== start) doc.history.position = start;
        doc.selection = selected;
        throw error;
    }
    return { reversed, parents: expected.length, skipped: selected.length - reversed };
}

function main() {
    try {
        console.log(JSON.stringify(reverseOrder(Document.current)));
    } catch (error) {
        app.alert(String(error.message || error), 'Reverse Order');
    }
}

main();
