/**
 * name: Swap objects by center
 * description: swap the locations of two selected objects by their center points.
 * version: 2.0.0
 * author: daani-rika
 */

"use strict";

const { app } = require("/application");
const { Document } = require("/document");
const {
  DocumentCommand,
  CompoundCommandBuilder,
  NodeMoveType,
  NodeChildType,
} = require("/commands");

const { Selection } = require("/selections");
const { Transform } = require("/geometry");

const doc = Document.current;

if (!doc) {
  app.alert("The script requires an open document.");
} else {
  const nodes = doc.selection.nodes.toArray();

  if (nodes.length !== 2) {
    app.alert(
      "Please select exactly 2 items.\nCurrently selected: " + nodes.length,
    );
  } else {
    const nodeA = nodes[0];
    const nodeB = nodes[1];

    // ── Validate: both nodes must share the same parent ────────────────
    const parentA = nodeA.parent;
    const parentB = nodeB.parent;

    if (!parentA || !parentB || !parentA.isSameNode(parentB)) {
      app.alert("Both objects must be inside the same layer / group.");
    } else {
      // ── Bounding boxes and center points ────────────────────────────
      const boxA = nodeA.getSpreadBaseBox();
      const boxB = nodeB.getSpreadBaseBox();

      const centerA = {
        x: boxA.x + boxA.width / 2,
        y: boxA.y + boxA.height / 2,
      };

      const centerB = {
        x: boxB.x + boxB.width / 2,
        y: boxB.y + boxB.height / 2,
      };

      // ── Position offset vectors ─────────────────────────────────────
      const dxA = centerB.x - centerA.x;
      const dyA = centerB.y - centerA.y;

      const dxB = centerA.x - centerB.x;
      const dyB = centerA.y - centerB.y;

      // ── Determine which node sits above the other in the layer stack ──
      // Walk nodeA's next-siblings; if we reach nodeB then A is above B.
      let aIsAbove = false;
      let sibling = nodeA.nextSibling;

      while (sibling) {
        if (sibling.isSameNode(nodeB)) {
          aIsAbove = true;
          break;
        }
        sibling = sibling.nextSibling;
      }

      const topNode = aIsAbove ? nodeA : nodeB;
      const bottomNode = aIsAbove ? nodeB : nodeA;

      // Remember the sibling that was directly below topNode BEFORE we move anything.
      const nodeAfterTop = topNode.nextSibling;

      // ── Build the compound command ──────────────────────────────────
      const builder = CompoundCommandBuilder.create();

      // 1. Position swap
      const selA = Selection.create(doc, nodeA);
      const selB = Selection.create(doc, nodeB);

      builder.addCommand(
        DocumentCommand.createTransform(
          selA,
          Transform.createTranslate(dxA, dyA),
        ),
      );

      builder.addCommand(
        DocumentCommand.createTransform(
          selB,
          Transform.createTranslate(dxB, dyB),
        ),
      );

      // 2. Layer-order swap

      // Step A: move the top node to just after the bottom node
      const selTop = Selection.create(doc, topNode);
      const selBottom = Selection.create(doc, bottomNode);

      builder.addCommand(
        DocumentCommand.createMoveNodes(
          selTop,
          bottomNode,
          NodeMoveType.After,
          NodeChildType.Main,
        ),
      );

      // Step B (non-adjacent case):
      // move the bottom node to original slot of topNode
      if (nodeAfterTop && !nodeAfterTop.isSameNode(bottomNode)) {
        builder.addCommand(
          DocumentCommand.createMoveNodes(
            selBottom,
            nodeAfterTop,
            NodeMoveType.Before,
            NodeChildType.Main,
          ),
        );
      }

      doc.executeCommand(builder.createCommand());
    }
  }
}
