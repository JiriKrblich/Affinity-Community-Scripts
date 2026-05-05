"use strict";

/*
    Faux 3D Primitives - just for fun! Might add more later if anyone is interested

    Adds:
    - Size control in dialog

    Expected hierarchy for All 3:

    All 3
    ├─ Cube
    │  ├─ Poly Line
    │  ├─ Poly Line
    │  └─ Poly Line
    ├─ Cylinder
    │  ├─ Poly Line
    │  ├─ Poly Line
    │  ├─ Poly Line
    │  ├─ Line
    │  └─ Line
    └─ Cone
       ├─ Poly Line
       └─ Poly Line
*/

const { Document } = require("/document");

const {
  PolyCurveNodeDefinition,
  ContainerNodeDefinition,
  NodeChildType,
} = require("/nodes");

const { AddChildNodesCommandBuilder } = require("/commands");

const { CurveBuilder, PolyCurve } = require("/geometry");
const { FillDescriptor } = require("/fills");
const { LineStyleDescriptor } = require("/linestyle");
const { RGBA8 } = require("/colours");
const { BlendMode } = require("affinity:common");

const { Dialog, DialogResult } = require("/dialog.js");
const { UnitType } = require("/units");

// --------------------------------------------------
// helpers
// --------------------------------------------------

function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (value.toArray) return value.toArray();
  return Array.from(value);
}

function solid(r, g, b, a) {
  return FillDescriptor.createSolid(
    RGBA8(r, g, b, a == null ? 255 : a),
    BlendMode.Normal,
  );
}

function noFill() {
  return FillDescriptor.createNone();
}

function lineStyle(width) {
  return LineStyleDescriptor.createDefault(width);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getNumberFromControl(ctrl, fallback) {
  const v = ctrl.value;

  if (typeof v === "number") {
    return v;
  }

  if (v && typeof v.value === "number") {
    return v.value;
  }

  const n = Number(v);

  if (isFinite(n)) {
    return n;
  }

  return fallback;
}

const black = solid(0, 0, 0, 255);
const transparent = noFill();

// --------------------------------------------------
// polycurve helpers
// --------------------------------------------------

function makeClosedPolyCurve(points) {
  const cb = CurveBuilder.create();

  cb.beginXY(points[0].x, points[0].y);

  for (let i = 1; i < points.length; i++) {
    cb.lineToXY(points[i].x, points[i].y);
  }

  cb.close();

  const poly = new PolyCurve();
  poly.addCurve(cb.createCurve());

  return poly;
}

function makeOpenPolyCurve(points) {
  const cb = CurveBuilder.create();

  cb.beginXY(points[0].x, points[0].y);

  for (let i = 1; i < points.length; i++) {
    cb.lineToXY(points[i].x, points[i].y);
  }

  const poly = new PolyCurve();
  poly.addCurve(cb.createCurve());

  return poly;
}

function addClosed(builder, points, brushFill, lineFill, width) {
  const nodeDef = PolyCurveNodeDefinition.create(
    makeClosedPolyCurve(points),
    brushFill,
    lineStyle(width == null ? 1 : width),
    lineFill || black,
    transparent,
  );

  builder.addNode(nodeDef);
}

function addOpen(builder, points, lineFill, width) {
  const nodeDef = PolyCurveNodeDefinition.create(
    makeOpenPolyCurve(points),
    noFill(),
    lineStyle(width == null ? 1 : width),
    lineFill || black,
    transparent,
  );

  builder.addNode(nodeDef);
}

function ellipsePoints(cx, cy, rx, ry, steps) {
  const pts = [];
  const count = steps || 56;

  for (let i = 0; i < count; i++) {
    const a = (Math.PI * 2 * i) / count;

    pts.push({
      x: cx + Math.cos(a) * rx,
      y: cy + Math.sin(a) * ry,
    });
  }

  return pts;
}

function addEllipse(builder, cx, cy, rx, ry, brushFill, lineFill, width) {
  addClosed(
    builder,
    ellipsePoints(cx, cy, rx, ry, 56),
    brushFill,
    lineFill || black,
    width == null ? 1 : width,
  );
}

// --------------------------------------------------
// primitives
// --------------------------------------------------

function drawCube(builder, cx, cy, size) {
  const s = size;
  const d = size * 0.38;

  // right side
  addClosed(
    builder,
    [
      { x: cx + s / 2, y: cy - s / 2 },
      { x: cx + s / 2 + d, y: cy - s / 2 - d },
      { x: cx + s / 2 + d, y: cy + s / 2 - d },
      { x: cx + s / 2, y: cy + s / 2 },
    ],
    solid(90, 150, 230),
    black,
    2,
  );

  // top
  addClosed(
    builder,
    [
      { x: cx - s / 2, y: cy - s / 2 },
      { x: cx - s / 2 + d, y: cy - s / 2 - d },
      { x: cx + s / 2 + d, y: cy - s / 2 - d },
      { x: cx + s / 2, y: cy - s / 2 },
    ],
    solid(145, 195, 255),
    black,
    2,
  );

  // front
  addClosed(
    builder,
    [
      { x: cx - s / 2, y: cy - s / 2 },
      { x: cx + s / 2, y: cy - s / 2 },
      { x: cx + s / 2, y: cy + s / 2 },
      { x: cx - s / 2, y: cy + s / 2 },
    ],
    solid(65, 120, 210),
    black,
    2,
  );
}

function drawCylinder(builder, cx, cy, size) {
  const width = size;
  const height = size * 1.25;
  const ellipseHeight = width * 0.32;

  // body
  addClosed(
    builder,
    [
      { x: cx - width / 2, y: cy - height / 2 },
      { x: cx + width / 2, y: cy - height / 2 },
      { x: cx + width / 2, y: cy + height / 2 },
      { x: cx - width / 2, y: cy + height / 2 },
    ],
    solid(115, 200, 190),
    solid(115, 200, 190),
    1,
  );

  // top
  addEllipse(
    builder,
    cx,
    cy - height / 2,
    width / 2,
    ellipseHeight / 2,
    solid(160, 235, 225),
    black,
    2,
  );

  // bottom
  addEllipse(
    builder,
    cx,
    cy + height / 2,
    width / 2,
    ellipseHeight / 2,
    solid(80, 170, 165),
    black,
    2,
  );

  // side lines
  addOpen(
    builder,
    [
      { x: cx - width / 2, y: cy - height / 2 },
      { x: cx - width / 2, y: cy + height / 2 },
    ],
    black,
    2,
  );

  addOpen(
    builder,
    [
      { x: cx + width / 2, y: cy - height / 2 },
      { x: cx + width / 2, y: cy + height / 2 },
    ],
    black,
    2,
  );
}

function drawCone(builder, cx, cy, size) {
  const width = size;
  const height = size * 1.35;
  const ellipseHeight = width * 0.32;

  // body
  addClosed(
    builder,
    [
      { x: cx, y: cy - height / 2 },
      { x: cx + width / 2, y: cy + height / 2 },
      { x: cx - width / 2, y: cy + height / 2 },
    ],
    solid(245, 165, 90),
    black,
    2,
  );

  // base
  addEllipse(
    builder,
    cx,
    cy + height / 2,
    width / 2,
    ellipseHeight / 2,
    solid(220, 120, 65),
    black,
    2,
  );
}

// --------------------------------------------------
// container helpers
// --------------------------------------------------

function executeBuilderAndGetNewNodes(doc, builder) {
  const addCmd = builder.createCommand(true, NodeChildType.Main);
  doc.executeCommand(addCmd);

  return asArray(addCmd.newNodes);
}

function createContainer(doc, name, parentNode) {
  const builder = AddChildNodesCommandBuilder.create();

  if (parentNode && builder.setInsertionTarget) {
    builder.setInsertionTarget(parentNode);
  }

  const groupDef = ContainerNodeDefinition.create(name);
  builder.addContainerNode(groupDef);

  const addCmd = builder.createCommand(true, NodeChildType.Main);
  doc.executeCommand(addCmd);

  const newNodes = asArray(addCmd.newNodes);
  const groupNode = newNodes[0];

  if (!groupNode) {
    throw new Error("Could not create container: " + name);
  }

  return groupNode;
}

function drawPrimitiveIntoContainer(
  doc,
  primitiveName,
  cx,
  cy,
  size,
  containerNode,
) {
  const builder = AddChildNodesCommandBuilder.create();

  if (containerNode && builder.setInsertionTarget) {
    builder.setInsertionTarget(containerNode);
  }

  if (primitiveName === "Cube") {
    drawCube(builder, cx, cy, size);
  } else if (primitiveName === "Cylinder") {
    drawCylinder(builder, cx, cy, size);
  } else if (primitiveName === "Cone") {
    drawCone(builder, cx, cy, size);
  } else {
    throw new Error("Unknown primitive: " + primitiveName);
  }

  executeBuilderAndGetNewNodes(doc, builder);
}

function createPrimitiveGroup(doc, primitiveName, cx, cy, size, parentNode) {
  const groupNode = createContainer(doc, primitiveName, parentNode);

  drawPrimitiveIntoContainer(doc, primitiveName, cx, cy, size, groupNode);

  return groupNode;
}

// --------------------------------------------------
// dialog
// --------------------------------------------------

function buildDialog(doc) {
  const dlg = Dialog.create("3D Primitive Size Test");
  dlg.initialWidth = 340;

  const group = dlg.addColumn().addGroup("Primitive");

  dlg.primitive = group.addRadioGroup("Primitive", [
    "Cube",
    "Cylinder",
    "Cone",
    "All 3",
  ]);

  dlg.primitive.selectedIndex = 3;

  dlg.size = group.addUnitValueEditor(
    "Size",
    UnitType.Pixel,
    doc.units,
    90,
    30,
    220,
  );

  dlg.size.setShowPopupSlider(true);
  dlg.size.setPrecision(0);

  return dlg;
}

function getChoice(index) {
  switch (index) {
    case 0:
      return "Cube";
    case 1:
      return "Cylinder";
    case 2:
      return "Cone";
    case 3:
    default:
      return "All 3";
  }
}

function isOk(result) {
  if (!result) {
    return false;
  }

  if (result.equals && result.equals(DialogResult.Ok)) {
    return true;
  }

  return (
    result.value === DialogResult.Ok || result.value === DialogResult.Ok.value
  );
}

// --------------------------------------------------
// main
// --------------------------------------------------

function main() {
  try {
    const doc = Document.current;

    if (!doc) {
      alert("This script requires an open document.");
      return;
    }

    const dlg = buildDialog(doc);
    const result = dlg.runModal();

    if (!isOk(result)) {
      return;
    }

    const choice = getChoice(dlg.primitive.selectedIndex);
    const size = clamp(getNumberFromControl(dlg.size, 90), 30, 220);

    if (choice === "All 3") {
      const all3Node = createContainer(doc, "All 3", null);

      const spacing = size * 2.45;
      const startX = 170;
      const y = 220;

      createPrimitiveGroup(doc, "Cube", startX, y, size, all3Node);
      createPrimitiveGroup(
        doc,
        "Cylinder",
        startX + spacing,
        y,
        size,
        all3Node,
      );
      createPrimitiveGroup(
        doc,
        "Cone",
        startX + spacing * 2,
        y,
        size,
        all3Node,
      );

      return;
    }

    createPrimitiveGroup(doc, choice, 170, 220, size, null);
  } catch (e) {
    alert("Script error:\n\n" + (e && e.stack ? e.stack : e));
  }
}

module.exports.main = main;
main();
