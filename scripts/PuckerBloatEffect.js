"use strict";

const { Document } = require("/document");
const { DocumentCommand, CompoundCommandBuilder } = require("/commands");
const { CurveBuilder, PolyCurve } = require("/geometry");
const { Dialog, DialogResult } = require("/dialog");
const { Selection } = require("/selections");

const doc = Document.current;

function gatherNodes(nodes) {
  const result = [];
  for (const n of nodes) {
    if (n.isGroupNode || n.isContainerNode) {
      result.push(...gatherNodes([...n.children]));
    } else if (
      n.isPolyCurveNode ||
      n.isShapeNode ||
      (n.isVectorNode && n.polyCurve)
    ) {
      result.push(n);
    }
  }
  return result;
}

const rawNodes = gatherNodes(doc.selection.nodes.toArray());

if (!doc) {
  alert("Deschide un document.");
} else if (!rawNodes.length) {
  alert("Selecteaza o curba, forma sau grup.");
} else {
  function ensureCurveNodes(raw) {
    const poly = raw.filter((n) => n.isPolyCurveNode);
    const shapes = raw.filter((n) => !n.isPolyCurveNode);
    for (const s of shapes) {
      doc.executeCommand(
        DocumentCommand.createConvertToCurves(Selection.create(doc, s)),
      );
    }
    const converted = shapes.length
      ? doc.selection.nodes.toArray().filter((n) => n.isPolyCurveNode)
      : [];
    return [...poly, ...converted];
  }

  const nodes = ensureCurveNodes(rawNodes);

  function applyPuckerBloat(nodes, amount) {
    const t = amount / 100;
    const cmds = [];
    for (const n of nodes) {
      const bbox = n.polyCurve.exactBoundingBox;
      if (!bbox) continue;
      const cx = bbox.x + bbox.width / 2;
      const cy = bbox.y + bbox.height / 2;
      const out = PolyCurve.create();
      for (const curve of n.polyCurve) {
        const beziers = [...curve.beziers];
        if (!beziers.length) continue;
        const builder = CurveBuilder.create();
        const fs = beziers[0].start;
        builder.beginXY(cx + (fs.x - cx) * (1 - t), cy + (fs.y - cy) * (1 - t));
        for (const bez of beziers) {
          builder.addBezierXY(
            cx + (bez.c1.x - cx) * (1 + t),
            cy + (bez.c1.y - cy) * (1 + t),
            cx + (bez.c2.x - cx) * (1 + t),
            cy + (bez.c2.y - cy) * (1 + t),
            cx + (bez.end.x - cx) * (1 - t),
            cy + (bez.end.y - cy) * (1 - t),
          );
        }
        if (curve.isClosed) builder.close();
        out.addCurve(builder.createCurve());
      }
      cmds.push(DocumentCommand.createSetCurves(n.curvesInterface, out));
    }
    if (!cmds.length) return;
    const cb = CompoundCommandBuilder.create();
    for (const c of cmds) cb.addCommand(c);
    doc.executeCommand(cb.createCommand());
  }

  const dlg = Dialog.create("Pucker & Bloat");
  const col = dlg.addColumn();
  const amtGrp = col.addGroup("Pucker <--> Bloat");
  const amtEd = amtGrp.addUnitValueEditor(
    "Amount (%)",
    "px",
    "px",
    0,
    -200,
    200,
  );
  amtEd.precision = 1;
  amtEd.showPopupSlider = true;
  const btnGrp = col.addGroup("");
  btnGrp.enableSeparator = true;
  const btns = btnGrp.addButtonSet("", ["Preview", "Apply"], 0);

  applyPuckerBloat(nodes, 0);
  let previewActive = true;

  let running = true;
  while (running) {
    btns.selectedIndex = 0;
    const r = dlg.show();
    const newAmount = Math.max(-200, Math.min(200, amtEd.value));
    const doApply = btns.selectedIndex === 1;

    if (r.value === DialogResult.Ok.value) {
      if (previewActive) doc.executeCommand(DocumentCommand.createUndo());
      applyPuckerBloat(nodes, newAmount);
      previewActive = true;
      if (doApply) running = false;
    } else {
      if (previewActive) doc.executeCommand(DocumentCommand.createUndo());
      previewActive = false;
      running = false;
    }
  }
} // end
