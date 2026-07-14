/**
 * name: Directional Blur Shadow
 * description: Directional Blur Shadow creates a directional shadow of an object that progressively blurs, fades and tapers as it moves away from the object. Direction is a free angle (0°=right, 90°=down). Layer opacity is exponentially normalized so more layers never darken the shadow, plus an overall darkness factor to darken/lighten the whole shadow smoothly.
 * version: 1.4.1 (darkness factor order fixed)
 * author: rbonelli (fixes + angle parameter + opacity fix + darkness factor: Claude)
 */

// =====================================================================
// DIRECTIONAL BLUR SHADOW  v3.0 (fixed, angle-based direction, exp. opacity,
//                                overall darkness factor)
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
//
// FIX (transform API): Transform.makeScale()/.makeTranslate()/.about() don't
//      exist in the current SDK - replaced with .scale()/.translate()/.around().
//      These were the calls throwing TypeErrors on every Preview/Apply click.
//      Taper checkbox now uses setOnValueChangedHandler(). Numeric fields get
//      proper UnitType enums (Pixel/Percentage/Degree/Number) instead of
//      ignored string units, and explicit default values (the SDK ignores
//      the initial-value parameter of addUnitValueEditor).
//
// CHANGE (direction): The 8 fixed direction combo box was replaced with a free
//      angle parameter in degrees (0°=right, 90°=down, clockwise on screen).
//      Taper scaling now works for any angle by rotating into a frame aligned
//      with the shadow direction, scaling perpendicular to it, and rotating
//      back around the pivot - this also fixes the old diagonal-direction
//      taper approximation, which only did uniform scaling.
//
// FIX (opacity distribution): Increasing the layer count used to darken the
//      shadow, because each layer's opacity was set directly to the linear
//      target value (opStart -> opEnd), and these semi-transparent layers
//      overlap heavily near the object. Alpha-over compositing of many such
//      layers saturates toward full opacity as the layer count grows. Fixed
//      by normalizing each layer's opacity exponentially (the correct
//      alpha-compositing law, analogous to the Beer-Lambert law for light
//      attenuation through N layers):
//        rawOpacity = 1 - (1 - targetOpacity) ^ (1 / steps)
//      This guarantees the cumulative composited opacity converges to the
//      intended target regardless of how many layers are used - more layers
//      now only make the gradient smoother, never darker.
//
// ADD (overall darkness factor): a new "Overall darkness (%)" field under
//      "End opacity" scales the whole shadow's opacity by a single factor
//      (10-300%, default 100%).
//
// FIX (darkness factor order): the darkness factor is applied AFTER the
//      exponential normalization above (opacity = min(1, rawOpacity *
//      darkness)), not before it on the raw target opacity. Applying it
//      before caused many near-object layers (whose target opacity is
//      already close to opStart) to get clamped to exactly 1.0 at higher
//      darkness values, creating a flat "fully opaque" plateau followed by
//      an abrupt drop-off once past the clamp - the "extremely dark near
//      the object, then a steep cliff" artifact. Scaling the already-smooth
//      per-layer curve afterwards keeps the falloff monotonic and smooth.
//
// New defaults: Angle 30°, Start opacity 100%, End opacity 30%,
//               Taper size at tip 90%.
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
const { UnitType } = require("/units.js");
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
let defAngle       = 30;
let defDistance    = 150;
let defSteps       = 10;
let defBlurMax     = 25;
let defColour      = RGBA8(0, 0, 0, 255);
let defOpStart     = 100;
let defOpEnd       = 30;
let defDarkness    = 100;
let defTaperOn     = false;
let defTaperEnd    = 90;
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
    angle, distance, steps, blurMax,
    shadowColour, opStart, opEnd, darkness,
    useTaper, taperEnd,
  } = params;

  // 0° = right, 90° = down (clockwise on screen, since the y-axis points down)
  const angleRad   = (angle * Math.PI) / 180;
  const nx         = Math.cos(angleRad);
  const ny         = Math.sin(angleRad);

  const bounds     = originalNode.spreadVisibleBox;
  const cx         = bounds.x + bounds.width  / 2;
  const cy         = bounds.y + bounds.height / 2;
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
    // Target opacity along the distance (linear ramp opStart -> opEnd).
    // NOT used directly as the layer's own opacity: since layers overlap
    // heavily under alpha-over compositing, that would saturate towards
    // full darkness as the layer count grows. Instead, normalize each
    // layer's opacity exponentially (the alpha-compositing law, analogous
    // to the Beer-Lambert law), so the cumulative composited opacity stays
    // at the intended target regardless of step count:
    //   1 - (1 - rawOpacity)^steps == targetOpacity
    //
    // The overall darkness factor is deliberately applied AFTER this
    // normalization (not before, on the raw target): applying it before
    // would push many near-object layers (whose target opacity is already
    // close to opStart) to hit the 0..1 clamp exactly at higher darkness
    // values - all becoming fully opaque (a flat "plateau"), followed by an
    // abrupt drop-off for the layers past the clamp. That's exactly the
    // "extremely dark near the object, then a steep cliff" artifact.
    // Scaling the already-smooth per-layer curve afterwards keeps the
    // falloff monotonic and smooth.
    const targetOpacity = opStart + (opEnd - opStart) * t;
    const rawOpacity = 1 - Math.pow(1 - Math.min(1, Math.max(0, targetOpacity)), 1 / steps);
    const opacity = Math.min(1, rawOpacity * darkness);
    const perpScale  = 1.0 + (taperEnd - 1.0) * t;

    // Taper perpendicular to the shadow direction, for any angle: rotate
    // into a frame aligned with the direction, scale perpendicular to it,
    // rotate back, anchored around the pivot.
    const xfScale = new Transform();
    if (useTaper) {
      xfScale.rotate(-angleRad);
      xfScale.scale(1.0, perpScale);
      xfScale.rotate(angleRad);
      xfScale.around(pivotX, pivotY);
    }
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
    xfMove.translate(offsetX, offsetY);
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

  const grpDir      = col.addGroup("Direction");
  const angleEditor = grpDir.addUnitValueEditor(
    "Angle (0°=right, 90°=down)", UnitType.Degree, UnitType.Degree, defAngle, 0, 360,
  );
  angleEditor.value = defAngle;

  const grpParam    = col.addGroup("Parameters");
  const distEditor  = grpParam.addUnitValueEditor("Total distance (px)", UnitType.Pixel, UnitType.Pixel, defDistance, 10, 2000);
  const stepsEditor = grpParam.addUnitValueEditor("Number of layers",    UnitType.Number, UnitType.Number, defSteps,    3,  30);
  const blurEditor  = grpParam.addUnitValueEditor("Max blur (px)",       UnitType.Pixel, UnitType.Pixel, defBlurMax,  1,  300);
  // addUnitValueEditor ignores the initial-value parameter (always starts at 0) - set explicitly:
  distEditor.value  = defDistance;
  stepsEditor.value = defSteps;
  blurEditor.value  = defBlurMax;

  const grpFx         = col.addGroup("Shadow appearance");
  const colorPicker   = grpFx.addColourPicker("Shadow colour", defColour);
  const opStartEditor = grpFx.addUnitValueEditor("Start opacity (%)", UnitType.Percentage, UnitType.Percentage, defOpStart, 1, 100);
  const opEndEditor   = grpFx.addUnitValueEditor("End opacity (%)",   UnitType.Percentage, UnitType.Percentage, defOpEnd,   0, 100);
  const darknessEditor = grpFx.addUnitValueEditor("Overall darkness (%)", UnitType.Percentage, UnitType.Percentage, defDarkness, 10, 300);
  opStartEditor.value = defOpStart;
  opEndEditor.value   = defOpEnd;
  darknessEditor.value = defDarkness;

  const grpTaper  = col.addGroup("Taper (Narrow / Expand)");
  const taperCheck  = grpTaper.addCheckBox("Enable taper", defTaperOn);
  const taperEditor = grpTaper.addUnitValueEditor("Size at tip (%)", UnitType.Percentage, UnitType.Percentage, defTaperEnd, 1, 500);
  taperEditor.value = defTaperEnd;
  taperEditor.isEnabled = defTaperOn;

  taperCheck.setOnValueChangedHandler(() => {
    taperEditor.isEnabled = taperCheck.value;
  });

  const grpOutput   = col.addGroup("Output");
  const rasterCheck = grpOutput.addCheckBox("Rasterize into a single layer", defRasterize);

  const grpActions = col.addGroup("");
  const actionBtns = grpActions.addButtonSet("", ["▶ Preview", "✓ Apply"], 0);

  const result = dlg.runModal();

  defAngle     = angleEditor.value;
  defDistance  = distEditor.value;
  defSteps     = Math.max(3, Math.round(stepsEditor.value));
  defBlurMax   = blurEditor.value;
  defColour    = colorPicker.value || RGBA8(0, 0, 0, 255);
  defOpStart   = opStartEditor.value;
  defOpEnd     = opEndEditor.value;
  defDarkness  = darknessEditor.value;
  defTaperOn   = taperCheck.value;
  defTaperEnd  = taperEditor.value;
  defRasterize = rasterCheck.value;

  const params = {
    angle:        defAngle,
    distance:     defDistance,
    steps:        defSteps,
    blurMax:      defBlurMax,
    shadowColour: defColour,
    opStart:      defOpStart / 100,
    opEnd:        defOpEnd   / 100,
    darkness:     defDarkness / 100,
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
  angle:        defAngle,
  distance:     defDistance,
  steps:        defSteps,
  blurMax:      defBlurMax,
  shadowColour: defColour,
  opStart:      defOpStart / 100,
  opEnd:        defOpEnd   / 100,
  darkness:     defDarkness / 100,
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
