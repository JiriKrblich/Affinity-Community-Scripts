/**
 * name: Quick Mirror
 * description: Mirrors the selected layer to the left, right, top, or bottom with an adjustable gap.
 * version: 1.1.1
 * author: hellsfaun
 */

"use strict";

const { app } = require("/application");
const { Document } = require("/document");
const { Dialog, DialogResult } = require("/dialog");
const { AddChildNodesCommandBuilder, CompoundCommandBuilder, DocumentCommand, InsertionMode, NodeChildType, NodeMoveType } = require("/commands");
const { DocumentCommandApi } = require("affinity:commands");
const { Transform } = require("/geometry");
const { ContainerNodeDefinition } = require("/nodes");
const { Selection } = require("/selections");
const { UnitType } = require("/units");

const APP_NAME = "Quick Mirror";
const DIRECTIONS = ["Right", "Left", "Bottom", "Top"];
const DEFAULT_GAP = 0;
const OUTPUT_MODES = ["Separate layers", "A container layer", "A merged shape"];
const DEFAULT_OUTPUT_MODE_INDEX = 0;

const doc = Document.current;

function toArray(collection) {
  if (!collection) return [];
  try { if (collection.toArray) return collection.toArray(); } catch (_) {}
  try { if (Array.isArray(collection)) return collection.slice(); } catch (_) {}
  try { if (collection.length !== undefined && typeof collection !== 'string') return Array.from(collection); } catch (_) {}
  const result = [];
  try { for (const item of collection) result.push(item); } catch (_) {}
  return result;
}

function getSelectedNodes() {
  try { return toArray(doc.selection.nodes); } catch (_) { return []; }
}

function getNodeLabel(node, fallback) {
  try {
    return node.userDescription || node.defaultDescriptionForDisplay || node.defaultDescription || fallback;
  } catch (_) { return fallback; }
}

function getNodeBox(node) {
  try {
    const box = node.getSpreadBaseBox(false);
    if (box && isFinite(box.x) && isFinite(box.y)) return box;
  } catch (_) {}
  try { return node.baseBox; } catch (_) { return null; }
}

function getMirrorTransform(box, direction, gap) {
  const { x, y, width, height } = box;
  const right = x + width;
  const bottom = y + height;

  switch (direction) {
    case "Left":
      return Transform.createTranslate(-gap, 0).multiply(Transform.createTranslate(x, 0)).multiply(Transform.createScale(-1, 1)).multiply(Transform.createTranslate(-x, 0));
    case "Top":
      return Transform.createTranslate(0, -gap).multiply(Transform.createTranslate(0, y)).multiply(Transform.createScale(1, -1)).multiply(Transform.createTranslate(0, -y));
    case "Bottom":
      return Transform.createTranslate(0, gap).multiply(Transform.createTranslate(0, bottom)).multiply(Transform.createScale(1, -1)).multiply(Transform.createTranslate(0, -bottom));
    case "Right":
    default:
      return Transform.createTranslate(gap, 0).multiply(Transform.createTranslate(right, 0)).multiply(Transform.createScale(-1, 1)).multiply(Transform.createTranslate(-right, 0));
  }
}

function safeExec(cmd) {
  try { if (cmd) doc.executeCommand(cmd); } catch (_) {}
}

function sel(nodes, append) {
  try {
    if (nodes === undefined) return Selection.create(doc);
    if (Array.isArray(nodes)) return Selection.create(doc, nodes, !!append);
    return Selection.create(doc, nodes);
  } catch (_) { return Selection.create(doc); }
}

function createContainerAndMove(nodes, nearNode, name) {
  if (!nodes || !nodes.length) return null;
  const builder = AddChildNodesCommandBuilder.create();
  try { builder.setInsertionTargetSelection(sel(nearNode)); } catch (_) { builder.setInsertionTarget(doc.currentSpread); }
  builder.addContainerNode(ContainerNodeDefinition.create(name));
  const addCmd = builder.createCommand(true, NodeChildType.Main);
  safeExec(addCmd);
  const container = addCmd.newNodes && addCmd.newNodes[0];
  if (!container) return null;
  const compound = CompoundCommandBuilder.create();
  let added = 0;
  for (const node of nodes) {
    try {
      compound.addCommand(DocumentCommand.createMoveNodes(sel(node), container, NodeMoveType.Inside, NodeChildType.Main));
      added++;
    } catch (_) {}
  }
  if (added) safeExec(compound.createCommand());
  return container;
}

function duplicateMirroredLayer(node, direction, gap) {
  const box = getNodeBox(node);
  if (!box) return null;
  const originalLabel = getNodeLabel(node, "Layer");
  const duplicate = node.duplicate(getMirrorTransform(box, direction, gap));
  try { duplicate.userDescription = originalLabel + " — M"; } catch (_) {}
  try { node.userDescription = originalLabel + " — O"; } catch (_) {}
  return duplicate;
}

function unionMirroredPair(node, direction, gap) {
  const box = getNodeBox(node);
  if (!box) return null;
  const duplicate = node.duplicate(getMirrorTransform(box, direction, gap));
  if (!duplicate) return null;

  const pairSelection = sel([node, duplicate]);
  let unionCmd;
  try {
    unionCmd = new DocumentCommand(DocumentCommandApi.createBoolOpUnionCommand(pairSelection.handle));
  } catch (_) {
    return null;
  }

  try { doc.executeCommand(unionCmd); } catch (_) { return null; }

  let result = null;
  try {
    const selected = toArray(doc.selection.nodes);
    result = selected && selected[0];
  } catch (_) {}

  if (result) {
    try { result.userDescription = getNodeLabel(node, "Layer") + " — MC"; } catch (_) {}
  }
  return result;
}

function mirrorAsLayers(nodes, direction, gap, groupResult) {
  const outputNodes = [];

  if (groupResult) {
    const first = nodes[0];
    const groupName = getNodeLabel(first, "Layer") + " — M";
    const toMove = [];
    for (const node of nodes) {
      const duplicate = duplicateMirroredLayer(node, direction, gap);
      if (!duplicate) continue;
      toMove.push(node);
      toMove.push(duplicate);
    }
    if (toMove.length) {
      const container = createContainerAndMove(toMove, first, groupName);
      if (container) outputNodes.push(container); else outputNodes.push(...toMove.filter(Boolean));
    }
  } else {
    for (const node of nodes) {
      const duplicate = duplicateMirroredLayer(node, direction, gap);
      if (!duplicate) continue;
      outputNodes.push(node);
      outputNodes.push(duplicate);
    }
  }

  if (outputNodes.length) safeExec(DocumentCommand.createSetSelection(sel(outputNodes, true)));
  return outputNodes.length;
}

function mirrorAsCompound(nodes, direction, gap) {
  const outputNodes = [];
  for (const node of nodes) {
    const result = unionMirroredPair(node, direction, gap);
    if (result) outputNodes.push(result);
  }
  if (!outputNodes.length) return 0;
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
      compound.addCommand(DocumentCommand.createTransform(Selection.create(doc, node), getMirrorTransform(box, direction, gap), { duplicateNodes: true }));
      commandCount++;
    } catch (_) {}
  }
  return commandCount ? compound.createCommand() : null;
}

function clearPreview() {
  try { doc.executeCommand(DocumentCommand.createClearPreviews()); } catch (_) {}
}

function buildDialog() {
  const dlg = Dialog.create(APP_NAME);
  const col = dlg.addColumn();
  const mirrorGroup = col.addGroup("Mirror");
  dlg.direction = mirrorGroup.addComboBox("Direction", DIRECTIONS, 0);
  dlg.direction.customSize = { width: 130, height: -1 };
  dlg.gap = mirrorGroup.addUnitValueEditor("Gap", UnitType.Pixel, UnitType.Pixel, DEFAULT_GAP, 0, 100);
  dlg.gap.showPopupSlider = true;
  const outputGroup = col.addGroup("Output");
  dlg.outputMode = outputGroup.addRadioGroup("Keep result as", OUTPUT_MODES, DEFAULT_OUTPUT_MODE_INDEX);
  return dlg;
}

function main() {
  if (!doc) { app.alert("Quick Mirror requires an open document."); return; }

  const nodes = getSelectedNodes();
  if (!nodes.length) { app.alert("Select one or more layers first."); return; }

  const dlg = buildDialog();
  let inPreview = false;
  let dialogOpen = false;

  function readValues() {
    const outputMode = OUTPUT_MODES[dlg.outputMode.selectedIndex] || OUTPUT_MODES[0];
    return {
      direction: DIRECTIONS[dlg.direction.selectedIndex] || DIRECTIONS[0],
      gap: Number(dlg.gap.value) || 0,
      groupResult: outputMode === "A container layer",
      compoundResult: outputMode === "A merged shape",
    };
  }

  function updatePreview() {
    if (!dialogOpen || inPreview) return;
    inPreview = true;
    try {
      const values = readValues();
      const command = createLayerPreviewCommand(nodes, values.direction, values.gap);
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
  dlg.outputMode.onValueChangedHandler = updatePreview;
  dlg.onControlValueChangedHandler = updatePreview;

  dialogOpen = true;
  updatePreview();
  const result = dlg.show();
  dialogOpen = false;
  const values = readValues();
  clearPreview();

  if (result.value !== DialogResult.Ok.value) return;

  const count = values.compoundResult
    ? mirrorAsCompound(nodes, values.direction, values.gap)
    : mirrorAsLayers(nodes, values.direction, values.gap, values.groupResult);

  if (count === 0) app.alert("Quick Mirror could not mirror the selected layer.");
}

main();
module.exports.main = main;``
