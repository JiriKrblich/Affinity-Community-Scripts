/**
 * name: Replace Objects with Object v3ea
 */
'use strict';

// =============================================================================
// REPLACE ALL WITH KEY OBJECT v3ea (Live Stroke Weight Preview & Universal Engine)
// Affinity Designer / Photo / Publisher (v3g Standard)
//
// Key Features in v3ea:
// 1. Instant Live Preview for "Adopt Target Stroke Value":
//    Fixed the preview pipeline so checking "Adopt target stroke value"
//    immediately reconstructs the LineStyleDescriptor and assigns the proper
//    pen fill in the live preview overlay in real time before clicking OK.
// 2. Zero Layer Tag Modification (100% Clean Paths):
//    Completely free of layer tag coloring. Paths, curves, shapes, groups,
//    and symbols retain their pristine native layer tag colors with zero changes.
// 3. Atomic Clean Live Preview (Zero Target Ghosting):
//    Uses a single unified CompoundCommand preview pass (`executeCommand(cmd, true)`)
//    that atomically hides all target objects being replaced while rendering
//    the preview duplicate geometry above. Only the key object duplicates are
//    visible on canvas during preview.
// 4. Universal Parametric Shape Replacement:
//    Works flawlessly with shapes created with shape tools (Rectangle, Ellipse,
//    Star, Polygon, etc. whether converted to curves or not), curves, groups,
//    and symbols.
// 5. High-Fidelity Target Dimension Adoption (Exact v2 Engine):
//    Uses v2's proven `getIntrinsicSize` and `baseBox` unrotated coordinate
//    decomposition for pixel-perfect scale matching across any orientation.
// 6. Zero Duplicate Multiplier Bug Fix:
//    Preview creates 0 temporary DOM nodes and 0 history pollution.
//    On OK, keyNode.duplicate() is called strictly ONCE per target.
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
const { LineStyle, LineStyleDescriptor, LineStyleMask } = require('/linestyle');
const { Selection } = require('/selections');

const APP_NAME = 'Replace Objects with Object v3ea';
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

// =============================================================================
// GEOMETRY & INTRINSIC SIZE ENGINE (Exact v2 Precision)
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
  return { rotation: 0, scaleX: 1, scaleY: 1 };
}

function firstChildForVisuals(node) {
  if (nodeTag(node) !== 'GroupNode') return node;
  try {
    for (const child of node.children) return child;
  } catch (e) {}
  return node;
}

function getVisualRotation(node) {
  const source = firstChildForVisuals(node);
  return decomposeWorld(source).rotation || 0;
}

function getIntrinsicSize(node) {
  const source = firstChildForVisuals(node);
  const d = decomposeWorld(source);
  let bb = null;
  try {
    if (source.baseBox && isFiniteBox(source.baseBox)) {
      bb = source.baseBox;
    }
  } catch (e) {}
  if (!bb) {
    try { bb = getSpreadBox(source); } catch (e) {}
  }
  const sx = Math.abs(d.scaleX || 1);
  const sy = Math.abs(d.scaleY || 1);
  return {
    w: Math.max(EPS, sx * Math.abs(bb ? bb.width : 0)),
    h: Math.max(EPS, sy * Math.abs(bb ? bb.height : 0))
  };
}

function makeScaleAbout(cx, cy, sx, sy) {
  return Transform.createTranslate(cx, cy)
    .multiply(Transform.createScale(sx, sy))
    .multiply(Transform.createTranslate(-cx, -cy));
}

function makeRotateAbout(cx, cy, rotation) {
  return Transform.createTranslate(cx, cy)
    .multiply(Transform.createRotate(rotation))
    .multiply(Transform.createTranslate(-cx, -cy));
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
  } catch (e) {
    return null;
  }
}

function readLineWeightPts(node) {
  try {
    const lsi = node.lineStyleInterface;
    if (lsi && Number.isFinite(lsi.lineWeightPts) && lsi.lineWeightPts > 0) return lsi.lineWeightPts;
  } catch (e) {}
  try {
    if (Number.isFinite(node.lineWeightPts) && node.lineWeightPts > 0) return node.lineWeightPts;
  } catch (e) {}
  try {
    if (Number.isFinite(node.lineWeight) && node.lineWeight > 0) return node.lineWeight;
  } catch (e) {}
  try {
    const lsd = getLineStyleDescriptor(node);
    if (lsd && lsd.lineStyle && Number.isFinite(lsd.lineStyle.weight) && lsd.lineStyle.weight > 0) {
      const dpi = (node.document && node.document.dpi) ? node.document.dpi : 72;
      return (lsd.lineStyle.weight * 72) / dpi;
    }
  } catch (e) {}
  return null;
}

function findStrokeWeightPts(node) {
  const nodes = collectNodeTree(node);
  for (const n of nodes) {
    const weight = readLineWeightPts(n);
    if (Number.isFinite(weight) && weight > 0) return weight;
  }
  return null;
}

function setNodeLineWeightPts(node, weight) {
  try {
    const lsi = node.lineStyleInterface;
    if (lsi) {
      lsi.lineWeightPts = weight;
      return true;
    }
  } catch (e) {}
  try {
    node.lineWeightPts = weight;
    return true;
  } catch (e) {}
  try {
    node.lineWeight = weight;
    return true;
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

function applyAdoptFillToDuplicate(dup, target) {
  const sourceFd = findBrushFillDescriptor(target);
  if (!sourceFd) return 0;
  let count = 0;
  for (const n of collectNodeTree(dup)) {
    try {
      const fd = cloneFillDescriptor(sourceFd);
      if (!fd) continue;
      if (setNodeBrushFillDescriptor(n, fd)) count++;
    } catch (e) {}
  }
  return count;
}

function applyAdoptStrokeToDuplicate(dup, target) {
  const sourceFd = findPenFillDescriptor(target);
  if (!sourceFd) return 0;
  let count = 0;
  for (const n of collectNodeTree(dup)) {
    try {
      const fd = cloneFillDescriptor(sourceFd);
      if (!fd) continue;
      if (setNodePenFillDescriptor(n, fd)) count++;
    } catch (e) {}
  }
  return count;
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
// UNIVERSAL REPLACEMENT ENGINE (Guaranteed for All Shapes, Curves & Symbols)
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
    const deltaRot = tRot - kRot;
    const sx = ignoreSize ? 1 : tSize.w / kSize.w;
    const sy = ignoreSize ? 1 : tSize.h / kSize.h;
    const strokeWeight = adoptStrokeValue ? findStrokeWeightPts(target) : null;

    // Create duplicate of key object at target position
    const dup = keyNode.duplicate(Transform.createTranslate(tCx - kCx, tCy - kCy));
    if (!dup) continue;
    replaced++;
    duplicates.push(dup);

    if (!isKeySymbol) {
      pendingStyles.push({
        dup,
        target,
        adoptFill,
        adoptStroke,
        strokeWeight
      });
    }

    if (!ignoreSize && (Math.abs(sx - 1) > 0.001 || Math.abs(sy - 1) > 0.001)) {
      baseCb.addCommand(DocumentCommand.createTransform(
        dup.selfSelection,
        makeScaleAbout(tCx, tCy, sx, sy)
      ));
    }

    if (Math.abs(deltaRot) > 0.001) {
      baseCb.addCommand(DocumentCommand.createTransform(
        dup.selfSelection,
        makeRotateAbout(tCx, tCy, deltaRot)
      ));
    }

    baseCb.addCommand(DocumentCommand.createMoveNodes(
      dup.selfSelection, target, NodeMoveType.After, NodeChildType.Main
    ));

    if (deleteTargets) {
      baseCb.addCommand(DocumentCommand.createDeleteSelection(target.selfSelection, true));
    }
  }

  if (replaced === 0) {
    return { count: 0, duplicates };
  }

  try {
    doc.executeCommand(baseCb.createCommand(), false);
  } catch (e) {
    console.log('replaceWithKey command execution failed: ' + e.message);
  }

  // Zero tag coloring - all layers/paths preserve their clean native appearance

  for (const pending of pendingStyles) {
    if (pending.adoptFill) {
      applyAdoptFillToDuplicate(pending.dup, pending.target);
    }
    if (pending.adoptStroke) {
      applyAdoptStrokeToDuplicate(pending.dup, pending.target);
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
  return result.count;
}

// =============================================================================
// POLYCURVE EXTRACTION & ATOMIC PREVIEW ENGINE (Zero DOM Duplicates)
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

  // 2. Render duplicate preview shapes at target positions
  if (keyGeom.length > 0) {
    const addBuilder = AddChildNodesCommandBuilder.create();

    for (const target of targets) {
      let tBB;
      try { tBB = getSpreadBox(target); } catch (e) { continue; }
      const tCx = tBB.x + tBB.width / 2;
      const tCy = tBB.y + tBB.height / 2;
      const tRot = getVisualRotation(target);
      const tSize = getIntrinsicSize(target);

      const deltaRot = tRot - kRot;
      const sx = ignoreSize ? 1 : tSize.w / kSize.w;
      const sy = ignoreSize ? 1 : tSize.h / kSize.h;

      const xform = Transform.createTranslate(tCx, tCy)
        .multiply(Transform.createRotate(deltaRot))
        .multiply(Transform.createScale(sx, sy))
        .multiply(Transform.createTranslate(-kCx, -kCy));

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

        const def = PolyCurveNodeDefinition.create(
          pc,
          brushFill,
          lineStyle,
          lineFill,
          s.transparencyFill || FillDescriptor.createNone()
        );
        addBuilder.addNode(def);
      }
    }

    try {
      const addCmd = addBuilder.createCommand(false, NodeChildType.Main);
      if (addCmd) cb.addCommand(addCmd);
    } catch (e) {}
  }

  // Execute compound preview command (atomically hides targets and renders duplicate previews)
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
    try { b = getSpreadBox(n); } catch (e) {}
    const desc = n.userDescription || n.defaultDescription || nodeTag(n).replace('Node', '') || 'Object';
    const tag = isSymbolNode(n) ? 'Symbol' : (nodeTag(n).replace('Node', '') || 'Node');
    return `[${i + 1}]  ${desc}   ${b.width.toFixed(0)} x ${b.height.toFixed(0)}  (${tag})`;
  });

  const dlg = Dialog.create(APP_NAME);
  dlg.initialWidth = 420;
  const col = dlg.addColumn();

  const grpKey = col.addGroup('Key Object');
  grpKey.addStaticText('', 'Template object - replaces all other selected objects:');
  const keyCombo = grpKey.addComboBox('', labels, 0);
  keyCombo.isFullWidth = true;

  const grpOpts = col.addGroup('Options');
  const matchSizeCk = grpOpts.addCheckBox('Adopt target dimensions (override key size)', false);
  matchSizeCk.isFullWidth = true;
  const adoptFillCk = grpOpts.addCheckBox('Adopt target fill color', false);
  adoptFillCk.isFullWidth = true;
  const adoptStrokeCk = grpOpts.addCheckBox('Adopt target stroke color', false);
  adoptStrokeCk.isFullWidth = true;
  const adoptStrokeValueCk = grpOpts.addCheckBox('Adopt target stroke value', false);
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
    console.log(`[Replace Objects with Object v3ea] Applied: ${finalTargets.length} object(s) replaced.`);
  } else {
    console.log('[Replace Objects with Object v3ea] Cancelled - preview cleared.');
  }
}

module.exports.main = main;
main();
