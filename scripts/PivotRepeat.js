"use strict";

// =============================================================================
// PIVOT REPEAT v1daae (Procedural Pivot-Centric Array & Rotary/Floral Engine)
// Affinity Designer / Photo / Publisher (v3c+ Pipeline & Multi-Effect Standard)
//
// Features & Fixes in v1daae:
// - Fixed Layer Stacking / Z-Index Bug with Concentric Layers:
//   Previously, enabling 'Reverse Stacking Order' reversed the entire placement
//   array globally, causing Layer 0 (the large base repetition) to be placed on top
//   of all inner concentric rings and completely obscuring them.
//   Now:
//   - 'Reverse Stacking Order' cleanly reverses the petal overlap order WITHIN each
//     layer / ring around the circle (e.g. counter-clockwise fan overlap) while
//     preserving concentric layer visibility.
//   - Concentric rings (Layer 1, Layer 2...) always stack on top of base layers
//     so inner rosettes and rings remain 100% visible in Live Preview and applied vector geometry.
//   - Added 'Outer Rings on Top' switch in 'Concentric Layers / Rings' if the user
//     specifically wishes to place outer layers above inner ones.
// - Expanded & Supercharged 'Concentric Layers / Rings' Section:
//   1. 'Layers' (1 - 100 rings)
//   2. 'Layer Distance Step (px)': Radial spacing increment per concentric ring.
//   3. 'Layer Scaling (%)': Master progressive scale multiplier per layer.
//   4. 'Layer Width Scale (%)': Independent width scaling per layer.
//   5. 'Layer Height Scale (%)': Independent height scaling per layer.
//   6. 'Layer Rotation (deg)': Angular rotational step per layer.
//   7. 'Layer Item Spin (deg)': Individual shape rotation angle offset per layer.
//   8. 'Layer Radial Push (px)': Polar/spiral push increment per layer.
//   9. 'Added Copies Per Layer': Automatic copy count increase on outer rings.
//   10. 'Alternate Rotation Direction': Interlocking clockwise / counter-clockwise
//       alternation per layer (+θ, -θ, +θ...) for intricate mandalas & gears.
//   11. 'Outer Rings on Top': Explicit layer hierarchy control.
// - Original Object Dimensions Control:
//   - 'Width / Scale W (%)' & 'Height / Scale H (%)' in Column 1.
// - 'Distance from Origin (px)' Parameter in 'Pivot & Anchor Point':
//   Direct linear radial displacement from Transform Origin without swirl.
// - Both 'Distance from Origin' and 'Radial Push' Supported.
// - Tree-Aware & Recursive Style Synchronization (Group & Multi-Part Safe).
// - Robust Non-Uniform Container Transform Support (Conjugate Similarity Transforms).
// - Prominent Master 'Overall Size (%)' Parameter.
// - True Multi-Shape Alternation & Sequencing with Anchor Alignment.
// - Common Pivot Origin Invariance (T(P) = P).
// - 9-Point Spatial Anchor (SpatialAnchor.BottomCentre default).
// - 1:1 Live Preview & Output Conjugate Similarity Transform.
// - Standard Procedural Container Architecture (v3c/v3e Standard).
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
const { Dialog, DialogResult, HorizontalAlignment, SpatialAnchor } = require("/dialog");
const { Selection } = require("/selections");
const { UnitType } = require("/units");
const { RGB8 } = require("/colours");
const { FillDescriptor, BlendMode } = require("/fills");
const { LineStyleDescriptor } = require("/linestyle");
const { setTimeout } = require("/timers");

// =============================================================================
// CONSTANTS & REGISTRY
// =============================================================================

const SCRIPT_TITLE = "Pivot Repeat v1daae";
const TAG_KEY = "pivotRepeatSettings";
const GROUP_PREFIX = "Pivot Repeat Effect";
const SOURCE_PREFIX = "Source";
const RESULT_PREFIX = "Pivot Item";
const MAX_TOTAL_INSTANCES = 5000;

const DEFAULT_VALUES = {
  instances: 12,
  sizeScale: 1.0,
  scaleW: 1.0,       // Scale W (%) - Width of original object
  scaleH: 1.0,       // Scale H (%) - Height of original object
  fullCircle: true,
  totalAngle: 360,
  startAngle: 0,
  pivotAnchor: 6, // SpatialAnchor.BottomCentre (value: 6)
  pivotOffsetX: 0,
  pivotOffsetY: 0,
  originDistance: 0, // Distance from Transform Origin (px)
  radialPush: 0,     // Polar/Spiral Radial Push (px)
  startScale: 1.0,
  endScale: 1.0,
  itemSpin: 0,
  layers: 1,
  layerDistanceStep: 0, // Distance step between concentric rings (px)
  layerPushStep: 0,     // Radial push step between concentric rings (px)
  layerScale: 0.8,      // Master layer scaling
  layerScaleW: 1.0,     // Layer width scale (%)
  layerScaleH: 1.0,     // Layer height scale (%)
  layerRotation: 15,    // Layer rotation offset (deg)
  layerSpin: 0,         // Layer item spin offset (deg)
  addedInstancesPerLayer: 0,
  layerAltDirection: false, // Alternate rotation direction (+ / -) per layer
  reverseZIndex: false,     // Reverse item overlap order around circle per layer
  outerLayersOnTop: false,  // Layer stacking: false = Inner rings on top, true = Outer rings on top
  mixMode: 0, // 0 = Around Circle (by item), 1 = By Layer (concentric rings)
  shapePattern: "1.2"
};

const KNOWN_EFFECT_PREFIXES = [
  "Pivot Repeat Effect", "Radial Repeat Effect", "Zig Zag Effect", "Roughen Effect",
  "Pucker & Bloat", "Twist Effect", "Effects [", "Effect Container"
];

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

function getResultIndex(node) {
  const name = getNodeName(node);
  const m = name.match(/(?:Pivot Item|Radial Item|Result)\s+(\d+)/i);
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

function tagNodeRed(node) {
  if (!node) return;
  try {
    doc.executeCommand(DocumentCommand.createSetTagColour(mkSel(node), RGB8(255, 0, 0)), false);
  } catch (e) {}
}

function isPivotRepeatGroup(node) {
  if (!node) return false;
  try {
    if (node.tagInterface) {
      if (node.tagInterface.hasKey(TAG_KEY)) return true;
      if (node.tagInterface.hasKey("pivotRepeat")) return true;
      if (node.tagInterface.hasKey("effectPipeline")) {
        const json = node.tagInterface.getValueForKey("effectPipeline");
        if (json && json.indexOf("pivot_repeat") >= 0) return true;
      }
    }
  } catch (e) {}
  const name = getNodeName(node);
  if (name === GROUP_PREFIX || name.indexOf(GROUP_PREFIX) === 0 || name.indexOf("Pivot Repeat") === 0) return true;
  const children = getChildren(node);
  const hasSource = children.some(c => getNodeName(c).indexOf(SOURCE_PREFIX) === 0);
  const hasResult = children.some(c => hasRedTag(c) || getNodeName(c).indexOf(RESULT_PREFIX) === 0 || getNodeName(c).indexOf("Result") === 0);
  return hasSource && hasResult;
}

function isProceduralEffectContainer(node) {
  if (!node) return false;
  if (isPivotRepeatGroup(node)) return false;
  try {
    if (node.tagInterface && (
      node.tagInterface.hasKey("effectPipeline") ||
      node.tagInterface.hasKey("radialRepeatSettings") ||
      node.tagInterface.hasKey("zigZagSettings") ||
      node.tagInterface.hasKey("roughenSettings") ||
      node.tagInterface.hasKey("puckerBloatSettings") ||
      node.tagInterface.hasKey("twistSettings")
    )) return true;
  } catch (e) {}
  const name = getNodeName(node);
  for (const prefix of KNOWN_EFFECT_PREFIXES) {
    if (name.indexOf(prefix) === 0) return true;
  }
  const children = getChildren(node);
  const hasSource = children.some(c => getNodeName(c).indexOf("Source") === 0);
  const hasResult = children.some(c => hasRedTag(c) || getNodeName(c).indexOf("Result") === 0);
  return hasSource && hasResult;
}

function isResultNode(node) {
  if (!node) return false;
  if (hasRedTag(node)) return true;
  const name = getNodeName(node);
  if (name.indexOf(RESULT_PREFIX) === 0 || name.indexOf("Radial Item") === 0 || name.indexOf("Result") === 0) return true;
  return false;
}

function isSourceNode(node) {
  if (!node) return false;
  if (isResultNode(node)) return false;
  const name = getNodeName(node);
  return name.indexOf(SOURCE_PREFIX) === 0;
}

function getPivotRepeatGroupOf(node) {
  let current = node;
  while (current) {
    if (isPivotRepeatGroup(current)) return current;
    try { current = current.parent; } catch (e) { break; }
  }
  return null;
}

// =============================================================================
// SPATIAL ANCHOR & PIVOT HELPERS
// =============================================================================

function parseAnchorValue(val) {
  if (val === undefined || val === null) return SpatialAnchor.BottomCentre;
  if (typeof val === "object" && val.value !== undefined) return val;
  if (typeof val === "number") {
    switch (val) {
      case 1: return SpatialAnchor.TopLeft;
      case 2: return SpatialAnchor.CentreLeft;
      case 3: return SpatialAnchor.BottomLeft;
      case 4: return SpatialAnchor.TopCentre;
      case 5: return SpatialAnchor.Centre;
      case 6: return SpatialAnchor.BottomCentre;
      case 7: return SpatialAnchor.TopRight;
      case 8: return SpatialAnchor.CentreRight;
      case 9: return SpatialAnchor.BottomRight;
      default: return SpatialAnchor.BottomCentre;
    }
  }
  if (typeof val === "string") {
    const s = val.toLowerCase().replace(/[\s_-]/g, "");
    if (s.includes("topleft")) return SpatialAnchor.TopLeft;
    if (s.includes("topright")) return SpatialAnchor.TopRight;
    if (s.includes("topcentre") || s.includes("topcenter")) return SpatialAnchor.TopCentre;
    if (s.includes("bottomleft")) return SpatialAnchor.BottomLeft;
    if (s.includes("bottomright")) return SpatialAnchor.BottomRight;
    if (s.includes("bottomcentre") || s.includes("bottomcenter")) return SpatialAnchor.BottomCentre;
    if (s.includes("centreleft") || s.includes("centerleft")) return SpatialAnchor.CentreLeft;
    if (s.includes("centreright") || s.includes("centerright")) return SpatialAnchor.CentreRight;
    if (s.includes("centre") || s.includes("center")) return SpatialAnchor.Centre;
  }
  return SpatialAnchor.BottomCentre;
}

function getAnchorNumber(anchor) {
  if (anchor === undefined || anchor === null) return 6;
  if (typeof anchor === "number") return anchor;
  if (typeof anchor === "object" && typeof anchor.value === "number") return anchor.value;
  const parsed = parseAnchorValue(anchor);
  return (parsed && typeof parsed.value === "number") ? parsed.value : 6;
}

function getAnchorPoint(box, anchor) {
  if (!box) return { x: 0, y: 0 };
  const minX = box.x;
  const midX = box.x + box.width / 2;
  const maxX = box.x + box.width;
  const minY = box.y;
  const midY = box.y + box.height / 2;
  const maxY = box.y + box.height;

  const val = getAnchorNumber(anchor);

  switch (val) {
    case 1: return { x: minX, y: minY }; // TopLeft
    case 2: return { x: minX, y: midY }; // CentreLeft
    case 3: return { x: minX, y: maxY }; // BottomLeft
    case 4: return { x: midX, y: minY }; // TopCentre
    case 5: return { x: midX, y: midY }; // Centre
    case 6: return { x: midX, y: maxY }; // BottomCentre (Default for flowers/petals)
    case 7: return { x: maxX, y: minY }; // TopRight
    case 8: return { x: maxX, y: midY }; // CentreRight
    case 9: return { x: maxX, y: maxY }; // BottomRight
    default: return { x: midX, y: maxY };
  }
}

// =============================================================================
// PARAMETER SANITIZATION & METADATA (v3c/v3e Standard Storage)
// =============================================================================

function clamp(value, minValue, maxValue) {
  return Math.max(minValue, Math.min(maxValue, value));
}

function degToRad(value) {
  return (value * Math.PI) / 180;
}

function sanitizeValues(p, nodeCount) {
  const K = Math.max(1, nodeCount || 1);
  const layers = (p && typeof p.layers === "number" && !isNaN(p.layers)) ? clamp(Math.round(p.layers), 1, 100) : DEFAULT_VALUES.layers;
  const anchorNum = (p && p.pivotAnchor !== undefined) ? getAnchorNumber(p.pivotAnchor) : DEFAULT_VALUES.pivotAnchor;
  const mixMode = (p && typeof p.mixMode === "number" && !isNaN(p.mixMode)) ? clamp(Math.round(p.mixMode), 0, 1) : DEFAULT_VALUES.mixMode;

  return {
    instances: (p && typeof p.instances === "number" && !isNaN(p.instances)) ? clamp(Math.round(p.instances), 1, 500) : DEFAULT_VALUES.instances,
    sizeScale: (p && typeof p.sizeScale === "number" && !isNaN(p.sizeScale)) ? Math.max(0.01, p.sizeScale) : DEFAULT_VALUES.sizeScale,
    scaleW: (p && typeof p.scaleW === "number" && !isNaN(p.scaleW)) ? Math.max(0.01, p.scaleW) : DEFAULT_VALUES.scaleW,
    scaleH: (p && typeof p.scaleH === "number" && !isNaN(p.scaleH)) ? Math.max(0.01, p.scaleH) : DEFAULT_VALUES.scaleH,
    fullCircle: (p && p.fullCircle !== undefined) ? !!p.fullCircle : DEFAULT_VALUES.fullCircle,
    totalAngle: (p && typeof p.totalAngle === "number" && !isNaN(p.totalAngle)) ? clamp(p.totalAngle, -3600, 3600) : DEFAULT_VALUES.totalAngle,
    startAngle: (p && typeof p.startAngle === "number" && !isNaN(p.startAngle)) ? clamp(p.startAngle, -3600, 3600) : DEFAULT_VALUES.startAngle,
    pivotAnchor: anchorNum,
    pivotOffsetX: (p && typeof p.pivotOffsetX === "number" && !isNaN(p.pivotOffsetX)) ? clamp(p.pivotOffsetX, -100000, 100000) : DEFAULT_VALUES.pivotOffsetX,
    pivotOffsetY: (p && typeof p.pivotOffsetY === "number" && !isNaN(p.pivotOffsetY)) ? clamp(p.pivotOffsetY, -100000, 100000) : DEFAULT_VALUES.pivotOffsetY,
    originDistance: (p && typeof p.originDistance === "number" && !isNaN(p.originDistance)) ? clamp(p.originDistance, -100000, 100000) : DEFAULT_VALUES.originDistance,
    radialPush: (p && typeof p.radialPush === "number" && !isNaN(p.radialPush)) ? clamp(p.radialPush, -100000, 100000) : DEFAULT_VALUES.radialPush,
    startScale: (p && typeof p.startScale === "number" && !isNaN(p.startScale)) ? Math.max(0.01, p.startScale) : DEFAULT_VALUES.startScale,
    endScale: (p && typeof p.endScale === "number" && !isNaN(p.endScale)) ? Math.max(0.01, p.endScale) : DEFAULT_VALUES.endScale,
    itemSpin: (p && typeof p.itemSpin === "number" && !isNaN(p.itemSpin)) ? clamp(p.itemSpin, -3600, 3600) : DEFAULT_VALUES.itemSpin,
    layers: layers,
    layerDistanceStep: (p && typeof p.layerDistanceStep === "number" && !isNaN(p.layerDistanceStep)) ? clamp(p.layerDistanceStep, -100000, 100000) : DEFAULT_VALUES.layerDistanceStep,
    layerPushStep: (p && typeof p.layerPushStep === "number" && !isNaN(p.layerPushStep)) ? clamp(p.layerPushStep, -100000, 100000) : DEFAULT_VALUES.layerPushStep,
    layerScale: (p && typeof p.layerScale === "number" && !isNaN(p.layerScale)) ? Math.max(0.01, p.layerScale) : DEFAULT_VALUES.layerScale,
    layerScaleW: (p && typeof p.layerScaleW === "number" && !isNaN(p.layerScaleW)) ? Math.max(0.01, p.layerScaleW) : DEFAULT_VALUES.layerScaleW,
    layerScaleH: (p && typeof p.layerScaleH === "number" && !isNaN(p.layerScaleH)) ? Math.max(0.01, p.layerScaleH) : DEFAULT_VALUES.layerScaleH,
    layerRotation: (p && typeof p.layerRotation === "number" && !isNaN(p.layerRotation)) ? clamp(p.layerRotation, -3600, 3600) : DEFAULT_VALUES.layerRotation,
    layerSpin: (p && typeof p.layerSpin === "number" && !isNaN(p.layerSpin)) ? clamp(p.layerSpin, -3600, 3600) : DEFAULT_VALUES.layerSpin,
    addedInstancesPerLayer: (p && typeof p.addedInstancesPerLayer === "number" && !isNaN(p.addedInstancesPerLayer)) ? clamp(Math.round(p.addedInstancesPerLayer), 0, 500) : DEFAULT_VALUES.addedInstancesPerLayer,
    layerAltDirection: (p && p.layerAltDirection !== undefined) ? !!p.layerAltDirection : DEFAULT_VALUES.layerAltDirection,
    reverseZIndex: (p && p.reverseZIndex !== undefined) ? !!p.reverseZIndex : DEFAULT_VALUES.reverseZIndex,
    outerLayersOnTop: (p && p.outerLayersOnTop !== undefined) ? !!p.outerLayersOnTop : DEFAULT_VALUES.outerLayersOnTop,
    mixMode: mixMode,
    shapePattern: (p && typeof p.shapePattern === "string" && p.shapePattern.trim()) ? p.shapePattern.trim() : buildDefaultShapePattern(K)
  };
}

function readGroupValues(group, nodeCount) {
  if (!group) return sanitizeValues(DEFAULT_VALUES, nodeCount);

  // 1. TagInterface "pivotRepeatSettings" (Primary JSON metadata)
  try {
    if (group.tagInterface && group.tagInterface.hasKey(TAG_KEY)) {
      const json = group.tagInterface.getValueForKey(TAG_KEY);
      if (json) return sanitizeValues(JSON.parse(json), nodeCount);
    }
  } catch (e) {}

  // 2. TagInterface "effectPipeline"
  try {
    if (group.tagInterface && group.tagInterface.hasKey("effectPipeline")) {
      const json = group.tagInterface.getValueForKey("effectPipeline");
      if (json) {
        const parsed = JSON.parse(json);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const prStage = parsed.find(s => s && (s.id === "pivot_repeat" || s.id === "pivotrepeat"));
          if (prStage && prStage.params) {
            return sanitizeValues(prStage.params, nodeCount);
          }
        }
      }
    }
  } catch (e) {}

  // 3. Fallback: TagInterface "radialRepeatSettings" migration
  try {
    if (group.tagInterface && group.tagInterface.hasKey("radialRepeatSettings")) {
      const json = group.tagInterface.getValueForKey("radialRepeatSettings");
      if (json) {
        const rr = JSON.parse(json);
        return sanitizeValues({
          instances: rr.instances,
          sizeScale: rr.sizeScale,
          startScale: rr.startScale,
          endScale: rr.endScale,
          layers: rr.rows,
          layerScale: rr.rowScaling,
          layerRotation: rr.rowRotation,
          reverseZIndex: rr.reverseZIndex
        }, nodeCount);
      }
    }
  } catch (e) {}

  return sanitizeValues(DEFAULT_VALUES, nodeCount);
}

function setContainerMetadata(document, group, params) {
  if (!group) return;
  try {
    const groupSel = Selection.create(document, group, true);
    document.executeCommand(DocumentCommand.createSetDescription(groupSel, GROUP_PREFIX), false);
    document.executeCommand(DocumentCommand.createSetTagValueForKey(groupSel, TAG_KEY, JSON.stringify(params)), false);
    document.executeCommand(DocumentCommand.createSetTagValueForKey(groupSel, "effectPipeline", JSON.stringify([{ id: "pivot_repeat", params: params }])), false);
  } catch (e) {
    console.log("Pivot Repeat metadata error: " + e);
  }
}

// =============================================================================
// GEOMETRY & CONTAINER TRANSFORM MANAGEMENT
// =============================================================================

function validBB(b) {
  return b && isFinite(b.x) && isFinite(b.y) && isFinite(b.width) && isFinite(b.height) && (b.width > 0 || b.height > 0);
}

function getContainerTransform(containerNode) {
  if (!containerNode) return null;
  try {
    const xf = containerNode.baseToSpreadTransform || (containerNode.transformInterface ? containerNode.transformInterface.transform : null);
    if (xf) return xf.clone();
  } catch (e) {}
  return null;
}

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

  // 1. Visibility / Opacity
  try {
    if (node.visibilityInterface && typeof node.visibilityInterface.globalOpacity === "number") {
      opacity = node.visibilityInterface.globalOpacity;
    }
  } catch (e) {}

  // 2. Blend Mode
  try {
    if (node.blendModeInterface && node.blendModeInterface.blendMode) {
      blendMode = node.blendModeInterface.blendMode;
    } else if (node.blendMode) {
      blendMode = node.blendMode;
    }
  } catch (e) {}

  // 3. Line / Stroke Style
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
      } else {
        hasStroke = false;
        lineFill = FillDescriptor.createNone();
        lineStyle = LineStyleDescriptor.createDefault(0);
      }
    }
  } catch (e) {}

  // 4. Brush Fill
  try {
    if (node.brushFillInterface) {
      if (!node.brushFillInterface.isNoFill && node.brushFillInterface.currentDescriptor) {
        brushFill = node.brushFillInterface.currentDescriptor.clone();
      }
    }
  } catch (e) {}

  // 5. Transparency Fill
  try {
    if (node.transparencyInterface && !node.transparencyInterface.isTransparencyNone) {
      if (node.transparencyInterface.fillDescriptor) {
        transparencyFill = node.transparencyInterface.fillDescriptor.clone();
      }
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

  // 1. Brush Fill (only apply valid fills)
  if (style.brushFill && !style.brushFill.isNoFill) {
    cb.addCommand(DocumentCommand.createSetBrushFill(sel, style.brushFill), false);
  }

  // 2. Stroke / Line Fill & Style
  if (style.hasStroke && style.lineFill && !style.lineFill.isNoFill && style.lineStyle) {
    cb.addCommand(DocumentCommand.createSetLineStyleDescriptor(sel, style.lineStyle), false);
    cb.addCommand(DocumentCommand.createSetPenFill(sel, style.lineFill), false);
  }

  // 3. Transparency
  if (style.transparencyFill && !style.transparencyFill.isNoFill) {
    cb.addCommand(DocumentCommand.createSetTransparencyFill(sel, style.transparencyFill), false);
  }

  // 4. Opacity
  if (typeof style.opacity === "number" && style.opacity >= 0 && style.opacity <= 1.0) {
    cb.addCommand(DocumentCommand.createSetOpacity(sel, style.opacity), false);
  }

  // 5. Blend Mode
  if (style.blendMode) {
    cb.addCommand(DocumentCommand.createSetBlendMode(sel, style.blendMode), false);
  }

  const cmd = cb.createCommand();
  if (cmd) {
    document.executeCommand(cmd, false);
  }
}

/**
 * Recursively synchronizes styles from result nodes to source nodes.
 * Safely handles Groups, Multi-part shapes, and Leaf curves without
 * ever overriding child fills with empty group-level fills!
 */
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
    // Also sync group-level opacity or blendMode if applicable:
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

  // Leaf vector shape / curve:
  const rStyle = getNodeStyle(rNode);
  applyStyleToLeafNode(document, sNode, rStyle);
}

function syncSourceStylesFromResults(document, existingGroup, sourceNodes, resultNodes) {
  if (!existingGroup || !sourceNodes.length) return;

  for (let i = 0; i < sourceNodes.length; i++) {
    const sNode = sourceNodes[i];
    const rNode = (resultNodes && resultNodes.length > i) ? resultNodes[i] : (resultNodes && resultNodes[0]);
    if (sNode && rNode) {
      syncRecursiveStyles(document, sNode, rNode);
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

function extractGeomEntriesFromNode(node, containerTransform) {
  const entries = [];
  if (!node) return entries;

  const containerInv = (containerTransform && containerTransform.inverted) ? containerTransform.inverted : null;

  // 1. Procedural effect containers
  if (isProceduralEffectContainer(node)) {
    const results = getChildren(node).filter(isResultNode);
    for (const res of results) {
      const pc = clonePolyCurveToSpread(res);
      if (pc) {
        if (containerInv) {
          try { pc.transform(containerInv); } catch (e) {}
        }
        entries.push({ polyCurve: pc, style: getNodeStyle(res) });
      }
    }
    if (entries.length) return entries;
  }

  // 2. Nodes with children (Groups, Containers, Layers)
  const children = getChildren(node);
  if (children.length > 0) {
    for (const child of children) {
      const subEntries = extractGeomEntriesFromNode(child, containerTransform);
      for (const entry of subEntries) entries.push(entry);
    }
    if (entries.length > 0) return entries;
  }

  // 3. Single vector curve or shape node
  const singlePc = clonePolyCurveToSpread(node);
  if (singlePc) {
    if (containerInv) {
      try { singlePc.transform(containerInv); } catch (e) {}
    }
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

function buildLocalGeometry(sourceItems) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, found = false;
  for (const item of sourceItems) {
    if (item && item.box) {
      const b = item.box;
      if (validBB(b)) {
        x0 = Math.min(x0, b.x);
        y0 = Math.min(y0, b.y);
        x1 = Math.max(x1, b.x + b.width);
        y1 = Math.max(y1, b.y + b.height);
        found = true;
      }
    }
  }
  if (found && isFinite(x0) && isFinite(y0)) {
    return {
      center: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 },
      box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
    };
  }
  return { center: { x: 0, y: 0 }, box: { x: 0, y: 0, width: 100, height: 100 } };
}

// =============================================================================
// MULTI-SHAPE SEQUENCE PATTERNS & LABELS
// =============================================================================

function indexToTemplateLetter(index) {
  let n = index;
  let label = "";
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

function buildObjectLabelText(count) {
  if (count <= 1) return "1 shape selected";
  const labels = [];
  for (let i = 0; i < count; i++) {
    labels.push(`${i + 1}=Shape ${indexToTemplateLetter(i)}`);
  }
  return labels.join("  •  ");
}

function buildDefaultShapePattern(templateCount) {
  const templates = Math.max(1, templateCount);
  const pattern = [];
  for (let i = 0; i < templates; i++) {
    pattern.push(String(i + 1));
  }
  return pattern.join(".");
}

function parseTemplateToken(token, templateCount) {
  const clean = String(token || "").trim().toUpperCase();
  if (!clean) return null;
  const asNumber = parseInt(clean, 10);
  if (!isNaN(asNumber)) {
    return clamp(asNumber - 1, 0, templateCount - 1);
  }
  let value = 0;
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    if (code < 65 || code > 90) return null;
    value = value * 26 + (code - 64);
  }
  return clamp(value - 1, 0, templateCount - 1);
}

function parseShapePattern(text, templateCount) {
  if (templateCount <= 1) return [0];
  const tokens = String(text || "").split(/[^0-9A-Za-z]+/).filter(Boolean);
  const result = [];
  for (const token of tokens) {
    const parsed = parseTemplateToken(token, templateCount);
    if (parsed !== null) result.push(parsed);
  }
  if (result.length > 0) return result;
  const def = [];
  for (let i = 0; i < templateCount; i++) def.push(i);
  return def;
}

function getTemplateIndexForPlacement(placement, templateCount, params) {
  if (templateCount <= 1) return 0;
  const pattern = parseShapePattern(params.shapePattern, templateCount);
  if (!pattern.length) return 0;

  if (params.mixMode === 1) {
    // By Layer (Concentric Rings)
    return pattern[placement.layer % pattern.length] % templateCount;
  } else {
    // By Item (Around Circle)
    return pattern[placement.index % pattern.length] % templateCount;
  }
}

// =============================================================================
// PLACEMENTS & TRANSFORMS (Power Duplicate Common Pivot Engine)
// =============================================================================

function countTotalInstances(params) {
  let total = 0;
  for (let layer = 0; layer < params.layers; layer++) {
    total += Math.max(1, params.instances + layer * params.addedInstancesPerLayer);
  }
  return total;
}

function buildPlacements(params, sourceItems) {
  const total = countTotalInstances(params);
  if (total > MAX_TOTAL_INSTANCES) {
    throw new Error(`Too many instances (${total}). Limit is ${MAX_TOTAL_INSTANCES}.`);
  }

  // Calculate common target pivot from the primary shape (Shape 0):
  const primaryBox = (sourceItems && sourceItems[0] && sourceItems[0].box)
    ? sourceItems[0].box
    : { x: 0, y: 0, width: 100, height: 100 };

  const baseAnchor = getAnchorPoint(primaryBox, params.pivotAnchor);
  const targetPivot = {
    x: baseAnchor.x + (params.pivotOffsetX || 0),
    y: baseAnchor.y + (params.pivotOffsetY || 0)
  };

  const placements = [];

  for (let layer = 0; layer < params.layers; layer++) {
    const count = Math.max(1, params.instances + layer * params.addedInstancesPerLayer);
    
    // Layer rotation calculation with optional alternating direction (+ / -)
    const rotSign = params.layerAltDirection ? (layer % 2 === 1 ? -1 : 1) : 1;
    const layerOffsetDeg = params.startAngle + rotSign * params.layerRotation * layer;
    
    const layerScale = Math.pow(params.layerScale, layer);
    const layerScaleW = Math.pow(params.layerScaleW !== undefined ? params.layerScaleW : 1.0, layer);
    const layerScaleH = Math.pow(params.layerScaleH !== undefined ? params.layerScaleH : 1.0, layer);

    const stepAngleDeg = params.fullCircle
      ? (360 / count)
      : (count > 1 ? (params.totalAngle / (count - 1)) : params.totalAngle);

    for (let i = 0; i < count; i++) {
      const scaleT = count > 1 ? i / (count - 1) : 0;
      const angleDeg = layerOffsetDeg + i * stepAngleDeg;
      const angleRad = degToRad(angleDeg);

      const scale = (params.startScale + (params.endScale - params.startScale) * scaleT) * layerScale * (params.sizeScale || 1);
      
      const layerSpin = (params.layerSpin || 0) * layer;
      const spinRad = degToRad((params.itemSpin || 0) + layerSpin);

      // Distance from origin along the natural radial ray (with layer distance step):
      const originDist = (params.originDistance || 0) + layer * (params.layerDistanceStep || 0);

      // Radial push displacement along polar angle ray (with layer push step):
      const pushDist = (params.radialPush || 0) + layer * (params.layerPushStep || 0);
      const pushX = Math.cos(angleRad) * pushDist;
      const pushY = Math.sin(angleRad) * pushDist;

      placements.push({
        layer,
        index: i,
        count,
        pivot: targetPivot,
        originDistance: originDist,
        pushX,
        pushY,
        angleDeg,
        rotationRad: angleRad,
        scale: Math.max(0.001, scale),
        scaleW: (params.scaleW || 1.0) * layerScaleW,
        scaleH: (params.scaleH || 1.0) * layerScaleH,
        spinRad: spinRad
      });
    }
  }

  return { placements, targetPivot };
}

/**
 * Builds the exact similarity transform for an instance around the common pivot point P:
 * - Translates source shape by -sourceAnchor (aligning shape's local base/anchor to 0,0).
 * - Applies individual item spin (including layer spin).
 * - Applies source shape dimensions & layer scaling (sx = scale * scaleW, sy = scale * scaleH).
 * - Displaces by (0, -originDistance) directly along the shape's orientation axis.
 * - Applies rotation by angleRad around pivot P.
 * - Translates to targetPivot + radialPush.
 */
function buildPlacementTransform(placement, sourceAnchor) {
  const P = placement.pivot;
  const D = placement.originDistance || 0;
  const sx = placement.scale * (placement.scaleW || 1.0);
  const sy = placement.scale * (placement.scaleH || 1.0);

  return Transform
    .createTranslate(P.x + placement.pushX, P.y + placement.pushY)
    .multiply(Transform.createRotate(placement.rotationRad))
    .multiply(Transform.createTranslate(0, -D))
    .multiply(Transform.createScale(sx, sy))
    .multiply(Transform.createRotate(placement.spinRad))
    .multiply(Transform.createTranslate(-sourceAnchor.x, -sourceAnchor.y));
}

/**
 * Generates exact rendering and container insertion indices:
 * - Grouped layer-by-layer so concentric rings are rendered in predictable, correct stack order.
 * - By default: Layer 0 (base outer) -> Layer 1 -> Layer 2 (inner concentric rings on top).
 * - If outerLayersOnTop = true: Layer L-1 -> ... -> Layer 0 on top.
 * - If reverseItemOrder (reverseZIndex) = true: Items within each ring are reversed in overlap
 *   direction around the circle without breaking concentric layer visibility!
 */
function getOrderedPlacementIndices(placements, reverseItemOrder, outerLayersOnTop) {
  if (!placements || !placements.length) return [];
  
  const layerMap = new Map();
  for (let i = 0; i < placements.length; i++) {
    const layer = placements[i].layer;
    if (!layerMap.has(layer)) layerMap.set(layer, []);
    layerMap.get(layer).push(i);
  }

  const sortedLayers = Array.from(layerMap.keys()).sort((a, b) => a - b);
  if (outerLayersOnTop) {
    sortedLayers.reverse();
  }

  const finalIndices = [];
  for (const layer of sortedLayers) {
    let layerIndices = layerMap.get(layer);
    if (reverseItemOrder) {
      layerIndices = layerIndices.slice().reverse();
    }
    for (const idx of layerIndices) {
      finalIndices.push(idx);
    }
  }
  return finalIndices;
}

function clearPreviews(document) {
  try {
    document.executeCommand(DocumentCommand.createClearPreviews());
  } catch (e) {}
}

function doPreviewPolyCurves(document, sourceItems, targetNode, params, containerTransform) {
  clearPreviews(document);
  if (!sourceItems || !sourceItems.length) return;

  const { placements } = buildPlacements(params, sourceItems);

  const addBuilder = AddChildNodesCommandBuilder.create();
  if (targetNode) {
    addBuilder.setInsertionTargetSelection(mkSel(targetNode));
    addBuilder.setInsertionMode(InsertionMode.Top);
  }

  const orderedIndices = getOrderedPlacementIndices(placements, params.reverseZIndex, params.outerLayersOnTop);

  for (const placementIndex of orderedIndices) {
    const placement = placements[placementIndex];
    const templateIndex = getTemplateIndexForPlacement(placement, sourceItems.length, params);
    const item = sourceItems[templateIndex];
    if (!item) continue;

    const sourceAnchor = getAnchorPoint(item.box, params.pivotAnchor);
    const localTransform = buildPlacementTransform(placement, sourceAnchor);
    const previewTransform = containerTransform ? containerTransform.multiply(localTransform) : localTransform;

    if (item.geomEntries && item.geomEntries.length) {
      for (const geom of item.geomEntries) {
        if (!geom || !geom.polyCurve) continue;
        const pc = geom.polyCurve.clone();
        try { pc.transform(previewTransform); } catch (e) {}
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

function doApply(document, nodes, sourceItems, params, existingGroup, containerTransform) {
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

  // Generate Duplicate Items (1:1 Exact Spread-space Matching with Live Preview)
  const { placements } = buildPlacements(params, sourceItems);
  const containerInv = (containerTransform && containerTransform.inverted) ? containerTransform.inverted : null;
  const dupCb = CompoundCommandBuilder.create();

  for (let placementIndex = 0; placementIndex < placements.length; placementIndex++) {
    const placement = placements[placementIndex];
    const templateIndex = getTemplateIndexForPlacement(placement, nodes.length, params);
    const node = nodes[templateIndex];
    const item = sourceItems[templateIndex];
    const sourceAnchor = getAnchorPoint(item.box, params.pivotAnchor);
    const localTransform = buildPlacementTransform(placement, sourceAnchor);

    const spreadTransform = (containerTransform && containerInv)
      ? containerTransform.multiply(localTransform).multiply(containerInv)
      : localTransform;

    dupCb.addCommand(
      DocumentCommand.createTransform(mkSel(node), spreadTransform, { duplicateNodes: true }),
      false
    );
  }

  const dupCmd = dupCb.createCommand();
  document.executeCommand(dupCmd);
  const dupNodes = Array.from(dupCmd.newNodes || []);

  if (dupNodes.length === 0) return;

  // Organize Inside Container in exact layer-safe stacking order
  const moveCb = CompoundCommandBuilder.create();
  const orderedIndices = getOrderedPlacementIndices(placements, params.reverseZIndex, params.outerLayersOnTop);

  for (const i of orderedIndices) {
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
    const placement = placements[i];
    const templateIndex = getTemplateIndexForPlacement(placement, nodes.length, params);
    const srcNode = nodes[templateIndex];
    if (srcNode) {
      if (srcNode.visibilityInterface && typeof srcNode.visibilityInterface.globalOpacity === "number") {
        const op = srcNode.visibilityInterface.globalOpacity;
        if (op < 0.999) {
          try {
            doc.executeCommand(DocumentCommand.createSetOpacity(mkSel(node), op), false);
          } catch (e) {}
        }
      }
      try {
        const bm = (srcNode.blendModeInterface && srcNode.blendModeInterface.blendMode) || srcNode.blendMode;
        if (bm) {
          doc.executeCommand(DocumentCommand.createSetBlendMode(mkSel(node), bm), false);
        }
      } catch (e) {}
    }
  }

  try {
    document.selection = mkSel(targetGroup);
  } catch (e) {}
}

// =============================================================================
// MAIN ENTRY POINT & DIALOG UI
// =============================================================================

function runPivotRepeat(document, rawNodes) {
  if (rawNodes.some(isSymbolNode)) {
    const warnDlg = Dialog.create("Symbols Not Supported");
    const warnCol = warnDlg.addColumn();
    warnCol.addStaticText(
      null,
      "Symbols are not supported in " + SCRIPT_TITLE + "."
    ).setIsFullWidth(true);
    warnCol.addStaticText(
      null,
      "Please detach or expand symbols into standard shapes, curves, or groups before using Pivot Repeat."
    ).setIsFullWidth(true);
    warnDlg.show();
    return;
  }

  let existingGroup = null;
  let nodes = [];

  if (rawNodes.length === 1 && isPivotRepeatGroup(rawNodes[0])) {
    existingGroup = rawNodes[0];
  } else {
    for (const node of rawNodes) {
      const pGrp = getPivotRepeatGroupOf(node);
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

    // Safely sync styles recursively from visible results to hidden sources
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
      "Please detach or expand symbols into standard shapes, curves, or groups before using Pivot Repeat."
    ).setIsFullWidth(true);
    warnDlg.show();
    return;
  }

  const containerTransform = existingGroup ? getContainerTransform(existingGroup) : null;

  const sourceItems = nodes.map((node, index) => {
    const entries = extractGeomEntriesFromNode(node, containerTransform);
    const b = getEntriesBounds(entries);
    return {
      index: index,
      node: node,
      geomEntries: entries,
      box: b || { x: 0, y: 0, width: 100, height: 100 },
      localCenter: b ? b.center : { x: 0, y: 0 }
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

  const initialValues = existingGroup ? readGroupValues(existingGroup, nodes.length) : sanitizeValues(DEFAULT_VALUES, nodes.length);

  // Dialog UI Layout (2 Columns)
  const dlg = Dialog.create(SCRIPT_TITLE);
  dlg.initialWidth = 650;

  // --- COLUMN 1: PIVOT, ROTARY REPETITION & OBJECT DIMENSIONS ---
  const col1 = dlg.addColumn();

  const pivotGrp = col1.addGroup("Pivot & Anchor Point");
  const anchorCtrl = pivotGrp.addSpatialAnchor("Pivot Anchor", parseAnchorValue(initialValues.pivotAnchor));
  
  const pivotXCtrl = pivotGrp.addUnitValueEditor("Pivot Offset X (px)", UnitType.Number, UnitType.Number, initialValues.pivotOffsetX, -100000, 100000);
  pivotXCtrl.precision = 1;
  pivotXCtrl.showPopupSlider = true;

  const pivotYCtrl = pivotGrp.addUnitValueEditor("Pivot Offset Y (px)", UnitType.Number, UnitType.Number, initialValues.pivotOffsetY, -100000, 100000);
  pivotYCtrl.precision = 1;
  pivotYCtrl.showPopupSlider = true;

  const originDistCtrl = pivotGrp.addUnitValueEditor("Distance from Origin (px)", UnitType.Number, UnitType.Number, initialValues.originDistance, -100000, 100000);
  originDistCtrl.precision = 1;
  originDistCtrl.showPopupSlider = true;

  const radialPushCtrl = pivotGrp.addUnitValueEditor("Radial Push (px)", UnitType.Number, UnitType.Number, initialValues.radialPush, -100000, 100000);
  radialPushCtrl.precision = 1;
  radialPushCtrl.showPopupSlider = true;

  const repeatGrp = col1.addGroup("Repetition & Object Dimensions");
  const instancesCtrl = repeatGrp.addUnitValueEditor("Copies / Instances", UnitType.Number, UnitType.Number, initialValues.instances, 1, 500);
  instancesCtrl.precision = 0;

  const sizeCtrl = repeatGrp.addUnitValueEditor("Overall Size (%)", UnitType.Percentage, UnitType.Percentage, initialValues.sizeScale * 100, 1, 1000);
  sizeCtrl.precision = 1;
  sizeCtrl.showPopupSlider = true;

  const scaleWCtrl = repeatGrp.addUnitValueEditor("Width / Scale W (%)", UnitType.Percentage, UnitType.Percentage, initialValues.scaleW * 100, 1, 1000);
  scaleWCtrl.precision = 1;
  scaleWCtrl.showPopupSlider = true;

  const scaleHCtrl = repeatGrp.addUnitValueEditor("Height / Scale H (%)", UnitType.Percentage, UnitType.Percentage, initialValues.scaleH * 100, 1, 1000);
  scaleHCtrl.precision = 1;
  scaleHCtrl.showPopupSlider = true;

  const fullCircleCtrl = repeatGrp.addSwitch("Full 360° Circle", initialValues.fullCircle);

  const totalAngleCtrl = repeatGrp.addUnitValueEditor("Total Angle / Span (deg)", UnitType.Degree, UnitType.Degree, initialValues.totalAngle, -3600, 3600);
  totalAngleCtrl.precision = 1;

  const startAngleCtrl = repeatGrp.addUnitValueEditor("Start Angle (deg)", UnitType.Degree, UnitType.Degree, initialValues.startAngle, -3600, 3600);
  startAngleCtrl.precision = 1;

  const reverseZIndexCtrl = repeatGrp.addSwitch("Reverse Stacking Order", initialValues.reverseZIndex);

  // --- COLUMN 2: SCALING PROGRESSION, CONCENTRIC LAYERS & SHAPE MIXING ---
  const col2 = dlg.addColumn();

  const scalingGrp = col2.addGroup("Progression & Item Spin");
  const startScaleCtrl = scalingGrp.addUnitValueEditor("Start Scale (%)", UnitType.Percentage, UnitType.Percentage, initialValues.startScale * 100, 1, 1000);
  startScaleCtrl.precision = 1;
  startScaleCtrl.showPopupSlider = true;

  const endScaleCtrl = scalingGrp.addUnitValueEditor("End Scale (%)", UnitType.Percentage, UnitType.Percentage, initialValues.endScale * 100, 1, 1000);
  endScaleCtrl.precision = 1;
  endScaleCtrl.showPopupSlider = true;

  const itemSpinCtrl = scalingGrp.addUnitValueEditor("Individual Item Spin (deg)", UnitType.Degree, UnitType.Degree, initialValues.itemSpin, -3600, 3600);
  itemSpinCtrl.precision = 1;

  // Supercharged Concentric Layers Section with comprehensive parameters & layer stack control
  const layersGrp = col2.addGroup("Concentric Layers / Rings");
  const layersCtrl = layersGrp.addUnitValueEditor("Layers", UnitType.Number, UnitType.Number, initialValues.layers, 1, 100);
  layersCtrl.precision = 0;

  const layerDistCtrl = layersGrp.addUnitValueEditor("Layer Distance Step (px)", UnitType.Number, UnitType.Number, initialValues.layerDistanceStep, -100000, 100000);
  layerDistCtrl.precision = 1;
  layerDistCtrl.showPopupSlider = true;

  const layerScaleCtrl = layersGrp.addUnitValueEditor("Layer Scaling (%)", UnitType.Percentage, UnitType.Percentage, initialValues.layerScale * 100, 1, 1000);
  layerScaleCtrl.precision = 1;
  layerScaleCtrl.showPopupSlider = true;

  const layerScaleWCtrl = layersGrp.addUnitValueEditor("Layer Width Scale (%)", UnitType.Percentage, UnitType.Percentage, initialValues.layerScaleW * 100, 1, 1000);
  layerScaleWCtrl.precision = 1;
  layerScaleWCtrl.showPopupSlider = true;

  const layerScaleHCtrl = layersGrp.addUnitValueEditor("Layer Height Scale (%)", UnitType.Percentage, UnitType.Percentage, initialValues.layerScaleH * 100, 1, 1000);
  layerScaleHCtrl.precision = 1;
  layerScaleHCtrl.showPopupSlider = true;

  const layerRotationCtrl = layersGrp.addUnitValueEditor("Layer Rotation (deg)", UnitType.Degree, UnitType.Degree, initialValues.layerRotation, -3600, 3600);
  layerRotationCtrl.precision = 1;

  const layerSpinCtrl = layersGrp.addUnitValueEditor("Layer Item Spin (deg)", UnitType.Degree, UnitType.Degree, initialValues.layerSpin, -3600, 3600);
  layerSpinCtrl.precision = 1;

  const layerPushCtrl = layersGrp.addUnitValueEditor("Layer Radial Push (px)", UnitType.Number, UnitType.Number, initialValues.layerPushStep, -100000, 100000);
  layerPushCtrl.precision = 1;
  layerPushCtrl.showPopupSlider = true;

  const addedCtrl = layersGrp.addUnitValueEditor("Added Copies Per Layer", UnitType.Number, UnitType.Number, initialValues.addedInstancesPerLayer, 0, 500);
  addedCtrl.precision = 0;

  const altDirectionCtrl = layersGrp.addSwitch("Alternate Rotation Direction", initialValues.layerAltDirection);
  const outerLayersOnTopCtrl = layersGrp.addSwitch("Outer Rings on Top", initialValues.outerLayersOnTop);

  // Multi-Shape Mixing Section
  const mixGrp = col2.addGroup("Mix Multiple Shapes");
  let mixModeCtrl = null;
  let objectLabelsCtrl = null;
  let shapePatternCtrl = null;

  if (nodes.length > 1) {
    mixModeCtrl = mixGrp.addButtonSet("Mix Mode", ["Around Circle", "By Layer"], initialValues.mixMode);
    objectLabelsCtrl = mixGrp.addStaticText("Your Shapes", buildObjectLabelText(nodes.length));
    
    shapePatternCtrl = mixGrp.addTextBox("Shape Sequence (e.g. 1.2 or 1.2.3)", initialValues.shapePattern);
    shapePatternCtrl.isFullWidth = true;

    const patternHelp = mixGrp.addStaticText(
      "Sequence Info",
      "Alternates shapes around the circle or across layers (e.g. 1.2 alternates Shape 1 and Shape 2)."
    );
    patternHelp.isFullWidth = true;
  } else {
    const singleInfoCtrl = mixGrp.addStaticText(
      null,
      "Select 2 or more objects on your canvas to alternate shapes around the pivot."
    );
    singleInfoCtrl.isFullWidth = true;
  }

  // Info Note
  const noteGrp = col2.addGroup("");
  const txt1 = noteGrp.addStaticText(
    null,
    existingGroup ? "✨ Editing Pivot Repeat in Stack ✨" : "✨ Power Duplicate Pivot Invariance ✨"
  ).setIsFullWidth(true);
  txt1.textHorizontalAlignment = HorizontalAlignment.Centre;

  function updateControlStates() {
    if (totalAngleCtrl) {
      totalAngleCtrl.isEnabled = !fullCircleCtrl.value;
    }
    if (objectLabelsCtrl) {
      objectLabelsCtrl.isEnabled = nodes.length > 1;
    }
  }

  function readValues() {
    const layers = clamp(Math.round(layersCtrl.value), 1, 100);
    const patternText = (shapePatternCtrl && shapePatternCtrl.text && shapePatternCtrl.text.trim())
      ? shapePatternCtrl.text.trim()
      : initialValues.shapePattern;

    const selectedMixMode = mixModeCtrl ? clamp(mixModeCtrl.selectedIndex, 0, 1) : initialValues.mixMode;

    return sanitizeValues({
      instances: clamp(Math.round(instancesCtrl.value), 1, 500),
      sizeScale: clamp(sizeCtrl.value, 1, 1000) / 100,
      scaleW: clamp(scaleWCtrl.value, 1, 1000) / 100,
      scaleH: clamp(scaleHCtrl.value, 1, 1000) / 100,
      fullCircle: !!fullCircleCtrl.value,
      totalAngle: clamp(totalAngleCtrl.value, -3600, 3600),
      startAngle: clamp(startAngleCtrl.value, -3600, 3600),
      pivotAnchor: getAnchorNumber(anchorCtrl ? anchorCtrl.value : initialValues.pivotAnchor),
      pivotOffsetX: clamp(pivotXCtrl.value, -100000, 100000),
      pivotOffsetY: clamp(pivotYCtrl.value, -100000, 100000),
      originDistance: clamp(originDistCtrl.value, -100000, 100000),
      radialPush: clamp(radialPushCtrl.value, -100000, 100000),
      startScale: clamp(startScaleCtrl.value, 1, 1000) / 100,
      endScale: clamp(endScaleCtrl.value, 1, 1000) / 100,
      itemSpin: clamp(itemSpinCtrl.value, -3600, 3600),
      layers: layers,
      layerDistanceStep: clamp(layerDistCtrl.value, -100000, 100000),
      layerPushStep: clamp(layerPushCtrl.value, -100000, 100000),
      layerScale: clamp(layerScaleCtrl.value, 1, 1000) / 100,
      layerScaleW: clamp(layerScaleWCtrl.value, 1, 1000) / 100,
      layerScaleH: clamp(layerScaleHCtrl.value, 1, 1000) / 100,
      layerRotation: clamp(layerRotationCtrl.value, -3600, 3600),
      layerSpin: clamp(layerSpinCtrl.value, -3600, 3600),
      addedInstancesPerLayer: clamp(Math.round(addedCtrl.value), 0, 500),
      layerAltDirection: altDirectionCtrl ? !!altDirectionCtrl.value : initialValues.layerAltDirection,
      reverseZIndex: reverseZIndexCtrl ? !!reverseZIndexCtrl.value : initialValues.reverseZIndex,
      outerLayersOnTop: outerLayersOnTopCtrl ? !!outerLayersOnTopCtrl.value : initialValues.outerLayersOnTop,
      mixMode: selectedMixMode,
      shapePattern: patternText
    }, nodes.length);
  }

  // Debounced Live Preview
  let inPreview = false, previewTimer = null;
  function applyPreview() {
    updateControlStates();
    if (previewTimer) previewTimer.cancel();
    previewTimer = setTimeout(80, (err) => {
      if (err || inPreview) return;
      inPreview = true;
      try {
        const params = readValues();
        doPreviewPolyCurves(document, sourceItems, previewTargetNode, params, containerTransform);
      } catch (e) {
        console.log(SCRIPT_TITLE + " preview error: " + e);
        clearPreviews(document);
      } finally {
        inPreview = false;
      }
    });
  }

  anchorCtrl.onValueChangedHandler = applyPreview;
  pivotXCtrl.onValueChangedHandler = applyPreview;
  pivotYCtrl.onValueChangedHandler = applyPreview;
  originDistCtrl.onValueChangedHandler = applyPreview;
  radialPushCtrl.onValueChangedHandler = applyPreview;
  instancesCtrl.onValueChangedHandler = applyPreview;
  sizeCtrl.onValueChangedHandler = applyPreview;
  scaleWCtrl.onValueChangedHandler = applyPreview;
  scaleHCtrl.onValueChangedHandler = applyPreview;
  fullCircleCtrl.onValueChangedHandler = applyPreview;
  totalAngleCtrl.onValueChangedHandler = applyPreview;
  startAngleCtrl.onValueChangedHandler = applyPreview;
  reverseZIndexCtrl.onValueChangedHandler = applyPreview;
  startScaleCtrl.onValueChangedHandler = applyPreview;
  endScaleCtrl.onValueChangedHandler = applyPreview;
  itemSpinCtrl.onValueChangedHandler = applyPreview;
  layersCtrl.onValueChangedHandler = applyPreview;
  layerDistCtrl.onValueChangedHandler = applyPreview;
  layerScaleCtrl.onValueChangedHandler = applyPreview;
  layerScaleWCtrl.onValueChangedHandler = applyPreview;
  layerScaleHCtrl.onValueChangedHandler = applyPreview;
  layerRotationCtrl.onValueChangedHandler = applyPreview;
  layerSpinCtrl.onValueChangedHandler = applyPreview;
  layerPushCtrl.onValueChangedHandler = applyPreview;
  addedCtrl.onValueChangedHandler = applyPreview;
  if (altDirectionCtrl) altDirectionCtrl.onValueChangedHandler = applyPreview;
  if (outerLayersOnTopCtrl) outerLayersOnTopCtrl.onValueChangedHandler = applyPreview;
  if (mixModeCtrl) mixModeCtrl.onValueChangedHandler = applyPreview;
  if (shapePatternCtrl) shapePatternCtrl.onValueChangedHandler = applyPreview;
  dlg.onControlValueChangedHandler = applyPreview;

  // Hide initial primary shapes only while previewing
  if (!existingGroup) {
    const hidePrimariesCb = CompoundCommandBuilder.create();
    for (const n of nodes) {
      hidePrimariesCb.addCommand(DocumentCommand.createSetVisibility(mkSel(n), false));
    }
    document.executeCommand(hidePrimariesCb.createCommand());
  }

  updateControlStates();
  applyPreview();

  const result = dlg.show();
  if (previewTimer) previewTimer.cancel();
  clearPreviews(document);

  if (result.value === DialogResult.Ok.value) {
    const finalParams = readValues();
    try {
      doApply(document, nodes, sourceItems, finalParams, existingGroup, containerTransform);
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
// TOP-LEVEL INVOCATION & EXPORTS
// =============================================================================

function main() {
  if (!doc) {
    alert("Please open a document in Affinity.");
    return;
  }

  const rawNodes = doc.selection ? doc.selection.nodes.toArray().filter(Boolean) : [];
  if (!rawNodes.length) {
    alert("Please select at least one object (curve, shape, or group).");
    return;
  }

  runPivotRepeat(doc, rawNodes);
}

module.exports.main = main;
module.exports.isPivotRepeatGroup = isPivotRepeatGroup;
module.exports.readGroupValues = readGroupValues;
module.exports.buildPlacements = buildPlacements;
module.exports.buildPlacementTransform = buildPlacementTransform;
module.exports.getOrderedPlacementIndices = getOrderedPlacementIndices;
module.exports.getAnchorPoint = getAnchorPoint;
module.exports.parseAnchorValue = parseAnchorValue;
module.exports.getTemplateIndexForPlacement = getTemplateIndexForPlacement;
module.exports.getNodeStyle = getNodeStyle;
module.exports.syncRecursiveStyles = syncRecursiveStyles;
module.exports.syncSourceStylesFromResults = syncSourceStylesFromResults;
module.exports.doApply = doApply;

main();
