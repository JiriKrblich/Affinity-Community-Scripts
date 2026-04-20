/**
 * name: Custom Gradient Map v1
 * description: Creates a custom gradient map based on a selected gradient swatch.
 * version: 1.0.0
 * author: RE4LLY
 */

"use strict";
// ═══════════════════════════════════════════════════════════
//  CUSTOM GRADIENT MAP v1 by RE4LLY
//  Run this script and select a gradient swatch in the UI Panel to turn it into a custom gradient map.
//  - needs to have a document open to run
//  - only works with a gradient
//  - outputs a Container Layer named "Custom Gradient Map" containing a Curve
//    and a BW Adjustment Layer to simulate the effect of the Gradient Map Adjustment Layer.
// ═══════════════════════════════════════════════════════════

const { app } = require("/application");
const { Document } = require("/document");
const { Dialog, DialogResult } = require("/dialog");
const { Colour, Gradient } = require("/colours");
const { GradientFill, FillType } = require("/fills");
const { GradientFillType } = require("affinity:fills");
const { Spline } = require("/geometry");
const {
  CurvesAdjustmentParameters,
  CurvesAdjustmentRasterNodeDefinition,
  BlackAndWhiteAdjustmentRasterNodeDefinition,
  ContainerNodeDefinition,
} = require("/nodes");
const {
  AddChildNodesCommandBuilder,
  DocumentCommand,
  InsertionMode,
} = require("/commands");

//── 1. Validate the document ──────────────────────────────────

const docCheck = app.documents.all[0];
if (!docCheck) {
  const errorDlg1 = Dialog.create("Script Error");
  errorDlg1.initialWidth = 360;
  const col1 = errorDlg1.addColumn();
  const infoGrp1 = col1.addGroup("No document is open.");
  infoGrp1
    .addStaticText("", "Please select a document to open to continue.")
    .setIsFullWidth(true);
  const errorResult1 = errorDlg1.show();
  if (errorResult1.value === DialogResult.Ok.value) {
    const filePath = app.chooseFile();
    if (filePath) {
      Document.load(filePath);
    }
  }
}

//── 2. ── Get doc first (must be before createDefault calls) ───────────────────────
const doc = Document.current;
const spread = doc.currentSpread;
doc.executeCommand(DocumentCommand.createSetCurrentSpread(spread));

// ── 3. Show the fill-editor dialog ──────────────────────────────────────────
const defaultGradient = Gradient.create([
  {
    colour: Colour.createRGBA8({ r: 0, g: 0, b: 0, alpha: 255 }),
    position: 0,
    midpoint: 0.5,
  },
  {
    colour: Colour.createRGBA8({ r: 255, g: 255, b: 255, alpha: 255 }),
    position: 1,
    midpoint: 0.5,
  },
]);
const defaultFill = GradientFill.create(
  defaultGradient,
  GradientFillType.Linear,
);

const dialog = Dialog.create("Custom Gradient Map V1");
dialog.initialWidth = 360;
const fillEditor = dialog
  .addColumn()
  .addGroup("Select a Gradient")
  .addFillEditor(
    "Select a gradient swatch to use as the custom gradient map.",
    defaultFill,
  );
fillEditor.setIsFullWidth(true);

const result = dialog.runModal();
if (result.value !== DialogResult.Ok.value) throw new Error("Cancelled.");

const fill = fillEditor.fill;
if (!fill || fill.fillType.value !== FillType.Gradient.value) {
  const errorDlg2 = Dialog.create("Script Error");
  errorDlg2.initialWidth = 360;
  const col2 = errorDlg2.addColumn();
  const errorGrp2 = col2.addGroup("Selected fill is not a gradient.");
  errorGrp2
    .addStaticText(
      "",
      "Please select a gradient when running this script again",
    )
    .setIsFullWidth(true);
  const result = errorDlg2.show();
}

// ── 4. Extract gradient stops ────────────────────────────────────────────────
const stopCount = fill.gradient.stopCount;
const stops = [];
for (let i = 0; i < stopCount; i++) {
  const s = fill.gradient.getStop(i);
  const rgba = new Colour(s.colour).getRGBA8(false);
  stops.push({
    pos: s.position,
    r: rgba.r / 255,
    g: rgba.g / 255,
    b: rgba.b / 255,
  });
}
if (stops[0].pos > 0.001) stops.unshift({ pos: 0, ...stops[0] });
if (stops.at(-1).pos < 0.999) stops.push({ pos: 1, ...stops.at(-1) });

function makeSpline(ch) {
  const spline = Spline.create();
  for (const s of stops) spline.insertPointXY(s.pos, s[ch]);
  return spline;
}

// ── 5. Build adjustment definitions ─────────────────────────────────────────
const curvesParams = CurvesAdjustmentParameters.create();
curvesParams.setChannelSpline(0, makeSpline("r"));
curvesParams.setChannelSpline(1, makeSpline("g"));
curvesParams.setChannelSpline(2, makeSpline("b"));
const curvesDef = CurvesAdjustmentRasterNodeDefinition.createDefault(doc);
curvesDef.parameters = curvesParams;
const bwDef = BlackAndWhiteAdjustmentRasterNodeDefinition.createDefault();

// ── 6. Create "Gradient Map" Container Layer (creating groups is curently not supported by the SDK) at bottom of layer stack ──────────────────
const builder = AddChildNodesCommandBuilder.create();
builder.setInsertionTarget(spread);
builder.setInsertionMode(InsertionMode.Inside_AtFront);

const groupDef = ContainerNodeDefinition.createDefault();
groupDef.userDescription = "Custom Gradient Map";
builder.addContainerNode(groupDef);
const groupCmd = builder.createCommandAndReset(true);
doc.executeCommand(groupCmd);
const groupNode = groupCmd.newNodes[0];

// ── 7. B&W at bottom of Container Layer ────────────────────────────────────────────────
builder.setInsertionTarget(groupNode);
builder.setInsertionMode(InsertionMode.Inside_AtFront);
builder.addBlackAndWhiteAdjustmentRasterNode(bwDef);
const bwCmd = builder.createCommandAndReset(true);
doc.executeCommand(bwCmd);
const bwNode = bwCmd.newNodes[0];

// ── 8. Curves above B&W ──────────────────────────────────────────────────────
builder.setInsertionTarget(groupNode);
builder.addCurvesAdjustmentRasterNode(curvesDef);
doc.executeCommand(builder.createCommand(true));

console.log(
  `✓ "Gradient Map" group added at the bottom with ${stopCount} stop${stopCount !== 1 ? "s" : ""}.`,
);
