/**
 * Name: Duplicate at Selected Nodes
 * Description: Duplicates the front/top selected object at every selected on-curve node on the other selected curve objects.
 * Version: 1.0.0
 * Author: Dimas Nirwan
 */

const { Document } = require("/document");
const {
  DocumentCommand,
  CompoundCommandBuilder,
  AddChildNodesCommandBuilder,
} = require("/commands");
const { Selection, SubSelectionType } = require("/selections");
const { PolyCurveNodeDefinition } = require("/nodes");
const { Transform, CurveNodeType, PolyCurve } = require("/geometry");

function enumValue(value) {
  return value && typeof value === "object" && "value" in value
    ? value.value
    : value;
}

function isOnCurveNode(curveNode) {
  return (
    curveNode && enumValue(curveNode.type) === enumValue(CurveNodeType.OnCurve)
  );
}

function rectCenter(rect) {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
}

function getNodePolyCurveInSpread(node) {
  if (!node || !node.polyCurve) return null;

  const polyCurve = node.polyCurve.clone();
  polyCurve.transform(node.baseToSpreadTransform);
  return polyCurve;
}

function getSelectedCurveAnchors(selectionItem) {
  const node = selectionItem.node;
  if (!node || !node.polyCurve) return [];

  const subSelection = selectionItem.getSubSelectionOfType(
    SubSelectionType.CurveNode,
  );
  if (!subSelection || subSelection.isEmpty) return [];

  const polyCurve = getNodePolyCurveInSpread(node);
  if (!polyCurve) return [];

  const anchors = [];
  const seen = new Set();

  for (const item of subSelection.items) {
    if (item.curveID == null || item.nodeID == null) continue;
    if (item.curveID < 0 || item.curveID >= polyCurve.curveCount) continue;

    const curve = polyCurve.at(item.curveID);
    if (item.nodeID < 0 || item.nodeID >= curve.nodeCount) continue;

    const curveNode = curve.getNode(item.nodeID);
    if (!isOnCurveNode(curveNode)) continue;

    const point = curveNode.position;
    const key = Math.round(point.x * 1000) + "," + Math.round(point.y * 1000);
    if (seen.has(key)) continue;

    seen.add(key);
    anchors.push({ x: point.x, y: point.y });
  }

  return anchors;
}

function getReferencePoint(sourceItem) {
  const sourceNode = sourceItem.node;
  const selectedSourceAnchors = getSelectedCurveAnchors(sourceItem);

  if (selectedSourceAnchors.length === 1) return selectedSourceAnchors[0];

  const box = sourceNode.getSpreadVisibleBox();
  if (!box || box.width == null || box.height == null) return null;

  return rectCenter(box);
}

function collectTargetAnchors(selection, firstTargetIndex) {
  const anchors = [];
  const seen = new Set();

  for (let i = firstTargetIndex; i < selection.length; i++) {
    const itemAnchors = getSelectedCurveAnchors(selection.at(i));
    for (const anchor of itemAnchors) {
      const key =
        Math.round(anchor.x * 1000) + "," + Math.round(anchor.y * 1000);
      if (seen.has(key)) continue;
      seen.add(key);
      anchors.push(anchor);
    }
  }

  return anchors;
}

function addAnchor(anchors, seen, point) {
  const key = Math.round(point.x * 1000) + "," + Math.round(point.y * 1000);
  if (seen.has(key)) return;
  seen.add(key);
  anchors.push({ x: point.x, y: point.y });
}

function collectAllOnCurveAnchorsFromCurve(curve, anchors, seen) {
  for (let i = 0; i < curve.nodeCount; i++) {
    const curveNode = curve.getNode(i);
    if (isOnCurveNode(curveNode)) addAnchor(anchors, seen, curveNode.position);
  }
}

function collectAllOnCurveAnchorsFromNode(node) {
  const polyCurve = getNodePolyCurveInSpread(node);
  const anchors = [];
  const seen = new Set();

  if (!polyCurve) return anchors;

  for (let i = 0; i < polyCurve.curveCount; i++)
    collectAllOnCurveAnchorsFromCurve(polyCurve.at(i), anchors, seen);

  return anchors;
}

function collectAllTargetAnchorsExcept(selection, sourceIndex) {
  const anchors = [];
  const seen = new Set();

  for (let i = 0; i < selection.length; i++) {
    if (i === sourceIndex) continue;
    const node = selection.at(i).node;
    for (const anchor of collectAllOnCurveAnchorsFromNode(node))
      addAnchor(anchors, seen, anchor);
  }

  return anchors;
}

function duplicateFirstSubCurveAtRemainingSubCurveAnchors(doc, node) {
  const originalPolyCurve = node.polyCurve;
  if (!originalPolyCurve || originalPolyCurve.curveCount < 2) return 0;

  const spreadPolyCurve = originalPolyCurve.clone();
  spreadPolyCurve.transform(node.baseToSpreadTransform);

  const sourceCurve = spreadPolyCurve.at(0).clone();
  const sourceBox = sourceCurve.getBoundingBox();
  if (!sourceBox) return 0;

  const referencePoint = rectCenter(sourceBox);
  const anchors = [];
  const seen = new Set();
  for (let i = 1; i < spreadPolyCurve.curveCount; i++)
    collectAllOnCurveAnchorsFromCurve(spreadPolyCurve.at(i), anchors, seen);

  if (anchors.length === 0) return 0;

  const builder = AddChildNodesCommandBuilder.create();
  for (const anchor of anchors) {
    const curve = sourceCurve.clone();
    curve.translate(anchor.x - referencePoint.x, anchor.y - referencePoint.y);
    const polyCurve = new PolyCurve();
    polyCurve.addCurve(curve);
    builder.addNode(
      PolyCurveNodeDefinition.create(
        polyCurve,
        node.brushFillDescriptor,
        node.lineStyleDescriptor,
        node.penFillDescriptor,
        node.transparencyFillDescriptor,
      ),
    );
  }

  doc.executeCommand(builder.createCommand());
  return anchors.length;
}

function duplicateAtAnchors(doc, sourceNode, referencePoint, targetAnchors) {
  const sourceSelection = Selection.create(doc, sourceNode);
  const builder = CompoundCommandBuilder.create();
  let commandCount = 0;

  for (const anchor of targetAnchors) {
    const dx = anchor.x - referencePoint.x;
    const dy = anchor.y - referencePoint.y;
    const command = DocumentCommand.createTransform(
      sourceSelection,
      Transform.createTranslate(dx, dy),
      { duplicateNodes: true },
    );
    builder.addCommand(command, commandCount === 0);
    commandCount++;
  }

  if (commandCount === 0) return 0;

  doc.executeCommand(builder.createCommand());
  return commandCount;
}

function chooseSourceIndex(selection) {
  const noAnchorIndexes = [];

  for (let i = 0; i < selection.length; i++) {
    const item = selection.at(i);
    if (!item.node) continue;
    if (getSelectedCurveAnchors(item).length === 0) noAnchorIndexes.push(i);
  }

  // Affinity often lists node-subselected target curves before the normally
  // selected source object. When there is one plain selected object, use it.
  if (noAnchorIndexes.length === 1) return noAnchorIndexes[0];

  // Otherwise keep Illustrator's behavior: the front/top item in selection is source.
  return 0;
}

function collectTargetAnchorsExcept(selection, sourceIndex) {
  const anchors = [];
  const seen = new Set();

  for (let i = 0; i < selection.length; i++) {
    if (i === sourceIndex) continue;

    const itemAnchors = getSelectedCurveAnchors(selection.at(i));
    for (const anchor of itemAnchors) {
      const key =
        Math.round(anchor.x * 1000) + "," + Math.round(anchor.y * 1000);
      if (seen.has(key)) continue;
      seen.add(key);
      anchors.push(anchor);
    }
  }

  return anchors;
}

function main() {
  const doc = Document.current;
  if (!doc) {
    alert("Open a document first.");
    return;
  }

  const selection = doc.selection;
  if (!selection || selection.length < 1) {
    alert("Select the source object plus at least one target curve.");
    return;
  }

  if (selection.length === 1) {
    const onlyNode = selection.at(0).node;
    const duplicated = duplicateFirstSubCurveAtRemainingSubCurveAnchors(
      doc,
      onlyNode,
    );
    if (duplicated > 0) {
      console.log(
        "Dup At Selected Anchors: duplicated " +
          duplicated +
          " sub-curve object(s).",
      );
      return;
    }
    alert(
      "Select a source object plus target curve nodes, or select one Curves layer that contains at least two sub-curves.",
    );
    return;
  }

  const sourceIndex = chooseSourceIndex(selection);
  const sourceItem = selection.at(sourceIndex);
  const sourceNode = sourceItem.node;
  if (!sourceNode) {
    alert("The source item cannot be duplicated.");
    return;
  }

  const referencePoint = getReferencePoint(sourceItem);
  if (!referencePoint) {
    alert("Could not read the source object bounds.");
    return;
  }

  const targetAnchors = collectTargetAnchorsExcept(selection, sourceIndex);
  if (targetAnchors.length === 0) {
    targetAnchors.push(
      ...collectAllTargetAnchorsExcept(selection, sourceIndex),
    );
  }

  if (targetAnchors.length === 0) {
    alert(
      "No curve nodes found on the target objects. Select a source object plus at least one curve target.",
    );
    return;
  }

  const duplicated = duplicateAtAnchors(
    doc,
    sourceNode,
    referencePoint,
    targetAnchors,
  );
  console.log(
    "Dup At Selected Anchors: duplicated " + duplicated + " object(s).",
  );
}

main();
