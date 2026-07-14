/**
 * name: Directional Blur Shadow
 * description: Directional Blur Shadow creates a directional shadow of an object that progressively blurs, fades and tapers as it moves away from the object.
 * version: 1.1.0
 * author: rbonelli
 */

// =====================================================================
// DIRECTIONAL BLUR SHADOW  v3.0
//
// v3.0: Substitui o onControlValueChangedHandler (que causava crash com
//       mudanças rápidas) pelo padrão "dialog loop":
//
//       O diálogo tem um botão "▶ Preview" e um "✓ Apply".
//       – Preview: rebuilda o preview sob demanda (sem handlers async).
//       – Apply:   descarta o preview e commita o resultado final.
//       – Cancel:  descarta o preview e sai sem alterar o documento.
//
//       Isso elimina completamente a reentrância que causava o crash.
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
if (initialItems.length > 1) {
  console.log("WARNING: Multiple objects selected. Only the first will be used.");
}
const originalNode  = initialItems[0];
const parentNode    = originalNode.parent;
const isInsideGroup = parentNode.constructor.name !== "SpreadNode";

console.log(
  "Context: " +
    (isInsideGroup
      ? "inside group '" + parentNode.description + "'"
      : "root spread"),
);

// ─── Dialog ───────────────────────────────────────────────────────────
let defDirIndex    = 0;
let defDistance    = 150;
let defSteps       = 10;
let defBlurMax     = 25;
let defColour      = RGBA8(0, 0, 0, 255);
let defOpStart     = 75;
let defOpEnd       = 0;
let defTaperOn     = false;
let defTaperEnd    = 10;
let defRasterize   = true;

// ─── Preview state ────────────────────────────────────────────────────
let previewContainer = null;

// ─── Helper: delete the current preview group ─────────────────────────
function clearPreview() {
  if (!previewContainer) return;
  try {
    doc.executeCommand(
      DocumentCommand.createDeleteSelection(
        Selection.create(doc, previewContainer),
        true,
      ),
    );
  } catch (e) {}
  previewContainer = null;
}

// ─── Helper: find siblings in the correct context ─────────────────────
function getSiblings() {
  return isInsideGroup ? [...parentNode.children] : [...doc.layers];
}

// ─── Core: build shadow and return the ContainerNode ─────────────────
function buildShadow(params) {
  const {
    dirIndex, distance, steps, blurMax,
    shadowColour, opStart, opEnd,
    useTaper, taperEnd,
  } = params;

  const dirs = [
    [1, 0], [-1, 0], [0, 1],  [0, -1],
    [1, 1], [-1, 1], [1, -1], [-1, -1],
  ];
  const [dx, dy]   = dirs[dirIndex];
  const mag        = Math.sqrt(dx * dx + dy * dy);
  const nx         = dx / mag;
  const ny         = dy / mag;

  const bounds     = originalNode.spreadVisibleBox;
  const cx         = bounds.x + bounds.width  / 2;
  const cy         = bounds.y + bounds.height / 2;
  const isDiag     = nx !== 0 && ny !== 0;
  const scaleAxisX = isDiag ? 1 : Math.abs(ny);
  const scaleAxisY = isDiag ? 1 : Math.abs(nx);
  const expanding  = taperEnd > 1.0;
  const pivotSign  = expanding ? 1 : -1;
  const pivotX     = cx + pivotSign * nx * (bounds.width  / 2);
  const pivotY     = cy + pivotSign * ny * (bounds.height / 2);

  const shadowNodes = [];
  for (let i = steps; i >= 1; i--) {
    const t          = i / steps;
    const offsetX    = nx * distance * t;
    const offsetY    = ny * distance * t;
    const blurRadius = blurMax * t;
    const opacity    = opStart + (opEnd - opStart) * t;
    const perpScale  = 1.0 + (taperEnd - 1.0) * t;
    const sX         = useTaper && scaleAxisX > 0 ? perpScale : 1.0;
    const sY         = useTaper && scaleAxisY > 0 ? perpScale : 1.0;

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
    const dupNode = [...doc.selection.nodes][0];
    if (!dupNode) {
      console.log("WARNING: duplication failed at step " + i);
      continue;
    }

    const xfMove = new Transform();
    xfMove.makeTranslate(offsetX, offsetY);
    doc.executeCommand(DocumentCommand.createTransform(doc.selection, xfMove));

    const overlay   = ColourOverlayLayerEffect.create();
    overlay.colour  = shadowColour;
    overlay.opacity = 1.0;
    doc.executeCommand(
      DocumentCommand.createSetColourOverlayLayerEffect(doc.selection, overlay, 0),
    );

    const blur   = GaussianBlurLayerEffect.create();
    blur.radius  = blurRadius;
    blur.enabled = true;
    doc.executeCommand(
      DocumentCommand.createSetGaussianBlurLayerEffect(doc.selection, blur),
    );

    doc.executeCommand(DocumentCommand.createSetOpacity(doc.selection, opacity));

    shadowNodes.push(dupNode);
  }

  if (shadowNodes.length === 0) return null;

  const containerDef = ContainerNodeDefinition.createDefault();
  const builder      = AddChildNodesCommandBuilder.create();
  builder.addContainerNode(containerDef);
  if (isInsideGroup) builder.setInsertionTarget(parentNode);
  doc.executeCommand(builder.createCommand(false, NodeChildType.Main));

  const siblings   = getSiblings();
  const containers = siblings.filter(l => l.constructor.name === "ContainerNode");
  const container  = containers[containers.length - 1];
  if (!container) {
    console.log("ERROR: Could not locate the new ContainerNode.");
    return null;
  }

  doc.executeCommand(
    DocumentCommand.createMoveNodes(
      Selection.create(doc, shadowNodes),
      container,
      NodeMoveType.Inside,
      NodeChildType.Main,
    ),
  );

  const cSel = Selection.create(doc, container);
  doc.executeCommand(
    DocumentCommand.createSetDescription(cSel, "Directional Blur Shadow"),
  );
  doc.executeCommand(
    DocumentCommand.createMoveNodes(cSel, originalNode, NodeMoveType.Before, null),
  );

  return container;
}

// ─── Dialog loop ──────────────────────────────────────────────────────
let applyResult = false;

while (true) {
  const dlg = Dialog.create("Directional Blur Shadow");
  dlg.initialWidth = 340;
  const col = dlg.addColumn();

  const grpDir   = col.addGroup("Direction");
  const dirCombo = grpDir.addComboBox(
    "Blur direction",
    ["→ Right","← Left","↓ Down","↑ Up","↘ Right + Down","↙ Left + Down","↗ Right + Up","↖ Left + Up"],
    defDirIndex,
  );

  const grpParam    = col.addGroup("Parameters");
  const distEditor  = grpParam.addUnitValueEditor("Total distance (px)", "px", "px", defDistance, 10, 2000);
  const stepsEditor = grpParam.addUnitValueEditor("Number of layers",    "px", "px", defSteps,    3,  30);
  const blurEditor  = grpParam.addUnitValueEditor("Max blur (px)",       "px", "px", defBlurMax,  1,  300);

  const grpFx         = col.addGroup("Shadow appearance");
  const colorPicker   = grpFx.addColourPicker("Shadow colour", defColour);
  const opStartEditor = grpFx.addUnitValueEditor("Start opacity (%)", "px", "px", defOpStart, 1, 100);
  const opEndEditor   = grpFx.addUnitValueEditor("End opacity (%)",   "px", "px", defOpEnd,   0, 100);

  const grpTaper  = col.addGroup("Taper (Narrow / Expand)");
  const taperCheck  = grpTaper.addCheckBox("Enable taper", defTaperOn);
  const taperEditor = grpTaper.addUnitValueEditor("Size at tip (%)", "px", "px", defTaperEnd, 1, 500);
  taperEditor.isEnabled = defTaperOn;

  dlg.onControlValueChangedHandler = () => {
    taperEditor.isEnabled = taperCheck.value;
  };

  const grpOutput   = col.addGroup("Output");
  const rasterCheck = grpOutput.addCheckBox("Rasterize into a single layer", defRasterize);

  const grpActions = col.addGroup("");
  const actionBtns = grpActions.addButtonSet("", ["▶ Preview", "✓ Apply"], 0);

  const result = dlg.runModal();

  defDirIndex  = dirCombo.selectedIndex;
  defDistance  = distEditor.value;
  defSteps     = Math.max(3, Math.round(stepsEditor.value));
  defBlurMax   = blurEditor.value;
  defColour    = colorPicker.value || RGBA8(0, 0, 0, 255);
  defOpStart   = opStartEditor.value;
  defOpEnd     = opEndEditor.value;
  defTaperOn   = taperCheck.value;
  defTaperEnd  = taperEditor.value;
  defRasterize = rasterCheck.value;

  const params = {
    dirIndex:     defDirIndex,
    distance:     defDistance,
    steps:        defSteps,
    blurMax:      defBlurMax,
    shadowColour: defColour,
    opStart:      defOpStart / 100,
    opEnd:        defOpEnd   / 100,
    useTaper:     defTaperOn,
    taperEnd:     defTaperEnd / 100,
    doRasterize:  defRasterize,
  };

  if (result.value !== DialogResult.Ok.value) {
    clearPreview();
    doc.executeCommand(
      DocumentCommand.createSetSelection(Selection.create(doc, originalNode)),
    );
    console.log("Cancelled.");
    return;
  }

  const btnPressed = actionBtns.selectedIndex;

  if (btnPressed === 0) {
    clearPreview();
    previewContainer = buildShadow(params);
    doc.executeCommand(
      DocumentCommand.createSetSelection(Selection.create(doc, originalNode)),
    );
    console.log("Preview updated.");
    continue;
  }

  applyResult = true;
  break;
}

// ─── Commit ───────────────────────────────────────────────────────────
if (!applyResult) return;

clearPreview();

const finalParams = {
  dirIndex:     defDirIndex,
  distance:     defDistance,
  steps:        defSteps,
  blurMax:      defBlurMax,
  shadowColour: defColour,
  opStart:      defOpStart / 100,
  opEnd:        defOpEnd   / 100,
  useTaper:     defTaperOn,
  taperEnd:     defTaperEnd / 100,
  doRasterize:  defRasterize,
};

const shadowGroup = buildShadow(finalParams);

if (!shadowGroup) {
  console.log("No shadow layers were created.");
  return;
}

if (finalParams.doRasterize) {
  const groupSel = Selection.create(doc, shadowGroup);
  doc.executeCommand(
    DocumentCommand.createRasteriseObjects(groupSel, false, false),
  );
  const rasterSel = doc.selection;
  doc.executeCommand(
    DocumentCommand.createSetDescription(rasterSel, "Directional Blur Shadow"),
  );
  doc.executeCommand(
    DocumentCommand.createMoveNodes(
      rasterSel,
      originalNode,
      NodeMoveType.Before,
      null,
    ),
  );
}

doc.executeCommand(
  DocumentCommand.createSetSelection(Selection.create(doc, originalNode)),
);

console.log("─── Done! ───");
const finalCtx = isInsideGroup ? [...parentNode.children] : [...doc.layers];
finalCtx.forEach((l, i) => {
  const kids = l.children ? [...l.children].length : 0;
  console.log(
    "[" + i + "] " + l.constructor.name +
    ": '" + l.description + "'" +
    (kids ? " (" + kids + " children)" : ""),
  );
});
console.log("✓ Directional Blur Shadow placed behind the object");
console.log("✓ Original object is in front and selected");
