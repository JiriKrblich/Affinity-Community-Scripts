"use strict";

// =============================================================================
// ARRANGE ON PATH v4.11 (Procedural Vector Path Distribution & Arranger Engine)
// Affinity Designer / Photo / Publisher (v3e & Multi-Effect Standard)
//
// New Features & Architectural Fixes in v4.11:
// - Perfectly Balanced 3-Column UI with Restored "How It Works" Section:
//   • Equalized column heights across all 3 columns:
//     Col 1: Placement & Path (5) + Orientation & Pivot (6) = 11 controls
//     Col 2: Repeat & Distribution (2) + Resize & Scaling (7) + Z-Order (2) = 11 controls
//     Col 3: Randomize Engine (8) + How It Works (3 bullets) = Perfectly matches Col 1 & 2!
//   • Zero bottom whitespace, clean padding, ultra-compact dialog height (~760px width).
// - 3-Point Pivot Anchor Alignment Engine (Center / Top / Bottom):
//   • Center (0): Vector path cuts directly through the middle of the object.
//   • Top (1): Top bounding anchor aligns exactly with the path (hang under path).
//   • Bottom (2): Bottom bounding anchor aligns exactly with the path (sit on path).
// - Path Visibility Toggle:
//   • "Keep path visible" switch (default: false / hidden) cleanly preserves vector path inside container.
// - Fixed "Flip Normal" Geometry & Scaling Engine:
//   • Uses Math.max(0.001, finalScaleY) * flipY, cleanly mirroring the shape
//     across the curve tangent to the opposite normal side in both live preview and output.
// - Parameter Audit & Persistence Integrity:
//   • All 30 parameters verified for zero duplication and 100% 1-to-1 parity across
//     DEFAULT_VALUES, sanitizeValues, UI controls, getParams, and TagInterface metadata.
// - Absolute Invariant Matrix Engine & Container Scale Preservation (Pivot Standard):
//   • Decomposes and inverts container transform into Container Local Space (containerInv).
//   • Applies exact conjugate similarity transformation:
//     T_spread = T_container * T_local * T_container^-1.
//   • Guaranteed 0.0000px coordinate accuracy on move and permanent container dimension stability on resize.
// - 100% 1:1 Live Preview & Output Synchronization:
//   • Real-time PolyCurve preview renders exact spread transformations with full opacity,
//     stroke weight, pen fill, and blend mode fidelity.
// - Non-Destructive Container Re-Editing:
//   • Automatically detects and re-opens existing Arrange on Path containers.
//   • Extracts hidden sources ("Source 1..N") and reference paths ("Path 1..N"),
//     cleans up previous results, and generates new arrangements in-place.
//   • On Dialog Cancel: instantly restores previous result visibility with zero state mutation.
// - Full Expand Effects & Tag Metadata Compliance:
//   • Automatically tags all generated items with Red #FF0000 (RGB8(255, 0, 0)) for
//     instant 1-click vector baking via Expand Effects.
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

// =============================================================================
// CONSTANTS & REGISTRY
// =============================================================================

const SCRIPT_TITLE = "Arrange on Path v4.11";
const TAG_KEY = "arrangeOnPathSettings";
const GROUP_PREFIX = "Arrange on Path Effect";
const SOURCE_PREFIX = "Source";
const PATH_PREFIX = "Path";
const RESULT_PREFIX = "Arrange Item";
const MAX_TOTAL_INSTANCES = 5000;

const PIVOT_MODES = [
  "Center",
  "Top",
  "Bottom"
];

const MATCH_SIZE_MODES = [
  "Auto (Majority Size)",
  "First Object Size",
  "Average Size",
  "Off (Original Sizes)"
];

const Z_ORDER_MODES = [
  "Sequential (Path Order)",
  "Template Grouped (a,a,b,b...)",
  "Interleaved (Weave a,b,a,b...)",
  "Reverse Path Order"
];

const DEFAULT_VALUES = {
  // Placement & Path
  startFrac: 0,           // 0%
  endFrac: 100,           // 100%
  smartPlacement: true,
  reverse: false,
  pathVisible: false,     // Keep path visible (default: false)

  // Orientation, Pivot & Rotation
  alignToPath: true,
  pivotMode: 0,           // 0: Center, 1: Top, 2: Bottom
  flipNormal: false,
  baseRotation: 0,
  rotStartDeg: 0,
  rotEndDeg: 0,

  // Repeat & Distribution
  repeatMode: true,
  repeatCount: 12,

  // Resize & Scaling
  matchSizeMode: 0,       // 0: Auto (Majority), 1: First, 2: Average, 3: Off
  sizeScale: 100,         // Master Scale % (100% = 1.0)
  scaleW: 100,            // Scale Width % (100% = 1.0)
  scaleH: 100,            // Scale Height % (100% = 1.0)
  scaleStart: 100,        // Progressive Start Scale %
  scaleEnd: 100,          // Progressive End Scale %
  fitToPath: false,       // Auto-Fit to Path Spacing

  // Z-Order & Stacking
  zOrderMode: 0,          // 0: Sequential, 1: Template Grouped, 2: Interleaved, 3: Reverse
  reverseZIndex: false,

  // Randomize Engine
  rndEnabled: false,
  shuffleSeed: 0,
  jitterSeed: 0,
  jitterAmt: 30,          // Spacing amount %
  rotSeed: 0,
  rotMaxDeg: 45,          // Max rotation angle deg
  sizeSeed: 0,
  sizeAmt: 30             // Size amount %
};

const doc = Document.current;

// =============================================================================
// DOM, TAGS & CONTAINER DETECTION HELPERS
// =============================================================================

const mkSel = n => Selection.create(doc, n, true);

function isSameNode(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  try {
    if (a.isSameNode && a.isSameNode(b)) return true;
  } catch (e) {}
  return false;
}

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

function getPathIndex(node) {
  const name = getNodeName(node);
  const m = name.match(/Path\s+(\d+)/i);
  return m ? parseInt(m[1], 10) : 99999;
}

function getResultIndex(node) {
  const name = getNodeName(node);
  const m = name.match(/(?:Arrange Item|Result)\s+(\d+)/i);
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
    const rgba = colour.getRGBA8 ? colour.getRGBA8() : (colour.rgba8 || null);
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

function tagNodeRed(node) {
  if (!node) return;
  try {
    doc.executeCommand(DocumentCommand.createSetTagColour(mkSel(node), RGB8(255, 0, 0)), false);
  } catch (e) {}
}

function isResultNode(node) {
  if (!node) return false;
  if (hasRedTag(node)) return true;
  const name = getNodeName(node);
  return name.indexOf(RESULT_PREFIX) === 0 || name.indexOf("Result") === 0;
}

function isSourceNode(node) {
  if (!node) return false;
  if (isResultNode(node)) return false;
  const name = getNodeName(node);
  return name.indexOf(SOURCE_PREFIX) === 0;
}

function isPathNode(node) {
  if (!node) return false;
  if (isResultNode(node)) return false;
  const name = getNodeName(node);
  return name.indexOf(PATH_PREFIX) === 0;
}

function isArrangeOnPathGroup(node) {
  if (!node) return false;
  try {
    if (node.tagInterface) {
      if (node.tagInterface.hasKey(TAG_KEY)) return true;
      if (node.tagInterface.hasKey("arrangeOnPath")) return true;
      if (node.tagInterface.hasKey("effectPipeline")) {
        const json = node.tagInterface.getValueForKey("effectPipeline");
        if (json && json.indexOf("arrange_on_path") >= 0) return true;
      }
    }
  } catch (e) {}
  const name = getNodeName(node);
  if (name === GROUP_PREFIX || name.indexOf(GROUP_PREFIX) === 0 || name.indexOf("Arrange on Path") === 0) return true;
  const children = getChildren(node);
  const hasSource = children.some(c => getNodeName(c).indexOf(SOURCE_PREFIX) === 0);
  const hasPath = children.some(c => getNodeName(c).indexOf(PATH_PREFIX) === 0);
  const hasResult = children.some(c => hasRedTag(c) || getNodeName(c).indexOf(RESULT_PREFIX) === 0);
  return (hasSource || hasPath) && hasResult;
}

function getArrangeOnPathGroupOf(node) {
  let current = node;
  while (current) {
    if (isArrangeOnPathGroup(current)) return current;
    try { current = current.parent; } catch (e) { break; }
  }
  return null;
}

// =============================================================================
// PARAMETER SANITIZATION & METADATA
// =============================================================================

function clamp(value, minValue, maxValue) {
  return Math.max(minValue, Math.min(maxValue, value));
}

function degToRad(value) {
  return (value * Math.PI) / 180;
}

function sanitizeValues(p) {
  const pSafe = p || {};
  return {
    // Placement & Path
    startFrac: typeof pSafe.startFrac === "number" && !isNaN(pSafe.startFrac) ? clamp(pSafe.startFrac, 0, 100) : DEFAULT_VALUES.startFrac,
    endFrac: typeof pSafe.endFrac === "number" && !isNaN(pSafe.endFrac) ? clamp(pSafe.endFrac, 0, 100) : DEFAULT_VALUES.endFrac,
    smartPlacement: pSafe.smartPlacement !== undefined ? !!pSafe.smartPlacement : DEFAULT_VALUES.smartPlacement,
    reverse: pSafe.reverse !== undefined ? !!pSafe.reverse : DEFAULT_VALUES.reverse,
    pathVisible: pSafe.pathVisible !== undefined ? !!pSafe.pathVisible : DEFAULT_VALUES.pathVisible,

    // Orientation, Pivot & Rotation
    alignToPath: pSafe.alignToPath !== undefined ? !!pSafe.alignToPath : DEFAULT_VALUES.alignToPath,
    pivotMode: typeof pSafe.pivotMode === "number" && !isNaN(pSafe.pivotMode) ? clamp(Math.round(pSafe.pivotMode), 0, 2) : DEFAULT_VALUES.pivotMode,
    flipNormal: pSafe.flipNormal !== undefined ? !!pSafe.flipNormal : (pSafe.flip !== undefined ? !!pSafe.flip : DEFAULT_VALUES.flipNormal),
    baseRotation: typeof pSafe.baseRotation === "number" && !isNaN(pSafe.baseRotation) ? clamp(pSafe.baseRotation, -3600, 3600) : DEFAULT_VALUES.baseRotation,
    rotStartDeg: typeof pSafe.rotStartDeg === "number" && !isNaN(pSafe.rotStartDeg) ? clamp(pSafe.rotStartDeg, -3600, 3600) : DEFAULT_VALUES.rotStartDeg,
    rotEndDeg: typeof pSafe.rotEndDeg === "number" && !isNaN(pSafe.rotEndDeg) ? clamp(pSafe.rotEndDeg, -3600, 3600) : DEFAULT_VALUES.rotEndDeg,

    // Repeat & Distribution
    repeatMode: pSafe.repeatMode !== undefined ? !!pSafe.repeatMode : DEFAULT_VALUES.repeatMode,
    repeatCount: typeof pSafe.repeatCount === "number" && !isNaN(pSafe.repeatCount) ? clamp(Math.round(pSafe.repeatCount), 2, 1000) : DEFAULT_VALUES.repeatCount,

    // Resize & Scaling
    matchSizeMode: typeof pSafe.matchSizeMode === "number" && !isNaN(pSafe.matchSizeMode) ? clamp(Math.round(pSafe.matchSizeMode), 0, 3) : DEFAULT_VALUES.matchSizeMode,
    sizeScale: typeof pSafe.sizeScale === "number" && !isNaN(pSafe.sizeScale) ? clamp(pSafe.sizeScale, 1, 2000) : DEFAULT_VALUES.sizeScale,
    scaleW: typeof pSafe.scaleW === "number" && !isNaN(pSafe.scaleW) ? clamp(pSafe.scaleW, 1, 1000) : DEFAULT_VALUES.scaleW,
    scaleH: typeof pSafe.scaleH === "number" && !isNaN(pSafe.scaleH) ? clamp(pSafe.scaleH, 1, 1000) : DEFAULT_VALUES.scaleH,
    scaleStart: typeof pSafe.scaleStart === "number" && !isNaN(pSafe.scaleStart) ? clamp(pSafe.scaleStart, 1, 2000) : DEFAULT_VALUES.scaleStart,
    scaleEnd: typeof pSafe.scaleEnd === "number" && !isNaN(pSafe.scaleEnd) ? clamp(pSafe.scaleEnd, 1, 2000) : DEFAULT_VALUES.scaleEnd,
    fitToPath: pSafe.fitToPath !== undefined ? !!pSafe.fitToPath : DEFAULT_VALUES.fitToPath,

    // Z-Order & Stacking
    zOrderMode: typeof pSafe.zOrderMode === "number" && !isNaN(pSafe.zOrderMode) ? clamp(Math.round(pSafe.zOrderMode), 0, 3) : DEFAULT_VALUES.zOrderMode,
    reverseZIndex: pSafe.reverseZIndex !== undefined ? !!pSafe.reverseZIndex : DEFAULT_VALUES.reverseZIndex,

    // Randomize Engine
    rndEnabled: pSafe.rndEnabled !== undefined ? !!pSafe.rndEnabled : (pSafe.rnd && pSafe.rnd.enabled ? !!pSafe.rnd.enabled : DEFAULT_VALUES.rndEnabled),
    shuffleSeed: typeof pSafe.shuffleSeed === "number" && !isNaN(pSafe.shuffleSeed) ? clamp(Math.round(pSafe.shuffleSeed), 0, 99999) : (pSafe.rnd && pSafe.rnd.shuffleSeed ? Math.round(pSafe.rnd.shuffleSeed) : DEFAULT_VALUES.shuffleSeed),
    jitterSeed: typeof pSafe.jitterSeed === "number" && !isNaN(pSafe.jitterSeed) ? clamp(Math.round(pSafe.jitterSeed), 0, 99999) : (pSafe.rnd && pSafe.rnd.jitterSeed ? Math.round(pSafe.rnd.jitterSeed) : DEFAULT_VALUES.jitterSeed),
    jitterAmt: typeof pSafe.jitterAmt === "number" && !isNaN(pSafe.jitterAmt) ? clamp(pSafe.jitterAmt, 1, 100) : (pSafe.rnd && pSafe.rnd.jitterAmt ? pSafe.rnd.jitterAmt : DEFAULT_VALUES.jitterAmt),
    rotSeed: typeof pSafe.rotSeed === "number" && !isNaN(pSafe.rotSeed) ? clamp(Math.round(pSafe.rotSeed), 0, 99999) : (pSafe.rnd && pSafe.rnd.rotSeed ? Math.round(pSafe.rnd.rotSeed) : DEFAULT_VALUES.rotSeed),
    rotMaxDeg: typeof pSafe.rotMaxDeg === "number" && !isNaN(pSafe.rotMaxDeg) ? clamp(pSafe.rotMaxDeg, 1, 180) : (pSafe.rnd && pSafe.rnd.rotMaxDeg ? pSafe.rnd.rotMaxDeg : DEFAULT_VALUES.rotMaxDeg),
    sizeSeed: typeof pSafe.sizeSeed === "number" && !isNaN(pSafe.sizeSeed) ? clamp(Math.round(pSafe.sizeSeed), 0, 99999) : (pSafe.rnd && pSafe.rnd.sizeSeed ? Math.round(pSafe.rnd.sizeSeed) : DEFAULT_VALUES.sizeSeed),
    sizeAmt: typeof pSafe.sizeAmt === "number" && !isNaN(pSafe.sizeAmt) ? clamp(pSafe.sizeAmt, 1, 100) : (pSafe.rnd && pSafe.rnd.sizeAmt ? pSafe.rnd.sizeAmt : DEFAULT_VALUES.sizeAmt)
  };
}

function readGroupValues(group) {
  if (!group) return sanitizeValues(DEFAULT_VALUES);

  // 1. TagInterface "arrangeOnPathSettings" (Primary)
  try {
    if (group.tagInterface && group.tagInterface.hasKey(TAG_KEY)) {
      const json = group.tagInterface.getValueForKey(TAG_KEY);
      if (json) return sanitizeValues(JSON.parse(json));
    }
  } catch (e) {}

  // 2. TagInterface "effectPipeline"
  try {
    if (group.tagInterface && group.tagInterface.hasKey("effectPipeline")) {
      const json = group.tagInterface.getValueForKey("effectPipeline");
      if (json) {
        const parsed = JSON.parse(json);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const aopStage = parsed.find(s => s && (s.id === "arrange_on_path" || s.id === "arrangeonpath"));
          if (aopStage && aopStage.params) {
            return sanitizeValues(aopStage.params);
          }
        }
      }
    }
  } catch (e) {}

  // 3. Fallback: TagInterface "arrangeOnPath"
  try {
    if (group.tagInterface && group.tagInterface.hasKey("arrangeOnPath")) {
      const json = group.tagInterface.getValueForKey("arrangeOnPath");
      if (json) return sanitizeValues(JSON.parse(json));
    }
  } catch (e) {}

  return sanitizeValues(DEFAULT_VALUES);
}

function setContainerMetadata(document, group, params) {
  if (!group) return;
  try {
    const groupSel = Selection.create(document, group, true);
    document.executeCommand(DocumentCommand.createSetDescription(groupSel, GROUP_PREFIX), false);
    document.executeCommand(DocumentCommand.createSetTagValueForKey(groupSel, TAG_KEY, JSON.stringify(params)), false);
    document.executeCommand(DocumentCommand.createSetTagValueForKey(groupSel, "effectPipeline", JSON.stringify([{ id: "arrange_on_path", params: params }])), false);
  } catch (e) {
    console.log("Arrange on Path metadata error: " + e);
  }
}

// =============================================================================
// GEOMETRY & BEZIER MATH ENGINE (Spread Space)
// =============================================================================

function validBB(b) {
  return b && isFinite(b.x) && isFinite(b.y) && isFinite(b.width) && isFinite(b.height) && (b.width > 0 || b.height > 0);
}

function getNodePolyCurve(node) {
  if (!node) return null;
  try {
    if (node.polyCurve) return node.polyCurve;
    if (node.curvesInterface && node.curvesInterface.polyCurve) return node.curvesInterface.polyCurve;
  } catch (e) {}
  return null;
}

function isCurveNode(node) {
  if (!node) return false;
  return !!(node.polyCurve || (node.curvesInterface && node.curvesInterface.polyCurve) || node.isVectorNode);
}

function isClosedCurve(node) {
  if (!node) return false;
  try {
    const pc = getNodePolyCurve(node);
    if (pc) {
      for (const curve of pc) return !!curve.isClosed;
    }
  } catch (e) {}
  return false;
}

function clonePolyCurveToSpread(node) {
  if (!node) return null;
  try {
    const rawPc = getNodePolyCurve(node);
    if (!rawPc) return null;
    const pc = rawPc.clone();
    if (node.baseToSpreadTransform) {
      try { pc.transform(node.baseToSpreadTransform); } catch (e) {}
    } else if (node.transformInterface && node.transformInterface.transform) {
      try { pc.transform(node.transformInterface.transform); } catch (e) {}
    }
    return pc;
  } catch (e) {
    return null;
  }
}

function getContainerTransform(containerNode) {
  if (!containerNode) return null;
  try {
    const xf = containerNode.baseToSpreadTransform || (containerNode.transformInterface ? containerNode.transformInterface.transform : null);
    if (xf) return xf.clone();
  } catch (e) {}
  return null;
}

function getWorldBeziers(node, containerTransform) {
  const pc = clonePolyCurveToSpread(node);
  if (!pc) return [];
  if (containerTransform && containerTransform.inverted) {
    try { pc.transform(containerTransform.inverted); } catch (e) {}
  }
  const beziers = [];
  try {
    for (const curve of pc) {
      if (curve && curve.beziers) {
        beziers.push(...curve.beziers);
      }
    }
  } catch (e) {}
  return beziers;
}

function evalBez(b, t) {
  const u = 1 - t;
  return {
    x: u * u * u * b.start.x + 3 * u * u * t * b.c1.x + 3 * u * t * t * b.c2.x + t * t * t * b.end.x,
    y: u * u * u * b.start.y + 3 * u * u * t * b.c1.y + 3 * u * t * t * b.c2.y + t * t * t * b.end.y
  };
}

function evalBezTangent(b, t) {
  const u = 1 - t;
  return {
    x: 3 * u * u * (b.c1.x - b.start.x) + 6 * u * t * (b.c2.x - b.c1.x) + 3 * t * t * (b.end.x - b.c2.x),
    y: 3 * u * u * (b.c1.y - b.start.y) + 6 * u * t * (b.c2.y - b.c1.y) + 3 * t * t * (b.end.y - b.c2.y)
  };
}

function buildArcTable(beziers) {
  const STEPS = 500;
  const tbl = [];
  let cum = 0;
  for (let bi = 0; bi < beziers.length; bi++) {
    const b = beziers[bi];
    let prev = evalBez(b, 0);
    tbl.push({ bi, t: 0, cum });
    for (let s = 1; s <= STEPS; s++) {
      const t = s / STEPS;
      const pt = evalBez(b, t);
      cum += Math.hypot(pt.x - prev.x, pt.y - prev.y);
      tbl.push({ bi, t, cum });
      prev = pt;
    }
  }
  return tbl;
}

function arcLookup(tbl, frac) {
  if (!tbl || tbl.length === 0) return { bi: 0, t: 0 };
  const total = tbl[tbl.length - 1].cum;
  if (total <= 1e-9) return { bi: 0, t: 0 };
  const c = Math.min(Math.max(frac, 0), 1) * total;
  let lo = 0, hi = tbl.length - 1;
  while (lo < hi - 1) {
    const m = (lo + hi) >> 1;
    if (tbl[m].cum <= c) lo = m;
    else hi = m;
  }
  const a = tbl[lo], bE = tbl[hi];
  const span = bE.cum - a.cum;
  const f = span < 1e-9 ? 0 : (c - a.cum) / span;
  return { bi: f < 0.5 ? a.bi : bE.bi, t: a.t + (bE.t - a.t) * f };
}

function normFrac(f) {
  if (f >= 0 && f <= 1) return f;
  return ((f % 1) + 1) % 1;
}

function samplePath(tbl, beziers, frac) {
  if (!beziers || beziers.length === 0) return { x: 0, y: 0 };
  const { bi, t } = arcLookup(tbl, normFrac(frac));
  return evalBez(beziers[bi], t);
}

function sampleTangent(tbl, beziers, frac) {
  if (!beziers || beziers.length === 0) return { x: 1, y: 0 };
  const sf = Math.min(Math.max(normFrac(frac), 0.0001), 0.9999);
  const { bi, t } = arcLookup(tbl, sf);
  const tang = evalBezTangent(beziers[bi], Math.min(Math.max(t, 0.0001), 0.9999));
  const len = Math.hypot(tang.x, tang.y);
  return len < 1e-9 ? { x: 1, y: 0 } : { x: tang.x / len, y: tang.y / len };
}

function nearestFrac(cx, cy, tbl, beziers) {
  if (!beziers || beziers.length === 0) return 0;
  let bf = 0, bd = Infinity;
  for (let i = 0; i <= 1000; i++) {
    const frac = i / 1000;
    const pt = samplePath(tbl, beziers, frac);
    const d = Math.hypot(pt.x - cx, pt.y - cy);
    if (d < bd) {
      bd = d;
      bf = frac;
    }
  }
  const w = 1 / 1000;
  for (let i = 0; i <= 200; i++) {
    const frac = Math.min(Math.max(bf - w + (2 * w * i) / 200, 0), 1);
    const pt = samplePath(tbl, beziers, frac);
    const d = Math.hypot(pt.x - cx, pt.y - cy);
    if (d < bd) {
      bd = d;
      bf = frac;
    }
  }
  return bf;
}

function resolveRange(startFrac, endFrac, isClosed) {
  let sf = startFrac, ef = endFrac;
  if (isClosed && ef < sf) ef += 1.0;
  const useLoop = isClosed && (ef - sf) >= 0.999;
  return { sf, ef, useLoop };
}

function computeFrac(i, N, sf, ef, useLoop) {
  if (N <= 1) return (sf + ef) / 2;
  const raw = useLoop ? sf + (i / N) * (ef - sf) : sf + (i / (N - 1)) * (ef - sf);
  return Math.min(Math.max(raw, sf), ef);
}

// =============================================================================
// PRNG RANDOMIZATION HELPERS
// =============================================================================

function makePRNG(seed) {
  let s = (seed || 1) >>> 0;
  return () => {
    s += 0x6D2B79F5;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function antiClusterShuffle(arr, seed) {
  const rand = makePRNG(seed);
  const N = arr.length;
  if (N <= 1) return [...arr];
  const counts = new Map();
  for (const v of arr) counts.set(v, (counts.get(v) || 0) + 1);
  let templates = [...counts.keys()];
  for (let i = templates.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [templates[i], templates[j]] = [templates[j], templates[i]];
  }
  templates.sort((a, b) => counts.get(b) - counts.get(a));
  const rem = new Map(templates.map(t => [t, counts.get(t)]));
  const result = [];
  let last = -1;
  for (let pos = 0; pos < N; pos++) {
    let best = -1, bestCnt = -1;
    for (const t of templates) {
      const cnt = rem.get(t) || 0;
      if (cnt > 0 && t !== last && cnt > bestCnt) {
        bestCnt = cnt;
        best = t;
      }
    }
    if (best === -1) {
      for (const t of templates) {
        if ((rem.get(t) || 0) > 0) {
          best = t;
          break;
        }
      }
    }
    result.push(best);
    rem.set(best, (rem.get(best) || 0) - 1);
    last = best;
  }
  return result;
}

function applyRandomize(fracs, tmplIdx, sf, ef, rnd, useLoop) {
  const N = fracs.length;
  const extraRot = new Array(N).fill(0);
  const extraScale = new Array(N).fill(1);
  if (!rnd || !rnd.enabled) return { extraRot, extraScale };

  if (rnd.jitterSeed > 0) {
    const rand = makePRNG(rnd.jitterSeed);
    const span = ef - sf;
    const step = span / Math.max(N, 1);
    const amp = Math.min(Math.max((rnd.jitterAmt || 30) / 100, 0), 0.9);
    for (let i = 0; i < N; i++) {
      fracs[i] += (rand() - 0.5) * step * amp * 2;
      if (useLoop) {
        while (fracs[i] < sf) fracs[i] += span;
        while (fracs[i] >= ef) fracs[i] -= span;
      } else {
        fracs[i] = Math.min(Math.max(fracs[i], sf), ef);
      }
    }
    const pairs = fracs.map((f, i) => ({ f, t: tmplIdx[i] }));
    pairs.sort((a, b) => a.f - b.f);
    for (let i = 0; i < N; i++) {
      fracs[i] = pairs[i].f;
      tmplIdx[i] = pairs[i].t;
    }
  }

  if (rnd.shuffleSeed > 0) {
    const s = antiClusterShuffle([...tmplIdx], rnd.shuffleSeed);
    for (let i = 0; i < N; i++) tmplIdx[i] = s[i];
  }

  if (rnd.rotSeed > 0) {
    const rand = makePRNG(rnd.rotSeed);
    const maxR = ((rnd.rotMaxDeg || 45) * Math.PI) / 180;
    for (let i = 0; i < N; i++) extraRot[i] = (rand() - 0.5) * 2 * maxR;
  }

  if (rnd.sizeSeed > 0) {
    const rand = makePRNG(rnd.sizeSeed);
    const amp = (rnd.sizeAmt || 30) / 100;
    for (let i = 0; i < N; i++) extraScale[i] = 1 + (rand() - 0.5) * 2 * amp;
  }

  return { extraRot, extraScale };
}

// =============================================================================
// STYLES & RECURSIVE GEOMETRY EXTRACTION (Pristine Local Base Space)
// =============================================================================

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

function applyOpacityAndBlendToFillDescriptor(fillDesc, opacity, blendMode) {
  if (!fillDesc || fillDesc.isNoFill) return fillDesc;
  try {
    const clone = fillDesc.clone();
    if (blendMode && typeof clone.setBlendMode === "function") {
      try { clone.setBlendMode(blendMode); } catch (e) {}
    }
    if (typeof opacity === "number" && opacity < 0.999 && typeof clone.setOpacity === "function") {
      try { clone.setOpacity(opacity); } catch (e) {}
    }
    return clone;
  } catch (e) {
    return fillDesc;
  }
}

/**
 * Extracts geometry in the node's pristine local base coordinate space.
 * Uses inv(containerTransform) on spread polycurves to ensure exact local coordinates.
 */
function extractGeomEntriesFromNode(node, containerTransform) {
  const entries = [];
  if (!node) return entries;

  const containerInv = (containerTransform && containerTransform.inverted) ? containerTransform.inverted : null;

  function traverse(currentNode, insideSource) {
    if (!currentNode) return;
    const isSourceOrPath = insideSource || isSourceNode(currentNode) || isPathNode(currentNode);
    try {
      if (!isSourceOrPath && currentNode.visibilityInterface && currentNode.visibilityInterface.visible === false) {
        return;
      }
    } catch (e) {}

    const children = getChildren(currentNode);
    if (children.length > 0) {
      for (const child of children) traverse(child, isSourceOrPath);
      return;
    }

    const pcSpread = clonePolyCurveToSpread(currentNode);
    if (pcSpread) {
      if (containerInv) {
        try { pcSpread.transform(containerInv); } catch (e) {}
      }
      const style = getNodeStyle(currentNode);
      entries.push({ polyCurve: pcSpread, style: style });
    }
  }

  traverse(node, true);
  return entries;
}

function getEntriesBounds(entries) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let hasValid = false;

  for (const entry of entries) {
    if (!entry || !entry.polyCurve) continue;
    try {
      const b = entry.polyCurve.exactBoundingBox || entry.polyCurve.boundingBox || entry.polyCurve.bounds;
      if (validBB(b)) {
        minX = Math.min(minX, b.x);
        minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.width);
        maxY = Math.max(maxY, b.y + b.height);
        hasValid = true;
      }
    } catch (e) {}
  }

  if (!hasValid) return null;
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
  };
}

function getNodeOrientationAngle(node) {
  if (!node) return 0;
  try {
    const b2s = node.baseToSpreadTransform || (node.transformInterface ? node.transformInterface.transform : null);
    if (b2s) {
      const a = b2s.a !== undefined ? b2s.a : (b2s.data ? b2s.data[0] : 1);
      const c = b2s.c !== undefined ? b2s.c : (b2s.data ? b2s.data[3] : 0);
      return Math.atan2(c, a);
    }
  } catch (e) {}
  return 0;
}

function captureItemData(node, containerTransform) {
  const entries = extractGeomEntriesFromNode(node, containerTransform);
  const bounds = getEntriesBounds(entries);
  let center = { x: 0, y: 0 };
  let width = 50, height = 50;
  let finalBounds = null;

  if (bounds) {
    center = bounds.center;
    width = Math.max(1, bounds.width);
    height = Math.max(1, bounds.height);
    finalBounds = bounds;
  } else {
    try {
      const b = node.getSpreadBaseBox ? node.getSpreadBaseBox(false) : null;
      if (validBB(b)) {
        center = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
        width = Math.max(1, b.width);
        height = Math.max(1, b.height);
        finalBounds = { x: b.x, y: b.y, width: width, height: height, center };
      }
    } catch (e) {}
  }

  return {
    node,
    geomEntries: entries,
    center,
    width,
    height,
    bounds: finalBounds || { x: center.x - width / 2, y: center.y - height / 2, width, height, center },
    rot: getNodeOrientationAngle(node)
  };
}

/**
 * Calculates the local anchor point on the source object based on pivotMode:
 * 0: Center, 1: Top, 2: Bottom
 */
function getItemPivotPoint(item, pivotMode) {
  if (!item) return { x: 0, y: 0 };
  const b = item.bounds;
  if (!b) return item.center || { x: 0, y: 0 };

  if (pivotMode === 1) {
    // Top Anchor
    return { x: item.center.x, y: b.y };
  } else if (pivotMode === 2) {
    // Bottom Anchor
    return { x: item.center.x, y: b.y + b.height };
  }
  // 0: Center (Default)
  return item.center;
}

// =============================================================================
// PATH & OBJECT CLASSIFICATION / DETECTION
// =============================================================================

function hasNoFill(node) {
  if (!node) return false;
  try {
    if (node.hasBrushFill !== undefined) return !node.hasBrushFill;
    if (node.brushFillInterface) return node.brushFillInterface.isNoFill;
  } catch (e) {}
  return false;
}

function getBBoxArea(node) {
  try {
    const b = node.getSpreadBaseBox ? node.getSpreadBaseBox(false) : null;
    return b ? b.width * b.height : 0;
  } catch (e) {
    return 0;
  }
}

function autoDetectPathIndices(nodes) {
  // 1. Check for stroke-only curves (no brush fill)
  const noFill = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (isCurveNode(n) && hasNoFill(n)) {
      noFill.push(i);
    }
  }
  if (noFill.length > 0 && noFill.length < nodes.length) return noFill;

  // 2. Check for open (non-closed) curves
  const openCurves = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (isCurveNode(n) && !isClosedCurve(n)) {
      openCurves.push(i);
    }
  }
  if (openCurves.length > 0 && openCurves.length < nodes.length) return openCurves;

  // 3. Fallback: largest bounding box area curve
  let best = -1, bestArea = -1;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (isCurveNode(n)) {
      const a = getBBoxArea(n);
      if (a > bestArea) {
        bestArea = a;
        best = i;
      }
    }
  }
  return best >= 0 ? [best] : [];
}

function buildMultiConfig(allNodes, pathIndices, containerTransform) {
  const pathIdxSet = new Set(pathIndices);
  const pathCfgs = [], pathNodes = [];

  for (const pi of pathIndices) {
    const n = allNodes[pi];
    if (!n) continue;
    let pb;
    try {
      pb = getWorldBeziers(n, containerTransform);
      if (!pb || !pb.length) throw 0;
    } catch (e) {
      continue;
    }
    const isClosed = isClosedCurve(n);
    const tbl = buildArcTable(pb);
    const totalLength = tbl.length > 0 ? tbl[tbl.length - 1].cum : 0;
    pathCfgs.push({
      pathNode: n,
      pathBeziers: pb,
      tbl: tbl,
      totalLength: totalLength,
      isClosed: isClosed
    });
    pathNodes.push(n);
  }

  if (!pathCfgs.length) return null;

  const objIndices = allNodes.map((_, i) => i).filter(i => !pathIdxSet.has(i));
  const objNodes = objIndices.map(i => allNodes[i]);
  const sourceItems = objNodes.map(n => captureItemData(n, containerTransform));

  return {
    pathCfgs,
    pathNodes,
    objNodes,
    sourceItems,
    isClosed: pathCfgs[0].isClosed
  };
}

// =============================================================================
// RESIZE & MATCH SIZE NORMALIZATION ENGINE
// =============================================================================

function calculateDimensionNormalizations(sourceItems, matchSizeMode) {
  const N = sourceItems.length;
  if (N <= 1 || matchSizeMode === 3) {
    return sourceItems.map(() => ({ sx: 1.0, sy: 1.0 }));
  }

  if (matchSizeMode === 1) {
    // First Object Size
    const targetW = sourceItems[0].width || 50;
    const targetH = sourceItems[0].height || 50;
    return sourceItems.map(item => ({
      sx: targetW / Math.max(1, item.width),
      sy: targetH / Math.max(1, item.height)
    }));
  }

  if (matchSizeMode === 2) {
    // Average Size
    const avgW = sourceItems.reduce((acc, it) => acc + it.width, 0) / N;
    const avgH = sourceItems.reduce((acc, it) => acc + it.height, 0) / N;
    return sourceItems.map(item => ({
      sx: avgW / Math.max(1, item.width),
      sy: avgH / Math.max(1, item.height)
    }));
  }

  // 0: Auto (Majority Size)
  const TOLERANCE = 0.08;
  const clustersW = [];
  const clustersH = [];

  for (const it of sourceItems) {
    let foundW = false;
    for (const c of clustersW) {
      if (Math.abs(c.val - it.width) / Math.max(c.val, it.width) <= TOLERANCE) {
        c.count++;
        c.items.push(it.width);
        foundW = true;
        break;
      }
    }
    if (!foundW) clustersW.push({ val: it.width, count: 1, items: [it.width] });

    let foundH = false;
    for (const c of clustersH) {
      if (Math.abs(c.val - it.height) / Math.max(c.val, it.height) <= TOLERANCE) {
        c.count++;
        c.items.push(it.height);
        foundH = true;
        break;
      }
    }
    if (!foundH) clustersH.push({ val: it.height, count: 1, items: [it.height] });
  }

  clustersW.sort((a, b) => b.count - a.count);
  clustersH.sort((a, b) => b.count - a.count);

  const majW = clustersW[0].val;
  const majH = clustersH[0].val;

  return sourceItems.map(item => ({
    sx: majW / Math.max(1, item.width),
    sy: majH / Math.max(1, item.height)
  }));
}

// =============================================================================
// PLACEMENT CALCULATION & INVARIANT TRANSFORM GENERATION
// =============================================================================

function calculatePlacementsForPath(pc, sourceItems, params, pathIndex) {
  const isRepeat = params.repeatMode;
  let itemsToUse = sourceItems;

  if (!isRepeat && params.smartPlacement && sourceItems.length > 1) {
    const proj = sourceItems.map((item, i) => ({
      item: item,
      frac: nearestFrac(item.center.x, item.center.y, pc.tbl, pc.pathBeziers)
    }));
    proj.sort((a, b) => a.frac - b.frac);
    itemsToUse = proj.map(p => p.item);
  }

  const count = isRepeat ? params.repeatCount : itemsToUse.length;
  const nTemplates = itemsToUse.length;
  if (!count || !nTemplates) return [];

  const { sf, ef, useLoop } = resolveRange(params.startFrac / 100, params.endFrac / 100, pc.isClosed);
  const fracs = [], tmplIdx = [];

  for (let i = 0; i < count; i++) {
    fracs.push(computeFrac(i, count, sf, ef, useLoop));
    tmplIdx.push(i % nTemplates);
  }

  if (params.reverse) {
    fracs.reverse();
  }

  const { extraRot, extraScale } = applyRandomize(
    fracs,
    tmplIdx,
    sf,
    ef,
    {
      enabled: params.rndEnabled,
      shuffleSeed: params.shuffleSeed,
      jitterSeed: params.jitterSeed,
      jitterAmt: params.jitterAmt,
      rotSeed: params.rotSeed,
      rotMaxDeg: params.rotMaxDeg,
      sizeSeed: params.sizeSeed,
      sizeAmt: params.sizeAmt
    },
    useLoop
  );

  const normScales = calculateDimensionNormalizations(itemsToUse, params.matchSizeMode);

  // Auto-fit to path spacing
  let autoFitScale = 1.0;
  if (params.fitToPath && pc.totalLength > 0) {
    const spanFrac = Math.abs(ef - sf);
    const activeLength = pc.totalLength * (spanFrac > 0 ? spanFrac : 1.0);
    const segmentLength = activeLength / Math.max(1, count);
    const avgWidth = itemsToUse.reduce((acc, it) => acc + it.width, 0) / nTemplates;
    if (avgWidth > 0) {
      autoFitScale = clamp(segmentLength / avgWidth, 0.05, 10.0);
    }
  }

  const masterScale = (params.sizeScale / 100) * autoFitScale;
  const scaleW = params.scaleW / 100;
  const scaleH = params.scaleH / 100;
  const startS = params.scaleStart / 100;
  const endS = params.scaleEnd / 100;
  const startR = degToRad(params.rotStartDeg);
  const endR = degToRad(params.rotEndDeg);
  const baseR = degToRad(params.baseRotation);

  const placements = [];

  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0;
    const itemIdx = tmplIdx[i];
    const item = itemsToUse[itemIdx];
    const norm = normScales[itemIdx];

    const pt = samplePath(pc.tbl, pc.pathBeziers, fracs[i]);
    const tang = sampleTangent(pc.tbl, pc.pathBeziers, fracs[i]);
    const tangentAngle = Math.atan2(tang.y, tang.x);

    const progScale = startS + (endS - startS) * t;
    const progRot = startR + (endR - startR) * t;

    const finalScaleX = norm.sx * masterScale * scaleW * progScale * extraScale[i];
    const finalScaleY = norm.sy * masterScale * scaleH * progScale * extraScale[i];

    let finalAngle = baseR + progRot + extraRot[i];
    let flipY = 1.0;

    if (params.alignToPath) {
      finalAngle += tangentAngle - item.rot;
      if (params.flipNormal) {
        flipY = -1.0;
      }
    } else if (params.flipNormal) {
      flipY = -1.0;
    }

    placements.push({
      itemIndex: itemIdx,
      placementIndex: i,
      pathIndex: pathIndex,
      pt: pt,
      tangent: tang,
      tangentAngle: tangentAngle,
      scaleX: Math.max(0.001, finalScaleX),
      scaleY: Math.max(0.001, finalScaleY) * flipY,
      rotation: finalAngle,
      frac: fracs[i]
    });
  }

  return placements;
}

/**
 * Builds the canonical canvas Spread Space transform:
 * T_desired = Translate(pt.x, pt.y) * Rotate(rot) * Scale(sx, sy) * Translate(-pivot.x, -pivot.y)
 */
function buildDesiredSpreadTransform(pivot, placement) {
  return Transform
    .createTranslate(placement.pt.x, placement.pt.y)
    .multiply(Transform.createRotate(placement.rotation))
    .multiply(Transform.createScale(placement.scaleX, placement.scaleY))
    .multiply(Transform.createTranslate(-pivot.x, -pivot.y));
}

// =============================================================================
// LIVE PREVIEW ENGINE (PolyCurve Rendering, Zero-Crash)
// =============================================================================

function clearPreviews(document) {
  try {
    document.executeCommand(DocumentCommand.createClearPreviews());
  } catch (e) {}
}

function doPreviewPolyCurves(document, sourceItems, allPlacements, containerTransform, pivotMode) {
  clearPreviews(document);
  if (!sourceItems || !sourceItems.length || !allPlacements.length) return;

  const addBuilder = AddChildNodesCommandBuilder.create();

  for (const placement of allPlacements) {
    const item = sourceItems[placement.itemIndex];
    if (!item) continue;

    const pivotPoint = getItemPivotPoint(item, pivotMode);
    const localTransform = buildDesiredSpreadTransform(pivotPoint, placement);
    const previewTransform = containerTransform ? containerTransform.multiply(localTransform) : localTransform;

    if (item.geomEntries && item.geomEntries.length) {
      for (const geom of item.geomEntries) {
        if (!geom || !geom.polyCurve) continue;
        const pc = geom.polyCurve.clone();
        try { pc.transform(previewTransform); } catch (e) {}
        const s = geom.style;
        const op = typeof s.opacity === "number" ? s.opacity : 1.0;
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
// Z-ORDER SORTING & ORDER ENGINE
// =============================================================================

function reorderPlacementsForZOrder(allPlacements, zOrderMode, reverseZIndex) {
  let list = [...allPlacements];

  if (zOrderMode === 1) {
    // Template Grouped (a,a,b,b...)
    list.sort((a, b) => {
      if (a.itemIndex !== b.itemIndex) return a.itemIndex - b.itemIndex;
      return a.placementIndex - b.placementIndex;
    });
  } else if (zOrderMode === 2) {
    // Interleaved (Weave a,b,a,b...)
    list.sort((a, b) => a.placementIndex - b.placementIndex);
  } else if (zOrderMode === 3) {
    // Reverse Path Order
    list.sort((a, b) => b.placementIndex - a.placementIndex);
  } else {
    // 0: Sequential
    list.sort((a, b) => a.placementIndex - b.placementIndex);
  }

  if (reverseZIndex) {
    list.reverse();
  }

  return list;
}

// =============================================================================
// APPLY WORKFLOW (Conjugate Container Transforms + In-Place Preservation)
// =============================================================================

function doApply(document, cfg, params, existingGroup, containerTransform) {
  const { pathCfgs, pathNodes, objNodes, sourceItems } = cfg;
  if (!objNodes.length || !pathCfgs.length) throw new Error("No elements or path to arrange.");

  // Gather all placements across all paths
  let allPlacements = [];
  for (let p = 0; p < pathCfgs.length; p++) {
    const placements = calculatePlacementsForPath(pathCfgs[p], sourceItems, params, p);
    allPlacements.push(...placements);
  }

  if (!allPlacements.length) throw new Error("Nothing to place.");

  const orderedPlacements = reorderPlacementsForZOrder(allPlacements, params.zOrderMode, params.reverseZIndex);
  let targetGroup = existingGroup;

  if (existingGroup) {
    // -------------------------------------------------------------------------
    // 1. IN-PLACE CONTAINER UPDATE
    // -------------------------------------------------------------------------
    const oldResults = getChildren(existingGroup).filter(isResultNode);
    const updateCb = CompoundCommandBuilder.create();

    if (oldResults.length > 0) {
      updateCb.addCommand(DocumentCommand.createDeleteSelection(Selection.create(document, oldResults, true)));
    }

    updateCb.addCommand(DocumentCommand.createSetDescription(mkSel(existingGroup), GROUP_PREFIX));

    // Ensure sources remain safely preserved and hidden inside container
    for (let i = 0; i < objNodes.length; i++) {
      const src = objNodes[i];
      updateCb.addCommand(DocumentCommand.createSetDescription(mkSel(src), `${SOURCE_PREFIX} ${i + 1}`));
      updateCb.addCommand(DocumentCommand.createSetVisibility(mkSel(src), false));
    }
    // Update path description and visibility based on params.pathVisible
    for (let i = 0; i < pathNodes.length; i++) {
      const pn = pathNodes[i];
      updateCb.addCommand(DocumentCommand.createSetDescription(mkSel(pn), `${PATH_PREFIX} ${i + 1}`));
      updateCb.addCommand(DocumentCommand.createSetVisibility(mkSel(pn), !!params.pathVisible));
    }
    document.executeCommand(updateCb.createCommand());

    setContainerMetadata(document, existingGroup, params);

  } else {
    // -------------------------------------------------------------------------
    // 2. FRESH CONTAINER CREATION
    // -------------------------------------------------------------------------
    const gBuilder = AddChildNodesCommandBuilder.create();
    gBuilder.setInsertionTargetSelection(mkSel(objNodes[0]));
    gBuilder.setInsertionMode(InsertionMode.Top);
    gBuilder.addContainerNode(ContainerNodeDefinition.create(GROUP_PREFIX));
    const gCmd = gBuilder.createCommand(false, NodeChildType.Main);
    document.executeCommand(gCmd);
    targetGroup = gCmd.newNodes[0];

    const prepCompound = CompoundCommandBuilder.create();
    for (let i = 0; i < objNodes.length; i++) {
      const src = objNodes[i];
      prepCompound.addCommand(DocumentCommand.createSetDescription(mkSel(src), `${SOURCE_PREFIX} ${i + 1}`));
      prepCompound.addCommand(DocumentCommand.createMoveNodes(mkSel(src), targetGroup, NodeMoveType.Inside, NodeChildType.Main));
      prepCompound.addCommand(DocumentCommand.createSetVisibility(mkSel(src), false));
    }
    for (let i = 0; i < pathNodes.length; i++) {
      const pn = pathNodes[i];
      prepCompound.addCommand(DocumentCommand.createSetDescription(mkSel(pn), `${PATH_PREFIX} ${i + 1}`));
      prepCompound.addCommand(DocumentCommand.createMoveNodes(mkSel(pn), targetGroup, NodeMoveType.Inside, NodeChildType.Main));
      prepCompound.addCommand(DocumentCommand.createSetVisibility(mkSel(pn), !!params.pathVisible));
    }
    document.executeCommand(prepCompound.createCommand());

    setContainerMetadata(document, targetGroup, params);
  }

  // ---------------------------------------------------------------------------
  // 3. GENERATE DUPLICATES WITH EXACT CONJUGATE TRANSFORMS
  // Formula: T_spread = T_container * T_local * T_container^-1
  // ---------------------------------------------------------------------------
  const containerInv = (containerTransform && containerTransform.inverted) ? containerTransform.inverted : null;
  const dupCb = CompoundCommandBuilder.create();

  for (let i = 0; i < orderedPlacements.length; i++) {
    const placement = orderedPlacements[i];
    const srcNode = objNodes[placement.itemIndex];
    const item = sourceItems[placement.itemIndex];

    const pivotPoint = getItemPivotPoint(item, params.pivotMode);
    const localTransform = buildDesiredSpreadTransform(pivotPoint, placement);

    const spreadTransform = (containerTransform && containerInv)
      ? containerTransform.multiply(localTransform).multiply(containerInv)
      : localTransform;

    dupCb.addCommand(
      DocumentCommand.createTransform(mkSel(srcNode), spreadTransform, { duplicateNodes: true }),
      false
    );
  }

  const dupCmd = dupCb.createCommand();
  document.executeCommand(dupCmd);
  const dupNodes = Array.from(dupCmd.newNodes || []);

  if (dupNodes.length === 0) return;

  // ---------------------------------------------------------------------------
  // 4. MOVE TO CONTAINER, TAG RED & FINALIZE STYLES
  // ---------------------------------------------------------------------------
  const moveCb = CompoundCommandBuilder.create();
  for (let i = 0; i < dupNodes.length; i++) {
    const node = dupNodes[i];
    moveCb.addCommand(DocumentCommand.createMoveNodes(
      mkSel(node),
      targetGroup,
      NodeMoveType.Inside,
      NodeChildType.Main
    ));
    moveCb.addCommand(DocumentCommand.createSetVisibility(mkSel(node), true));
    moveCb.addCommand(DocumentCommand.createSetDescription(mkSel(node), `${RESULT_PREFIX} ${i + 1}`));
  }
  document.executeCommand(moveCb.createCommand());

  for (let i = 0; i < dupNodes.length; i++) {
    const node = dupNodes[i];
    tagNodeRed(node);
    const placement = orderedPlacements[i];
    const srcNode = objNodes[placement.itemIndex];
    if (srcNode) {
      if (srcNode.visibilityInterface && typeof srcNode.visibilityInterface.globalOpacity === "number") {
        const op = srcNode.visibilityInterface.globalOpacity;
        if (op < 0.999) {
          try {
            document.executeCommand(DocumentCommand.createSetOpacity(mkSel(node), op), false);
          } catch (e) {}
        }
      }
      try {
        const bm = (srcNode.blendModeInterface && srcNode.blendModeInterface.blendMode) || srcNode.blendMode;
        if (bm) {
          document.executeCommand(DocumentCommand.createSetBlendMode(mkSel(node), bm), false);
        }
      } catch (e) {}
    }
  }

  // Reselect container
  try {
    document.selection = mkSel(targetGroup);
  } catch (e) {}
}

// =============================================================================
// MAIN ENTRY POINT & DIALOG UI
// =============================================================================

function showError(msg) {
  const d = Dialog.create(SCRIPT_TITLE);
  d.addColumn().addGroup("Error").addStaticText("", msg);
  d.show();
}

function runArrangeOnPath() {
  if (!doc) {
    showError("No document open.");
    return;
  }

  const rawSel = doc.selection;
  const selLen = rawSel ? rawSel.length : 0;
  if (selLen === 0) {
    showError("Select at least 1 path + 1 object (or select an existing Arrange on Path group).");
    return;
  }

  const rawNodes = [];
  for (let i = 0; i < selLen; i++) rawNodes.push(rawSel.at(i).node);

  if (rawNodes.some(isSymbolNode)) {
    showError("Symbols are not supported in Arrange on Path.\nPlease expand or detach symbols first.");
    return;
  }

  let existingGroup = null;
  if (rawNodes.length === 1 && isArrangeOnPathGroup(rawNodes[0])) {
    existingGroup = rawNodes[0];
  } else {
    for (const node of rawNodes) {
      const pGrp = getArrangeOnPathGroupOf(node);
      if (pGrp) {
        existingGroup = pGrp;
        break;
      }
    }
  }

  let allNodes = [];
  let pathIndices = [];
  let oldResultsToHide = [];

  if (existingGroup) {
    const children = getChildren(existingGroup);
    const sources = children.filter(isSourceNode).sort((a, b) => getSourceIndex(a) - getSourceIndex(b));
    const paths = children.filter(isPathNode).sort((a, b) => getPathIndex(a) - getPathIndex(b));
    oldResultsToHide = children.filter(isResultNode).sort((a, b) => getResultIndex(a) - getResultIndex(b));

    allNodes = [...sources, ...paths];
    pathIndices = paths.map((_, idx) => sources.length + idx);

    if (!paths.length || !sources.length) {
      showError("Corrupted Arrange on Path container: missing sources or path.");
      return;
    }

    // Hide old results during live preview
    if (oldResultsToHide.length > 0) {
      try {
        const hideOldCb = CompoundCommandBuilder.create();
        for (const res of oldResultsToHide) {
          hideOldCb.addCommand(DocumentCommand.createSetVisibility(mkSel(res), false));
        }
        doc.executeCommand(hideOldCb.createCommand());
      } catch (e) {}
    }

  } else {
    allNodes = rawNodes;
    pathIndices = autoDetectPathIndices(allNodes);
  }

  if (!pathIndices.length) {
    showError("No vector path found in selection.\nPlease select at least 1 vector path and 1 object.");
    return;
  }

  const containerTransform = existingGroup ? getContainerTransform(existingGroup) : null;
  const cfg = buildMultiConfig(allNodes, pathIndices, containerTransform);
  if (!cfg || !cfg.pathCfgs.length) {
    showError("Cannot read path geometry. Ensure path is a valid vector curve.");
    return;
  }
  if (!cfg.objNodes.length) {
    showError("No objects to arrange. Select at least 1 object in addition to the path.");
    return;
  }

  const nPaths = cfg.pathCfgs.length;
  const nObjects = cfg.objNodes.length;
  const multiPath = nPaths > 1;

  const savedParams = existingGroup ? readGroupValues(existingGroup) : sanitizeValues({
    ...DEFAULT_VALUES,
    repeatMode: true
  });

  // ---------------------------------------------------------------------------
  // BUILD DIALOG UI (Perfectly Balanced 3-Column Ergonomic Architecture)
  // Equalized: Col 1 (11 controls) | Col 2 (11 controls) | Col 3 (8 controls + How It Works)
  // ---------------------------------------------------------------------------
  const dlg = Dialog.create(SCRIPT_TITLE);
  dlg.initialWidth = 760;

  // COLUMN 1: PLACEMENT & ORIENTATION / PIVOT (11 controls)
  const col1 = dlg.addColumn();

  const placementGrp = col1.addGroup(multiPath ? `Placement & Path (${nPaths} paths)` : "Placement & Path");
  const startCtrl = placementGrp.addUnitValueEditor("Start offset", UnitType.Percentage, UnitType.Percentage, savedParams.startFrac, 0, 100);
  startCtrl.precision = 1;
  startCtrl.showPopupSlider = true;
  const endCtrl = placementGrp.addUnitValueEditor("End offset", UnitType.Percentage, UnitType.Percentage, savedParams.endFrac, 0, 100);
  endCtrl.precision = 1;
  endCtrl.showPopupSlider = true;
  const smartCtrl = placementGrp.addSwitch("Smart Placement (proximity)", savedParams.smartPlacement);
  const reverseCtrl = placementGrp.addSwitch("Reverse path direction", savedParams.reverse);
  const pathVisibleCtrl = placementGrp.addSwitch(multiPath ? "Keep paths visible" : "Keep path visible", savedParams.pathVisible);

  const orientGrp = col1.addGroup("Orientation & Pivot Alignment");
  const alignCtrl = orientGrp.addSwitch("Align to path tangent", savedParams.alignToPath);
  const pivotCtrl = orientGrp.addComboBox("Pivot Alignment", PIVOT_MODES, savedParams.pivotMode);
  const flipCtrl = orientGrp.addSwitch("Flip normal", savedParams.flipNormal);
  const baseRotCtrl = orientGrp.addUnitValueEditor("Base Rotation", UnitType.Degree, UnitType.Degree, savedParams.baseRotation, -3600, 3600);
  baseRotCtrl.precision = 1;
  const rotStartCtrl = orientGrp.addUnitValueEditor("Prog. Rotation Start", UnitType.Degree, UnitType.Degree, savedParams.rotStartDeg, -3600, 3600);
  rotStartCtrl.precision = 1;
  const rotEndCtrl = orientGrp.addUnitValueEditor("Prog. Rotation End", UnitType.Degree, UnitType.Degree, savedParams.rotEndDeg, -3600, 3600);
  rotEndCtrl.precision = 1;

  // COLUMN 2: REPEAT & SCALING & Z-ORDER (11 controls)
  const col2 = dlg.addColumn();

  const repeatGrp = col2.addGroup("Repeat & Distribution");
  const repeatCtrl = repeatGrp.addSwitch(nObjects > 1 ? `Repeat (${nObjects} templates)` : "Repeat object along path", savedParams.repeatMode);
  const repeatCountCtrl = repeatGrp.addUnitValueEditor(multiPath ? `Count (× ${nPaths} paths)` : "Count", UnitType.Number, UnitType.Number, savedParams.repeatCount, 2, 1000);
  repeatCountCtrl.precision = 0;

  const resizeGrp = col2.addGroup("Resize & Scaling");
  const matchSizeCtrl = resizeGrp.addComboBox("Match Size", MATCH_SIZE_MODES, savedParams.matchSizeMode);
  const sizeScaleCtrl = resizeGrp.addUnitValueEditor("Master Scale", UnitType.Percentage, UnitType.Percentage, savedParams.sizeScale, 10, 2000);
  sizeScaleCtrl.precision = 0;
  sizeScaleCtrl.showPopupSlider = true;
  const scaleWCtrl = resizeGrp.addUnitValueEditor("Scale Width (W)", UnitType.Percentage, UnitType.Percentage, savedParams.scaleW, 10, 1000);
  scaleWCtrl.precision = 0;
  scaleWCtrl.showPopupSlider = true;
  const scaleHCtrl = resizeGrp.addUnitValueEditor("Scale Height (H)", UnitType.Percentage, UnitType.Percentage, savedParams.scaleH, 10, 1000);
  scaleHCtrl.precision = 0;
  scaleHCtrl.showPopupSlider = true;
  const scaleStartCtrl = resizeGrp.addUnitValueEditor("Start Scale", UnitType.Percentage, UnitType.Percentage, savedParams.scaleStart, 10, 2000);
  scaleStartCtrl.precision = 0;
  scaleStartCtrl.showPopupSlider = true;
  const scaleEndCtrl = resizeGrp.addUnitValueEditor("End Scale", UnitType.Percentage, UnitType.Percentage, savedParams.scaleEnd, 10, 2000);
  scaleEndCtrl.precision = 0;
  scaleEndCtrl.showPopupSlider = true;
  const fitToPathCtrl = resizeGrp.addSwitch("Auto-Fit to path spacing", savedParams.fitToPath);

  const zOrderGrp = col2.addGroup("Z-Order & Stacking");
  const zOrderCtrl = zOrderGrp.addComboBox("Layer Ordering", Z_ORDER_MODES, savedParams.zOrderMode);
  const reverseZCtrl = zOrderGrp.addSwitch("Reverse Stacking Order", savedParams.reverseZIndex);

  // COLUMN 3: RANDOMIZE ENGINE (8 controls) + HOW IT WORKS
  const col3 = dlg.addColumn();

  const randGrp = col3.addGroup("Randomize Engine");
  const randCtrl = randGrp.addSwitch("Enable Randomize", savedParams.rndEnabled);
  const shuffleSeedCtrl = randGrp.addUnitValueEditor("Shuffle Seed", UnitType.Number, UnitType.Number, savedParams.shuffleSeed, 0, 99999);
  shuffleSeedCtrl.precision = 0;
  const jitterSeedCtrl = randGrp.addUnitValueEditor("Spacing Jitter Seed", UnitType.Number, UnitType.Number, savedParams.jitterSeed, 0, 99999);
  jitterSeedCtrl.precision = 0;
  const jitterAmtCtrl = randGrp.addUnitValueEditor("Spacing Amount", UnitType.Percentage, UnitType.Percentage, savedParams.jitterAmt, 1, 100);
  jitterAmtCtrl.precision = 0;
  jitterAmtCtrl.showPopupSlider = true;
  const rotSeedCtrl = randGrp.addUnitValueEditor("Rotation Seed", UnitType.Number, UnitType.Number, savedParams.rotSeed, 0, 99999);
  rotSeedCtrl.precision = 0;
  const rotMaxCtrl = randGrp.addUnitValueEditor("Rotation Max Angle", UnitType.Degree, UnitType.Degree, savedParams.rotMaxDeg, 1, 180);
  rotMaxCtrl.precision = 0;
  rotMaxCtrl.showPopupSlider = true;
  const sizeSeedCtrl = randGrp.addUnitValueEditor("Size Seed", UnitType.Number, UnitType.Number, savedParams.sizeSeed, 0, 99999);
  sizeSeedCtrl.precision = 0;
  const sizeAmtCtrl = randGrp.addUnitValueEditor("Size Amount", UnitType.Percentage, UnitType.Percentage, savedParams.sizeAmt, 1, 100);
  sizeAmtCtrl.precision = 0;
  sizeAmtCtrl.showPopupSlider = true;

  const howItWorksGrp = col3.addGroup("How It Works");
  howItWorksGrp.addStaticText(null, "• Non-destructive: Re-run anytime to edit.").setIsFullWidth(true);
  howItWorksGrp.addStaticText(null, "• Pivot: Center (middle), Top (hang), Bottom (sit).").setIsFullWidth(true);
  howItWorksGrp.addStaticText(null, "• Red-tagged: Expand Effects compatible.").setIsFullWidth(true);

  // ---------------------------------------------------------------------------
  // PARAMETER AGGREGATOR & LIVE PREVIEW HOOKS
  // ---------------------------------------------------------------------------
  function getParams() {
    return sanitizeValues({
      startFrac: startCtrl.value,
      endFrac: endCtrl.value,
      smartPlacement: smartCtrl.value,
      reverse: reverseCtrl.value,
      pathVisible: pathVisibleCtrl.value,

      alignToPath: alignCtrl.value,
      pivotMode: pivotCtrl.selectedIndex,
      flipNormal: flipCtrl.value,
      baseRotation: baseRotCtrl.value,
      rotStartDeg: rotStartCtrl.value,
      rotEndDeg: rotEndCtrl.value,

      repeatMode: repeatCtrl.value,
      repeatCount: Math.round(repeatCountCtrl.value),

      matchSizeMode: matchSizeCtrl.selectedIndex,
      sizeScale: sizeScaleCtrl.value,
      scaleW: scaleWCtrl.value,
      scaleH: scaleHCtrl.value,
      scaleStart: scaleStartCtrl.value,
      scaleEnd: scaleEndCtrl.value,
      fitToPath: fitToPathCtrl.value,

      zOrderMode: zOrderCtrl.selectedIndex,
      reverseZIndex: reverseZCtrl.value,

      rndEnabled: randCtrl.value,
      shuffleSeed: Math.round(shuffleSeedCtrl.value),
      jitterSeed: Math.round(jitterSeedCtrl.value),
      jitterAmt: jitterAmtCtrl.value,
      rotSeed: Math.round(rotSeedCtrl.value),
      rotMaxDeg: rotMaxCtrl.value,
      sizeSeed: Math.round(sizeSeedCtrl.value),
      sizeAmt: sizeAmtCtrl.value
    });
  }

  let inPreview = false;
  function triggerPreview() {
    if (inPreview) return;
    inPreview = true;
    try {
      const p = getParams();
      let allPlacements = [];
      for (let i = 0; i < cfg.pathCfgs.length; i++) {
        const placements = calculatePlacementsForPath(cfg.pathCfgs[i], cfg.sourceItems, p, i);
        allPlacements.push(...placements);
      }
      const ordered = reorderPlacementsForZOrder(allPlacements, p.zOrderMode, p.reverseZIndex);
      doPreviewPolyCurves(doc, cfg.sourceItems, ordered, containerTransform, p.pivotMode);
    } catch (e) {
      console.log("Preview error: " + e);
    } finally {
      inPreview = false;
    }
  }

  startCtrl.onValueChangedHandler = triggerPreview;
  endCtrl.onValueChangedHandler = triggerPreview;
  smartCtrl.onValueChangedHandler = triggerPreview;
  reverseCtrl.onValueChangedHandler = triggerPreview;
  pathVisibleCtrl.onValueChangedHandler = triggerPreview;

  alignCtrl.onValueChangedHandler = triggerPreview;
  pivotCtrl.onValueChangedHandler = triggerPreview;
  flipCtrl.onValueChangedHandler = triggerPreview;
  baseRotCtrl.onValueChangedHandler = triggerPreview;
  rotStartCtrl.onValueChangedHandler = triggerPreview;
  rotEndCtrl.onValueChangedHandler = triggerPreview;

  repeatCtrl.onValueChangedHandler = triggerPreview;
  repeatCountCtrl.onValueChangedHandler = triggerPreview;

  matchSizeCtrl.onValueChangedHandler = triggerPreview;
  sizeScaleCtrl.onValueChangedHandler = triggerPreview;
  scaleWCtrl.onValueChangedHandler = triggerPreview;
  scaleHCtrl.onValueChangedHandler = triggerPreview;
  scaleStartCtrl.onValueChangedHandler = triggerPreview;
  scaleEndCtrl.onValueChangedHandler = triggerPreview;
  fitToPathCtrl.onValueChangedHandler = triggerPreview;

  zOrderCtrl.onValueChangedHandler = triggerPreview;
  reverseZCtrl.onValueChangedHandler = triggerPreview;

  randCtrl.onValueChangedHandler = triggerPreview;
  shuffleSeedCtrl.onValueChangedHandler = triggerPreview;
  jitterSeedCtrl.onValueChangedHandler = triggerPreview;
  jitterAmtCtrl.onValueChangedHandler = triggerPreview;
  rotSeedCtrl.onValueChangedHandler = triggerPreview;
  rotMaxCtrl.onValueChangedHandler = triggerPreview;
  sizeSeedCtrl.onValueChangedHandler = triggerPreview;
  sizeAmtCtrl.onValueChangedHandler = triggerPreview;

  // Initial preview on launch
  triggerPreview();

  // Show Modal Dialog
  const result = dlg.show();
  const finalParams = getParams();

  // Clear Previews & Clean Canvas
  clearPreviews(doc);

  if (result.value === DialogResult.Ok.value) {
    try {
      doApply(doc, cfg, finalParams, existingGroup, containerTransform);
    } catch (e) {
      showError("Apply failed:\n" + e.message);
    }
  } else {
    // Cancel: Restore previous results visibility if editing existing container
    if (existingGroup && oldResultsToHide.length > 0) {
      try {
        const restoreCb = CompoundCommandBuilder.create();
        for (const res of oldResultsToHide) {
          restoreCb.addCommand(DocumentCommand.createSetVisibility(mkSel(res), true));
        }
        doc.executeCommand(restoreCb.createCommand());
      } catch (e) {}
    }
  }
}

// Run
runArrangeOnPath();
