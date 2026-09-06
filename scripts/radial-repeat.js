"use strict";

// =============================================================================
// RADIAL REPEAT v6fa (Standard Procedural Radial Array & Geometry Engine)
// Affinity Designer / Photo / Publisher (v3e & Multi-Effect Standard)
//
// Features & Architecture in v6fa:
// - 1:1 Live Preview & Output Synchronization (v6fa Fix):
//   Guarantees 100% mathematical and visual identity between Live Preview and
//   the final applied container by applying conjugate similarity transformation
//   T_spread = M_container * T_local * M_container^-1 to duplicated source nodes.
// - Non-Uniform Container Transform Compensation:
//   When the container group is resized or transformed on canvas without maintaining
//   aspect ratio (non-uniform stretch/squash), Radial Repeat v6fa decomposes and inverts
//   the container transform matrix to work in container local coordinate space.
//   Master source curves and local placement matrices maintain 100% purity and
//   geometric integrity, completely eliminating compound deformation or distortion.
// - Reverse Stacking Order Switch:
//   Interactive switch "Reverse Stacking Order" to invert the Z-index of
//   concentric rows and radial items (Inner on Top vs Outer on Top).
// - Mix Shapes Across Rows & Rings (Multi-Shape Sequencing):
//   Alternate or sequence multiple selected shapes across concentric rows or around single rings.
// - Preserved Source Integrity:
//   Sources (Source 1, Source 2...) maintain 100% geometric and styling integrity across infinite re-runs.
// - Zero Phantom Strokes & Exact Style Fidelity:
//   Accurate stroke visibility detection; never adds phantom strokes to un-stroked shapes.
// - Full Blend Mode & Opacity Fidelity in Live Preview:
//   Accurately renders Layer Blend Modes (Multiply, Screen, Overlay, Color Dodge, etc.)
//   and semi-transparent opacity in real time during live preview.
// - Standard Clean Metadata Storage (Zig Zag v3e Standard):
//   Zero parameters in the container group name ("Radial Repeat Effect").
//   All active parameters stored in TagInterface as JSON under 'radialRepeatSettings' and 'effectPipeline'.
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
const { PolyCurve, CurveBuilder, Transform } = require("/geometry");
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

const SCRIPT_TITLE = "Radial Repeat v6fa";
const TAG_KEY = "radialRepeatSettings";
const GROUP_PREFIX = "Radial Repeat Effect";
const SOURCE_PREFIX = "Source";
const RESULT_PREFIX = "Radial Item";
const MAX_TOTAL_INSTANCES = 5000;

const DEFAULT_VALUES = {
  instances: 6,
  radius: 250,
  sizeScale: 1.0,
  rows: 1,
  rowSpacing: 50,
  addedInstancesPerRow: 0,
  rowRotation: 0,
  reverseZIndex: false,
  customRotation: false,
  customAngle: 0,
  startScale: 1.0,
  endScale: 1.0,
  rowScaling: 1.0,
  rowTemplateMode: false,
  rowPattern: "1.2"
};

const KNOWN_EFFECT_PREFIXES = [
  "Zig Zag Effect", "Roughen Effect", "Pucker & Bloat", "Twist Effect",
  "Effects [", "Effect Container"
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
  const m = name.match(/(?:Radial Item|Result)\s+(\d+)/i);
  return m ? parseInt(m[1], 10) : 99999;
}

// Check if a node or any of its descendants is a Symbol
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

function isRadialRepeatGroup(node) {
  if (!node) return false;
  try {
    if (node.tagInterface) {
      if (node.tagInterface.hasKey(TAG_KEY)) return true;
      if (node.tagInterface.hasKey("radialRepeat")) return true;
      if (node.tagInterface.hasKey("effectPipeline")) {
        const json = node.tagInterface.getValueForKey("effectPipeline");
        if (json && json.indexOf("radial_repeat") >= 0) return true;
      }
    }
  } catch (e) {}
  const name = getNodeName(node);
  if (name === GROUP_PREFIX || name.indexOf(GROUP_PREFIX) === 0 || name.indexOf("Radial Repeat") === 0) return true;
  const children = getChildren(node);
  const hasSource = children.some(c => getNodeName(c).indexOf(SOURCE_PREFIX) === 0);
  const hasResult = children.some(c => hasRedTag(c) || getNodeName(c).indexOf(RESULT_PREFIX) === 0 || getNodeName(c).indexOf("Result") === 0);
  return hasSource && hasResult;
}

function isProceduralEffectContainer(node) {
  if (!node) return false;
  if (isRadialRepeatGroup(node)) return false;
  try {
    if (node.tagInterface && (
      node.tagInterface.hasKey("effectPipeline") ||
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
  if (name.indexOf(RESULT_PREFIX) === 0 || name.indexOf("Result") === 0) return true;
  return false;
}

function isSourceNode(node) {
  if (!node) return false;
  if (isResultNode(node)) return false;
  const name = getNodeName(node);
  return name.indexOf(SOURCE_PREFIX) === 0;
}

function getRadialRepeatGroupOf(node) {
  let current = node;
  while (current) {
    if (isRadialRepeatGroup(current)) return current;
    try { current = current.parent; } catch (e) { break; }
  }
  return null;
}

// =============================================================================
// PARAMETER SANITIZATION & METADATA (v3e Standard Storage)
// =============================================================================

function clamp(value, minValue, maxValue) {
  return Math.max(minValue, Math.min(maxValue, value));
}

function degToRad(value) {
  return (value * Math.PI) / 180;
}

function sanitizeValues(p, nodeCount) {
  const K = Math.max(1, nodeCount || 1);
  const rows = (p && typeof p.rows === "number" && !isNaN(p.rows)) ? clamp(Math.round(p.rows), 1, 100) : DEFAULT_VALUES.rows;
  return {
    instances: (p && typeof p.instances === "number" && !isNaN(p.instances)) ? clamp(Math.round(p.instances), 1, 500) : DEFAULT_VALUES.instances,
    radius: (p && typeof p.radius === "number" && !isNaN(p.radius)) ? Math.max(0, p.radius) : DEFAULT_VALUES.radius,
    sizeScale: (p && typeof p.sizeScale === "number" && !isNaN(p.sizeScale)) ? Math.max(0.01, p.sizeScale) : DEFAULT_VALUES.sizeScale,
    rows: rows,
    rowSpacing: (p && typeof p.rowSpacing === "number" && !isNaN(p.rowSpacing)) ? Math.max(0, p.rowSpacing) : DEFAULT_VALUES.rowSpacing,
    addedInstancesPerRow: (p && typeof p.addedInstancesPerRow === "number" && !isNaN(p.addedInstancesPerRow)) ? clamp(Math.round(p.addedInstancesPerRow), 0, 500) : DEFAULT_VALUES.addedInstancesPerRow,
    rowRotation: (p && typeof p.rowRotation === "number" && !isNaN(p.rowRotation)) ? clamp(p.rowRotation, -3600, 3600) : DEFAULT_VALUES.rowRotation,
    reverseZIndex: (p && p.reverseZIndex !== undefined) ? !!p.reverseZIndex : DEFAULT_VALUES.reverseZIndex,
    customRotation: (p && p.customRotation !== undefined) ? !!p.customRotation : DEFAULT_VALUES.customRotation,
    customAngle: (p && typeof p.customAngle === "number" && !isNaN(p.customAngle)) ? clamp(p.customAngle, -3600, 3600) : DEFAULT_VALUES.customAngle,
    startScale: (p && typeof p.startScale === "number" && !isNaN(p.startScale)) ? Math.max(0.01, p.startScale) : DEFAULT_VALUES.startScale,
    endScale: (p && typeof p.endScale === "number" && !isNaN(p.endScale)) ? Math.max(0.01, p.endScale) : DEFAULT_VALUES.endScale,
    rowScaling: (p && typeof p.rowScaling === "number" && !isNaN(p.rowScaling)) ? Math.max(0.01, p.rowScaling) : DEFAULT_VALUES.rowScaling,
    rowTemplateMode: (p && p.rowTemplateMode !== undefined) ? !!p.rowTemplateMode : DEFAULT_VALUES.rowTemplateMode,
    rowPattern: (p && typeof p.rowPattern === "string" && p.rowPattern.trim()) ? p.rowPattern.trim() : buildDefaultRowPattern(rows, K)
  };
}

function readGroupValues(group, nodeCount) {
  if (!group) return sanitizeValues(DEFAULT_VALUES, nodeCount);

  // 1. TagInterface "radialRepeatSettings" (Primary JSON metadata)
  try {
    if (group.tagInterface && group.tagInterface.hasKey(TAG_KEY)) {
      const json = group.tagInterface.getValueForKey(TAG_KEY);
      if (json) {
        return sanitizeValues(JSON.parse(json), nodeCount);
      }
    }
  } catch (e) {}

  // 2. TagInterface "effectPipeline" (Multi-effect standard container key)
  try {
    if (group.tagInterface && group.tagInterface.hasKey("effectPipeline")) {
      const json = group.tagInterface.getValueForKey("effectPipeline");
      if (json) {
        const parsed = JSON.parse(json);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const rrStage = parsed.find(s => s && (s.id === "radial_repeat" || s.id === "radialrepeat"));
          if (rrStage && rrStage.params) {
            return sanitizeValues(rrStage.params, nodeCount);
          }
        }
      }
    }
  } catch (e) {}

  // 3. TagInterface "radialRepeat" fallback
  try {
    if (group.tagInterface && group.tagInterface.hasKey("radialRepeat")) {
      const json = group.tagInterface.getValueForKey("radialRepeat");
      if (json) {
        return sanitizeValues(JSON.parse(json), nodeCount);
      }
    }
  } catch (e) {}

  // 4. Legacy name-based fallback
  try {
    const name = getNodeName(group);
    const instMatch = name.match(/(\d+)\s*items?/i);
    const radMatch = name.match(/r:\s*([\d.]+)/i);
    const rowsMatch = name.match(/rows?:\s*(\d+)/i);
    if (instMatch || radMatch || rowsMatch) {
      return sanitizeValues({
        instances: instMatch ? parseInt(instMatch[1], 10) : DEFAULT_VALUES.instances,
        radius: radMatch ? parseFloat(radMatch[1]) : DEFAULT_VALUES.radius,
        rows: rowsMatch ? parseInt(rowsMatch[1], 10) : DEFAULT_VALUES.rows
      }, nodeCount);
    }
  } catch (e) {}

  return sanitizeValues(DEFAULT_VALUES, nodeCount);
}

function setContainerMetadata(document, group, params) {
  if (!group) return;
  try {
    const groupSel = Selection.create(document, group, true);
    // Standard clean container naming (Zero parameters in layer name)
    document.executeCommand(DocumentCommand.createSetDescription(groupSel, GROUP_PREFIX), false);
    // Standard JSON metadata serialization in TagInterface (v3e standard)
    document.executeCommand(DocumentCommand.createSetTagValueForKey(groupSel, TAG_KEY, JSON.stringify(params)), false);
    document.executeCommand(DocumentCommand.createSetTagValueForKey(groupSel, "effectPipeline", JSON.stringify([{ id: "radial_repeat", params: params }])), false);
  } catch (e) {
    console.log("Radial Repeat metadata error: " + e);
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

  // 3. Line / Stroke Style (Accurate stroke detection: No phantom strokes)
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

/**
 * Modulates the alpha and binds the exact BlendMode of a FillDescriptor
 * so live preview accurately renders blend modes (Multiply, Screen, Overlay, etc.)
 * and semi-transparent opacity in real-time.
 */
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

/**
 * Extracts PolyCurve entries from a node in local container coordinates.
 * When containerTransform is provided (e.g. from existingGroup), the spread-space
 * polycurve is inverted by containerTransform to recover the pristine local geometry.
 */
function extractGeomEntriesFromNode(node, containerTransform) {
  const entries = [];
  if (!node) return entries;

  const containerInv = (containerTransform && containerTransform.inverted) ? containerTransform.inverted : null;

  // 1. Procedural effect containers (extract deformed results)
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

  // 2. Nodes with children (Groups, Containers, LayerNodes)
  const children = getChildren(node);
  if (children.length > 0) {
    for (const child of children) {
      const subEntries = extractGeomEntriesFromNode(child, containerTransform);
      for (const entry of subEntries) entries.push(entry);
    }
    if (entries.length > 0) return entries;
  }

  // 3. Single vector curve or shape node (Rectangle, Ellipse, Star, PolyCurve, etc.)
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
    if (item && item.geomEntries) {
      const b = getEntriesBounds(item.geomEntries);
      if (b) {
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
// MULTI-SHAPE SEQUENCE PATTERN & LABELS
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
  if (count <= 1) {
    return "1 shape selected (select 2+ to mix across rows)";
  }
  const labels = [];
  for (let i = 0; i < count; i++) {
    labels.push(`${i + 1}=Shape ${indexToTemplateLetter(i)}`);
  }
  return labels.join("  •  ");
}

function buildDefaultRowPattern(rowCount, templateCount) {
  const rows = Math.max(1, Math.round(rowCount));
  const templates = Math.max(1, templateCount);
  const pattern = [];
  for (let row = 0; row < rows; row++) {
    pattern.push(String((row % templates) + 1));
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

function parseRowTemplatePattern(text, templateCount) {
  if (templateCount <= 1) return [0];

  const tokens = String(text || "")
    .split(/[^0-9A-Za-z]+/)
    .filter(token => token.length > 0);
  const result = [];

  for (const token of tokens) {
    const parsed = parseTemplateToken(token, templateCount);
    if (parsed !== null) result.push(parsed);
  }

  return result.length ? result : [0];
}

function getTemplateIndexForPlacement(placementIndex, placement, nodes, params) {
  if (nodes.length <= 1) return 0;

  if (params.rowTemplateMode) {
    const map = parseRowTemplatePattern(params.rowPattern, nodes.length);
    if (map.length > 0) {
      if (params.rows > 1) {
        return map[placement.row % map.length] % nodes.length;
      } else {
        return map[placement.index % map.length] % nodes.length;
      }
    }
  }

  return placementIndex % nodes.length;
}

// =============================================================================
// PLACEMENTS & TRANSFORMS (Container Local Space Engine)
// =============================================================================

function countTotalInstances(params) {
  let total = 0;
  for (let row = 0; row < params.rows; row++) {
    total += Math.max(1, params.instances + row * params.addedInstancesPerRow);
  }
  return total;
}

function buildPlacements(params, localCenter) {
  const total = countTotalInstances(params);
  if (total > MAX_TOTAL_INSTANCES) {
    throw new Error(`Too many instances (${total}). Limit is ${MAX_TOTAL_INSTANCES}.`);
  }

  const placements = [];

  for (let row = 0; row < params.rows; row++) {
    const count = Math.max(1, params.instances + row * params.addedInstancesPerRow);
    const radius = Math.max(0, params.radius + row * params.rowSpacing);
    const rowOffsetDeg = params.rowRotation * row;
    const rowScale = Math.pow(params.rowScaling, row);

    for (let i = 0; i < count; i++) {
      const circleT = i / count;
      const scaleT = count > 1 ? i / (count - 1) : 0;
      const angleDeg = rowOffsetDeg + circleT * 360;
      const angleRad = degToRad(angleDeg);
      const scale = (params.startScale + (params.endScale - params.startScale) * scaleT) * rowScale * (params.sizeScale || 1);
      const rotationDeg = params.customRotation ? params.customAngle : angleDeg;
      const rotationRad = degToRad(rotationDeg);

      placements.push({
        row,
        index: i,
        count,
        x: localCenter.x + Math.cos(angleRad) * radius,
        y: localCenter.y + Math.sin(angleRad) * radius,
        scale: Math.max(0.001, scale),
        rotation: rotationRad
      });
    }
  }

  return placements;
}

function buildPlacementTransform(localSourceCenter, placement) {
  return Transform
    .createTranslate(placement.x, placement.y)
    .multiply(Transform.createRotate(placement.rotation))
    .multiply(Transform.createScale(placement.scale, placement.scale))
    .multiply(Transform.createTranslate(-localSourceCenter.x, -localSourceCenter.y));
}

function clearPreviews(document) {
  try {
    document.executeCommand(DocumentCommand.createClearPreviews());
  } catch (e) {}
}

function doPreviewPolyCurves(document, sourceItems, targetNode, localGeometry, params, containerTransform) {
  clearPreviews(document);
  if (!sourceItems || !sourceItems.length) return;

  const placements = buildPlacements(params, localGeometry.center);
  const sourceNodes = sourceItems.map(s => s.node);
  const sourceCenters = sourceItems.map(s => s.localCenter);

  const addBuilder = AddChildNodesCommandBuilder.create();
  if (targetNode) {
    addBuilder.setInsertionTargetSelection(mkSel(targetNode));
    addBuilder.setInsertionMode(InsertionMode.Top);
  }

  // When reverseZIndex is true, add preview nodes in reverse order so inner items draw on top of outer items
  const indices = params.reverseZIndex
    ? Array.from({ length: placements.length }, (_, i) => placements.length - 1 - i)
    : Array.from({ length: placements.length }, (_, i) => i);

  for (const placementIndex of indices) {
    const templateIndex = getTemplateIndexForPlacement(placementIndex, placements[placementIndex], sourceNodes, params);
    const item = sourceItems[templateIndex];
    if (!item) continue;

    const localTransform = buildPlacementTransform(sourceCenters[templateIndex], placements[placementIndex]);
    const previewTransform = containerTransform ? containerTransform.multiply(localTransform) : localTransform;

    if (item.geomEntries && item.geomEntries.length) {
      for (const geom of item.geomEntries) {
        if (!geom || !geom.polyCurve) continue;
        const pc = geom.polyCurve.clone();
        try { pc.transform(previewTransform); } catch (e) {}
        const s = geom.style;
        const op = (typeof s.opacity === "number") ? s.opacity : 1.0;
        const bm = s.blendMode || null;

        // Apply opacity and blend mode modulation directly to preview brush and line fills
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

function doApply(document, nodes, localGeometry, params, existingGroup, sourceItems, containerTransform) {
  let targetGroup = existingGroup;

  if (existingGroup) {
    // -------------------------------------------------------------------------
    // 1. IN-PLACE CONTAINER UPDATE:
    // Keep existing container & sources untouched to preserve container matrix.
    // -------------------------------------------------------------------------
    const oldResults = getChildren(existingGroup).filter(isResultNode);
    const updateCb = CompoundCommandBuilder.create();

    // Delete old result items
    if (oldResults.length > 0) {
      updateCb.addCommand(DocumentCommand.createDeleteSelection(Selection.create(document, oldResults, true)));
    }

    // Update container title (Clean Name v3e Standard)
    updateCb.addCommand(DocumentCommand.createSetDescription(mkSel(existingGroup), GROUP_PREFIX));

    // Ensure sources are properly named and STAY HIDDEN in deterministic order
    for (let i = 0; i < nodes.length; i++) {
      const src = nodes[i];
      updateCb.addCommand(DocumentCommand.createSetDescription(mkSel(src), `${SOURCE_PREFIX} ${i + 1}`));
      updateCb.addCommand(DocumentCommand.createSetVisibility(mkSel(src), false));
    }
    document.executeCommand(updateCb.createCommand());

    // Explicitly serialize settings to TagInterface (v3e standard)
    setContainerMetadata(document, existingGroup, params);

  } else {
    // -------------------------------------------------------------------------
    // 2. FRESH CONTAINER CREATION (First run on raw shapes / groups)
    // -------------------------------------------------------------------------
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

    // Explicitly serialize settings to TagInterface (v3e standard)
    setContainerMetadata(document, targetGroup, params);
  }

  // ---------------------------------------------------------------------------
  // 3. GENERATE DUPLICATE ITEMS (1:1 Exact Spread-space Matching with Live Preview)
  // When existingGroup has containerTransform, the spread transform is:
  // T_spread = M_container * T_local * M_container^-1
  // ---------------------------------------------------------------------------
  const placements = buildPlacements(params, localGeometry.center);
  const sourceCenters = sourceItems.map(s => s.localCenter);
  const containerInv = (containerTransform && containerTransform.inverted) ? containerTransform.inverted : null;
  const dupCb = CompoundCommandBuilder.create();

  for (let placementIndex = 0; placementIndex < placements.length; placementIndex++) {
    const templateIndex = getTemplateIndexForPlacement(placementIndex, placements[placementIndex], nodes, params);
    const node = nodes[templateIndex];
    const localTransform = buildPlacementTransform(sourceCenters[templateIndex], placements[placementIndex]);

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

  // ---------------------------------------------------------------------------
  // 4. ORGANIZE INSIDE CONTAINER (Exact Z-Index Match with Live Preview)
  // ---------------------------------------------------------------------------
  const moveCb = CompoundCommandBuilder.create();
  const moveIndices = params.reverseZIndex
    ? Array.from({ length: dupNodes.length }, (_, i) => dupNodes.length - 1 - i)
    : Array.from({ length: dupNodes.length }, (_, i) => i);

  for (const i of moveIndices) {
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
    const templateIndex = getTemplateIndexForPlacement(i, placements[i], nodes, params);
    const srcNode = nodes[templateIndex];
    if (srcNode) {
      // Set Opacity
      if (srcNode.visibilityInterface && typeof srcNode.visibilityInterface.globalOpacity === "number") {
        const op = srcNode.visibilityInterface.globalOpacity;
        if (op < 0.999) {
          try {
            doc.executeCommand(DocumentCommand.createSetOpacity(mkSel(node), op), false);
          } catch (e) {}
        }
      }
      // Set Blend Mode
      try {
        const bm = (srcNode.blendModeInterface && srcNode.blendModeInterface.blendMode) || srcNode.blendMode;
        if (bm) {
          doc.executeCommand(DocumentCommand.createSetBlendMode(mkSel(node), bm), false);
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

function runRadialRepeat(document, rawNodes) {
  // Check for symbols in selection
  if (rawNodes.some(isSymbolNode)) {
    const warnDlg = Dialog.create("Symbols Not Supported");
    const warnCol = warnDlg.addColumn();
    warnCol.addStaticText(
      null,
      "Symbols are not supported in " + SCRIPT_TITLE + "."
    ).setIsFullWidth(true);
    warnCol.addStaticText(
      null,
      "Please detach or expand symbols into standard shapes, curves, or groups before using Radial Repeat."
    ).setIsFullWidth(true);
    warnDlg.show();
    return;
  }

  let existingGroup = null;
  let nodes = [];

  // Robust container & selection resolution (Extrude Tool v6de standard):
  if (rawNodes.length === 1 && isRadialRepeatGroup(rawNodes[0])) {
    existingGroup = rawNodes[0];
  } else {
    for (const node of rawNodes) {
      const pGrp = getRadialRepeatGroupOf(node);
      if (pGrp) {
        existingGroup = pGrp;
        break;
      }
    }
  }

  if (existingGroup) {
    const children = getChildren(existingGroup);
    const existingSources = children.filter(isSourceNode).sort((a, b) => getSourceIndex(a) - getSourceIndex(b));

    // Master sources maintain 100% geometric and styling integrity
    nodes = existingSources.length > 0 ? existingSources : children.filter(c => !isResultNode(c));
    if (nodes.length === 0) {
      nodes = children;
    }
  } else {
    // Canvas selection: 1 or more shapes, curves, or groups
    nodes = rawNodes;
  }

  // Double-check if nodes inside the container or resolved selection contain symbols
  if (nodes.some(isSymbolNode)) {
    const warnDlg = Dialog.create("Symbols Not Supported");
    const warnCol = warnDlg.addColumn();
    warnCol.addStaticText(
      null,
      "Symbols are not supported in " + SCRIPT_TITLE + "."
    ).setIsFullWidth(true);
    warnCol.addStaticText(
      null,
      "Please detach or expand symbols into standard shapes, curves, or groups before using Radial Repeat."
    ).setIsFullWidth(true);
    warnDlg.show();
    return;
  }

  // Extract container transform matrix (if editing existing container)
  const containerTransform = existingGroup ? getContainerTransform(existingGroup) : null;

  // Prepare source items with local-space PolyCurves for ultra-fast, smooth, distortion-free preview
  const sourceItems = nodes.map(node => {
    const entries = extractGeomEntriesFromNode(node, containerTransform);
    const b = getEntriesBounds(entries);
    return {
      node: node,
      geomEntries: entries,
      localCenter: b ? b.center : { x: 0, y: 0 }
    };
  });

  const localGeometry = buildLocalGeometry(sourceItems);
  const previewTargetNode = existingGroup || nodes[0];

  // ---------------------------------------------------------------------------
  // LIVE PREVIEW VISIBILITY MANAGEMENT:
  // - If editing existing container: hide old results during preview.
  //   Sources STAY hidden.
  // - If running on fresh primary shapes: hide primary objects during preview
  //   so only the repeating radial pattern is visible.
  // ---------------------------------------------------------------------------
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
      hidePrimariesCb.addCommand(DocumentCommand.createSetVisibility(mkSel(n), false));
    }
    document.executeCommand(hidePrimariesCb.createCommand());
  }

  // Read initial values from TagInterface metadata or defaults
  const initialValues = existingGroup ? readGroupValues(existingGroup, nodes.length) : sanitizeValues(DEFAULT_VALUES, nodes.length);

  // Dialog UI
  const dlg = Dialog.create(SCRIPT_TITLE);
  dlg.initialWidth = 640;

  const col1 = dlg.addColumn();

  const instancesGrp = col1.addGroup("Instances & Rows");
  const instancesCtrl = instancesGrp.addUnitValueEditor("Instances", UnitType.Number, UnitType.Number, initialValues.instances, 1, 500);
  instancesCtrl.precision = 0;
  const radiusCtrl = instancesGrp.addUnitValueEditor("Radius (px)", UnitType.Number, UnitType.Number, initialValues.radius, 0, 100000);
  radiusCtrl.precision = 1;
  radiusCtrl.showPopupSlider = true;
  const sizeCtrl = instancesGrp.addUnitValueEditor("Size (%)", UnitType.Percentage, UnitType.Percentage, initialValues.sizeScale * 100, 1, 1000);
  sizeCtrl.precision = 1;
  sizeCtrl.showPopupSlider = true;
  const rowsCtrl = instancesGrp.addUnitValueEditor("Rows", UnitType.Number, UnitType.Number, initialValues.rows, 1, 100);
  rowsCtrl.precision = 0;
  const rowSpacingCtrl = instancesGrp.addUnitValueEditor("Row Spacing (px)", UnitType.Number, UnitType.Number, initialValues.rowSpacing, 0, 100000);
  rowSpacingCtrl.precision = 1;
  rowSpacingCtrl.showPopupSlider = true;
  const addedCtrl = instancesGrp.addUnitValueEditor("Added Instances Per Row", UnitType.Number, UnitType.Number, initialValues.addedInstancesPerRow, 0, 500);
  addedCtrl.precision = 0;
  const rowRotationCtrl = instancesGrp.addUnitValueEditor("Row Rotation", UnitType.Degree, UnitType.Degree, initialValues.rowRotation, -3600, 3600);
  rowRotationCtrl.precision = 1;
  const reverseZIndexCtrl = instancesGrp.addSwitch("Reverse Stacking Order", initialValues.reverseZIndex);

  const rotationGrp = col1.addGroup("Rotation");
  const customRotationCtrl = rotationGrp.addSwitch("Enable Custom Rotation", initialValues.customRotation);
  const customAngleCtrl = rotationGrp.addUnitValueEditor("Angle (deg)", UnitType.Degree, UnitType.Degree, initialValues.customAngle, -3600, 3600);
  customAngleCtrl.precision = 1;

  const scalingGrp = col1.addGroup("Scaling");
  const startScaleCtrl = scalingGrp.addUnitValueEditor("Instances Start Scale (%)", UnitType.Percentage, UnitType.Percentage, initialValues.startScale * 100, 1, 1000);
  startScaleCtrl.precision = 1;
  startScaleCtrl.showPopupSlider = true;
  const endScaleCtrl = scalingGrp.addUnitValueEditor("Instances End Scale (%)", UnitType.Percentage, UnitType.Percentage, initialValues.endScale * 100, 1, 1000);
  endScaleCtrl.precision = 1;
  endScaleCtrl.showPopupSlider = true;
  const rowScaleCtrl = scalingGrp.addUnitValueEditor("Row Scaling (%)", UnitType.Percentage, UnitType.Percentage, initialValues.rowScaling * 100, 1, 1000);
  rowScaleCtrl.precision = 1;
  rowScaleCtrl.showPopupSlider = true;

  const col2 = dlg.addColumn();

  // Multi-Shape Rows Section (Rows terminology & conditional display)
  const templateGrp = col2.addGroup("Mix Shapes Across Rows");
  let rowTemplateModeCtrl = null;
  let objectLabelsCtrl = null;
  let rowPatternCtrl = null;

  if (nodes.length > 1) {
    rowTemplateModeCtrl = templateGrp.addSwitch("Mix Shapes by Row", initialValues.rowTemplateMode);
    objectLabelsCtrl = templateGrp.addStaticText("Your Shapes", buildObjectLabelText(nodes.length));
    
    rowPatternCtrl = templateGrp.addTextBox("Row Pattern (e.g. 1.2 or 1.2.1)", initialValues.rowPattern);
    rowPatternCtrl.isFullWidth = true;
    rowPatternCtrl.isMultiLine = true;
    rowPatternCtrl.rowSpan = 2;

    const rowPatternHelpCtrl = templateGrp.addStaticText(
      "How to arrange shapes",
      "Choose which shape goes on each row (from inner to outer):\n• Type shape numbers (1, 2) or letters (A, B) separated by dots.\n• Example: 1.2 alternates Shape 1 and Shape 2 on each row.\n• Example: 1.1.2 puts Shape 1 on rows 1 & 2, and Shape 2 on row 3."
    );
    rowPatternHelpCtrl.isFullWidth = true;
  } else {
    const singleInfoCtrl = templateGrp.addStaticText(
      null,
      "To use this feature, select 2 or more objects on your canvas before running the script."
    );
    singleInfoCtrl.isFullWidth = true;
  }

  // Standard Procedural Stack Info (Clean, concise)
  const noteGrp = col2.addGroup("");
  const txt1 = noteGrp.addStaticText(
    null,
    existingGroup ? "✨ Editing Radial Repeat in Stack ✨" : "✨ Non-destructive Procedural Repeat ✨"
  ).setIsFullWidth(true);
  txt1.textHorizontalAlignment = HorizontalAlignment.Centre;

  const txt2 = noteGrp.addStaticText(
    null,
    "Run this script again on the container to edit parameters."
  ).setIsFullWidth(true);
  txt2.textHorizontalAlignment = HorizontalAlignment.Centre;

  function updateTemplateControls() {
    if (objectLabelsCtrl) {
      objectLabelsCtrl.isEnabled = nodes.length > 1;
    }
  }

  function readValues() {
    const rows = clamp(Math.round(rowsCtrl.value), 1, 100);
    const patternText = (rowPatternCtrl && rowPatternCtrl.text && rowPatternCtrl.text.trim())
      ? rowPatternCtrl.text.trim()
      : initialValues.rowPattern;

    return sanitizeValues({
      instances: clamp(Math.round(instancesCtrl.value), 1, 500),
      radius: clamp(radiusCtrl.value, 0, 100000),
      sizeScale: clamp(sizeCtrl.value, 1, 1000) / 100,
      rows: rows,
      rowSpacing: clamp(rowSpacingCtrl.value, 0, 100000),
      addedInstancesPerRow: clamp(Math.round(addedCtrl.value), 0, 500),
      rowRotation: clamp(rowRotationCtrl.value, -3600, 3600),
      reverseZIndex: reverseZIndexCtrl ? !!reverseZIndexCtrl.value : initialValues.reverseZIndex,
      customRotation: !!customRotationCtrl.value,
      customAngle: clamp(customAngleCtrl.value, -3600, 3600),
      startScale: clamp(startScaleCtrl.value, 1, 1000) / 100,
      endScale: clamp(endScaleCtrl.value, 1, 1000) / 100,
      rowScaling: clamp(rowScaleCtrl.value, 1, 1000) / 100,
      rowTemplateMode: (rowTemplateModeCtrl ? !!rowTemplateModeCtrl.value : initialValues.rowTemplateMode) && nodes.length > 1,
      rowPattern: patternText
    }, nodes.length);
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
        doPreviewPolyCurves(document, sourceItems, previewTargetNode, localGeometry, params, containerTransform);
      } catch (e) {
        console.log(SCRIPT_TITLE + " preview error: " + e);
        clearPreviews(document);
      } finally {
        inPreview = false;
      }
    });
  }

  instancesCtrl.onValueChangedHandler = applyPreview;
  radiusCtrl.onValueChangedHandler = applyPreview;
  sizeCtrl.onValueChangedHandler = applyPreview;
  rowsCtrl.onValueChangedHandler = applyPreview;
  rowSpacingCtrl.onValueChangedHandler = applyPreview;
  addedCtrl.onValueChangedHandler = applyPreview;
  rowRotationCtrl.onValueChangedHandler = applyPreview;
  reverseZIndexCtrl.onValueChangedHandler = applyPreview;
  customRotationCtrl.onValueChangedHandler = applyPreview;
  customAngleCtrl.onValueChangedHandler = applyPreview;
  startScaleCtrl.onValueChangedHandler = applyPreview;
  endScaleCtrl.onValueChangedHandler = applyPreview;
  rowScaleCtrl.onValueChangedHandler = applyPreview;
  if (rowTemplateModeCtrl) {
    rowTemplateModeCtrl.onValueChangedHandler = function() {
      updateTemplateControls();
      applyPreview();
    };
  }
  if (rowPatternCtrl) {
    rowPatternCtrl.onValueChangedHandler = applyPreview;
  }
  dlg.onControlValueChangedHandler = applyPreview;

  updateTemplateControls();
  applyPreview();

  const result = dlg.show();
  if (previewTimer) previewTimer.cancel();
  clearPreviews(document);

  if (result.value === DialogResult.Ok.value) {
    const finalParams = readValues();
    try {
      doApply(document, nodes, localGeometry, finalParams, existingGroup, sourceItems, containerTransform);
    } catch (e) {
      alert("Application failed:\n" + e.message);
    }
  } else {
    // If Cancelled, restore visibility
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

  runRadialRepeat(doc, rawNodes);
}

module.exports.main = main;
module.exports.isRadialRepeatGroup = isRadialRepeatGroup;
module.exports.readGroupValues = readGroupValues;
module.exports.buildPlacements = buildPlacements;
module.exports.buildPlacementTransform = buildPlacementTransform;
module.exports.doApply = doApply;

main();
