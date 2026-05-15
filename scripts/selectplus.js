"use strict";

const { app } = require("/application");
const { Dialog, DialogResult } = require("/dialog");
const { Document } = require("/document");
const { DocumentCommand } = require("/commands");
const { Selection } = require("/selections");

const RELATIONSHIP_OPTIONS = [
  "children",
  "parent",
  "sibblings",
  "grandchildren",
];
const SHAPE_OPTIONS = ["inside", "outside"];
const EVERY_INDEXING_OPTIONS = ["layer order", "horizontal", "vertical"];
const RANDOM_PERCENTAGE_OPTIONS = ["80%", "50%", "30%", "10%"];

function getResultValue(result) {
  return result && result.value != null ? result.value : result;
}

function showSelectDialog(doc) {
  const dialog = Dialog.create("Select");
  dialog.initialWidth = 360;
  dialog.isResizable = false;
  const shapeTargetOptions = getShapeTargetOptions(doc);

  const group = dialog.addColumn().addGroup("");
  const relationshipEnabledControl = group.addCheckBox("Relationship", true);
  const relationshipControl = group.addButtonSet("", RELATIONSHIP_OPTIONS, 0);
  const nameControl = group.addCheckBox("Name", false);
  const nameTextControl = group.addTextBox("", "");
  const shapeControl = group.addCheckBox("Shape", false);
  const shapeModeControl = group.addButtonSet("", SHAPE_OPTIONS, 0);
  const shapeTargetControl = group.addComboBox("", shapeTargetOptions.names, 0);
  const everyControl = group.addCheckBox("Every", false);
  const everyIndexingControl = group.addButtonSet(
    "indexing",
    EVERY_INDEXING_OPTIONS,
    0,
  );
  const everySelectControl = group.addTextBox("select", "1");
  const everyUnselectControl = group.addTextBox("unselect", "1");
  const randomControl = group.addCheckBox("Random", false);
  const randomPercentageControl = group.addButtonSet(
    "",
    RANDOM_PERCENTAGE_OPTIONS,
    1,
  );
  relationshipEnabledControl.isFullWidth = true;
  relationshipControl.isFullWidth = true;
  nameControl.isFullWidth = true;
  nameTextControl.isFullWidth = true;
  shapeControl.isFullWidth = true;
  shapeModeControl.isFullWidth = true;
  shapeTargetControl.isFullWidth = true;
  everyControl.isFullWidth = true;
  everyIndexingControl.isFullWidth = true;
  everySelectControl.customSize = { width: 90, height: -1 };
  everyUnselectControl.customSize = { width: 90, height: -1 };
  randomControl.isFullWidth = true;
  randomPercentageControl.isFullWidth = true;
  relationshipControl.setIsEnabledBy(relationshipEnabledControl);
  nameTextControl.setIsEnabledBy(nameControl);
  shapeModeControl.setIsEnabledBy(shapeControl);
  shapeTargetControl.setIsEnabledBy(shapeControl);
  everyIndexingControl.setIsEnabledBy(everyControl);
  everySelectControl.setIsEnabledBy(everyControl);
  everyUnselectControl.setIsEnabledBy(everyControl);
  randomPercentageControl.setIsEnabledBy(randomControl);

  if (getResultValue(dialog.runModal()) !== DialogResult.Ok.value) {
    return null;
  }

  return {
    relationship:
      relationshipEnabledControl.value === true
        ? RELATIONSHIP_OPTIONS[relationshipControl.selectedIndex] ||
          RELATIONSHIP_OPTIONS[0]
        : null,
    nameText:
      nameControl.value === true
        ? String(nameTextControl.text || "").trim()
        : null,
    shape:
      shapeControl.value === true
        ? {
            mode:
              SHAPE_OPTIONS[shapeModeControl.selectedIndex] || SHAPE_OPTIONS[0],
            target:
              shapeTargetOptions.layers[shapeTargetControl.selectedIndex] ||
              null,
          }
        : null,
    every:
      everyControl.value === true
        ? {
            indexing:
              EVERY_INDEXING_OPTIONS[everyIndexingControl.selectedIndex] ||
              EVERY_INDEXING_OPTIONS[0],
            select: parseIntegerText(everySelectControl.text, 1),
            unselect: parseIntegerText(everyUnselectControl.text, 1),
          }
        : null,
    randomPercentage:
      randomControl.value === true
        ? parseRandomPercentage(
            RANDOM_PERCENTAGE_OPTIONS[randomPercentageControl.selectedIndex],
          )
        : null,
  };
}

function parseRandomPercentage(value) {
  const percentage = Number(String(value || "").replace("%", ""));
  if (!Number.isFinite(percentage)) {
    return null;
  }
  return Math.max(0, Math.min(100, percentage)) / 100;
}

function parseIntegerText(value, fallback) {
  const number = Number(String(value || "").trim());
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(0, Math.round(number));
}

function nodesContain(nodes, candidate) {
  return nodes.some((node) => node.isSameNode(candidate));
}

function addUniqueNode(nodes, candidate) {
  if (!candidate || nodesContain(nodes, candidate)) {
    return;
  }
  nodes.push(candidate);
}

function getInputNodes(doc) {
  const selectedNodes = doc.selection.nodes.toArray
    ? doc.selection.nodes.toArray()
    : Array.from(doc.selection.nodes);

  if (selectedNodes.length > 0) {
    return selectedNodes;
  }

  return doc.layers.toArray ? doc.layers.toArray() : Array.from(doc.layers);
}

function getDirectChildren(node) {
  return node.children.toArray
    ? node.children.toArray()
    : Array.from(node.children);
}

function getLayerName(node) {
  return String(node.userDescription || node.description || "").trim();
}

function getShapeTargetOptions(doc) {
  const layers = [];
  const names = [];

  for (const node of doc.layers.all) {
    if (!isVectorShapeNode(node)) {
      continue;
    }

    layers.push(node);
    names.push(
      getLayerName(node) || node.description || "Layer " + layers.length,
    );
  }

  if (names.length === 0) {
    names.push("No vector shape layers found");
  }

  return { layers, names };
}

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
    return null;
  }

  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  };
}

function isVectorShapeNode(node) {
  if (!node || !node.isVectorNode || !node.curvesInterface) {
    return false;
  }

  try {
    return node.curvesInterface.polyPolyCurves.hasCurves === true;
  } catch (_) {
    return false;
  }
}

function isArtboardNode(node) {
  if (!node || !node.artboardInterface) {
    return false;
  }

  try {
    return node.artboardInterface.isArtboardEnabled === true;
  } catch (_) {
    return false;
  }
}

function selectChildren(inputNodes) {
  const outputNodes = [];

  for (const node of inputNodes) {
    const children = getDirectChildren(node);
    if (children.length === 0) {
      addUniqueNode(outputNodes, node);
      continue;
    }

    for (const child of children) {
      addUniqueNode(outputNodes, child);
    }
  }

  return outputNodes;
}

function selectParents(inputNodes) {
  const outputNodes = [];

  for (const node of inputNodes) {
    const parent = node.parent;
    if (!isArtboardNode(parent)) {
      addUniqueNode(outputNodes, parent);
    }
  }

  return outputNodes;
}

function selectSibblings(inputNodes) {
  const outputNodes = [];

  for (const node of inputNodes) {
    const parent = node.parent;
    if (!parent) {
      continue;
    }

    for (const sibbling of getDirectChildren(parent)) {
      addUniqueNode(outputNodes, sibbling);
    }
  }

  return outputNodes;
}

function addLeafNodes(node, outputNodes) {
  const children = getDirectChildren(node);
  if (children.length === 0) {
    addUniqueNode(outputNodes, node);
    return;
  }

  for (const child of children) {
    addLeafNodes(child, outputNodes);
  }
}

function selectGrandchildren(inputNodes) {
  const outputNodes = [];

  for (const node of inputNodes) {
    addLeafNodes(node, outputNodes);
  }

  return outputNodes;
}

function applyRandomFilter(nodes, percentage) {
  if (percentage == null) {
    return nodes;
  }

  return nodes.filter(() => Math.random() < percentage);
}

function addMatchingNameNodes(node, searchText, outputNodes) {
  if (getLayerName(node).toLowerCase().includes(searchText)) {
    addUniqueNode(outputNodes, node);
  }

  for (const child of getDirectChildren(node)) {
    addMatchingNameNodes(child, searchText, outputNodes);
  }
}

function applyNameFilter(nodes, nameText) {
  if (nameText == null) {
    return nodes;
  }

  const searchText = nameText.toLowerCase();
  const outputNodes = [];
  for (const node of nodes) {
    addMatchingNameNodes(node, searchText, outputNodes);
  }
  return outputNodes;
}

function getShapeContainmentGeometry(targetNode) {
  if (!targetNode || !isVectorShapeNode(targetNode)) {
    return null;
  }

  const curvesInterface = targetNode.curvesInterface;
  const polyPolyCurve = curvesInterface.polyPolyCurves.clone();
  polyPolyCurve.transform(curvesInterface.domainTransform);
  return {
    polyPolyCurve,
    windingOrder: curvesInterface.windingOrder,
  };
}

function isPointInsideShape(point, shapeGeometry) {
  if (!point || !shapeGeometry) {
    return false;
  }

  return (
    shapeGeometry.polyPolyCurve.containsPoint(
      point,
      false,
      shapeGeometry.windingOrder,
      true,
    ) === true
  );
}

function applyShapeFilter(nodes, options) {
  if (options == null) {
    return nodes;
  }

  const shapeGeometry = getShapeContainmentGeometry(options.target);
  if (!shapeGeometry) {
    return [];
  }

  const outputNodes = [];
  const keepInside = options.mode === "inside";
  for (const node of nodes) {
    if (node.isSameNode(options.target)) {
      continue;
    }

    const inside = isPointInsideShape(getNodeCenter(node), shapeGeometry);
    if (inside === keepInside) {
      outputNodes.push(node);
    }
  }
  return outputNodes;
}

function createLayerOrderMap(doc) {
  const orderedNodes = doc.layers.all.reverse().toArray
    ? doc.layers.all.reverse().toArray()
    : Array.from(doc.layers.all.reverse());
  return orderedNodes;
}

function getLayerOrderIndex(layerOrderNodes, node) {
  for (let index = 0; index < layerOrderNodes.length; index += 1) {
    if (layerOrderNodes[index].isSameNode(node)) {
      return index;
    }
  }
  return Number.MAX_SAFE_INTEGER;
}

function sortNodesForEvery(nodes, options, doc) {
  const sortedNodes = nodes.slice ? nodes.slice() : Array.from(nodes);

  if (options.indexing === "horizontal" || options.indexing === "vertical") {
    const axis = options.indexing === "horizontal" ? "y" : "x";
    sortedNodes.sort((a, b) => {
      const centerA = getNodeCenter(a);
      const centerB = getNodeCenter(b);
      const valueA = centerA ? centerA[axis] : Number.MAX_SAFE_INTEGER;
      const valueB = centerB ? centerB[axis] : Number.MAX_SAFE_INTEGER;
      return valueA - valueB;
    });
    return sortedNodes;
  }

  const layerOrderNodes = createLayerOrderMap(doc);
  sortedNodes.sort(
    (a, b) =>
      getLayerOrderIndex(layerOrderNodes, a) -
      getLayerOrderIndex(layerOrderNodes, b),
  );
  return sortedNodes;
}

function applyEveryFilter(nodes, options, doc) {
  if (options == null) {
    return nodes;
  }

  const selectedNodes = [];
  const sortedNodes = sortNodesForEvery(nodes, options, doc);
  const cycleLength = options.select + options.unselect;

  for (let index = 0; index < sortedNodes.length; index += 1) {
    if (index % cycleLength < options.select) {
      selectedNodes.push(sortedNodes[index]);
    }
  }

  return selectedNodes;
}

function refineSelection(options, inputNodes, doc) {
  let outputNodes;

  if (options.relationship == null) {
    outputNodes = inputNodes.slice
      ? inputNodes.slice()
      : Array.from(inputNodes);
  } else {
    switch (options.relationship) {
      case "children":
        outputNodes = selectChildren(inputNodes);
        break;
      case "parent":
        outputNodes = selectParents(inputNodes);
        break;
      case "sibblings":
        outputNodes = selectSibblings(inputNodes);
        break;
      case "grandchildren":
        outputNodes = selectGrandchildren(inputNodes);
        break;
      default:
        throw new Error(
          'Unknown relationship mode "' + options.relationship + '".',
        );
    }
  }

  outputNodes = applyNameFilter(outputNodes, options.nameText);
  outputNodes = applyShapeFilter(outputNodes, options.shape);
  outputNodes = applyEveryFilter(outputNodes, options.every, doc);
  return applyRandomFilter(outputNodes, options.randomPercentage);
}

function main() {
  const doc = Document.current;
  if (!doc) {
    app.alert("This script requires an open document.");
    return;
  }

  const options = showSelectDialog(doc);
  if (!options) {
    return;
  }

  if (options.nameText === "") {
    app.alert("Enter a partial layer name, or uncheck Name.");
    return;
  }

  if (options.shape && !options.shape.target) {
    app.alert("No vector shape target layer was found, or uncheck Shape.");
    return;
  }

  if (options.every && options.every.select + options.every.unselect === 0) {
    app.alert(
      "Enter a Select or Unselect count greater than zero, or uncheck Every.",
    );
    return;
  }

  const inputNodes = getInputNodes(doc);
  if (inputNodes.length === 0) {
    app.alert("No document layers were found.");
    return;
  }

  const outputNodes = refineSelection(options, inputNodes, doc);
  const outputSelection = Selection.create(doc, outputNodes);
  doc.executeCommand(DocumentCommand.createSetSelection(outputSelection));

  console.log(
    "Select: relationship=" +
      options.relationship +
      ", nameText=" +
      String(options.nameText) +
      ", shape=" +
      (options.shape ? options.shape.mode : "null") +
      ", every=" +
      JSON.stringify(options.every) +
      ", randomPercentage=" +
      String(options.randomPercentage) +
      ", input=" +
      inputNodes.length +
      ", output=" +
      outputNodes.length,
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  app.alert("Select failed: " + message);
  console.log("Select failed: " + message);
}

module.exports.main = main;
