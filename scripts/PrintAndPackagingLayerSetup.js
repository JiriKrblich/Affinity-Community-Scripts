/**
 * name: Print & Packaging Layer Setup
 * description: Automatically generates a standardized layer structure for print and packaging design, including Dielines, Special Finishes, Main Design, and Background groups.
 * version: 1.0.0
 * author: Packaging Assistant
 */

'use strict';

// STREAMING_CHUNK:Importing required Affinity modules...
const { Document: AffinityDocument } = require('/document');
const Nodes = require('/nodes');
const Commands = require('/commands');

function runSetup() {
    // STREAMING_CHUNK:Initializing document and target context...
    const doc = AffinityDocument.current;

    if (!doc) {
        console.log("ERROR: No document open. Please open or create a document first.");
        return;
    }

    let target = doc.currentSpread;
    const sel = doc.selection;

    // STREAMING_CHUNK:Resolving artboard selection...
    // If an object or artboard is selected, target that specific artboard
    if (sel && sel.length > 0) {
        let node = sel.at(0).node;
        let depth = 0;

        while (node && depth < 12) {
            const ai = node.artboardInterface;
            if (ai && ai.isArtboardEnabled) {
                target = node;
                break;
            }
            node = node.parent;
            depth++;
        }
    }

    // STREAMING_CHUNK:Defining the print and packaging layer structure...
    // Arrays are defined in BOTTOM-TO-TOP order.
    const layerStructure = [
        {
            name: "4. BACKGROUND (Prints + extends into bleed)",
            children: [
                "Solid background",
                "Background image",
                "Pattern"
            ]
        },
        {
            name: "3. MAIN DESIGN (Prints)",
            children: [
                "Decorative graphics",
                "Illustrations",
                "Typography",
                "Logo"
            ]
        },
        {
            name: "2. SPECIAL FINISHES (Technical production artwork)",
            children: [
                "Spot UV",
                "Deboss",
                "Emboss",
                "Foil"
            ]
        },
        {
            name: "1. DIELINE (Technical / non-artwork)",
            children: [
                "Bleed Paths",
                "Trim / technical vectors",
                "Crease / fold paths",
                "Cut paths"
            ]
        }
    ];

    // STREAMING_CHUNK:Helper function to generate layer containers...
    function createLayerContainer(parentNode, layerName) {
        const def = Nodes.ContainerNodeDefinition.createDefault();
        def.userDescription = layerName;

        const builder = Commands.AddChildNodesCommandBuilder.create();
        builder.setInsertionTarget(parentNode);
        builder.addContainerNode(def);

        doc.executeCommand(builder.createCommand(false));

        let newlyCreatedLayer = null;
        for (const child of parentNode.children) {
            newlyCreatedLayer = child;
        }

        return newlyCreatedLayer;
    }

    // STREAMING_CHUNK:Iterating and building the layer tree...
    let totalLayersCreated = 0;

    for (const group of layerStructure) {
        const parentGroupNode = createLayerContainer(target, group.name);
        totalLayersCreated++;

        if (parentGroupNode) {
            for (const childName of group.children) {
                createLayerContainer(parentGroupNode, childName);
                totalLayersCreated++;
            }
        }
    }

    // STREAMING_CHUNK:Finalizing script execution...
    console.log("Success: Print & Packaging Layer Structure Generated!");
    console.log(`Created ${totalLayersCreated} total groups/layers inside target.`);
}

runSetup();
