/**
 * name: Quick Mirror
 * description: Mirrors the selected layer to the left, right, top, or bottom with an adjustable gap.
 * version: 1.0.0
 * author: hellsfaun
 */

"use strict";

const { app } = require("/application");
const { Document } = require("/document");
const { Dialog, DialogResult } = require("/dialog");
const {
  AddChildNodesCommandBuilder,
  CompoundCommandBuilder,
  DocumentCommand,
  InsertionMode,
  NodeChildType,
  NodeMoveType,
} = require("/commands");
const { Transform } = require("/geometry");
const { ContainerNodeDefinition } = require("/nodes");
const { Selection } = require("/selections");
const { UnitType } = require("/units");

const APP_NAME = "Quick Mirror";
const DIRECTIONS = ["Right", "Left", "Bottom", "Top"];
const DEFAULT_GAP = 0;
const DEFAULT_GROUP_RESULT = false;

const doc = Document.current;

function toArray(collection) {
  if (!collection) return [];
  try {
    if (collection.toArray) return collection.toArray();
  } catch (_) {}
  try {
    if (Array.isArray(collection)) return collection.slice();
  } catch (_) {}
  try {
    if (collection.length !== undefined && typeof collection !== "string")
      return Array.from(collection);
  } catch (_) {}
  const result = [];
  try {
    for (const item of collection) result.push(item);
  } catch (_) {}
  return result;
}

function getSelectedNodes() {
  try {
    return toArray(doc.selection.nodes);
  } catch (_) {
    return [];
  }
}

function getNodeLabel(node, fallback) {
  try {
    return (
      node.userDescription ||
      node.defaultDescriptionForDisplay ||
      node.defaultDescription ||
      fallback
    );
  } catch (_) {
    return fallback;
  }
}

function getNodeBox(node) {
  try {
    const box = node.getSpreadBaseBox(false);
    if (box && isFinite(box.x) && isFinite(box.y)) return box;
  } catch (_) {}
  try {
    return node.baseBox;
  } catch (_) {
    return null;
  }
}

function getMirrorTransform(box, direction, gap) {
  const { x, y, width, height } = box;
  const right = x + width;
  const bottom = y + height;

  switch (direction) {
    case "Left":
      return Transform.createTranslate(-gap, 0)
        .multiply(Transform.createTranslate(x, 0))
        .multiply(Transform.createScale(-1, 1))
        .multiply(Transform.createTranslate(-x, 0));
    case "Top":
      return Transform.createTranslate(0, -gap)
        .multiply(Transform.createTranslate(0, y))
        .multiply(Transform.createScale(1, -1))
        .multiply(Transform.createTranslate(0, -y));
    case "Bottom":
      return Transform.createTranslate(0, gap)
        .multiply(Transform.createTranslate(0, bottom))
        .multiply(Transform.createScale(1, -1))
        .multiply(Transform.createTranslate(0, -bottom));
    case "Right":
    default:
      return Transform.createTranslate(gap, 0)
        .multiply(Transform.createTranslate(right, 0))
        .multiply(Transform.createScale(-1, 1))
        .multiply(Transform.createTranslate(-right, 0));
  }
}

function isCurveNode(node) {
  try {
    return !!(node && node.isPolyCurveNode && node.polyCurve);
  } catch (_) {
    return false;
  }
}

function allSelectedAreCurves(nodes) {
  return nodes.length > 0 && nodes.every(isCurveNode);
}

function safeExec(cmd) {
  try {
    if (cmd) doc.executeCommand(cmd);
  } catch (_) {}
}

function sel(nodes, append) {
  try {
    if (nodes === undefined) return Selection.create(doc);
    if (Array.isArray(nodes)) return Selection.create(doc, nodes, !!append);
    return Selection.create(doc, nodes);
  } catch (_) {
    return Selection.create(doc);
  }
}

function createContainerAndMove(nodes, nearNode, name) {
  if (!nodes || !nodes.length) return null;
  const builder = AddChildNodesCommandBuilder.create();
  try {
    builder.setInsertionTargetSelection(sel(nearNode));
  } catch (_) {
    builder.setInsertionTarget(doc.currentSpread);
  }
  builder.addContainerNode(ContainerNodeDefinition.create(name));
  const addCmd = builder.createCommand(true, NodeChildType.Main);
  safeExec(addCmd);
  const container = addCmd.newNodes && addCmd.newNodes[0];
  if (!container) return null;
  const compound = CompoundCommandBuilder.create();
  let added = 0;
  for (const node of nodes) {
    try {
      compound.addCommand(
        DocumentCommand.createMoveNodes(
          sel(node),
          container,
          NodeMoveType.Inside,
          NodeChildType.Main,
        ),
      );
      added++;
    } catch (_) {}
  }
  if (added) safeExec(compound.createCommand());
  return container;
}

function duplicateMirroredLayer(node, direction, gap) {
  const box = getNodeBox(node);
  if (!box) return null;
  const duplicate = node.duplicate(getMirrorTransform(box, direction, gap));
  try {
    duplicate.userDescription = getNodeLabel(node, "Layer") + " (Mirror)";
  } catch (_) {}
  return duplicate;
}

function mirrorAsLayers(nodes, direction, gap, groupResult) {
  const outputNodes = [];

  if (groupResult) {
    const first = nodes[0];
    const groupName = getNodeLabel(first, "Layer") + " (Mirrored)";
    const toMove = [];
    for (const node of nodes) {
      const duplicate = duplicateMirroredLayer(node, direction, gap);
      if (!duplicate) continue;
      toMove.push(node);
      toMove.push(duplicate);
    }
    if (toMove.length) {
      const container = createContainerAndMove(toMove, first, groupName);
      if (container) outputNodes.push(container);
      else outputNodes.push(...toMove.filter(Boolean));
    }
  } else {
    for (const node of nodes) {
      const duplicate = duplicateMirroredLayer(node, direction, gap);
      if (!duplicate) continue;
      outputNodes.push(node);
      outputNodes.push(duplicate);
    }
  }

  if (outputNodes.length)
    safeExec(DocumentCommand.createSetSelection(sel(outputNodes, true)));
  return outputNodes.length;
}

function mirrorAsCurveNodes(nodes, direction, gap, groupResult) {
  const outputNodes = [];

  if (groupResult) {
    const first = nodes[0];
    const groupName = getNodeLabel(first, "Layer") + " (Mirrored)";
    const toMove = [];
    for (const node of nodes) {
      const duplicate = duplicateMirroredLayer(node, direction, gap);
      if (!duplicate) continue;
      toMove.push(node);
      toMove.push(duplicate);
    }
    if (toMove.length) {
      const container = createContainerAndMove(toMove, first, groupName);
      if (container) outputNodes.push(container);
      else outputNodes.push(...toMove.filter(Boolean));
    }
  } else {
    for (const node of nodes) {
      const duplicate = duplicateMirroredLayer(node, direction, gap);
      if (!duplicate) continue;
      outputNodes.push(node);
      outputNodes.push(duplicate);
    }
  }

  if (outputNodes.length)
    safeExec(DocumentCommand.createSetSelection(sel(outputNodes, true)));
  return outputNodes.length;
}

function createLayerPreviewCommand(nodes, direction, gap) {
  const compound = CompoundCommandBuilder.create();
  let commandCount = 0;
  for (const node of nodes) {
    const box = getNodeBox(node);
    if (!box) continue;
    try {
      compound.addCommand(
        DocumentCommand.createTransform(
          Selection.create(doc, node),
          getMirrorTransform(box, direction, gap),
          { duplicateNodes: true },
        ),
      );
      commandCount++;
    } catch (_) {}
  }
  return commandCount ? compound.createCommand() : null;
}

function clearPreview() {
  try {
    doc.executeCommand(DocumentCommand.createClearPreviews());
  } catch (_) {}
}

function buildDialog(curveMode) {
  const dlg = Dialog.create(APP_NAME);
  const col = dlg.addColumn();
  const mirrorGroup = col.addGroup("Mirror");
  dlg.direction = mirrorGroup.addComboBox("Direction", DIRECTIONS, 0);
  dlg.direction.customSize = { width: 130, height: -1 };
  dlg.gap = mirrorGroup.addUnitValueEditor(
    "Gap",
    UnitType.Pixel,
    UnitType.Pixel,
    DEFAULT_GAP,
    0,
    100,
  );
  dlg.gap.showPopupSlider = true;
  const outputGroup = col.addGroup("Output");
  dlg.groupResult = outputGroup.addSwitch("Group result", DEFAULT_GROUP_RESULT);
  return dlg;
}

function main() {
  if (!doc) {
    app.alert("Quick Mirror requires an open document.");
    return;
  }

  const nodes = getSelectedNodes();
  if (!nodes.length) {
    app.alert("Select one or more layers first.");
    return;
  }

  const curveMode = allSelectedAreCurves(nodes);
  const dlg = buildDialog(curveMode);
  let inPreview = false;
  let dialogOpen = false;

  function readValues() {
    return {
      direction: DIRECTIONS[dlg.direction.selectedIndex] || DIRECTIONS[0],
      gap: Number(dlg.gap.value) || 0,
      groupResult: !!dlg.groupResult.value,
    };
  }

  function updatePreview() {
    if (!dialogOpen || inPreview) return;
    inPreview = true;
    try {
      const values = readValues();
      const command = createLayerPreviewCommand(
        nodes,
        values.direction,
        values.gap,
      );
      clearPreview();
      if (command) doc.executeCommand(command, true);
    } catch (_) {
      clearPreview();
    } finally {
      inPreview = false;
    }
  }

  dlg.direction.onValueChangedHandler = updatePreview;
  dlg.gap.onValueChangedHandler = updatePreview;
  dlg.groupResult.onValueChangedHandler = updatePreview;
  dlg.onControlValueChangedHandler = updatePreview;

  dialogOpen = true;
  updatePreview();
  const result = dlg.show();
  dialogOpen = false;
  const values = readValues();
  clearPreview();

  if (result.value !== DialogResult.Ok.value) return;

  const count = curveMode
    ? mirrorAsCurveNodes(
        nodes,
        values.direction,
        values.gap,
        values.groupResult,
      )
    : mirrorAsLayers(nodes, values.direction, values.gap, values.groupResult);

  if (count === 0)
    app.alert("Quick Mirror could not mirror the selected layer.");
}

main();
module.exports.main = main;
