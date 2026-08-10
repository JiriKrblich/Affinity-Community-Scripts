/**
 * name: Make Button 2.2.2
 * description: Instantly creates perfectly padded rounded button backgrounds behind selected text layers with live preview, customizable fill/stroke styling, linked padding controls, automatic grouping, and optional height normalisation across mixed-size selections.
 * version: 2.2.2
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
const { Rectangle } = require("/geometry");
const { RGBA8 } = require("/colours");
const { FillDescriptor, SolidFill } = require("/fills");
const { LineStyleDescriptor, LineStyle, StrokeAlignment } = require("/linestyle");
const { ContainerNodeDefinition, ShapeNodeDefinition } = require("/nodes");
const { ShapeRectangle, ShapeCornerType } = require("/shapes");
const { Selection } = require("/selections");
const { app } = require("/application");
const { setTimeout } = require("/timers");

const APP_NAME = "Make Button";
const DEFAULT_CONTAINER_NAME = "Button";
const BUTTON_PREFIX = "\u2022 ";
const BACKGROUND_NAME = "BG";
const PREVIEW_DELAY = 16;
const MIN_SIZE = 0.01;

const LIMITS = {
  padding: { min: 0, max: 100 },
  cornerRadius: { min: 0, max: 200 },
  strokeWidth: { min: 0, max: 50 },
};

let config = {
  paddingX: 20,
  paddingY: 20,
  cornerRadius: 20,
  colour: RGBA8(50, 50, 50),
  strokeWidth: 0,
  strokeColour: RGBA8(100, 100, 100),
  strokeAlignment: StrokeAlignment.Outside,
  normalizeHeight: false,
  normalizeWidth: false,
  textAlign: 1,
  livePreview: true,
  _maxReferenceHeight: 0,
  _maxReferenceWidth: 0,
};

const STROKE_ALIGNMENT_LABELS = ["Outside", "Center", "Inside"];
const STROKE_ALIGNMENT_VALUES = [
  StrokeAlignment.Outside,
  StrokeAlignment.Centre,
  StrokeAlignment.Inside,
];

const TEXT_ALIGNMENT_LABELS = ["Left", "Center", "Right"];

const FONT_RATIOS = {
  cap: 0.70,
  xHeight: 0.48,
  descender: 0.20,
};

const RE_CAP_ASCENDER = /[A-ZÀ-ÖØ-ŸbdfhijkltÀ-ÖQJ]/;
const RE_DESCENDER = /[gjpqy]/;

function getTextString(node) {
  const props = ["text", "plainText", "content", "characters", "userText"];
  for (const prop of props) {
    try {
      const v = node[prop];
      if (typeof v === "string") return v;
    } catch (_) {}
  }
  return "";
}

function detectFontSize(node) {
  const attempts = [
    () => node.textStyle && node.textStyle.fontSize,
    () => node.paragraphStyle && node.paragraphStyle.fontSize,
    () => node.characterStyle && node.characterStyle.fontSize,
    () => node.style && node.style.fontSize,
    () => node.fontSize,
    () => node.textFormat && node.textFormat.fontSize,
    () => node.textAttributes && node.textAttributes.fontSize,
  ];
  for (const fn of attempts) {
    try {
      const v = fn();
      if (typeof v === "number" && v > 0) return v;
    } catch (_) {}
  }
  return null;
}

function classifyText(text) {
  let hasCap = false, hasDesc = false, hasAnyLetter = false;
  for (const ch of text) {
    if (/[A-Za-z\u00C0-\u024F]/.test(ch)) {
      hasAnyLetter = true;
      if (RE_CAP_ASCENDER.test(ch)) hasCap = true;
      if (RE_DESCENDER.test(ch)) hasDesc = true;
    }
  }
  return { hasCap, hasDesc, hasAnyLetter };
}

function computeTargetNormMetrics(node, box) {
  const text = getTextString(node);
  const { hasCap, hasDesc, hasAnyLetter } = classifyText(text);
  const refRatio = hasCap || !hasAnyLetter ? FONT_RATIOS.cap : FONT_RATIOS.xHeight;
  const descRatio = hasDesc ? FONT_RATIOS.descender : 0;
  let referenceHeight, baselineY;
  const fs = detectFontSize(node);
  if (fs && fs > 0) {
    referenceHeight = fs * refRatio;
    baselineY = box.y + box.height - fs * descRatio;
  } else {
    if (descRatio > 0) {
      const totalRatio = refRatio + descRatio;
      referenceHeight = box.height * (refRatio / totalRatio);
    } else {
      referenceHeight = box.height;
    }
    baselineY = box.y + referenceHeight;
  }
  return { referenceHeight, baselineY };
}

function enrichTargetsForNormalize(targets) {
  let maxRef = 0;
  for (const target of targets) {
    try {
      target._normMetrics = computeTargetNormMetrics(target.node, target.box);
      if (target._normMetrics.referenceHeight > maxRef)
        maxRef = target._normMetrics.referenceHeight;
    } catch (e) {
      console.log("Make Button: failed to compute normalization metrics for a target - " + String(e));
      target._normMetrics = null;
    }
  }
  return maxRef;
}

function computeMaxBoxWidth(targets) {
  let maxWidth = 0;
  for (const t of targets) {
    if (t.box.width > maxWidth) maxWidth = t.box.width;
  }
  return maxWidth;
}

function clampValue(value, min, max, fallback) {
  const number = Number(value);
  if (!isFinite(number)) return fallback;
  return Math.max(min, Math.min(number, max));
}

function getEditorValue(editor, limit, fallback) {
  return clampValue(editor.value, limit.min, limit.max, fallback);
}

function getPickerValue(picker, fallback) {
  return picker.value || fallback;
}

function cleanLayerName(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function readString(object, property) {
  try { return cleanLayerName(object[property]); } catch (_) { return ""; }
}

function getLayerName(node) {
  const properties = [
    "description", "userDescription",
    "defaultDescriptionForDisplay", "defaultDescription",
  ];
  for (const property of properties) {
    const value = readString(node, property);
    if (value && value !== BACKGROUND_NAME) return value;
  }
  return readString(node, "text");
}

function getButtonContainerName(node) {
  let name = getLayerName(node) || DEFAULT_CONTAINER_NAME;
  if (name.indexOf(BUTTON_PREFIX) === 0) return name;
  return BUTTON_PREFIX + name;
}

function addPixelEditor(group, label, value, limit) {
  const editor = group.addUnitValueEditor(
    label, UnitType.Pixel, UnitType.Pixel, value, limit.min, limit.max,
  );
  editor.showPopupSlider = true;
  return editor;
}

function detectTargets(doc) {
  const sel = doc.selection;
  if (!sel || sel.length === 0) return [];
  const targets = [];
  for (const node of sel.nodes) {
    try {
      const box = node.getSpreadBaseBox();
      if (!box) continue;
      targets.push({ node, box, _normMetrics: null });
    } catch (_) {}
  }
  return targets;
}

function clampRadius(radius, width, height) {
  return Math.max(0, Math.min(radius, Math.min(width, height) / 2));
}

function getBackgroundGeometry(box, conf, target) {
  let baseWidth = box.width;
  if (conf.normalizeWidth && conf._maxReferenceWidth > 0) {
    baseWidth = conf._maxReferenceWidth;
  }
  const width = Math.max(MIN_SIZE, baseWidth + conf.paddingX * 2);

  let x = box.x - conf.paddingX;

  if (conf.normalizeWidth && conf._maxReferenceWidth > 0) {
    if (conf.textAlign === 0) {
      x = box.x - conf.paddingX;
    } else if (conf.textAlign === 2) {
      x = (box.x + box.width) + conf.paddingX - width;
    } else {
      x = (box.x + box.width / 2) - (width / 2);
    }
  }

  let y, height;
  const normMetrics = target && target._normMetrics;
  const maxRef = conf._maxReferenceHeight;
  if (conf.normalizeHeight && normMetrics && maxRef > 0) {
    height = Math.max(MIN_SIZE, maxRef + conf.paddingY * 2);
    y = normMetrics.baselineY - maxRef - conf.paddingY;
  } else {
    height = Math.max(MIN_SIZE, box.height + conf.paddingY * 2);
    y = box.y - conf.paddingY;
  }

  return { x, y, width, height, radius: clampRadius(conf.cornerRadius, width, height) };
}

function createSolidFillDescriptor(colour) {
  return FillDescriptor.createSolid(SolidFill.create(colour));
}

function applyStrokeToNodeDef(nodeDef, conf) {
  if (conf.strokeWidth <= 0) return;
  try {
    const lineStyle = LineStyle.createDefaultWithWeight(conf.strokeWidth);
    const lineDescriptor = LineStyleDescriptor.create(lineStyle, {
      strokeAlignment: conf.strokeAlignment ?? StrokeAlignment.Outside,
    });
    nodeDef.setLineDescriptors(
      createSolidFillDescriptor(conf.strokeColour),
      lineDescriptor,
      0,
    );
  } catch (e) {
    console.log("Make Button: failed to apply stroke - " + String(e));
  }
}

function applyRoundedShapeCorners(shape, radius, width, height) {
  for (const corner of [shape.topLeft, shape.topRight, shape.bottomLeft, shape.bottomRight]) {
    corner.cornerType = ShapeCornerType.Round;
    corner.setRadius(radius, width, height);
  }
}

function createBackgroundNodeDef(box, conf, target) {
  const geometry = getBackgroundGeometry(box, conf, target);
  const shape = ShapeRectangle.create();
  const fillDesc = createSolidFillDescriptor(conf.colour);
  shape.setAbsoluteSizes(true, geometry.width, geometry.height);
  applyRoundedShapeCorners(shape, geometry.radius, geometry.width, geometry.height);
  const nodeDef = ShapeNodeDefinition.create(
    shape,
    new Rectangle(geometry.x, geometry.y, geometry.width, geometry.height),
    fillDesc,
  );
  applyStrokeToNodeDef(nodeDef, conf);
  nodeDef.userDescription = BACKGROUND_NAME;
  return nodeDef;
}

function buildPreviewCommand(targets, conf) {
  const compound = CompoundCommandBuilder.create();
  let added = 0;
  for (const target of targets) {
    try {
      const builder = AddChildNodesCommandBuilder.create();
      builder.setInsertionTarget(target.node);
      builder.setInsertionMode(InsertionMode.Behind);
      builder.addNode(createBackgroundNodeDef(target.box, conf, target));
      compound.addCommand(builder.createCommand(true, NodeChildType.Main));
      added++;
    } catch (_) {}
  }
  if (added === 0) return null;
  try { return compound.createCommand(); } catch (_) { return null; }
}

function getNodeSelection(doc, node) {
  try {
    if (node.selfSelection) return node.selfSelection;
  } catch (_) {}
  return Selection.create(doc, node);
}

function clearPreviews(doc) {
  try { doc.executeCommand(DocumentCommand.createClearPreviews()); } catch (_) {}
}

function executePreview(doc, targets, conf) {
  const cmd = buildPreviewCommand(targets, conf);
  if (!cmd) return false;
  doc.executeCommand(cmd, true);
  return true;
}

function createButtonsAndGroups(doc, targets, conf) {
  const historyStart = doc.history.position;

  function rollback(reason) {
    console.log("Make Button: rolling back - " + reason);
    try {
      if (doc.history.position !== historyStart) {
        doc.history.position = historyStart;
      }
    } catch (e) {
      console.log("Make Button: rollback failed - " + String(e));
    }
  }

  const containerCompound = CompoundCommandBuilder.create();
  let containerCount = 0;

  for (const target of targets) {
    try {
      const definition = ContainerNodeDefinition.create(
        getButtonContainerName(target.node)
      );
      const builder = AddChildNodesCommandBuilder.create();
      builder.setInsertionTargetSelection(getNodeSelection(doc, target.node));
      builder.addContainerNode(definition);
      containerCompound.addCommand(
        builder.createCommand(false, NodeChildType.Main),
        false
      );
      containerCount++;
    } catch (e) {
      console.log("Make Button: failed to build container command for a target - " + String(e));
    }
  }

  if (containerCount === 0) return false;

  let containerCmd;
  try {
    containerCmd = containerCompound.createCommand();
    doc.executeCommand(containerCmd);
  } catch (e) {
    rollback("container creation threw: " + String(e));
    return false;
  }

  const containers = (containerCmd.newNodes || []).filter(n => {
    try { return n.isContainerNode; } catch (_) { return false; }
  });

  if (containers.length !== targets.length) {
    rollback("container count mismatch (" + containers.length + " of " + targets.length + ")");
    return false;
  }

  const finalCompound = CompoundCommandBuilder.create();
  let finalCount = 0;

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const container = containers[i];

    try {
      const bgBuilder = AddChildNodesCommandBuilder.create();
      bgBuilder.setInsertionTarget(container);
      bgBuilder.addNode(createBackgroundNodeDef(target.box, conf, target));
      finalCompound.addCommand(
        bgBuilder.createCommand(false, NodeChildType.Main),
        false
      );

      finalCompound.addCommand(
        DocumentCommand.createMoveNodes(
          Selection.create(doc, [target.node]),
          container,
          NodeMoveType.Inside,
          NodeChildType.Main
        ),
        false
      );

      finalCount++;
    } catch (e) {
      console.log("Make Button: failed to build finalize command for a target - " + String(e));
    }
  }

  if (finalCount !== targets.length) {
    rollback("only " + finalCount + " of " + targets.length + " targets finalized");
    return false;
  }

  try {
    doc.executeCommand(finalCompound.createCommand());
  } catch (e) {
    rollback("finalize compound threw: " + String(e));
    return false;
  }

  return true;
}

function restoreSelection(doc, nodes) {
  try { doc.selection = Selection.create(doc, nodes); } catch (_) {}
}

function main() {
  const doc = Document.current;
  if (!doc) { app.alert("No document open.", APP_NAME); return; }

  const targets = detectTargets(doc);
  if (targets.length === 0) { app.alert("Please select at least one layer.", APP_NAME); return; }

  const originalNodes = targets.map(t => t.node);

  const globalMaxReferenceHeight = enrichTargetsForNormalize(targets);
  const globalMaxWidth = computeMaxBoxWidth(targets);

  const dlg = Dialog.create(APP_NAME);
  dlg.initialWidth = 360;
  const col = dlg.addColumn();

  const bgGroup = col.addGroup("Background Fill");
  bgGroup.enableSeparator = false;
  const picker = bgGroup.addColourPicker("", config.colour);
  picker.isFullWidth = true;

  const strokeGroup = col.addGroup("Stroke Fill");
  strokeGroup.enableSeparator = false;
  const strokePicker = strokeGroup.addColourPicker("", config.strokeColour);
  strokePicker.isFullWidth = true;

  const grp = col.addGroup("Button Appearance");
  grp.enableSeparator = true;

  const normalizeHeightSwitch = grp.addSwitch("Normalize Height", config.normalizeHeight);
  const normalizeWidthSwitch = grp.addSwitch("Normalize Width", config.normalizeWidth);
  const textAlignCtrl = grp.addComboBox("Content Alignment", TEXT_ALIGNMENT_LABELS, config.textAlign);
  const linkSwitch = grp.addSwitch("Link Padding", true);

  const padXCtrl = addPixelEditor(grp, "Horizontal Padding", config.paddingX, LIMITS.padding);
  const padYCtrl = addPixelEditor(grp, "Vertical Padding", config.paddingY, LIMITS.padding);
  const radiusCtrl = addPixelEditor(grp, "Corner Radius", config.cornerRadius, LIMITS.cornerRadius);
  const strokeWidthCtrl = addPixelEditor(grp, "Stroke Width", config.strokeWidth, LIMITS.strokeWidth);
  const strokeAlignmentCtrl = grp.addComboBox(
    "Stroke Alignment",
    STROKE_ALIGNMENT_LABELS,
    STROKE_ALIGNMENT_VALUES.indexOf(config.strokeAlignment),
  );

  const previewGrp = col.addGroup("");
  previewGrp.enableSeparator = true;
  const livePreviewSwitch = previewGrp.addSwitch("Enable Live Preview", config.livePreview);

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
    config.cornerRadius = getEditorValue(radiusCtrl, LIMITS.cornerRadius, config.cornerRadius);
    config.strokeWidth = getEditorValue(strokeWidthCtrl, LIMITS.strokeWidth, config.strokeWidth);
    try {
      config.strokeAlignment = STROKE_ALIGNMENT_VALUES[strokeAlignmentCtrl.selectedIndex];
    } catch (_) {
      config.strokeAlignment = config.strokeAlignment || StrokeAlignment.Outside;
    }
    config.colour = getPickerValue(picker, config.colour);
    config.strokeColour = getPickerValue(strokePicker, config.strokeColour);
    config.normalizeHeight = normalizeHeightSwitch.value;
    config.normalizeWidth = normalizeWidthSwitch.value;
    config.textAlign = textAlignCtrl.selectedIndex;
    config.livePreview = livePreviewSwitch.value;

    config._maxReferenceHeight = config.normalizeHeight ? globalMaxReferenceHeight : 0;
    config._maxReferenceWidth = config.normalizeWidth ? globalMaxWidth : 0;
  }

  function refreshPreview() {
    if (previewRunning) { previewQueued = true; return; }
    previewRunning = true;
    try {
      clearPreviews(doc);
      if (config.livePreview) {
        executePreview(doc, targets, config);
      }
    } catch (_) {} finally {
      previewRunning = false;
      if (previewQueued) { previewQueued = false; queuePreview(); }
    }
  }

  function queuePreview() {
    if (previewTimer) return;
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
  strokeAlignmentCtrl.onValueChangedHandler = handleUpdate;
  normalizeHeightSwitch.onValueChangedHandler = handleUpdate;
  normalizeWidthSwitch.onValueChangedHandler = handleUpdate;
  textAlignCtrl.onValueChangedHandler = handleUpdate;
  linkSwitch.onValueChangedHandler = handleUpdate;
  padXCtrl.onValueChangedHandler = handleUpdate;
  padYCtrl.onValueChangedHandler = handleUpdate;
  radiusCtrl.onValueChangedHandler = handleUpdate;
  strokeWidthCtrl.onValueChangedHandler = handleUpdate;
  livePreviewSwitch.onValueChangedHandler = handleUpdate;

  const historyStart = doc.history.position;
  updateConfigFromUI();
  refreshPreview();

  const result = dlg.show();
  clearPreviews(doc);

  if (result.value === DialogResult.Ok.value) {
    updateConfigFromUI();
    let created = false;
    try {
      created = createButtonsAndGroups(doc, targets, config);
    } catch (e) {
      console.log("Make Button: unexpected error creating buttons - " + String(e));
    }
    if (!created) {
      app.alert("Unable to create one or more grouped buttons. No changes were made.", APP_NAME);
      try {
        if (doc.history.position !== historyStart)
          doc.history.position = historyStart;
      } catch (_) {}
    }
  } else {
    try {
      if (doc.history.position !== historyStart)
        doc.history.position = historyStart;
    } catch (_) {}
  }

  restoreSelection(doc, originalNodes);
  setTimeout(0, () => { restoreSelection(doc, originalNodes); });
  setTimeout(100, () => { restoreSelection(doc, originalNodes); });
}

main();
