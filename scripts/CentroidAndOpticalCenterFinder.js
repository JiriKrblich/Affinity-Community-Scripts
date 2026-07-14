/**
 * name: Centroid & Optical Center Finder
 * description: Calculates and draws the mathematical centroid (Red) and the visual/optical center (Blue) for selected shapes. https://bjango.com/articles/opticaladjustments/
 * version: 1.1
 * author: CrackHub
 * @affinity 3.2+
 * Changelog;
 * v1.0 - Once the points are created, the objects remain selected; you can group them using Ctrl+G if you wish.
 * 		- Multiple selection allowed
 * v1.1 - Optionally shifts the selected objects
 * 		- On the rare native dialog failure, fails cleanly (no retry, to avoid an unpredictable double-dialog) and asks you to re-run.
 */
"use strict";

const { app } = require("/application");
const { Document } = require("/document");
const { Dialog, DialogResult } = require("/dialog");
const { AddChildNodesCommandBuilder, DocumentCommand, NodeChildType } = require("/commands");
const { PolyCurveNodeDefinition } = require("/nodes");
const { Selection } = require("/selections");
const { CurveBuilder, PolyCurve, Transform } = require("/geometry");
const { FillDescriptor } = require("/fills");
const { LineStyleDescriptor } = require("/linestyle");
const { RGBA8 } = require("/colours");
const { BlendMode } = require("affinity:common");

// ─────────────────────────────────────────────────────────────────────────────
// Color / style helpers
// ─────────────────────────────────────────────────────────────────────────────

function solid(r, g, b, a) {
  return FillDescriptor.createSolid(RGBA8(r, g, b, a == null ? 255 : a), BlendMode.Normal);
}

function noFill() {
  return FillDescriptor.createNone();
}

function lineStyle(width) {
  return LineStyleDescriptor.createDefault(width);
}

const transparent = noFill();

// ─────────────────────────────────────────────────────────────────────────────
// Array / value / geometry helpers (shared with Centroid Finder & Align to Centroid)
// ─────────────────────────────────────────────────────────────────────────────

function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value.toArray === "function") return value.toArray();
  return Array.from(value);
}

function isFiniteNumber(value) {
  return typeof value === "number" && isFinite(value);
}

function validPoint(point) {
  return point && isFiniteNumber(point.x) && isFiniteNumber(point.y);
}

function getTransformMatrix(transform) {
  const text = String(transform);
  const match = text.match(
    /\[\[([^,\]]+),([^,\]]+),([^\]]+)\]\s*\[([^,\]]+),([^,\]]+),([^\]]+)\]\]/,
  );
  if (!match) return null;
  return {
    a: Number(match[1]),
    b: Number(match[2]),
    c: Number(match[3]),
    d: Number(match[4]),
    e: Number(match[5]),
    f: Number(match[6]),
  };
}

function transformPoint(point, transform) {
  if (!transform || !validPoint(point)) return point;

  const matrix = getTransformMatrix(transform);
  if (matrix) {
    return {
      x: matrix.a * point.x + matrix.b * point.y + matrix.c,
      y: matrix.d * point.x + matrix.e * point.y + matrix.f,
    };
  }

  if (typeof transform.decompose !== "function") return point;
  const data = transform.decompose();
  const scaleX = data.scaleX == null ? 1 : data.scaleX;
  const scaleY = data.scaleY == null ? 1 : data.scaleY;
  const shear = data.shear || 0;
  const rotation = data.rotation || 0;
  const translateX = data.translateX || 0;
  const translateY = data.translateY || 0;
  const shearedX = point.x * scaleX + point.y * shear;
  const shearedY = point.y * scaleY;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  return {
    x: shearedX * cos - shearedY * sin + translateX,
    y: shearedX * sin + shearedY * cos + translateY,
  };
}

function getNodeBox(node) {
  if (!node) return null;
  try {
    if (node.exactSpreadBaseBox) return node.exactSpreadBaseBox;
  } catch (_) {}
  try {
    if (typeof node.getSpreadBaseBox === "function") {
      const box = node.getSpreadBaseBox(false);
      if (box) return box;
    }
  } catch (_) {}
  try {
    if (node.spreadVisibleBox) return node.spreadVisibleBox;
  } catch (_) {}
  try {
    if (node.baseBox) return node.baseBox;
  } catch (_) {}
  try {
    const box = node.getSpreadVisibleBox();
    if (box) return box;
  } catch (_) {}
  return null;
}

function boxesAreClose(a, b, tolerance) {
  if (!a || !b) return false;
  const t = tolerance == null ? 0.5 : tolerance;
  return (
    Math.abs(a.x - b.x) <= t &&
    Math.abs(a.y - b.y) <= t &&
    Math.abs(a.width - b.width) <= t &&
    Math.abs(a.height - b.height) <= t
  );
}

function getTransformContext(converted, tolerance) {
  let rawBox = null;
  try {
    rawBox = converted.curvesInterface.polyPolyCurves.exactBoundingBox;
  } catch (_) {}
  if (!rawBox) {
    try {
      rawBox = converted.polyCurve.exactBoundingBox;
    } catch (_) {}
  }

  let transform = null;
  try {
    transform = converted.curvesInterface.domainTransform;
  } catch (_) {}

  const spreadBox = getNodeBox(converted);
  return {
    shouldTransform: Boolean(rawBox && spreadBox && !boxesAreClose(rawBox, spreadBox, tolerance)),
    transform,
  };
}

function mapCurvePoint(point, context) {
  if (!validPoint(point)) return null;
  return context.shouldTransform ? transformPoint(point, context.transform) : point;
}

function getSelectedNodes(doc) {
  const nodes = [];
  try {
    nodes.push.apply(nodes, asArray(doc.selection.nodes));
  } catch (_) {}

  if (nodes.length === 0) {
    try {
      for (const item of doc.selection.items) {
        if (item && item.node) nodes.push(item.node);
      }
    } catch (_) {}
  }

  const unique = [];
  for (const node of nodes) {
    if (node && unique.indexOf(node) < 0) unique.push(node);
  }
  return unique;
}

function getCurves(converted) {
  const curves = [];
  try {
    const polyPoly = converted.curvesInterface.polyPolyCurves;
    for (let i = 0; i < polyPoly.polyCurveCount; i += 1) {
      for (const curve of polyPoly.getTransformedPolyCurve(i)) {
        curves.push(curve);
      }
    }
  } catch (_) {}

  if (curves.length === 0) {
    try {
      for (const curve of converted.polyCurve) curves.push(curve);
    } catch (_) {}
  }
  return curves;
}

function convertTemporaryDuplicateToCurves(doc, node) {
  const temp = node.duplicate();
  const selection = Selection.create(doc, temp);
  const command = DocumentCommand.createConvertToCurves(selection);
  doc.executeCommand(command);

  const candidates = [];
  try {
    candidates.push.apply(candidates, asArray(command.newNodes));
  } catch (_) {}
  try {
    candidates.push.apply(candidates, asArray(doc.selection.nodes));
  } catch (_) {}
  candidates.push(temp);

  for (const candidate of candidates) {
    try {
      if (candidate && candidate.isPolyCurveNode) return candidate;
    } catch (_) {}
  }
  return candidates[0] || temp;
}

function deleteTemporaryNode(doc, node) {
  if (!node) return;
  try {
    if (typeof node.delete === "function") {
      node.delete();
      return;
    }
  } catch (_) {}
  try {
    doc.executeCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, node), false));
  } catch (_) {}
}

// Paul Bourke polygon area & centroid formula
function calculatePolygonCentroid(points) {
  if (points.length < 3) return null;

  const closedPoints = points.slice();
  if (
    closedPoints[0].x !== closedPoints[closedPoints.length - 1].x ||
    closedPoints[0].y !== closedPoints[closedPoints.length - 1].y
  ) {
    closedPoints.push(closedPoints[0]);
  }

  let area = 0;
  let cx = 0;
  let cy = 0;

  for (let i = 0; i < closedPoints.length - 1; i++) {
    const p1 = closedPoints[i];
    const p2 = closedPoints[i + 1];
    const factor = p1.x * p2.y - p2.x * p1.y;

    area += factor;
    cx += (p1.x + p2.x) * factor;
    cy += (p1.y + p2.y) * factor;
  }

  area /= 2;
  if (Math.abs(area) < 1e-5) return null;

  return {
    cx: cx / (6 * area),
    cy: cy / (6 * area),
    area: Math.abs(area),
  };
}

// Computes bbox center, mathematical centroid, and optical center for one node.
function computeCenters(doc, node) {
  let converted = null;
  let temporary = false;
  let finalCx = null;
  let finalCy = null;
  let bboxCx = null;
  let bboxCy = null;
  let shapeHeight = 0;

  const box = getNodeBox(node);
  if (!box) return null;
  bboxCx = box.x + box.width / 2;
  bboxCy = box.y + box.height / 2;
  shapeHeight = box.height;

  const tolerance = 0.5;

  try {
    if (node.isPolyCurveNode) {
      converted = node;
    } else {
      converted = convertTemporaryDuplicateToCurves(doc, node);
      temporary = true;
    }

    if (converted && converted.isPolyCurveNode) {
      const context = getTransformContext(converted, tolerance);
      const curves = getCurves(converted);

      let totalArea = 0;
      let weightedCx = 0;
      let weightedCy = 0;
      let allSampledPoints = [];

      for (const curve of curves) {
        const beziers = [...curve.beziers];
        if (beziers.length > 0) {
          const subPathPoints = [];

          for (const seg of beziers) {
            const p0 = mapCurvePoint(seg.start, context);
            const p1 = mapCurvePoint(seg.c1 || seg.start, context);
            const p2 = mapCurvePoint(seg.c2 || seg.end, context);
            const p3 = mapCurvePoint(seg.end, context);

            const steps = 10;
            for (let j = 0; j < steps; j++) {
              const t = j / steps;
              const mt = 1 - t;
              const mt2 = mt * mt;
              const mt3 = mt2 * mt;
              const t2 = t * t;
              const t3 = t2 * t;

              const x = mt3 * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t3 * p3.x;
              const y = mt3 * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t3 * p3.y;

              const pt = { x, y };
              subPathPoints.push(pt);
              allSampledPoints.push(pt);
            }
          }

          const endPt = mapCurvePoint(beziers[beziers.length - 1].end, context);
          subPathPoints.push(endPt);
          allSampledPoints.push(endPt);

          const polyResult = calculatePolygonCentroid(subPathPoints);
          if (polyResult) {
            weightedCx += polyResult.cx * polyResult.area;
            weightedCy += polyResult.cy * polyResult.area;
            totalArea += polyResult.area;
          }
        }
      }

      if (totalArea > 0) {
        finalCx = weightedCx / totalArea;
        finalCy = weightedCy / totalArea;
      } else if (allSampledPoints.length > 0) {
        let sumX = 0,
          sumY = 0;
        for (const pt of allSampledPoints) {
          sumX += pt.x;
          sumY += pt.y;
        }
        finalCx = sumX / allSampledPoints.length;
        finalCy = sumY / allSampledPoints.length;
      }
    }
  } catch (e) {
    finalCx = null;
    finalCy = null;
  } finally {
    if (temporary && converted) {
      deleteTemporaryNode(doc, converted);
    }
  }

  if (finalCx === null || finalCy === null) {
    finalCx = bboxCx;
    finalCy = bboxCy;
  }

  let opticalCx = 0.6 * finalCx + 0.4 * bboxCx;
  let opticalCy = 0.6 * finalCy + 0.4 * bboxCy;

  const isSymmetric = Math.hypot(finalCx - bboxCx, finalCy - bboxCy) < 1.0;
  if (!isSymmetric && shapeHeight > 0) {
    opticalCy -= shapeHeight * 0.015;
  }

  return {
    bboxCx,
    bboxCy,
    centroidX: finalCx,
    centroidY: finalCy,
    opticalX: opticalCx,
    opticalY: opticalCy,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Marker geometry (Red centroid + Blue optical center circles)
// ─────────────────────────────────────────────────────────────────────────────

function makeClosedPolyCurve(points) {
  const builder = CurveBuilder.create();
  builder.beginXY(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i += 1) {
    builder.lineToXY(points[i].x, points[i].y);
  }
  builder.close();
  const poly = PolyCurve.create();
  poly.addCurve(builder.createCurve());
  return poly;
}

function makeCircleDef(cx, cy, radius, brushFill, strokeFill, width) {
  const points = [];
  const steps = 24;
  for (let i = 0; i < steps; i += 1) {
    const angle = (Math.PI * 2 * i) / steps;
    points.push({
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
    });
  }
  return PolyCurveNodeDefinition.create(
    makeClosedPolyCurve(points),
    brushFill,
    lineStyle(width),
    strokeFill || brushFill,
    transparent,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  const doc = Document.current;
  if (!doc) {
    app.alert("Please open an active document.", "Centroid & Optical Center Finder");
    return;
  }

  const selected = getSelectedNodes(doc);
  if (selected.length === 0) {
    app.alert("Please select at least one object.", "Centroid & Optical Center Finder");
    return;
  }

  const spread = doc.currentSpread || doc.spreads.first;
  const holeDiameter = 9;

  // Precompute (once) each node's bbox center, centroid, and optical center.
  const entries = [];
  for (const node of selected) {
    const centers = computeCenters(doc, node);
    if (!centers) continue;
    entries.push({
      node,
      bboxCx: centers.bboxCx,
      bboxCy: centers.bboxCy,
      centroidX: centers.centroidX,
      centroidY: centers.centroidY,
      opticalX: centers.opticalX,
      opticalY: centers.opticalY,
      appliedDx: 0,
      appliedDy: 0,
      previewMarkerNodes: [], // currently-shown preview marker nodes for this entry (if any)
    });
  }

  if (entries.length === 0) {
    app.alert(
      "Could not compute reference points for the selected object(s).",
      "Centroid & Optical Center Finder",
    );
    return;
  }

  function targetDelta(entry, useOptical) {
    const px = useOptical ? entry.opticalX : entry.centroidX;
    const py = useOptical ? entry.opticalY : entry.centroidY;
    return { dx: entry.bboxCx - px, dy: entry.bboxCy - py };
  }

  // Applies (or re-applies) the alignment shift. Only the INCREMENTAL
  // difference vs. what's already applied is executed, so toggling the tick
  // or switching Red/Blue repeatedly stays correct.
  function applyDeltas(useOptical) {
    for (const entry of entries) {
      const target = targetDelta(entry, useOptical);
      const incDx = target.dx - entry.appliedDx;
      const incDy = target.dy - entry.appliedDy;
      if (Math.abs(incDx) < 1e-6 && Math.abs(incDy) < 1e-6) continue;
      try {
        const xf = Transform.createTranslate(incDx, incDy);
        const cmd = DocumentCommand.createTransform(Selection.create(doc, entry.node), xf, {
          mergeable: false,
        });
        doc.executeCommand(cmd);
        entry.appliedDx = target.dx;
        entry.appliedDy = target.dy;
      } catch (e) {}
    }
  }

  // Undoes any alignment shift currently applied, restoring original positions
  // (this is what happens when the tick is OFF - "old" unshifted behavior).
  function revertAll() {
    for (const entry of entries) {
      if (entry.appliedDx === 0 && entry.appliedDy === 0) continue;
      try {
        const xf = Transform.createTranslate(-entry.appliedDx, -entry.appliedDy);
        const cmd = DocumentCommand.createTransform(Selection.create(doc, entry.node), xf, {
          mergeable: false,
        });
        doc.executeCommand(cmd);
        entry.appliedDx = 0;
        entry.appliedDy = 0;
      } catch (e) {}
    }
  }

  // Deletes any currently-shown preview marker nodes for every entry.
  function deletePreviewMarkers() {
    for (const entry of entries) {
      for (const markerNode of entry.previewMarkerNodes) {
        deleteTemporaryNode(doc, markerNode);
      }
      entry.previewMarkerNodes = [];
    }
  }

  // Draws the Red (centroid) + Blue (optical center) markers for every entry,
  // at their CURRENT position (original position + whatever shift is applied -
  // 0 if the tick is off). Called every round (Preview AND Apply), so markers
  // are always visible regardless of the "Align to reference point" tick.
  function drawPreviewMarkers() {
    const markerFillRed = solid(255, 0, 0, 255);
    const markerFillBlue = solid(0, 162, 232, 255);
    const markerStroke = solid(0, 0, 0, 255);
    let processedCount = 0;

    for (const entry of entries) {
      const { node, appliedDx, appliedDy } = entry;
      const centroidX = entry.centroidX + appliedDx;
      const centroidY = entry.centroidY + appliedDy;
      const opticalX = entry.opticalX + appliedDx;
      const opticalY = entry.opticalY + appliedDy;

      let nodeDefs;
      try {
        nodeDefs = [
          makeCircleDef(centroidX, centroidY, holeDiameter / 2, markerFillRed, markerStroke, 0.6),
          makeCircleDef(opticalX, opticalY, holeDiameter / 2, markerFillBlue, markerStroke, 0.6),
        ];
      } catch (geomErr) {
        continue;
      }

      let parentContainer = null;
      try {
        parentContainer = node.parent || null;
      } catch (_) {}
      if (!parentContainer) parentContainer = spread;

      let insertedOk = false;
      let markerNodes = [];

      // Insert as SIBLINGS of node's parent (not as children of node itself),
      // otherwise node's own path clips/masks the markers.
      try {
        const builder = AddChildNodesCommandBuilder.create();
        builder.setInsertionTarget(parentContainer);
        for (const def of nodeDefs) builder.addNode(def);
        const command = builder.createCommand(false, NodeChildType.Main);
        doc.executeCommand(command);
        markerNodes = asArray(command.newNodes);
        insertedOk = true;
      } catch (e) {
        try {
          const builder = AddChildNodesCommandBuilder.create();
          builder.setInsertionTarget(spread);
          for (const def of nodeDefs) builder.addNode(def);
          const command = builder.createCommand(false, NodeChildType.Main);
          doc.executeCommand(command);
          markerNodes = asArray(command.newNodes);
          insertedOk = true;
        } catch (e2) {
          insertedOk = false;
        }
      }

      if (insertedOk) {
        processedCount++;
        entry.previewMarkerNodes = markerNodes;
      }
    }

    if (processedCount === 0) {
      app.alert("Could not draw markers for the selected object(s).", "Centroid & Optical Center Finder");
    }
  }

  // Leaves node + its (kept) markers selected, so you can group them yourself
  // with Ctrl+G - no real "Group" creation command exists in the scripting API.
  function selectAllForGrouping() {
    const nodesToSelectAtEnd = [];
    for (const entry of entries) {
      nodesToSelectAtEnd.push(entry.node, ...entry.previewMarkerNodes);
    }
    if (nodesToSelectAtEnd.length > 0) {
      try {
        doc.selection = nodesToSelectAtEnd;
      } catch (_) {}
    }
  }

  // ── Dialog ──────────────────────────────────────────────────────────────
  const dialog = Dialog.create("Centroid & Optical Center Finder");
  dialog.initialWidth = 320;
  dialog.isResizable = false;
  const col = dialog.addColumn();

  // Descriptive paragraph (goes inside the multi-line text box)
  const infoText =
    "Optionally aligns the object(s) so the chosen point sits exactly on their current bounding-box center " +
    "(use this AFTER bbox-aligning against a reference shape).\nRed and Blue markers are optionally drawn at the end.";

  // Selection-count line (kept SEPARATE, outside the text box, full width)
  const selectionCountText =
    entries.length > 1 ? entries.length + " objects selected." : "1 object selected.";

  const infoGroup = col.addGroup("Info");
  const infoBox = infoGroup.addTextBox("", infoText);
  infoBox.isFullWidth = true;
  infoBox.isMultiLine = true;
  infoBox.rowSpan = 3;
  infoBox.isEnabled = false; // display-only, prevents the user from editing it

  infoGroup.addStaticText("", selectionCountText).isFullWidth = true;

  const alignGroup = col.addGroup("Align to Reference Point");
  const tickCtrl = alignGroup.addCheckBox("Align to reference point", false);
  tickCtrl.isFullWidth = true;
  const pointRadio = alignGroup.addRadioGroup(
    "",
    ["Centroid (Red)", "Optical Center (Blue)"],
    0,
  );
  pointRadio.isFullWidth = true;
  pointRadio.isEnabled = tickCtrl.value; // starts disabled (tick is off by default)

  const markersCtrl = alignGroup.addSwitch("Create markers", true);
  markersCtrl.isEnabled = tickCtrl.value; // only relevant while aligning is enabled

  tickCtrl.setOnValueChangedHandler(() => {
    pointRadio.isEnabled = tickCtrl.value;
    markersCtrl.isEnabled = tickCtrl.value;
  });

  const actionGroup = col.addGroup("");
  actionGroup.enableSeparator = true;
  const modeBtns = actionGroup.addButtonSet("", ["↺ Preview", "✓ Apply"], 0);
  modeBtns.isFullWidth = true;

  let running = true;
  while (running) {
    modeBtns.selectedIndex = 0;
    let result;
    try {
      result = dialog.runModal();
    } catch (dlgErr) {
      app.alert(
        "The dialog closed unexpectedly due to a rare native issue.\n" +
          "Nothing was changed - please run the script again.\n\n" +
          String(dlgErr && dlgErr.message ? dlgErr.message : dlgErr),
        "Centroid & Optical Center Finder",
      );
      revertAll();
      deletePreviewMarkers();
      running = false;
      continue;
    }

    const tickOn = tickCtrl.value;
    const useOptical = pointRadio.selectedIndex === 1;
    // "Create markers" only matters while aligning; if alignment is off,
    // markers are always created/kept (no shift happened, so this is just
    // the plain "draw the points" behavior with no reason to discard them).
    const keepMarkers = tickOn ? markersCtrl.value : true;
    const mode = modeBtns.selectedIndex;

    if (result.value === DialogResult.Ok.value) {
      // Clear any previous preview markers before recomputing/redrawing.
      deletePreviewMarkers();

      if (tickOn) {
        applyDeltas(useOptical);
      } else {
        revertAll(); // Tick off -> "old" behavior: no shift
      }

      // Always draw markers for a live preview - UNLESS aligning is on and
      // "Create markers" is off, in which case markers should stay hidden
      // even during Preview (not just discarded at the final Apply step).
      if (keepMarkers) {
        drawPreviewMarkers();
      }

      if (mode === 1) {
        // Apply -> commit the shift (if any); keep the markers if they were
        // drawn (keepMarkers true), otherwise there's nothing to discard.
        if (keepMarkers) {
          selectAllForGrouping();
        }
        running = false;
      }
      // mode === 0 (Preview) -> keep looping; markers stay visible until the
      // next round, where they're cleared and redrawn fresh.
    } else {
      deletePreviewMarkers();
      revertAll();
      running = false;
    }
  }
}

try {
  main();
} catch (error) {
  app.alert(String(error && error.message ? error.message : error), "Centroid & Optical Center Finder");
}

module.exports.main = main;
