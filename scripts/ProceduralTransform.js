"use strict";

// =============================================================================
// PROCEDURAL TRANSFORM v3.5 (Oriented Procedural Vector Transform Engine)
// Affinity Designer / Photo / Publisher (v3c+ Pipeline & Multi-Effect Standard)
//
// Features:
// - Full Procedural Container Architecture & In-Place Re-Editing (v3c+ standard):
//   • Non-destructive: Re-run script anytime on existing effect group or child to re-open dialog with previous parameters.
//   • Object-Space Oriented Transforms: Modifying Width (w) and Height (h) scales along the object's
//     natural local axes even when moved, rotated, skewed, or resized on canvas (Zero diagonal distortion).
//   • 2D Principal Axis Projection Sorting: Auto Visual Flow automatically sorts objects along
//     the true progression trajectory (horizontal, vertical, diagonal, or curved).
//   • Hidden pristine Source shapes preserved inside the container.
//   • Evaluated Result shapes marked with Red Tag #FF0000 for 1-click baking via Expand Effects.
//   • Full JSON parameter serialization in tagInterface ("proceduralTransformSettings" & "effectPipeline").
//   • Style synchronization: Canvas color/stroke edits to results propagate to sources.
// - Standard Procedural Effect Workflow Notification (Zig Zag Standard):
//   • "✨ Non-destructive Procedural Effect ✨"
//   • "Run this script again on the container to edit parameters, or run other effect scripts to stack effects."
// - 3-Button Vertical Alignment Anchor Set: Top, Center, Bottom (Default: Center).
// - Motion-Software Parametric Curve Control for EACH parameter (s, w, h, r):
//   • Mode 0: Continuous Power / Bias Curve (Curvature & Bias sliders)
//   • Mode 1: Smooth S-Curve / Sigmoid (Steepness & Midpoint Inflection sliders)
//   • Mode 2: Bell Curve (Peak Shift & Width / Sharpness sliders)
//   • Mode 3: Cubic Bezier (Ease In & Ease Out Influence sliders)
//   • Mode 4: Linear
// - Full Continuous Slider Parameters: Curvature (-100% to +100%) and Midpoint/Bias (0% to 100%).
// - Default End Rotation is 0° (Start: 0°, End: 0°).
// - Non-destructive, real-time debounced Live Preview on canvas (80ms).
// - Reverse progression switch (0→1 vs 1→0).
// - Spread-space coordinate accuracy with zero origin drift.
// - Atomic 1-step undo via CompoundCommandBuilder.
// - Symbol node safety detection.
// =============================================================================

const { Document } = require("/document");
const {
  DocumentCommand,
  AddChildNodesCommandBuilder,
  CompoundCommandBuilder,
  InsertionMode,
  NodeChildType,
  NodeMoveType
} = require("/commands");
const { PolyCurve, Transform } = require("/geometry");
const { ContainerNodeDefinition, PolyCurveNodeDefinition } = require("/nodes");
const { Dialog, DialogResult, HorizontalAlignment } = require("/dialog");
const { Selection } = require("/selections");
const { UnitType } = require("/units");
const { RGB8 } = require("/colours");
const { FillDescriptor, BlendMode } = require("/fills");
const { LineStyleDescriptor } = require("/linestyle");
const { setTimeout } = require("/timers");

// =============================================================================
// CONSTANTS & REGISTRY
// =============================================================================

const SCRIPT_TITLE = "Procedural Transform v3.5";
const TAG_KEY = "proceduralTransformSettings";
const LEGACY_TAG_KEY = "progressiveTransformSettings";
const GROUP_PREFIX = "Procedural Transform Effect";
const LEGACY_GROUP_PREFIX = "Progressive Transform Effect";
const SOURCE_PREFIX = "Source";
const RESULT_PREFIX = "Procedural Item";

const CURVE_MODES = [
  "Power / Bias Curve",
  "Smooth S-Curve (Sigmoid)",
  "Bell Curve (Peak)",
  "Cubic Bezier (In/Out)",
  "Linear"
];

const DEFAULT_VALUES = {
  startScale: 1.0,        // 100% (s)
  endScale: 1.0,          // 100% (s)
  scaleCurveMode: 0,      // 0: Power/Bias
  scaleCurvature: 0,      // -100% to +100% (0 = Linear)
  scaleMidpoint: 50,      // 0% to 100% (50 = Center)

  startWidth: 1.0,        // 100% (w)
  endWidth: 1.0,          // 100% (w)
  widthCurveMode: 0,
  widthCurvature: 0,
  widthMidpoint: 50,

  startHeight: 1.0,       // 100% (h)
  endHeight: 1.0,         // 100% (h)
  heightCurveMode: 0,
  heightCurvature: 0,
  heightMidpoint: 50,

  startRotation: 0,       // 0 deg (r)
  endRotation: 0,         // 0 deg (r)
  rotCurveMode: 0,
  rotCurvature: 0,
  rotMidpoint: 50,

  vAlign: 1,              // 0: Top, 1: Center (Default), 2: Bottom
  sortMode: 0,            // 0: Auto (Visual Flow), 1: Left→Right, 2: Top→Bottom, 3: Selection Order
  reverseOrder: false
};

const doc = Document.current;

// =============================================================================
// DOM, TAGS & CONTAINER DETECTION HELPERS
// =============================================================================

const mkSel = n => Selection.create(doc, n, true);

function getNodeName(node) {
  try { return node.userDescription || node.name || ""; } catch (e) { return ""; }
}

function getChildren(node) {
  if (!node) return [];
  const children = [];
  let child = null;
  try { child = node.firstChild; } catch (e) { child = null; }
  while (child) {
    children.push(child);
    try { child = child.nextSibling; } catch (e) { child = null; }
  }
  return children;
}

function getSourceIndex(node) {
  const name = getNodeName(node);
  const m = name.match(/Source\s+(\d+)/i);
  return m ? parseInt(m[1], 10) : 99999;
}

function getResultIndex(node) {
  const name = getNodeName(node);
  const m = name.match(/(?:Procedural Item|Progressive Item|Result)\s+(\d+)/i);
  return m ? parseInt(m[1], 10) : 99999;
}

function isSymbolNode(node) {
  if (!node) return false;
  try {
    if (node.isSymbol || node.isSymbolNode || node.isSymbolInstance) return true;
  } catch (e) {}
  try {
    if (node.type && /symbol/i.test(String(node.type))) return true;
  } catch (e) {}
  try {
    if (node.typeName && /symbol/i.test(String(node.typeName))) return true;
  } catch (e) {}
  try {
    if (node.constructor && node.constructor.name && /symbol/i.test(node.constructor.name)) return true;
  } catch (e) {}
  try {
    const name = getNodeName(node);
    if (/\(symbol\)/i.test(name) || /^symbol\b/i.test(name)) return true;
  } catch (e) {}
  try {
    const children = getChildren(node);
    for (const child of children) {
      if (isSymbolNode(child)) return true;
    }
  } catch (e) {}
  return false;
}

function isRedTagColour(colour) {
  if (!colour) return false;
  try {
    const rgba = colour.rgba8 || (colour.getRGBA8 ? colour.getRGBA8() : null);
    if (!rgba) return false;
    const r = rgba.r !== undefined ? rgba.r : rgba.red;
    const g = rgba.g !== undefined ? rgba.green : rgba.green;
    const b = rgba.b !== undefined ? rgba.blue : rgba.blue;
    if (r === undefined || g === undefined || b === undefined) return false;
    if (r === 255 && g === 0 && b === 0) return true;
    if (r >= 180 && g <= 100 && b <= 100 && (r - Math.max(g, b) >= 80)) return true;
    return false;
  } catch (e) {
    return false;
  }
}

function hasRedTag(node) {
  if (!node) return false;
  try { if (node.tagColour && isRedTagColour(node.tagColour)) return true; } catch (e) {}
  try { if (node.layerColour && isRedTagColour(node.layerColour)) return true; } catch (e) {}
  return false;
}

function isResultNode(node) {
  if (!node) return false;
  if (hasRedTag(node)) return true;
  const name = getNodeName(node);
  return name.indexOf(RESULT_PREFIX) === 0 || name.indexOf("Progressive Item") === 0 || name.indexOf("Result") === 0;
}

function isSourceNode(node) {
  if (!node) return false;
  if (isResultNode(node)) return false;
  const name = getNodeName(node);
  return name.indexOf(SOURCE_PREFIX) === 0;
}

function isProceduralTransformGroup(node) {
  if (!node) return false;
  try {
    if (node.tagInterface) {
      if (node.tagInterface.hasKey(TAG_KEY)) return true;
      if (node.tagInterface.hasKey(LEGACY_TAG_KEY)) return true;
      if (node.tagInterface.hasKey("proceduralTransform")) return true;
      if (node.tagInterface.hasKey("progressiveTransform")) return true;
      if (node.tagInterface.hasKey("effectPipeline")) {
        const json = node.tagInterface.getValueForKey("effectPipeline");
        if (json && (json.indexOf("procedural_transform") >= 0 || json.indexOf("progressive_transform") >= 0)) return true;
      }
    }
  } catch (e) {}
  const name = getNodeName(node);
  if (name === GROUP_PREFIX || name.indexOf(GROUP_PREFIX) === 0 || name === LEGACY_GROUP_PREFIX || name.indexOf(LEGACY_GROUP_PREFIX) === 0 || name.indexOf("Procedural Transform") === 0 || name.indexOf("Progressive Transform") === 0) return true;
  const children = getChildren(node);
  const hasSource = children.some(c => getNodeName(c).indexOf(SOURCE_PREFIX) === 0);
  const hasResult = children.some(c => hasRedTag(c) || getNodeName(c).indexOf(RESULT_PREFIX) === 0 || getNodeName(c).indexOf("Progressive Item") === 0);
  return hasSource && hasResult;
}

function getProceduralTransformGroupOf(node) {
  let current = node;
  while (current) {
    if (isProceduralTransformGroup(current)) return current;
    try { current = current.parent; } catch (e) { break; }
  }
  return null;
}

function clamp(value, minValue, maxValue) {
  return Math.max(minValue, Math.min(maxValue, value));
}

function degToRad(value) {
  return (value * Math.PI) / 180;
}

function validBB(b) {
  return b && isFinite(b.x) && isFinite(b.y) && isFinite(b.width) && isFinite(b.height) && (b.width > 0 || b.height > 0);
}

function getNodeOrientationAngle(node) {
  if (!node) return 0;
  try {
    const b2s = node.baseToSpreadTransform || (node.transformInterface ? node.transformInterface.transform : null);
    if (b2s) {
      const a = b2s.a !== undefined ? b2s.a : b2s.data ? b2s.data[0] : 1;
      const c = b2s.c !== undefined ? b2s.c : b2s.data ? b2s.data[3] : 0;
      return Math.atan2(c, a);
    }
  } catch (e) {}
  return 0;
}

/**
 * Clones polyCurve directly into Spread Space for 100% canvas accuracy.
 */
function clonePolyCurveToSpread(node) {
  if (!node) return null;
  try {
    if (node.curvesInterface && node.curvesInterface.polyCurve) {
      const pc = node.curvesInterface.polyCurve.clone();
      const xf = node.baseToSpreadTransform || (node.transformInterface ? node.transformInterface.transform : null);
      if (xf) {
        try { pc.transform(xf); } catch (e) {}
      }
      return pc;
    }
  } catch (e) {}
  return null;
}

function getNodeStyle(node) {
  const defaultStyle = {
    brushFill: FillDescriptor.createNone(),
    lineStyle: LineStyleDescriptor.createDefault(0),
    lineFill: FillDescriptor.createNone(),
    transparencyFill: FillDescriptor.createNone(),
    opacity: 1.0,
    blendMode: null,
    hasStroke: false
  };

  if (!node) return defaultStyle;

  let brushFill = FillDescriptor.createNone();
  let lineStyle = LineStyleDescriptor.createDefault(0);
  let lineFill = FillDescriptor.createNone();
  let transparencyFill = FillDescriptor.createNone();
  let hasStroke = false;
  let opacity = 1.0;
  let blendMode = null;

  try {
    if (node.visibilityInterface && typeof node.visibilityInterface.globalOpacity === "number") {
      opacity = node.visibilityInterface.globalOpacity;
    }
  } catch (e) {}

  try {
    if (node.blendModeInterface && node.blendModeInterface.blendMode) {
      blendMode = node.blendModeInterface.blendMode;
    } else if (node.blendMode) {
      blendMode = node.blendMode;
    }
  } catch (e) {}

  try {
    if (node.lineStyleInterface) {
      const lsi = node.lineStyleInterface;
      const isNoFill = lsi.isNoFill;
      const isVisible = (typeof lsi.isLineStyleVisible === "boolean") ? lsi.isLineStyleVisible : true;
      const lsDesc = lsi.lineStyleDescriptor;
      const penFill = lsi.penFillDescriptor;
      const weight = (lsDesc && lsDesc.lineStyle && typeof lsDesc.lineStyle.weight === "number")
        ? lsDesc.lineStyle.weight
        : (typeof lsi.lineWeight === "number" ? lsi.lineWeight : 0);

      if (isVisible && !isNoFill && weight > 0 && penFill && !penFill.isNoFill) {
        hasStroke = true;
        lineFill = penFill.clone();
        lineStyle = lsDesc ? lsDesc.clone() : LineStyleDescriptor.createDefault(weight);
      }
    }
  } catch (e) {}

  try {
    if (node.brushFillInterface && !node.brushFillInterface.isNoFill && node.brushFillInterface.currentDescriptor) {
      brushFill = node.brushFillInterface.currentDescriptor.clone();
    }
  } catch (e) {}

  try {
    if (node.transparencyInterface && !node.transparencyInterface.isTransparencyNone && node.transparencyInterface.fillDescriptor) {
      transparencyFill = node.transparencyInterface.fillDescriptor.clone();
    }
  } catch (e) {}

  return {
    brushFill,
    lineStyle,
    lineFill,
    transparencyFill,
    hasStroke,
    opacity,
    blendMode
  };
}

function applyStyleToLeafNode(document, node, style) {
  if (!node || !style) return;
  const sel = Selection.create(document, node, true);
  const cb = CompoundCommandBuilder.create();

  if (style.brushFill && !style.brushFill.isNoFill) {
    cb.addCommand(DocumentCommand.createSetBrushFill(sel, style.brushFill), false);
  }

  if (style.hasStroke && style.lineFill && !style.lineFill.isNoFill && style.lineStyle) {
    cb.addCommand(DocumentCommand.createSetLineStyleDescriptor(sel, style.lineStyle), false);
    cb.addCommand(DocumentCommand.createSetPenFill(sel, style.lineFill), false);
  }

  if (style.transparencyFill && !style.transparencyFill.isNoFill) {
    cb.addCommand(DocumentCommand.createSetTransparencyFill(sel, style.transparencyFill), false);
  }

  if (typeof style.opacity === "number" && style.opacity >= 0 && style.opacity <= 1.0) {
    cb.addCommand(DocumentCommand.createSetOpacity(sel, style.opacity), false);
  }

  if (style.blendMode) {
    cb.addCommand(DocumentCommand.createSetBlendMode(sel, style.blendMode), false);
  }

  const cmd = cb.createCommand();
  if (cmd) {
    document.executeCommand(cmd, false);
  }
}

function syncRecursiveStyles(document, sNode, rNode) {
  if (!sNode || !rNode) return;

  const sChildren = getChildren(sNode);
  const rChildren = getChildren(rNode);

  if (sChildren.length > 0 && rChildren.length > 0) {
    for (let i = 0; i < sChildren.length; i++) {
      const sChild = sChildren[i];
      const rChild = rChildren[i] || rChildren[0];
      syncRecursiveStyles(document, sChild, rChild);
    }
    try {
      if (rNode.visibilityInterface && typeof rNode.visibilityInterface.globalOpacity === "number") {
        const op = rNode.visibilityInterface.globalOpacity;
        if (op < 0.999) {
          document.executeCommand(DocumentCommand.createSetOpacity(Selection.create(document, sNode, true), op), false);
        }
      }
      const bm = (rNode.blendModeInterface && rNode.blendModeInterface.blendMode) || rNode.blendMode;
      if (bm) {
        document.executeCommand(DocumentCommand.createSetBlendMode(Selection.create(document, sNode, true), bm), false);
      }
    } catch (e) {}
    return;
  }

  const rStyle = getNodeStyle(rNode);
  applyStyleToLeafNode(document, sNode, rStyle);
}

function syncSourceStylesFromResults(document, existingGroup, sourceNodes, resultNodes) {
  if (!existingGroup || !sourceNodes || !sourceNodes.length) return;

  for (let i = 0; i < sourceNodes.length; i++) {
    const sNode = sourceNodes[i];
    const rNode = (resultNodes && resultNodes.length > i) ? resultNodes[i] : (resultNodes && resultNodes[0]);
    if (sNode && rNode) {
      try {
        syncRecursiveStyles(document, sNode, rNode);
      } catch (e) {}
    }
  }
}

function applyOpacityAndBlendToFillDescriptor(fillDesc, opacity, targetBlendMode) {
  if (!fillDesc || fillDesc.isNoFill) return FillDescriptor.createNone();
  try {
    const typedFill = fillDesc.fill;
    if (typedFill) {
      const clonedFill = typedFill.clone();
      if (typeof opacity === "number" && opacity < 0.999 && opacity >= 0) {
        const currentAlpha = (typeof clonedFill.alpha === "number") ? clonedFill.alpha : 1.0;
        clonedFill.alpha = Math.max(0, Math.min(1, currentAlpha * opacity));
      }
      const finalBlendMode = targetBlendMode || fillDesc.blendMode || BlendMode.Normal;
      return FillDescriptor.create(
        clonedFill,
        fillDesc.isScaleWithObject,
        fillDesc.transform,
        finalBlendMode,
        fillDesc.isAnchoredToSpread
      );
    }
  } catch (e) {}
  return fillDesc;
}

function extractGeomEntriesFromNode(node) {
  const entries = [];
  if (!node) return entries;

  const children = getChildren(node);
  if (children.length > 0) {
    for (const child of children) {
      const subEntries = extractGeomEntriesFromNode(child);
      for (const entry of subEntries) entries.push(entry);
    }
    if (entries.length > 0) return entries;
  }

  const singlePc = clonePolyCurveToSpread(node);
  if (singlePc) {
    entries.push({ polyCurve: singlePc, style: getNodeStyle(node) });
    return entries;
  }

  return entries;
}

function getEntriesBounds(entries) {
  if (!entries || !entries.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, found = false;
  for (const entry of entries) {
    if (entry && entry.polyCurve) {
      let pb = null;
      try { pb = entry.polyCurve.exactBoundingBox || entry.polyCurve.boundingBox || entry.polyCurve.bounds; } catch (e) {}
      if (!pb) {
        try { pb = entry.polyCurve.getExactBoundingBox ? entry.polyCurve.getExactBoundingBox() : entry.polyCurve.getBoundingBox(); } catch (e) {}
      }
      if (validBB(pb)) {
        x0 = Math.min(x0, pb.x);
        y0 = Math.min(y0, pb.y);
        x1 = Math.max(x1, pb.x + pb.width);
        y1 = Math.max(y1, pb.y + pb.height);
        found = true;
      }
    }
  }
  if (found && isFinite(x0) && isFinite(y0)) {
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0, center: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 } };
  }
  return null;
}

// =============================================================================
// SPATIAL SORTING ENGINE (Principal Trajectory Projection / Visual Flow)
// =============================================================================

function sortSourceItems(items, sortMode) {
  if (!items || items.length <= 1) return items.slice();

  const withCenter = items.map(item => {
    const cx = item.box.x + item.box.width * 0.5;
    const cy = item.box.y + item.box.height * 0.5;
    return { item, cx, cy };
  });

  if (sortMode === 3) {
    // Selection / Layer Order (original order)
    return items.slice();
  }

  if (sortMode === 1) {
    // Left -> Right (Canvas X)
    withCenter.sort((a, b) => (Math.abs(a.cx - b.cx) > 0.001 ? a.cx - b.cx : a.cy - b.cy));
    return withCenter.map(w => w.item);
  }

  if (sortMode === 2) {
    // Top -> Bottom (Canvas Y)
    withCenter.sort((a, b) => (Math.abs(a.cy - b.cy) > 0.001 ? a.cy - b.cy : a.cx - b.cx));
    return withCenter.map(w => w.item);
  }

  // sortMode === 0: Auto (Principal Progression Trajectory Projection)
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const w of withCenter) {
    minX = Math.min(minX, w.cx);
    maxX = Math.max(maxX, w.cx);
    minY = Math.min(minY, w.cy);
    maxY = Math.max(maxY, w.cy);
  }
  const dirX = maxX - minX;
  const dirY = maxY - minY;
  const len = Math.sqrt(dirX * dirX + dirY * dirY);

  if (len > 0.001) {
    const nx = dirX / len;
    const ny = dirY / len;
    withCenter.sort((a, b) => {
      const projA = a.cx * nx + a.cy * ny;
      const projB = b.cx * nx + b.cy * ny;
      return projA - projB;
    });
  } else {
    withCenter.sort((a, b) => (Math.abs(a.cx - b.cx) > 0.001 ? a.cx - b.cx : a.cy - b.cy));
  }

  return withCenter.map(w => w.item);
}

// =============================================================================
// PARAMETRIC MOTION CURVE MATH (Continuous Curvature & Bias Evaluation)
// =============================================================================

function evaluateCubicBezier(t, x1, y1, x2, y2) {
  let s = t;
  for (let iter = 8; iter > 0; iter--) {
    const currentX = 3 * Math.pow(1 - s, 2) * s * x1 + 3 * (1 - s) * Math.pow(s, 2) * x2 + Math.pow(s, 3);
    const dx = 3 * Math.pow(1 - s, 2) * x1 + 6 * (1 - s) * s * (x2 - x1) + 3 * Math.pow(s, 2) * (1 - x2);
    if (Math.abs(dx) < 1e-6) break;
    const diff = currentX - t;
    if (Math.abs(diff) < 1e-5) break;
    s -= diff / dx;
    s = clamp(s, 0, 1);
  }
  return 3 * Math.pow(1 - s, 2) * s * y1 + 3 * (1 - s) * Math.pow(s, 2) * y2 + Math.pow(s, 3);
}

function evaluateParametricCurve(u, mode, curvature, midpoint) {
  const x = clamp(u, 0, 1);
  const mid = clamp(midpoint, 1, 99) / 100;

  if (mode === 4 || (curvature === 0 && mode === 0 && midpoint === 50)) {
    return x;
  }

  // 1. Mode 0: Continuous Power & Bias
  if (mode === 0) {
    let power = 1.0;
    if (curvature > 0) {
      power = 1.0 + (curvature / 100) * 4.0;
    } else if (curvature < 0) {
      power = 1.0 / (1.0 + (-curvature / 100) * 4.0);
    }

    let biased = x;
    if (Math.abs(mid - 0.5) > 0.001) {
      biased = x / ((1.0 / mid - 2.0) * (1.0 - x) + 1.0);
    }

    return Math.pow(clamp(biased, 0, 1), power);
  }

  // 2. Mode 1: Smooth S-Curve (Sigmoid Gain)
  if (mode === 1) {
    const k = clamp(1.0 + (curvature / 100) * 4.0, 0.2, 8.0);
    const m = mid;
    if (x < m) {
      return 0.5 * Math.pow(x / m, k);
    } else {
      return 1.0 - 0.5 * Math.pow((1.0 - x) / (1.0 - m), k);
    }
  }

  // 3. Mode 2: Parametric Bell Curve (Peak at midpoint)
  if (mode === 2) {
    const peak = mid;
    const spread = Math.max(0.1, 1.0 - (curvature / 100) * 0.7);
    const dist = (x - peak) / spread;
    const val = Math.exp(-dist * dist * 4);
    return clamp(val, 0, 1);
  }

  // 4. Mode 3: Cubic Bezier (After Effects Keyframe Influence)
  if (mode === 3) {
    const easeIn = clamp(midpoint / 100, 0, 1);
    const easeOut = clamp((curvature + 100) / 200, 0, 1);
    return evaluateCubicBezier(x, easeOut, 0, 1 - easeIn, 1);
  }

  return x;
}

function sanitizeValues(p) {
  const sort = (p && typeof p.sortMode === "number" && !isNaN(p.sortMode)) ? clamp(Math.round(p.sortMode), 0, 3) : DEFAULT_VALUES.sortMode;
  const align = (p && typeof p.vAlign === "number" && !isNaN(p.vAlign)) ? clamp(Math.round(p.vAlign), 0, 2) : DEFAULT_VALUES.vAlign;

  const sMode = (p && typeof p.scaleCurveMode === "number" && !isNaN(p.scaleCurveMode)) ? clamp(Math.round(p.scaleCurveMode), 0, CURVE_MODES.length - 1) : DEFAULT_VALUES.scaleCurveMode;
  const sCurv = (p && typeof p.scaleCurvature === "number" && !isNaN(p.scaleCurvature)) ? clamp(p.scaleCurvature, -100, 100) : DEFAULT_VALUES.scaleCurvature;
  const sMid = (p && typeof p.scaleMidpoint === "number" && !isNaN(p.scaleMidpoint)) ? clamp(p.scaleMidpoint, 0, 100) : DEFAULT_VALUES.scaleMidpoint;

  const wMode = (p && typeof p.widthCurveMode === "number" && !isNaN(p.widthCurveMode)) ? clamp(Math.round(p.widthCurveMode), 0, CURVE_MODES.length - 1) : DEFAULT_VALUES.widthCurveMode;
  const wCurv = (p && typeof p.widthCurvature === "number" && !isNaN(p.widthCurvature)) ? clamp(p.widthCurvature, -100, 100) : DEFAULT_VALUES.widthCurvature;
  const wMid = (p && typeof p.widthMidpoint === "number" && !isNaN(p.widthMidpoint)) ? clamp(p.widthMidpoint, 0, 100) : DEFAULT_VALUES.widthMidpoint;

  const hMode = (p && typeof p.heightCurveMode === "number" && !isNaN(p.heightCurveMode)) ? clamp(Math.round(p.heightCurveMode), 0, CURVE_MODES.length - 1) : DEFAULT_VALUES.heightCurveMode;
  const hCurv = (p && typeof p.heightCurvature === "number" && !isNaN(p.heightCurvature)) ? clamp(p.heightCurvature, -100, 100) : DEFAULT_VALUES.heightCurvature;
  const hMid = (p && typeof p.heightMidpoint === "number" && !isNaN(p.heightMidpoint)) ? clamp(p.heightMidpoint, 0, 100) : DEFAULT_VALUES.heightMidpoint;

  const rMode = (p && typeof p.rotCurveMode === "number" && !isNaN(p.rotCurveMode)) ? clamp(Math.round(p.rotCurveMode), 0, CURVE_MODES.length - 1) : DEFAULT_VALUES.rotCurveMode;
  const rCurv = (p && typeof p.rotCurvature === "number" && !isNaN(p.rotCurvature)) ? clamp(p.rotCurvature, -100, 100) : DEFAULT_VALUES.rotCurvature;
  const rMid = (p && typeof p.rotMidpoint === "number" && !isNaN(p.rotMidpoint)) ? clamp(p.rotMidpoint, 0, 100) : DEFAULT_VALUES.rotMidpoint;

  return {
    startScale: (p && typeof p.startScale === "number" && !isNaN(p.startScale)) ? Math.max(0.001, p.startScale) : DEFAULT_VALUES.startScale,
    endScale: (p && typeof p.endScale === "number" && !isNaN(p.endScale)) ? Math.max(0.001, p.endScale) : DEFAULT_VALUES.endScale,
    scaleCurveMode: sMode,
    scaleCurvature: sCurv,
    scaleMidpoint: sMid,

    startWidth: (p && typeof p.startWidth === "number" && !isNaN(p.startWidth)) ? Math.max(0.001, p.startWidth) : DEFAULT_VALUES.startWidth,
    endWidth: (p && typeof p.endWidth === "number" && !isNaN(p.endWidth)) ? Math.max(0.001, p.endWidth) : DEFAULT_VALUES.endWidth,
    widthCurveMode: wMode,
    widthCurvature: wCurv,
    widthMidpoint: wMid,

    startHeight: (p && typeof p.startHeight === "number" && !isNaN(p.startHeight)) ? Math.max(0.001, p.startHeight) : DEFAULT_VALUES.startHeight,
    endHeight: (p && typeof p.endHeight === "number" && !isNaN(p.endHeight)) ? Math.max(0.001, p.endHeight) : DEFAULT_VALUES.endHeight,
    heightCurveMode: hMode,
    heightCurvature: hCurv,
    heightMidpoint: hMid,

    startRotation: (p && typeof p.startRotation === "number" && !isNaN(p.startRotation)) ? clamp(p.startRotation, -3600, 3600) : DEFAULT_VALUES.startRotation,
    endRotation: (p && typeof p.endRotation === "number" && !isNaN(p.endRotation)) ? clamp(p.endRotation, -3600, 3600) : DEFAULT_VALUES.endRotation,
    rotCurveMode: rMode,
    rotCurvature: rCurv,
    rotMidpoint: rMid,

    vAlign: align,
    sortMode: sort,
    reverseOrder: (p && p.reverseOrder !== undefined) ? !!p.reverseOrder : DEFAULT_VALUES.reverseOrder
  };
}

function readGroupValues(group) {
  if (!group) return sanitizeValues(DEFAULT_VALUES);

  try {
    if (group.tagInterface && group.tagInterface.hasKey(TAG_KEY)) {
      const json = group.tagInterface.getValueForKey(TAG_KEY);
      if (json) return sanitizeValues(JSON.parse(json));
    }
  } catch (e) {}

  try {
    if (group.tagInterface && group.tagInterface.hasKey(LEGACY_TAG_KEY)) {
      const json = group.tagInterface.getValueForKey(LEGACY_TAG_KEY);
      if (json) return sanitizeValues(JSON.parse(json));
    }
  } catch (e) {}

  try {
    if (group.tagInterface && group.tagInterface.hasKey("effectPipeline")) {
      const json = group.tagInterface.getValueForKey("effectPipeline");
      if (json) {
        const parsed = JSON.parse(json);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const ptStage = parsed.find(s => s && (s.id === "procedural_transform" || s.id === "proceduraltransform" || s.id === "progressive_transform" || s.id === "progressivetransform"));
          if (ptStage && ptStage.params) {
            return sanitizeValues(ptStage.params);
          }
        }
      }
    }
  } catch (e) {}

  return sanitizeValues(DEFAULT_VALUES);
}

function setContainerMetadata(document, group, params) {
  if (!group) return;
  const groupSel = mkSel(group);
  const json = JSON.stringify(params);

  try {
    document.executeCommand(DocumentCommand.createSetTagValueForKey(groupSel, TAG_KEY, json), false);
  } catch (e) {}

  const pipeline = [
    {
      id: "procedural_transform",
      name: "Procedural Transform",
      params: params
    }
  ];
  try {
    document.executeCommand(DocumentCommand.createSetTagValueForKey(groupSel, "effectPipeline", JSON.stringify(pipeline)), false);
  } catch (e) {}
}

/**
 * Calculates the exact similarity transform in SPREAD SPACE for object at progression index i,
 * applying individual parametric curves for s, w, h, and r with Oriented Alignment Anchor.
 * Scales along the object's NATURAL local orientation (phi) to prevent any diagonal distortion or shearing.
 */
function calculateObjectTransform(index, totalCount, item, params) {
  const box = item.box;
  const phi = item.orientationAngle || 0;

  let u = totalCount > 1 ? index / (totalCount - 1) : 0.5;
  if (params.reverseOrder) {
    u = 1 - u;
  }

  // 1. Uniform Scale (s) via parametric curve
  const ts = evaluateParametricCurve(u, params.scaleCurveMode, params.scaleCurvature, params.scaleMidpoint);
  const scale = params.startScale + (params.endScale - params.startScale) * ts;

  // 2. Width Scale (w) via parametric curve
  const tw = evaluateParametricCurve(u, params.widthCurveMode, params.widthCurvature, params.widthMidpoint);
  const scaleW = params.startWidth + (params.endWidth - params.startWidth) * tw;

  // 3. Height Scale (h) via parametric curve
  const th = evaluateParametricCurve(u, params.heightCurveMode, params.heightCurvature, params.heightMidpoint);
  const scaleH = params.startHeight + (params.endHeight - params.startHeight) * th;

  // 4. Rotation (r) via parametric curve
  const tr = evaluateParametricCurve(u, params.rotCurveMode, params.rotCurvature, params.rotMidpoint);
  const rotDeg = params.startRotation + (params.endRotation - params.startRotation) * tr;
  const rotRad = degToRad(rotDeg);

  // Composite scale factors
  const sx = Math.max(0.001, scale * scaleW);
  const sy = Math.max(0.001, scale * scaleH);

  // Center of the shape in spread space
  const cx = box.x + box.width * 0.5;
  const cy = box.y + box.height * 0.5;

  // Oriented Vertical Alignment Anchor calculation
  let anchorX = cx;
  let anchorY = cy;
  if (params.vAlign === 0) {
    // Top anchor: offset along oriented Y axis
    const halfH = box.height * 0.5;
    anchorX = cx + Math.sin(phi) * halfH;
    anchorY = cy - Math.cos(phi) * halfH;
  } else if (params.vAlign === 2) {
    // Bottom anchor: offset along oriented Y axis
    const halfH = box.height * 0.5;
    anchorX = cx - Math.sin(phi) * halfH;
    anchorY = cy + Math.cos(phi) * halfH;
  }

  // Oriented Transform: Rotate into natural frame, scale (w, h), rotate by (phi + rot), translate to anchor
  return Transform
    .createTranslate(anchorX, anchorY)
    .multiply(Transform.createRotate(phi + rotRad))
    .multiply(Transform.createScale(sx, sy))
    .multiply(Transform.createRotate(-phi))
    .multiply(Transform.createTranslate(-anchorX, -anchorY));
}

// =============================================================================
// LIVE PREVIEW ENGINE (Non-Destructive Debounced 80ms)
// =============================================================================

function clearPreviews(document) {
  try {
    document.executeCommand(DocumentCommand.createClearPreviews());
  } catch (e) {}
}

function doPreviewPolyCurves(document, sourceItems, targetNode, params) {
  clearPreviews(document);
  if (!sourceItems || !sourceItems.length) return;

  const sortedItems = sortSourceItems(sourceItems, params.sortMode);
  const N = sortedItems.length;

  const addBuilder = AddChildNodesCommandBuilder.create();
  if (targetNode) {
    addBuilder.setInsertionTargetSelection(mkSel(targetNode));
    addBuilder.setInsertionMode(InsertionMode.Top);
  }

  for (let i = 0; i < N; i++) {
    const item = sortedItems[i];
    if (!item) continue;

    const spreadTransform = calculateObjectTransform(i, N, item, params);

    if (item.geomEntries && item.geomEntries.length) {
      for (const geom of item.geomEntries) {
        if (!geom || !geom.polyCurve) continue;
        const pc = geom.polyCurve.clone();
        try { pc.transform(spreadTransform); } catch (e) {}
        const s = geom.style;
        const op = (typeof s.opacity === "number") ? s.opacity : 1.0;
        const bm = s.blendMode || null;

        const previewBrushFill = (s.brushFill && !s.brushFill.isNoFill)
          ? applyOpacityAndBlendToFillDescriptor(s.brushFill, op, bm)
          : FillDescriptor.createNone();

        const previewLineFill = (s.hasStroke && s.lineFill && !s.lineFill.isNoFill)
          ? applyOpacityAndBlendToFillDescriptor(s.lineFill, op, bm)
          : FillDescriptor.createNone();

        const previewLineStyle = s.hasStroke
          ? (s.lineStyle || LineStyleDescriptor.createDefault(1))
          : LineStyleDescriptor.createDefault(0);

        const def = PolyCurveNodeDefinition.create(
          pc,
          previewBrushFill,
          previewLineStyle,
          previewLineFill,
          s.transparencyFill || FillDescriptor.createNone()
        );

        addBuilder.addNode(def);
      }
    }
  }

  const cmd = addBuilder.createCommand(false, NodeChildType.Main);
  if (cmd) {
    document.executeCommand(cmd, true);
  }
}

// =============================================================================
// APPLY WORKFLOW (In-Place Container Preservation + Red Tag #FF0000 + JSON)
// =============================================================================

function doApply(document, nodes, sourceItems, params, existingGroup) {
  let targetGroup = existingGroup;

  if (existingGroup) {
    const oldResults = getChildren(existingGroup).filter(isResultNode);
    const updateCb = CompoundCommandBuilder.create();

    if (oldResults.length > 0) {
      updateCb.addCommand(DocumentCommand.createDeleteSelection(Selection.create(document, oldResults, true)));
    }

    updateCb.addCommand(DocumentCommand.createSetDescription(mkSel(existingGroup), GROUP_PREFIX));

    for (let i = 0; i < nodes.length; i++) {
      const src = nodes[i];
      updateCb.addCommand(DocumentCommand.createSetDescription(mkSel(src), `${SOURCE_PREFIX} ${i + 1}`));
      updateCb.addCommand(DocumentCommand.createSetVisibility(mkSel(src), false));
    }
    document.executeCommand(updateCb.createCommand());

    setContainerMetadata(document, existingGroup, params);

  } else {
    const gBuilder = AddChildNodesCommandBuilder.create();
    gBuilder.setInsertionTargetSelection(mkSel(nodes[0]));
    gBuilder.setInsertionMode(InsertionMode.Top);
    gBuilder.addContainerNode(ContainerNodeDefinition.create(GROUP_PREFIX));
    const gCmd = gBuilder.createCommand(false, NodeChildType.Main);
    document.executeCommand(gCmd);
    targetGroup = gCmd.newNodes[0];

    const prepCompound = CompoundCommandBuilder.create();
    for (let i = 0; i < nodes.length; i++) {
      const src = nodes[i];
      prepCompound.addCommand(DocumentCommand.createSetDescription(mkSel(src), `${SOURCE_PREFIX} ${i + 1}`));
      prepCompound.addCommand(DocumentCommand.createMoveNodes(mkSel(src), targetGroup, NodeMoveType.Inside, NodeChildType.Main));
      prepCompound.addCommand(DocumentCommand.createSetVisibility(mkSel(src), false));
    }
    document.executeCommand(prepCompound.createCommand());

    setContainerMetadata(document, targetGroup, params);
  }

  // Generate Duplicate Result Items in Sorted Visual Order
  const sortedItems = sortSourceItems(sourceItems, params.sortMode);
  const N = sortedItems.length;
  const dupCb = CompoundCommandBuilder.create();

  for (let i = 0; i < N; i++) {
    const item = sortedItems[i];
    const node = item.node;
    const spreadTransform = calculateObjectTransform(i, N, item, params);

    dupCb.addCommand(
      DocumentCommand.createTransform(mkSel(node), spreadTransform, { duplicateNodes: true }),
      false
    );
  }

  const dupCmd = dupCb.createCommand();
  if (dupCmd) {
    document.executeCommand(dupCmd);

    // Style & Red Tag the newly duplicated result items
    if (dupCmd.newNodes && dupCmd.newNodes.length > 0) {
      const tagCb = CompoundCommandBuilder.create();
      const newItems = dupCmd.newNodes;

      for (let i = 0; i < newItems.length; i++) {
        const itemNode = newItems[i];
        tagCb.addCommand(DocumentCommand.createSetDescription(mkSel(itemNode), `${RESULT_PREFIX} ${i + 1}`));
        tagCb.addCommand(DocumentCommand.createSetVisibility(mkSel(itemNode), true));
        tagCb.addCommand(DocumentCommand.createMoveNodes(mkSel(itemNode), targetGroup, NodeMoveType.Inside, NodeChildType.Main));
      }
      document.executeCommand(tagCb.createCommand());

      // Red tag #FF0000 for Expand Effects standard compatibility
      try {
        const resSel = Selection.create(document, newItems, true);
        document.executeCommand(DocumentCommand.createSetTagColour(resSel, RGB8(255, 0, 0)), false);
      } catch (e) {}
    }
  }

  // Keep target group selected for immediate next re-edit
  try {
    document.executeCommand(DocumentCommand.createSetSelection(mkSel(targetGroup)), false);
  } catch (e) {}
}

// =============================================================================
// MAIN ENTRY POINT & DIALOG UI
// =============================================================================

function runProceduralTransform(document, rawNodes) {
  let existingGroup = null;
  let nodes = [];

  if (rawNodes.length === 1 && isProceduralTransformGroup(rawNodes[0])) {
    existingGroup = rawNodes[0];
  } else {
    for (const node of rawNodes) {
      const pGrp = getProceduralTransformGroupOf(node);
      if (pGrp) {
        existingGroup = pGrp;
        break;
      }
    }
  }

  if (existingGroup) {
    const children = getChildren(existingGroup);
    const existingSources = children.filter(isSourceNode).sort((a, b) => getSourceIndex(a) - getSourceIndex(b));
    const existingResults = children.filter(isResultNode).sort((a, b) => getResultIndex(a) - getResultIndex(b));

    nodes = existingSources.length > 0 ? existingSources : children.filter(c => !isResultNode(c));
    if (nodes.length === 0) nodes = children;

    // Synchronize fill/stroke from modified visible results back to sources
    if (existingSources.length > 0 && existingResults.length > 0) {
      syncSourceStylesFromResults(document, existingGroup, existingSources, existingResults);
    }
  } else {
    nodes = rawNodes;
  }

  if (nodes.some(isSymbolNode)) {
    const warnDlg = Dialog.create("Symbols Not Supported");
    const warnCol = warnDlg.addColumn();
    warnCol.addStaticText(
      null,
      "Symbols are not supported in " + SCRIPT_TITLE + "."
    ).setIsFullWidth(true);
    warnCol.addStaticText(
      null,
      "Please detach or expand symbols into standard shapes, curves, or groups before running " + SCRIPT_TITLE + "."
    ).setIsFullWidth(true);
    warnDlg.show();
    return;
  }

  const sourceItems = nodes.map((node, index) => {
    const entries = extractGeomEntriesFromNode(node);
    const b = getEntriesBounds(entries);
    const angle = getNodeOrientationAngle(node);

    return {
      index: index,
      sourceIndex: index,
      node: node,
      geomEntries: entries,
      orientationAngle: angle,
      box: b || { x: 0, y: 0, width: 100, height: 100 }
    };
  });

  const previewTargetNode = existingGroup || nodes[0];

  let oldResultsToHide = [];
  if (existingGroup) {
    oldResultsToHide = getChildren(existingGroup).filter(isResultNode);
    if (oldResultsToHide.length > 0) {
      const hideOldCb = CompoundCommandBuilder.create();
      for (const res of oldResultsToHide) {
        hideOldCb.addCommand(DocumentCommand.createSetVisibility(mkSel(res), false));
      }
      document.executeCommand(hideOldCb.createCommand());
    }
  } else {
    const hidePrimariesCb = CompoundCommandBuilder.create();
    for (const n of nodes) {
      hidePrimariesCb.addCommand(DocumentCommand.createSetVisibility(mkSel(n), true));
    }
  }

  const initialValues = existingGroup ? readGroupValues(existingGroup) : sanitizeValues(DEFAULT_VALUES);

  // Dialog UI (2 Columns)
  const dlg = Dialog.create(SCRIPT_TITLE);
  dlg.initialWidth = 720;

  // --- COLUMN 1: SCALE & DIMENSIONS (s, w, h) ---
  const col1 = dlg.addColumn();

  // 1. Master Scale
  const scaleGrp = col1.addGroup("Master Scale (s)");
  const startScaleCtrl = scaleGrp.addUnitValueEditor("Start Scale (%)", UnitType.Percentage, UnitType.Percentage, initialValues.startScale * 100, 1, 1000);
  startScaleCtrl.precision = 1;
  startScaleCtrl.showPopupSlider = true;

  const endScaleCtrl = scaleGrp.addUnitValueEditor("End Scale (%)", UnitType.Percentage, UnitType.Percentage, initialValues.endScale * 100, 1, 1000);
  endScaleCtrl.precision = 1;
  endScaleCtrl.showPopupSlider = true;

  const scaleCurveCtrl = scaleGrp.addComboBox("Scale Curve Mode", CURVE_MODES);
  try { scaleCurveCtrl.selectedIndex = initialValues.scaleCurveMode; } catch (e) {}

  const scaleCurvCtrl = scaleGrp.addUnitValueEditor("Scale Curvature (%)", UnitType.Percentage, UnitType.Percentage, initialValues.scaleCurvature, -100, 100);
  scaleCurvCtrl.precision = 1;
  scaleCurvCtrl.showPopupSlider = true;

  const scaleMidCtrl = scaleGrp.addUnitValueEditor("Scale Midpoint / Bias (%)", UnitType.Percentage, UnitType.Percentage, initialValues.scaleMidpoint, 0, 100);
  scaleMidCtrl.precision = 1;
  scaleMidCtrl.showPopupSlider = true;

  // 2. Width
  const widthGrp = col1.addGroup("Width / Scale X (w)");
  const startWidthCtrl = widthGrp.addUnitValueEditor("Start Width (%)", UnitType.Percentage, UnitType.Percentage, initialValues.startWidth * 100, 1, 1000);
  startWidthCtrl.precision = 1;
  startWidthCtrl.showPopupSlider = true;

  const endWidthCtrl = widthGrp.addUnitValueEditor("End Width (%)", UnitType.Percentage, UnitType.Percentage, initialValues.endWidth * 100, 1, 1000);
  endWidthCtrl.precision = 1;
  endWidthCtrl.showPopupSlider = true;

  const widthCurveCtrl = widthGrp.addComboBox("Width Curve Mode", CURVE_MODES);
  try { widthCurveCtrl.selectedIndex = initialValues.widthCurveMode; } catch (e) {}

  const widthCurvCtrl = widthGrp.addUnitValueEditor("Width Curvature (%)", UnitType.Percentage, UnitType.Percentage, initialValues.widthCurvature, -100, 100);
  widthCurvCtrl.precision = 1;
  widthCurvCtrl.showPopupSlider = true;

  const widthMidCtrl = widthGrp.addUnitValueEditor("Width Midpoint / Bias (%)", UnitType.Percentage, UnitType.Percentage, initialValues.widthMidpoint, 0, 100);
  widthMidCtrl.precision = 1;
  widthMidCtrl.showPopupSlider = true;

  // 3. Height
  const heightGrp = col1.addGroup("Height / Scale Y (h)");
  const startHeightCtrl = heightGrp.addUnitValueEditor("Start Height (%)", UnitType.Percentage, UnitType.Percentage, initialValues.startHeight * 100, 1, 1000);
  startHeightCtrl.precision = 1;
  startHeightCtrl.showPopupSlider = true;

  const endHeightCtrl = heightGrp.addUnitValueEditor("End Height (%)", UnitType.Percentage, UnitType.Percentage, initialValues.endHeight * 100, 1, 1000);
  endHeightCtrl.precision = 1;
  endHeightCtrl.showPopupSlider = true;

  const heightCurveCtrl = heightGrp.addComboBox("Height Curve Mode", CURVE_MODES);
  try { heightCurveCtrl.selectedIndex = initialValues.heightCurveMode; } catch (e) {}

  const heightCurvCtrl = heightGrp.addUnitValueEditor("Height Curvature (%)", UnitType.Percentage, UnitType.Percentage, initialValues.heightCurvature, -100, 100);
  heightCurvCtrl.precision = 1;
  heightCurvCtrl.showPopupSlider = true;

  const heightMidCtrl = heightGrp.addUnitValueEditor("Height Midpoint / Bias (%)", UnitType.Percentage, UnitType.Percentage, initialValues.heightMidpoint, 0, 100);
  heightMidCtrl.precision = 1;
  heightMidCtrl.showPopupSlider = true;

  // --- COLUMN 2: ROTATION (r), ALIGNMENT & SEQUENCE CONTROL ---
  const col2 = dlg.addColumn();

  // 4. Rotation
  const rotGrp = col2.addGroup("Rotation (r)");
  const startRotCtrl = rotGrp.addUnitValueEditor("Start Rotation (deg)", UnitType.Degree, UnitType.Degree, initialValues.startRotation, -3600, 3600);
  startRotCtrl.precision = 1;
  startRotCtrl.showPopupSlider = true;

  const endRotCtrl = rotGrp.addUnitValueEditor("End Rotation (deg)", UnitType.Degree, UnitType.Degree, initialValues.endRotation, -3600, 3600);
  endRotCtrl.precision = 1;
  endRotCtrl.showPopupSlider = true;

  const rotCurveCtrl = rotGrp.addComboBox("Rotation Curve Mode", CURVE_MODES);
  try { rotCurveCtrl.selectedIndex = initialValues.rotCurveMode; } catch (e) {}

  const rotCurvCtrl = rotGrp.addUnitValueEditor("Rotation Curvature (%)", UnitType.Percentage, UnitType.Percentage, initialValues.rotCurvature, -100, 100);
  rotCurvCtrl.precision = 1;
  rotCurvCtrl.showPopupSlider = true;

  const rotMidCtrl = rotGrp.addUnitValueEditor("Rotation Midpoint / Bias (%)", UnitType.Percentage, UnitType.Percentage, initialValues.rotMidpoint, 0, 100);
  rotMidCtrl.precision = 1;
  rotMidCtrl.showPopupSlider = true;

  // 5. Vertical Alignment (Top, Center, Bottom)
  const alignGrp = col2.addGroup("Vertical Alignment Anchor");
  const alignCtrl = alignGrp.addButtonSet("Alignment", ["Top", "Center", "Bottom"]);
  try { alignCtrl.selectedIndex = initialValues.vAlign; } catch (e) {}

  // 6. Sequence & Flow
  const progGrp = col2.addGroup("Sequence & Flow");
  const sortCtrl = progGrp.addComboBox("Order / Flow", [
    "Auto (Visual Flow: Left→Right / Top→Bottom)",
    "Left → Right (Canvas X)",
    "Top → Bottom (Canvas Y)",
    "Selection / Layer Order"
  ]);
  try { sortCtrl.selectedIndex = initialValues.sortMode; } catch (e) {}

  const reverseCtrl = progGrp.addSwitch("Reverse Direction (1→0)", initialValues.reverseOrder);

  // Status & Standard Procedural Effect Notice (Zig Zag Standard)
  const noteGrp = col2.addGroup("");
  const txt1 = noteGrp.addStaticText(null, existingGroup ? "✨ Editing Procedural Transform in Stack ✨" : "✨ Non-destructive Procedural Effect ✨").setIsFullWidth(true);
  txt1.textHorizontalAlignment = HorizontalAlignment.Centre;

  const txt2 = noteGrp.addStaticText(null, "Run this script again on the container to edit parameters, or run other effect scripts to stack effects.").setIsFullWidth(true);
  txt2.textHorizontalAlignment = HorizontalAlignment.Centre;

  function readValues() {
    const getComboVal = ctrl => (ctrl && typeof ctrl.selectedIndex === "number") ? ctrl.selectedIndex : 0;
    const alignVal = (alignCtrl && typeof alignCtrl.selectedIndex === "number") ? alignCtrl.selectedIndex : 1;

    return sanitizeValues({
      startScale: clamp(startScaleCtrl.value, 1, 10000) / 100,
      endScale: clamp(endScaleCtrl.value, 1, 10000) / 100,
      scaleCurveMode: getComboVal(scaleCurveCtrl),
      scaleCurvature: clamp(scaleCurvCtrl.value, -100, 100),
      scaleMidpoint: clamp(scaleMidCtrl.value, 0, 100),

      startWidth: clamp(startWidthCtrl.value, 1, 10000) / 100,
      endWidth: clamp(endWidthCtrl.value, 1, 10000) / 100,
      widthCurveMode: getComboVal(widthCurveCtrl),
      widthCurvature: clamp(widthCurvCtrl.value, -100, 100),
      widthMidpoint: clamp(widthMidCtrl.value, 0, 100),

      startHeight: clamp(startHeightCtrl.value, 1, 10000) / 100,
      endHeight: clamp(endHeightCtrl.value, 1, 10000) / 100,
      heightCurveMode: getComboVal(heightCurveCtrl),
      heightCurvature: clamp(heightCurvCtrl.value, -100, 100),
      heightMidpoint: clamp(heightMidCtrl.value, 0, 100),

      startRotation: clamp(startRotCtrl.value, -3600, 3600),
      endRotation: clamp(endRotCtrl.value, -3600, 3600),
      rotCurveMode: getComboVal(rotCurveCtrl),
      rotCurvature: clamp(rotCurvCtrl.value, -100, 100),
      rotMidpoint: clamp(rotMidCtrl.value, 0, 100),

      vAlign: alignVal,
      sortMode: getComboVal(sortCtrl),
      reverseOrder: reverseCtrl ? !!reverseCtrl.value : false
    });
  }

  // Debounced Live Preview
  let inPreview = false, previewTimer = null;
  function applyPreview() {
    if (previewTimer) previewTimer.cancel();
    previewTimer = setTimeout(80, (err) => {
      if (err || inPreview) return;
      inPreview = true;
      try {
        const params = readValues();
        doPreviewPolyCurves(document, sourceItems, previewTargetNode, params);
      } catch (e) {
        console.log(SCRIPT_TITLE + " preview error: " + e);
        clearPreviews(document);
      } finally {
        inPreview = false;
      }
    });
  }

  startScaleCtrl.onValueChangedHandler = applyPreview;
  endScaleCtrl.onValueChangedHandler = applyPreview;
  if (scaleCurveCtrl) scaleCurveCtrl.onValueChangedHandler = applyPreview;
  scaleCurvCtrl.onValueChangedHandler = applyPreview;
  scaleMidCtrl.onValueChangedHandler = applyPreview;

  startWidthCtrl.onValueChangedHandler = applyPreview;
  endWidthCtrl.onValueChangedHandler = applyPreview;
  if (widthCurveCtrl) widthCurveCtrl.onValueChangedHandler = applyPreview;
  widthCurvCtrl.onValueChangedHandler = applyPreview;
  widthMidCtrl.onValueChangedHandler = applyPreview;

  startHeightCtrl.onValueChangedHandler = applyPreview;
  endHeightCtrl.onValueChangedHandler = applyPreview;
  if (heightCurveCtrl) heightCurveCtrl.onValueChangedHandler = applyPreview;
  heightCurvCtrl.onValueChangedHandler = applyPreview;
  heightMidCtrl.onValueChangedHandler = applyPreview;

  startRotCtrl.onValueChangedHandler = applyPreview;
  endRotCtrl.onValueChangedHandler = applyPreview;
  if (rotCurveCtrl) rotCurveCtrl.onValueChangedHandler = applyPreview;
  rotCurvCtrl.onValueChangedHandler = applyPreview;
  rotMidCtrl.onValueChangedHandler = applyPreview;

  if (alignCtrl) alignCtrl.onValueChangedHandler = applyPreview;
  if (sortCtrl) sortCtrl.onValueChangedHandler = applyPreview;
  if (reverseCtrl) reverseCtrl.onValueChangedHandler = applyPreview;
  dlg.onControlValueChangedHandler = applyPreview;

  // Hide initial primary shapes while preview is active (if not existing group)
  if (!existingGroup) {
    const hidePrimariesCb = CompoundCommandBuilder.create();
    for (const n of nodes) {
      hidePrimariesCb.addCommand(DocumentCommand.createSetVisibility(mkSel(n), false));
    }
    document.executeCommand(hidePrimariesCb.createCommand());
  }

  applyPreview();

  const result = dlg.show();
  if (previewTimer) previewTimer.cancel();
  clearPreviews(document);

  if (result.value === DialogResult.Ok.value) {
    const finalParams = readValues();
    try {
      doApply(document, nodes, sourceItems, finalParams, existingGroup);
    } catch (e) {
      alert("Application failed:\n" + e.message);
    }
  } else {
    // Restore visibility if cancelled
    const restoreCb = CompoundCommandBuilder.create();
    if (existingGroup) {
      for (const src of nodes) {
        restoreCb.addCommand(DocumentCommand.createSetVisibility(mkSel(src), false));
      }
      for (const res of oldResultsToHide) {
        restoreCb.addCommand(DocumentCommand.createSetVisibility(mkSel(res), true));
      }
    } else {
      for (const n of nodes) {
        restoreCb.addCommand(DocumentCommand.createSetVisibility(mkSel(n), true));
      }
    }
    document.executeCommand(restoreCb.createCommand());
  }
}

// =============================================================================
// TOP-LEVEL INVOCATION
// =============================================================================

function main() {
  if (!doc) {
    alert("Please open a document in Affinity.");
    return;
  }

  const rawNodes = doc.selection ? doc.selection.nodes.toArray().filter(Boolean) : [];
  if (!rawNodes.length) {
    alert("Please select at least one object (shape, curve, text, or group).");
    return;
  }

  runProceduralTransform(doc, rawNodes);
}

main();
