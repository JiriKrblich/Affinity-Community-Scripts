/**
 * name: Make Button
 * description: Instantly creates perfectly padded rounded button backgrounds behind selected text layers with live preview, customizable fill/stroke styling, linked padding controls, and automatic grouping.
 * version: 1.0.0
 * author: hellsfaun
 */

"use strict";

const { Document } = require("/document");
const { Dialog, DialogResult } = require("/dialog");
const {
  AddChildNodesCommandBuilder,
  InsertionMode,
  DocumentCommand,
  CompoundCommandBuilder,
  NodeChildType,
  NodeMoveType,
} = require("/commands");
const { UnitType } = require("/units");
const { CurveBuilder, PolyCurve } = require("/geometry");
const { RGBA8 } = require("/colours");
const { FillDescriptor, SolidFill } = require("/fills");
const { LineStyleDescriptor } = require("/linestyle");
const { ContainerNodeDefinition, PolyCurveNodeDefinition } = require("/nodes");
const { Selection } = require("/selections");
const { app } = require("/application");
const { setTimeout } = require("/timers");

const APP_NAME = "Make Button";
const DEFAULT_CONTAINER_NAME = "Button";
const BUTTON_PREFIX = "\u2022 ";
const BACKGROUND_NAME = "BG";
const PREVIEW_DELAY = 16;
const MIN_SIZE = 0.01;
const BEZIER_CIRCLE = 0.552284749831;

const LIMITS = {
  padding: { min: 0, max: 500 },
  cornerRadius: { min: 0, max: 500 },
  strokeWidth: { min: 0, max: 100 },
};

let config = {
  paddingX: 40,
  paddingY: 40,
  cornerRadius: 40,
  colour: RGBA8(50, 50, 50),
  strokeWidth: 2,
  strokeColour: RGBA8(100, 100, 100),
};

function clampValue(value, min, max, fallback) {
  const number = Number(value);

  if (!isFinite(number)) {
    return fallback;
  }

  return Math.max(min, Math.min(number, max));
}

function getEditorValue(editor, limit, fallback) {
  return clampValue(editor.value, limit.min, limit.max, fallback);
}

function getPickerValue(picker, fallback) {
  return picker.value || fallback;
}

function cleanLayerName(value) {
  if (value === null || value === undefined) {
    return "";
  }

  const text = String(value);

  return text.replace(/^\s+|\s+$/g, "");
}

function readString(object, property) {
  try {
    return cleanLayerName(object[property]);
  } catch (_) {
    return "";
  }
}

function getLayerName(node) {
  const properties = [
    "description",
    "userDescription",
    "defaultDescriptionForDisplay",
    "defaultDescription",
  ];

  for (const property of properties) {
    const value = readString(node, property);

    if (value && value !== BACKGROUND_NAME) {
      return value;
    }
  }

  return readString(node, "text");
}

function getButtonContainerName(node) {
  let name = getLayerName(node) || DEFAULT_CONTAINER_NAME;

  if (name.indexOf(BUTTON_PREFIX) === 0) {
    return name;
  }

  return BUTTON_PREFIX + name;
}

function addPixelEditor(group, label, value, limit) {
  const editor = group.addUnitValueEditor(
    label,
    UnitType.Pixel,
    UnitType.Pixel,
    value,
    limit.min,
    limit.max,
  );

  editor.showPopupSlider = true;

  return editor;
}

function detectTargets(doc) {
  const sel = doc.selection;

  if (!sel || sel.length === 0) {
    return [];
  }

  const cachedNodes = [];

  for (const node of sel.nodes) {
    cachedNodes.push(node);
  }

  const targets = [];

  for (const node of cachedNodes) {
    try {
      const box = node.getSpreadBaseBox();

      if (!box) continue;

      targets.push({
        node,
        box,
      });
    } catch (_) {
      // Skip invalid nodes safely
    }
  }

  return targets;
}

function clampRadius(radius, width, height) {
  const maxRadius = Math.min(width, height) / 2;
  return Math.max(0, Math.min(radius, maxRadius));
}

function getBackgroundGeometry(box, conf) {
  const width = Math.max(MIN_SIZE, box.width + conf.paddingX * 2);

  const height = Math.max(MIN_SIZE, box.height + conf.paddingY * 2);

  return {
    x: box.x - conf.paddingX,
    y: box.y - conf.paddingY,
    width,
    height,
    radius: clampRadius(conf.cornerRadius, width, height),
  };
}

function createSolidFillDescriptor(colour) {
  return FillDescriptor.createSolid(SolidFill.create(colour));
}

function applyStrokeToNodeDef(nodeDef, conf) {
  if (conf.strokeWidth <= 0) {
    return;
  }

  try {
    if (!nodeDef.setLineDescriptors) {
      return;
    }

    nodeDef.setLineDescriptors(
      0,
      createSolidFillDescriptor(conf.strokeColour),
      LineStyleDescriptor.createDefault(conf.strokeWidth),
    );
  } catch (_) {
    // Strokes are optional; leave the fill-only button intact if Affinity rejects them.
  }
}

function createRoundedRectanglePolyCurve(x, y, width, height, radius) {
  const right = x + width;
  const bottom = y + height;
  const polyCurve = new PolyCurve();
  const builder = CurveBuilder.create();

  if (radius <= 0) {
    polyCurve.addCurve(
      builder
        .beginXY(x, y)
        .lineToXY(right, y)
        .lineToXY(right, bottom)
        .lineToXY(x, bottom)
        .close()
        .createCurve(),
    );

    return polyCurve;
  }

  const k = radius * BEZIER_CIRCLE;

  polyCurve.addCurve(
    builder
      .beginXY(x + radius, y)
      .lineToXY(right - radius, y)
      .addBezierXY(
        right - radius + k,
        y,
        right,
        y + radius - k,
        right,
        y + radius,
      )
      .lineToXY(right, bottom - radius)
      .addBezierXY(
        right,
        bottom - radius + k,
        right - radius + k,
        bottom,
        right - radius,
        bottom,
      )
      .lineToXY(x + radius, bottom)
      .addBezierXY(
        x + radius - k,
        bottom,
        x,
        bottom - radius + k,
        x,
        bottom - radius,
      )
      .lineToXY(x, y + radius)
      .addBezierXY(x, y + radius - k, x + radius - k, y, x + radius, y)
      .close()
      .createCurve(),
  );

  return polyCurve;
}

function createBackgroundNodeDef(box, conf) {
  const geometry = getBackgroundGeometry(box, conf);

  const fillDesc = createSolidFillDescriptor(conf.colour);

  const nodeDef = PolyCurveNodeDefinition.createDefault();

  nodeDef.setCurves(
    createRoundedRectanglePolyCurve(
      geometry.x,
      geometry.y,
      geometry.width,
      geometry.height,
      geometry.radius,
    ),
  );

  nodeDef.setBrushFillDescriptor(0, fillDesc);
  applyStrokeToNodeDef(nodeDef, conf);

  nodeDef.userDescription = BACKGROUND_NAME;

  return nodeDef;
}

function buildCompoundCommand(targets, conf) {
  const compound = CompoundCommandBuilder.create();

  let added = 0;

  for (const target of targets) {
    try {
      const builder = AddChildNodesCommandBuilder.create();

      builder.setInsertionTarget(target.node);
      builder.setInsertionMode(InsertionMode.Behind);

      builder.addNode(createBackgroundNodeDef(target.box, conf));

      compound.addCommand(builder.createCommand(true, NodeChildType.Main));

      added++;
    } catch (_) {
      // Ignore problematic nodes safely
    }
  }

  if (added === 0) {
    return null;
  }

  try {
    return compound.createCommand();
  } catch (_) {
    return null;
  }
}

function getNodeSelection(doc, node) {
  try {
    if (node.selfSelection) {
      return node.selfSelection;
    }
  } catch (_) {}

  return Selection.create(doc, node);
}

function getNodeBox(node) {
  try {
    return node.getSpreadBaseBox();
  } catch (_) {}

  try {
    return node.baseBox;
  } catch (_) {}

  return null;
}

function snapshotParentChildren(targets) {
  const snapshots = [];

  for (const target of targets) {
    const cached = [];

    try {
      const parent = target.node.parent;

      if (parent) {
        for (const child of parent.children) {
          cached.push(child);
        }
      }
    } catch (_) {}

    snapshots.push(cached);
  }

  return snapshots;
}

function addUniqueNode(nodes, node) {
  if (nodes.indexOf(node) === -1) {
    nodes.push(node);
  }
}

function isButtonBackground(node) {
  try {
    return node.userDescription === BACKGROUND_NAME;
  } catch (_) {
    return false;
  }
}

function filterBackgroundNodes(nodes) {
  const backgrounds = [];

  if (!nodes) {
    return backgrounds;
  }

  for (const node of nodes) {
    if (isButtonBackground(node)) {
      backgrounds.push(node);
    }
  }

  return backgrounds;
}

function findInsertedBackgrounds(targets, snapshots) {
  const inserted = [];

  for (let i = 0; i < targets.length; i++) {
    try {
      const parent = targets[i].node.parent;

      if (!parent) continue;

      const before = snapshots[i];
      const current = [];

      for (const child of parent.children) {
        current.push(child);
      }

      for (const child of current) {
        if (before.indexOf(child) === -1 && isButtonBackground(child)) {
          addUniqueNode(inserted, child);
        }
      }
    } catch (_) {}
  }

  return inserted;
}

function scoreBackgroundMatch(node, geometry) {
  const box = getNodeBox(node);

  if (!box) {
    return Number.MAX_VALUE;
  }

  return (
    Math.abs(box.x - geometry.x) +
    Math.abs(box.y - geometry.y) +
    Math.abs(box.width - geometry.width) +
    Math.abs(box.height - geometry.height)
  );
}

function pairBackgroundsWithTargets(backgrounds, targets, conf) {
  const pairs = [];
  const used = [];

  for (let i = 0; i < targets.length; i++) {
    const geometry = getBackgroundGeometry(targets[i].box, conf);
    let bestNode = null;
    let bestIndex = -1;
    let bestScore = Number.MAX_VALUE;

    for (let j = 0; j < backgrounds.length; j++) {
      if (used.indexOf(j) !== -1) continue;

      const score = scoreBackgroundMatch(backgrounds[j], geometry);

      if (score < bestScore) {
        bestNode = backgrounds[j];
        bestIndex = j;
        bestScore = score;
      }
    }

    if (!bestNode && backgrounds[i] && used.indexOf(i) === -1) {
      bestNode = backgrounds[i];
      bestIndex = i;
    }

    if (bestNode) {
      used.push(bestIndex);
      pairs.push({
        background: bestNode,
        content: targets[i].node,
      });
    }
  }

  return pairs;
}

function createContainerNearNode(doc, node, name) {
  const definition = ContainerNodeDefinition.create(name);
  const builder = AddChildNodesCommandBuilder.create();

  builder.setInsertionTargetSelection(getNodeSelection(doc, node));
  builder.addContainerNode(definition);

  const cmd = builder.createCommand();
  doc.executeCommand(cmd);

  if (cmd.newNodes && cmd.newNodes.length > 0) {
    return cmd.newNodes[0];
  }

  return null;
}

function moveNodesIntoContainer(doc, nodes, container) {
  const compound = CompoundCommandBuilder.create();
  let added = 0;

  for (let i = 0; i < nodes.length; i++) {
    try {
      compound.addCommand(
        DocumentCommand.createMoveNodes(
          getNodeSelection(doc, nodes[i]),
          container,
          NodeMoveType.Inside,
          NodeChildType.Main,
        ),
      );

      added++;
    } catch (_) {}
  }

  if (added === 0) {
    return false;
  }

  doc.executeCommand(compound.createCommand());
  return true;
}

function groupButtonPairs(doc, pairs) {
  let grouped = 0;

  for (const pair of pairs) {
    try {
      const container = createContainerNearNode(
        doc,
        pair.content,
        getButtonContainerName(pair.content),
      );

      if (
        container &&
        moveNodesIntoContainer(doc, [pair.background, pair.content], container)
      ) {
        grouped++;
      }
    } catch (_) {}
  }

  return grouped;
}

function clearPreviews(doc) {
  try {
    doc.executeCommand(DocumentCommand.createClearPreviews());
  } catch (_) {}
}

function executeButtonCommand(doc, targets, conf, isPreview) {
  const cmd = buildCompoundCommand(targets, conf);

  if (!cmd) {
    return false;
  }

  doc.executeCommand(cmd, !!isPreview);
  return cmd;
}

function createButtonsAndGroups(doc, targets, conf) {
  const snapshots = snapshotParentChildren(targets);
  const cmd = executeButtonCommand(doc, targets, conf, false);

  if (!cmd) {
    return false;
  }

  const commandBackgrounds = filterBackgroundNodes(cmd.newNodes);
  const backgrounds =
    commandBackgrounds.length >= targets.length
      ? commandBackgrounds
      : findInsertedBackgrounds(targets, snapshots);

  const pairs = pairBackgroundsWithTargets(backgrounds, targets, conf);

  if (pairs.length > 0) {
    groupButtonPairs(doc, pairs);
  }

  return true;
}

function restoreSelection(doc, nodes) {
  try {
    doc.selection = Selection.create(doc, nodes);
  } catch (_) {}
}

function main() {
  const doc = Document.current;

  if (!doc) {
    app.alert("No document open.", APP_NAME);
    return;
  }

  const targets = detectTargets(doc);

  if (targets.length === 0) {
    app.alert("Please select at least one layer.", APP_NAME);
    return;
  }

  const originalNodes = targets.map((t) => t.node);

  const dlg = Dialog.create(APP_NAME);
  dlg.initialWidth = 360;

  const col = dlg.addColumn();

  const grp = col.addGroup("Button Appearance");

  const picker = grp.addColourPicker("Background Fill", config.colour);

  picker.isFullWidth = true;

  const strokePicker = grp.addColourPicker("Stroke Fill", config.strokeColour);

  strokePicker.isFullWidth = true;

  const linkSwitch = grp.addSwitch("Link Padding", true);

  const padXCtrl = addPixelEditor(
    grp,
    "Horizontal Padding",
    config.paddingX,
    LIMITS.padding,
  );

  const padYCtrl = addPixelEditor(
    grp,
    "Vertical Padding",
    config.paddingY,
    LIMITS.padding,
  );

  const radiusCtrl = addPixelEditor(
    grp,
    "Corner Radius",
    config.cornerRadius,
    LIMITS.cornerRadius,
  );

  const strokeWidthCtrl = addPixelEditor(
    grp,
    "Stroke Width",
    config.strokeWidth,
    LIMITS.strokeWidth,
  );

  let isSyncing = false;

  let lastLink = linkSwitch.value;
  let lastPadX = padXCtrl.value;
  let lastPadY = padYCtrl.value;

  let previewTimer = null;
  let previewRunning = false;
  let previewQueued = false;

  function syncPaddingControls() {
    if (isSyncing) return;

    isSyncing = true;

    try {
      if (linkSwitch.value) {
        if (!lastLink) {
          padYCtrl.value = padXCtrl.value;
        } else if (padXCtrl.value !== lastPadX) {
          padYCtrl.value = padXCtrl.value;
        } else if (padYCtrl.value !== lastPadY) {
          padXCtrl.value = padYCtrl.value;
        }
      }

      lastLink = linkSwitch.value;
      lastPadX = padXCtrl.value;
      lastPadY = padYCtrl.value;
    } finally {
      isSyncing = false;
    }
  }

  function updateConfigFromUI() {
    config.paddingX = getEditorValue(padXCtrl, LIMITS.padding, config.paddingX);

    config.paddingY = getEditorValue(padYCtrl, LIMITS.padding, config.paddingY);

    config.cornerRadius = getEditorValue(
      radiusCtrl,
      LIMITS.cornerRadius,
      config.cornerRadius,
    );

    config.strokeWidth = getEditorValue(
      strokeWidthCtrl,
      LIMITS.strokeWidth,
      config.strokeWidth,
    );

    config.colour = getPickerValue(picker, config.colour);

    config.strokeColour = getPickerValue(strokePicker, config.strokeColour);
  }

  function refreshPreview() {
    if (previewRunning) {
      previewQueued = true;
      return;
    }

    previewRunning = true;

    try {
      clearPreviews(doc);
      executeButtonCommand(doc, targets, config, true);
    } catch (_) {
      // Silent preview failure
    } finally {
      previewRunning = false;

      if (previewQueued) {
        previewQueued = false;
        queuePreview();
      }
    }
  }

  function queuePreview() {
    if (previewTimer) {
      return;
    }

    previewTimer = setTimeout(PREVIEW_DELAY, () => {
      previewTimer = null;
      refreshPreview();
    });
  }

  function handleUpdate() {
    syncPaddingControls();
    updateConfigFromUI();
    queuePreview();
  }

  picker.onValueChangedHandler = handleUpdate;
  strokePicker.onValueChangedHandler = handleUpdate;
  linkSwitch.onValueChangedHandler = handleUpdate;
  padXCtrl.onValueChangedHandler = handleUpdate;
  padYCtrl.onValueChangedHandler = handleUpdate;
  radiusCtrl.onValueChangedHandler = handleUpdate;
  strokeWidthCtrl.onValueChangedHandler = handleUpdate;

  const historyStart = doc.history.position;

  updateConfigFromUI();
  refreshPreview();

  const result = dlg.show();

  clearPreviews(doc);

  if (result.value === DialogResult.Ok.value) {
    updateConfigFromUI();

    try {
      createButtonsAndGroups(doc, targets, config);
    } catch (_) {
      app.alert("Unable to create one or more grouped buttons.", APP_NAME);
    }
  } else {
    try {
      if (doc.history.position !== historyStart) {
        doc.history.position = historyStart;
      }
    } catch (_) {}
  }

  restoreSelection(doc, originalNodes);

  setTimeout(0, () => {
    restoreSelection(doc, originalNodes);
  });

  setTimeout(100, () => {
    restoreSelection(doc, originalNodes);
  });
}

main();
