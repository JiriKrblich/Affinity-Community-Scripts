// =====================================================================
// DIRECTIONAL BLUR SHADOW
// Simulates Photoshop's Path Blur effect: a directional shadow that
// progressively blurs, fades and tapers (narrows or expands) as it
// moves away from the object.
//
// Works correctly with objects at the root spread level OR inside groups.
//
// Rasterize mode: merges into a single pixel layer in the same context.
// Group mode: keeps vector nodes with live effects, fully editable.
//
// USAGE: Select an object and run the script.
// =====================================================================
"use strict";

const { Document } = require("/document.js");
const {
  AddChildNodesCommandBuilder,
  DocumentCommand,
  NodeMoveType,
  NodeChildType,
} = require("/commands.js");
const { ContainerNodeDefinition } = require("/nodes.js");
const { Selection } = require("/selections.js");
const { Transform } = require("/geometry.js");
const { Dialog, DialogResult } = require("/dialog.js");
const { RGBA8 } = require("/colours.js");
const {
  GaussianBlurLayerEffect,
  ColourOverlayLayerEffect,
} = require("/layereffects.js");

// ─── Initial checks ──────────────────────────────────────────────────
const doc = Document.current;
if (!doc) {
  console.log("ERROR: No document is open.");
  return;
}

const initialItems = [...doc.selection.nodes];
if (initialItems.length === 0) {
  console.log("ERROR: Please select an object before running the script.");
  return;
}
const originalNode = initialItems[0];

// Determine whether the object lives inside a group or at the root spread level
const parentNode = originalNode.parent;
const isInsideGroup = parentNode.constructor.name !== "SpreadNode";
console.log(
  "Context: " +
    (isInsideGroup
      ? "inside group '" + parentNode.description + "'"
      : "root spread"),
);

// ─── Settings dialog ─────────────────────────────────────────────────
const dlg = Dialog.create("Directional Blur Shadow");
dlg.initialWidth = 340;

const col = dlg.addColumn();

const grpDir = col.addGroup("Direction");
const dirCombo = grpDir.addComboBox(
  "Blur direction",
  [
    "→ Right",
    "← Left",
    "↓ Down",
    "↑ Up",
    "↘ Right + Down",
    "↙ Left + Down",
    "↗ Right + Up",
    "↖ Left + Up",
  ],
  0,
);

const grpParam = col.addGroup("Parameters");
const distEditor = grpParam.addUnitValueEditor(
  "Total distance (px)",
  "px",
  "px",
  150,
  10,
  2000,
);
const stepsEditor = grpParam.addUnitValueEditor(
  "Number of layers",
  "px",
  "px",
  10,
  3,
  30,
);
const blurEditor = grpParam.addUnitValueEditor(
  "Max blur (px)",
  "px",
  "px",
  25,
  1,
  300,
);

const grpFx = col.addGroup("Shadow appearance");
const colorPicker = grpFx.addColourPicker("Shadow colour", RGBA8(0, 0, 0, 255));
const opStartEditor = grpFx.addUnitValueEditor(
  "Start opacity (%)",
  "px",
  "px",
  75,
  1,
  100,
);
const opEndEditor = grpFx.addUnitValueEditor(
  "End opacity (%)",
  "px",
  "px",
  0,
  0,
  100,
);

const grpTaper = col.addGroup("Taper (Narrow / Expand)");
const taperCheck = grpTaper.addCheckBox("Enable taper", false);
// < 100% = narrows at the tip | 100% = no effect | > 100% = expands at the tip
const taperEditor = grpTaper.addUnitValueEditor(
  "Size at tip (%)",
  "px",
  "px",
  10,
  1,
  500,
);
taperEditor.setIsEnabledBy(taperCheck);

const grpOutput = col.addGroup("Output");
const rasterCheck = grpOutput.addCheckBox(
  "Rasterize into a single layer",
  true,
);

const result = dlg.runModal();
if (result.value !== DialogResult.Ok.value) {
  console.log("Cancelled.");
  return;
}

// ─── Read parameters ─────────────────────────────────────────────────
const dirIndex = dirCombo.selectedIndex;
const distance = distEditor.value;
const steps = Math.max(3, Math.round(stepsEditor.value));
const blurMax = blurEditor.value;
const shadowColour = colorPicker.value || RGBA8(0, 0, 0, 255);
const opStart = opStartEditor.value / 100;
const opEnd = opEndEditor.value / 100;
const useTaper = taperCheck.value;
const taperEnd = taperEditor.value / 100;
const doRasterize = rasterCheck.value;

// Unit direction vectors
const dirs = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
];
const [dx, dy] = dirs[dirIndex];
const mag = Math.sqrt(dx * dx + dy * dy);
const nx = dx / mag;
const ny = dy / mag;

console.log(
  "Generating " +
    steps +
    " layers | taper=" +
    (useTaper ? taperEnd * 100 + "%" : "off") +
    " | mode=" +
    (doRasterize ? "rasterize" : "vector group"),
);

// ─── Calculate taper pivot and scale axes ─────────────────────────────
const bounds = originalNode.spreadVisibleBox;
const cx = bounds.x + bounds.width / 2;
const cy = bounds.y + bounds.height / 2;

// Scale is applied on the axis PERPENDICULAR to the direction of movement:
// Horizontal shadow → scale Y only | Vertical shadow → scale X only | Diagonal → both
const isDiagonal = nx !== 0 && ny !== 0;
const scaleAxisX = isDiagonal ? 1 : Math.abs(ny);
const scaleAxisY = isDiagonal ? 1 : Math.abs(nx);

// Pivot point for the taper scale:
// Narrowing (taperEnd < 1): pivot on the edge OPPOSITE to movement direction
// → shadow starts full-size and narrows toward the tip
// Expanding (taperEnd > 1): pivot on the edge IN the movement direction
// → shadow starts full-size and fans outward toward the tip
const expanding = taperEnd > 1.0;
const pivotSign = expanding ? 1 : -1;
const pivotX = cx + pivotSign * nx * (bounds.width / 2);
const pivotY = cy + pivotSign * ny * (bounds.height / 2);

// ─── Generate shadow layers ───────────────────────────────────────────
// createTransform with duplicateNodes places the copy in the same parent
// as the original, working correctly at root level and inside groups.
const shadowNodes = [];

for (let i = steps; i >= 1; i--) {
  const t = i / steps; // 1 = farthest from object, ~0 = closest

  const offsetX = nx * distance * t;
  const offsetY = ny * distance * t;
  const blurRadius = blurMax * t;
  // Opacity: close = opStart, far = opEnd
  const opacity = opStart + (opEnd - opStart) * t;
  // Scale: 1.0 close → taperEnd far (works for <1, =1, and >1)
  const perpScale = 1.0 + (taperEnd - 1.0) * t;
  const sX = useTaper && scaleAxisX > 0 ? perpScale : 1.0;
  const sY = useTaper && scaleAxisY > 0 ? perpScale : 1.0;

  // 1. Duplicate with taper scale — automatically placed in the same parent
  const xfScale = new Transform();
  xfScale.makeScale(sX, sY);
  if (useTaper) xfScale.about(pivotX, pivotY);
  doc.executeCommand(
    DocumentCommand.createTransform(
      Selection.create(doc, originalNode),
      xfScale,
      { duplicateNodes: true },
    ),
  );
  const dupSel = doc.selection;
  const dupNode = [...dupSel.nodes][0];
  if (!dupNode) {
    console.log("WARNING: duplication failed at step " + i);
    continue;
  }

  // 2. Translate by the shadow offset
  const xfMove = new Transform();
  xfMove.makeTranslate(offsetX, offsetY);
  doc.executeCommand(DocumentCommand.createTransform(dupSel, xfMove));

  // 3. Colour overlay — live effect, keeps the node as vector
  const overlay = ColourOverlayLayerEffect.create();
  overlay.colour = shadowColour;
  overlay.opacity = 1.0;
  doc.executeCommand(
    DocumentCommand.createSetColourOverlayLayerEffect(dupSel, overlay, 0),
  );

  // 4. Gaussian blur — live effect, keeps the node as vector
  const blur = GaussianBlurLayerEffect.create();
  blur.radius = blurRadius;
  blur.enabled = true;
  doc.executeCommand(
    DocumentCommand.createSetGaussianBlurLayerEffect(dupSel, blur),
  );

  // 5. Layer opacity
  doc.executeCommand(DocumentCommand.createSetOpacity(dupSel, opacity));

  // Node remains as vector with live effects — no rasterization here
  shadowNodes.push(dupNode);
}

console.log("Shadow layers created: " + shadowNodes.length);
if (shadowNodes.length === 0) {
  console.log("No shadow layers were created.");
  return;
}

const origSel = Selection.create(doc, originalNode);

// ─── RASTERIZE MODE ──────────────────────────────────────────────────
// Strategy: move all shadow nodes into a temporary ContainerNode, then
// call rasteriseObjects on it — this produces exactly one RasterNode
// in the correct context without touching anything else in the document.
// This avoids mergeVisible(), which operates on the entire spread and
// would incorrectly include unrelated visible layers.
if (doRasterize) {
  // Create a temporary ContainerNode in the same context as the original
  const tmpDef = ContainerNodeDefinition.createDefault();
  const tmpBuilder = AddChildNodesCommandBuilder.create();
  tmpBuilder.addContainerNode(tmpDef);
  if (isInsideGroup) tmpBuilder.setInsertionTarget(parentNode);
  doc.executeCommand(tmpBuilder.createCommand(false, NodeChildType.Main));

  // Locate the newly created container in the correct context
  const siblings = isInsideGroup ? [...parentNode.children] : [...doc.layers];
  const tmpContainer = siblings.find(
    (l) => l.constructor.name === "ContainerNode",
  );

  // Move all shadow nodes into the temporary container
  doc.executeCommand(
    DocumentCommand.createMoveNodes(
      Selection.create(doc, shadowNodes),
      tmpContainer,
      NodeMoveType.Inside,
      NodeChildType.Main,
    ),
  );

  // Rasterize the container → produces 1 RasterNode in the same context
  const tmpSel = Selection.create(doc, tmpContainer);
  doc.executeCommand(
    DocumentCommand.createRasteriseObjects(tmpSel, false, false),
  );

  // The resulting RasterNode is now the active selection
  const rasterSel = doc.selection;
  doc.executeCommand(
    DocumentCommand.createSetDescription(rasterSel, "Directional Blur Shadow"),
  );

  // Position behind the original (Before → lower index → visually behind ✓)
  doc.executeCommand(
    DocumentCommand.createMoveNodes(
      rasterSel,
      originalNode,
      NodeMoveType.Before,
      null,
    ),
  );
  // ─── GROUP MODE: vector nodes grouped, fully editable ─────────────────
} else {
  // Create the ContainerNode in the same context as the original
  const containerDef = ContainerNodeDefinition.createDefault();
  const builder = AddChildNodesCommandBuilder.create();
  builder.addContainerNode(containerDef);
  if (isInsideGroup) builder.setInsertionTarget(parentNode);
  doc.executeCommand(builder.createCommand(false, NodeChildType.Main));

  // Locate the container in the correct context
  const siblings = isInsideGroup ? [...parentNode.children] : [...doc.layers];
  const containerNode = siblings.find(
    (l) => l.constructor.name === "ContainerNode",
  );

  if (containerNode) {
    // Move all shadow vector nodes into the group
    doc.executeCommand(
      DocumentCommand.createMoveNodes(
        Selection.create(doc, shadowNodes),
        containerNode,
        NodeMoveType.Inside,
        NodeChildType.Main,
      ),
    );

    const cSel = Selection.create(doc, containerNode);
    doc.executeCommand(
      DocumentCommand.createSetDescription(cSel, "Directional Blur Shadow"),
    );

    // Position behind the original (Before → lower index → visually behind ✓)
    doc.executeCommand(
      DocumentCommand.createMoveNodes(
        cSel,
        originalNode,
        NodeMoveType.Before,
        null,
      ),
    );
  }
}

// Return selection to the original object
doc.executeCommand(DocumentCommand.createSetSelection(origSel));

console.log("─── Done! ───");
const finalCtx = isInsideGroup ? [...parentNode.children] : [...doc.layers];
finalCtx.forEach((l, i) => {
  const kids = l.children ? [...l.children].length : 0;
  console.log(
    "[" +
      i +
      "] " +
      l.constructor.name +
      ": '" +
      l.description +
      "'" +
      (kids ? " (" + kids + " children)" : ""),
  );
});
console.log("✓ Directional Blur Shadow placed behind the object");
console.log("✓ Original object is in front and selected");
