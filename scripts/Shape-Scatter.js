/**
 * name: Shape Scatter
 * description: Instantly scatter perfect clones of any vector shape. Features auto-canvas detection, exact style preservation, dynamic size/rotation jitter, and overlap prevention across multiple patterns (Random, Grid, Burst). Real-time previews bake into a single, optimized node to keep your layers panel perfectly clean.
 * version: 1.2.0
 * author: hellsfaun
 *
 * 1.2.0 – Stroke scaling option:
 *  - "Proportional (per particle)": every particle becomes its own curve
 *    object with the stroke scaled by its size factor
 *    (LineStyleDescriptor.cloneScaled). The particles are collected in a
 *    layer "Shape Scatter Burst" (groups cannot be created via the SDK).
 *  - "Proportional (average, single object)": one object as before, stroke
 *    scaled by the average particle size factor.
 *  - "Fixed (original width)": previous behaviour.
 * 1.1.0 – Port to current Affinity SDK:
 *  - VectorNodeDefinition.setBrushFillDescriptor(fd, index) and
 *    setLineDescriptors(lineFill, lineStyle, index): index is now the LAST
 *    parameter. The old order silently produced particles with NoFill and
 *    no stroke (invisible result).
 *  - Stroke is copied via lineStyleInterface.getCurrentDescriptors() (keeps
 *    stroke alignment, pressure etc. instead of rebuilding from lineStyle).
 *  - Fill/stroke is read from the node the geometry came from (after
 *    conversion to curves), so text sources get their real glyph colour.
 *  - Text is always converted first: text nodes expose a curvesInterface,
 *    but it does not contain the glyph outlines. Conversion yields a group
 *    (one curve per letter) – all sub-curves are collected.
 *  - Dialog.show() (deprecated) -> runModal(); addDropDownList (no longer
 *    exists) -> addComboBox; unit editor values set explicitly.
 *  - Preview is only rebuilt when a setting actually changed (the dialog
 *    handler also fires on open / programmatic changes).
 *  - Min/Max size are swapped automatically if entered the wrong way round.
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
const { PolyCurveNodeDefinition, ContainerNodeDefinition } = require("/nodes");

const DEFAULTS = {
  particleCount: 100,
  minSize: 15,
  maxSize: 60,
  rotationJitter: 360,
  preventOverlap: false,
  overlapThreshold: 0,
  strokeMode: 2, // 0 fixed, 1 average (single object), 2 per particle
};

let previewNodes = [];
let lastSettingsKey = null;

function showMessage(title, message) {
  const dlg = Dialog.create(title);
  dlg.addColumn().addGroup("").addStaticText("", message);
  dlg.runModal();
}

function collectBeziers(curve) {
  const beziers = [];
  try {
    if (curve.isEmpty || curve.pointCount === 0) return beziers;
    for (const bez of curve.beziers) beziers.push(bez);
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

function isTextNode(node) {
  return /Text/.test(String(node[Symbol.toStringTag]));
}

// True if the node or any descendant is text. Text nodes expose a
// curvesInterface too, but it does NOT contain the glyph outlines (and
// their brushFill reads as NoFill) – they must be converted first.
function containsText(node) {
  if (isTextNode(node)) return true;
  try {
    const kids = node.children;
    if (kids) for (const k of kids) if (containsText(k)) return true;
  } catch (e) {}
  return false;
}

// Returns all descendant nodes (incl. the node itself) that carry curves.
function collectCurveNodes(node, out) {
  if (isTextNode(node)) return out;
  let hasCurves = false;
  try {
    hasCurves = !!(node.curvesInterface && node.curvesInterface.polyCurve);
  } catch (e) {}
  if (hasCurves) {
    out.push(node);
    return out;
  }
  try {
    const kids = node.children;
    if (kids) for (const k of kids) collectCurveNodes(k, out);
  } catch (e) {}
  return out;
}

// Reads the spread-space geometry plus fill/stroke from the source.
// Non-curve sources (text etc.) are duplicated, converted and removed again.
function readSource(sourceNode) {
  const doc = Document.current;
  let curveNodes = containsText(sourceNode)
    ? []
    : collectCurveNodes(sourceNode, []);
  let tempNode = null;

  if (curveNodes.length === 0) {
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
    doc.executeCommand(
      DocumentCommand.createConvertToCurves(Selection.create(doc, tempNode)),
    );
    tempNode = doc.selection.firstNode || tempNode;
    curveNodes = collectCurveNodes(tempNode, []);
  }

  if (curveNodes.length === 0) {
    if (tempNode) deleteNode(tempNode);
    throw new Error("Could not convert the selected object to curves.");
  }

  const poly = new PolyCurve();
  for (const cn of curveNodes) {
    const pc = cn.curvesInterface.polyCurve.clone();
    pc.transform(cn.baseToSpreadTransform);
    for (let i = 0; i < pc.curveCount; i++) poly.addCurve(pc.at(i));
  }

  // Styles from the first curve node (for text: the real glyph colour)
  const styleNode = curveNodes[0];
  let brushFill = null;
  let lineDescs = null;
  try {
    brushFill = styleNode.brushFillInterface.fillDescriptor;
  } catch (e) {}
  try {
    lineDescs = styleNode.lineStyleInterface.getCurrentDescriptors();
  } catch (e) {}

  if (tempNode) deleteNode(tempNode);

  return { poly, brushFill, lineDescs };
}

function deleteNode(node) {
  const doc = Document.current;
  try {
    doc.executeCommand(
      DocumentCommand.createDeleteSelection(Selection.create(doc, node), false),
    );
  } catch (e) {}
}

function generateParticles(basePoly, settings, bounds) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;

  // Pre-collect beziers once (also used for the bounds)
  const baseCurves = [];
  for (let i = 0; i < basePoly.curveCount; i++) {
    const curve = basePoly.at(i);
    const beziers = collectBeziers(curve);
    if (beziers.length === 0) continue;
    baseCurves.push({ beziers, isClosed: curve.isClosed });
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

  const particles = []; // { curves: Curve[], scale }

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

  for (let i = 0; i < settings.particleCount; i++) {
    let px, py, targetSize;
    let validSpot = false;
    const maxAttempts = 50;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const algo = settings.algorithm;
      if (algo === 1) {
        const col = i % gridCols;
        const row = Math.floor(i / gridCols);
        px = startX + col * cellW + Math.random() * cellW;
        py = startY + row * cellH + Math.random() * cellH;
      } else if (algo === 2) {
        const angle = Math.random() * Math.PI * 2;
        const burstRadius = (Math.random() * Math.min(areaW, areaH)) / 2;
        px = centerX + Math.cos(angle) * burstRadius;
        py = centerY + Math.sin(angle) * burstRadius;
      } else {
        px = startX + Math.random() * areaW;
        py = startY + Math.random() * areaH;
      }

      targetSize =
        settings.minSize +
        Math.random() * (settings.maxSize - settings.minSize);

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

    if (!validSpot) continue;

    placedParticles.push({ x: px, y: py, radius: targetSize / 2 });

    const scale = targetSize / baseDim;
    const rot = Math.random() * settings.rotationJitter * (Math.PI / 180);
    const cosA = Math.cos(rot);
    const sinA = Math.sin(rot);

    const transformPt = (p) => {
      const tx = p.x - cx;
      const ty = p.y - cy;
      return {
        x: (tx * cosA - ty * sinA) * scale + px,
        y: (tx * sinA + ty * cosA) * scale + py,
      };
    };

    const curves = [];
    for (const bc of baseCurves) {
      const bldr = CurveBuilder.create();
      bldr.begin(transformPt(bc.beziers[0].start));
      for (const bez of bc.beziers) {
        bldr.addBezier(
          transformPt(bez.c1),
          transformPt(bez.c2),
          transformPt(bez.end),
        );
      }
      if (bc.isClosed) bldr.close();
      curves.push(bldr.createCurve());
    }
    particles.push({ curves, scale });
  }

  return particles;
}

function deletePreview() {
  for (const node of previewNodes) deleteNode(node);
  previewNodes = [];
}

function createOverlay(source, settings, insertionTarget) {
  const doc = Document.current;
  const poly = source.poly;

  if (poly.curveCount === 0) {
    throw new Error("No curves were found on the selected object.");
  }

  // Auto-detect artboard/canvas bounds
  let targetBox = { x: 0, y: 0, width: 2000, height: 2000 };
  try {
    const box = insertionTarget.getSpreadBaseBox(false);
    if (box && box.width > 0 && box.height > 0) targetBox = box;
  } catch (e) {}

  const particles = generateParticles(poly, settings, targetBox);
  if (particles.length === 0) throw new Error("No particles could be placed.");

  // Builds one curve node; strokeScale = factor for the stroke width
  const makeDef = (polyCurve, strokeScale, name) => {
    const def = PolyCurveNodeDefinition.createDefault();
    def.setCurves(polyCurve);
    // Current SDK: (descriptor, index) – index LAST
    if (source.brushFill) {
      try {
        def.setBrushFillDescriptor(source.brushFill, 0);
      } catch (e) {
        console.log("Fill transfer failed: " + e.message);
      }
    }
    // Current SDK: (lineFill, lineStyle, index) – index LAST
    if (source.lineDescs) {
      try {
        const ls = Math.abs(strokeScale - 1) > 1e-6
          ? source.lineDescs.lineStyle.cloneScaled(strokeScale)
          : source.lineDescs.lineStyle;
        def.setLineDescriptors(source.lineDescs.fill, ls, 0);
      } catch (e) {
        console.log("Stroke transfer failed: " + e.message);
      }
    }
    def.userDescription = name;
    return def;
  };

  if (settings.strokeMode === 2) {
    // One object per particle, collected in a layer
    const cb = AddChildNodesCommandBuilder.create();
    cb.setInsertionTarget(insertionTarget);
    cb.addContainerNode(ContainerNodeDefinition.create("Shape Scatter Burst"));
    const cCmd = cb.createCommand(false, NodeChildType.Main);
    doc.executeCommand(cCmd);
    const container = cCmd.newNodes && cCmd.newNodes[0];
    if (!container) throw new Error("Could not create the result layer.");
    previewNodes = [container];

    const builder = AddChildNodesCommandBuilder.create();
    builder.setInsertionTarget(container);
    particles.forEach((p, i) => {
      const pc = new PolyCurve();
      for (const c of p.curves) pc.addCurve(c);
      builder.addNode(makeDef(pc, p.scale, "Particle " + (i + 1)));
    });
    doc.executeCommand(builder.createCommand(true, NodeChildType.Main));
    return;
  }

  // Single object holding all curves
  const allPoly = new PolyCurve();
  let scaleSum = 0;
  for (const p of particles) {
    for (const c of p.curves) allPoly.addCurve(c);
    scaleSum += p.scale;
  }
  const strokeScale = settings.strokeMode === 1 ? scaleSum / particles.length : 1;

  const builder = AddChildNodesCommandBuilder.create();
  builder.setInsertionTarget(insertionTarget);
  builder.addNode(makeDef(allPoly, strokeScale, "Shape Scatter Burst"));
  const cmd = builder.createCommand(true, NodeChildType.Main);
  doc.executeCommand(cmd);
  previewNodes = cmd.newNodes ? [...cmd.newNodes] : [];
}

function run() {
  const doc = Document.current;
  if (!doc) return;
  const sel = doc.selection;

  if (!sel || sel.length === 0) {
    showMessage(
      "Shape Scatter",
      "No object selected. Please select a path or shape to scatter.",
    );
    return;
  }

  const sourceNode = sel.firstNode;
  let source;
  let insertionTarget;
  try {
    insertionTarget = findInsertionTarget(sourceNode);
    source = readSource(sourceNode);
  } catch (e) {
    showMessage("Shape Scatter - Error", e.message || String(e));
    return;
  }

  const dlg = Dialog.create("Shape Scatter");
  dlg.initialWidth = 360;
  const opts = dlg.addColumn().addGroup("Scatter Settings");

  const algoCtrl = opts.addComboBox(
    "Distribution Pattern",
    ["Random Area", "Grid Jitter", "Radial Burst"],
    0,
  );
  algoCtrl.selectedIndex = 0;

  function addEditor(label, units, value, min, max) {
    const ed = opts.addUnitValueEditor(label, units, units, value, min, max);
    ed.value = value; // initial value is not reliably taken over
    ed.showPopupSlider = true;
    return ed;
  }

  const countCtrl = addEditor("Particle Count", UnitType.Number, DEFAULTS.particleCount, 1, 5000);
  const minCtrl = addEditor("Min Size (px)", UnitType.Pixel, DEFAULTS.minSize, 1, 1000);
  const maxCtrl = addEditor("Max Size (px)", UnitType.Pixel, DEFAULTS.maxSize, 1, 1000);
  const rotCtrl = addEditor("Rotation Jitter (°)", UnitType.Number, DEFAULTS.rotationJitter, 0, 360);

  const preventOverlapCtrl = opts.addSwitch("Prevent shape overlap", DEFAULTS.preventOverlap);
  preventOverlapCtrl.value = DEFAULTS.preventOverlap;

  const thresholdCtrl = addEditor("Overlap Threshold (px)", UnitType.Pixel, DEFAULTS.overlapThreshold, 0, 500);

  const strokeCtrl = opts.addComboBox(
    "Stroke width",
    [
      "Fixed (original width)",
      "Proportional (average, single object)",
      "Proportional (per particle)",
    ],
    DEFAULTS.strokeMode,
  );
  strokeCtrl.selectedIndex = DEFAULTS.strokeMode;

  const hideCtrl = opts.addSwitch("Hide original shape", false);
  hideCtrl.value = false;

  function readSettings() {
    let a = Math.max(0.1, Number(minCtrl.value));
    let b = Math.max(0.1, Number(maxCtrl.value));
    if (a > b) [a, b] = [b, a];
    return {
      algorithm: Number(algoCtrl.selectedIndex) || 0,
      particleCount: Math.max(1, Math.round(Number(countCtrl.value))),
      minSize: a,
      maxSize: b,
      rotationJitter: Number(rotCtrl.value),
      preventOverlap: !!preventOverlapCtrl.value,
      overlapThreshold: Number(thresholdCtrl.value),
      strokeMode: Number(strokeCtrl.selectedIndex) || 0,
      hideOriginal: !!hideCtrl.value,
    };
  }

  function updatePreview(force) {
    const s = readSettings();
    // "Hide original" does not affect the particles
    const key = JSON.stringify(Object.assign({}, s, { hideOriginal: null }));
    if (!force && key === lastSettingsKey && previewNodes.length > 0) return true;
    deletePreview();
    try {
      createOverlay(source, s, insertionTarget);
      lastSettingsKey = key;
      return true;
    } catch (e) {
      console.log("Preview failed: " + (e.message || e));
      lastSettingsKey = null;
      return false;
    }
  }

  updatePreview(true);
  dlg.onControlValueChangedHandler = () => updatePreview(false);

  const result = dlg.runModal();
  if (result.value !== DialogResult.Ok.value) {
    deletePreview();
    return;
  }

  if (previewNodes.length === 0 && !updatePreview(true)) {
    showMessage("Shape Scatter - Error", "Could not generate overlay.");
    return;
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
