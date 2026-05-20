/**
 * name: Shape Scatter
 * description: Scatters clones of the selected shape/curve across a defined canvas area.
 * version: 2.0.0
 * author: hellsfaun/Generated via Gemini 3.1 Pro
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
const { Curve, PolyCurve, Rectangle, CurveBuilder } = require("/geometry");
const { PolyCurveNodeDefinition } = require("/nodes");
const { FillDescriptor } = require("/fills");
const { LineStyleDescriptor } = require("/linestyle");
const { Colour } = require("/colours");

const DEFAULTS = {
  particleCount: 100,
  minSize: 15,
  maxSize: 60,
  rotationJitter: 360,
  preventOverlap: false,
  overlapThreshold: 0,
};

let previewNodes = [];

function showMessage(title, message) {
  const dlg = Dialog.create(title);
  dlg.addColumn().addGroup("").addStaticText("", message).isFullWidth = true;
  dlg.show();
}

function collectBeziers(curve) {
  const beziers = [];
  try {
    for (const bez of curve.beziers) {
      beziers.push(bez);
    }
  } catch (e) {
    return [];
  }
  return beziers;
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

function readSpreadPolyCurve(sourceNode) {
  const doc = Document.current;
  let readNode = sourceNode;
  let tempNode = null;

  if (!readNode.curvesInterface) {
    const dupCmd = DocumentCommand.createTransform(
      sourceNode.selfSelection,
      null,
      { duplicateNodes: true },
    );
    doc.executeCommand(dupCmd);

    if (!dupCmd.newNodes || dupCmd.newNodes.length === 0) {
      throw new Error(
        "Duplicate failed. Select a curve, shape, or text outline.",
      );
    }

    tempNode = dupCmd.newNodes[0];
    try {
      doc.executeCommand(
        DocumentCommand.createSetVisibility(tempNode.selfSelection, false),
      );
    } catch (e) {}

    if (!tempNode.curvesInterface) {
      doc.executeCommand(
        DocumentCommand.createConvertToCurves(Selection.create(doc, tempNode)),
      );
      tempNode = doc.selection.firstNode;
    }

    if (!tempNode || !tempNode.curvesInterface) {
      throw new Error("Could not convert the selected object to curves.");
    }

    readNode = tempNode;
  }

  // Capture the geometry and apply standard document coordinates
  const poly = readNode.curvesInterface.polyCurve.clone();
  poly.transform(readNode.baseToSpreadTransform);

  if (tempNode) {
    try {
      doc.executeCommand(
        DocumentCommand.createDeleteSelection(tempNode.selfSelection, false),
      );
    } catch (e) {}
  }

  return poly;
}

function generateParticlesPolyCurve(basePoly, settings, bounds) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;

  // 1. Calculate the exact center and dimensions of the base source shape
  for (let i = 0; i < basePoly.curveCount; i++) {
    const curve = basePoly.at(i);
    const beziers = collectBeziers(curve);
    for (const bez of beziers) {
      [bez.start, bez.end, bez.c1, bez.c2].forEach((p) => {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      });
    }
  }

  const cx = minX === Infinity ? 0 : (minX + maxX) / 2;
  const cy = minY === Infinity ? 0 : (minY + maxY) / 2;
  const baseDim =
    minX === Infinity ? 1 : Math.max(maxX - minX, maxY - minY) || 1;

  const masterPoly = new PolyCurve();

  // 2. Define the distribution bounds (using canvas/artboard bounds)
  const areaW = bounds.width;
  const areaH = bounds.height;
  const startX = bounds.x;
  const startY = bounds.y;

  const gridCols = Math.ceil(Math.sqrt(settings.particleCount));
  const cellW = areaW / gridCols;
  const cellH = areaH / Math.ceil(settings.particleCount / gridCols);
  const centerX = startX + areaW / 2;
  const centerY = startY + areaH / 2;

  const placedParticles = [];

  // 3. Scatter Loop
  for (let i = 0; i < settings.particleCount; i++) {
    let px, py, targetSize;
    let validSpot = false;
    const maxAttempts = 50; // Max location rerolls if an overlap is detected

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Pick a location based on selected Algorithm
      const algo = settings.algorithm;
      if (algo === 1 || algo === "Grid Jitter") {
        const col = i % gridCols;
        const row = Math.floor(i / gridCols);
        px = startX + col * cellW + Math.random() * cellW;
        py = startY + row * cellH + Math.random() * cellH;
      } else if (algo === 2 || algo === "Radial Burst") {
        const angle = Math.random() * Math.PI * 2;
        const burstRadius = (Math.random() * Math.min(areaW, areaH)) / 2;
        px = centerX + Math.cos(angle) * burstRadius;
        py = centerY + Math.sin(angle) * burstRadius;
      } else {
        // 0: Random Area
        px = startX + Math.random() * areaW;
        py = startY + Math.random() * areaH;
      }

      // Pick a random size
      targetSize =
        settings.minSize +
        Math.random() * (settings.maxSize - settings.minSize);

      // Overlap check
      if (!settings.preventOverlap) {
        validSpot = true;
        break;
      }

      let hasOverlap = false;
      const currentRadius = targetSize / 2;

      for (const placed of placedParticles) {
        const dx = px - placed.x;
        const dy = py - placed.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        // Collision occurs if distance is less than combined radii plus threshold
        if (dist < currentRadius + placed.radius + settings.overlapThreshold) {
          hasOverlap = true;
          break;
        }
      }

      if (!hasOverlap) {
        validSpot = true;
        break;
      }
    }

    // If the canvas is too crowded and we ran out of attempts, skip this particle
    if (!validSpot) continue;

    // Register particle for future collision checks
    placedParticles.push({ x: px, y: py, radius: targetSize / 2 });

    const scale = targetSize / baseDim;

    // Calculate random rotation
    const rot = Math.random() * settings.rotationJitter * (Math.PI / 180);
    const cosA = Math.cos(rot);
    const sinA = Math.sin(rot);

    // 4. Manually rebuild the shape by mathematically transforming every Bezier point.
    for (let c = 0; c < basePoly.curveCount; c++) {
      const curve = basePoly.at(c);
      const beziers = collectBeziers(curve);
      if (beziers.length === 0) continue;

      const bldr = CurveBuilder.create();

      // Helper: Translates to origin, scales, rotates, then translates to final canvas position
      const transformPt = (p) => {
        const tx = p.x - cx;
        const ty = p.y - cy;
        const rx = (tx * cosA - ty * sinA) * scale;
        const ry = (tx * sinA + ty * cosA) * scale;
        return { x: rx + px, y: ry + py };
      };

      bldr.begin(transformPt(beziers[0].start));

      for (const bez of beziers) {
        bldr.addBezier(
          transformPt(bez.c1),
          transformPt(bez.c2),
          transformPt(bez.end),
        );
      }

      if (curve.isClosed) {
        bldr.close();
      }

      masterPoly.addCurve(bldr.createCurve());
    }
  }

  return masterPoly;
}

function deletePreview() {
  const doc = Document.current;
  for (const node of previewNodes) {
    try {
      doc.executeCommand(
        DocumentCommand.createDeleteSelection(
          Selection.create(doc, node),
          false,
        ),
      );
    } catch (e) {}
  }
  previewNodes = [];
}

function createOverlay(sourceNode, settings, basePolyCurve, insertionTarget) {
  const doc = Document.current;

  const poly = basePolyCurve || readSpreadPolyCurve(sourceNode);

  if (poly.curveCount === 0) {
    throw new Error("No curves were found on the selected object.");
  }

  // Auto-detect artboard/canvas bounds
  let targetBox = { x: 0, y: 0, width: 2000, height: 2000 }; // fallback
  try {
    const box = insertionTarget.getSpreadBaseBox();
    if (box && box.width > 0 && box.height > 0) {
      targetBox = box;
    }
  } catch (e) {}

  const particlePoly = generateParticlesPolyCurve(poly, settings, targetBox);

  const builder = AddChildNodesCommandBuilder.create();
  builder.setInsertionTarget(
    insertionTarget || findInsertionTarget(sourceNode),
  );

  // Create single node holding all curves
  const def = PolyCurveNodeDefinition.createDefault();
  def.setCurves(particlePoly);

  // Inherit source fill exactly
  try {
    def.setBrushFillDescriptor(0, sourceNode.brushFillInterface.fillDescriptor);
  } catch (e) {}

  // Inherit source stroke exactly
  try {
    def.setLineDescriptors(
      0,
      sourceNode.lineStyleInterface.penFillDescriptor,
      LineStyleDescriptor.create(sourceNode.lineStyleInterface.lineStyle),
    );
  } catch (e) {}

  def.userDescription = "Shape Scatter Burst";
  builder.addNode(def);

  const cmd = builder.createCommand(true, NodeChildType.Main);
  doc.executeCommand(cmd);
  previewNodes = cmd.newNodes || [];
}

function run() {
  const doc = Document.current;
  const sel = doc.selection;

  if (!sel || sel.length === 0) {
    showMessage(
      "Shape Scatter",
      "No object selected. Please select a path or shape to scatter.",
    );
    return;
  }

  const sourceNode = sel.firstNode;
  let basePoly;
  let insertionTarget;
  try {
    basePoly = readSpreadPolyCurve(sourceNode);
    insertionTarget = findInsertionTarget(sourceNode);
  } catch (e) {
    showMessage("Shape Scatter - Error", e.message || String(e));
    return;
  }

  const dlg = Dialog.create("Shape Scatter");
  dlg.initialWidth = 360;
  const col = dlg.addColumn();

  const opts = col.addGroup("Scatter Settings");

  let algoCtrl;
  try {
    algoCtrl = opts.addDropDownList(
      "Distribution Pattern",
      ["Random Area", "Grid Jitter", "Radial Burst"],
      0,
    );
  } catch (e) {
    algoCtrl = opts.addComboBox(
      "Distribution Pattern",
      ["Random Area", "Grid Jitter", "Radial Burst"],
      0,
    );
  }

  const countCtrl = opts.addUnitValueEditor(
    "Particle Count",
    UnitType.Number,
    UnitType.Number,
    DEFAULTS.particleCount,
    1,
    5000,
  );
  countCtrl.showPopupSlider = true;

  const minCtrl = opts.addUnitValueEditor(
    "Min Size (px)",
    UnitType.Pixel,
    UnitType.Pixel,
    DEFAULTS.minSize,
    1,
    1000,
  );
  minCtrl.showPopupSlider = true;
  const maxCtrl = opts.addUnitValueEditor(
    "Max Size (px)",
    UnitType.Pixel,
    UnitType.Pixel,
    DEFAULTS.maxSize,
    1,
    1000,
  );
  maxCtrl.showPopupSlider = true;

  const rotCtrl = opts.addUnitValueEditor(
    "Rotation Jitter (°)",
    UnitType.Number,
    UnitType.Number,
    DEFAULTS.rotationJitter,
    0,
    360,
  );
  rotCtrl.showPopupSlider = true;

  const preventOverlapCtrl = opts.addSwitch(
    "Prevent shape overlap",
    DEFAULTS.preventOverlap,
  );

  const thresholdCtrl = opts.addUnitValueEditor(
    "Overlap Threshold (px)",
    UnitType.Pixel,
    UnitType.Pixel,
    DEFAULTS.overlapThreshold,
    0,
    500,
  );
  thresholdCtrl.showPopupSlider = true;

  const hideCtrl = opts.addSwitch("Hide original shape", false);

  function readSettings() {
    return {
      algorithm:
        algoCtrl.selectedIndex !== undefined
          ? algoCtrl.selectedIndex
          : algoCtrl.value,
      particleCount: Math.max(1, countCtrl.value),
      minSize: Math.max(0.1, minCtrl.value),
      maxSize: Math.max(0.1, maxCtrl.value),
      rotationJitter: rotCtrl.value,
      preventOverlap: preventOverlapCtrl.value,
      overlapThreshold: thresholdCtrl.value,
      hideOriginal: hideCtrl.value,
    };
  }

  function updatePreview() {
    deletePreview();
    try {
      createOverlay(sourceNode, readSettings(), basePoly, insertionTarget);
      return true;
    } catch (e) {
      return false;
    }
  }

  // Bind real-time UI updates
  updatePreview();
  dlg.onControlValueChangedHandler = updatePreview;

  const result = dlg.show();
  if (result.value !== DialogResult.Ok.value) {
    deletePreview();
    return;
  }

  if (previewNodes.length === 0 && !updatePreview()) {
    showMessage("Shape Scatter - Error", "Could not generate overlay.");
  }

  if (readSettings().hideOriginal) {
    try {
      doc.executeCommand(
        DocumentCommand.createSetVisibility(sourceNode.selfSelection, false),
      );
    } catch (e) {}
  }

  // Keep particles committed on OK
  previewNodes = [];
}

run();
