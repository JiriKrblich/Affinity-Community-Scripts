/**
 * name: Reverse Order
 * description: Reverses selected layers within each parent, preserving unselected layer slots and group membership. Supports Vector, Raster (Pixel/Image), and Enclosures/Masks.
 * version: 1.0.2
 * author: WaveF (Enhanced for Raster & Enclosures)
 * website: https://minicg.com
*/
'use strict';

const { app } = require('/application');
const { Document } = require('/document');
const { Selection } = require('/selections');
const { DocumentCommand, CompoundCommandBuilder, NodeMoveType, NodeChildType } = require('/commands');

function reverseOrder(doc) {
    if (!doc) throw new Error('Please open a document first.');
    const selected = [];
    for (let i = 0; i < doc.selection.length; i++) {
        const node = doc.selection.at(i).node;
        if (node) selected.push(node);
    }
    if (selected.length < 2) throw new Error('Please select at least two layers.');

    // Classify selected nodes by (parent, childType)
    // Layers under a parent can reside in Main children (vector, pixel, image, group)
    // or Enclosures (masks, raster masks, live adjustments)
    const groups = [];
    for (const node of selected) {
        const parent = node.parent;
        if (!parent) continue;

        let childType = NodeChildType.Main;
        let isEnclosure = false;
        if (parent.enclosures && Array.from(parent.enclosures).some(e => e.isSameNode(node))) {
            childType = NodeChildType.Enclosure;
            isEnclosure = true;
        }

        let group = groups.find(g => g.parent.isSameNode(parent) && g.childType === childType);
        if (!group) {
            group = { parent, childType, isEnclosure, selected: [] };
            groups.push(group);
        }
        group.selected.push(node);
    }

    const builder = CompoundCommandBuilder.create();
    let reversedCount = 0;
    const expectedVerifications = [];

    for (const group of groups) {
        const siblings = group.isEnclosure ? Array.from(group.parent.enclosures) : Array.from(group.parent.children);
        const slots = [];
        siblings.forEach((node, index) => {
            if (group.selected.some(s => s.isSameNode(node))) slots.push(index);
        });

        if (slots.length < 2) continue;

        const spread = group.parent.isSpreadNode ? group.parent : group.parent.spread;
        if (!spread || !spread.isSameNode(doc.currentSpread)) {
            throw new Error('Please select layers on the current spread only.');
        }

        // Selected nodes in original slot order
        const selNodesInSlotOrder = slots.map(idx => siblings[idx]);
        const reversedSelNodes = [...selNodesInSlotOrder].reverse();

        // Build desired order of siblings with reversed slots
        const desiredOrder = [...siblings];
        slots.forEach((slotIdx, i) => {
            desiredOrder[slotIdx] = reversedSelNodes[i];
        });

        // Deterministic sequential alignment algorithm:
        // Move any node not at its target index using relative Before / After commands
        const currentList = [...siblings];
        for (let i = 0; i < desiredOrder.length; i++) {
            const targetNode = desiredOrder[i];
            if (currentList[i].isSameNode(targetNode)) continue;

            const currentIndex = currentList.findIndex(n => n.isSameNode(targetNode));
            if (currentIndex === -1) continue;

            if (i === 0) {
                builder.addCommand(DocumentCommand.createMoveNodes(
                    Selection.create(doc, targetNode),
                    currentList[0],
                    NodeMoveType.Before,
                    group.childType
                ));
            } else {
                builder.addCommand(DocumentCommand.createMoveNodes(
                    Selection.create(doc, targetNode),
                    currentList[i - 1],
                    NodeMoveType.After,
                    group.childType
                ));
            }

            // Keep simulation list aligned with live DOM shifts
            currentList.splice(currentIndex, 1);
            currentList.splice(i, 0, targetNode);
        }

        expectedVerifications.push({
            parent: group.parent,
            isEnclosure: group.isEnclosure,
            childType: group.childType,
            nodes: desiredOrder
        });
        reversedCount += slots.length;
    }

    if (!reversedCount) {
        throw new Error('Select at least two layers within the same parent to reverse.');
    }

    builder.addCommand(DocumentCommand.createSetSelection(Selection.create(doc, selected)));
    const start = doc.history.position;
    try {
        doc.executeCommand(builder.createCommand());
        for (const exp of expectedVerifications) {
            const actual = exp.isEnclosure ? Array.from(exp.parent.enclosures) : Array.from(exp.parent.children);
            if (actual.length !== exp.nodes.length || actual.some((n, i) => !n.isSameNode(exp.nodes[i]))) {
                throw new Error('Affinity could not reorder these layers. The changes have been rolled back.');
            }
        }
    } catch (error) {
        if (doc.history.position !== start) doc.history.position = start;
        doc.selection = Selection.create(doc, selected);
        throw error;
    }

    return { reversed: reversedCount, parents: expectedVerifications.length, skipped: selected.length - reversedCount };
}

function main() {
    try {
        const result = reverseOrder(Document.current);
        console.log('Reverse Order:', JSON.stringify(result));
    } catch (error) {
        app.alert(String(error.message || error), 'Reverse Order');
    }
}

main();
