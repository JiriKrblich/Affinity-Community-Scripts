/**
 * Block Shadow Tool v4
 * Fixed: preview undo now reliably removes the previous shadow before generating new one.
 * Preview never groups (keeps it as single undoable command).
 * Apply commits final version with grouping.
 
 * name: Vector Block Shadow Tool 3.0.1
 * description: Replicate the Block Shadow functionality from CorelDRAW by generating a solid, 2D vector extrusion from a source object. Unlike a drop shadow, this must result in a flat vector path capable of being sent to a plotter or vinyl cutter.
 * version: 1.4.1
 * author: jn-373*/

// v1.4.1 – SDK compatibility update for the current Affinity version:
//   * PolyCurveNodeDefinition.create(curve, brushFill, lineFill, lineStyle, transparencyFill)
//     (lineFill/lineStyle order swapped in the SDK -> no shadow was created)
//   * Unit strings "mm" / "°" / "%" -> UnitType values, explicit start values
//   * createMoveNodes() now gets its required NodeChildType argument
//   * Preview removal by deleting the tracked preview shadows (the step-counting
//     createUndo() no longer removed the preview -> shadows piled up); preview shadows are added
//     with individual commands (newNodes of commands inside a compound throws
//     INVALID_OP, which broke "Punch out" in the preview)
//   * CurveBuilder / PolyCurve via .create()

const { Document } = require("/document");
const {
  DocumentCommand,
  AddChildNodesCommandBuilder,
  InsertionMode,
  NodeMoveType,
  NodeChildType,
  CompoundCommandBuilder,
} = require("/commands");
const { PolyCurveNodeDefinition, ContainerNodeDefinition } = require("/nodes");
const { PolyCurve, CurveBuilder } = require("/geometry");
const { Colour } = require("/colours");
const { FillDescriptor, SolidFill } = require("/fills");
const { LineStyle, LineStyleDescriptor } = require("/linestyle");
const { Dialog, DialogResult } = require("/dialog");
const { Selection } = require("/selections");
const { UnitType } = require("/units");

// ── Geometry ─────────────────────────────────────────────────────────────────

function cross(O, A, B) {
  return (A.x - O.x) * (B.y - O.y) - (A.y - O.y) * (B.x - O.x);
}

function convexHull(points) {
  if (points.length < 3) return points;
  const sorted = points
    .slice()
    .sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));
  const lower = [];
  for (const p of sorted) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0
    )
      lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0
    )
      upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function sampleCurve(c, samplesPerSeg) {
  const pts = [];
  const nodes = c.nodes;
  const onCurveIdx = [];
  for (let j = 0; j < nodes.length; j++) {
    const t = nodes[j].type?.value;
    if (t === 0 || t === 3) onCurveIdx.push(j);
  }
  for (const idx of onCurveIdx) {
    try {
      const bez = c.getCubicBezier(idx);
      if (!bez || !bez.start) continue;
      for (let k = 0; k < samplesPerSeg; k++) {
        const t = k / samplesPerSeg;
        const mt = 1 - t;
        pts.push({
          x:
            mt * mt * mt * bez.start.x +
            3 * mt * mt * t * bez.c1.x +
            3 * mt * t * t * bez.c2.x +
            t * t * t * bez.end.x,
          y:
            mt * mt * mt * bez.start.y +
            3 * mt * mt * t * bez.c1.y +
            3 * mt * t * t * bez.c2.y +
            t * t * t * bez.end.y,
        });
      }
    } catch (e) {}
  }
  return pts;
}

function getNodePoints(node, samplesPerSeg) {
  const allPts = [];
  try {
    const ci = node.curvesInterface;
    if (ci) {
      const pc = ci.polyCurve;
      const cloned = pc.clone();
      cloned.transform(node.baseToSpreadTransform);
      for (let i = 0; i < cloned.curveCount; i++) {
        allPts.push(...sampleCurve(cloned.at(i), samplesPerSeg));
      }
    }
  } catch (e) {}
  if (allPts.length === 0) {
    const bb = node.getSpreadBaseBox(false);
    allPts.push(
      { x: bb.x, y: bb.y },
      { x: bb.x + bb.width, y: bb.y },
      { x: bb.x + bb.width, y: bb.y + bb.height },
      { x: bb.x, y: bb.y + bb.height },
    );
  }
  return allPts;
}

function buildShadowPC(sourcePts, dx, dy, doPunch, sourceNode) {
  const offsetPts = sourcePts.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  const hull = convexHull(sourcePts.concat(offsetPts));
  if (hull.length < 3) return null;
  const cb = CurveBuilder.create();
  cb.beginXY(hull[0].x, hull[0].y);
  for (let i = 1; i < hull.length; i++) cb.lineToXY(hull[i].x, hull[i].y);
  cb.close();
  const pc = PolyCurve.create();
  pc.addCurve(cb.createCurve());
  if (doPunch) {
    try {
      const ci = sourceNode.curvesInterface;
      if (ci) {
        const cloned = ci.polyCurve.clone();
        cloned.transform(sourceNode.baseToSpreadTransform);
        if (cloned.curveCount > 0) pc.addCurve(cloned.at(0));
      } else {
        const bb = sourceNode.getSpreadBaseBox(false);
        const cb2 = CurveBuilder.create();
        cb2.beginXY(bb.x, bb.y);
        cb2.lineToXY(bb.x + bb.width, bb.y);
        cb2.lineToXY(bb.x + bb.width, bb.y + bb.height);
        cb2.lineToXY(bb.x, bb.y + bb.height);
        cb2.close();
        pc.addCurve(cb2.createCurve());
      }
    } catch (e) {}
  }
  return pc;
}

// Preview: inserts the shadow nodes and RETURNS them, so the preview can be
// removed again by deleting exactly these nodes (see removePreview in main).
// Note: nodes created inside a CompoundCommand cannot be referenced afterwards
// (newNodes throws INVALID_OP), so each shadow is added with its own command.
function applyPreview(doc, nodes, params) {
  const created = [];
  const { dx, dy, brushFill, doPunch } = params;
  const lsd = LineStyleDescriptor.create(LineStyle.createDefault(), {});
  const SAMPLES = 8;

  for (const node of nodes) {
    try {
      const srcPts = getNodePoints(node, SAMPLES);
      const shadowPC = buildShadowPC(srcPts, dx, dy, doPunch, node);
      if (!shadowPC) continue;

      const def = PolyCurveNodeDefinition.create(
        shadowPC,
        brushFill,
        FillDescriptor.createNone(), // lineFill
        lsd, // lineStyle  (SDK order: curve, brush, lineFill, lineStyle, transparency)
        FillDescriptor.createNone(),
      );
      def.userDescription = "Block Shadow";

      const addBuilder = AddChildNodesCommandBuilder.create();
      addBuilder.addPolyCurveNode(def);
      addBuilder.setInsertionTarget(node);
      addBuilder.setInsertionMode(InsertionMode.Behind);
      addBuilder.clearCurrentSelection = true;
      const addCmd = addBuilder.createCommand(false);
      doc.executeCommand(addCmd);

      const shadowNode = addCmd.newNodes?.[0];
      if (shadowNode) created.push(shadowNode);

      if (doPunch) {
        if (shadowNode) {
          doc.executeCommand(
            DocumentCommand.createSetWindingMode(
              Selection.create(doc, shadowNode),
              1,
            ),
          );
        }
      }
    } catch (e) {
      console.log("Preview build err:", e.message);
    }
  }
  return created;
}

// Apply final: full version with grouping, each node is its own compound
function applyFinal(doc, nodes, params) {
  const { dx, dy, brushFill, doPunch, doGroup } = params;
  const lsd = LineStyleDescriptor.create(LineStyle.createDefault(), {});
  const SAMPLES = 8;

  for (const node of nodes) {
    try {
      const srcPts = getNodePoints(node, SAMPLES);
      const shadowPC = buildShadowPC(srcPts, dx, dy, doPunch, node);
      if (!shadowPC) continue;

      const def = PolyCurveNodeDefinition.create(
        shadowPC,
        brushFill,
        FillDescriptor.createNone(), // lineFill
        lsd, // lineStyle  (SDK order: curve, brush, lineFill, lineStyle, transparency)
        FillDescriptor.createNone(),
      );
      def.userDescription = "Block Shadow";

      const addBuilder = AddChildNodesCommandBuilder.create();
      addBuilder.addPolyCurveNode(def);
      addBuilder.setInsertionTarget(node);
      addBuilder.setInsertionMode(InsertionMode.Behind);
      addBuilder.clearCurrentSelection = true;
      const addCmd = addBuilder.createCommand(false);
      doc.executeCommand(addCmd);
      const shadowNode = addCmd.newNodes?.[0];
      if (!shadowNode) continue;

      if (doPunch) {
        doc.executeCommand(
          DocumentCommand.createSetWindingMode(
            Selection.create(doc, shadowNode),
            1,
          ),
        );
      }

      if (doGroup) {
        const groupDef = ContainerNodeDefinition.create(
          node.description + " + Shadow",
        );
        const grpBuilder = AddChildNodesCommandBuilder.create();
        grpBuilder.addContainerNode(groupDef);
        grpBuilder.setInsertionTarget(node);
        grpBuilder.setInsertionMode(InsertionMode.Behind);
        grpBuilder.clearCurrentSelection = true;
        const grpCmd = grpBuilder.createCommand(false);
        doc.executeCommand(grpCmd);
        const groupNode = grpCmd.newNodes?.[0];
        if (groupNode) {
          doc.executeCommand(
            DocumentCommand.createMoveNodes(
              Selection.create(doc, shadowNode),
              groupNode,
              NodeMoveType.Inside,
              NodeChildType.Main,
            ),
          );
          doc.executeCommand(
            DocumentCommand.createMoveNodes(
              Selection.create(doc, node),
              groupNode,
              NodeMoveType.Inside,
              NodeChildType.Main,
            ),
          );
        }
      }
    } catch (e) {
      console.log("Apply err:", e.message);
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const doc = Document.current;
if (!doc) {
  console.log("No document open.");
} else {
  const nodes = [];
  for (const item of doc.selection.items) {
    if (item.node) nodes.push(item.node);
  }

  if (nodes.length === 0) {
    const dlg = Dialog.create("Block Shadow");
    dlg
      .addColumn()
      .addGroup("")
      .addStaticText("", "Please select at least one object, then run again.");
    dlg.runModal();
  } else {
    const dlg = Dialog.create("Block Shadow");
    dlg.initialWidth = 380;
    const col = dlg.addColumn();

    const projGrp = col.addGroup("Projection");
    const distEd = projGrp.addUnitValueEditor(
      "Distance (mm)",
      UnitType.Number,
      UnitType.Number,
      10,
      0,
      200,
    );
    distEd.value = 10;
    distEd.precision = 1;
    distEd.showPopupSlider = true;
    const angleEd = projGrp.addUnitValueEditor(
      "Angle (°)  0=right  90=down",
      UnitType.Number,
      UnitType.Number,
      45,
      0,
      360,
    );
    angleEd.value = 45;
    angleEd.precision = 0;
    angleEd.showPopupSlider = true;

    const colGrp = col.addGroup("Shadow Colour (CMYK %)");
    const cEd = colGrp.addUnitValueEditor("C", UnitType.Number, UnitType.Number, 0, 0, 100);
    cEd.value = 0;
    cEd.precision = 0;
    const mEd = colGrp.addUnitValueEditor("M", UnitType.Number, UnitType.Number, 0, 0, 100);
    mEd.value = 0;
    mEd.precision = 0;
    const yEd = colGrp.addUnitValueEditor("Y", UnitType.Number, UnitType.Number, 0, 0, 100);
    yEd.value = 0;
    yEd.precision = 0;
    const kEd = colGrp.addUnitValueEditor("K", UnitType.Number, UnitType.Number, 100, 0, 100);
    kEd.value = 100;
    kEd.precision = 0;

    const optGrp = col.addGroup("Options");
    const punchCheck = optGrp.addCheckBox(
      "Punch out source (hollow shadow)",
      false,
    );
    punchCheck.value = false;
    const groupCheck = optGrp.addCheckBox("Group shadow with original", true);
    groupCheck.value = true;

    const actGrp = col.addGroup("Action");
    const statusTxt = actGrp.addStaticText("", "Preview ready");
    statusTxt.isFullWidth = true;
    const btns = actGrp.addButtonSet("", ["↺ Preview", "✓ Apply"]);
    btns.isFullWidth = true;

    const dpi = doc.dpi;

    function getParams(doGroup) {
      const distPx = (distEd.value / 25.4) * dpi;
      const rad = (angleEd.value * Math.PI) / 180;
      return {
        dx: distPx * Math.cos(rad),
        dy: distPx * Math.sin(rad),
        brushFill: FillDescriptor.createSolid(
          SolidFill.create(
            Colour.createCMYKA8({
              c: Math.round((cEd.value / 100) * 255),
              m: Math.round((mEd.value / 100) * 255),
              y: Math.round((yEd.value / 100) * 255),
              k: Math.round((kEd.value / 100) * 255),
              alpha: 255,
            }),
          ),
        ),
        doPunch: !!punchCheck.value,
        doGroup: !!doGroup,
      };
    }

    // Preview shadows currently in the document. Removing the preview deletes
    // exactly these nodes (neither createUndo() nor a history rollback removes
    // them reliably in the current SDK -> shadows piled up).
    let previewShadows = [];

    function undoPreview() {
      if (previewShadows.length) {
        try {
          doc.executeCommand(
            DocumentCommand.createDeleteSelection(
              Selection.create(doc, previewShadows, true),
              false,
            ),
          );
        } catch (e) {
          for (const n of previewShadows) {
            try {
              doc.executeCommand(
                DocumentCommand.createDeleteSelection(n.selfSelection, false),
              );
            } catch (_) {}
          }
        }
      }
      previewShadows = [];
    }

    // Show initial preview immediately
    try {
      previewShadows = applyPreview(doc, nodes, getParams(false));
      statusTxt.text = "Preview active";
    } catch (e) {
      statusTxt.text = "Error: " + e.message;
    }

    let running = true;
    while (running) {
      btns.selectedIndex = 0;
      const result = dlg.runModal();
      const action = btns.selectedIndex;

      if (result.value !== DialogResult.Ok.value) {
        // Cancel — remove preview entirely
        undoPreview();
        running = false;
      } else if (action === 1) {
        // Apply — remove preview, commit final with grouping
        undoPreview();
        applyFinal(doc, nodes, getParams(groupCheck.value));
        running = false;
      } else {
        // Preview — remove old preview, generate new one
        undoPreview();
        try {
          previewShadows = applyPreview(doc, nodes, getParams(false));
          statusTxt.text =
            "Preview active — " +
            distEd.value.toFixed(1) +
            "mm @ " +
            angleEd.value +
            "°";
        } catch (e) {
          statusTxt.text = "Error: " + e.message;
        }
      }
    }
  }
}
