// author: WaveF
// email: wavef@live.com
// website: https://minicg.com
// name: Convert 2 Artboards
// version: 1.0.2
// Convert each selected element into an independent artboard.
// Images and other nodes without an ArtboardInterface are placed in a new
// artboard matching their spread-space bounds. Existing artboards are skipped.
'use strict';

const { app } = require('/application');
const { Document } = require('/document');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
const { Selection } = require('/selections');
const { ShapeNodeDefinition } = require('/nodes');
const { ShapeRectangle } = require('/shapes');
const { Rectangle } = require('/geometry');
const { NodeMoveType, NodeChildType } = require('affinity:dom');

function isArtboard(node) {
    return !!node.artboardInterface?.isArtboardEnabled;
}

function convert_2_artboards(doc) {
    if (!doc) throw new Error('Please open a document first.');
    const selected = [];
    for (let i = 0; i < doc.selection.length; i++) {
        const node = doc.selection.at(i).node;
        if (node) selected.push(node);
    }
    if (!selected.length) throw new Error('Please select the elements you want to convert.');

    const results = [];
    const report = { converted: 0, skipped: 0, failed: [] };
    for (const node of selected) {
        const label = node.userDescription || node.defaultDescription || 'Unnamed element';
        if (isArtboard(node)) {
            report.skipped++;
            results.push(node);
            continue;
        }
        const spread = node.spread;
        if (!spread.isSameNode(doc.currentSpread)) {
            doc.executeCommand(DocumentCommand.createSetCurrentSpread(spread));
        }
        const historyPosition = doc.history.position;
        try {
            const selection = Selection.create(doc, node);
            let artboard;
            if (node.artboardInterface) {
                doc.executeCommand(DocumentCommand.createSetArtboardEnabled(selection, true));
                if (!isArtboard(node)) throw new Error('This element cannot be converted directly to an artboard.');
                artboard = node;
            } else {
                const box = node.getSpreadBaseBox();
                if (![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
                    box.width <= 0 || box.height <= 0) {
                    throw new Error('The element does not have valid two-dimensional bounds.');
                }
                const definition = ShapeNodeDefinition.createDefault();
                definition.shape = ShapeRectangle.create();
                // Affinity rounds new artboard origins to whole pixels. Round
                // outward so fractional image edges are never clipped.
                const left = Math.floor(box.x);
                const top = Math.floor(box.y);
                definition.setBoundingRectangle(new Rectangle(left, top,
                    Math.ceil(box.x + box.width) - left,
                    Math.ceil(box.y + box.height) - top));
                definition.userDescription = label;
                const add = DocumentCommand.createAddArtboard(definition);
                doc.executeCommand(add);
                artboard = add.newNodes.find(isArtboard);
                if (!artboard) throw new Error('Could not create the artboard.');

                const move = CompoundCommandBuilder.create();
                // Keep top-level stacking order. Nested content is moved to its
                // own top-level artboard using Affinity's native move command.
                if (node.parent.isSameNode(spread)) {
                    move.addCommand(DocumentCommand.createMoveNodes(
                        Selection.create(doc, artboard), node, NodeMoveType.Before, NodeChildType.Main));
                }
                move.addCommand(DocumentCommand.createMoveNodes(
                    selection, artboard, NodeMoveType.Inside, NodeChildType.Main));
                doc.executeCommand(move.createCommand());
                if (!node.parent.isSameNode(artboard)) throw new Error('Could not move the element into the artboard.');
            }
            results.push(artboard);
            report.converted++;
        } catch (error) {
            // Roll back this element only, including any empty artboard.
            if (doc.history.position !== historyPosition) doc.history.position = historyPosition;
            results.push(node);
            report.failed.push(label + ': ' + String(error.message || error));
        }
    }
    doc.selection = results;
    return report;
}

function main() {
    try {
        const report = convert_2_artboards(Document.current);
        let message = 'Converted: ' + report.converted + '\nExisting artboards skipped: ' + report.skipped;
        if (report.failed.length) message += '\nFailed conversions:\n' + report.failed.join('\n');
        console.log(JSON.stringify(report));
        app.alert(message, 'Convert 2 Artboards');
    } catch (error) {
        app.alert(String(error.message || error), 'Convert 2 Artboards');
    }
}

main();
