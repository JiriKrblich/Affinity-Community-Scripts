/**
 * name: Insert Key-object to Elements
 * description: Inserts the Key Object into target elements (clipping/nesting). Fully supports Raster (Pixel/Image) layers, Vector shapes, and Groups.
 * version: 1.2.0
 * author: WaveF (Enhanced for Raster & Robust Key-Object)
 * website: https://minicg.com
*/
'use strict';

const { Document } = require('/document');
const { DocumentCommand, NodeChildType, NodeMoveType } = require('/commands');
const { Selection } = require('/selections');
const { app } = require('/application');

const APP_NAME = 'Insert Key-object to Elements';
const doc = Document.current;

if (!doc) {
  app.alert('Please open a document first.', APP_NAME);
  return;
}

if (doc.selection.length < 2) {
  app.alert('Select one Key Object and at least one target element.', APP_NAME);
  return;
}

// Intelligent Key Object resolution:
// If doc.hasKeyObject is true (user Alt-clicked on canvas): use doc.selection.firstNode.
// If false (e.g. layers selected in Layers panel or transparent raster canvas):
// gracefully take the first node in selection as keyObject so raster workflows are never blocked.
const keyObject = doc.selection.firstNode;

if (!keyObject) {
  app.alert('No valid Key Object found in current selection.', APP_NAME);
  return;
}

const targets = Array.from(doc.selection.nodes).filter(node => !node.isSameNode(keyObject));

if (targets.length === 0) {
  app.alert('No target elements were found.', APP_NAME);
  return;
}

const insertedTargets = [];
const failures = [];

// To ensure maximum transform and bitmap pixel integrity:
// 1. Process targets 1 to targets.length - 1 using pristine duplicates of keyObject
// 2. Process target 0 using the original keyObject at the very end
// This ensures no duplicate inherits local coordinate offsets or distortions from earlier targets.

// Duplicates for targets 1 .. n-1
for (let i = 1; i < targets.length; i++) {
  const target = targets[i];
  const historyPosition = doc.history.position;
  try {
    // Duplicate with cloneRaster: true to ensure full raster bitmap copying
    const dupCmd = DocumentCommand.createTransform(
      keyObject.selfSelection,
      null,
      { duplicateNodes: true, cloneRaster: true }
    );
    doc.executeCommand(dupCmd);

    const nodeToInsert = (dupCmd.newNodes && dupCmd.newNodes[0]) ? dupCmd.newNodes[0] : doc.selection.firstNode;
    if (!nodeToInsert || nodeToInsert.isSameNode(keyObject)) {
      throw new Error('Could not duplicate the Key Object.');
    }

    // Attempt insertion into Main with fallback to Enclosure
    let moveSuccess = false;
    try {
      doc.executeCommand(DocumentCommand.createMoveNodes(
        nodeToInsert.selfSelection,
        target,
        NodeMoveType.Inside,
        NodeChildType.Main
      ));
      if (nodeToInsert.parent && nodeToInsert.parent.isSameNode(target)) {
        moveSuccess = true;
      }
    } catch (errMain) {
      try {
        doc.executeCommand(DocumentCommand.createMoveNodes(
          nodeToInsert.selfSelection,
          target,
          NodeMoveType.Inside,
          NodeChildType.Enclosure
        ));
        if (nodeToInsert.parent && nodeToInsert.parent.isSameNode(target)) {
          moveSuccess = true;
        }
      } catch (errEnc) {
        throw errMain;
      }
    }

    if (!moveSuccess) {
      throw new Error('Could not insert duplicate into this element.');
    }

    insertedTargets.push(target);
  } catch (error) {
    if (doc.history.position !== historyPosition) {
      doc.history.position = historyPosition;
    }
    const name = target.userDescription || target.defaultDescription || 'Element';
    failures.push(`${name}: ${String(error.message || error)}`);
  }
}

// Original keyObject into target 0
if (targets.length > 0) {
  const target0 = targets[0];
  const historyPosition = doc.history.position;
  try {
    let moveSuccess = false;
    try {
      doc.executeCommand(DocumentCommand.createMoveNodes(
        keyObject.selfSelection,
        target0,
        NodeMoveType.Inside,
        NodeChildType.Main
      ));
      if (keyObject.parent && keyObject.parent.isSameNode(target0)) {
        moveSuccess = true;
      }
    } catch (errMain) {
      try {
        doc.executeCommand(DocumentCommand.createMoveNodes(
          keyObject.selfSelection,
          target0,
          NodeMoveType.Inside,
          NodeChildType.Enclosure
        ));
        if (keyObject.parent && keyObject.parent.isSameNode(target0)) {
          moveSuccess = true;
        }
      } catch (errEnc) {
        throw errMain;
      }
    }

    if (!moveSuccess) {
      throw new Error('Could not insert the Key Object into this element.');
    }

    insertedTargets.unshift(target0);
  } catch (error) {
    if (doc.history.position !== historyPosition) {
      doc.history.position = historyPosition;
    }
    const name = target0.userDescription || target0.defaultDescription || 'Element';
    failures.push(`${name}: ${String(error.message || error)}`);
  }
}

doc.selection = Selection.create(doc, insertedTargets, true);

const keyName = keyObject.userDescription || keyObject.defaultDescription || (keyObject.isRasterNode ? 'Pixel Layer' : 'Key Object');
let resultMessage = `Processed ${insertedTargets.length} of ${targets.length} target element(s).`;
resultMessage += `\nKey Object: "${keyName}"`;
if (failures.length) {
  resultMessage += `\n\nFailures:\n${failures.join('\n')}`;
}
app.alert(resultMessage, APP_NAME);
