/**
 * name: Insert Key-object to Elements
 * description: Inserts the original Key Object into one target and duplicates it into every other selected target element.
 * version: 1.1.0
 * author: WaveF
 * email: wavef@live.com
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

if (!doc.hasKeyObject) {
  app.alert('Please mark one selected element as the Key Object first.', APP_NAME);
  return;
}

// The SDK represents the Key Object as the first node in a keyed selection.
const keyObject = doc.selection.firstNode;
const targets = Array.from(doc.selection.nodes).filter(node => !node.isSameNode(keyObject));

if (!keyObject || targets.length === 0) {
  app.alert('No target elements were found.', APP_NAME);
  return;
}

const insertedTargets = [];
const failures = [];
let originalInserted = false;

for (const target of targets) {
  const historyPosition = doc.history.position;
  try {
    let nodeToInsert = keyObject;

    if (originalInserted) {
      // Each remaining target receives a new copy of the original Key Object.
      doc.executeCommand(DocumentCommand.createTransform(
        keyObject.selfSelection,
        null,
        { duplicateNodes: true }
      ));

      nodeToInsert = doc.selection.firstNode;
      if (!nodeToInsert || nodeToInsert.isSameNode(keyObject)) {
        throw new Error('Could not duplicate the Key Object.');
      }
    }

    doc.executeCommand(DocumentCommand.createMoveNodes(
      nodeToInsert.selfSelection,
      target,
      NodeMoveType.Inside,
      NodeChildType.Main
    ));

    if (!nodeToInsert.parent || !nodeToInsert.parent.isSameNode(target)) {
      throw new Error('Could not insert the Key Object into this element.');
    }

    originalInserted = originalInserted || nodeToInsert.isSameNode(keyObject);
    insertedTargets.push(target);
  } catch (error) {
    if (doc.history.position !== historyPosition) {
      doc.history.position = historyPosition;
    }
    const name = target.userDescription || target.defaultDescription || 'Element';
    failures.push(`${name}: ${String(error.message || error)}`);
  }
}

doc.selection = Selection.create(doc, insertedTargets, true);

let resultMessage = `Processed ${insertedTargets.length} element(s).`;
if (originalInserted) {
  resultMessage += '\nThe original Key Object was inserted into the first successful target.';
}
if (failures.length) {
  resultMessage += `\n\n${failures.join('\n')}`;
}
app.alert(resultMessage, APP_NAME);
