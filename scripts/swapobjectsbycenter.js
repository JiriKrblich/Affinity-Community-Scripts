/**
 * name: Swap objects by center
 * description: swap the locations of two selected objects by their center points.
 * version: 1.0.0
 * author: daani-rika
 */

'use strict';

const { app }                                     = require('/application');
const { Document }                                = require('/document');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
const { Selection }                               = require('/selections');
const { Transform }                               = require('/geometry');

const doc = Document.current;

if (!doc) {
    app.alert('The script requires an open document.');
}
else {
    const nodes = doc.selection.nodes.toArray();

    if (nodes.length !== 2) {
        app.alert('Please select exactly 2 items.\nCurrently selected: ' + nodes.length);
    }
    else {
        const nodeA = nodes[0];
        const nodeB = nodes[1];

        // Bounding box in spread coordinates
        const boxA = nodeA.getSpreadBaseBox();
        const boxB = nodeB.getSpreadBaseBox();

        // Centers of objects
        const centerA = { x: boxA.x + boxA.width / 2,  y: boxA.y + boxA.height / 2 };
        const centerB = { x: boxB.x + boxB.width / 2,  y: boxB.y + boxB.height / 2 };

        // Offset vectors relative to the centers
        const dxA = centerB.x - centerA.x;
        const dyA = centerB.y - centerA.y;
        const dxB = centerA.x - centerB.x;
        const dyB = centerA.y - centerB.y;

        // Separate selection for each object
        const selA = Selection.create(doc, nodeA);
        const selB = Selection.create(doc, nodeB);

        // Movement commands
        const cmdA = DocumentCommand.createTransform(selA, Transform.createTranslate(dxA, dyA));
        const cmdB = DocumentCommand.createTransform(selB, Transform.createTranslate(dxB, dyB));

        // Combine into a single action (one undo)
        const builder = CompoundCommandBuilder.create();
        builder.addCommand(cmdA);
        builder.addCommand(cmdB);

        doc.executeCommand(builder.createCommand());
    }
}