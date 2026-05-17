'use strict';

// PUCKER & BLOAT v2.3 - Affinity Designer
//
// v2.3 keeps the v1 pucker/bloat curve algorithm, but updates preview/commit:
// - preview commands run as MCP preview state from onValueChangedHandler
// - every preview is rebuilt from each object's original curvesInterface data
// - selected groups are expanded recursively to all vector children
// - multiple selected objects are processed together
// - ShapeNodes are converted to mutable curves in one batch before preview/apply
// - Cancel clears previews and restores the starting history position, including conversion
// - OK clears previews, then applies the final curve change once

const { Document } = require('/document');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
const { CurveBuilder, PolyCurve } = require('/geometry');
const { Dialog, DialogResult } = require('/dialog');
const { Selection } = require('/selections');

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

function isPuckerBloatCandidate(n) {
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

function collectVectorNodes(selectedNodes) {
  const nodes = [];

  function visit(node) {
    let child = null;
    try {
      child = node.firstChild;
    } catch (e) {
      child = null;
    }

    if ((node.isGroupNode || node.isContainerNode) && child) {
      while (child) {
        visit(child);

        try {
          child = child.nextSibling;
        } catch (e) {
          child = null;
        }
      }
      return;
    }

    if (isPuckerBloatCandidate(node)) {
      pushUnique(nodes, node);
    }

    while (child) {
      visit(child);

      try {
        child = child.nextSibling;
      } catch (e) {
        child = null;
      }
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
      console.log('Pucker & Bloat convert failed: ' + e);
    }

    if (!converted.length) {
      try {
        for (const selected of collectVectorNodes(doc.selection.nodes.toArray())) {
          pushUnique(converted, selected);
        }
      } catch (e) {
        console.log('Pucker & Bloat convert fallback failed: ' + e);
      }
    }

    return converted;
  }

  function restoreHistoryStart() {
    if (doc.history.position !== historyStart) {
      doc.history.position = historyStart;
    }
  }

  function readValues() {
    return {
      amount: Math.max(-200, Math.min(200, amtEd.value))
    };
  }

  function readBoxCenter(polyCurve) {
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
        x: bbox.x + bbox.width / 2,
        y: bbox.y + bbox.height / 2
      };
    }

    if (bbox.x0 !== undefined && bbox.x1 !== undefined && bbox.y0 !== undefined && bbox.y1 !== undefined) {
      return {
        x: (bbox.x0 + bbox.x1) / 2,
        y: (bbox.y0 + bbox.y1) / 2
      };
    }

    return null;
  }

  function warpPoint(pt, cx, cy, scale) {
    return {
      x: cx + (pt.x - cx) * scale,
      y: cy + (pt.y - cy) * scale
    };
  }

  function buildPuckerBloatPolyCurve(sourcePolyCurve, amount) {
    const center = readBoxCenter(sourcePolyCurve);
    if (!center) return sourcePolyCurve.clone();

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

  function createPuckerBloatCommand(targets, amount) {
    const cb = CompoundCommandBuilder.create();
    let count = 0;

    for (const target of targets) {
      cb.addCommand(DocumentCommand.createSetCurves(
        target.curvesInterface,
        buildPuckerBloatPolyCurve(target.sourcePolyCurve, amount)
      ));
      count++;
    }

    return count ? cb.createCommand() : null;
  }

  let inPreview = false;
  const previewTargets = makeTargets(nodes);

  function applyPreview() {
    if (inPreview) return;
    inPreview = true;

    try {
      const values = readValues();
      doc.executeCommand(DocumentCommand.createClearPreviews());

      if (previewTargets.length) {
        const cmd = createPuckerBloatCommand(previewTargets, values.amount);
        if (cmd) doc.executeCommand(cmd, true);
      }
    } catch (e) {
      console.log('Pucker & Bloat preview failed: ' + e);
    } finally {
      inPreview = false;
    }
  }

  const dlg = Dialog.create('Pucker & Bloat');
  dlg.initialWidth = 340;

  const col = dlg.addColumn();
  const grp = col.addGroup('Parameters');

  var amtEd = grp.addUnitValueEditor('Amount (%)', 'px', 'px', 0, -200, 200);
  amtEd.precision = 1;
  amtEd.showPopupSlider = true;

  amtEd.onValueChangedHandler = applyPreview;
  dlg.onControlValueChangedHandler = applyPreview;

  const result = dlg.show();
  const finalValues = readValues();

  try {
    doc.executeCommand(DocumentCommand.createClearPreviews());
  } catch (e) {
    console.log('Pucker & Bloat clear preview failed: ' + e);
  }

  if (result.value === DialogResult.Ok.value) {
    const targets = makeTargets(nodes);
    if (targets.length) {
      const cmd = createPuckerBloatCommand(targets, finalValues.amount);
      if (cmd) doc.executeCommand(cmd);
    }
  } else {
    restoreHistoryStart();
  }
}
