/**
 * name: Extrude Tool v6de
 */
"use strict";

// =============================================================================
// EXTRUDE TOOL v6de (Robust Node Identity, Foreign/Duplicate Extraction & Synergy)
// Affinity Designer / Photo / Publisher
//
// Features & Fixes in v6de:
// - Robust DOM Identity Comparison (v6de Critical Fix):
//   Replaced referential equality (===) with isSameNode DOM equality across all
//   container detection and grouping logic. Affinity wrapper objects for the same
//   group node now correctly deduplicate, eliminating the 'Select at least 2 shapes'
//   error when 2 shapes inside a container are selected.
// - Foreign & Duplicate Shape Extraction:
//   Selecting 2 or more duplicate generated objects, duplicate caps, or foreign shapes
//   (e.g. 2 ellipses, rectangles, stars) inside a container automatically extracts
//   them above the container (NodeMoveType.After) and opens the Extrude dialog
//   to create a new separate extrusion, leaving the original container untouched.
// - Smart Sub-Selection Resolution:
//   Clicking on ANY single component of an extrusion on canvas or in the Layers
//   panel (Cap 1, Cap 2, Front Wall, Back Bevel, or any child curve) automatically
//   targets the parent Extrude container for parameter editing.
// - Non-Recursive Crash-Proof Architecture:
//   Zero recursive loops between group and result detection, completely eliminating
//   JavaScript stack overflows.
// - Safe Document Selection & Visibility:
//   Safely repoints document selection to the container group and non-destructively
//   toggles visibility during live preview to avoid dangling C++ pointers.
// - Swap Main/Secondary Re-entrancy Stability:
//   Preserves exact cap orientation and visual state across infinite re-runs
//   without inverting or flipping caps.
// - Canonical Cap Index Ordering:
//   Existing container caps maintain strict canonical identity (Cap 1, Cap 2, etc.)
//   independently of transient container Z-index stacking.
// - Clean Container Naming & JSON Metadata (Zig Zag v3e Standard):
//   Container group is named cleanly as 'Extrude Tool Effect' with zero parameter
//   clutter in the layer name. All active parameters are serialized as JSON in
//   tagInterface under 'extrudeSettings' and 'effectPipeline'.
// - Backward Compatibility:
//   Seamlessly reads parameters from existing legacy containers that had settings
//   in their name or tags.
// - Direct Procedural Effect Synergy:
//   Full native support for extruding paths and shapes with procedural effects
//   (Zig Zag, Roughen, Pucker & Bloat, Twist, etc.).
// - Re-entrant & Non-Destructive:
//   Re-run Extrude Tool on an existing group anytime to modify sliders, adjust bevel
//   profiles, or change blend steps.
// - Canvas Transform Re-adaptation:
//   Scale, move, or transform cap paths on canvas, then re-run Extrude Tool to
//   automatically recalculate and regenerate the 3D extrusion.
// - Red Layer Tag (v3d/v3e Standard):
//   Marks all generated Extrude Result containers/nodes with RGB8(255, 0, 0)
//   for seamless integration with Expand Effects v3d/v3e.
// - Spread Coordinate Baking:
//   Coordinates are baked in spread space via clonePolyCurveToSpread to eliminate
//   any canvas origin drifting.
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
const { Dialog, DialogResult } = require("/dialog");
const { Selection } = require("/selections");
const { FillDescriptor } = require("/fills");
const { LineStyleDescriptor } = require("/linestyle");
const { RGBA8, RGB8 } = require("/colours");
const { BlendMode } = require("affinity:common");
const { setTimeout } = require("/timers");

// =============================================================================
// CONSTANTS & REGISTRY
// =============================================================================

const SCRIPT_TITLE = 'Extrude Tool v6de';
const GROUP_PREFIX = 'Extrude Tool Effect';
const RESULT_PREFIX = 'Extrude Result';
const BEVEL_EDITOR_MAX = 10000;
const TAG_KEY = 'extrudeSettings';

const DEFAULT_VALUES = {
  steps: 1,
  subdivs: 5,
  opacity: 100,
  bevelEnabled: true,
  bevelCenter: 0,
  bevelHighToLow: 0,
  bevelLowToHigh: 0,
  preserveBevelBounds: false,
  swap: false
};

const EFFECT_ROUGHEN = 'roughen';
const EFFECT_ZIGZAG = 'zigzag';
const EFFECT_PUCKER_BLOAT = 'pucker_bloat';
const EFFECT_TWIST = 'twist';

const KNOWN_EFFECT_PREFIXES = [
  'Zig Zag Effect', 'Roughen Effect', 'Pucker & Bloat', 'Twist Effect',
  'Effects [', 'Effect Container'
];

const EffectRegistry = {
  [EFFECT_ROUGHEN]: {
    id: EFFECT_ROUGHEN,
    name: 'Roughen',
    defaultParams: { size: 5, isRelative: true, detail: 10, smooth: false, seed: 42 },
    sanitizeParams: function(p) {
      const size = (p && typeof p.size === 'number' && !isNaN(p.size)) ? Math.max(0, p.size) : 5;
      const isRelative = (p && p.isRelative !== undefined) ? !!p.isRelative : true;
      const detail = (p && typeof p.detail === 'number' && !isNaN(p.detail)) ? Math.max(1, Math.round(p.detail)) : 10;
      const smooth = (p && p.smooth !== undefined) ? !!p.smooth : false;
      const seed = (p && typeof p.seed === 'number' && !isNaN(p.seed)) ? Math.round(p.seed) : 42;
      return { size, isRelative, detail, smooth, seed };
    },
    evaluate: function(polyCurve, params) {
      const p = EffectRegistry[EFFECT_ROUGHEN].sanitizeParams(params);
      return buildRoughenPolyCurve(polyCurve, p.size, p.isRelative, p.detail, p.smooth, p.seed);
    }
  },
  [EFFECT_ZIGZAG]: {
    id: EFFECT_ZIGZAG,
    name: 'Zig Zag',
    defaultParams: { amp: 10, ridges: 8, smooth: false },
    sanitizeParams: function(p) {
      const amp = (p && typeof p.amp === 'number' && !isNaN(p.amp)) ? Math.max(0, p.amp) : 10;
      const ridges = (p && typeof p.ridges === 'number' && !isNaN(p.ridges)) ? Math.max(1, Math.round(p.ridges)) : 8;
      const smooth = (p && p.smooth !== undefined) ? !!p.smooth : false;
      return { amp, ridges, smooth };
    },
    evaluate: function(polyCurve, params) {
      const p = EffectRegistry[EFFECT_ZIGZAG].sanitizeParams(params);
      return buildZigZagPolyCurve(polyCurve, p.amp, p.ridges, p.smooth);
    }
  },
  [EFFECT_PUCKER_BLOAT]: {
    id: EFFECT_PUCKER_BLOAT,
    name: 'Pucker & Bloat',
    defaultParams: { amount: 50 },
    sanitizeParams: function(p) {
      const amount = (p && typeof p.amount === 'number' && !isNaN(p.amount)) ? Math.max(-200, Math.min(200, p.amount)) : 50;
      return { amount };
    },
    evaluate: function(polyCurve, params) {
      const p = EffectRegistry[EFFECT_PUCKER_BLOAT].sanitizeParams(params);
      return buildPuckerBloatPolyCurve(polyCurve, p.amount);
    }
  },
  [EFFECT_TWIST]: {
    id: EFFECT_TWIST,
    name: 'Twist',
    defaultParams: { angle: 45, subdiv: 40 },
    sanitizeParams: function(p) {
      const angle = (p && typeof p.angle === 'number' && !isNaN(p.angle)) ? Math.max(-3600, Math.min(3600, p.angle)) : 45;
      const subdiv = (p && typeof p.subdiv === 'number' && !isNaN(p.subdiv)) ? Math.max(4, Math.round(p.subdiv)) : 40;
      return { angle, subdiv };
    },
    evaluate: function(polyCurve, params) {
      const p = EffectRegistry[EFFECT_TWIST].sanitizeParams(params);
      return buildTwistPolyCurve(polyCurve, p.angle, p.subdiv);
    }
  }
};

const doc = Document.current;

// =============================================================================
// DOM, TAGS & CONTAINER DETECTION HELPERS (Non-Recursive, Safe & Strict Equality)
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

function findMatchingNode(list, target) {
  if (!target || !list) return null;
  for (const item of list) {
    if (isSameNode(item, target)) return item;
  }
  return null;
}

function pushUnique(nodes, node) {
  if (!node) return;
  for (const existing of nodes) {
    if (isSameNode(existing, node)) return;
  }
  nodes.push(node);
}

function getNodeName(node) {
  try { return node.userDescription || node.name || ''; } catch (e) { return ''; }
}

function getChildren(node) {
  const children = [];
  let child = null;
  try { child = node.firstChild; } catch (e) { child = null; }
  while (child) {
    children.push(child);
    try { child = child.nextSibling; } catch (e) { child = null; }
  }
  return children;
}

function isRedTagColour(colour) {
  if (!colour) return false;
  try {
    const rgba = colour.rgba8 || (colour.getRGBA8 ? colour.getRGBA8() : null);
    if (!rgba) return false;
    const r = rgba.r !== undefined ? rgba.r : rgba.red;
    const g = rgba.g !== undefined ? rgba.g : rgba.green;
    const b = rgba.b !== undefined ? rgba.b : rgba.blue;
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

/**
 * Non-recursive check: verifies only the node itself without inspecting children.
 */
function isExtrudeGroup(node) {
  if (!node || !node.isContainerNode) return false;
  try {
    if (node.tagInterface) {
      if (node.tagInterface.hasKey(TAG_KEY)) return true;
      if (node.tagInterface.hasKey('effectPipeline')) {
        const json = node.tagInterface.getValueForKey('effectPipeline');
        if (json && json.indexOf('"extrude"') >= 0) return true;
      }
    }
  } catch (e) {}
  const name = getNodeName(node);
  return name === GROUP_PREFIX || name.indexOf(GROUP_PREFIX) === 0 || name.indexOf('Extrude Tool') === 0 || name.indexOf('Extrude Effect') === 0;
}

function isProceduralEffectContainer(node) {
  if (!node || !node.isContainerNode) return false;
  if (isExtrudeGroup(node)) return false;
  try {
    if (node.tagInterface && (
      node.tagInterface.hasKey('effectPipeline') ||
      node.tagInterface.hasKey('zigZagSettings') ||
      node.tagInterface.hasKey('roughenSettings') ||
      node.tagInterface.hasKey('puckerBloatSettings') ||
      node.tagInterface.hasKey('twistSettings')
    )) return true;
  } catch (e) {}
  const name = getNodeName(node);
  for (const prefix of KNOWN_EFFECT_PREFIXES) {
    if (name.indexOf(prefix) === 0) return true;
  }
  return false;
}

/**
 * Non-recursive check: verifies if a node is an Extrude Result container or inside one.
 */
function isExtrudeResultNode(node) {
  if (!node) return false;
  if (hasRedTag(node)) return true;
  const name = getNodeName(node);
  if (name.indexOf(RESULT_PREFIX) === 0 || name.indexOf('Wall') >= 0 || name.indexOf('Bevel') >= 0) return true;
  
  let current = node.parent;
  while (current) {
    if (isExtrudeGroup(current)) return false;
    const pName = getNodeName(current);
    if (pName.indexOf(RESULT_PREFIX) === 0) return true;
    try { current = current.parent; } catch (e) { break; }
  }
  return false;
}

function isResultNode(node) {
  return isExtrudeResultNode(node);
}

function isSourceCapNode(node) {
  if (!node) return false;
  if (isExtrudeResultNode(node)) return false;
  if (isExtrudeGroup(node)) return false;
  return true;
}

function isStandardExtrudeCap(node) {
  if (!node || isExtrudeResultNode(node) || isExtrudeGroup(node)) return false;
  const name = getNodeName(node).trim();
  if (/^cap\s+\d+$/i.test(name)) return true;
  if (/^shape\s*node\s+\d+$/i.test(name)) return true;
  if (/^shape\s+\d+$/i.test(name)) return true;
  if (/^curve\s+\d+$/i.test(name)) return true;
  if (isProceduralEffectContainer(node)) return true;
  return false;
}

function isForeignNode(node, group) {
  if (!node || isSameNode(node, group)) return false;
  if (isExtrudeResultNode(node)) return false;
  if (isStandardExtrudeCap(node)) return false;
  return true;
}

function getCapIndex(node) {
  const name = getNodeName(node).trim();
  const m = name.match(/^(?:cap|shape|curve)\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : 99999;
}

function getProceduralEffectContainerOf(node) {
  let current = node;
  while (current) {
    if (isProceduralEffectContainer(current)) return current;
    try { current = current.parent; } catch (e) { break; }
  }
  return null;
}

function resolveToCapNode(node) {
  if (!node) return null;
  if (getExtrudeGroupOf(node)) return node;
  const effectContainer = getProceduralEffectContainerOf(node);
  if (effectContainer) return effectContainer;
  return node;
}

function isDescendantOf(node, parent) {
  let cur = node ? node.parent : null;
  while (cur) {
    if (isSameNode(cur, parent)) return true;
    try { cur = cur.parent; } catch (e) { break; }
  }
  return false;
}

function extractNodeFromContainer(node, group) {
  if (!node) return;
  try {
    const target = group || getExtrudeGroupOf(node);
    if (!target) return;
    const parent = node.parent;
    if (!parent) return;

    if (isSameNode(parent, target) || isDescendantOf(node, target)) {
      const cmd = DocumentCommand.createMoveNodes(
        Selection.create(doc, node, true),
        target,
        NodeMoveType.After,
        NodeChildType.Main
      );
      if (cmd) doc.executeCommand(cmd, false);
    }
  } catch (e) {}
}

function getExtrudeGroupOf(node) {
  let current = node;
  while (current) {
    if (isExtrudeGroup(current)) return current;
    try { current = current.parent; } catch (e) { break; }
  }
  return null;
}

function getSelectionNodes() {
  const nodes = [];
  try {
    if (doc.selection && doc.selection.items) {
      for (const item of doc.selection.items) {
        const n = (item && item.node) ? item.node : item;
        if (n) pushUnique(nodes, n);
      }
    }
  } catch (e) {}
  try {
    if (doc.selection && doc.selection.nodes) {
      for (const node of doc.selection.nodes.toArray()) {
        if (node) pushUnique(nodes, node);
      }
    }
  } catch (e) {}
  return nodes;
}

function nodeZRank(node) {
  let z = 0;
  try {
    let p = node.previousSibling;
    while (p) { z++; p = p.previousSibling; }
  } catch (e) {}
  return z;
}

function tagNodeRed(node) {
  if (!node) return;
  try {
    const sel = Selection.create(doc, node, true);
    doc.executeCommand(DocumentCommand.createSetTagColour(sel, RGB8(255, 0, 0)), false);
  } catch (e) {}
}

// =============================================================================
// METADATA SERIALIZATION & DESCRIPTIONS (Zig Zag v3e Standard)
// =============================================================================

function sanitizeValues(v) {
  if (!v) return { ...DEFAULT_VALUES };
  return {
    steps: (typeof v.steps === 'number' && !isNaN(v.steps)) ? Math.max(1, Math.min(50, Math.round(v.steps))) : DEFAULT_VALUES.steps,
    subdivs: (typeof v.subdivs === 'number' && !isNaN(v.subdivs)) ? Math.max(1, Math.min(32, Math.round(v.subdivs))) : DEFAULT_VALUES.subdivs,
    opacity: (typeof v.opacity === 'number' && !isNaN(v.opacity)) ? Math.max(0, Math.min(100, v.opacity)) : DEFAULT_VALUES.opacity,
    bevelEnabled: v.bevelEnabled !== undefined ? !!v.bevelEnabled : DEFAULT_VALUES.bevelEnabled,
    bevelCenter: (typeof v.bevelCenter === 'number' && !isNaN(v.bevelCenter)) ? Math.max(0, Math.round(v.bevelCenter)) : DEFAULT_VALUES.bevelCenter,
    bevelHighToLow: (typeof v.bevelHighToLow === 'number' && !isNaN(v.bevelHighToLow)) ? Math.max(0, Math.round(v.bevelHighToLow)) : DEFAULT_VALUES.bevelHighToLow,
    bevelLowToHigh: (typeof v.bevelLowToHigh === 'number' && !isNaN(v.bevelLowToHigh)) ? Math.max(0, Math.round(v.bevelLowToHigh)) : DEFAULT_VALUES.bevelLowToHigh,
    preserveBevelBounds: v.preserveBevelBounds !== undefined ? !!v.preserveBevelBounds : DEFAULT_VALUES.preserveBevelBounds,
    swap: v.swap !== undefined ? !!v.swap : DEFAULT_VALUES.swap
  };
}

function readGroupValues(group) {
  if (!group) return { ...DEFAULT_VALUES };

  // 1. TagInterface "extrudeSettings" (Primary JSON metadata)
  try {
    if (group.tagInterface && group.tagInterface.hasKey(TAG_KEY)) {
      const json = group.tagInterface.getValueForKey(TAG_KEY);
      if (json) {
        const parsed = JSON.parse(json);
        return sanitizeValues(parsed);
      }
    }
  } catch (e) {}

  // 2. TagInterface "effectPipeline" (Multi-effect pipeline metadata)
  try {
    if (group.tagInterface && group.tagInterface.hasKey("effectPipeline")) {
      const json = group.tagInterface.getValueForKey("effectPipeline");
      if (json) {
        const parsed = JSON.parse(json);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const exStage = parsed.find(s => s && s.id === "extrude");
          if (exStage && exStage.params) {
            return sanitizeValues(exStage.params);
          }
        }
      }
    }
  } catch (e) {}

  // 3. Name-based Regex fallback for legacy containers created with older versions
  const name = getNodeName(group);
  const regex = /steps=(\d+)\s+subdivs=(\d+)\s+op=([\d.]+)\s+bev=(0|1)\s+bevC=(\d+)\s+bevHL=(\d+)\s+bevLH=(\d+)\s+bevBnd=(0|1)\s+swap=(0|1)/;
  const match = regex.exec(name);
  if (match) {
    return sanitizeValues({
      steps: parseInt(match[1], 10),
      subdivs: parseInt(match[2], 10),
      opacity: parseFloat(match[3]),
      bevelEnabled: match[4] === '1',
      bevelCenter: parseInt(match[5], 10),
      bevelHighToLow: parseInt(match[6], 10),
      bevelLowToHigh: parseInt(match[7], 10),
      preserveBevelBounds: match[8] === '1',
      swap: match[9] === '1'
    });
  }

  return { ...DEFAULT_VALUES };
}

function formatGroupName(v) {
  return GROUP_PREFIX;
}

function createDeleteNodesCommand(nodes) {
  if (!nodes || !nodes.length) return null;
  return DocumentCommand.createDeleteSelection(Selection.create(doc, nodes, true));
}

// =============================================================================
// PROCEDURAL EFFECT PIPELINE EVALUATION
// =============================================================================

function readEffectPipeline(group) {
  if (!group) return [];
  try {
    if (group.tagInterface && group.tagInterface.hasKey("effectPipeline")) {
      const json = group.tagInterface.getValueForKey("effectPipeline");
      if (json) {
        const parsed = JSON.parse(json);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.map(stage => ({
            id: stage.id,
            params: EffectRegistry[stage.id] ? EffectRegistry[stage.id].sanitizeParams(stage.params) : stage.params
          })).filter(stage => !!EffectRegistry[stage.id]);
        }
      }
    }
  } catch (e) {}

  try {
    if (group.tagInterface) {
      if (group.tagInterface.hasKey("zigZagSettings")) {
        const s = JSON.parse(group.tagInterface.getValueForKey("zigZagSettings"));
        return [{ id: EFFECT_ZIGZAG, params: EffectRegistry[EFFECT_ZIGZAG].sanitizeParams(s) }];
      }
      if (group.tagInterface.hasKey("roughenSettings")) {
        const s = JSON.parse(group.tagInterface.getValueForKey("roughenSettings"));
        return [{ id: EFFECT_ROUGHEN, params: EffectRegistry[EFFECT_ROUGHEN].sanitizeParams(s) }];
      }
      if (group.tagInterface.hasKey("puckerBloatSettings")) {
        const s = JSON.parse(group.tagInterface.getValueForKey("puckerBloatSettings"));
        return [{ id: EFFECT_PUCKER_BLOAT, params: EffectRegistry[EFFECT_PUCKER_BLOAT].sanitizeParams(s) }];
      }
      if (group.tagInterface.hasKey("twistSettings")) {
        const s = JSON.parse(group.tagInterface.getValueForKey("twistSettings"));
        return [{ id: EFFECT_TWIST, params: EffectRegistry[EFFECT_TWIST].defaultParams }];
      }
    }
  } catch (e) {}

  const name = getNodeName(group);
  if (name.indexOf('Zig Zag') >= 0) return [{ id: EFFECT_ZIGZAG, params: { ...EffectRegistry[EFFECT_ZIGZAG].defaultParams } }];
  if (name.indexOf('Roughen') >= 0) return [{ id: EFFECT_ROUGHEN, params: { ...EffectRegistry[EFFECT_ROUGHEN].defaultParams } }];
  if (name.indexOf('Pucker') >= 0 || name.indexOf('Bloat') >= 0) return [{ id: EFFECT_PUCKER_BLOAT, params: { ...EffectRegistry[EFFECT_PUCKER_BLOAT].defaultParams } }];
  if (name.indexOf('Twist') >= 0) return [{ id: EFFECT_TWIST, params: { ...EffectRegistry[EFFECT_TWIST].defaultParams } }];

  return [];
}

function evaluatePipeline(sourcePolyCurve, pipeline) {
  if (!sourcePolyCurve) return PolyCurve.create();
  if (!pipeline || !pipeline.length) return sourcePolyCurve.clone();

  let current = sourcePolyCurve.clone();
  for (const stage of pipeline) {
    if (!stage || !stage.id) continue;
    const handler = EffectRegistry[stage.id];
    if (handler && handler.evaluate) {
      current = handler.evaluate(current, stage.params);
    }
  }
  return current;
}

function clonePolyCurveToSpread(node) {
  if (!node || !node.curvesInterface || !node.curvesInterface.polyCurve) return null;
  try {
    const pc = node.curvesInterface.polyCurve.clone();
    const xf = node.baseToSpreadTransform || (node.transformInterface ? node.transformInterface.transform : null);
    if (xf) {
      try { pc.transform(xf); } catch (e) {}
    }
    return pc;
  } catch (e) {
    return null;
  }
}

function extractCapPolyCurve(node) {
  if (!node) return null;

  const effectParent = getProceduralEffectContainerOf(node);
  const targetNode = effectParent || node;

  // 1. Procedural Effect Container Synergy
  if (isProceduralEffectContainer(targetNode)) {
    const children = getChildren(targetNode);
    const resultNodes = children.filter(c => hasRedTag(c) || getNodeName(c).indexOf('Result') === 0);
    for (const r of resultNodes) {
      if (r.curvesInterface && r.curvesInterface.polyCurve) {
        const pc = clonePolyCurveToSpread(r);
        if (pc && pc.curveCount > 0) return pc;
      }
    }

    const sourceNodes = children.filter(c => getNodeName(c).indexOf('Source') === 0);
    const pipeline = readEffectPipeline(targetNode);
    if (sourceNodes.length > 0 && sourceNodes[0].curvesInterface && sourceNodes[0].curvesInterface.polyCurve) {
      const basePC = clonePolyCurveToSpread(sourceNodes[0]);
      if (basePC) {
        return evaluatePipeline(basePC, pipeline);
      }
    }
  }

  // 2. Standard vector curve / shape / duplicated result curve / Ellipse / Rectangle / etc.
  if (node.curvesInterface && node.curvesInterface.polyCurve) {
    return clonePolyCurveToSpread(node);
  }

  return null;
}

// =============================================================================
// GEOMETRY & BEZIER MATH HELPERS
// =============================================================================

const lerp = (a, b, t) => a + (b - a) * t;
const lerpPt = (a, b, t) => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });
const lerpSeg = (a, b, t) => ({
  start: lerpPt(a.start, b.start, t),
  c1: lerpPt(a.c1, b.c1, t),
  c2: lerpPt(a.c2, b.c2, t),
  end: lerpPt(a.end, b.end, t)
});
const scalePtFromCenter = (p, c, s) => ({ x: c.x + (p.x - c.x) * s, y: c.y + (p.y - c.y) * s });
const scaleSegFromCenter = (seg, center, s) => ({
  start: scalePtFromCenter(seg.start, center, s),
  c1: scalePtFromCenter(seg.c1, center, s),
  c2: scalePtFromCenter(seg.c2, center, s),
  end: scalePtFromCenter(seg.end, center, s)
});

function splitAt(seg, t) {
  const p0 = seg.start, p1 = seg.c1, p2 = seg.c2, p3 = seg.end;
  const a = lerpPt(p0, p1, t), b = lerpPt(p1, p2, t), c = lerpPt(p2, p3, t);
  const d = lerpPt(a, b, t), e = lerpPt(b, c, t), f = lerpPt(d, e, t);
  return { left: { start: p0, c1: a, c2: d, end: f }, right: { start: f, c1: e, c2: c, end: p3 } };
}

function subdivide(segs, n) {
  if (n <= 1) return segs;
  const out = [];
  for (const seg of segs) {
    let rem = seg;
    for (let i = 0; i < n - 1; i++) {
      const parts = splitAt(rem, 1 / (n - i));
      out.push(parts.left);
      rem = parts.right;
    }
    out.push(rem);
  }
  return out;
}

function extractSegs(node) {
  try {
    const pc = extractCapPolyCurve(node);
    if (!pc || pc.curveCount === 0) return null;
    const curve = pc.at(0);
    const segs = [];
    for (const b of curve.beziers) {
      segs.push({
        start: { x: b.start.x, y: b.start.y },
        c1: { x: b.c1.x, y: b.c1.y },
        c2: { x: b.c2.x, y: b.c2.y },
        end: { x: b.end.x, y: b.end.y }
      });
    }
    return segs.length > 0 ? { segs, closed: curve.isClosed, n: segs.length } : null;
  } catch (e) {
    return null;
  }
}

function bestAlign(segsA, segsB) {
  const n = segsA.length;
  if (n !== segsB.length || n === 0) return segsB;
  let bestRot = 0, bestDist = Infinity;
  for (let r = 0; r < n; r++) {
    let dist = 0;
    for (let i = 0; i < n; i++) {
      const a = segsA[i].start, b = segsB[(i + r) % n].start;
      dist += (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
    }
    if (dist < bestDist) { bestDist = dist; bestRot = r; }
  }
  return bestRot === 0 ? segsB : [...segsB.slice(bestRot), ...segsB.slice(0, bestRot)];
}

function approxSegLen(s) {
  return (Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y)
    + Math.hypot(s.c1.x - s.start.x, s.c1.y - s.start.y)
    + Math.hypot(s.c2.x - s.c1.x, s.c2.y - s.c1.y)
    + Math.hypot(s.end.x - s.c2.x, s.end.y - s.c2.y)) / 2;
}

function approxPerimeter(segs) {
  let len = 0;
  for (const s of segs) len += approxSegLen(s);
  return len;
}

function segsCenter(segs) {
  let cx = 0, cy = 0;
  for (const s of segs) { cx += s.start.x; cy += s.start.y; }
  return { x: cx / segs.length, y: cy / segs.length };
}

function resampleToCount(segs, targetN) {
  const result = segs.map(s => ({ ...s }));
  while (result.length < targetN) {
    let maxLen = -1, maxIdx = 0;
    for (let i = 0; i < result.length; i++) {
      const l = approxSegLen(result[i]);
      if (l > maxLen) { maxLen = l; maxIdx = i; }
    }
    const parts = splitAt(result[maxIdx], 0.5);
    result.splice(maxIdx, 1, parts.left, parts.right);
  }
  return result;
}

function scaleSegsFromCenter(segs, center, scale) {
  return segs.map(seg => scaleSegFromCenter(seg, center, scale));
}

function addPointToBounds(bounds, p) {
  bounds.minX = Math.min(bounds.minX, p.x);
  bounds.minY = Math.min(bounds.minY, p.x);
  bounds.maxX = Math.max(bounds.maxX, p.x);
  bounds.maxY = Math.max(bounds.maxY, p.y);
}

function boundsFromSegGroups(segGroups) {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const segs of segGroups) {
    for (const seg of segs) {
      addPointToBounds(bounds, seg.start);
      addPointToBounds(bounds, seg.c1);
      addPointToBounds(bounds, seg.c2);
      addPointToBounds(bounds, seg.end);
    }
  }
  return bounds;
}

function boundsCenter(bounds) {
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
}

function fitScaleForBounds(segGroups, bounds, anchor) {
  let scale = 1;
  const EPS = 0.0001;
  const cp = p => {
    if (p.x > bounds.maxX && p.x > anchor.x + EPS) scale = Math.min(scale, (bounds.maxX - anchor.x) / (p.x - anchor.x));
    if (p.x < bounds.minX && p.x < anchor.x - EPS) scale = Math.min(scale, (bounds.minX - anchor.x) / (p.x - anchor.x));
    if (p.y > bounds.maxY && p.y > anchor.y + EPS) scale = Math.min(scale, (bounds.maxY - anchor.y) / (p.y - anchor.y));
    if (p.y < bounds.minY && p.y < anchor.y - EPS) scale = Math.min(scale, (bounds.minY - anchor.y) / (p.y - anchor.y));
  };
  for (const segs of segGroups) {
    for (const seg of segs) { cp(seg.start); cp(seg.c1); cp(seg.c2); cp(seg.end); }
  }
  return Math.max(0.001, Math.min(1, scale));
}

function facePC(sA, sB) {
  const cb = CurveBuilder.create();
  cb.beginXY(sA.start.x, sA.start.y);
  cb.addBezierXY(sA.c1.x, sA.c1.y, sA.c2.x, sA.c2.y, sA.end.x, sA.end.y);
  cb.lineToXY(sB.end.x, sB.end.y);
  cb.addBezierXY(sB.c2.x, sB.c2.y, sB.c1.x, sB.c1.y, sB.start.x, sB.start.y);
  cb.close();
  const pc = new PolyCurve();
  pc.addCurve(cb.createCurve());
  return pc;
}

function mkNode(poly, fill, strokeFill, lsd) {
  return PolyCurveNodeDefinition.create(poly, fill, lsd, strokeFill, FillDescriptor.createNone());
}

function faceSignedArea(sA, sB) {
  const pts = [sA.start, sA.end, sB.end, sB.start];
  let area = 0;
  for (let k = 0; k < 4; k++) {
    const p = pts[k], q = pts[(k + 1) % 4];
    area += p.x * q.y - q.x * p.y;
  }
  return area / 2;
}

function pathSignedArea(segs) {
  let area = 0;
  for (const s of segs) area += s.start.x * s.end.y - s.end.x * s.start.y;
  return area / 2;
}

// =============================================================================
// PROCEDURAL EFFECT ALGORITHMS (ZIGZAG, ROUGHEN, PUCKER, TWIST)
// =============================================================================

function evalBez(b, t) {
  const u = 1 - t;
  return {
    x: u * u * u * b.start.x + 3 * u * u * t * b.c1.x + 3 * u * t * t * b.c2.x + t * t * t * b.end.x,
    y: u * u * u * b.start.y + 3 * u * u * t * b.c1.y + 3 * u * t * t * b.c2.y + t * t * t * b.end.y
  };
}

function tanNorm(b, t) {
  const u = 1 - t;
  const dx = 3 * (u * u * (b.c1.x - b.start.x) + 2 * u * t * (b.c2.x - b.c1.x) + t * t * (b.end.x - b.c2.x));
  const dy = 3 * (u * u * (b.c1.y - b.start.y) + 2 * u * t * (b.c2.y - b.c1.y) + t * t * (b.end.y - b.c2.y));
  const l = Math.hypot(dx, dy) || 1e-9;
  return { tx: dx / l, ty: dy / l, nx: -dy / l, ny: dx / l };
}

function buildArcTable(beziers) {
  const tbl = [];
  let cum = 0;
  for (let bi = 0; bi < beziers.length; bi++) {
    const b = beziers[bi];
    let prev = evalBez(b, 0);
    tbl.push({ bi, t: 0, cum });
    for (let s = 1; s <= 500; s++) {
      const t = s / 500;
      const pt = evalBez(b, t);
      cum += Math.hypot(pt.x - prev.x, pt.y - prev.y);
      tbl.push({ bi, t, cum });
      prev = pt;
    }
  }
  return tbl;
}

function sampleAt(tbl, beziers, c) {
  const totalLen = tbl[tbl.length - 1].cum;
  if (c <= 0) return { p: evalBez(beziers[0], 0), g: tanNorm(beziers[0], 0) };
  if (c >= totalLen) {
    const lastBi = beziers.length - 1;
    return { p: evalBez(beziers[lastBi], 1), g: tanNorm(beziers[lastBi], 1) };
  }
  let lo = 0, hi = tbl.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (tbl[mid].cum <= c) lo = mid; else hi = mid;
  }
  const a = tbl[lo], b = tbl[hi];
  let bi = a.bi, t = a.t;
  if (a.bi === b.bi) {
    const span = b.cum - a.cum;
    const f = span < 1e-9 ? 0 : (c - a.cum) / span;
    t = a.t + (b.t - a.t) * f;
  } else {
    if (Math.abs(c - a.cum) < Math.abs(c - b.cum)) { bi = a.bi; t = a.t; }
    else { bi = b.bi; t = b.t; }
  }
  t = Math.max(0, Math.min(1, t));
  return { p: evalBez(beziers[bi], t), g: tanNorm(beziers[bi], t) };
}

function getEndTangent(b) {
  let dx = b.end.x - b.c2.x, dy = b.end.y - b.c2.y;
  if (Math.hypot(dx, dy) < 1e-9) {
    dx = b.end.x - b.c1.x; dy = b.end.y - b.c1.y;
    if (Math.hypot(dx, dy) < 1e-9) { dx = b.end.x - b.start.x; dy = b.end.y - b.start.y; }
  }
  const l = Math.hypot(dx, dy) || 1e-9;
  return { tx: dx / l, ty: dy / l };
}

function getStartTangent(b) {
  let dx = b.c1.x - b.start.x, dy = b.c1.y - b.start.y;
  if (Math.hypot(dx, dy) < 1e-9) {
    dx = b.c2.x - b.start.x; dy = b.c2.y - b.start.y;
    if (Math.hypot(dx, dy) < 1e-9) { dx = b.end.x - b.start.x; dy = b.end.y - b.start.y; }
  }
  const l = Math.hypot(dx, dy) || 1e-9;
  return { tx: dx / l, ty: dy / l };
}

function detectCorners(beziers, tbl, totalLen, closed) {
  const ANGLE_THRESHOLD = 15 * Math.PI / 180;
  const corners = [];
  const bezierEndCum = [];
  for (let bi = 0; bi < beziers.length; bi++) bezierEndCum[bi] = 0;
  for (let j = 0; j < tbl.length; j++) {
    if (tbl[j].t === 1) bezierEndCum[tbl[j].bi] = tbl[j].cum;
  }
  const n = beziers.length;
  for (let i = 0; i < n; i++) {
    const nextIdx = (i + 1) % n;
    if (!closed && nextIdx === 0) continue;
    const g1 = getEndTangent(beziers[i]);
    const g2 = getStartTangent(beziers[nextIdx]);
    const dot = g1.tx * g2.tx + g1.ty * g2.ty;
    const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
    if (angle > ANGLE_THRESHOLD) {
      let cum = bezierEndCum[i];
      if (closed && i === n - 1 && Math.abs(cum - totalLen) < 1e-6) cum = 0;
      let bx = g1.tx + g2.tx, by = g1.ty + g2.ty;
      let bl = Math.hypot(bx, by);
      if (bl < 1e-9) { bx = -g1.ty; by = g1.tx; bl = 1.0; }
      corners.push({ cum: cum, tx: bx / bl, ty: by / bl });
    }
  }
  corners.sort((a, b) => a.cum - b.cum);
  return corners;
}

function buildZigZagPolyCurve(sourcePolyCurve, amp, ridges, smooth) {
  if (amp <= 0 || ridges <= 0) return sourcePolyCurve.clone();
  const out = PolyCurve.create();
  for (const curve of sourcePolyCurve) {
    const beziers = [...curve.beziers];
    if (!beziers.length) continue;
    const tbl = buildArcTable(beziers);
    const totalLen = tbl[tbl.length - 1].cum;
    if (totalLen < 1e-9) { out.addCurve(curve.clone()); continue; }
    const closed = curve.isClosed;
    const corners = detectCorners(beziers, tbl, totalLen, closed);
    const peaks = ridges * 2;
    const step = totalLen / peaks;
    const pts = [];
    if (closed) {
      for (let i = 0; i < peaks; i++) {
        const sampled = sampleAt(tbl, beziers, i * step);
        const sign = i % 2 === 0 ? 1 : -1;
        pts.push({ x: sampled.p.x + sampled.g.nx * amp * sign, y: sampled.p.y + sampled.g.ny * amp * sign, tx: sampled.g.tx, ty: sampled.g.ty });
      }
    } else {
      for (let i = 0; i <= peaks; i++) {
        const sampled = sampleAt(tbl, beziers, Math.min(i * step, totalLen));
        const sign = (i === 0 || i === peaks) ? 0 : (i % 2 === 1 ? 1 : -1);
        pts.push({ x: sampled.p.x + sampled.g.nx * amp * sign, y: sampled.p.y + sampled.g.ny * amp * sign, tx: sampled.g.tx, ty: sampled.g.ty });
      }
    }
    const builder = CurveBuilder.create();
    builder.beginXY(pts[0].x, pts[0].y);
    const count = closed ? pts.length : pts.length - 1;
    if (smooth) {
      for (let i = 0; i < count; i++) {
        const p0 = pts[i], p1 = pts[(i + 1) % pts.length];
        const h = Math.hypot(p1.x - p0.x, p1.y - p0.y) / 3;
        builder.addBezierXY(p0.x + p0.tx * h, p0.y + p0.ty * h, p1.x - p1.tx * h, p1.y - p1.ty * h, p1.x, p1.y);
      }
    } else {
      for (let i = 1; i <= count; i++) builder.lineToXY(pts[i % pts.length].x, pts[i % pts.length].y);
    }
    if (closed) builder.close();
    out.addCurve(builder.createCurve());
  }
  return out;
}

function readPolyCurveBounds(polyCurve) {
  let bbox = null;
  try { bbox = polyCurve.exactBoundingBox || polyCurve.boundingBox; } catch (e) {}
  if (!bbox) return { x: 0, y: 0, width: 100, height: 100, cx: 50, cy: 50, maxDimension: 100 };
  const w = (bbox.width !== undefined) ? bbox.width : 100;
  const h = (bbox.height !== undefined) ? bbox.height : 100;
  const x = (bbox.x !== undefined) ? bbox.x : 0;
  const y = (bbox.y !== undefined) ? bbox.y : 0;
  return { x, y, width: w, height: h, cx: x + w / 2, cy: y + h / 2, maxDimension: Math.max(w, h, 1) };
}

function pseudoNoise(seed, index) {
  const n = index * 12.9898 + seed * 78.233;
  const f = Math.sin(n) * 43758.5453;
  return (f - Math.floor(f)) * 2 - 1;
}

function buildRoughenPolyCurve(sourcePolyCurve, size, isRelative, detail, smooth, seed) {
  if (!sourcePolyCurve) return PolyCurve.create();
  if (size <= 0) return sourcePolyCurve.clone();
  const bounds = readPolyCurveBounds(sourcePolyCurve);
  const INCH_PT = 72;
  const safeSeed = seed || 42;
  const out = PolyCurve.create();
  let globalPointIdx = 0;
  for (const curve of sourcePolyCurve) {
    const beziers = [...curve.beziers];
    if (!beziers.length) continue;
    const tbl = buildArcTable(beziers);
    const totalLen = tbl[tbl.length - 1].cum;
    if (totalLen < 1e-9) { out.addCurve(curve.clone()); continue; }
    const closed = curve.isClosed;
    const actualAmp = isRelative ? (Math.max(bounds.maxDimension, totalLen * 0.5) * (size / 100)) : size;
    let segments = Math.max(2, Math.round(detail * (totalLen / INCH_PT)));
    if (closed && segments % 2 !== 0) segments += 1;
    const step = totalLen / segments;
    const pts = [];
    const count = closed ? segments : segments + 1;
    for (let i = 0; i < count; i++) {
      const isEndpoint = !closed && (i === 0 || i === segments);
      const c = Math.min(i * step, totalLen);
      const sampled = sampleAt(tbl, beziers, c);
      let disp = 0;
      if (!isEndpoint) {
        const nVal = pseudoNoise(safeSeed, globalPointIdx + i * 3);
        disp = nVal * actualAmp;
      }
      pts.push({ x: sampled.p.x + sampled.g.nx * disp, y: sampled.p.y + sampled.g.ny * disp, tx: sampled.g.tx, ty: sampled.g.ty });
    }
    globalPointIdx += count + 10;
    const builder = CurveBuilder.create();
    builder.beginXY(pts[0].x, pts[0].y);
    const loopCount = closed ? pts.length : pts.length - 1;
    if (smooth) {
      for (let i = 0; i < loopCount; i++) {
        const p0 = pts[i], p1 = pts[(i + 1) % pts.length];
        const h = Math.hypot(p1.x - p0.x, p1.y - p0.y) / 3;
        builder.addBezierXY(p0.x + p0.tx * h, p0.y + p0.ty * h, p1.x - p1.tx * h, p1.y - p1.ty * h, p1.x, p1.y);
      }
    } else {
      for (let i = 1; i <= loopCount; i++) builder.lineToXY(pts[i % pts.length].x, pts[i % pts.length].y);
    }
    if (closed) builder.close();
    out.addCurve(builder.createCurve());
  }
  return out;
}

function warpPoint(pt, cx, cy, scale) {
  return { x: cx + (pt.x - cx) * scale, y: cy + (pt.y - cy) * scale };
}

function buildPuckerBloatPolyCurve(sourcePolyCurve, amount) {
  const bbox = readPolyCurveBounds(sourcePolyCurve);
  const center = { x: bbox.cx, y: bbox.cy };
  const t = amount / 100;
  const anchorScale = 1 - t;
  const handleScale = 1 + t;
  const out = PolyCurve.create();
  for (const curve of sourcePolyCurve) {
    const beziers = [...curve.beziers];
    if (!beziers.length) { out.addCurve(curve.clone()); continue; }
    const builder = CurveBuilder.create();
    const first = warpPoint(beziers[0].start, center.x, center.y, anchorScale);
    builder.beginXY(first.x, first.y);
    for (const bez of beziers) {
      const c1 = warpPoint(bez.c1, center.x, center.y, handleScale);
      const c2 = warpPoint(bez.c2, center.x, center.y, handleScale);
      const end = warpPoint(bez.end, center.x, center.y, anchorScale);
      builder.addBezierXY(c1.x, c1.y, c2.x, c2.y, end.x, end.y);
    }
    if (curve.isClosed) builder.close();
    out.addCurve(builder.createCurve());
  }
  return out;
}

function twistPoint(point, cx, cy, angleRad, maxR) {
  const dx = point.x - cx, dy = point.y - cy;
  const r = Math.hypot(dx, dy);
  if (r < 1e-9) return point;
  const angle = Math.atan2(dy, dx) + angleRad * (r / maxR);
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
}

function buildTwistPolyCurve(sourcePolyCurve, angleDeg, subdiv) {
  const bounds = readPolyCurveBounds(sourcePolyCurve);
  const cx = bounds.cx, cy = bounds.cy;
  const maxR = Math.hypot(bounds.width / 2, bounds.height / 2) || 1;
  const angleRad = angleDeg * Math.PI / 180;
  const out = PolyCurve.create();
  for (const curve of sourcePolyCurve) {
    const beziers = [...curve.beziers];
    if (!beziers.length) { out.addCurve(curve.clone()); continue; }
    const points = [];
    for (const bez of beziers) {
      for (let step = 0; step < subdiv; step++) points.push(evalBez(bez, step / subdiv));
    }
    if (!curve.isClosed) {
      const last = beziers[beziers.length - 1];
      points.push({ x: last.end.x, y: last.end.y });
    }
    const twisted = points.map(point => twistPoint(point, cx, cy, angleRad, maxR));
    const builder = CurveBuilder.create();
    builder.beginXY(twisted[0].x, twisted[0].y);
    for (let i = 1; i < twisted.length; i++) builder.lineToXY(twisted[i].x, twisted[i].y);
    if (curve.isClosed) builder.close();
    out.addCurve(builder.createCurve());
  }
  return out;
}

// =============================================================================
// EXTRUDE GEOMETRY GENERATION PIPELINE
// =============================================================================

function prepareShapes(rawNodes) {
  let shapes = rawNodes.map(n => {
    const d = extractSegs(n);
    return d ? { node: n, d } : null;
  }).filter(Boolean);

  if (shapes.length < 2) return null;

  const maxN = Math.max(...shapes.map(s => s.d.n));
  shapes = shapes.map(sh => {
    if (sh.d.n < maxN) {
      return {
        node: sh.node,
        d: { segs: resampleToCount(sh.d.segs, maxN), closed: sh.d.closed, n: maxN }
      };
    }
    return sh;
  });

  const scored = shapes.map(sh => ({
    sh,
    perim: approxPerimeter(sh.d.segs),
    zRank: nodeZRank(sh.node)
  }));
  const maxP = Math.max(...scored.map(d => d.perim)) || 1;
  const maxZ = Math.max(...scored.map(d => d.zRank)) || 1;
  scored.sort((a, b) => ((b.perim / maxP) * 0.6 + (b.zRank / maxZ) * 0.4) - ((a.perim / maxP) * 0.6 + (a.zRank / maxZ) * 0.4));
  return scored.map(d => d.sh);
}

function prepareExistingGroupShapes(sourceNodes) {
  // Sort sourceNodes strictly by their canonical Cap index (Cap 1, Cap 2, etc.)
  const sortedSourceNodes = [...sourceNodes].sort((a, b) => {
    const idxA = getCapIndex(a);
    const idxB = getCapIndex(b);
    if (idxA !== idxB) return idxA - idxB;
    return nodeZRank(a) - nodeZRank(b);
  });

  let shapes = sortedSourceNodes.map(n => {
    const d = extractSegs(n);
    return d ? { node: n, d } : null;
  }).filter(Boolean);

  if (shapes.length < 2) return null;

  const maxN = Math.max(...shapes.map(s => s.d.n));
  shapes = shapes.map(sh => {
    if (sh.d.n < maxN) {
      return {
        node: sh.node,
        d: { segs: resampleToCount(sh.d.segs, maxN), closed: sh.d.closed, n: maxN }
      };
    }
    return sh;
  });

  return shapes;
}

function runExtrude() {
  if (!doc) {
    alert("No document open.");
    return;
  }

  const selectedNodes = getSelectionNodes();
  if (!selectedNodes || !selectedNodes.length) {
    alert("Select at least 2 shapes to extrude, or an Extrude Tool effect group to edit.");
    return;
  }

  // 1. Group selected nodes by their parent Extrude container using isSameNode deduplication
  const extrudeGroups = [];
  const groupItemsMap = [];
  const standaloneNodes = [];

  for (const n of selectedNodes) {
    const grp = getExtrudeGroupOf(n);
    if (grp) {
      let gIdx = -1;
      for (let i = 0; i < extrudeGroups.length; i++) {
        if (isSameNode(extrudeGroups[i], grp)) {
          gIdx = i;
          break;
        }
      }
      if (gIdx === -1) {
        extrudeGroups.push(grp);
        groupItemsMap.push([n]);
      } else {
        pushUnique(groupItemsMap[gIdx], n);
      }
    } else {
      pushUnique(standaloneNodes, n);
    }
  }

  // ---------------------------------------------------------------------------
  // CASE A: Selection is purely within exactly 1 Extrude container
  // ---------------------------------------------------------------------------
  if (extrudeGroups.length === 1 && standaloneNodes.length === 0) {
    const targetGroup = extrudeGroups[0];
    const itemsInGroup = groupItemsMap[0];

    // If exactly 1 node is selected (container itself, 1 cap, 1 wall/bevel, or 1 child curve)
    if (itemsInGroup.length === 1) {
      const singleNode = itemsInGroup[0];
      if (isForeignNode(singleNode, targetGroup)) {
        extractNodeFromContainer(singleNode, targetGroup);
        alert("Extracted foreign element from container. Select at least 2 vector shapes to extrude.");
        return;
      }
      // Single cap, result face, or container selected -> Edit container parameters!
      mainUpdateGroup(targetGroup);
      return;
    }

    // If 2 or more nodes are selected inside the container:
    const allChildren = getChildren(targetGroup);
    const canonicalCaps = allChildren.filter(c => !isExtrudeResultNode(c) && isStandardExtrudeCap(c));
    const nonResultChildren = allChildren.filter(c => !isExtrudeResultNode(c));
    const capNames = nonResultChildren.map(c => getNodeName(c).trim());
    const hasDuplicateCaps = new Set(capNames).size !== capNames.length;
    const hasForeigners = nonResultChildren.some(c => !isStandardExtrudeCap(c));

    // Pure update ONLY if the selection matches all original canonical caps with no duplicates/foreigners
    const isPureCanonicalCapsSelection = !hasDuplicateCaps &&
      !hasForeigners &&
      canonicalCaps.length === itemsInGroup.length &&
      canonicalCaps.every(cap => itemsInGroup.some(item => isSameNode(item, cap)));

    if (isPureCanonicalCapsSelection) {
      mainUpdateGroup(targetGroup);
      return;
    }

    // Otherwise: user selected 2 duplicates of generated objects, 2 foreign objects (e.g. 2 ellipses),
    // duplicate caps, or a sub-selection inside the container.
    // Extract them out of the container to create a new extrusion, keeping the container intact!
    const extractedList = [];
    for (const item of itemsInGroup) {
      extractNodeFromContainer(item, targetGroup);
      const resolved = resolveToCapNode(item);
      if (resolved) pushUnique(extractedList, resolved);
    }

    if (extractedList.length >= 2) {
      mainCreate(extractedList);
    } else {
      alert("Extracted elements from container. Select at least 2 vector shapes to extrude.");
    }
    return;
  }

  // ---------------------------------------------------------------------------
  // CASE B: Standalone nodes selected on canvas (no existing group involved)
  // ---------------------------------------------------------------------------
  if (extrudeGroups.length === 0 && standaloneNodes.length >= 2) {
    const rawSel = [];
    for (const n of standaloneNodes) {
      const resolved = resolveToCapNode(n);
      if (resolved) pushUnique(rawSel, resolved);
    }
    if (rawSel.length >= 2) {
      mainCreate(rawSel);
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // CASE C: Mixed selection (items inside group + items outside group)
  // ---------------------------------------------------------------------------
  if (extrudeGroups.length > 0 && (standaloneNodes.length > 0 || extrudeGroups.length > 1)) {
    const rawSel = [];
    for (let g = 0; g < extrudeGroups.length; g++) {
      const grp = extrudeGroups[g];
      const items = groupItemsMap[g] || [];
      for (const item of items) {
        if (!isExtrudeGroup(item)) {
          extractNodeFromContainer(item, grp);
        }
      }
    }
    for (const n of selectedNodes) {
      if (isExtrudeGroup(n)) continue;
      const resolved = resolveToCapNode(n);
      if (resolved) pushUnique(rawSel, resolved);
    }
    if (rawSel.length >= 2) {
      mainCreate(rawSel);
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // Fallback: If 1 group selected, update it
  // ---------------------------------------------------------------------------
  if (extrudeGroups.length === 1) {
    mainUpdateGroup(extrudeGroups[0]);
    return;
  }

  alert("Select at least 2 shapes to extrude, or an Extrude Tool effect group to edit.");
}

function mainCreate(rawNodes) {
  try {
    const shapes = prepareShapes(rawNodes);
    if (!shapes || shapes.length < 2) {
      alert("Could not read curves. Please select at least 2 valid vector shapes.");
      return;
    }
    runDialog(shapes, DEFAULT_VALUES, null);
  } catch (e) {
    console.log("mainCreate error: " + e);
  }
}

function mainUpdateGroup(group) {
  try {
    const initialValues = readGroupValues(group);
    let sourceNodes = getChildren(group).filter(isSourceCapNode);

    // Prefer nodes named Cap 1, Cap 2, etc. if present
    const capNamedNodes = sourceNodes.filter(n => /^cap\s+\d+$/i.test(getNodeName(n)));
    if (capNamedNodes.length >= 2) {
      sourceNodes = capNamedNodes;
    }

    if (sourceNodes.length < 2) {
      alert("Extrude Tool group must contain at least 2 source cap shapes.");
      return;
    }

    const shapes = prepareExistingGroupShapes(sourceNodes);
    if (!shapes || shapes.length < 2) {
      alert("Could not read curves from the group caps.");
      return;
    }

    // Set selection cleanly to the group BEFORE modifying child nodes
    try { doc.selection = mkSel(group); } catch (e) {}

    runDialog(shapes, initialValues, group);
  } catch (e) {
    console.log("mainUpdateGroup error: " + e);
  }
}

function runDialog(shapes, initialValues, existingGroup) {
  // Hide old result nodes non-destructively during live preview
  let oldResultsToHide = [];
  if (existingGroup) {
    try {
      oldResultsToHide = getChildren(existingGroup).filter(isResultNode);
      if (oldResultsToHide.length > 0) {
        const hideOldCb = CompoundCommandBuilder.create();
        for (const res of oldResultsToHide) {
          hideOldCb.addCommand(DocumentCommand.createSetVisibility(mkSel(res), false));
        }
        doc.executeCommand(hideOldCb.createCommand());
      }
    } catch (e) {}
  }

  function getActive(swap) {
    const base = swap ? [...shapes].reverse() : shapes;
    const active = base.map(sh => ({
      node: sh.node,
      d: { segs: [...sh.d.segs], closed: sh.d.closed, n: sh.d.n }
    }));
    if (active[0].d.closed) {
      for (let i = 1; i < active.length; i++) {
        active[i].d.segs = bestAlign(active[i - 1].d.segs, active[i].d.segs);
      }
    }
    return active;
  }

  function addFacesBetween(faceList, A, B, exNx, exNy) {
    const n = Math.min(A.length, B.length);
    for (let i = 0; i < n; i++) {
      const cx = (A[i].start.x + A[i].end.x + B[i].start.x + B[i].end.x) / 4;
      const cy = (A[i].start.y + A[i].end.y + B[i].start.y + B[i].end.y) / 4;
      faceList.push({
        pc: facePC(A[i], B[i]),
        depth: cx * exNx + cy * exNy,
        sa: faceSignedArea(A[i], B[i])
      });
    }
  }

  function bevelIsActive(p) {
    return p.bevelEnabled && Math.max(p.bevelCenter, p.bevelHighToLow, p.bevelLowToHigh) > 0;
  }

  function profileBevelAmount(active, index, p, zRanks) {
    if (!bevelIsActive(p)) return 0;
    const zMin = Math.min(...zRanks), zMax = Math.max(...zRanks);
    let highT = 0.5;
    if (zMax > zMin) highT = (zRanks[index] - zMin) / (zMax - zMin);
    else if (active.length > 1) highT = 1 - index / (active.length - 1);
    return p.bevelCenter + p.bevelHighToLow * highT + p.bevelLowToHigh * (1 - highT);
  }

  function build(active, p) {
    const sideFaces = [], frontBevelFaces = [], backBevelFaces = [];
    const cFront = segsCenter(active[0].d.segs), cBack = segsCenter(active[active.length - 1].d.segs);
    const exDx = cBack.x - cFront.x, exDy = cBack.y - cFront.y;
    const exLen = Math.hypot(exDx, exDy) || 1, exNx = exDx / exLen, exNy = exDy / exLen;
    const bevelOn = bevelIsActive(p);
    const zRanks = active.map(sh => nodeZRank(sh.node));

    let profiles = active.map((sh, index) => {
      const center = segsCenter(sh.d.segs);
      const amount = profileBevelAmount(active, index, p, zRanks);
      const bevelScale = amount > 0 ? 1 + amount / 100 : 1;
      const sideSegs = bevelScale > 1 ? scaleSegsFromCenter(sh.d.segs, center, bevelScale) : sh.d.segs;
      return { base: subdivide(sh.d.segs, p.subdivs), side: subdivide(sideSegs, p.subdivs) };
    });

    if (bevelOn && p.preserveBevelBounds) {
      const selectedBounds = boundsFromSegGroups(active.map(sh => sh.d.segs));
      const anchor = boundsCenter(selectedBounds);
      const fitScale = fitScaleForBounds(profiles.map(pr => pr.side), selectedBounds, anchor);
      if (fitScale < 1) {
        profiles = profiles.map(pr => ({
          base: pr.base,
          side: scaleSegsFromCenter(pr.side, anchor, fitScale)
        }));
      }
    }

    const subN = profiles[0].side.length;
    if (bevelOn) {
      const bevelSteps = Math.max(1, p.steps);
      const frontBase = profiles[0].base, frontSide = profiles[0].side;
      const backProfile = profiles[profiles.length - 1];
      for (let k = 0; k < bevelSteps; k++) {
        const t0 = k / bevelSteps, t1 = (k + 1) / bevelSteps;
        addFacesBetween(frontBevelFaces, frontBase.map((a, i) => lerpSeg(a, frontSide[i], t0)), frontBase.map((a, i) => lerpSeg(a, frontSide[i], t1)), exNx, exNy);
        addFacesBetween(backBevelFaces, backProfile.side.map((a, i) => lerpSeg(a, backProfile.base[i], t0)), backProfile.side.map((a, i) => lerpSeg(a, backProfile.base[i], t1)), exNx, exNy);
      }
    }

    for (let s = 0; s < profiles.length - 1; s++) {
      const A = profiles[s].side, B = profiles[s + 1].side;
      for (let k = 0; k < p.steps; k++) {
        const t0 = k / p.steps, t1 = (k + 1) / p.steps;
        addFacesBetween(sideFaces, A.map((a, i) => lerpSeg(a, B[i], t0)).slice(0, subN), A.map((a, i) => lerpSeg(a, B[i], t1)).slice(0, subN), exNx, exNy);
      }
    }

    return { allFaces: [...backBevelFaces, ...sideFaces, ...frontBevelFaces], sideFaces, frontBevelFaces, backBevelFaces };
  }

  function splitFaces(allFaces, active) {
    const fs = pathSignedArea(active[0].d.segs) > 0 ? -1 : 1;
    return {
      frontFaces: allFaces.filter(f => f.sa * fs >= 0),
      backFaces: allFaces.filter(f => f.sa * fs < 0)
    };
  }

  function makeDefs(faces, fill, stroke, lsd) {
    return [...faces].sort((a, b) => a.depth - b.depth).map(f => mkNode(f.pc, fill, stroke, lsd));
  }

  function readStyle(node, opacity) {
    const f = opacity / 100;
    let fill = FillDescriptor.createNone();
    let effectiveNode = node;

    if (isProceduralEffectContainer(node)) {
      const children = getChildren(node);
      const res = children.find(c => hasRedTag(c) || getNodeName(c).indexOf('Result') === 0) || children[0];
      if (res) effectiveNode = res;
    }

    try {
      const bfd = effectiveNode.brushFillDescriptor;
      if (bfd && bfd.type !== "none" && bfd.fill && bfd.fill.colour) {
        const c = bfd.fill.colour.rgba8;
        fill = FillDescriptor.createSolid(RGBA8(c.r, c.g, c.b, Math.min(255, Math.round(c.alpha * f))), BlendMode.Normal);
      }
    } catch (e) {}

    let stroke = FillDescriptor.createNone();
    try {
      const pfd = effectiveNode.penFillDescriptor;
      if (pfd && pfd.type !== "none") stroke = pfd;
    } catch (e) {}

    let lsd = null;
    try { lsd = effectiveNode.lineStyleDescriptor; } catch (e) {}
    if (!lsd) lsd = LineStyleDescriptor.createDefault(4.166);

    return { fill, stroke, lsd };
  }

  function buildFaceDefinitions(active, p) {
    const mainNode = active[0].node, secNode = active[active.length - 1].node;
    const built = build(active, p);
    const style = readStyle(mainNode, p.opacity);

    if (bevelIsActive(p)) {
      const sideSplit = splitFaces(built.sideFaces, active);
      const groups = [
        { name: "Back Wall", defs: makeDefs(sideSplit.backFaces, style.fill, style.stroke, style.lsd) },
        { name: "Back Bevel", defs: makeDefs(built.backBevelFaces, style.fill, style.stroke, style.lsd) },
        { name: "Front Wall", defs: makeDefs(sideSplit.frontFaces, style.fill, style.stroke, style.lsd) },
        { name: "Front Bevel", defs: makeDefs(built.frontBevelFaces, style.fill, style.stroke, style.lsd) }
      ].filter(g => g.defs.length > 0);

      const total = groups.reduce((sum, g) => sum + g.defs.length, 0);
      if (total === 0) return null;
      return { mainNode, secNode, groups, total, bevelMode: true };
    }

    const split = splitFaces(built.allFaces, active);
    const fDefs = makeDefs(split.frontFaces, style.fill, style.stroke, style.lsd);
    const bDefs = makeDefs(split.backFaces, style.fill, style.stroke, style.lsd);
    if (fDefs.length === 0 && bDefs.length === 0) return null;
    return { mainNode, secNode, fDefs, bDefs, F: fDefs.length, B: bDefs.length };
  }

  function doPreview(p) {
    try {
      doc.executeCommand(DocumentCommand.createClearPreviews());
      const active = getActive(p.swap);
      const faceDefs = buildFaceDefinitions(active, p);
      if (!faceDefs) return;

      const allDefs = faceDefs.bevelMode ? faceDefs.groups.flatMap(g => g.defs) : [...(faceDefs.bDefs || []), ...(faceDefs.fDefs || [])];
      const addBuilder = AddChildNodesCommandBuilder.create();

      const topNodeInActive = active[0].node;
      const bottomNodeInActive = active[active.length - 1].node;
      const isTopNodeHigherInDoc = nodeZRank(topNodeInActive) >= nodeZRank(bottomNodeInActive);

      if (isTopNodeHigherInDoc) {
        addBuilder.setInsertionTargetSelection(mkSel(bottomNodeInActive));
        addBuilder.setInsertionMode(InsertionMode.Top);
      } else {
        addBuilder.setInsertionTargetSelection(mkSel(bottomNodeInActive));
        addBuilder.setInsertionMode(InsertionMode.Top);

        const topCapPc = extractCapPolyCurve(topNodeInActive);
        if (topCapPc) {
          const capStyle = readStyle(topNodeInActive, 100);
          const topCapDef = mkNode(topCapPc, capStyle.fill, capStyle.stroke, capStyle.lsd);
          allDefs.push(topCapDef);
        }
      }

      allDefs.forEach(d => addBuilder.addNode(d));
      const cmd = addBuilder.createCommand(false, NodeChildType.Main);
      if (cmd) doc.executeCommand(cmd, true);
    } catch (e) {
      console.log("Preview error: " + e);
    }
  }

  function doApply(p) {
    try {
      const active = getActive(p.swap);
      const faceDefs = buildFaceDefinitions(active, p);
      if (!faceDefs) {
        alert("No geometry generated.");
        return;
      }

      let targetGroup = existingGroup;
      const prepCompound = CompoundCommandBuilder.create();
      const sortedNodes = [...shapes.map(s => s.node)].sort((a, b) => nodeZRank(a) - nodeZRank(b));

      if (!targetGroup) {
        const gBuilder = AddChildNodesCommandBuilder.create();
        gBuilder.setInsertionTargetSelection(mkSel(faceDefs.mainNode));
        gBuilder.setInsertionMode(InsertionMode.Top);
        gBuilder.addContainerNode(ContainerNodeDefinition.create(GROUP_PREFIX));
        const gCmd = gBuilder.createCommand(false, NodeChildType.Main);
        doc.executeCommand(gCmd);
        targetGroup = gCmd.newNodes[0];

        for (const node of sortedNodes) {
          prepCompound.addCommand(DocumentCommand.createMoveNodes(mkSel(node), targetGroup, NodeMoveType.Inside, NodeChildType.Main));
        }
      } else {
        prepCompound.addCommand(DocumentCommand.createSetDescription(mkSel(targetGroup), GROUP_PREFIX));
        const oldResultNodes = getChildren(targetGroup).filter(isResultNode);
        const delCmd = createDeleteNodesCommand(oldResultNodes);
        if (delCmd) prepCompound.addCommand(delCmd);
      }

      // Save JSON metadata in tagInterface (Zig Zag v3e Standard)
      try {
        prepCompound.addCommand(DocumentCommand.createSetTagValueForKey(mkSel(targetGroup), TAG_KEY, JSON.stringify(p)));
        prepCompound.addCommand(DocumentCommand.createSetTagValueForKey(mkSel(targetGroup), "effectPipeline", JSON.stringify([{ id: "extrude", params: p }])));
      } catch (e) {}

      // Ensure persistent canonical Cap names (Cap 1, Cap 2, ...)
      for (let i = 0; i < shapes.length; i++) {
        const node = shapes[i].node;
        prepCompound.addCommand(DocumentCommand.createSetDescription(mkSel(node), "Cap " + (i + 1)));
      }
      doc.executeCommand(prepCompound.createCommand());

      let layout = [];
      if (faceDefs.bevelMode) {
        layout = faceDefs.groups.map(g => ({ name: g.name, defs: g.defs }));
      } else {
        layout = [{ name: "Back", defs: faceDefs.bDefs }, { name: "Front", defs: faceDefs.fDefs }].filter(g => g.defs.length > 0);
      }

      const geomBuilder = AddChildNodesCommandBuilder.create();
      geomBuilder.setInsertionTarget(targetGroup);
      geomBuilder.setInsertionMode(InsertionMode.Inside);
      for (const group of layout) {
        geomBuilder.addContainerNode(ContainerNodeDefinition.create(RESULT_PREFIX + " " + group.name));
      }
      for (let g = layout.length - 1; g >= 0; g--) {
        layout[g].defs.forEach(d => geomBuilder.addNode(d));
      }
      const geomCmd = geomBuilder.createCommand(false, NodeChildType.Main);
      doc.executeCommand(geomCmd);
      const newNodes = geomCmd.newNodes;

      const moveCompound = CompoundCommandBuilder.create();
      let offset = 0;
      const createdContainers = newNodes.filter(n => n.isContainerNode);
      const getCont = (name) => createdContainers.find(c => (c.userDescription || c.name || "") === (RESULT_PREFIX + " " + name));

      for (let g = 0; g < layout.length; g++) {
        const group = layout[g], cont = getCont(group.name);
        for (let i = offset + group.defs.length - 1; i >= offset; i--) {
          moveCompound.addCommand(DocumentCommand.createMoveNodes(mkSel(newNodes[i]), cont, NodeMoveType.Inside, NodeChildType.Main));
        }
        offset += group.defs.length;
      }

      const frontWallCont = getCont("Front Wall") || getCont("Front");
      const frontBevelCont = getCont("Front Bevel");
      const backWallCont = getCont("Back Wall") || getCont("Back");
      const backBevelCont = getCont("Back Bevel");

      const origMainNode = shapes[0].node;
      const origSecNode = shapes[shapes.length - 1].node;
      const topCap = p.swap ? origSecNode : origMainNode;
      const bottomCap = p.swap ? origMainNode : origSecNode;

      let zStack = [bottomCap];
      for (const n of sortedNodes) {
        if (n !== origMainNode && n !== origSecNode) zStack.push(n);
      }
      zStack.push(backWallCont);
      zStack.push(backBevelCont);
      zStack.push(frontWallCont);
      zStack.push(frontBevelCont);
      zStack.push(topCap);
      zStack = zStack.filter(Boolean);

      for (let i = 1; i < zStack.length; i++) {
        moveCompound.addCommand(DocumentCommand.createMoveNodes(mkSel(zStack[i]), zStack[i - 1], NodeMoveType.After, NodeChildType.Main));
      }
      doc.executeCommand(moveCompound.createCommand());

      // Tag all result containers with Red Tag (v3d/v3e standard)
      for (const cont of createdContainers) {
        tagNodeRed(cont);
      }

      try { doc.selection = mkSel(targetGroup); } catch (e) {}
    } catch (e) {
      console.log("doApply error: " + e);
    }
  }

  // --- Dialog UI ---
  const dlg = Dialog.create("Extrude Tool");
  dlg.initialWidth = 340;
  const col = dlg.addColumn();

  const gBlend = col.addGroup("Blend");
  const eSteps = gBlend.addUnitValueEditor("Steps", "", "", initialValues.steps, 1, 20);
  eSteps.precision = 0; eSteps.showPopupSlider = false;
  const eSubdivs = gBlend.addUnitValueEditor("Smoothness", "", "", initialValues.subdivs, 1, 16);
  eSubdivs.precision = 0; eSubdivs.showPopupSlider = false;

  const gStyle = col.addGroup("Style");
  const eOp = gStyle.addUnitValueEditor("Opacity (%)", "", "%", initialValues.opacity, 0, 100);
  eOp.precision = 0; eOp.showPopupSlider = false;

  const gBevel = col.addGroup("Bevel");
  const sBevelEnabled = gBevel.addSwitch("Enable", initialValues.bevelEnabled);
  const eBevelCenter = gBevel.addUnitValueEditor("Center (%)", "", "%", initialValues.bevelCenter, 0, BEVEL_EDITOR_MAX);
  eBevelCenter.precision = 0; eBevelCenter.showPopupSlider = false;
  const eBevelHighToLow = gBevel.addUnitValueEditor("High Z -> Low Z (%)", "", "%", initialValues.bevelHighToLow, 0, BEVEL_EDITOR_MAX);
  eBevelHighToLow.precision = 0; eBevelHighToLow.showPopupSlider = false;
  const eBevelLowToHigh = gBevel.addUnitValueEditor("Low Z -> High Z (%)", "", "%", initialValues.bevelLowToHigh, 0, BEVEL_EDITOR_MAX);
  eBevelLowToHigh.precision = 0; eBevelLowToHigh.showPopupSlider = false;
  const sPreserveBevelBounds = gBevel.addSwitch("Preserve Bounds", initialValues.preserveBevelBounds);

  const gOpts = col.addGroup("Options");
  const sSwap = gOpts.addSwitch("Swap Main/Secondary", initialValues.swap);

  const gHelp = col.addGroup("How It Works");
  const t1 = gHelp.addStaticText(null, "• Re-run anytime to edit sliders or swap caps.").setIsFullWidth(true);
  const t2 = gHelp.addStaticText(null, "• Scale / move caps on canvas & re-run to auto-rebuild.").setIsFullWidth(true);
  const t3 = gHelp.addStaticText(null, "• Works with Zig Zag, Roughen & effect paths directly!").setIsFullWidth(true);

  const getP = () => sanitizeValues({
    steps: Math.max(1, Math.round(eSteps.value)),
    subdivs: Math.max(1, Math.round(eSubdivs.value)),
    opacity: eOp.value,
    bevelEnabled: sBevelEnabled.value,
    bevelCenter: Math.max(0, Math.round(eBevelCenter.value)),
    bevelHighToLow: Math.max(0, Math.round(eBevelHighToLow.value)),
    bevelLowToHigh: Math.max(0, Math.round(eBevelLowToHigh.value)),
    preserveBevelBounds: sPreserveBevelBounds.value,
    swap: sSwap.value
  });

  let inPreview = false, previewTimer = null;
  function applyPreview() {
    if (previewTimer) previewTimer.cancel();
    previewTimer = setTimeout(100, (err) => {
      if (err || inPreview) return;
      inPreview = true;
      try {
        doPreview(getP());
      } finally {
        inPreview = false;
      }
    });
  }

  eSteps.onValueChangedHandler = applyPreview;
  eSubdivs.onValueChangedHandler = applyPreview;
  eOp.onValueChangedHandler = applyPreview;
  sBevelEnabled.onValueChangedHandler = applyPreview;
  eBevelCenter.onValueChangedHandler = applyPreview;
  eBevelHighToLow.onValueChangedHandler = applyPreview;
  eBevelLowToHigh.onValueChangedHandler = applyPreview;
  sPreserveBevelBounds.onValueChangedHandler = applyPreview;
  sSwap.onValueChangedHandler = applyPreview;

  applyPreview();

  const result = dlg.show();
  if (previewTimer) previewTimer.cancel();
  const finalValues = getP();
  doc.executeCommand(DocumentCommand.createClearPreviews());

  if (result.value === DialogResult.Ok.value) {
    doApply(finalValues);
  } else {
    // Clean restore on cancel without re-extrusion overhead
    if (existingGroup && oldResultsToHide.length > 0) {
      try {
        const showOldCb = CompoundCommandBuilder.create();
        for (const res of oldResultsToHide) {
          showOldCb.addCommand(DocumentCommand.createSetVisibility(mkSel(res), true));
        }
        doc.executeCommand(showOldCb.createCommand());
      } catch (e) {}
    }
  }
}

// =============================================================================
// EXPORTS & ENTRY POINT
// =============================================================================

module.exports.main = runExtrude;
module.exports.extractCapPolyCurve = extractCapPolyCurve;
module.exports.isExtrudeGroup = isExtrudeGroup;
module.exports.readGroupValues = readGroupValues;

runExtrude();
