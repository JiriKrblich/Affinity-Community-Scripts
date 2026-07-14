'use strict';
/**
 * name: CMYK Layer Creator
 * description: Create a grouped set of pixel layers for blue, red, yellow, and black,
 * as well as line work, all set to a blend mode of Multiply and tagged with color.
 * version: 1.0.0
 * author: Sir Cake
 */
const { Document } = require('/document');
const { RasterFormat } = require('/rasterobject');
const { ContainerNodeDefinition, RasterNodeDefinition, NodeChildType } = require('/nodes');
const { AddChildNodesCommandBuilder, DocumentCommand, InsertionMode } = require('/commands');
const { BlendMode } = require('/blendmodeinterface');
const { Selection } = require('/selections');
const { RGBA8 } = require('/colours');

const doc = Document.current;
if (!doc) {
    console.log("ERROR: No document is open.");
} else {
    const originalFormat = doc.format;
    const isPhotoFormat = originalFormat.value === 0;

    // If not a Photo document, temporarily convert so pixel layers can be added
    if (!isPhotoFormat) {
        const convertCmd = DocumentCommand.createConvertDocumentFormat({ value: 0 });
        doc.executeCommand(convertCmd);
    }

    const spread = doc.rootNode.firstChild;

    // Step 1: Create "Color" group
    const groupDef = ContainerNodeDefinition.create('Color');
    const groupBuilder = AddChildNodesCommandBuilder.create();
    groupBuilder.addContainerNode(groupDef);
    groupBuilder.setInsertionTarget(spread);
    doc.executeCommand(groupBuilder.createCommand(false, NodeChildType.Main));

    let groupNode = null;
    for (const child of spread.children) {
        if (child.isContainerNode && child.userDescription === 'Color') {
            groupNode = child;
            break;
        }
    }

    if (!groupNode) {
        console.log("ERROR: Could not find Color group.");
    } else {
        // Step 2: Add 5 pixel layers with blend mode and label colours
        const layers = [
            { name: 'Blue',     colour: RGBA8(21,  190, 253) },
            { name: 'Red',      colour: RGBA8(244, 87,  178) },
            { name: 'Yellow',   colour: RGBA8(255, 242, 125)  },
            { name: 'Black',    colour: RGBA8(164, 164, 164) },
            { name: 'Line Art', colour: RGBA8(207, 158, 255) },
        ];

        for (const layerDef of layers) {
            const rasterDef = RasterNodeDefinition.create(RasterFormat.RGBA8);
            rasterDef.userDescription = layerDef.name;

            const layerBuilder = AddChildNodesCommandBuilder.create();
            layerBuilder.addRasterNode(rasterDef);
            layerBuilder.setInsertionTarget(groupNode);
            layerBuilder.setInsertionMode(InsertionMode.Inside_AtFront);
            doc.executeCommand(layerBuilder.createCommand(false, NodeChildType.Main));

            const newLayer = groupNode.children.first;
            if (newLayer) {
                const sel = Selection.create(doc, newLayer);
                doc.setBlendMode(BlendMode.Multiply, false, sel);
                const tagCmd = DocumentCommand.createSetTagColour(sel, layerDef.colour);
                doc.executeCommand(tagCmd);
                console.log("Added layer: " + newLayer.userDescription);
            }
        }

        console.log("Done! Group 'Color' with 5 pixel layers created.");
    }

    // Convert back to original format if we changed it
    if (!isPhotoFormat) {
        const revertCmd = DocumentCommand.createConvertDocumentFormat(originalFormat);
        doc.executeCommand(revertCmd);
    }
}
