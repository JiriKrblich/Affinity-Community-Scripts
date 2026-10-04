/**
 * name: Replace Objects with Object v3ec
 * description: Replaces target objects with a selected Key Object template. Universal support for Vector (Shapes & Curves), Raster (Pixel & Image layers), Groups, and Child/Parent hierarchies. Zero-shear composite transform matrix preserves exact rotation and intrinsic dimensions.
 * version: 3.2.2
 * author: WaveF (Enhanced with Universal Vector, Group, Hierarchy & Zero-Shear Raster Support)
 * website: https://minicg.com
*/
'use strict';

// =============================================================================
// REPLACE OBJECTS WITH OBJECT v3ec (Universal Vector, Group, Hierarchy & Raster)
// Affinity Designer / Photo / Publisher (v3g Standard & Multi-Layer Pipeline)
//
// Key Features in v3ec:
// 1. Universal Vector & Group Compatibility:
//    - Full support for vector Curves, parametric Shapes (Rectangle, Ellipse, etc.),
//      Groups (as Key or Target), Text, and Symbols.
// 2. Child / Parent Hierarchy Preservation:
//    - Replaces child elements inside Groups, Artboards, Layers, or Enclosures.
//    - Automatically positions duplicates in the exact target parent hierarchy
//      and maintains proper stacking order.
// 3. Zero-Shear Composite Transform Matrix:
//    - Transforms duplicates from key center to target center:
//      M = T(tCx, tCy) * R(tRot) * S(sx, sy) * R(-kRot) * T(-kCx, -kCy)
//    - Completely prevents shear/skew on rotated vectors and rasters.
// 4. Safe Style Adoption (Pre-Cloned Descriptors):
//    - Fill, stroke, and line weight descriptors are cloned BEFORE target deletion,
//      preventing dead-handle crashes when adopting styles.
// 5. Universal Live Preview:
//    - PolyCurve previews for vectors with real-time adopted colors.
//    - Transient native duplicates for rasters, groups, and symbols.
// =============================================================================

const { app } = require('/application');
const { Document } = require('/document');
const {
  DocumentCommand,
  AddChildNodesCommandBuilder,
  CompoundCommandBuilder,
  NodeChildType,
  NodeMoveType
} = require('/commands');
const { PolyCurveNodeDefinition } = require('/nodes');
const { Dialog, DialogResult } = require('/dialog');
const { Transform } = require('/geometry');
const { FillDescriptor } = require('/fills');
const { LineStyleDescriptor } = require('/linestyle');
const { Selection } = require('/selections');

const APP_NAME = 'Replace Objects with Object v3ec';
const EPS = 1e-9;

// =============================================================================
// DOCUMENT & SELECTION HELPERS
// =============================================================================

function getCurrentDocument() {
  try {
    if (app && app.documents) {
      if (app.documents.current) return app.documents.current;
      if (app.documents.all) {
        for (const d of app.documents.all) return d;
      }
    }
  } catch (e) {}

  try {
    return Document.current || null;
  } catch (e) {
    return null;
  }
}

function nodeTag(node) {
  try {
    return node && node[Symbol.toStringTag] ? String(node[Symbol.toStringTag]) : '';
  } catch (e) {
    return '';
  }
}

function isSymbolNode(node) {
  if (!node) return false;
  const tag = nodeTag(node).toLowerCase();
  if (tag.includes('symbol')) return true;
  try {
    if (node.isSymbol || (node.type && String(node.type).toLowerCase().includes('symbol'))) return true;
  } catch (e) {}
  try {
    if (node.symbolInterface || node.isSymbolInstance) return true;
  } catch (e) {}
  try {
    const desc = (node.userDescription || node.defaultDescription || '').toLowerCase();
    if (desc.startsWith('symbol') || desc.includes('(symbol)')) return true;
  } catch (e) {}
  return false;
}

function isRasterNode(node) {
  if (!node) return false;
  try {
    if (node.isRasterNode || node.isImageNode) return true;
  } catch (e) {}
  const tag = nodeTag(node).toLowerCase();
  return tag.includes('raster') || tag.includes('image');
}

function isGroupNode(node) {
  if (!node) return false;
  try {
    if (node.isGroupNode || node.isContainerNode) return true;
  } catch (e) {}
  const tag = nodeTag(node).toLowerCase();
  return tag.includes('group') || tag.includes('container') ||
    (node.type && (String(node.type).toLowerCase().includes('group') || String(node.type).toLowerCase().includes('container')));
}

function isSameNode(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  try {
    if (a.isSameNode && a.isSameNode(b)) return true;
  } catch (e) {}
  return false;
}

function addUnique(nodes, node) {
  if (!node) return;
  if (!nodes.some(n => isSameNode(n, node))) nodes.push(node);
}

function getSelectionNodes(doc) {
  const nodes = [];
  const sel = doc && doc.selection;
  if (!sel) return nodes;

  try {
    if (sel.nodes) {
      for (const n of sel.nodes) addUnique(nodes, n);
      return nodes;
    }
  } catch (e) {}

  try {
    const len = sel.length || 0;
    for (let i = 0; i < len; i++) {
      const item = sel.at(i);
      addUnique(nodes, item && item.node ? item.node : item);
    }
  } catch (e) {}

  return nodes;
}

function getTopLevelNodes(nodes) {
  return nodes.filter(n => {
    let p = n.parent;
    while (p) {
      if (nodes.some(s => isSameNode(s, p))) return false;
      p = p.parent;
    }
    return true;
  });
}

function makeSelection(doc, nodes) {
  const usable = [];
  for (const node of nodes) {
    try {
      if (node && node.document) usable.push(node);
    } catch (e) {}
  }
  return usable.length ? Selection.create(doc, usable, true) : null;
}

/**
 * Universal node duplication:
 * - Raster nodes: DocumentCommand.createTransform with cloneRaster: true
 * - Vector, Group, Container, Shape, Curve, Symbol: node.duplicate()
 */
function duplicateNode(doc, node) {
  if (isRasterNode(node)) {
    try {
      const sel = Selection.create(doc, node);
      const cmd = DocumentCommand.createTransform(sel, Transform.createIdentity(), {
        duplicateNodes: true,
        cloneRaster: true
      });
      doc.executeCommand(cmd);
      if (cmd.newNodes && cmd.newNodes.length > 0) {
        return cmd.newNodes[0];
      }
      return doc.selection.firstNode;
    } catch (e) {}
  }

  // Vector / Group / Container / Symbol: native synchronous duplication
  try {
    const dup = node.duplicate();
    if (dup) return dup;
  } catch (e) {}

  try {
    const sel = Selection.create(doc, node);
    const cmd = DocumentCommand.createTransform(sel, Transform.createIdentity(), {
      duplicateNodes: true
    });
    doc.executeCommand(cmd);
    if (cmd.newNodes && cmd.newNodes.length > 0) {
      return cmd.newNodes[0];
    }
    return doc.selection.firstNode;
  } catch (e2) {
    return null;
  }
}

function getTargetChildType(target) {
  try {
    if (target && target.parent && target.parent.enclosures) {
      const isEnc = Array.from(target.parent.enclosures).some(e => isSameNode(e, target));
      if (isEnc) return NodeChildType.Enclosure;
    }
  } catch (e) {}
  return NodeChildType.Main;
}

// =============================================================================
// GEOMETRY & ZERO-SHEAR ENGINE
// =============================================================================

function isFiniteBox(box) {
  return !!box &&
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height);
}

function getSpreadBox(node) {
  try {
    const exact = node.exactSpreadBaseBox;
    if (isFiniteBox(exact)) return exact;
  } catch (e) {}

  try {
    const box = node.getSpreadBaseBox(false);
    if (isFiniteBox(box)) return box;
  } catch (e) {}

  try {
    const box = node.spreadBaseBox;
    if (isFiniteBox(box)) return box;
  } catch (e) {}

  try {
    const box = node.baseBox;
    if (isFiniteBox(box)) return box;
  } catch (e) {}

  throw new Error('Cannot read object bounds.');
}

function getWorldTransform(node) {
  try {
    const localToSpread = node.localToSpreadTransform;
    const own = node.transformInterface && node.transformInterface.transform;
    if (localToSpread && own && typeof localToSpread.multiply === 'function') {
      return localToSpread.multiply(own);
    }
  } catch (e) {}

  try {
    if (node.baseToSpreadTransform) return node.baseToSpreadTransform;
  } catch (e) {}

  try {
    return node.transformInterface && node.transformInterface.transform;
  } catch (e) {
    return null;
  }
}

function decomposeWorld(node) {
  try {
    const t = getWorldTransform(node);
    if (t && typeof t.decompose === 'function') return t.decompose();
  } catch (e) {}
  return { rotation: 0, scaleX: 1, scaleY: 1, shear: 0 };
}

function getVisualRotation(node) {
  if (!node) return 0;
  const d = decomposeWorld(node);
  return d.rotation || 0;
}

function getIntrinsicSize(node) {
  if (!node) return { w: 100, h: 100 };
  const d = decomposeWorld(node);

  // For individual shapes/curves/rasters with a valid baseBox:
  if (!isGroupNode(node)) {
    let bb = null;
    try {
      if (node.baseBox && isFiniteBox(node.baseBox)) {
        bb = node.baseBox;
      }
    } catch (e) {}

    if (bb && (Math.abs(d.scaleX || 1) > EPS || Math.abs(d.scaleY || 1) > EPS)) {
      const sx = Math.abs(d.scaleX || 1);
      const sy = Math.abs(d.scaleY || 1);
      return {
        w: Math.max(EPS, sx * Math.abs(bb.width)),
        h: Math.max(EPS, sy * Math.abs(bb.height))
      };
    }
  }

  // For Groups or objects without baseBox:
  const spBox = getSpreadBox(node);
  return {
    w: Math.max(EPS, spBox.width),
    h: Math.max(EPS, spBox.height)
  };
}

/**
 * Unified Zero-Shear Composite Transform Matrix:
 * M = T(tCx, tCy) * R(tRot) * S(sx, sy) * R(-kRot) * T(-kCx, -kCy)
 * Transforms duplicate from key center (kCx, kCy) to target center (tCx, tCy)
 * with intrinsic un-rotation, pure axial scaling (zero shear), and target rotation.
 */
function createCompositeTransform(kCx, kCy, kRot, tCx, tCy, tRot, sx, sy) {
  return Transform.createTranslate(tCx, tCy)
    .multiply(Transform.createRotate(tRot))
    .multiply(Transform.createScale(sx, sy))
    .multiply(Transform.createRotate(-kRot))
    .multiply(Transform.createTranslate(-kCx, -kCy));
}

// =============================================================================
// STYLE & DESCRIPTOR ENGINE
// =============================================================================

function collectNodeTree(node) {
  const nodes = [];
  function visit(n) {
    if (!n) return;
    nodes.push(n);
    try {
      for (const child of n.children) visit(child);
      return;
    } catch (e) {}
    try {
      let child = n.firstChild;
      while (child) {
        visit(child);
        child = child.nextSibling;
      }
    } catch (e) {}
  }
  visit(node);
  return nodes;
}

function cloneFill(rawFill) {
  try {
    if (rawFill && rawFill.clone) return rawFill.clone();
  } catch (e) {}
  return rawFill;
}

function cloneFillDescriptor(fd) {
  if (!fd) return null;
  try {
    if (!fd.fill) return FillDescriptor.createNone();
    return FillDescriptor.create(
      cloneFill(fd.fill),
      fd.isScaleWithObject,
      fd.transform,
      fd.blendMode,
      fd.isAnchoredToSpread
    );
  } catch (e) {
    return null;
  }
}

function getBrushFillDescriptor(node) {
  try {
    if (node.brushFillDescriptor) return node.brushFillDescriptor;
  } catch (e) {}
  try {
    if (node.brushFillInterface) {
      return node.brushFillInterface.getCurrentDescriptor(false);
    }
  } catch (e) {}
  return null;
}

function getPenFillDescriptor(node) {
  try {
    if (node.penFillDescriptor) return node.penFillDescriptor;
  } catch (e) {}
  try {
    if (node.penFillInterface) {
      return node.penFillInterface.getCurrentDescriptor(false);
    }
  } catch (e) {}
  return null;
}

function findBrushFillDescriptor(node) {
  const nodes = collectNodeTree(node);
  for (const n of nodes) {
    try {
      if (n.hasBrushFill === false) continue;
    } catch (e) {}
    const fd = getBrushFillDescriptor(n);
    if (fd && fd.fill) return fd;
  }
  return null;
}

function findPenFillDescriptor(node) {
  const nodes = collectNodeTree(node);
  for (const n of nodes) {
    try {
      if (n.hasPenFill === false) continue;
    } catch (e) {}
    const fd = getPenFillDescriptor(n);
    if (fd && fd.fill && !fd.isNoFill) return fd;
  }
  return null;
}

function getLineStyleDescriptor(node) {
  try {
    const lsi = node.lineStyleInterface;
    if (lsi) return lsi.getCurrentLineStyleDescriptor();
  } catch (e) {}
  try {
    if (node.lineStyleDescriptor) return node.lineStyleDescriptor;
  } catch (e) {}
  return null;
}

function findLineStyleDescriptor(node) {
  const nodes = collectNodeTree(node);
  for (const n of nodes) {
    try {
      if (n.hasPenFill === false) continue;
    } catch (e) {}
    const lsd = getLineStyleDescriptor(n);
    if (lsd) return lsd;
  }
  return null;
}

function cloneLineStyleDescriptor(lsd) {
  try {
    if (lsd && lsd.clone) return lsd.clone();
  } catch (e) {}
  return lsd || null;
}

function createLineStyleDescriptorWithWeightPts(sourceLsd, weightPts, doc) {
  const pixels = weightPts * (doc && doc.dpi ? doc.dpi : 72) / 72;
  try {
    if (sourceLsd && sourceLsd.lineStyle) {
      const ls = sourceLsd.lineStyle.clone();
      ls.weight = pixels;
      return LineStyleDescriptor.create(ls, {
        frontArrow: sourceLsd.frontArrowHead,
        backArrow: sourceLsd.backArrowHead,
        pressure: sourceLsd.pressure,
        isBehind: sourceLsd.isBehind,
        isScale: sourceLsd.isScale,
        strokeAlignment: sourceLsd.strokeAlignment
      });
    }
  } catch (e) {}
  try {
    return LineStyleDescriptor.createDefault(pixels);
  } catch (e2) {
    return null;
  }
}

function findStrokeWeightPts(node) {
  try {
    if (node && node.lineStyleInterface) {
      const lsi = node.lineStyleInterface;
      const lsDesc = lsi.lineStyleDescriptor;
      const weight = (lsDesc && lsDesc.lineStyle && typeof lsDesc.lineStyle.weight === 'number')
        ? lsDesc.lineStyle.weight
        : (typeof lsi.lineWeight === 'number' ? lsi.lineWeight : 0);
      if (typeof weight === 'number' && weight > 0) {
        const dpi = (node.document && node.document.dpi) ? node.document.dpi : 72;
        return weight * 72 / dpi;
      }
    }
  } catch (e) {}

  const nodes = collectNodeTree(node);
  for (const n of nodes) {
    try {
      if (n.lineStyleInterface) {
        const lsi = n.lineStyleInterface;
        const lsDesc = lsi.lineStyleDescriptor;
        const weight = (lsDesc && lsDesc.lineStyle && typeof lsDesc.lineStyle.weight === 'number')
          ? lsDesc.lineStyle.weight
          : (typeof lsi.lineWeight === 'number' ? lsi.lineWeight : 0);
        if (typeof weight === 'number' && weight > 0) {
          const dpi = (node.document && node.document.dpi) ? node.document.dpi : 72;
          return weight * 72 / dpi;
        }
      }
    } catch (e) {}
  }
  return null;
}

function setNodeLineWeightPts(node, weightPts) {
  try {
    if (node.lineStyleInterface) {
      node.lineStyleInterface.lineWeight = weightPts;
      return true;
    }
  } catch (e) {}
  try {
    const lsd = getLineStyleDescriptor(node);
    const newLsd = createLineStyleDescriptorWithWeightPts(lsd, weightPts, node.document);
    if (newLsd) {
      node.lineStyleDescriptor = newLsd;
      return true;
    }
  } catch (e) {}
  return false;
}

function setNodeBrushFillDescriptor(node, fd) {
  try {
    node.brushFillDescriptor = fd;
    return true;
  } catch (e) {}
  try {
    if (node.brushFillInterface) {
      node.brushFillInterface.currentDescriptor = fd;
      return true;
    }
  } catch (e) {}
  return false;
}

function setNodePenFillDescriptor(node, fd) {
  try {
    node.penFillDescriptor = fd;
    return true;
  } catch (e) {}
  try {
    if (node.penFillInterface) {
      node.penFillInterface.currentDescriptor = fd;
      return true;
    }
  } catch (e) {}
  return false;
}

function applyStrokeWeightToDuplicate(dup, weight) {
  if (!Number.isFinite(weight) || weight <= 0) return 0;
  let count = 0;
  for (const n of collectNodeTree(dup)) {
    if (setNodeLineWeightPts(n, weight)) count++;
  }
  return count;
}

// =============================================================================
// UNIVERSAL REPLACEMENT ENGINE (Vector, Raster, Group & Hierarchy)
// =============================================================================

function replaceWithKey(doc, keyNode, targets, ignoreSize, adoptFill, adoptStroke, adoptStrokeValue, deleteTargets) {
  const eligible = targets.filter(t => {
    try {
      return t.isEditable;
    } catch (e) {
      return true;
    }
  });
  if (eligible.length === 0) return { count: 0, duplicates: [] };

  const kBB = getSpreadBox(keyNode);
  const kCx = kBB.x + kBB.width / 2;
  const kCy = kBB.y + kBB.height / 2;
  const kRot = getVisualRotation(keyNode);
  const kSize = getIntrinsicSize(keyNode);
  const isKeySymbol = isSymbolNode(keyNode);
  const isKeyRaster = isRasterNode(keyNode);

  const baseCb = CompoundCommandBuilder.create();
  let replaced = 0;
  const pendingStyles = [];
  const duplicates = [];

  for (const target of eligible) {
    let tBB;
    try {
      tBB = getSpreadBox(target);
    } catch (e) {
      continue;
    }
    const tCx = tBB.x + tBB.width / 2;
    const tCy = tBB.y + tBB.height / 2;
    const tRot = getVisualRotation(target);
    const tSize = getIntrinsicSize(target);

    const sx = ignoreSize ? 1 : tSize.w / kSize.w;
    const sy = ignoreSize ? 1 : tSize.h / kSize.h;

    // PRE-CLONE target styles BEFORE target is deleted to avoid dead-handle issues
    const targetBrushFd = adoptFill ? findBrushFillDescriptor(target) : null;
    const targetPenFd = adoptStroke ? findPenFillDescriptor(target) : null;
    const targetStrokeWeight = adoptStrokeValue ? findStrokeWeightPts(target) : null;

    // 1. Duplicate keyNode synchronously at original position
    const dup = duplicateNode(doc, keyNode);
    if (!dup) continue;
    replaced++;
    duplicates.push(dup);

    // Save pre-cloned styles for vector/group duplicates
    if (!isKeySymbol && !isKeyRaster) {
      pendingStyles.push({
        dup,
        brushFd: cloneFillDescriptor(targetBrushFd),
        penFd: cloneFillDescriptor(targetPenFd),
        strokeWeight: targetStrokeWeight
      });
    }

    // 2. Zero-shear composite matrix:
    // Transforms from (kCx, kCy) with kRot to (tCx, tCy) with tRot and scale (sx, sy)
    const M = createCompositeTransform(kCx, kCy, kRot, tCx, tCy, tRot, sx, sy);
    baseCb.addCommand(DocumentCommand.createTransform(dup.selfSelection, M));

    // 3. Move duplicate into target parent hierarchy (Group, Layer, Artboard, Enclosure)
    const targetChildType = getTargetChildType(target);
    baseCb.addCommand(DocumentCommand.createMoveNodes(
      dup.selfSelection, target, NodeMoveType.After, targetChildType
    ));

    // 4. Delete target
    if (deleteTargets) {
      baseCb.addCommand(DocumentCommand.createDeleteSelection(target.selfSelection, true));
    }
  }

  if (replaced === 0) {
    return { count: 0, duplicates };
  }

  // Execute base compound command
  try {
    doc.executeCommand(baseCb.createCommand(), false);
  } catch (e) {
    console.log('replaceWithKey command execution failed: ' + e.message);
  }

  // Apply pre-cloned vector styles
  for (const pending of pendingStyles) {
    if (pending.brushFd) {
      for (const n of collectNodeTree(pending.dup)) {
        setNodeBrushFillDescriptor(n, cloneFillDescriptor(pending.brushFd));
      }
    }
    if (pending.penFd) {
      for (const n of collectNodeTree(pending.dup)) {
        setNodePenFillDescriptor(n, cloneFillDescriptor(pending.penFd));
      }
    }
    if (Number.isFinite(pending.strokeWeight) && pending.strokeWeight > 0) {
      applyStrokeWeightToDuplicate(pending.dup, pending.strokeWeight);
    }
  }

  return { count: replaced, duplicates };
}

function doReplace(doc, keyNode, targets, ignoreSize, adoptFill, adoptStroke, adoptStrokeValue) {
  const result = replaceWithKey(doc, keyNode, targets, ignoreSize, adoptFill, adoptStroke, adoptStrokeValue, true);
  if (result.count === 0) return 0;
  if (result.duplicates && result.duplicates.length > 0) {
    try {
      const newSel = makeSelection(doc, result.duplicates);
      if (newSel) doc.selection = newSel;
    } catch (e) {}
  }
  return result.count;
}

// =============================================================================
// POLYCURVE EXTRACTION & ZERO-SHEAR LIVE PREVIEW ENGINE
// =============================================================================

function clonePolyCurveToSpread(node) {
  if (!node) return null;
  try {
    let pc = null;
    if (node.curvesInterface) {
      try { pc = node.curvesInterface.polyCurve ? node.curvesInterface.polyCurve.clone() : null; } catch (e) {}
      if (!pc) {
        try { pc = node.curvesInterface.corneredPolyCurve ? node.curvesInterface.corneredPolyCurve.clone() : null; } catch (e) {}
      }
    }
    if (pc) {
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
  let brushFill = FillDescriptor.createNone();
  let lineStyle = LineStyleDescriptor.createDefault(0);
  let lineFill = FillDescriptor.createNone();
  let transparencyFill = FillDescriptor.createNone();

  try {
    if (node.lineStyleInterface) {
      const lsi = node.lineStyleInterface;
      const lsDesc = lsi.lineStyleDescriptor;
      const penFill = lsi.penFillDescriptor;
      const weight = (lsDesc && lsDesc.lineStyle && typeof lsDesc.lineStyle.weight === 'number')
        ? lsDesc.lineStyle.weight
        : (typeof lsi.lineWeight === 'number' ? lsi.lineWeight : 0);

      if (lsDesc) {
        lineStyle = lsDesc.clone();
      } else if (weight > 0) {
        lineStyle = LineStyleDescriptor.createDefault(weight);
      }

      if (penFill && !penFill.isNoFill) {
        lineFill = penFill.clone();
      }
    }
  } catch (e) {}

  try {
    if (node.brushFillInterface && node.brushFillInterface.currentDescriptor) {
      const bf = node.brushFillInterface.currentDescriptor;
      if (bf && !bf.isNoFill) brushFill = bf.clone();
    } else if (node.brushFillDescriptor && !node.brushFillDescriptor.isNoFill) {
      brushFill = node.brushFillDescriptor.clone();
    }
  } catch (e) {}

  try {
    if (node.transparencyInterface && node.transparencyInterface.fillDescriptor) {
      const tf = node.transparencyInterface.fillDescriptor;
      if (tf && !tf.isNoFill) transparencyFill = tf.clone();
    }
  } catch (e) {}

  return { brushFill, lineStyle, lineFill, transparencyFill };
}

function extractGeomEntriesFromNode(node) {
  const entries = [];
  if (!node) return entries;

  const children = [];
  try {
    let c = node.firstChild;
    while (c) {
      children.push(c);
      c = c.nextSibling;
    }
  } catch (e) {}

  if (children.length > 0) {
    for (const child of children) {
      const sub = extractGeomEntriesFromNode(child);
      for (const s of sub) entries.push(s);
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

function clearDocumentPreviews(doc) {
  try {
    doc.executeCommand(DocumentCommand.createClearPreviews());
  } catch (e) {}
}

function renderLivePreview(doc, keyNode, targets, ignoreSize, adoptFill, adoptStroke, adoptStrokeValue) {
  clearDocumentPreviews(doc);
  if (!keyNode || !targets || !targets.length) return;

  const keyGeom = extractGeomEntriesFromNode(keyNode);
  const isKeyRaster = isRasterNode(keyNode);
  const isKeySym = isSymbolNode(keyNode);

  let kBB;
  try { kBB = getSpreadBox(keyNode); } catch (e) { return; }
  const kCx = kBB.x + kBB.width / 2;
  const kCy = kBB.y + kBB.height / 2;
  const kRot = getVisualRotation(keyNode);
  const kSize = getIntrinsicSize(keyNode);

  const targetSel = makeSelection(doc, targets);
  if (!targetSel) return;

  const cb = CompoundCommandBuilder.create();

  // 1. Atomically hide all target objects being replaced
  cb.addCommand(DocumentCommand.createSetVisibility(targetSel, false));

  const isKeyGroup = isGroupNode(keyNode);
  let usedVectorPreview = false;
  if (keyGeom.length > 0 && !isKeyRaster && !isKeySym && !isKeyGroup) {
    try {
      // Vector preview using PolyCurves with adopted styles
      const addBuilder = AddChildNodesCommandBuilder.create();

      for (const target of targets) {
        let tBB;
        try { tBB = getSpreadBox(target); } catch (e) { continue; }
        const tCx = tBB.x + tBB.width / 2;
        const tCy = tBB.y + tBB.height / 2;
        const tRot = getVisualRotation(target);
        const tSize = getIntrinsicSize(target);

        const sx = ignoreSize ? 1 : tSize.w / kSize.w;
        const sy = ignoreSize ? 1 : tSize.h / kSize.h;

        // Transform from key spread pos to target center with zero shear
        const xform = createCompositeTransform(kCx, kCy, kRot, tCx, tCy, tRot, sx, sy);

        const targetBrushFd = adoptFill ? findBrushFillDescriptor(target) : null;
        const targetPenFd = adoptStroke ? findPenFillDescriptor(target) : null;
        const targetStrokeWeight = adoptStrokeValue ? findStrokeWeightPts(target) : null;

        for (const geom of keyGeom) {
          if (!geom || !geom.polyCurve) continue;
          const pc = geom.polyCurve.clone();
          try { pc.transform(xform); } catch (e) {}

          const s = geom.style;
          let brushFill = targetBrushFd
            ? cloneFillDescriptor(targetBrushFd)
            : (s.brushFill && !s.brushFill.isNoFill ? s.brushFill.clone() : FillDescriptor.createNone());

          let lineFill = targetPenFd
            ? cloneFillDescriptor(targetPenFd)
            : (s.lineFill && !s.lineFill.isNoFill ? s.lineFill.clone() : FillDescriptor.createNone());

          let lineStyle = s.lineStyle ? s.lineStyle.clone() : LineStyleDescriptor.createDefault(0);

          if (Number.isFinite(targetStrokeWeight) && targetStrokeWeight > 0) {
            lineStyle = createLineStyleDescriptorWithWeightPts(lineStyle, targetStrokeWeight, doc);
            if (!lineFill || lineFill.isNoFill) {
              const keyPen = findPenFillDescriptor(keyNode);
              const targetPen = findPenFillDescriptor(target);
              if (keyPen && !keyPen.isNoFill) {
                lineFill = cloneFillDescriptor(keyPen);
              } else if (targetPen && !targetPen.isNoFill) {
                lineFill = cloneFillDescriptor(targetPen);
              } else if (brushFill && !brushFill.isNoFill) {
                lineFill = cloneFillDescriptor(brushFill);
              }
            }
          }

          // In Affinity SDK: PolyCurveNodeDefinition.create(curve, brushFill, lineFill, lineStyle, transparencyFill)
          const def = PolyCurveNodeDefinition.create(
            pc,
            brushFill,
            lineFill,
            lineStyle,
            s.transparencyFill || FillDescriptor.createNone()
          );
          addBuilder.addNode(def);
        }
      }

      const addCmd = addBuilder.createCommand(false, NodeChildType.Main);
      if (addCmd) {
        cb.addCommand(addCmd);
        usedVectorPreview = true;
      }
    } catch (e) {
      usedVectorPreview = false;
    }
  }

  if (!usedVectorPreview) {
    // Native transient preview: works 100% reliably for all layer types (Vectors, Shapes, Curves, Rasters, Groups, Symbols)
    const keySel = Selection.create(doc, keyNode);
    for (const target of targets) {
      let tBB;
      try { tBB = getSpreadBox(target); } catch (e) { continue; }
      const tCx = tBB.x + tBB.width / 2;
      const tCy = tBB.y + tBB.height / 2;
      const tRot = getVisualRotation(target);
      const tSize = getIntrinsicSize(target);

      const sx = ignoreSize ? 1 : tSize.w / kSize.w;
      const sy = ignoreSize ? 1 : tSize.h / kSize.h;

      const M = createCompositeTransform(kCx, kCy, kRot, tCx, tCy, tRot, sx, sy);

      cb.addCommand(DocumentCommand.createTransform(keySel, M, {
        duplicateNodes: true,
        cloneRaster: isKeyRaster
      }));
    }
  }

  // Execute compound preview command
  try {
    const finalCmd = cb.createCommand();
    if (finalCmd) doc.executeCommand(finalCmd, true);
  } catch (e) {
    console.log('Preview compound command error: ' + e.message);
  }
}

function showMessage(title, message) {
  try {
    const dlg = Dialog.create(title);
    dlg.addColumn().addGroup('').addStaticText('', message).isFullWidth = true;
    dlg.show();
  } catch (e) {
    console.log(title + ': ' + message);
  }
}

// =============================================================================
// MAIN ENTRY POINT
// =============================================================================

function main() {
  const doc = getCurrentDocument();
  if (!doc) {
    showMessage(APP_NAME, 'No document open.');
    return;
  }

  const topLevel = getTopLevelNodes(getSelectionNodes(doc));

  if (topLevel.length < 2) {
    showMessage(APP_NAME, 'Select at least 2 objects (key + targets) and run again.');
    return;
  }

  const labels = topLevel.map((n, i) => {
    let b = { width: 0, height: 0 };
    try {
      const isz = getIntrinsicSize(n);
      b = { width: isz.w, height: isz.h };
    } catch (e) {
      try { b = getSpreadBox(n); } catch (e2) {}
    }
    const desc = n.userDescription || n.defaultDescription || nodeTag(n).replace('Node', '') || 'Object';
    const isRaster = isRasterNode(n);
    const tag = isSymbolNode(n) ? 'Symbol' : (isRaster ? (n.isRasterNode ? 'Pixel' : 'Image') : (isGroupNode(n) ? 'Group' : (nodeTag(n).replace('Node', '') || 'Node')));
    
    const pTag = n.parent ? nodeTag(n.parent) : '';
    const isNested = n.parent && pTag !== 'SpreadNode' && pTag !== 'DocumentNode';
    const parentDesc = isNested
      ? ` [in ${n.parent.userDescription || n.parent.defaultDescription || pTag.replace('Node', '')}]`
      : '';

    return `[${i + 1}]  ${desc}   ${b.width.toFixed(0)} x ${b.height.toFixed(0)}  (${tag})${parentDesc}`;
  });

  const dlg = Dialog.create(APP_NAME);
  dlg.initialWidth = 460;
  const col = dlg.addColumn();

  const grpKey = col.addGroup('Key Object');
  grpKey.addStaticText('', 'Template object - replaces all other selected objects:');
  const keyCombo = grpKey.addComboBox('', labels, 0);
  keyCombo.isFullWidth = true;

  const grpOpts = col.addGroup('Options');
  const matchSizeCk = grpOpts.addCheckBox('Adopt target dimensions (override key size)', false);
  matchSizeCk.isFullWidth = true;
  const adoptFillCk = grpOpts.addCheckBox('Adopt target fill color (vector only)', false);
  adoptFillCk.isFullWidth = true;
  const adoptStrokeCk = grpOpts.addCheckBox('Adopt target stroke color (vector only)', false);
  adoptStrokeCk.isFullWidth = true;
  const adoptStrokeValueCk = grpOpts.addCheckBox('Adopt target stroke value (vector only)', false);
  adoptStrokeValueCk.isFullWidth = true;

  const grpInfo = col.addGroup('');
  grpInfo.enableSeparator = true;
  grpInfo.addStaticText('', `${topLevel.length} objects - 1 key - ${topLevel.length - 1} target(s)`).isFullWidth = true;
  grpInfo.addStaticText('', 'Live preview updates when the key or options change.').isFullWidth = true;
  grpInfo.addStaticText('', 'OK - applies once. Cancel - clears the preview.').isFullWidth = true;

  function readControls() {
    const keyIdx = Math.min(Math.max(keyCombo.selectedIndex, 0), topLevel.length - 1);
    return {
      keyIdx,
      ignoreSize: !matchSizeCk.value,
      adoptFill: adoptFillCk.value,
      adoptStroke: adoptStrokeCk.value,
      adoptStrokeValue: adoptStrokeValueCk.value
    };
  }

  let currentControls = readControls();

  function triggerPreview() {
    currentControls = readControls();
    const keyNode = topLevel[currentControls.keyIdx];
    const targets = topLevel.filter((_, i) => i !== currentControls.keyIdx);

    renderLivePreview(
      doc,
      keyNode,
      targets,
      currentControls.ignoreSize,
      currentControls.adoptFill,
      currentControls.adoptStroke,
      currentControls.adoptStrokeValue
    );
  }

  keyCombo.onValueChangedHandler = triggerPreview;
  matchSizeCk.onValueChangedHandler = triggerPreview;
  adoptFillCk.onValueChangedHandler = triggerPreview;
  adoptStrokeCk.onValueChangedHandler = triggerPreview;
  adoptStrokeValueCk.onValueChangedHandler = triggerPreview;

  // Initial preview on open
  triggerPreview();

  const result = dlg.show();

  // Clear live preview immediately on dialog close
  clearDocumentPreviews(doc);

  if (result.value === DialogResult.Ok.value) {
    const finalControls = readControls();
    const finalKeyNode = topLevel[finalControls.keyIdx];
    const finalTargets = topLevel.filter((_, i) => i !== finalControls.keyIdx);

    const replacedCount = doReplace(
      doc,
      finalKeyNode,
      finalTargets,
      finalControls.ignoreSize,
      finalControls.adoptFill,
      finalControls.adoptStroke,
      finalControls.adoptStrokeValue
    );

    if (replacedCount > 0) {
      console.log(`Replaced ${replacedCount} object(s) with ${finalKeyNode.userDescription || finalKeyNode.defaultDescription || 'key object'}.`);
    }
  }
}

try {
  main();
} catch (err) {
  showMessage(APP_NAME, 'Replace Objects Error: ' + (err && (err.message || err.stack) ? (err.message || err.stack) : err));
}
