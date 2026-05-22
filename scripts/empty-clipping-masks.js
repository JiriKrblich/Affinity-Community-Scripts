
'use strict';
const { app } = require('/application');

const doc = app.documents.current;
if (!doc) {
    console.log("No document open.");
} else {
    const sel = doc.selection;

    // Snapshot selected nodes first (per SDK hints: snapshot before any commands)
    const selectedNodes = [];
    for (const item of sel.items) {
        selectedNodes.push(item.node);
    }

    if (selectedNodes.length === 0) {
        console.log("Nothing selected.");
    } else {
        let deletedCount = 0;

        for (const node of selectedNodes) {
            // Collect all children (main child list) into an array first
            const children = [];
            for (const child of node.children) {
                children.push(child);
            }

            // Also collect enclosure children (masks, adjustment layers attached as enclosures)
            const enclosures = [];
            for (const enc of node.enclosures) {
                enclosures.push(enc);
            }

            // Delete in reverse order
            for (const child of [...children].reverse()) {
                try {
                    child.delete();
                    deletedCount++;
                } catch(e) {
                    console.log("Could not delete child: " + e);
                }
            }

            for (const enc of [...enclosures].reverse()) {
                try {
                    enc.delete();
                    deletedCount++;
                } catch(e) {
                    console.log("Could not delete enclosure: " + e);
                }
            }
        }

        console.log("Deleted " + deletedCount + " child/enclosure nodes from " + selectedNodes.length + " selected object(s).");
    }
}
