"use strict";

// =============================================================================
// SET STROKE WIDTH v1 (Batch Recursive Stroke Modifier)
// Affinity Designer / Photo / Publisher
//
// Description:
// Changes the stroke width of all selected vector objects and their nested
// children (including shapes clipped inside other shapes or nested in groups)
// in a single operation.
//
// Parameters:
// - Exactly ONE parameter: Stroke Width (in points, with live slider).
// =============================================================================

const { Document } = require("/document");
const { Selection } = require("/selections");
const { Dialog, DialogResult } = require("/dialog");
const { UnitType } = require("/units");
const { LineType } = require("/linestyle");
const { DocumentCommand } = require("/commands");

function main() {
  const doc = Document.current;
  if (!doc) {
    return;
  }

  // 1. Capture currently selected nodes before any dialog opens
  const rawSelection = doc.selection ? doc.selection.nodes.toArray() : [];
  if (rawSelection.length === 0) {
    const warnDlg = Dialog.create("No Selection");
    const col = warnDlg.addColumn();
    col.addStaticText(
      null,
      "Please select at least one object to change its stroke width."
    ).setIsFullWidth(true);
    warnDlg.show();
    return;
  }

  // 2. Recursively collect all descendant nodes (children and enclosures/clips)
  function collectAllNodes(roots) {
    const list = [];
    const visited = new Set();

    function recurse(node) {
      if (!node || visited.has(node.handle)) return;
      visited.add(node.handle);
      list.push(node);

      try {
        if (node.children) {
          for (const child of node.children) {
            recurse(child);
          }
        }
      } catch (_) {}

      try {
        if (node.enclosures) {
          for (const enc of node.enclosures) {
            recurse(enc);
          }
        }
      } catch (_) {}
    }

    for (const root of roots) {
      recurse(root);
    }
    return list;
  }

  // 3. Helper to determine if a node has an active stroke
  function hasStroke(node) {
    if (!node || !node.lineStyleInterface) return false;
    try {
      const ls = node.lineStyleInterface;
      if (ls.isLineStyleVisible === false) return false;
      if (node.hasPenFill === false) return false;
      if (ls.lineType && ls.lineType.value === LineType.None.value) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  const allNodes = collectAllNodes(rawSelection);

  // Target all nodes that currently have a stroke.
  // Fallback: if none have an active stroke, target all vector nodes.
  let targetNodes = allNodes.filter(hasStroke);
  if (targetNodes.length === 0) {
    targetNodes = allNodes.filter((n) => n.lineStyleInterface != null);
  }

  if (targetNodes.length === 0) {
    const warnDlg = Dialog.create("No Vector Objects");
    const col = warnDlg.addColumn();
    col.addStaticText(
      null,
      "No stroked or vector objects found in the current selection."
    ).setIsFullWidth(true);
    warnDlg.show();
    return;
  }

  // 4. Determine initial stroke width from the first target node
  let initialVal = 1;
  for (const n of targetNodes) {
    try {
      if (n.lineStyleInterface && typeof n.lineStyleInterface.lineWeightPts === "number") {
        initialVal = Math.round(n.lineStyleInterface.lineWeightPts * 100) / 100;
        break;
      }
    } catch (_) {}
  }

  // Create selection keeping nested children (removeNested = false)
  const targetSelection = Selection.create(doc, targetNodes, false);

  // 5. Build Dialog with EXACTLY ONE parameter
  const dlg = Dialog.create("Set Stroke Width");
  const col = dlg.addColumn();
  const grp = col.addGroup();

  const strokeCtrl = grp.addUnitValueEditor(
    "Stroke Width",
    UnitType.Point,
    UnitType.Point,
    initialVal,
    0,
    500
  );
  strokeCtrl.setShowPopupSlider(true);

  // Live preview handler
  function applyPreview() {
    try {
      const val = strokeCtrl.value;
      if (typeof val === "number" && val >= 0) {
        doc.setLineWeightPts(val, targetSelection, true);
      }
    } catch (_) {}
  }

  dlg.onControlValueChangedHandler = applyPreview;

  // 6. Show Dialog
  const result = dlg.show();

  // Always clear preview rendering
  try {
    doc.executeCommand(DocumentCommand.createClearPreviews(), false);
  } catch (_) {}

  // 7. Apply permanent change if user clicked OK
  if (result && result.value === DialogResult.Ok.value) {
    const finalVal = strokeCtrl.value;
    if (typeof finalVal === "number" && finalVal >= 0) {
      doc.setLineWeightPts(finalVal, targetSelection, false);
    }
  }

  // 8. Restore user's original selection
  try {
    const restoreSel = Selection.create(doc, rawSelection, true);
    doc.executeCommand(DocumentCommand.createSetSelection(restoreSel), false);
  } catch (_) {}
}

main();
