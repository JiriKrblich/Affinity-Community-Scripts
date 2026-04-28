"use strict";

const { app } = require("/application");
const { Dialog, DialogResult } = require("/dialog");
const { Document } = require("/document");
const {
  AddChildNodesCommandBuilder,
  DocumentCommand,
  NodeChildType,
  NodeMoveType,
} = require("/commands");
const { ContainerNodeDefinition } = require("/nodes");
const { Selection } = require("/selections");
const { Transform } = require("/geometry");

const TARGET_LAYER_NAME = "target";
const INSERTION_METHODS = ["path", "nodes", "center", "corners"];
const PATH_INSERTION_METHOD_INDEX = INSERTION_METHODS.indexOf("path");
const DUPLICATE_LAYER_NAMES = {
  center: "center symbol",
  corners: "corner symbol",
  nodes: "node symbol",
  path: "path symbol",
};
const GROUP_LAYER_NAMES = {
  center: "center symbols",
  corners: "corner symbols",
  nodes: "node symbols",
  path: "path symbols",
};
const DEFAULT_PATH_SYMBOL_COUNT = 10;
const PATH_SYMBOL_COUNT_OPTIONS = Array.from({ length: 100 }, (_, index) =>
  String(index + 1),
);

function getNodeBox(node) {
  return (
    node.exactSpreadBaseBox ||
    node.getSpreadBaseBox(true) ||
    node.spreadVisibleBox
  );
}

function getNodeCenter(node) {
  const box = getNodeBox(node);
  if (!box) {
    throw new Error(
      'Could not read bounds for layer "' + node.description + '".',
    );
  }

  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  };
}

function getBoxCorners(node) {
  const box = getNodeBox(node);
  if (!box) {
    throw new Error(
      'Could not read bounds for layer "' + node.description + '".',
    );
  }

  return [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ];
}

function getLayerName(node) {
  return (node.userDescription || node.description || "").trim();
}

function findTargetLayers(doc, targetLayerName) {
  const targetLayers = [];
  for (const node of doc.layers.all) {
    if (getLayerName(node) === targetLayerName) {
      targetLayers.push(node);
    }
  }
  return targetLayers;
}

function getTargetLayerNameOptions(doc) {
  const names = [TARGET_LAYER_NAME];
  for (const node of doc.layers.all) {
    const name = getLayerName(node);
    if (name && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

function duplicateNodeAtCenter(node, sourceCenter, targetCenter) {
  const dx = targetCenter.x - sourceCenter.x;
  const dy = targetCenter.y - sourceCenter.y;
  return node.duplicate(Transform.createTranslate(dx, dy));
}

function rotateNodeAroundCenter(node, angle) {
  if (Math.abs(angle) < 0.000001) {
    return;
  }

  const center = getNodeCenter(node);
  const transform = Transform.createTranslate(center.x, center.y)
    .multiply(Transform.createRotate(angle))
    .multiply(Transform.createTranslate(-center.x, -center.y));
  const selection = Selection.create(node.document, node);
  const command = DocumentCommand.createTransform(selection, transform);
  node.document.executeCommand(command);
}

function duplicateNodeAtPlacement(node, sourceCenter, placement) {
  return duplicateNodeAtCenter(node, sourceCenter, placement);
}

function getTransformMatrix(transform) {
  const text = String(transform);
  const match = text.match(
    /\[\[([^,\]]+),([^,\]]+),([^\]]+)\]\s*\[([^,\]]+),([^,\]]+),([^\]]+)\]\]/,
  );
  if (!match) {
    return null;
  }

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
  const matrix = getTransformMatrix(transform);
  if (matrix) {
    return {
      x: matrix.a * point.x + matrix.b * point.y + matrix.c,
      y: matrix.d * point.x + matrix.e * point.y + matrix.f,
    };
  }

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

function getPointBounds(points) {
  if (points.length === 0) {
    return null;
  }

  let minX = points[0].x;
  let minY = points[0].y;
  let maxX = points[0].x;
  let maxY = points[0].y;

  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function boxesAreClose(a, b) {
  if (!a || !b) {
    return false;
  }

  const tolerance = 0.5;
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  );
}

function pointsAreClose(a, b) {
  const tolerance = 0.5;
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;
}

function removeSyntheticShapeCenterPoint(node, points) {
  if (!node.isShapeNode || points.length <= 1) {
    return points;
  }

  const center = getNodeCenter(node);
  return points.filter((point) => !pointsAreClose(point, center));
}

function getCurveOnPathPoints(curve) {
  const points = [];
  const count = curve.points.length;
  if (count === 0) {
    return points;
  }

  let index = curve.firstOnCurvePointIndex;
  const last = curve.lastOnCurvePointIndex;
  const seen = {};

  for (
    let guard = 0;
    guard < count && index != null && !seen[index];
    guard += 1
  ) {
    seen[index] = true;
    const point = curve.getPoint(index);
    points.push({ x: point.x, y: point.y });

    if (index === last) {
      break;
    }

    index = curve.getNextOnCurvePointIndex(index, true);
  }

  return points;
}

function getPolyCurvePoints(polyCurve) {
  const points = [];
  for (const curve of polyCurve) {
    points.push(...getCurveOnPathPoints(curve));
  }
  return points;
}

function getPolyPolyCurvePoints(polyPolyCurve) {
  const points = [];
  for (let i = 0; i < polyPolyCurve.polyCurveCount; i += 1) {
    points.push(
      ...getPolyCurvePoints(polyPolyCurve.getTransformedPolyCurve(i)),
    );
  }
  return points;
}

function getPolyPolyCurves(polyPolyCurve) {
  const curves = [];
  for (let i = 0; i < polyPolyCurve.polyCurveCount; i += 1) {
    for (const curve of polyPolyCurve.getTransformedPolyCurve(i)) {
      curves.push(curve);
    }
  }
  return curves;
}

function getConvertedVectorCurves(converted) {
  const curves = getPolyPolyCurves(converted.curvesInterface.polyPolyCurves);
  if (curves.length > 0) {
    return curves;
  }

  for (const curve of converted.polyCurve) {
    curves.push(curve);
  }
  return curves;
}

function getCurveBeziers(curve) {
  const beziers = [];
  for (const bezier of curve.beziers) {
    beziers.push(bezier);
  }
  return beziers;
}

function getBezierPointAtLength(bezier, length) {
  if (length <= 0) {
    return { x: bezier.start.x, y: bezier.start.y };
  }

  if (length >= bezier.length) {
    return { x: bezier.end.x, y: bezier.end.y };
  }

  const t = bezier.getParamAtLength(length);
  return bezier.split(t).left.end;
}

function getPointAtPathLength(beziers, length) {
  let remaining = length;

  for (const bezier of beziers) {
    if (remaining <= bezier.length) {
      return getBezierPointAtLength(bezier, remaining);
    }
    remaining -= bezier.length;
  }

  const last = beziers[beziers.length - 1];
  return { x: last.end.x, y: last.end.y };
}

function getPointAtNormalizedPathLength(beziers, length, pathLength, closed) {
  if (closed) {
    let normalized = length % pathLength;
    if (normalized < 0) {
      normalized += pathLength;
    }
    return getPointAtPathLength(beziers, normalized);
  }

  return getPointAtPathLength(
    beziers,
    Math.max(0, Math.min(pathLength, length)),
  );
}

function getPathCentroid(points) {
  const bounds = getPointBounds(points);
  if (!bounds) {
    return { x: 0, y: 0 };
  }

  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
}

function normalAngleFromSamples(point, before, after, centroid) {
  const tangentX = after.x - before.x;
  const tangentY = after.y - before.y;
  if (Math.abs(tangentX) < 0.000001 && Math.abs(tangentY) < 0.000001) {
    return 0;
  }

  let normalX = -tangentY;
  let normalY = tangentX;
  const outwardX = point.x - centroid.x;
  const outwardY = point.y - centroid.y;

  if (normalX * outwardX + normalY * outwardY < 0) {
    normalX = -normalX;
    normalY = -normalY;
  }

  return Math.atan2(normalY, normalX);
}

function removeDuplicatePoints(points) {
  const unique = [];
  for (const point of points) {
    if (!unique.some((existing) => pointsAreClose(existing, point))) {
      unique.push(point);
    }
  }
  return unique;
}

function removeDuplicatePlacements(placements) {
  const unique = [];
  for (const placement of placements) {
    if (!unique.some((existing) => pointsAreClose(existing, placement))) {
      unique.push(placement);
    }
  }
  return unique;
}

function convertTemporaryDuplicateToCurves(doc, node) {
  const temp = node.duplicate();
  const selection = Selection.create(doc, temp);
  const command = DocumentCommand.createConvertToCurves(selection);
  doc.executeCommand(command);

  const candidates = [
    command.newNodes[0],
    doc.selection.firstNode,
    doc.layers.first,
    temp,
  ].filter((candidate) => candidate);

  for (const candidate of candidates) {
    if (candidate.isPolyCurveNode) {
      return candidate;
    }
  }

  return candidates[0];
}

function getVectorNodePoints(node) {
  const doc = node.document;
  let converted = null;

  try {
    converted = node.isPolyCurveNode
      ? node
      : convertTemporaryDuplicateToCurves(doc, node);

    if (!converted.isPolyCurveNode) {
      return [getNodeCenter(node)];
    }

    let rawPoints = getPolyPolyCurvePoints(
      converted.curvesInterface.polyPolyCurves,
    );
    if (rawPoints.length === 0) {
      rawPoints = getPolyCurvePoints(converted.polyCurve);
    }

    if (rawPoints.length === 0) {
      return [getNodeCenter(node)];
    }

    const spreadBox = getNodeBox(converted);
    const rawGeometryBox =
      converted.curvesInterface.polyPolyCurves.exactBoundingBox ||
      converted.polyCurve.exactBoundingBox;
    const spreadPoints = boxesAreClose(rawGeometryBox, spreadBox)
      ? rawPoints
      : rawPoints.map((point) =>
          transformPoint(point, converted.curvesInterface.domainTransform),
        );

    return removeDuplicatePoints(
      removeSyntheticShapeCenterPoint(node, spreadPoints),
    );
  } catch (error) {
    console.log(
      'Could not read nodes for "' + getLayerName(node) + '": ' + String(error),
    );
    return [getNodeCenter(node)];
  } finally {
    if (!node.isPolyCurveNode && converted) {
      try {
        converted.delete();
      } catch (error) {
        console.log(
          'Could not remove temporary node for "' +
            getLayerName(node) +
            '": ' +
            String(error),
        );
      }
    }
  }
}

function getVectorPathIntervalPoints(node, count) {
  const doc = node.document;
  let converted = null;

  try {
    converted = node.isPolyCurveNode
      ? node
      : convertTemporaryDuplicateToCurves(doc, node);

    if (!converted.isPolyCurveNode) {
      return [getNodeCenter(node)];
    }

    const beziers = [];
    for (const curve of getConvertedVectorCurves(converted)) {
      beziers.push(...getCurveBeziers(curve));
    }

    if (beziers.length === 0) {
      return [getNodeCenter(node)];
    }

    const pathLength = beziers.reduce((sum, bezier) => sum + bezier.length, 0);
    if (pathLength <= 0) {
      return [getNodeCenter(node)];
    }

    const interval = pathLength / count;
    const rawPoints = [];
    for (let i = 0; i < count; i += 1) {
      rawPoints.push(getPointAtPathLength(beziers, interval * i));
    }

    const spreadBox = getNodeBox(converted);
    const rawGeometryBox =
      converted.curvesInterface.polyPolyCurves.exactBoundingBox ||
      converted.polyCurve.exactBoundingBox;
    const spreadPoints = boxesAreClose(rawGeometryBox, spreadBox)
      ? rawPoints
      : rawPoints.map((point) =>
          transformPoint(point, converted.curvesInterface.domainTransform),
        );

    return removeDuplicatePoints(
      removeSyntheticShapeCenterPoint(node, spreadPoints),
    );
  } catch (error) {
    console.log(
      'Could not read path intervals for "' +
        getLayerName(node) +
        '": ' +
        String(error),
    );
    return [getNodeCenter(node)];
  } finally {
    if (!node.isPolyCurveNode && converted) {
      try {
        converted.delete();
      } catch (error) {
        console.log(
          'Could not remove temporary node for "' +
            getLayerName(node) +
            '": ' +
            String(error),
        );
      }
    }
  }
}

function getVectorPathIntervalPlacements(node, count) {
  const doc = node.document;
  let converted = null;

  try {
    converted = node.isPolyCurveNode
      ? node
      : convertTemporaryDuplicateToCurves(doc, node);

    if (!converted.isPolyCurveNode) {
      return [getNodeCenter(node)];
    }

    const beziers = [];
    for (const curve of getConvertedVectorCurves(converted)) {
      beziers.push(...getCurveBeziers(curve));
    }

    if (beziers.length === 0) {
      return [getNodeCenter(node)];
    }

    const pathLength = beziers.reduce((sum, bezier) => sum + bezier.length, 0);
    if (pathLength <= 0) {
      return [getNodeCenter(node)];
    }

    const spreadBox = getNodeBox(converted);
    const rawGeometryBox =
      converted.curvesInterface.polyPolyCurves.exactBoundingBox ||
      converted.polyCurve.exactBoundingBox;
    const shouldTransform = !boxesAreClose(rawGeometryBox, spreadBox);
    const transform = converted.curvesInterface.domainTransform;
    const first = beziers[0].start;
    const last = beziers[beziers.length - 1].end;
    const closed = pointsAreClose(first, last);
    const interval = pathLength / count;
    const sampleDistance = Math.max(pathLength * 0.001, 0.5);
    const rawPoints = [];

    for (let i = 0; i < count; i += 1) {
      rawPoints.push(getPointAtPathLength(beziers, interval * i));
    }

    const spreadPoints = shouldTransform
      ? rawPoints.map((point) => transformPoint(point, transform))
      : rawPoints;
    const filteredSpreadPoints = removeSyntheticShapeCenterPoint(
      node,
      spreadPoints,
    );
    const centroid = getPathCentroid(filteredSpreadPoints);
    const placements = [];

    for (let i = 0; i < count; i += 1) {
      const distance = interval * i;
      const point = shouldTransform
        ? transformPoint(getPointAtPathLength(beziers, distance), transform)
        : getPointAtPathLength(beziers, distance);

      if (
        !filteredSpreadPoints.some((filteredPoint) =>
          pointsAreClose(filteredPoint, point),
        )
      ) {
        continue;
      }

      const before = shouldTransform
        ? transformPoint(
            getPointAtNormalizedPathLength(
              beziers,
              distance - sampleDistance,
              pathLength,
              closed,
            ),
            transform,
          )
        : getPointAtNormalizedPathLength(
            beziers,
            distance - sampleDistance,
            pathLength,
            closed,
          );
      const after = shouldTransform
        ? transformPoint(
            getPointAtNormalizedPathLength(
              beziers,
              distance + sampleDistance,
              pathLength,
              closed,
            ),
            transform,
          )
        : getPointAtNormalizedPathLength(
            beziers,
            distance + sampleDistance,
            pathLength,
            closed,
          );

      placements.push({
        x: point.x,
        y: point.y,
        normalAngle: normalAngleFromSamples(point, before, after, centroid),
      });
    }

    return removeDuplicatePlacements(placements);
  } catch (error) {
    console.log(
      'Could not read path interval normals for "' +
        getLayerName(node) +
        '": ' +
        String(error),
    );
    return [getNodeCenter(node)];
  } finally {
    if (!node.isPolyCurveNode && converted) {
      try {
        converted.delete();
      } catch (error) {
        console.log(
          'Could not remove temporary node for "' +
            getLayerName(node) +
            '": ' +
            String(error),
        );
      }
    }
  }
}

function getVectorNodeNormalPlacements(node) {
  const doc = node.document;
  let converted = null;

  try {
    converted = node.isPolyCurveNode
      ? node
      : convertTemporaryDuplicateToCurves(doc, node);

    if (!converted.isPolyCurveNode) {
      return [getNodeCenter(node)];
    }

    const beziers = [];
    for (const curve of getConvertedVectorCurves(converted)) {
      beziers.push(...getCurveBeziers(curve));
    }

    if (beziers.length === 0) {
      return [getNodeCenter(node)];
    }

    const pathLength = beziers.reduce((sum, bezier) => sum + bezier.length, 0);
    if (pathLength <= 0) {
      return [getNodeCenter(node)];
    }

    const spreadBox = getNodeBox(converted);
    const rawGeometryBox =
      converted.curvesInterface.polyPolyCurves.exactBoundingBox ||
      converted.polyCurve.exactBoundingBox;
    const shouldTransform = !boxesAreClose(rawGeometryBox, spreadBox);
    const transform = converted.curvesInterface.domainTransform;

    const first = beziers[0].start;
    const last = beziers[beziers.length - 1].end;
    const closed = pointsAreClose(first, last);
    const sampleDistance = Math.max(pathLength * 0.001, 0.5);
    const rawAnchorDistances = [];
    let runningLength = 0;

    for (const bezier of beziers) {
      rawAnchorDistances.push(runningLength);
      runningLength += bezier.length;
    }

    if (!closed) {
      rawAnchorDistances.push(pathLength);
    }

    const anchorDistances = [];
    for (const distance of rawAnchorDistances) {
      const point = getPointAtNormalizedPathLength(
        beziers,
        distance,
        pathLength,
        closed,
      );
      if (
        !anchorDistances.some((existingDistance) => {
          const existingPoint = getPointAtNormalizedPathLength(
            beziers,
            existingDistance,
            pathLength,
            closed,
          );
          return pointsAreClose(existingPoint, point);
        })
      ) {
        anchorDistances.push(distance);
      }
    }

    const rawPoints = anchorDistances.map((distance) =>
      getPointAtNormalizedPathLength(beziers, distance, pathLength, closed),
    );
    const spreadPoints = shouldTransform
      ? rawPoints.map((point) => transformPoint(point, transform))
      : rawPoints;
    const filteredSpreadPoints = removeSyntheticShapeCenterPoint(
      node,
      spreadPoints,
    );
    const centroid = getPathCentroid(filteredSpreadPoints);
    const placements = [];

    for (let i = 0; i < anchorDistances.length; i += 1) {
      const point = shouldTransform
        ? transformPoint(
            getPointAtNormalizedPathLength(
              beziers,
              anchorDistances[i],
              pathLength,
              closed,
            ),
            transform,
          )
        : getPointAtNormalizedPathLength(
            beziers,
            anchorDistances[i],
            pathLength,
            closed,
          );

      if (
        !filteredSpreadPoints.some((filteredPoint) =>
          pointsAreClose(filteredPoint, point),
        )
      ) {
        continue;
      }

      const before = shouldTransform
        ? transformPoint(
            getPointAtNormalizedPathLength(
              beziers,
              anchorDistances[i] - sampleDistance,
              pathLength,
              closed,
            ),
            transform,
          )
        : getPointAtNormalizedPathLength(
            beziers,
            anchorDistances[i] - sampleDistance,
            pathLength,
            closed,
          );
      const after = shouldTransform
        ? transformPoint(
            getPointAtNormalizedPathLength(
              beziers,
              anchorDistances[i] + sampleDistance,
              pathLength,
              closed,
            ),
            transform,
          )
        : getPointAtNormalizedPathLength(
            beziers,
            anchorDistances[i] + sampleDistance,
            pathLength,
            closed,
          );

      placements.push({
        x: point.x,
        y: point.y,
        normalAngle: normalAngleFromSamples(point, before, after, centroid),
      });
    }

    return removeDuplicatePlacements(placements);
  } catch (error) {
    console.log(
      'Could not read node normals for "' +
        getLayerName(node) +
        '": ' +
        String(error),
    );
    return [getNodeCenter(node)];
  } finally {
    if (!node.isPolyCurveNode && converted) {
      try {
        converted.delete();
      } catch (error) {
        console.log(
          'Could not remove temporary node for "' +
            getLayerName(node) +
            '": ' +
            String(error),
        );
      }
    }
  }
}

function rotatePlacementsByRightAngle(placements) {
  return placements.map((placement) => {
    if (typeof placement.normalAngle !== "number") {
      return placement;
    }

    return {
      x: placement.x,
      y: placement.y,
      normalAngle: placement.normalAngle + Math.PI / 2,
    };
  });
}

function getInsertionPoints(
  nodes,
  method,
  pathSymbolCount,
  rotateAlongPath,
  rotateToPathNormals,
) {
  const points = [];
  for (const node of nodes) {
    if (method === "corners") {
      points.push(...getBoxCorners(node));
    } else if (method === "nodes") {
      if (rotateAlongPath || rotateToPathNormals) {
        const placements = getVectorNodeNormalPlacements(node);
        points.push(
          ...(rotateToPathNormals
            ? rotatePlacementsByRightAngle(placements)
            : placements),
        );
      } else {
        points.push(...getVectorNodePoints(node));
      }
    } else if (method === "path") {
      if (rotateAlongPath || rotateToPathNormals) {
        const placements = getVectorPathIntervalPlacements(
          node,
          pathSymbolCount,
        );
        points.push(
          ...(rotateToPathNormals
            ? rotatePlacementsByRightAngle(placements)
            : placements),
        );
      } else {
        points.push(...getVectorPathIntervalPoints(node, pathSymbolCount));
      }
    } else {
      points.push(getNodeCenter(node));
    }
  }
  return points;
}

function createGroupContainer(doc, groupName) {
  const builder = AddChildNodesCommandBuilder.create();
  builder.setInsertionTarget(doc.currentSpread);
  builder.addContainerNode(ContainerNodeDefinition.create(groupName));

  const command = builder.createCommand(false, NodeChildType.Main);
  doc.executeCommand(command);
  return command.newNodes[0];
}

function moveNodesIntoContainer(doc, nodes, container) {
  const selection = Selection.create(doc, nodes);
  const command = DocumentCommand.createMoveNodes(
    selection,
    container,
    NodeMoveType.Inside,
    NodeChildType.Main,
  );
  doc.executeCommand(command);
}

function chooseInsertionMethod(doc) {
  const dialog = Dialog.create("Distribute Target on Shapes");
  dialog.initialWidth = 430;
  dialog.isResizable = true;
  const group = dialog.addColumn().addGroup("");
  const instructions = group.addStaticText(
    "",
    "Inserts copies of “target” layers onto selected vector shapes or paths.\n\n- Select a layer name from the dropdown or rename your layer to « target ».\n- Multiple matching layers are used in round-robin order.\n- Supports vector, group, symbol, and pixel layers.\n- to undo, delete the inserted group from layer panel",
  );
  const targetLayerNameOptions = getTargetLayerNameOptions(doc);
  const targetLayerNameControl = group.addComboBox(
    "Target layer name",
    targetLayerNameOptions,
    0,
  );
  const methodControl = group.addComboBox(
    "Insertion method",
    INSERTION_METHODS,
    0,
  );
  const pathCountControl = group.addComboBox(
    "Number of copies",
    PATH_SYMBOL_COUNT_OPTIONS,
    DEFAULT_PATH_SYMBOL_COUNT - 1,
  );
  const rotateControl = group.addCheckBox("Rotate along path", false);
  const rotateNormalsControl = group.addCheckBox(
    "Rotate to path normals",
    false,
  );

  instructions.isFullWidth = true;
  methodControl.isFullWidth = true;
  targetLayerNameControl.isFullWidth = true;
  pathCountControl.customSize = { width: 90, height: -1 };
  pathCountControl.setIsEnabledByWithSelectedIndex(
    methodControl,
    PATH_INSERTION_METHOD_INDEX,
  );
  rotateControl.isFullWidth = true;
  rotateControl.setIsEnabledByWithSelectedIndex(
    methodControl,
    PATH_INSERTION_METHOD_INDEX,
  );
  rotateControl.setIsDisabledBy(rotateNormalsControl);
  rotateNormalsControl.isFullWidth = true;
  rotateNormalsControl.setIsEnabledByWithSelectedIndex(
    methodControl,
    PATH_INSERTION_METHOD_INDEX,
  );
  rotateNormalsControl.setIsDisabledBy(rotateControl);

  if (dialog.runModal() != DialogResult.Ok.value) {
    return null;
  }

  const rotateAlongPath = rotateControl.value === true;
  const rotateToPathNormals = rotateNormalsControl.value === true;
  if (rotateAlongPath && rotateToPathNormals) {
    app.alert(
      'Choose either "Rotate along path" or "Rotate to path normals", not both.',
    );
    return null;
  }

  return {
    targetLayerName:
      targetLayerNameOptions[targetLayerNameControl.selectedIndex] ||
      TARGET_LAYER_NAME,
    method:
      INSERTION_METHODS[methodControl.selectedIndex] || INSERTION_METHODS[0],
    rotateAlongPath,
    rotateToPathNormals,
    pathSymbolCount:
      Number(PATH_SYMBOL_COUNT_OPTIONS[pathCountControl.selectedIndex]) ||
      DEFAULT_PATH_SYMBOL_COUNT,
  };
}

function main() {
  const doc = Document.current;
  if (!doc) {
    app.alert("This script requires an open document.");
    return;
  }

  const options = chooseInsertionMethod(doc);
  if (!options) {
    return;
  }

  const selectedVectors = doc.selection.nodes.filter(
    (node) => node.isVectorNode,
  );
  if (selectedVectors.length === 0) {
    app.alert("Select one or more vector layers first.");
    return;
  }

  const targetLayers = findTargetLayers(doc, options.targetLayerName);
  if (targetLayers.length === 0) {
    app.alert('No layer named "' + options.targetLayerName + '" was found.');
    return;
  }

  const insertionMethod = options.method;
  const insertionPoints = getInsertionPoints(
    selectedVectors,
    insertionMethod,
    options.pathSymbolCount,
    options.rotateAlongPath,
    options.rotateToPathNormals,
  );
  const duplicateLayerName =
    DUPLICATE_LAYER_NAMES[insertionMethod] || "center symbol";
  const groupLayerName = GROUP_LAYER_NAMES[insertionMethod] || "center symbols";
  const duplicates = [];

  for (let i = 0; i < insertionPoints.length; i += 1) {
    const point = insertionPoints[i];
    const targetLayer = targetLayers[i % targetLayers.length];
    const targetCenter = getNodeCenter(targetLayer);
    const duplicate = duplicateNodeAtPlacement(
      targetLayer,
      targetCenter,
      point,
    );
    duplicate.userDescription = duplicateLayerName;
    duplicates.push(duplicate);
  }

  const group = createGroupContainer(doc, groupLayerName);
  moveNodesIntoContainer(doc, duplicates, group);

  let rotatedCount = 0;
  for (let i = 0; i < duplicates.length; i += 1) {
    const angle = insertionPoints[i].normalAngle;
    if (typeof angle === "number") {
      rotateNodeAroundCenter(duplicates[i], angle);
      rotatedCount += 1;
    }
  }
  console.log(
    "Duplicate target: method=" +
      insertionMethod +
      ", rotateAlongPath=" +
      String(options.rotateAlongPath) +
      ", rotateToPathNormals=" +
      String(options.rotateToPathNormals) +
      ", targetLayers=" +
      targetLayers.length +
      ", placements=" +
      insertionPoints.length +
      ", rotated=" +
      rotatedCount,
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  app.alert("Duplicate target at centers failed: " + message);
  console.log("Duplicate target at centers failed: " + message);
}

module.exports.main = main;
