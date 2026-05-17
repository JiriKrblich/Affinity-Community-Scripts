'use strict';

// TWIST EFFECT v2.5 - Affinity Designer
//
// v2.5 keeps the v1 twist algorithm, but updates preview/commit for MCP 3.2.1:
// - preview commands run as preview state from dialog value handlers
// - every preview is rebuilt from each object's original curvesInterface data
// - selected groups are expanded recursively to all vector children using node.children.all
// - multiple selected objects are processed together
// - ShapeNodes are converted to mutable curves before preview/apply
// - default preview is applied after the dialog opens
// - Cancel clears previews and restores the starting history position, including conversion
// - OK clears previews, then applies the final curve change once

const { Document } = require('/document');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
const { CurveBuilder, PolyCurve } = require('/geometry');
const { Dialog, DialogResult } = require('/dialog');
const { Selection } = require('/selections');
const { setImmediate } = require('/timers');

const doc = Document.current;

if (!doc) {
  alert('Deschide un document.');
} else {
  const rawNodes = getSelectedVectorNodes();

  if (!rawNodes.length) {
    alert('Selecteaza una sau mai multe curbe, forme sau grupuri.');
  } else {
    main(rawNodes);
  }
}

function isTwistCandidate(n) {
  if (!n) return false;

  try {
    return !!(n.curvesInterface && n.curvesInterface.polyCurve);
  } catch (e) {
    return false;
  }
}

function pushUnique(nodes, node) {
  if (!node) return;

  for (const existing of nodes) {
    try {
      if (existing.isSameNode && existing.isSameNode(node)) return;
    } catch (e) {
      // Ignore stale handles left behind by conversion/history changes.
    }
  }

  nodes.push(node);
}

function getDirectChildren(node) {
  const children = [];

  if (!node) return children;

  try {
    for (const child of node.children) {
      pushUnique(children, child);
    }
  } catch (e) {
    let child = null;
    try {
      child = node.firstChild;
    } catch (err) {
      child = null;
    }

    while (child) {
      pushUnique(children, child);

      try {
        child = child.nextSibling;
      } catch (err) {
        child = null;
      }
    }
  }

  return children;
}

function getDescendantNodes(node) {
  const children = [];

  if (!node) return children;

  try {
    for (const child of node.children.all) {
      pushUnique(children, child);
    }
  } catch (e) {
    function visit(parent) {
      for (const child of getDirectChildren(parent)) {
        pushUnique(children, child);
        visit(child);
      }
    }

    visit(node);
  }

  return children;
}

function collectVectorNodes(selectedNodes) {
  const nodes = [];

  function visit(node) {
    if (!node) return;

    const descendants = getDescendantNodes(node);

    if ((node.isGroupNode || node.isContainerNode) && descendants.length) {
      for (const child of descendants) {
        if (isTwistCandidate(child)) pushUnique(nodes, child);
      }
      return;
    }

    if (isTwistCandidate(node)) {
      pushUnique(nodes, node);
    }

    for (const child of descendants) {
      if (isTwistCandidate(child)) pushUnique(nodes, child);
    }
  }

  for (const node of selectedNodes) {
    visit(node);
  }

  return nodes;
}

function collectVectorNodesViaSelectionItems(selection) {
  const nodes = [];

  let items = null;
  try {
    items = selection.items;
  } catch (e) {
    items = null;
  }

  if (!items) return nodes;

  for (const item of items) {
    let node = null;
    try {
      node = item.node;
    } catch (e) {
      node = null;
    }

    for (const target of collectVectorNodes([node])) {
      pushUnique(nodes, target);
    }
  }

  return nodes;
}

function getSelectedVectorNodes() {
  const nodes = collectVectorNodesViaSelectionItems(doc.selection);
  if (nodes.length) return nodes;

  try {
    return collectVectorNodes(doc.selection.nodes.toArray());
  } catch (e) {
    return [];
  }
}

function main(rawNodes) {
  const historyStart = doc.history.position;
  const nodes = ensureMutableCurveNodes(rawNodes);

  if (!nodes.length) {
    alert('Nu am putut converti selectia la curbe editabile.');
    return;
  }

  function makeTargets(raw) {
    const targets = [];

    for (const n of raw) {
      try {
        const curvesInterface = n.curvesInterface;
        const polyCurve = n.polyCurve || curvesInterface.polyCurve;

        if (curvesInterface && polyCurve) {
          targets.push({
            curvesInterface,
            sourcePolyCurve: polyCurve.clone()
          });
        }
      } catch (e) {
        // Ignore non-vector children inside selected groups.
      }
    }

    return targets;
  }

  function ensureMutableCurveNodes(raw) {
    const result = [];
    const needsConvert = [];

    for (const n of raw) {
      if (isMutableCurveNode(n)) {
        pushUnique(result, n);
        continue;
      }

      pushUnique(needsConvert, n);
    }

    for (const converted of convertNodesToCurves(needsConvert)) {
      if (isMutableCurveNode(converted)) {
        pushUnique(result, converted);
      }
    }

    return result;
  }

  function isMutableCurveNode(n) {
    if (!n) return false;

    try {
      return !!(n.curvesInterface && n.curvesInterface.isMutable && (n.polyCurve || n.curvesInterface.polyCurve));
    } catch (e) {
      return false;
    }
  }

  function convertNodesToCurves(nodesToConvert) {
    const converted = [];

    if (!nodesToConvert.length) return converted;

    try {
      const cmd = DocumentCommand.createConvertToCurves(Selection.create(doc, nodesToConvert, true));
      doc.executeCommand(cmd);

      for (const newNode of collectVectorNodes(cmd.newNodes)) {
        pushUnique(converted, newNode);
      }
    } catch (e) {
      console.log('Twist convert failed: ' + e);
    }

    if (!converted.length) {
      try {
        for (const selected of collectVectorNodes(doc.selection.nodes.toArray())) {
          pushUnique(converted, selected);
        }
      } catch (e) {
        console.log('Twist convert fallback failed: ' + e);
      }
    }

    return converted;
  }

  function restoreHistoryStart() {
    if (doc.history.position !== historyStart) {
      doc.history.position = historyStart;
    }
  }

  function readBox(polyCurve) {
    let bbox = null;

    try {
      bbox = polyCurve.exactBoundingBox;
    } catch (e) {
      bbox = null;
    }

    if (!bbox) {
      try {
        bbox = polyCurve.boundingBox;
      } catch (e) {
        bbox = null;
      }
    }

    if (!bbox) return null;

    if (bbox.width !== undefined && bbox.height !== undefined) {
      return {
        x: bbox.x,
        y: bbox.y,
        width: bbox.width,
        height: bbox.height
      };
    }

    if (bbox.x0 !== undefined && bbox.x1 !== undefined && bbox.y0 !== undefined && bbox.y1 !== undefined) {
      return {
        x: bbox.x0,
        y: bbox.y0,
        width: bbox.x1 - bbox.x0,
        height: bbox.y1 - bbox.y0
      };
    }

    return null;
  }

  function evalBez(b, t) {
    const u = 1 - t;
    return {
      x: u * u * u * b.start.x + 3 * u * u * t * b.c1.x + 3 * u * t * t * b.c2.x + t * t * t * b.end.x,
      y: u * u * u * b.start.y + 3 * u * u * t * b.c1.y + 3 * u * t * t * b.c2.y + t * t * t * b.end.y
    };
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
    const bbox = readBox(sourcePolyCurve);
    if (!bbox) return sourcePolyCurve.clone();

    const cx = bbox.x + bbox.width / 2;
    const cy = bbox.y + bbox.height / 2;
    const maxR = Math.hypot(bbox.width / 2, bbox.height / 2) || 1;
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

  function createTwistCommand(targets, angleDeg, subdiv) {
    const cb = CompoundCommandBuilder.create();
    let count = 0;

    for (const target of targets) {
      cb.addCommand(DocumentCommand.createSetCurves(
        target.curvesInterface,
        buildTwistPolyCurve(target.sourcePolyCurve, angleDeg, subdiv)
      ));
      count++;
    }

    return count ? cb.createCommand() : null;
  }

  function readValues() {
    return {
      angle: Math.max(-3600, Math.min(3600, angleEd.value)),
      subdiv: Math.max(4, Math.min(200, Math.round(subdivEd.value)))
    };
  }

  function clearPreviews() {
    try {
      doc.executeCommand(DocumentCommand.createClearPreviews());
    } catch (e) {
      console.log('Twist clear preview failed: ' + e);
    }
  }

  let inPreview = false;
  let dialogOpen = false;
  const previewTargets = makeTargets(nodes);

  function applyPreview() {
    if (!dialogOpen) return;
    if (inPreview) return;
    inPreview = true;

    try {
      const values = readValues();
      clearPreviews();

      if (previewTargets.length) {
        const cmd = createTwistCommand(previewTargets, values.angle, values.subdiv);
        if (cmd) doc.executeCommand(cmd, true);
      }
    } catch (e) {
      console.log('Twist preview failed: ' + e);
      clearPreviews();
    } finally {
      inPreview = false;
    }
  }

  const dlg = Dialog.create('Twist Effect');
  dlg.initialWidth = 340;

  const col = dlg.addColumn();
  const grp = col.addGroup('Parameters');

  var angleEd = grp.addUnitValueEditor('Angle (deg)', 'px', 'px', 45, -3600, 3600);
  angleEd.precision = 1;
  angleEd.showPopupSlider = true;

  var subdivEd = grp.addUnitValueEditor('Mesh Resolution', 'px', 'px', 40, 4, 200);
  subdivEd.precision = 0;
  subdivEd.showPopupSlider = true;

  angleEd.onValueChangedHandler = applyPreview;
  subdivEd.onValueChangedHandler = applyPreview;
  dlg.onControlValueChangedHandler = applyPreview;

  dialogOpen = true;
  setImmediate(applyPreview);
  const result = dlg.show();
  dialogOpen = false;
  const finalValues = readValues();

  clearPreviews();

  if (result.value === DialogResult.Ok.value) {
    const finalTargets = makeTargets(nodes);

    if (finalTargets.length) {
      const cmd = createTwistCommand(finalTargets, finalValues.angle, finalValues.subdiv);
      if (cmd) doc.executeCommand(cmd);
    }
  } else {
    restoreHistoryStart();
  }
}
