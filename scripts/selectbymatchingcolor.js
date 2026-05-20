"use strict";

// === Select Same Color (fill or stroke) within the parent layer ===
// Usage:
//   1. In Affinity, select ONE object whose color you want to propagate.
//   2. Run this script (Studio > Scripts).
//   3. All objects in the same parent layer sharing the fill OR stroke
//      color will be selected.

const { app } = require("/application");
const { Selection } = require("/selections");
const {
  NodeChildType,
  getNodeChildrenRecursive,
  createTypedNode,
} = require("/nodes");

function rgba8Key(colour) {
  // Returns a canonical RGBA8 string (alpha included) for strict
  // color comparison between two nodes.
  if (!colour) return null;
  try {
    const c = colour.rgba8;
    return c.r + "," + c.g + "," + c.b + "," + c.alpha;
  } catch (e) {
    return null;
  }
}

function solidColourKey(fill) {
  // fill is a Fill object (SolidFill, NoFill, GradientFill, BitmapFill...).
  // Only SolidFill can be reliably compared.
  if (!fill) return null;
  if (fill[Symbol.toStringTag] === "SolidFill") {
    return rgba8Key(fill.colour);
  }
  // For gradient / pattern / none, return null so we don't confuse
  // "no fill" with an actual color.
  return null;
}

function getNodeBrushKey(node) {
  try {
    if (typeof node.hasBrushFill !== "undefined" && node.hasBrushFill) {
      const desc = node.brushFillDescriptor;
      if (desc) return solidColourKey(desc.fill);
    }
  } catch (e) {
    /* node has no brushFill (group, raster, etc.) */
  }
  return null;
}

function getNodePenKey(node) {
  try {
    if (typeof node.hasPenFill !== "undefined" && node.hasPenFill) {
      const desc = node.penFillDescriptor;
      if (desc) return solidColourKey(desc.fill);
    }
  } catch (e) {
    /* node has no penFill */
  }
  return null;
}

function main() {
  const doc = app.documents.current;
  if (!doc) {
    app.alert("No document open.", "Select by color");
    return;
  }

  const currentSel = doc.selection;
  if (!currentSel || currentSel.length === 0) {
    app.alert(
      "Select an object first to use its color as reference.",
      "Select by color",
    );
    return;
  }

  // 1. Target colors: taken from the first selected object
  const refNode = currentSel.firstNode;
  if (!refNode) {
    app.alert(
      "The selection does not contain a usable node.",
      "Select by color",
    );
    return;
  }

  const targetBrush = getNodeBrushKey(refNode);
  const targetPen = getNodePenKey(refNode);

  if (!targetBrush && !targetPen) {
    app.alert(
      "The selected object has no solid color (fill or stroke).\n" +
        "This script only compares solid colors (SolidFill).",
      "Select by color",
    );
    return;
  }

  // 2. Parent layer: we look for the container acting as the "layer".
  //    We walk up to the direct parent of the node, which matches
  //    what's visually shown as the layer/group in the Layers panel.
  let parent = refNode.parent;
  if (!parent) {
    // Fallback: use the current spread to scan everything.
    parent = doc.currentSpread;
  }
  if (!parent) {
    app.alert("Unable to determine the parent layer.", "Select by color");
    return;
  }

  // 3. Recursive scan of all descendants of the parent
  const matches = [];
  let scanned = 0;

  for (const child of getNodeChildrenRecursive(
    parent.handle,
    NodeChildType.Main,
    false,
  )) {
    scanned++;
    const brushKey = getNodeBrushKey(child);
    const penKey = getNodePenKey(child);

    // Match if AT LEAST one color (fill or stroke) matches the target.
    let isMatch = false;
    if (targetBrush && (brushKey === targetBrush || penKey === targetBrush))
      isMatch = true;
    if (
      !isMatch &&
      targetPen &&
      (brushKey === targetPen || penKey === targetPen)
    )
      isMatch = true;

    if (isMatch) matches.push(child);
  }

  // 4. Build the new selection
  if (matches.length === 0) {
    app.alert(
      "No object found with the same color in the layer.",
      "Select by color",
    );
    return;
  }

  const newSel = Selection.createEmpty(doc);
  for (const node of matches) {
    newSel.add(node);
  }
  doc.selection = newSel;

  console.log("Nodes scanned     : " + scanned);
  console.log("Target fill color : " + (targetBrush || "—"));
  console.log("Target stroke col.: " + (targetPen || "—"));
  console.log("Objects selected  : " + matches.length);
}

main();
