/**
name: Pattern Maker
version: 1.2.0
description: Create patterns from an object. Supports brick and drop patterns.
author: Nic Kraneis

1.2.0 – checked/adapted for current Affinity SDK (3.3):
 - Preview rollback via doc.history.position instead of counting commands
   and replaying "Undo" commands (a miscount could undo the user's own
   earlier work).
 - Single runModal(): "Update Preview" button keeps the dialog open,
   native OK = apply, Cancel/X/ESC = discard. (Before: ButtonSet
   Preview/Apply + re-opening the dialog in a loop.)
 - Initial preview uses the dialog values; start values set explicitly.
 - Gap X/Y in document units (internally px) instead of plain numbers.
 - Pattern layer is created in the parent of the original objects
   (layer/artboard) instead of always at spread level.
*/

// Google Gemini was used in creation of this script.

"use strict";

const { Document } = require("/document");
const { Dialog, DialogResult } = require("/dialog");
const {
  AddChildNodesCommandBuilder,
  DocumentCommand,
  NodeChildType,
  NodeMoveType,
} = require("/commands");
const { ContainerNodeDefinition } = require("/nodes");
const { Selection } = require("/selections");
const { Transform } = require("/geometry");
const { UnitType } = require("/units");

function getNodeBox(node) {
  return (
    node.exactSpreadBaseBox ||
    (typeof node.getSpreadBaseBox === "function"
      ? node.getSpreadBaseBox(true)
      : null) ||
    node.spreadVisibleBox
  );
}

function getSelectionBounds(nodes) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  let valid = false;

  for (const node of nodes) {
    const bb = getNodeBox(node);
    if (bb) {
      valid = true;
      if (bb.x < minX) minX = bb.x;
      if (bb.y < minY) minY = bb.y;
      if (bb.x + bb.width > maxX) maxX = bb.x + bb.width;
      if (bb.y + bb.height > maxY) maxY = bb.y + bb.height;
    }
  }

  if (!valid) return { x: 0, y: 0, width: 0, height: 0 };

  return {
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
  };
}

// Parent of the originals (layer / artboard / spread) as insertion target
function findParentTarget(doc, nodes) {
  try {
    const p = nodes[0].parent;
    if (p && p[Symbol.toStringTag] !== "DocumentNode") return p;
  } catch (e) {}
  return doc.currentSpread;
}

function createGroupContainer(doc, target, groupName) {
  const builder = AddChildNodesCommandBuilder.create();
  builder.setInsertionTarget(target);
  builder.addContainerNode(ContainerNodeDefinition.create(groupName));
  const command = builder.createCommand(false, NodeChildType.Main);
  doc.executeCommand(command);
  const node = command.newNodes[0];
  if (!node) throw new Error("Could not create layer '" + groupName + "'.");
  return node;
}

function moveNodesIntoContainer(doc, nodes, container) {
  const validNodes = (nodes || []).filter((n) => n !== undefined && n !== null);
  if (validNodes.length === 0) return;

  const selection = Selection.create(doc, validNodes);
  doc.executeCommand(
    DocumentCommand.createMoveNodes(
      selection,
      container,
      NodeMoveType.Inside,
      NodeChildType.Main,
    ),
  );
}

function showError(msg) {
  const d = Dialog.create("Pattern Maker - Error");
  d.initialWidth = 450;
  const col = d.addColumn();
  const txt = col.addGroup("Diagnostics").addStaticText("", msg);
  txt.isFullWidth = true;
  d.runModal();
}

function main() {
  const doc = Document.current;
  if (!doc) {
    showError("No document open.");
    return;
  }

  const sel = doc.selection;
  if (!sel || sel.length === 0) {
    showError("Please select at least one layer to create a pattern.");
    return;
  }

  const origNodes = [];
  for (let i = 0; i < sel.length; i++) {
    origNodes.push(sel.at(i).node);
  }
  const bounds = getSelectionBounds(origNodes);
  const parentTarget = findParentTarget(doc, origNodes);

  // ---- dialog -------------------------------------------------------------

  const dlg = Dialog.create("Pattern Maker");
  dlg.initialWidth = 380;
  const col = dlg.addColumn();

  const gridGrp = col.addGroup("Grid");
  const colsCtrl = gridGrp.addUnitValueEditor("Columns (X)", UnitType.Number, UnitType.Number, 3, 1, 100);
  colsCtrl.precision = 0;
  const rowsCtrl = gridGrp.addUnitValueEditor("Rows (Y)", UnitType.Number, UnitType.Number, 3, 1, 100);
  rowsCtrl.precision = 0;

  const spacingGrp = col.addGroup("Spacing");
  const gapXCtrl = spacingGrp.addUnitValueEditor("Gap X", UnitType.Pixel, doc.units, 0, -10000, 10000);
  const gapYCtrl = spacingGrp.addUnitValueEditor("Gap Y", UnitType.Pixel, doc.units, 0, -10000, 10000);

  const staggerGrp = col.addGroup("Stagger");
  const staggerRowCtrl = staggerGrp.addSwitch("Stagger Rows (Brick)", false);
  const staggerColCtrl = staggerGrp.addSwitch("Stagger Columns (Drop)", false);
  const staggerAmtCtrl = staggerGrp.addUnitValueEditor("Stagger Amount (%)", UnitType.Number, UnitType.Number, 50, 0, 100);
  staggerAmtCtrl.precision = 1;

  const hintGrp = col.addGroup("Editing Tip");
  const hintTxt = hintGrp.addStaticText(
    "",
    "Convert the object into a Symbol before running this script so all generated copies remain linked and can be edited together.",
  );
  hintTxt.isFullWidth = true;

  const actGrp = col.addGroup("");
  const previewBtn = actGrp.addButton("↺ Update Preview");
  previewBtn.isFullWidth = true;
  const statusTxt = actGrp.addStaticText("", "OK = apply, Cancel = discard");
  statusTxt.isFullWidth = true;

  // Start values explicitly (initial values are not reliably taken over)
  colsCtrl.value = 3;
  rowsCtrl.value = 3;
  gapXCtrl.value = 0;
  gapYCtrl.value = 0;
  staggerRowCtrl.value = false;
  staggerColCtrl.value = false;
  staggerAmtCtrl.value = 50;

  function readParams() {
    return {
      cols: Math.max(1, Math.round(Number(colsCtrl.value) || 1)),
      rows: Math.max(1, Math.round(Number(rowsCtrl.value) || 1)),
      gapX: Number(gapXCtrl.value) || 0,
      gapY: Number(gapYCtrl.value) || 0,
      staggerRow: !!staggerRowCtrl.value,
      staggerCol: !!staggerColCtrl.value,
      staggerAmt: (Number(staggerAmtCtrl.value) || 0) / 100,
    };
  }

  // ---- build --------------------------------------------------------------

  function doApply(p, isFinal) {
    const unitW = (bounds.width || 0) + p.gapX;
    const unitH = (bounds.height || 0) + p.gapY;

    if (isFinal) {
      // Flat structure: every copy is its own object in the pattern layer
      const patternGroup = createGroupContainer(doc, parentTarget, `Pattern (${p.cols}x${p.rows})`);
      moveNodesIntoContainer(doc, origNodes, patternGroup);

      for (let r = 0; r < p.rows; r++) {
        const rowDx = p.staggerRow && r % 2 !== 0 ? unitW * p.staggerAmt : 0;
        const rowDy = r * unitH;

        for (let c = 0; c < p.cols; c++) {
          if (r === 0 && c === 0) continue;
          const dx = rowDx + c * unitW;
          const dy = rowDy + (p.staggerCol && c % 2 !== 0 ? unitH * p.staggerAmt : 0);
          for (const node of origNodes) {
            node.duplicate(Transform.createTranslate(dx, dy));
          }
        }
      }
      return patternGroup;
    }

    // Preview: build one row, then duplicate the row (much faster)
    const firstRowNodes = [...origNodes];
    for (let c = 1; c < p.cols; c++) {
      const dx = c * unitW;
      const dy = p.staggerCol && c % 2 !== 0 ? unitH * p.staggerAmt : 0;
      for (const node of origNodes) {
        const dup = node.duplicate(Transform.createTranslate(dx, dy));
        if (dup) firstRowNodes.push(dup);
      }
    }

    const rowGroup = createGroupContainer(doc, parentTarget, "TempRow");
    moveNodesIntoContainer(doc, firstRowNodes, rowGroup);

    const allRows = [rowGroup];
    for (let r = 1; r < p.rows; r++) {
      const dx = p.staggerRow && r % 2 !== 0 ? unitW * p.staggerAmt : 0;
      const dy = r * unitH;
      const rowDup = rowGroup.duplicate(Transform.createTranslate(dx, dy));
      if (rowDup) allRows.push(rowDup);
    }

    const patternGroup = createGroupContainer(doc, parentTarget, `Preview (${p.cols}x${p.rows})`);
    moveNodesIntoContainer(doc, allRows, patternGroup);
    return patternGroup;
  }

  // ---- preview handling via history position -----------------------------

  const basePos = doc.history.position;

  function rollback() {
    let guard = 100000;
    while (doc.history.position > basePos && guard-- > 0) {
      doc.history.undo();
    }
  }

  function updatePreview() {
    rollback();
    try {
      const p = readParams();
      doApply(p, false);
      statusTxt.text = `Preview ${p.cols} × ${p.rows} – OK = apply, Cancel = discard`;
    } catch (e) {
      rollback();
      statusTxt.text = "Preview error: " + e.message;
      console.log("Preview Error: " + e.message);
    }
  }

  previewBtn.setOnClickHandler(updatePreview);

  updatePreview();

  const result = dlg.runModal();

  // Always discard the preview first
  rollback();

  if (!result || result.value !== DialogResult.Ok.value) return;

  try {
    const group = doApply(readParams(), true);
    doc.executeCommand(DocumentCommand.createSetSelection(group.selfSelection));
  } catch (e) {
    rollback();
    showError("Apply Error:\n" + e.message);
  }
}

try {
  main();
} catch (error) {
  showError("Script Error:\n" + String(error));
}
