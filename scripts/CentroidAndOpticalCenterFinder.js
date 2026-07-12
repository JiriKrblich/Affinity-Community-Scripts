/**
 * name: Centroid & Optical Center Finder
 * description: Calculates and draws the mathematical centroid (Red) and the visual/optical center (Blue) for selected shapes. https://bjango.com/articles/opticaladjustments/
 * version: 1.2.0
 * author: CrackHub
 * @affinity 3.2+
 * - Once the points are created, the objects remain selected; you can group them using Ctrl+G if you wish.
 * - Multiple selection allowed
 */

"use strict";

const { app } = require("/application");
const { Document } = require("/document");
const { AddChildNodesCommandBuilder, DocumentCommand, NodeChildType } = require("/commands");
const { PolyCurveNodeDefinition } = require("/nodes");
const { Selection } = require("/selections");
const { CurveBuilder, PolyCurve } = require("/geometry");
const { FillDescriptor } = require("/fills");
const { LineStyleDescriptor } = require("/linestyle");
const { RGBA8 } = require("/colours");
const { BlendMode } = require("affinity:common");

const PI = Math.PI;

// Color and Style Helpers
function solid(r, g, b, a) {
  return FillDescriptor.createSolid(
    RGBA8(r, g, b, a == null ? 255 : a),
    BlendMode.Normal,
  );
}

function noFill() {
  return FillDescriptor.createNone();
}

function lineStyle(width) {
  return LineStyleDescriptor.createDefault(width);
}

const transparent = noFill();

// Array and Value Validation Helpers
function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value.toArray === "function") return value.toArray();
  return Array.from(value);
}

// Coordinate Transformation Helpers
function isFiniteNumber(value) {
  return typeof value === "number" && isFinite(value);
}

function validPoint(point) {
  return point && isFiniteNumber(point.x) && isFiniteNumber(point.y);
}

function distance(a, b) {
  if (!validPoint(a) || !validPoint(b)) return Infinity;
  return Math.hypot(a.x - b.x, a.y - b.y);
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

  // Decompose fallback for complex transformations
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

// Selection and Node Tree Helpers
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
    doc.executeCommand(
      DocumentCommand.createDeleteSelection(Selection.create(doc, node), false),
    );
  } catch (_) {}
}

// Paul Bourke Polygon Area & Centroid Formulas
function calculatePolygonCentroid(points) {
  if (points.length < 3) return null;

  const closedPoints = points.slice();
  if (closedPoints[0].x !== closedPoints[closedPoints.length - 1].x || closedPoints[0].y !== closedPoints[closedPoints.length - 1].y) {
    closedPoints.push(closedPoints[0]);
  }

  let area = 0;
  let cx = 0;
  let cy = 0;

  for (let i = 0; i < closedPoints.length - 1; i++) {
    const p1 = closedPoints[i];
    const p2 = closedPoints[i + 1];
    const factor = (p1.x * p2.y) - (p2.x * p1.y);

    area += factor;
    cx += (p1.x + p2.x) * factor;
    cy += (p1.y + p2.y) * factor;
  }

  area /= 2;
  if (Math.abs(area) < 1e-5) return null;

  return {
    cx: cx / (6 * area),
    cy: cy / (6 * area),
    area: Math.abs(area)
  };
}

// Custom Geometry Generation for Visual Markers
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

// Main Execution
function main() {
  const doc = Document.current;
  if (!doc) {
    app.alert("Please open an active document.", "Centroid Finder");
    return;
  }

  const selected = getSelectedNodes(doc);
  if (selected.length === 0) {
    app.alert("Please select at least one object.", "Centroid Finder");
    return;
  }

  const spread = doc.currentSpread || doc.spreads.first;
  const holeDiameter = 9; // Visual marker diameter (px)
  const tolerance = 0.5;
  let processedCount = 0;
  const nodesToSelectAtEnd = []; // Collects node + its markers here; all left selected at the end

  for (const node of selected) {
    let converted = null;
    let temporary = false;
    let finalCx = null;
    let finalCy = null;
    let bboxCx = null;
    let bboxCy = null;
    let shapeHeight = 0;

    // Grab correct bounding box dimensions for optical mapping
    const box = getNodeBox(node);
    if (box) {
      bboxCx = box.x + box.width / 2;
      bboxCy = box.y + box.height / 2;
      shapeHeight = box.height;
    }

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
          // Fallback midpoint for open curves with zero area
          let sumX = 0, sumY = 0;
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

    // Fallback to bounding box center if centroid calculation fails
    if (finalCx === null || finalCy === null) {
      finalCx = bboxCx;
      finalCy = bboxCy;
    }

    // --- OPTICAL (PERCEPTUAL) ALIGNMENT FORMULA ---
    let opticalCx = (0.6 * finalCx) + (0.4 * bboxCx);
    let opticalCy = (0.6 * finalCy) + (0.4 * bboxCy);

    // Symmetry Check: If mathematical centroid and bounding box center are virtually identical
    // (perfect circles, squares, etc.), we bypass the vertical gravity offset.
    const isSymmetric = Math.hypot(finalCx - bboxCx, finalCy - bboxCy) < 1.0;

    if (!isSymmetric && shapeHeight > 0) {
      // Apply the aesthetic vertical upward shift (1.5% of height) to prevent sagging illusions only on asymmetric shapes
      opticalCy -= (shapeHeight * 0.015);
    }

    // Prepare marker definitions for this selected object
    const nodeDefs = [];

    // 🔴 1. Mathematical Centroid Marker - RED
    const markerFillRed = solid(255, 0, 0, 255);
    const markerStroke = solid(0, 0, 0, 255);
    nodeDefs.push(
      makeCircleDef(
        finalCx,
        finalCy,
        holeDiameter / 2,
        markerFillRed,
        markerStroke,
        0.6
      )
    );

    // 🔵 2. Optical Visual Center Marker - BLUE
    const markerFillBlue = solid(0, 162, 232, 255);
    nodeDefs.push(
      makeCircleDef(
        opticalCx,
        opticalCy,
        holeDiameter / 2,
        markerFillBlue,
        markerStroke,
        0.6
      )
    );

    // Add markers to the node's PARENT (as a sibling) - adding them to the node
    // itself would turn it into a clip/mask, so we add to the parent instead.
    if (nodeDefs.length > 0) {
      let insertedOk = false;
      let markerNodes = [];

      // The node's own container (parent) - fall back to the spread if not found
      let parentContainer = null;
      try {
        parentContainer = node.parent || null;
      } catch (_) {}
      if (!parentContainer) parentContainer = spread;

      // --- STEP 1: INSERTION only. ---
      // IMPORTANT: we use setInsertionTarget(parentContainer) INSTEAD OF
      // setInsertionTarget(node). Targeting the node itself makes the markers
      // its CHILDREN, and the node's own path then clips/masks them (this was
      // the cause of the markers appearing "inside" the object as a mask).
      // Adding them as siblings of the parent removes this clipping behavior.
      try {
        const builder = AddChildNodesCommandBuilder.create();
        builder.setInsertionTarget(parentContainer);

        for (const def of nodeDefs) {
          builder.addNode(def);
        }

        // "false" -> places the new nodes at the END of the list (on top, z-order)
        const command = builder.createCommand(false, NodeChildType.Main);
        doc.executeCommand(command);

        // Grab the marker nodes (red + blue) we just added
        markerNodes = asArray(command.newNodes);
        insertedOk = true;
      } catch (e) {
        // Adding to the parent failed; fall back to adding directly to the spread
        try {
          const builder = AddChildNodesCommandBuilder.create();
          builder.setInsertionTarget(spread);
          for (const def of nodeDefs) {
            builder.addNode(def);
          }
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

        // Grouping is not done from the script (the Affinity scripting API has
        // no real "create Group" command - confirmed by checking nodes.js,
        // commands.js, document.js, and selections.js). Instead we add the
        // object + its markers to the selection list; everything will remain
        // selected when the script finishes, so you can group it yourself with Ctrl+G.
        nodesToSelectAtEnd.push(node, ...markerNodes);
      }
    }
  }

  // At the end of the script: leave all created object+marker sets selected
  if (nodesToSelectAtEnd.length > 0) {
    try {
      doc.selection = nodesToSelectAtEnd;
    } catch (selErr) {
      // If selection can't be set, fail silently; the objects still exist in the document.
    }
  }

  if (processedCount === 0) {
    app.alert("Could not calculate the centroid for the selected objects.", "Centroid Finder");
  }
}

module.exports.main = main;

try {
  main();
} catch (error) {
  app.alert(String(error && error.message ? error.message : error), "Centroid Finder");
}
