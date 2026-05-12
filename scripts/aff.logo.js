/**
 * name: Logo Construction Grid Generator
 * description: Creates editable orthogonal, angled, tangent, circular, node, and Bezier handle construction guides from selected logo/SVG vectors.
 * version: 1.1.0
 * author: Codex
 */

"use strict";

const { app } = require("/application");
const { Document } = require("/document");
const { Dialog, DialogResult } = require("/dialog");
const { UnitType } = require("/units");
const {
  AddChildNodesCommandBuilder,
  DocumentCommand,
  NodeChildType,
} = require("/commands");
const { ContainerNodeDefinition, PolyCurveNodeDefinition } = require("/nodes");
const { Selection } = require("/selections");
const { CurveBuilder, PolyCurve } = require("/geometry");
const { FillDescriptor } = require("/fills");
const { LineStyleDescriptor } = require("/linestyle");
const { RGBA8 } = require("/colours");
const { BlendMode } = require("affinity:common");

const GRID_GROUP_NAME = "Logo Construction Grid";
const PI = Math.PI;

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

function distance(a, b) {
  if (!validPoint(a) || !validPoint(b)) return Infinity;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function normalizeAngle(angle) {
  let out = angle % PI;
  if (out < 0) out += PI;
  return out;
}

function angleDistance(a, b) {
  const d = Math.abs(normalizeAngle(a) - normalizeAngle(b));
  return Math.min(d, PI - d);
}

function isAxisAngle(angle, toleranceRadians) {
  const a = normalizeAngle(angle);
  return (
    angleDistance(a, 0) <= toleranceRadians ||
    angleDistance(a, PI / 2) <= toleranceRadians
  );
}

function pointToSegmentDistance(point, a, b) {
  if (!validPoint(point) || !validPoint(a) || !validPoint(b)) return Infinity;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 0.000001) return distance(point, a);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lenSq));
  return distance(point, { x: a.x + dx * t, y: a.y + dy * t });
}

function cubicPoint(bezier, t) {
  const start = bezier.start;
  const end = bezier.end;
  const c1 = validPoint(bezier.c1) ? bezier.c1 : start;
  const c2 = validPoint(bezier.c2) ? bezier.c2 : end;
  const u = 1 - t;
  return {
    x:
      u * u * u * start.x +
      3 * u * u * t * c1.x +
      3 * u * t * t * c2.x +
      t * t * t * end.x,
    y:
      u * u * u * start.y +
      3 * u * u * t * c1.y +
      3 * u * t * t * c2.y +
      t * t * t * end.y,
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
    if (typeof node.getSpreadBaseBox === "function") {
      const box = node.getSpreadBaseBox(true);
      if (box) return box;
    }
  } catch (_) {}
  try {
    if (node.spreadVisibleBox) return node.spreadVisibleBox;
  } catch (_) {}
  try {
    if (node.baseBox) return node.baseBox;
  } catch (_) {}
  return null;
}

function addBoxToBounds(bounds, box) {
  if (!box || !isFiniteNumber(box.x) || !isFiniteNumber(box.y)) return bounds;
  if (!isFiniteNumber(box.width) || !isFiniteNumber(box.height)) return bounds;

  const left = box.x;
  const top = box.y;
  const right = box.x + box.width;
  const bottom = box.y + box.height;

  if (!bounds) {
    return { left, top, right, bottom };
  }

  bounds.left = Math.min(bounds.left, left);
  bounds.top = Math.min(bounds.top, top);
  bounds.right = Math.max(bounds.right, right);
  bounds.bottom = Math.max(bounds.bottom, bottom);
  return bounds;
}

function boundsToBox(bounds) {
  return {
    x: bounds.left,
    y: bounds.top,
    width: Math.max(0, bounds.right - bounds.left),
    height: Math.max(0, bounds.bottom - bounds.top),
  };
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

function hasChildren(node) {
  try {
    return node && node.children && asArray(node.children).length > 0;
  } catch (_) {
    return false;
  }
}

function isVectorCandidate(node) {
  if (!node) return false;
  try {
    if (node.isPolyCurveNode || node.isShapeNode) return true;
  } catch (_) {}
  try {
    if (node.isVectorNode && (node.polyCurve || node.curvesInterface)) return true;
  } catch (_) {}
  return false;
}

function walkSelectedTree(node, vectorNodes, allNodes) {
  if (!node) return;
  allNodes.push(node);
  if (isVectorCandidate(node)) vectorNodes.push(node);

  if (!hasChildren(node)) return;
  for (const child of asArray(node.children)) {
    walkSelectedTree(child, vectorNodes, allNodes);
  }
}

function deleteExistingGridGroups(doc, root) {
  const matches = [];

  function walk(node) {
    if (!node || !hasChildren(node)) return;
    for (const child of asArray(node.children)) {
      const name = String(child.userDescription || child.description || "");
      if (name === GRID_GROUP_NAME) matches.push(child);
      walk(child);
    }
  }

  walk(root);

  for (const node of matches) {
    try {
      doc.executeCommand(
        DocumentCommand.createDeleteSelection(Selection.create(doc, node), false),
      );
    } catch (_) {}
  }
}

function createGroup(doc, parent, name) {
  const builder = AddChildNodesCommandBuilder.create();
  if (parent && typeof builder.setInsertionTarget === "function") {
    builder.setInsertionTarget(parent);
  }
  const groupDef = ContainerNodeDefinition.create(name);
  builder.addContainerNode(groupDef);
  const command = builder.createCommand(false, NodeChildType.Main);
  doc.executeCommand(command);
  const node = command.newNodes && command.newNodes[0];
  if (node) {
    try {
      node.userDescription = name;
    } catch (_) {}
  }
  return node;
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

function addUniquePoint(points, point, tolerance) {
  if (!validPoint(point)) return;
  for (const existing of points) {
    if (distance(existing, point) <= tolerance) return;
  }
  points.push({ x: point.x, y: point.y });
}

function addUniqueSegment(segments, from, to, tolerance) {
  if (!validPoint(from) || !validPoint(to)) return;
  if (distance(from, to) <= tolerance) return;
  segments.push({
    from: { x: from.x, y: from.y },
    to: { x: to.x, y: to.y },
  });
}

function addAngleSeed(data, from, to, options, weightMultiplier) {
  if (!validPoint(from) || !validPoint(to)) return;
  const length = distance(from, to);
  if (length < options.minEdgeLength) return;
  const angle = normalizeAngle(Math.atan2(to.y - from.y, to.x - from.x));
  if (options.includeOrthogonal && isAxisAngle(angle, options.axisAngleSkipRadians)) return;

  data.angleSeeds.push({
    angle,
    point: { x: from.x, y: from.y },
    weight: Math.max(1, length * (weightMultiplier || 1)),
  });
}

function isStraightBezier(start, c1, c2, end, options) {
  const chord = distance(start, end);
  if (chord < options.minEdgeLength) return false;
  const tolerance = Math.max(options.tolerance * 2.5, chord * 0.015);
  const c1Distance = validPoint(c1) ? pointToSegmentDistance(c1, start, end) : 0;
  const c2Distance = validPoint(c2) ? pointToSegmentDistance(c2, start, end) : 0;
  return c1Distance <= tolerance && c2Distance <= tolerance;
}

function addPointToBounds(bounds, point) {
  if (!validPoint(point)) return bounds;
  if (!bounds) {
    return { left: point.x, top: point.y, right: point.x, bottom: point.y };
  }
  bounds.left = Math.min(bounds.left, point.x);
  bounds.top = Math.min(bounds.top, point.y);
  bounds.right = Math.max(bounds.right, point.x);
  bounds.bottom = Math.max(bounds.bottom, point.y);
  return bounds;
}

function detectCircleFromSamples(points, options) {
  if (!points || points.length < 12) return null;

  let bounds = null;
  for (const point of points) bounds = addPointToBounds(bounds, point);
  if (!bounds) return null;

  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const maxSide = Math.max(width, height);
  const minSide = Math.min(width, height);
  if (maxSide < options.minCircleRadius * 2) return null;
  if (minSide / maxSide < options.circleAspectThreshold) return null;

  const center = {
    x: (bounds.left + bounds.right) / 2,
    y: (bounds.top + bounds.bottom) / 2,
  };

  let sum = 0;
  let count = 0;
  for (const point of points) {
    const r = distance(center, point);
    if (isFiniteNumber(r)) {
      sum += r;
      count += 1;
    }
  }
  if (count === 0) return null;

  const radius = sum / count;
  if (radius < options.minCircleRadius) return null;

  let variance = 0;
  for (const point of points) {
    const r = distance(center, point);
    variance += Math.pow(r - radius, 2);
  }
  const normalizedStdDev = Math.sqrt(variance / count) / radius;
  if (normalizedStdDev > options.circleVarianceThreshold) return null;

  return { center, radius, weight: radius };
}

function collectCurveData(doc, node, data, options) {
  let converted = null;
  let temporary = false;

  try {
    if (node.isPolyCurveNode) {
      converted = node;
    } else {
      converted = convertTemporaryDuplicateToCurves(doc, node);
      temporary = true;
    }

    if (!converted || !converted.isPolyCurveNode) {
      const box = getNodeBox(node);
      if (box) {
        addUniquePoint(data.anchors, { x: box.x, y: box.y }, options.tolerance);
        addUniquePoint(data.anchors, { x: box.x + box.width, y: box.y }, options.tolerance);
        addUniquePoint(data.anchors, { x: box.x + box.width, y: box.y + box.height }, options.tolerance);
        addUniquePoint(data.anchors, { x: box.x, y: box.y + box.height }, options.tolerance);
      }
      return;
    }

    const context = getTransformContext(converted, options.tolerance);
    const curves = getCurves(converted);

    for (const curve of curves) {
      let usedBeziers = false;
      const curveSamples = [];
      try {
        for (const bezier of curve.beziers) {
          usedBeziers = true;
          const start = mapCurvePoint(bezier.start, context);
          const end = mapCurvePoint(bezier.end, context);
          const c1 = mapCurvePoint(bezier.c1, context);
          const c2 = mapCurvePoint(bezier.c2, context);

          for (let i = 0; i <= options.curveSampleSteps; i += 1) {
            curveSamples.push(mapCurvePoint(cubicPoint(bezier, i / options.curveSampleSteps), context));
          }

          if (options.includeAnchors) {
            addUniquePoint(data.anchors, start, options.tolerance);
            addUniquePoint(data.anchors, end, options.tolerance);
          }

          if (options.includeAngleGuides && isStraightBezier(start, c1, c2, end, options)) {
            addAngleSeed(data, start, end, options, 1);
          }

          if (options.includeTangentGuides) {
            addAngleSeed(data, start, c1, options, 0.45);
            addAngleSeed(data, end, c2, options, 0.45);
          }

          if (options.includeHandles) {
            if (distance(start, c1) > options.tolerance) {
              addUniquePoint(data.handles, c1, options.tolerance);
              addUniqueSegment(data.handleSegments, start, c1, options.tolerance);
            }
            if (distance(end, c2) > options.tolerance) {
              addUniquePoint(data.handles, c2, options.tolerance);
              addUniqueSegment(data.handleSegments, end, c2, options.tolerance);
            }
          }
        }
      } catch (_) {}

      if (!usedBeziers && options.includeAnchors) {
        try {
          const count = curve.points.length;
          for (let i = 0; i < count; i += 1) {
            const point = curve.getPoint(i);
            const mapped = mapCurvePoint(point, context);
            addUniquePoint(data.anchors, mapped, options.tolerance);
            curveSamples.push(mapped);
          }
        } catch (_) {}
      }

      if (options.includeCircularGuides) {
        try {
          if (curve.isClosed) {
            const circle = detectCircleFromSamples(curveSamples, options);
            if (circle) data.circles.push(circle);
          }
        } catch (_) {}
      }
    }
  } catch (error) {
    console.log("Could not read vector geometry: " + String(error));
  } finally {
    if (temporary) deleteTemporaryNode(doc, converted);
  }
}

function addNumber(values, value) {
  if (isFiniteNumber(value)) values.push(value);
}

function mergeNumbers(values, tolerance, maxCount) {
  const sorted = values.filter(isFiniteNumber).sort((a, b) => a - b);
  const merged = [];

  for (const value of sorted) {
    if (merged.length === 0 || Math.abs(value - merged[merged.length - 1]) > tolerance) {
      merged.push(value);
    } else {
      merged[merged.length - 1] = (merged[merged.length - 1] + value) / 2;
    }
  }

  if (!maxCount || merged.length <= maxCount) return merged;

  const thinned = [];
  const step = (merged.length - 1) / Math.max(1, maxCount - 1);
  for (let i = 0; i < maxCount; i += 1) {
    thinned.push(merged[Math.round(i * step)]);
  }
  return mergeNumbers(thinned, tolerance, 0);
}

function makeOpenPolyCurve(points) {
  const builder = CurveBuilder.create();
  builder.beginXY(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i += 1) {
    builder.lineToXY(points[i].x, points[i].y);
  }
  const poly = PolyCurve.create();
  poly.addCurve(builder.createCurve());
  return poly;
}

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

function makeLineDef(x1, y1, x2, y2, strokeFill, width) {
  return PolyCurveNodeDefinition.create(
    makeOpenPolyCurve([
      { x: x1, y: y1 },
      { x: x2, y: y2 },
    ]),
    noFill(),
    lineStyle(width),
    strokeFill,
    transparent,
  );
}

function makeSquareDef(cx, cy, size, brushFill, strokeFill, width) {
  const half = size / 2;
  return PolyCurveNodeDefinition.create(
    makeClosedPolyCurve([
      { x: cx - half, y: cy - half },
      { x: cx + half, y: cy - half },
      { x: cx + half, y: cy + half },
      { x: cx - half, y: cy + half },
    ]),
    brushFill,
    lineStyle(width),
    strokeFill || brushFill,
    transparent,
  );
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

function makeLineCandidate(angle, point, weight) {
  const normalized = normalizeAngle(angle);
  const nx = -Math.sin(normalized);
  const ny = Math.cos(normalized);
  return {
    angle: normalized,
    offset: nx * point.x + ny * point.y,
    weight: weight || 1,
  };
}

function addLineCandidate(candidates, angle, point, weight, options) {
  if (!validPoint(point)) return;
  if (options.includeOrthogonal && isAxisAngle(angle, options.axisAngleSkipRadians)) return;
  candidates.push(makeLineCandidate(angle, point, weight));
}

function mergeLineCandidates(candidates, options) {
  const clusters = [];

  for (const candidate of candidates) {
    let found = null;
    for (const cluster of clusters) {
      if (
        angleDistance(cluster.angle, candidate.angle) <= options.angleMergeRadians &&
        Math.abs(cluster.offset - candidate.offset) <= options.angleOffsetTolerance
      ) {
        found = cluster;
        break;
      }
    }

    if (!found) {
      found = {
        angle: candidate.angle,
        offset: candidate.offset,
        weight: 0,
        sumOffset: 0,
        sumCos: 0,
        sumSin: 0,
      };
      clusters.push(found);
    }

    found.weight += candidate.weight;
    found.sumOffset += candidate.offset * candidate.weight;
    found.sumCos += Math.cos(candidate.angle * 2) * candidate.weight;
    found.sumSin += Math.sin(candidate.angle * 2) * candidate.weight;
    found.angle = normalizeAngle(Math.atan2(found.sumSin, found.sumCos) / 2);
    found.offset = found.sumOffset / found.weight;
  }

  clusters.sort((a, b) => b.weight - a.weight);
  return clusters.slice(0, options.maxAngledGuides);
}

function lineEndpointsForBox(line, box, extend) {
  const dx = Math.cos(line.angle);
  const dy = Math.sin(line.angle);
  const nx = -dy;
  const ny = dx;
  const center = {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  };
  const correction = line.offset - (nx * center.x + ny * center.y);
  const point = {
    x: center.x + nx * correction,
    y: center.y + ny * correction,
  };
  const length = Math.hypot(box.width, box.height) + extend * 2 + 200;
  return {
    from: { x: point.x - dx * length, y: point.y - dy * length },
    to: { x: point.x + dx * length, y: point.y + dy * length },
  };
}

function clusterAngleFamilies(seeds, options) {
  const clusters = [];

  for (const seed of seeds) {
    let found = null;
    for (const cluster of clusters) {
      if (angleDistance(cluster.angle, seed.angle) <= options.angleFamilyRadians) {
        found = cluster;
        break;
      }
    }

    if (!found) {
      found = {
        angle: seed.angle,
        weight: 0,
        sumCos: 0,
        sumSin: 0,
      };
      clusters.push(found);
    }

    found.weight += seed.weight;
    found.sumCos += Math.cos(seed.angle * 2) * seed.weight;
    found.sumSin += Math.sin(seed.angle * 2) * seed.weight;
    found.angle = normalizeAngle(Math.atan2(found.sumSin, found.sumCos) / 2);
  }

  clusters.sort((a, b) => b.weight - a.weight);
  return clusters.slice(0, options.maxAngleFamilies);
}

function mergeCircleCandidates(circles, options) {
  const centers = [];
  const centerTolerance = Math.max(options.tolerance * 6, options.markerSize);

  for (const circle of circles) {
    let found = null;
    for (const center of centers) {
      if (distance(center.center, circle.center) <= centerTolerance) {
        found = center;
        break;
      }
    }

    if (!found) {
      found = {
        center: { x: circle.center.x, y: circle.center.y },
        weight: 0,
        sumX: 0,
        sumY: 0,
        radii: [],
      };
      centers.push(found);
    }

    found.weight += circle.weight;
    found.sumX += circle.center.x * circle.weight;
    found.sumY += circle.center.y * circle.weight;
    found.center = { x: found.sumX / found.weight, y: found.sumY / found.weight };
    found.radii.push(circle.radius);
  }

  centers.sort((a, b) => b.weight - a.weight);
  return centers.slice(0, options.maxCircleCenters);
}

function addCircularGuides(defs, data, box, circleFill, blackFill, options) {
  const centers = mergeCircleCandidates(data.circles, options);
  let circleCount = 0;

  for (const centerInfo of centers) {
    const radii = centerInfo.radii.slice();
    if (options.projectCirclesThroughAnchors) {
      const points = data.anchors.concat(data.handles);
      const maxRadius = Math.hypot(box.width, box.height) + options.extend;
      for (const point of points) {
        const radius = distance(centerInfo.center, point);
        if (radius >= options.minCircleRadius && radius <= maxRadius) {
          radii.push(radius);
        }
      }
    }

    const mergedRadii = mergeNumbers(
      radii,
      Math.max(options.tolerance * 3, 2),
      options.maxCirclesPerCenter,
    );

    for (const radius of mergedRadii) {
      defs.push(
        makeCircleDef(
          centerInfo.center.x,
          centerInfo.center.y,
          radius,
          noFill(),
          circleFill,
          options.circleLineWidth,
        ),
      );
      circleCount += 1;
    }

    defs.push(
      makeCircleDef(
        centerInfo.center.x,
        centerInfo.center.y,
        Math.max(1.5, options.markerSize * 0.3),
        blackFill,
        blackFill,
        options.markerStrokeWidth,
      ),
    );
  }

  return circleCount;
}

function addDefinitions(doc, target, defs) {
  if (!defs.length) return [];
  const builder = AddChildNodesCommandBuilder.create();
  builder.setInsertionTarget(target);
  for (const def of defs) builder.addNode(def);
  const command = builder.createCommand(true, NodeChildType.Main);
  doc.executeCommand(command);
  return asArray(command.newNodes);
}

function buildGrid(doc, sourceNodes, allNodes, options) {
  let bounds = null;
  for (const node of allNodes) {
    bounds = addBoxToBounds(bounds, getNodeBox(node));
  }

  if (!bounds) {
    throw new Error("Could not read bounds from the selected logo.");
  }

  const box = boundsToBox(bounds);
  const data = {
    anchors: [],
    handles: [],
    handleSegments: [],
    angleSeeds: [],
    circles: [],
  };

  if (options.includeBounds) {
    addUniquePoint(data.anchors, { x: box.x, y: box.y }, options.tolerance);
    addUniquePoint(data.anchors, { x: box.x + box.width, y: box.y }, options.tolerance);
    addUniquePoint(data.anchors, { x: box.x + box.width, y: box.y + box.height }, options.tolerance);
    addUniquePoint(data.anchors, { x: box.x, y: box.y + box.height }, options.tolerance);
    addUniquePoint(
      data.anchors,
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      options.tolerance,
    );
  }

  for (const node of sourceNodes) {
    collectCurveData(doc, node, data, options);
  }

  const xValues = [];
  const yValues = [];

  if (options.includeBounds) {
    addNumber(xValues, box.x);
    addNumber(xValues, box.x + box.width / 2);
    addNumber(xValues, box.x + box.width);
    addNumber(yValues, box.y);
    addNumber(yValues, box.y + box.height / 2);
    addNumber(yValues, box.y + box.height);
  }

  for (const point of data.anchors) {
    addNumber(xValues, point.x);
    addNumber(yValues, point.y);
  }
  if (options.includeHandles) {
    for (const point of data.handles) {
      addNumber(xValues, point.x);
      addNumber(yValues, point.y);
    }
  }

  const xs = mergeNumbers(xValues, options.tolerance, options.maxGuidesPerAxis);
  const ys = mergeNumbers(yValues, options.tolerance, options.maxGuidesPerAxis);

  const left = box.x - options.extend;
  const right = box.x + box.width + options.extend;
  const top = box.y - options.extend;
  const bottom = box.y + box.height + options.extend;

  const gridFill = solid(0, 174, 239, 255);
  const angleFill = solid(0, 0, 0, 205);
  const circleFill = solid(0, 0, 0, 150);
  const markerFill = solid(0, 160, 220, 255);
  const blackFill = solid(0, 0, 0, 255);
  const defs = [];

  if (options.includeHandles) {
    for (const segment of data.handleSegments) {
      defs.push(
        makeLineDef(
          segment.from.x,
          segment.from.y,
          segment.to.x,
          segment.to.y,
          blackFill,
          options.handleLineWidth,
        ),
      );
    }
  }

  if (options.includeOrthogonal) {
    for (const x of xs) {
      defs.push(makeLineDef(x, top, x, bottom, gridFill, options.gridLineWidth));
    }
    for (const y of ys) {
      defs.push(makeLineDef(left, y, right, y, gridFill, options.gridLineWidth));
    }
  }

  let angledCount = 0;
  if (options.includeAngleGuides) {
    const angleCandidates = [];

    if (options.includeDirectEdgeGuides) {
      for (const seed of data.angleSeeds) {
        addLineCandidate(angleCandidates, seed.angle, seed.point, seed.weight, options);
      }
    }

    if (options.projectAnglesThroughAnchors) {
      const families = clusterAngleFamilies(data.angleSeeds, options);
      const projectionPoints = data.anchors.length > 0 ? data.anchors : data.handles;
      for (const family of families) {
        for (const point of projectionPoints) {
          addLineCandidate(angleCandidates, family.angle, point, family.weight, options);
        }
      }
    }

    const angledLines = mergeLineCandidates(angleCandidates, options);
    for (const line of angledLines) {
      const endpoints = lineEndpointsForBox(line, box, options.extend);
      defs.push(
        makeLineDef(
          endpoints.from.x,
          endpoints.from.y,
          endpoints.to.x,
          endpoints.to.y,
          angleFill,
          options.angleLineWidth,
        ),
      );
    }
    angledCount = angledLines.length;
  }

  let circleCount = 0;
  if (options.includeCircularGuides) {
    circleCount = addCircularGuides(defs, data, box, circleFill, blackFill, options);
  }

  if (options.includeAnchors) {
    for (const point of data.anchors) {
      defs.push(
        makeSquareDef(
          point.x,
          point.y,
          options.markerSize,
          markerFill,
          blackFill,
          options.markerStrokeWidth,
        ),
      );
    }
  }

  if (options.includeHandles) {
    for (const point of data.handles) {
      defs.push(
        makeCircleDef(
          point.x,
          point.y,
          Math.max(1.5, options.markerSize * 0.35),
          blackFill,
          blackFill,
          options.markerStrokeWidth,
        ),
      );
    }
  }

  return {
    defs,
    box,
    verticalCount: options.includeOrthogonal ? xs.length : 0,
    horizontalCount: options.includeOrthogonal ? ys.length : 0,
    angledCount,
    circleCount,
    anchorCount: data.anchors.length,
    handleCount: data.handles.length,
  };
}

function readOptionsFromDialog() {
  const dialog = Dialog.create("Logo Construction Grid");
  dialog.initialWidth = 420;
  const col = dialog.addColumn();

  const guideGroup = col.addGroup("Guide systems");
  const orthogonalCtrl = guideGroup.addSwitch("Horizontal/vertical from nodes", true);
  const angledCtrl = guideGroup.addSwitch("Angled edge guides", true);
  const angleProjectCtrl = guideGroup.addSwitch("Project angle families through nodes", true);
  const tangentCtrl = guideGroup.addSwitch("Use Bezier tangents for angles", true);
  const circleCtrl = guideGroup.addSwitch("Concentric circle guides", true);

  const measureGroup = col.addGroup("Guide range");
  const extendCtrl = measureGroup.addUnitValueEditor(
    "Extend past logo",
    UnitType.Pixel,
    UnitType.Pixel,
    160,
    0,
    2000,
  );
  const toleranceCtrl = measureGroup.addUnitValueEditor(
    "Merge tolerance",
    UnitType.Pixel,
    UnitType.Pixel,
    1,
    0,
    20,
  );
  const maxGuidesCtrl = measureGroup.addUnitValueEditor(
    "Max straight guides",
    UnitType.Number,
    UnitType.Number,
    180,
    10,
    500,
  );
  maxGuidesCtrl.precision = 0;
  const angleFamiliesCtrl = measureGroup.addUnitValueEditor(
    "Max angle families",
    UnitType.Number,
    UnitType.Number,
    6,
    1,
    24,
  );
  angleFamiliesCtrl.precision = 0;
  const circlesCtrl = measureGroup.addUnitValueEditor(
    "Max circles per center",
    UnitType.Number,
    UnitType.Number,
    18,
    1,
    80,
  );
  circlesCtrl.precision = 0;

  const detailGroup = col.addGroup("Details");
  const boundsCtrl = detailGroup.addSwitch("Include bounds and center", true);
  const anchorsCtrl = detailGroup.addSwitch("Include vector anchors", true);
  const handlesCtrl = detailGroup.addSwitch("Include Bezier handles", true);

  const styleGroup = col.addGroup("Style");
  const gridWidthCtrl = styleGroup.addUnitValueEditor(
    "Grid line width",
    UnitType.Pixel,
    UnitType.Pixel,
    0.5,
    0.1,
    20,
  );
  const handleWidthCtrl = styleGroup.addUnitValueEditor(
    "Handle line width",
    UnitType.Pixel,
    UnitType.Pixel,
    0.8,
    0.1,
    20,
  );
  const angleWidthCtrl = styleGroup.addUnitValueEditor(
    "Angled line width",
    UnitType.Pixel,
    UnitType.Pixel,
    0.65,
    0.1,
    20,
  );
  const circleWidthCtrl = styleGroup.addUnitValueEditor(
    "Circle line width",
    UnitType.Pixel,
    UnitType.Pixel,
    0.55,
    0.1,
    20,
  );
  const markerSizeCtrl = styleGroup.addUnitValueEditor(
    "Node marker size",
    UnitType.Pixel,
    UnitType.Pixel,
    7,
    1,
    80,
  );

  const result = dialog.runModal();
  if (result.value !== DialogResult.Ok.value) return null;

  return {
    extend: Math.max(0, extendCtrl.value),
    tolerance: Math.max(0.01, toleranceCtrl.value),
    includeOrthogonal: Boolean(orthogonalCtrl.value),
    includeAngleGuides: Boolean(angledCtrl.value),
    includeDirectEdgeGuides: Boolean(angledCtrl.value),
    projectAnglesThroughAnchors: Boolean(angleProjectCtrl.value),
    includeTangentGuides: Boolean(tangentCtrl.value),
    includeCircularGuides: Boolean(circleCtrl.value),
    projectCirclesThroughAnchors: true,
    maxGuidesPerAxis: Math.max(10, Math.round(maxGuidesCtrl.value)),
    maxAngledGuides: Math.max(10, Math.round(maxGuidesCtrl.value)),
    maxAngleFamilies: Math.max(1, Math.round(angleFamiliesCtrl.value)),
    maxCirclesPerCenter: Math.max(1, Math.round(circlesCtrl.value)),
    maxCircleCenters: 12,
    includeBounds: Boolean(boundsCtrl.value),
    includeAnchors: Boolean(anchorsCtrl.value),
    includeHandles: Boolean(handlesCtrl.value),
    gridLineWidth: Math.max(0.1, gridWidthCtrl.value),
    handleLineWidth: Math.max(0.1, handleWidthCtrl.value),
    angleLineWidth: Math.max(0.1, angleWidthCtrl.value),
    circleLineWidth: Math.max(0.1, circleWidthCtrl.value),
    markerSize: Math.max(1, markerSizeCtrl.value),
    markerStrokeWidth: 0.6,
    minEdgeLength: Math.max(4, markerSizeCtrl.value * 1.25),
    minCircleRadius: Math.max(8, markerSizeCtrl.value * 1.5),
    curveSampleSteps: 8,
    axisAngleSkipRadians: (2 * PI) / 180,
    angleMergeRadians: (1.5 * PI) / 180,
    angleFamilyRadians: (4 * PI) / 180,
    angleOffsetTolerance: Math.max(2, toleranceCtrl.value * 4),
    circleAspectThreshold: 0.72,
    circleVarianceThreshold: 0.18,
  };
}

function main() {
  const doc = Document.current;
  if (!doc) {
    app.alert("Open a document before running this script.", GRID_GROUP_NAME);
    return;
  }

  const selected = getSelectedNodes(doc);
  if (selected.length === 0) {
    app.alert(
      "Select your imported SVG/logo layer or group, then run the script again.",
      GRID_GROUP_NAME,
    );
    return;
  }

  const options = readOptionsFromDialog();
  if (!options) return;

  const vectorNodes = [];
  const allNodes = [];
  for (const node of selected) {
    walkSelectedTree(node, vectorNodes, allNodes);
  }

  if (allNodes.length === 0) {
    app.alert("The current selection does not contain readable layers.", GRID_GROUP_NAME);
    return;
  }

  const spread = doc.currentSpread || doc.spreads.first;
  deleteExistingGridGroups(doc, doc.rootNode || spread);

  const group = createGroup(doc, spread, GRID_GROUP_NAME);
  if (!group) {
    throw new Error("Could not create the construction grid group.");
  }

  const grid = buildGrid(doc, vectorNodes, allNodes, options);
  addDefinitions(doc, group, grid.defs);

  try {
    doc.executeCommand(DocumentCommand.createSetSelection(group.selfSelection));
  } catch (_) {}

  app.alert(
    [
      "Construction grid created.",
      "",
      "Vertical guides: " + grid.verticalCount,
      "Horizontal guides: " + grid.horizontalCount,
      "Angled guides: " + grid.angledCount,
      "Circle guides: " + grid.circleCount,
      "Anchor markers: " + grid.anchorCount,
      "Bezier handles: " + grid.handleCount,
    ].join("\n"),
    GRID_GROUP_NAME,
  );
}

module.exports.main = main;

try {
  main();
} catch (error) {
  app.alert(String(error && error.message ? error.message : error), GRID_GROUP_NAME);
}
