/**
 * name: Zig Zag Effect v3g
 */

'use strict';

// =============================================================================
// ZIG ZAG EFFECT v3g (Unified Multi-Effect Pipeline & Foreigner Object Extraction)
// Affinity Designer / Photo / Publisher (v3g & Multi-Effect Standard)
//
// Procedural Vector Zig Zag Effect:
// - Amplitude (px): Wave peak displacement height (unlocked up to 10,000px).
// - Ridges: Wave / zig-zag crest count along path segments (unlocked up to 10,000+ ridges).
// - Smooth wave:
//   * Off: Corner angular zig-zag peaks (lineToXY).
//   * On: Smooth wavy bezier curves (addBezierXY).
//
// Features & Architecture in v3g (Foreign Object Auto-Extraction & Cumulative Transform Invariance):
// - Foreign Object Auto-Extraction (v3g Core Feature):
//   If a non-generated foreign object (e.g. an ellipse, rectangle, star, custom curve, or
//   foreign group that was dragged, pasted, or duplicated inside the effect container) is detected,
//   the script automatically extracts it OUT of the container and applies the procedural
//   effect directly onto it as a new effect container, leaving the original container clean.
// - Permanent Multi-Run Stretch Preservation:
//   Source 1 permanently retains the pristine un-stretched base geometry (S_0) in local coordinates.
//   When the container is resized or stretched non-uniformly on canvas, the new stretch matrix (M_new)
//   is combined with the previous cumulative transform (C_old) via Transform.multiply(M_new, C_old) -> C_new.
//   Procedural wave, ridge count, and peak calculations are ALWAYS evaluated on the pristine S_0,
//   ensuring that ridge counts, wave frequencies, and crest positions never jump, reshuffle,
//   or distort across infinite re-runs (Run 1, Run 2, Run 3 ... Run N).
//   The cumulative transform C_new is serialized into container tag metadata using native
//   Affinity SDK transform decompose/compose.
// - 1:1 Live Preview & Output Synchronicity:
//   Live Preview and final applied output evaluate identical geometry and cumulative transforms,
//   guaranteeing 100% visual and mathematical match on every single run.
// - Clean Identity Matrix Reset & Baking on OK (M = I):
//   On clicking OK, resets the container's transform matrix to identity (M = I), stores S_0 in
//   Source 1 (hidden), and bakes C_new * R_local into Result 1 with Red Tag (#FF0000).
// - Parameter Purity:
//   Never mutates initialParams.amp or initialParams.ridges in the dialog.
// - 100% Style Fidelity:
//   Accurately extracts stroke style, pen fill descriptor, brush fill descriptor,
//   opacity, and blend modes using the native Affinity SDK interface properties:
//   * Brush Fill: node.brushFillInterface.currentDescriptor
//   * Stroke Fill & Style: node.lineStyleInterface.penFillDescriptor & lineStyleDescriptor
//   * Transparency: node.transparencyInterface.fillDescriptor
//   * Fallback resolution: Result 1 -> Source 1 -> Container Group
// - Direct In-Container Placement (InsertionMode.Inside):
//   Inserts Result layers directly inside the container group with InsertionMode.Inside,
//   keeping the container hierarchy pristine.
// - Multi-Effect Pipeline:
//   Stack multiple procedural effects (Zig Zag, Roughen, Twist, Pucker & Bloat)
//   on the same shape in any order.
// - Zero Phantom Strokes:
//   Never adds phantom strokes to un-stroked shapes.
// - Full Blend Mode & Opacity Fidelity in Live Preview:
//   Renders layer opacity and Blend Modes (Multiply, Screen, Overlay, etc.) in real time.
// - Red Layer Tag (#FF0000) & Expand Compatibility:
//   Result layers are tagged with RGB8(255, 0, 0) for seamless one-click baking via Expand Effects.
// - Symbol Protection:
//   Detects symbol instances and presents a helpful dialog to avoid crashes.
// =============================================================================

const { Document } = require('/document');
const {
  AddChildNodesCommandBuilder,
  CompoundCommandBuilder,
  DocumentCommand,
  InsertionMode,
  NodeChildType,
  NodeMoveType
} = require('/commands');
const {
  ContainerNodeDefinition,
  PolyCurveNodeDefinition
} = require('/nodes');
const { CurveBuilder, PolyCurve, Transform } = require('/geometry');
const { Dialog, DialogResult, HorizontalAlignment } = require('/dialog');
const { FillDescriptor, BlendMode } = require('/fills');
const { LineStyleDescriptor } = require('/linestyle');
const { RGB8 } = require('/colours');
const { Selection } = require('/selections');
const { UnitType } = require('/units');
const { setTimeout } = require('/timers');

// =============================================================================
// EFFECT REGISTRY & CONSTANTS
// =============================================================================

const SCRIPT_TITLE = 'Zig Zag Effect v3g';
const CURRENT_EFFECT_ID = 'zigzag';
const EFFECT_ROUGHEN = 'roughen';
const EFFECT_ZIGZAG = 'zigzag';
const EFFECT_PUCKER_BLOAT = 'pucker_bloat';
const EFFECT_TWIST = 'twist';

const KNOWN_GROUP_PREFIXES = [
  'Zig Zag Effect', 'Roughen Effect', 'Pucker & Bloat', 'Twist Effect',
  'Effects [', 'Effect Container'
];
const SOURCE_PREFIX = 'Source';
const RESULT_PREFIX = 'Result';

const EffectRegistry = {
  [EFFECT_ROUGHEN]: {
    id: EFFECT_ROUGHEN,
    name: 'Roughen',
    defaultParams: {
      size: 5,
      isRelative: true,
      detail: 10,
      smooth: false,
      seed: 42
    },
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
    },
    formatSummary: function(params) {
      const p = EffectRegistry[EFFECT_ROUGHEN].sanitizeParams(params);
      return `Roughen (${p.size}${p.isRelative ? '%' : 'px'}, ${p.detail}/in, seed:${p.seed}${p.smooth ? ', smooth' : ''})`;
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
    },
    formatSummary: function(params) {
      const p = EffectRegistry[EFFECT_ZIGZAG].sanitizeParams(params);
      return `Zig Zag (${p.amp}px, ${p.ridges}r${p.smooth ? ', smooth' : ''})`;
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
    },
    formatSummary: function(params) {
      const p = EffectRegistry[EFFECT_PUCKER_BLOAT].sanitizeParams(params);
      return `Pucker & Bloat (${p.amount > 0 ? '+' : ''}${p.amount}%)`;
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
    },
    formatSummary: function(params) {
      const p = EffectRegistry[EFFECT_TWIST].sanitizeParams(params);
      return `Twist (${p.angle}°, ${p.subdiv}s)`;
    }
  }
};

const doc = Document.current;
const mkSel = n => Selection.create(doc, n, true);

function isSameNode(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  try {
    if (a.isSameNode && a.isSameNode(b)) return true;
  } catch (e) {}
  return false;
}

function isDescendantOf(node, parent) {
  let cur = node ? node.parent : null;
  while (cur) {
    if (isSameNode(cur, parent)) return true;
    try { cur = cur.parent; } catch (e) { break; }
  }
  return false;
}

// =============================================================================
// DOM & CONTAINER DETECTION HELPERS
// =============================================================================

function getNodeName(node) {
  try {
    return node.userDescription || node.name || '';
  } catch (e) {
    return '';
  }
}

function getChildren(node) {
  const children = [];
  if (!node) return children;
  try {
    let c = node.firstChild;
    while (c) {
      children.push(c);
      c = c.nextSibling;
    }
  } catch (e) {}
  return children;
}

function isEffectGroup(node) {
  if (!node || !node.isContainerNode) return false;
  try {
    if (node.tagInterface && node.tagInterface.hasKey('effectPipeline')) {
      return true;
    }
  } catch (e) {}

  const name = getNodeName(node);
  return KNOWN_GROUP_PREFIXES.some(prefix => name.startsWith(prefix));
}

function getEffectGroupOfNode(node) {
  if (!node) return null;
  if (isEffectGroup(node)) return node;
  let p = node.parent;
  while (p) {
    if (isEffectGroup(p)) return p;
    p = p.parent;
  }
  return null;
}

function isResultNode(node) {
  if (!node) return false;
  const name = getNodeName(node);
  if (name.startsWith(RESULT_PREFIX)) return true;
  try {
    if (node.tagInterface && node.tagInterface.tagColour) {
      const tc = node.tagInterface.tagColour;
      if (tc.r === 255 && tc.g === 0 && tc.b === 0) return true;
    }
  } catch (e) {}
  try {
    if (node.tagColour) {
      const tc = node.tagColour;
      const r = tc.r !== undefined ? tc.r : tc.red;
      const g = tc.g !== undefined ? tc.g : tc.green;
      const b = tc.b !== undefined ? tc.b : tc.blue;
      if (r === 255 && g === 0 && b === 0) return true;
      if (r >= 180 && g <= 100 && b <= 100 && (r - Math.max(g, b) >= 80)) return true;
    }
  } catch (e) {}
  return false;
}

function isSourceNode(node) {
  if (!node) return false;
  const name = getNodeName(node);
  return name.startsWith(SOURCE_PREFIX);
}

function isForeignNode(node, group) {
  if (!node || isSameNode(node, group)) return false;
  if (isResultNode(node)) return false;
  if (isSourceNode(node)) return false;
  return true;
}

function extractNodeFromContainer(node, group) {
  if (!node) return;
  try {
    const target = group || getEffectGroupOfNode(node);
    if (!target) return;
    const parent = node.parent;
    if (!parent) return;

    if (isSameNode(parent, target) || isDescendantOf(node, target)) {
      let cmd = null;
      if (typeof DocumentCommand.createMoveNodes === 'function') {
        cmd = DocumentCommand.createMoveNodes(
          Selection.create(doc, node, true),
          target,
          NodeMoveType.After,
          NodeChildType.Main
        );
      } else if (typeof DocumentCommand.createMove === 'function') {
        cmd = DocumentCommand.createMove(
          Selection.create(doc, node, true),
          target,
          NodeMoveType.After,
          NodeChildType.Main
        );
      }
      if (cmd) doc.executeCommand(cmd, false);
    }
  } catch (e) {}
}

function isVectorCandidate(node) {
  if (!node) return false;
  if (node.isContainerNode) return false;
  if (node.curvesInterface && node.curvesInterface.polyCurve) return true;
  if (node.shapeInterface) return true;
  return false;
}

function isSymbolNode(node) {
  if (!node) return false;
  try {
    if (node.type === "Symbol" || node.type === "symbolInstance") return true;
    const desc = getNodeName(node);
    if (desc && desc.toLowerCase().indexOf("symbol") !== -1) return true;
  } catch (e) {}
  return false;
}

function collectVectorNodes(nodes) {
  const result = [];
  for (const node of nodes) {
    if (isEffectGroup(node)) continue;
    if (node.isContainerNode) {
      const children = getChildren(node);
      const sub = collectVectorNodes(children);
      for (const s of sub) pushUnique(result, s);
    } else if (isVectorCandidate(node)) {
      pushUnique(result, node);
    }
  }
  return result;
}

function pushUnique(arr, item) {
  for (let i = 0; i < arr.length; i++) {
    if (isSameNode(arr[i], item)) return;
  }
  arr.push(item);
}

function getSelectionNodes() {
  const nodes = [];
  if (!doc || !doc.selection) return nodes;
  try {
    const sel = doc.selection;
    if (typeof sel.length === "number") {
      for (let i = 0; i < sel.length; i++) {
        const item = sel.at(i);
        if (item && item.node) {
          pushUnique(nodes, item.node);
        } else if (item && item.isNode) {
          pushUnique(nodes, item);
        }
      }
    }
  } catch (e) {}
  if (!nodes.length) {
    try {
      if (doc.selection.nodes) {
        for (const n of doc.selection.nodes) pushUnique(nodes, n);
      }
    } catch (e) {}
  }
  return nodes;
}

function findAllEffectGroups() {
  const groups = [];
  try {
    for (const node of doc.layers.all) {
      if (isEffectGroup(node)) groups.push(node);
    }
  } catch (e) {}
  return groups;
}

// =============================================================================
// TRANSFORM SERIALIZATION & CUMULATIVE STATE ENGINE (v3g)
// =============================================================================

function serializeTransform(xf) {
  if (!xf) return null;
  try {
    return xf.decompose();
  } catch (e) {
    return null;
  }
}

function deserializeTransform(data) {
  const t = Transform.createIdentity();
  if (!data) return t;
  try {
    t.compose(data);
  } catch (e) {}
  return t;
}

function readCumulativeTransform(group) {
  try {
    if (group.tagInterface && group.tagInterface.hasKey('effectCumulativeTransform')) {
      const raw = group.tagInterface.getValueForKey('effectCumulativeTransform');
      if (raw) {
        return deserializeTransform(JSON.parse(raw));
      }
    }
  } catch (e) {}
  return Transform.createIdentity();
}

function writeCumulativeTransform(document, group, xf) {
  try {
    const s = serializeTransform(xf);
    document.executeCommand(
      DocumentCommand.createSetTagValueForKey(
        mkSel(group),
        'effectCumulativeTransform',
        JSON.stringify(s)
      ),
      false
    );
  } catch (e) {}
}

function getContainerTransform(containerNode) {
  if (!containerNode) return Transform.createIdentity();
  try {
    const xf = containerNode.baseToSpreadTransform || (containerNode.transformInterface ? containerNode.transformInterface.transform : null);
    if (xf) return xf.clone();
  } catch (e) {}
  return Transform.createIdentity();
}

function clonePolyCurveToSpread(node) {
  if (!node || !node.curvesInterface || !node.curvesInterface.polyCurve) return null;
  try {
    const pc = node.curvesInterface.polyCurve.clone();
    const xf = node.baseToSpreadTransform || (node.transformInterface ? node.transformInterface.transform : null);
    if (xf) {
      try {
        pc.transform(xf);
      } catch (e) {}
    }
    return pc;
  } catch (e) {
    return null;
  }
}

// =============================================================================
// STYLE EXTRACTION HELPERS (ACCURATE SDK PROPERTIES)
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
      } else {
        hasStroke = false;
        lineFill = FillDescriptor.createNone();
        lineStyle = LineStyleDescriptor.createDefault(0);
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

function cloneStyle(style) {
  return {
    brushFill: style.brushFill ? style.brushFill.clone() : FillDescriptor.createNone(),
    lineStyle: style.lineStyle ? style.lineStyle.clone() : LineStyleDescriptor.createDefault(0),
    lineFill: style.lineFill ? style.lineFill.clone() : FillDescriptor.createNone(),
    transparencyFill: style.transparencyFill ? style.transparencyFill.clone() : FillDescriptor.createNone(),
    hasStroke: !!style.hasStroke,
    opacity: (typeof style.opacity === "number") ? style.opacity : 1.0,
    blendMode: style.blendMode || null
  };
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

function extractSourceEntriesFromNodes(nodes) {
  const entries = [];
  for (const node of nodes) {
    try {
      const pc = clonePolyCurveToSpread(node);
      if (pc) {
        entries.push({
          sourceNode: node,
          sourcePolyCurveLocal: pc,
          style: getNodeStyle(node)
        });
      }
    } catch (e) {}
  }
  return entries;
}

function extractSourceEntriesFromGroup(group) {
  const entries = [];
  if (!group) return entries;

  const children = getChildren(group);
  let sourceNodes = children.filter(isSourceNode);
  const resultNodes = children.filter(isResultNode);

  if (!sourceNodes.length) {
    sourceNodes = children.filter(c => !isResultNode(c) && !isForeignNode(c, group) && isVectorCandidate(c));
  }

  for (let i = 0; i < sourceNodes.length; i++) {
    const sNode = sourceNodes[i];
    const rNode = resultNodes[i] || resultNodes[0];

    try {
      if (sNode.curvesInterface && sNode.curvesInterface.polyCurve) {
        const pcLocal = sNode.curvesInterface.polyCurve.clone();

        let style = getNodeStyle(rNode || sNode);
        if (style.brushFill.isNoFill && !style.hasStroke) {
          const sStyle = getNodeStyle(sNode);
          if (!sStyle.brushFill.isNoFill || sStyle.hasStroke) {
            style = sStyle;
          } else {
            const gStyle = getNodeStyle(group);
            if (!gStyle.brushFill.isNoFill || gStyle.hasStroke) {
              style = gStyle;
            }
          }
        }

        entries.push({
          sourceNode: sNode,
          sourcePolyCurveLocal: pcLocal,
          style: style
        });
      }
    } catch (e) {}
  }

  return entries;
}

// =============================================================================
// PIPELINE EVALUATION & METADATA MANAGEMENT
// =============================================================================

function evaluatePipeline(sourcePolyCurve, pipeline) {
  if (!sourcePolyCurve) return PolyCurve.create();
  if (!pipeline || !pipeline.length) {
    return sourcePolyCurve.clone();
  }

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

function formatPipelineGroupName(pipeline) {
  if (!pipeline || !pipeline.length) return 'Zig Zag Effect';
  if (pipeline.length === 1) {
    const handler = EffectRegistry[pipeline[0].id];
    return handler ? (handler.name + ' Effect') : 'Zig Zag Effect';
  }
  const names = pipeline.map(s => {
    const h = EffectRegistry[s.id];
    return h ? h.name : s.id;
  });
  return 'Effects [' + names.join(' + ') + ']';
}

function formatStackDescription(pipeline, activeEffectId) {
  if (!pipeline || !pipeline.length) return 'No effects in stack';
  return pipeline.map((stage, idx) => {
    const h = EffectRegistry[stage.id];
    const name = h ? h.name : stage.id;
    if (stage.id === activeEffectId) {
      return `[${idx + 1}] ${name} (active)`;
    }
    return `[${idx + 1}] ${name}`;
  }).join('  ➔  ');
}

function readEffectPipeline(groupNode) {
  if (!groupNode) return [];
  try {
    if (groupNode.tagInterface && groupNode.tagInterface.hasKey('effectPipeline')) {
      const raw = groupNode.tagInterface.getValueForKey('effectPipeline');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed.map(stage => {
            const h = EffectRegistry[stage.id];
            return {
              id: stage.id,
              params: h ? h.sanitizeParams(stage.params) : stage.params
            };
          });
        }
      }
    }
  } catch (e) {}
  return [{ id: CURRENT_EFFECT_ID, params: EffectRegistry[CURRENT_EFFECT_ID].defaultParams }];
}

function setContainerMetadata(document, groupNode, pipeline) {
  if (!groupNode) return;
  try {
    const groupSel = mkSel(groupNode);
    document.executeCommand(
      DocumentCommand.createSetTagValueForKey(groupSel, 'effectPipeline', JSON.stringify(pipeline)),
      false
    );
    const title = formatPipelineGroupName(pipeline);
    document.executeCommand(DocumentCommand.createSetDescription(groupSel, title), false);
  } catch (e) {}
}

function tagNodeRed(node) {
  if (!node) return;
  try {
    doc.executeCommand(DocumentCommand.createSetTagColour(mkSel(node), RGB8(255, 0, 0)), false);
  } catch (e) {}
}

// =============================================================================
// GEOMETRIC SAMPLING & ZIG ZAG CORE
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
  return {
    tx: dx / l,
    ty: dy / l,
    nx: -dy / l,
    ny: dx / l
  };
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
  if (c <= 0) {
    return { p: evalBez(beziers[0], 0), g: tanNorm(beziers[0], 0) };
  }
  if (c >= totalLen) {
    const lastBi = beziers.length - 1;
    return { p: evalBez(beziers[lastBi], 1), g: tanNorm(beziers[lastBi], 1) };
  }

  let lo = 0;
  let hi = tbl.length - 1;

  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (tbl[mid].cum <= c) lo = mid;
    else hi = mid;
  }

  const a = tbl[lo];
  const b = tbl[hi];
  let bi = a.bi;
  let t = a.t;

  if (a.bi === b.bi) {
    const span = b.cum - a.cum;
    const f = span < 1e-9 ? 0 : (c - a.cum) / span;
    t = a.t + (b.t - a.t) * f;
  } else {
    if (Math.abs(c - a.cum) < Math.abs(c - b.cum)) {
      bi = a.bi;
      t = a.t;
    } else {
      bi = b.bi;
      t = b.t;
    }
  }

  t = Math.max(0, Math.min(1, t));
  return { p: evalBez(beziers[bi], t), g: tanNorm(beziers[bi], t) };
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
    const peaks = ridges * 2;
    const step = totalLen / peaks;
    const pts = [];

    if (closed) {
      for (let i = 0; i < peaks; i++) {
        const sampled = sampleAt(tbl, beziers, i * step);
        const sign = i % 2 === 0 ? 1 : -1;
        pts.push({
          x: sampled.p.x + sampled.g.nx * amp * sign,
          y: sampled.p.y + sampled.g.ny * amp * sign,
          tx: sampled.g.tx,
          ty: sampled.g.ty
        });
      }
    } else {
      for (let i = 0; i <= peaks; i++) {
        const sampled = sampleAt(tbl, beziers, Math.min(i * step, totalLen));
        const sign = (i === 0 || i === peaks) ? 0 : (i % 2 === 1 ? 1 : -1);
        pts.push({
          x: sampled.p.x + sampled.g.nx * amp * sign,
          y: sampled.p.y + sampled.g.ny * amp * sign,
          tx: sampled.g.tx,
          ty: sampled.g.ty
        });
      }
    }

    const builder = CurveBuilder.create();
    builder.beginXY(pts[0].x, pts[0].y);
    const count = closed ? pts.length : pts.length - 1;

    if (smooth) {
      for (let i = 0; i < count; i++) {
        const p0 = pts[i];
        const p1 = pts[(i + 1) % pts.length];
        const h = Math.hypot(p1.x - p0.x, p1.y - p0.y) / 3;
        builder.addBezierXY(
          p0.x + p0.tx * h,
          p0.y + p0.ty * h,
          p1.x - p1.tx * h,
          p1.y - p1.ty * h,
          p1.x,
          p1.y
        );
      }
    } else {
      for (let i = 1; i <= count; i++) {
        const pt = pts[i % pts.length];
        builder.lineToXY(pt.x, pt.y);
      }
    }

    if (closed) builder.close();
    out.addCurve(builder.createCurve());
  }

  return out;
}

// =============================================================================
// ROUGHEN / PUCKER & BLOAT / TWIST CORES (MULTI-EFFECT ENGINE)
// =============================================================================

function readPolyCurveBounds(polyCurve) {
  let bbox = null;
  try {
    bbox = polyCurve.exactBoundingBox || polyCurve.boundingBox;
  } catch (e) {}

  if (!bbox) return { x: 0, y: 0, width: 100, height: 100, cx: 50, cy: 50, maxDimension: 100 };
  const w = (bbox.width !== undefined) ? bbox.width : 100;
  const h = (bbox.height !== undefined) ? bbox.height : 100;
  const x = (bbox.x !== undefined) ? bbox.x : 0;
  const y = (bbox.y !== undefined) ? bbox.y : 0;
  return {
    x: x,
    y: y,
    width: w,
    height: h,
    cx: x + w / 2,
    cy: y + h / 2,
    maxDimension: Math.max(w, h, 1)
  };
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
    if (totalLen < 1e-9) {
      out.addCurve(curve.clone());
      continue;
    }

    const closed = curve.isClosed;
    const actualAmp = isRelative
      ? (Math.max(bounds.maxDimension, totalLen * 0.5) * (size / 100))
      : size;

    let segments = Math.max(2, Math.round(detail * (totalLen / INCH_PT)));
    if (closed && segments % 2 !== 0) {
      segments += 1;
    }

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

      pts.push({
        x: sampled.p.x + sampled.g.nx * disp,
        y: sampled.p.y + sampled.g.ny * disp,
        tx: sampled.g.tx,
        ty: sampled.g.ty
      });
    }

    globalPointIdx += count + 10;

    if (!pts.length) {
      out.addCurve(curve.clone());
      continue;
    }

    const builder = CurveBuilder.create();
    builder.beginXY(pts[0].x, pts[0].y);

    const loopCount = closed ? pts.length : pts.length - 1;

    if (smooth) {
      for (let i = 0; i < loopCount; i++) {
        const p0 = pts[i];
        const p1 = pts[(i + 1) % pts.length];
        const h = Math.hypot(p1.x - p0.x, p1.y - p0.y) / 3;

        builder.addBezierXY(
          p0.x + p0.tx * h,
          p0.y + p0.ty * h,
          p1.x - p1.tx * h,
          p1.y - p1.ty * h,
          p1.x,
          p1.y
        );
      }
    } else {
      for (let i = 1; i <= loopCount; i++) {
        const pt = pts[i % pts.length];
        builder.lineToXY(pt.x, pt.y);
      }
    }

    if (closed) builder.close();
    out.addCurve(builder.createCurve());
  }

  return out;
}

function warpPoint(pt, cx, cy, scale) {
  return {
    x: cx + (pt.x - cx) * scale,
    y: cy + (pt.y - cy) * scale
  };
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
    if (!beziers.length) {
      out.addCurve(curve.clone());
      continue;
    }

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
  const dx = point.x - cx;
  const dy = point.y - cy;
  const r = Math.hypot(dx, dy);
  if (r < 1e-9) return point;

  const angle = Math.atan2(dy, dx) + angleRad * (r / maxR);
  return {
    x: cx + r * Math.cos(angle),
    y: cy + r * Math.sin(angle)
  };
}

function buildTwistPolyCurve(sourcePolyCurve, angleDeg, subdiv) {
  const bounds = readPolyCurveBounds(sourcePolyCurve);
  const cx = bounds.cx;
  const cy = bounds.cy;
  const maxR = Math.hypot(bounds.width / 2, bounds.height / 2) || 1;
  const angleRad = angleDeg * Math.PI / 180;
  const out = PolyCurve.create();

  for (const curve of sourcePolyCurve) {
    const beziers = [...curve.beziers];
    if (!beziers.length) {
      out.addCurve(curve.clone());
      continue;
    }

    const points = [];
    for (const bez of beziers) {
      for (let step = 0; step < subdiv; step++) {
        points.push(evalBez(bez, step / subdiv));
      }
    }

    if (!curve.isClosed) {
      const last = beziers[beziers.length - 1];
      points.push({ x: last.end.x, y: last.end.y });
    }

    if (!points.length) {
      out.addCurve(curve.clone());
      continue;
    }

    const twisted = points.map(point => twistPoint(point, cx, cy, angleRad, maxR));
    const builder = CurveBuilder.create();
    builder.beginXY(twisted[0].x, twisted[0].y);

    for (let i = 1; i < twisted.length; i++) {
      builder.lineToXY(twisted[i].x, twisted[i].y);
    }

    if (curve.isClosed) builder.close();
    out.addCurve(builder.createCurve());
  }

  return out;
}

// =============================================================================
// DEFINITION FACTORIES & CONTAINER INSERTION HELPERS
// =============================================================================

function createPolyCurveDefinition(polyCurve, style, name) {
  const s = cloneStyle(style);
  const def = PolyCurveNodeDefinition.create(
    polyCurve.clone(),
    s.brushFill,
    s.hasStroke ? s.lineStyle : LineStyleDescriptor.createDefault(0),
    s.hasStroke ? s.lineFill : FillDescriptor.createNone(),
    s.transparencyFill
  );
  if (name) def.userDescription = name;
  return def;
}

function makeSourceDefinitions(entries) {
  const defs = [];
  for (let i = 0; i < entries.length; i++) {
    const pc = entries[i].sourcePolyCurveLocal.clone();
    defs.push(createPolyCurveDefinition(
      pc,
      entries[i].style,
      `${SOURCE_PREFIX} ${i + 1}`
    ));
  }
  return defs;
}

function makeResultDefinitions(entries, pipeline, cumulativeTransform) {
  const defs = [];
  for (let i = 0; i < entries.length; i++) {
    const localCurve = entries[i].sourcePolyCurveLocal;
    const resPolyCurve = evaluatePipeline(localCurve, pipeline);
    if (cumulativeTransform) {
      try { resPolyCurve.transform(cumulativeTransform); } catch (e) {}
    }
    defs.push(createPolyCurveDefinition(
      resPolyCurve,
      entries[i].style,
      `${RESULT_PREFIX} ${i + 1}`
    ));
  }
  return defs;
}

function addDefinitionsInsideGroup(targetGroup, definitions) {
  if (!targetGroup || !definitions || !definitions.length) return [];

  const builder = AddChildNodesCommandBuilder.create();
  builder.setInsertionTarget(targetGroup);
  builder.setInsertionMode(InsertionMode.Inside);
  for (const def of definitions) {
    builder.addPolyCurveNode(def);
  }
  const cmd = builder.createCommand(false, NodeChildType.Main);
  doc.executeCommand(cmd);

  return Array.from(cmd.newNodes || []);
}

function clearPreviews(document) {
  try {
    document.executeCommand(DocumentCommand.createClearPreviews());
  } catch (e) {}
}

function doPreviewPipeline(document, previewGroupList, pipeline) {
  clearPreviews(document);
  if (!previewGroupList || !previewGroupList.length) return;

  const addBuilder = AddChildNodesCommandBuilder.create();
  if (previewGroupList[0].targetNode) {
    addBuilder.setInsertionTargetSelection(mkSel(previewGroupList[0].targetNode));
    addBuilder.setInsertionMode(InsertionMode.Top);
  }

  for (const groupEntry of previewGroupList) {
    const { entries, cumulativeTransform } = groupEntry;
    if (!entries || !entries.length) continue;

    for (const entry of entries) {
      const localCurve = entry.sourcePolyCurveLocal;
      if (!localCurve) continue;

      const resPolyCurve = evaluatePipeline(localCurve, pipeline);
      if (cumulativeTransform) {
        try {
          resPolyCurve.transform(cumulativeTransform);
        } catch (e) {}
      }

      const s = entry.style;
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
        resPolyCurve,
        previewBrushFill,
        previewLineStyle,
        previewLineFill,
        s.transparencyFill || FillDescriptor.createNone()
      );

      addBuilder.addNode(def);
    }
  }

  const cmd = addBuilder.createCommand(false, NodeChildType.Main);
  if (cmd) {
    document.executeCommand(cmd, true);
  }
}

// =============================================================================
// DIALOG & USER INTERACTION (ZIG ZAG EFFECT UI)
// =============================================================================

function showDialog(title, initialParams, stackInfo, onPreview) {
  let inPreview = false;
  let previewTimer = null;

  const dlg = Dialog.create(title);
  dlg.initialWidth = 360;

  const col = dlg.addColumn();
  const grp = col.addGroup('Zig Zag Options');

  const ampEd = grp.addUnitValueEditor('Amplitude', UnitType.Point, UnitType.Point, initialParams.amp, 0, 10000);
  ampEd.precision = 1;
  ampEd.showPopupSlider = true;

  const ridgesEd = grp.addUnitValueEditor('Ridges', UnitType.Number, UnitType.Number, initialParams.ridges, 1, 10000);
  ridgesEd.precision = 0;
  ridgesEd.showPopupSlider = true;

  const smoothSw = grp.addSwitch('Smooth wave', initialParams.smooth);

  let activeSw = null;
  if (stackInfo.isEditingExisting) {
    activeSw = grp.addSwitch('Active in effect stack', true);
  }

  const noteGrp = col.addGroup('');
  const txt1 = noteGrp.addStaticText(null, stackInfo.headerText).setIsFullWidth(true);
  txt1.textHorizontalAlignment = HorizontalAlignment.Centre;

  if (stackInfo.stackSummary) {
    const txt2 = noteGrp.addStaticText(null, stackInfo.stackSummary).setIsFullWidth(true);
    txt2.textHorizontalAlignment = HorizontalAlignment.Centre;
  }

  function readValues() {
    return {
      enabled: activeSw ? !!activeSw.value : true,
      params: {
        amp: Math.max(0, Math.round(ampEd.value * 10) / 10),
        ridges: Math.max(1, Math.round(ridgesEd.value)),
        smooth: !!smoothSw.value
      }
    };
  }

  function triggerPreview() {
    if (previewTimer) previewTimer.cancel();
    previewTimer = setTimeout(60, (err) => {
      if (err || inPreview) return;
      inPreview = true;
      try {
        const current = readValues();
        onPreview(current);
      } catch (e) {
        console.log(SCRIPT_TITLE + ' preview error: ' + e);
        clearPreviews(doc);
      } finally {
        inPreview = false;
      }
    });
  }

  ampEd.onValueChangedHandler = triggerPreview;
  ridgesEd.onValueChangedHandler = triggerPreview;
  smoothSw.onValueChangedHandler = triggerPreview;
  if (activeSw) activeSw.onValueChangedHandler = triggerPreview;
  dlg.onControlValueChangedHandler = triggerPreview;

  triggerPreview();

  const result = dlg.show();
  if (previewTimer) previewTimer.cancel();
  clearPreviews(doc);

  return {
    ok: result.value === DialogResult.Ok.value,
    result: readValues()
  };
}

// =============================================================================
// MAIN ENTRY POINTS & EXECUTION WORKFLOWS
// =============================================================================

function mainCreate(sourceNodes) {
  const entries = extractSourceEntriesFromNodes(sourceNodes);
  if (!entries.length) {
    alert('No usable vector curves were found in the selection.');
    return;
  }

  const initialParams = EffectRegistry[CURRENT_EFFECT_ID].defaultParams;
  const stackInfo = {
    isEditingExisting: false,
    headerText: '✨ Non-destructive Procedural Effect ✨',
    stackSummary: 'Run this script again on the container to edit parameters, or run other effect scripts to stack effects.'
  };

  // Hide primary source shapes during preview
  const hidePrimariesCb = CompoundCommandBuilder.create();
  for (const n of sourceNodes) {
    hidePrimariesCb.addCommand(DocumentCommand.createSetVisibility(mkSel(n), false));
  }
  doc.executeCommand(hidePrimariesCb.createCommand());

  const previewGroupList = [{
    entries: entries,
    targetNode: sourceNodes[0],
    cumulativeTransform: Transform.createIdentity()
  }];

  const dialogResult = showDialog(SCRIPT_TITLE, initialParams, stackInfo, function(current) {
    const pipeline = current.enabled ? [{ id: CURRENT_EFFECT_ID, params: current.params }] : [];
    doPreviewPipeline(doc, previewGroupList, pipeline);
  });

  clearPreviews(doc);

  if (dialogResult.ok) {
    const pipeline = dialogResult.result.enabled ? [{ id: CURRENT_EFFECT_ID, params: dialogResult.result.params }] : [];

    // 1. Create Container Group at position of first source node
    const groupName = formatPipelineGroupName(pipeline);
    const gBuilder = AddChildNodesCommandBuilder.create();
    gBuilder.setInsertionTargetSelection(mkSel(sourceNodes[0]));
    gBuilder.setInsertionMode(InsertionMode.Top);
    gBuilder.addContainerNode(ContainerNodeDefinition.create(groupName));
    const gCmd = gBuilder.createCommand(false, NodeChildType.Main);
    doc.executeCommand(gCmd);
    const targetGroup = gCmd.newNodes[0];

    // 2. Add pristine Sources inside Container Group (Hidden)
    const sourceDefs = makeSourceDefinitions(entries);
    const createdSources = addDefinitionsInsideGroup(targetGroup, sourceDefs);
    if (createdSources.length) {
      const sSel = Selection.create(doc, createdSources, true);
      doc.executeCommand(DocumentCommand.createSetVisibility(sSel, false), false);
    }

    // 3. Add Results inside Container Group (Visible, Red Tag #FF0000)
    const resultDefs = makeResultDefinitions(entries, pipeline, Transform.createIdentity());
    const createdResults = addDefinitionsInsideGroup(targetGroup, resultDefs);
    if (createdResults.length) {
      for (let i = 0; i < createdResults.length; i++) {
        const resNode = createdResults[i];
        tagNodeRed(resNode);
        doc.executeCommand(DocumentCommand.createSetVisibility(mkSel(resNode), true), false);
        const srcStyle = entries[i] ? entries[i].style : null;
        if (srcStyle) {
          if (typeof srcStyle.opacity === "number" && srcStyle.opacity < 0.999) {
            try { doc.executeCommand(DocumentCommand.createSetOpacity(mkSel(resNode), srcStyle.opacity), false); } catch (e) {}
          }
          if (srcStyle.blendMode) {
            try { doc.executeCommand(DocumentCommand.createSetBlendMode(mkSel(resNode), srcStyle.blendMode), false); } catch (e) {}
          }
        }
      }
    }

    // 4. Serialize Tag Metadata & Cumulative Transform
    setContainerMetadata(doc, targetGroup, pipeline);
    writeCumulativeTransform(doc, targetGroup, Transform.createIdentity());

    // 5. Delete original shapes & Select Container
    const delCb = CompoundCommandBuilder.create();
    delCb.addCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, sourceNodes, true)));
    doc.executeCommand(delCb.createCommand());

    doc.selection = Selection.create(doc, targetGroup, true);

  } else {
    // If Cancelled, restore visibility
    const restoreCb = CompoundCommandBuilder.create();
    for (const n of sourceNodes) {
      restoreCb.addCommand(DocumentCommand.createSetVisibility(mkSel(n), true));
    }
    doc.executeCommand(restoreCb.createCommand());
  }
}

function mainUpdateMany(groups) {
  const existingPipeline = readEffectPipeline(groups[0]);
  const existingIdx = existingPipeline.findIndex(s => s.id === CURRENT_EFFECT_ID);
  const isEditingExisting = existingIdx >= 0;

  let initialParams = isEditingExisting
    ? { ...existingPipeline[existingIdx].params }
    : { ...EffectRegistry[CURRENT_EFFECT_ID].defaultParams };

  const updates = [];
  const oldResultsToHide = [];

  for (const group of groups) {
    const containerTransform = getContainerTransform(group);
    const oldCumulativeTransform = readCumulativeTransform(group);
    const newCumulativeTransform = Transform.multiply(containerTransform, oldCumulativeTransform);

    const entries = extractSourceEntriesFromGroup(group);
    if (!entries.length) {
      alert('One selected effect group has no source curves to update.');
      return;
    }

    const scaleX = Math.hypot(containerTransform.xAxis.x, containerTransform.xAxis.y);
    const scaleY = Math.hypot(containerTransform.yAxis.x, containerTransform.yAxis.y);
    const isTransformed = Math.abs(scaleX - 1) > 1e-4 || Math.abs(scaleY - 1) > 1e-4 ||
                          Math.abs(containerTransform.origin.x) > 1e-4 || Math.abs(containerTransform.origin.y) > 1e-4;

    const children = getChildren(group);
    const resultNodes = children.filter(isResultNode);
    const sourceNodes = children.filter(isSourceNode);

    for (const r of resultNodes) oldResultsToHide.push(r);

    updates.push({
      group,
      entries,
      resultNodes,
      sourceNodes,
      containerTransform,
      isTransformed,
      newCumulativeTransform,
      targetNode: group
    });
  }

  let stackSummaryText = '';
  if (isEditingExisting) {
    stackSummaryText = formatStackDescription(existingPipeline, CURRENT_EFFECT_ID);
  } else if (existingPipeline.length > 0) {
    stackSummaryText = formatStackDescription([...existingPipeline, { id: CURRENT_EFFECT_ID }], CURRENT_EFFECT_ID);
  }

  const stackInfo = {
    isEditingExisting: isEditingExisting,
    headerText: isEditingExisting ? '✨ Editing Zig Zag in Stack ✨' : '➕ Adding Zig Zag to Stack ➕',
    stackSummary: stackSummaryText + '\n(Run this script again on the container to modify settings)'
  };

  // Hide old results during live preview
  if (oldResultsToHide.length > 0) {
    const hideOldCb = CompoundCommandBuilder.create();
    for (const res of oldResultsToHide) {
      hideOldCb.addCommand(DocumentCommand.createSetVisibility(mkSel(res), false));
    }
    doc.executeCommand(hideOldCb.createCommand());
  }

  function computePipeline(current) {
    let pipeline = [...existingPipeline];
    if (isEditingExisting) {
      if (current.enabled) {
        pipeline[existingIdx] = { id: CURRENT_EFFECT_ID, params: current.params };
      } else {
        pipeline.splice(existingIdx, 1);
      }
    } else {
      if (current.enabled) {
        pipeline.push({ id: CURRENT_EFFECT_ID, params: current.params });
      }
    }
    return pipeline;
  }

  const previewGroupList = updates.map(u => ({
    entries: u.entries,
    targetNode: u.group,
    cumulativeTransform: u.newCumulativeTransform
  }));

  const dialogResult = showDialog(
    isEditingExisting ? 'Zig Zag (Edit Stack)' : 'Zig Zag (Add to Stack)',
    initialParams,
    stackInfo,
    function(current) {
      const pipeline = computePipeline(current);
      doPreviewPipeline(doc, previewGroupList, pipeline);
    }
  );

  clearPreviews(doc);

  if (dialogResult.ok) {
    const finalPipeline = computePipeline(dialogResult.result);

    for (const update of updates) {
      const { group, entries, resultNodes, sourceNodes, containerTransform, isTransformed, newCumulativeTransform } = update;

      // 1. Reset group transform to Identity if it was transformed/stretched
      if (isTransformed && containerTransform && containerTransform.inverted) {
        try {
          doc.executeCommand(DocumentCommand.createTransform(mkSel(group), containerTransform.inverted), false);
        } catch (e) {}
      }

      // 2. Delete old results and old sources
      const toDelete = [...resultNodes, ...sourceNodes];
      if (toDelete.length > 0) {
        const delSel = Selection.create(doc, toDelete, true);
        doc.executeCommand(DocumentCommand.createDeleteSelection(delSel));
      }

      // 3. Add pristine Sources inside Container Group (Hidden)
      const sourceDefs = makeSourceDefinitions(entries);
      const createdSources = addDefinitionsInsideGroup(group, sourceDefs);
      if (createdSources.length) {
        const sSel = Selection.create(doc, createdSources, true);
        doc.executeCommand(DocumentCommand.createSetVisibility(sSel, false), false);
      }

      // 4. Generate results with cumulative transform applied and insert directly inside container group
      const resultDefs = makeResultDefinitions(entries, finalPipeline, newCumulativeTransform);
      const createdResults = addDefinitionsInsideGroup(group, resultDefs);

      for (let i = 0; i < createdResults.length; i++) {
        const resNode = createdResults[i];
        tagNodeRed(resNode);
        doc.executeCommand(DocumentCommand.createSetVisibility(mkSel(resNode), true), false);
        doc.executeCommand(DocumentCommand.createSetDescription(mkSel(resNode), `${RESULT_PREFIX} ${i + 1}`), false);
        const srcStyle = entries[i] ? entries[i].style : null;
        if (srcStyle) {
          if (typeof srcStyle.opacity === "number" && srcStyle.opacity < 0.999) {
            try { doc.executeCommand(DocumentCommand.createSetOpacity(mkSel(resNode), srcStyle.opacity), false); } catch (e) {}
          }
          if (srcStyle.blendMode) {
            try { doc.executeCommand(DocumentCommand.createSetBlendMode(mkSel(resNode), srcStyle.blendMode), false); } catch (e) {}
          }
        }
      }

      // 5. Update container metadata, title & cumulative transform
      setContainerMetadata(doc, group, finalPipeline);
      writeCumulativeTransform(doc, group, newCumulativeTransform);
    }

    doc.selection = Selection.create(doc, groups, true);

  } else {
    // If Cancelled, restore visibility of old results
    if (oldResultsToHide.length > 0) {
      const restoreCb = CompoundCommandBuilder.create();
      for (const res of oldResultsToHide) {
        restoreCb.addCommand(DocumentCommand.createSetVisibility(mkSel(res), true));
      }
      doc.executeCommand(restoreCb.createCommand());
    }
  }
}

// =============================================================================
// MAIN ENTRY POINT
// =============================================================================

function main() {
  if (!doc) {
    alert('Please open a document in Affinity first.');
    return;
  }

  const selected = getSelectionNodes();

  // Check for symbol nodes
  if (selected.some(isSymbolNode)) {
    const warnDlg = Dialog.create("Symbols Not Supported");
    const warnCol = warnDlg.addColumn();
    warnCol.addStaticText(
      null,
      "Symbols are not supported in " + SCRIPT_TITLE + "."
    ).setIsFullWidth(true);
    warnCol.addStaticText(
      null,
      "Please detach or expand symbols into standard shapes, curves, or groups before applying procedural effects."
    ).setIsFullWidth(true);
    warnDlg.show();
    return;
  }

  // 1. Group selected items by container
  const standaloneNodes = [];
  const selectedGroups = [];
  const groupItemsMap = [];

  for (const n of selected) {
    const grp = getEffectGroupOfNode(n);
    if (grp) {
      let gIdx = -1;
      for (let i = 0; i < selectedGroups.length; i++) {
        if (isSameNode(selectedGroups[i], grp)) {
          gIdx = i;
          break;
        }
      }
      if (gIdx === -1) {
        selectedGroups.push(grp);
        groupItemsMap.push([n]);
      } else {
        pushUnique(groupItemsMap[gIdx], n);
      }
    } else {
      pushUnique(standaloneNodes, n);
    }
  }

  // 2. Check for Foreign Objects inside or among selected groups
  const foreignNodesToExtract = [];

  for (let i = 0; i < selectedGroups.length; i++) {
    const grp = selectedGroups[i];
    const items = groupItemsMap[i];

    // Check if specifically selected items in grp are foreign nodes
    for (const item of items) {
      if (isForeignNode(item, grp)) {
        pushUnique(foreignNodesToExtract, item);
      }
    }

    // If the group itself is selected, inspect all its children for foreigners
    if (items.some(it => isSameNode(it, grp))) {
      const allChildren = getChildren(grp);
      for (const child of allChildren) {
        if (isForeignNode(child, grp)) {
          pushUnique(foreignNodesToExtract, child);
        }
      }
    }
  }

  // 3. If Foreign Objects are detected -> Extract them and apply script effect!
  if (foreignNodesToExtract.length > 0) {
    const extractedVectorNodes = [];
    for (const fNode of foreignNodesToExtract) {
      extractNodeFromContainer(fNode);
      const vNodes = collectVectorNodes([fNode]);
      for (const vn of vNodes) pushUnique(extractedVectorNodes, vn);
    }

    if (extractedVectorNodes.length > 0) {
      mainCreate(extractedVectorNodes);
      return;
    }
  }

  // 4. Standard routing: Existing effect containers vs Standalone shapes
  if (selectedGroups.length > 0 && standaloneNodes.length === 0) {
    mainUpdateMany(selectedGroups);
  } else {
    const sourceNodes = collectVectorNodes(standaloneNodes);

    if (sourceNodes.length) {
      mainCreate(sourceNodes);
    } else if (selectedGroups.length > 0) {
      mainUpdateMany(selectedGroups);
    } else {
      const groups = findAllEffectGroups();
      if (groups.length === 1) {
        mainUpdateMany(groups);
      } else if (groups.length > 1) {
        alert('Select the effect group or groups you want to update.');
      } else {
        alert('Please select at least one vector curve or shape.');
      }
    }
  }
}

module.exports.main = main;
module.exports.SCRIPT_TITLE = SCRIPT_TITLE;
module.exports.EffectRegistry = EffectRegistry;
module.exports.evaluatePipeline = evaluatePipeline;
module.exports.buildZigZagPolyCurve = buildZigZagPolyCurve;
module.exports.clonePolyCurveToSpread = clonePolyCurveToSpread;
module.exports.extractSourceEntriesFromGroup = extractSourceEntriesFromGroup;

main();
