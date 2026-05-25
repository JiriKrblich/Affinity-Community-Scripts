/**
 * name: Apple Squircle Tool
 * description: Turn selected rectangles into Apple-style squircles with adjustable strength and optional live preview.
 * version: 1.0.0
 * author: the-shoemaker
 */

"use strict";

const { Document } = require("/document");
const { Dialog, DialogResult } = require("/dialog");
const { UnitType } = require("/units");
const {
  DocumentCommand,
  AddChildNodesCommandBuilder,
  NodeChildType,
} = require("/commands");
const { Selection } = require("/selections");
const { PolyCurve, CurveBuilder } = require("/geometry");
const { PolyCurveNodeDefinition } = require("/nodes");
const { LineStyleDescriptor } = require("/linestyle");

const DEFAULTS = {
  amount: 78,
  replaceOriginals: true,
  livePreview: false,
};

let previewNodes = [];
let previewVisible = false;

function showMessage(title, message) {
  const dlg = Dialog.create(title);
  dlg.initialWidth = 420;
  dlg.addColumn().addGroup("").addStaticText("", message).isFullWidth = true;
  dlg.show();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function exec(doc, cmd) {
  doc.executeCommand(cmd);
}

function deleteNodes(doc, nodes) {
  for (const node of nodes) {
    try {
      exec(
        doc,
        DocumentCommand.createDeleteSelection(
          Selection.create(doc, node),
          false,
        ),
      );
    } catch (e) {}
  }
}

function setNodesVisibility(doc, nodes, isVisible) {
  for (const node of nodes) {
    try {
      exec(
        doc,
        DocumentCommand.createSetVisibility(node.selfSelection, isVisible),
      );
    } catch (e) {}
  }
}

function deletePreview() {
  if (previewNodes.length === 0) return;
  deleteNodes(Document.current, previewNodes);
  previewNodes = [];
}

function clearPreviewAndRestore(doc, sourceNodes) {
  deletePreview();
  if (previewVisible) {
    setNodesVisibility(doc, sourceNodes, true);
    previewVisible = false;
  }
}

function findInsertionTarget(sourceNode) {
  const doc = Document.current;
  let node = sourceNode;

  while (node && node[Symbol.toStringTag] !== "SpreadNode") {
    try {
      const abi = node.artboardInterface;
      if (abi && abi.isArtboardEnabled) return abi.node || node;
    } catch (e) {}
    node = node.parent;
  }

  return doc.currentSpread;
}

function makeLineSeg(start, end) {
  return {
    start,
    c1: { x: start.x, y: start.y },
    c2: { x: end.x, y: end.y },
    end,
  };
}

function buildRectangleSegments(box) {
  const left = box.x;
  const top = box.y;
  const right = box.x + box.width;
  const bottom = box.y + box.height;

  const p0 = { x: left, y: top };
  const p1 = { x: right, y: top };
  const p2 = { x: right, y: bottom };
  const p3 = { x: left, y: bottom };

  return [
    makeLineSeg(p0, p1),
    makeLineSeg(p1, p2),
    makeLineSeg(p2, p3),
    makeLineSeg(p3, p0),
  ];
}

function buildSquircleSegments(box, amountPercent) {
  const left = box.x;
  const top = box.y;
  const width = box.width;
  const height = box.height;
  const right = left + width;
  const bottom = top + height;

  const t = clamp(amountPercent / 100, 0, 1);
  if (t <= 0.0001) return buildRectangleSegments(box);

  const minSide = Math.min(width, height);
  const inset = minSide * 0.5 * t;
  const handleFactor = lerp(0.55, 0.92, t);
  const handle = inset * handleFactor;

  const p0 = { x: left + inset, y: top };
  const p1 = { x: right - inset, y: top };
  const p2 = { x: right, y: top + inset };
  const p3 = { x: right, y: bottom - inset };
  const p4 = { x: right - inset, y: bottom };
  const p5 = { x: left + inset, y: bottom };
  const p6 = { x: left, y: bottom - inset };
  const p7 = { x: left, y: top + inset };

  return [
    makeLineSeg(p0, p1),
    {
      start: p1,
      c1: { x: p1.x + handle, y: p1.y },
      c2: { x: p2.x, y: p2.y - handle },
      end: p2,
    },
    makeLineSeg(p2, p3),
    {
      start: p3,
      c1: { x: p3.x, y: p3.y + handle },
      c2: { x: p4.x + handle, y: p4.y },
      end: p4,
    },
    makeLineSeg(p4, p5),
    {
      start: p5,
      c1: { x: p5.x - handle, y: p5.y },
      c2: { x: p6.x, y: p6.y + handle },
      end: p6,
    },
    makeLineSeg(p6, p7),
    {
      start: p7,
      c1: { x: p7.x, y: p7.y - handle },
      c2: { x: p0.x - handle, y: p0.y },
      end: p0,
    },
  ];
}

function buildPolyCurveFromSegments(segments) {
  const builder = CurveBuilder.create();
  builder.begin(segments[0].start);

  for (const seg of segments) {
    builder.addBezier(seg.c1, seg.c2, seg.end);
  }

  builder.close();

  const poly = new PolyCurve();
  poly.addCurve(builder.createCurve());
  return poly;
}

function buildDefinitionFromSource(sourceNode, amountPercent) {
  const box = sourceNode.getSpreadBaseBox();
  if (!box || box.width <= 0 || box.height <= 0) {
    throw new Error("A selected object has no usable bounds.");
  }

  const def = PolyCurveNodeDefinition.createDefault();
  const poly = buildPolyCurveFromSegments(
    buildSquircleSegments(box, amountPercent),
  );
  def.setCurves(poly);

  try {
    def.setBrushFillDescriptor(0, sourceNode.brushFillInterface.fillDescriptor);
  } catch (e) {}

  try {
    def.setLineDescriptors(
      0,
      sourceNode.lineStyleInterface.penFillDescriptor,
      LineStyleDescriptor.create(sourceNode.lineStyleInterface.lineStyle),
    );
  } catch (e) {}

  const baseName =
    sourceNode.userDescription || sourceNode.defaultDescription || "Shape";
  def.userDescription = baseName + " Squircle";
  return def;
}

function createPreviewForNodes(sourceNodes, settings) {
  const doc = Document.current;
  const created = [];

  for (const sourceNode of sourceNodes) {
    const builder = AddChildNodesCommandBuilder.create();
    builder.setInsertionTarget(findInsertionTarget(sourceNode));
    builder.addNode(buildDefinitionFromSource(sourceNode, settings.amount));

    const cmd = builder.createCommand(true, NodeChildType.Main);
    exec(doc, cmd);

    if (cmd.newNodes && cmd.newNodes.length > 0) {
      for (const node of cmd.newNodes) created.push(node);
    }
  }

  previewNodes = created;
}

function readSelectedNodes(doc) {
  const sel = doc.selection;
  const nodes = [];

  if (!sel || sel.length === 0) return nodes;

  for (let i = 0; i < sel.length; i++) {
    const node = sel.at(i).node;
    if (!node) continue;

    try {
      const box = node.getSpreadBaseBox();
      if (box && box.width > 0 && box.height > 0) nodes.push(node);
    } catch (e) {}
  }

  return nodes;
}

function run() {
  const doc = Document.current;
  const sourceNodes = readSelectedNodes(doc);

  if (sourceNodes.length === 0) {
    showMessage(
      "Apple Squircle Live",
      "Select one or more square or rectangle vector shapes, then run the script.",
    );
    return;
  }

  const dlg = Dialog.create("Apple Squircle Live");
  dlg.initialWidth = 400;

  const col = dlg.addColumn();
  const intro = col.addGroup("Apple Squircle Tool");
  intro.addStaticText(
    "",
    "Turn selected rectangles into Apple-style squircles. Adjust the effect strength, and optionally enable live preview while you tweak it.",
  ).isFullWidth = true;

  const opts = col.addGroup("Squircle");
  const amountCtrl = opts.addUnitValueEditor(
    "Effect Amount",
    UnitType.Number,
    UnitType.Number,
    DEFAULTS.amount,
    0,
    100,
  );
  amountCtrl.precision = 0;
  amountCtrl.showPopupSlider = true;

  const replaceCtrl = opts.addSwitch(
    "Replace original shapes on OK",
    DEFAULTS.replaceOriginals,
  );

  const previewGroup = col.addGroup("Preview");
  const livePreviewCtrl = previewGroup.addSwitch(
    "Enable live preview",
    DEFAULTS.livePreview,
  );
  const hintCtrl = previewGroup.addStaticText(
    "",
    "Live preview is off by default to keep the canvas and layers panel stable. Click OK to apply, or enable live preview when you want interactive feedback.",
  );
  hintCtrl.isFullWidth = true;

  function readSettings() {
    return {
      amount: clamp(Math.round(amountCtrl.value), 0, 100),
      replaceOriginals: replaceCtrl.value,
      livePreview: livePreviewCtrl.value,
    };
  }

  function updatePreview() {
    try {
      if (!previewVisible) {
        setNodesVisibility(doc, sourceNodes, false);
        previewVisible = true;
      }

      deletePreview();
      createPreviewForNodes(sourceNodes, readSettings());
      return true;
    } catch (e) {
      clearPreviewAndRestore(doc, sourceNodes);
      return false;
    }
  }

  let lastLivePreview = DEFAULTS.livePreview;
  let lastAmount = clamp(Math.round(amountCtrl.value), 0, 100);

  dlg.onControlValueChangedHandler = function () {
    const settings = readSettings();

    if (!settings.livePreview) {
      clearPreviewAndRestore(doc, sourceNodes);
      lastLivePreview = false;
      lastAmount = settings.amount;
      return true;
    }

    const shouldRefresh =
      !lastLivePreview ||
      settings.amount !== lastAmount ||
      previewNodes.length === 0;

    lastLivePreview = true;
    lastAmount = settings.amount;

    if (!shouldRefresh) return true;
    return updatePreview();
  };

  const result = dlg.show();

  if (result.value !== DialogResult.Ok.value) {
    clearPreviewAndRestore(doc, sourceNodes);
    return;
  }

  const settings = readSettings();

  if (settings.livePreview) {
    if (previewNodes.length === 0 && !updatePreview()) {
      showMessage(
        "Apple Squircle Tool",
        "The preview could not be generated for the current selection.",
      );
      clearPreviewAndRestore(doc, sourceNodes);
      return;
    }
  } else if (!updatePreview()) {
    showMessage(
      "Apple Squircle Tool",
      "The squircle could not be generated for the current selection. Try plain vector rectangles or squares.",
    );
    clearPreviewAndRestore(doc, sourceNodes);
    return;
  }

  if (settings.replaceOriginals) {
    deleteNodes(doc, sourceNodes);
  } else if (previewVisible) {
    setNodesVisibility(doc, sourceNodes, true);
  }

  previewNodes = [];
  previewVisible = false;
}

run();
