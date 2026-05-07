
'use strict';

// ══════════════════════════════════════════════════════════════════
//  TWIST — Affinity Designer
//  Rotatie polara progresiva per punct (Adobe Illustrator style)
//  Subdivizare bezier → twist → reconstruire polyline
// ══════════════════════════════════════════════════════════════════

const { Document }                               = require('/document');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
const { CurveBuilder, PolyCurve }                = require('/geometry');
const { Dialog, DialogResult }                   = require('/dialog');
const { Selection }                              = require('/selections');

const doc = Document.current;

function gatherNodes(nodes) {
  const result = [];
  for (const n of nodes) {
    if (n.isGroupNode || n.isContainerNode) result.push(...gatherNodes([...n.children]));
    else if (n.isPolyCurveNode || n.isShapeNode || (n.isVectorNode && n.polyCurve)) result.push(n);
  }
  return result;
}

const rawNodes = gatherNodes(doc.selection.nodes.toArray());
if (!doc)                  { alert('Deschide un document.'); }
else if (!rawNodes.length) { alert('Selecteaza o curba, forma sau grup.'); }
else {

function ensureCurveNodes(raw) {
  const poly   = raw.filter(n => n.isPolyCurveNode);
  const shapes = raw.filter(n => !n.isPolyCurveNode);
  for (const s of shapes)
    doc.executeCommand(DocumentCommand.createConvertToCurves(Selection.create(doc, s)));
  const converted = shapes.length
    ? doc.selection.nodes.toArray().filter(n => n.isPolyCurveNode) : [];
  return [...poly, ...converted];
}

function evalBez(b, t) {
  const u = 1 - t;
  return {
    x: u*u*u*b.start.x + 3*u*u*t*b.c1.x + 3*u*t*t*b.c2.x + t*t*t*b.end.x,
    y: u*u*u*b.start.y + 3*u*u*t*b.c1.y + 3*u*t*t*b.c2.y + t*t*t*b.end.y
  };
}

function twistPt(x, y, cx, cy, angleRad, maxR) {
  const dx = x-cx, dy = y-cy, r = Math.hypot(dx, dy);
  if (r < 1e-9) return { x, y };
  const a = Math.atan2(dy, dx) + angleRad * (r / maxR);
  return { x: cx + r*Math.cos(a), y: cy + r*Math.sin(a) };
}

const nodes = ensureCurveNodes(rawNodes);

function applyTwist(angleDeg, subdiv) {
  const angleRad = angleDeg * Math.PI / 180;
  const cmds = [];

  for (const n of nodes) {
    const bbox = n.polyCurve.exactBoundingBox;
    if (!bbox) continue;
    const cx   = bbox.x + bbox.width  / 2;
    const cy   = bbox.y + bbox.height / 2;
    const maxR = Math.hypot(bbox.width/2, bbox.height/2) || 1;

    const out = PolyCurve.create();
    for (const curve of n.polyCurve) {
      const beziers = [...curve.beziers];
      if (!beziers.length) continue;
      const builder = CurveBuilder.create();
      const pts = [];
      for (const bez of beziers)
        for (let s=0; s<subdiv; s++) pts.push(evalBez(bez, s/subdiv));
      if (!curve.isClosed) { const l=beziers[beziers.length-1]; pts.push({x:l.end.x,y:l.end.y}); }
      const tp = pts.map(p => twistPt(p.x, p.y, cx, cy, angleRad, maxR));
      builder.beginXY(tp[0].x, tp[0].y);
      for (let i=1; i<tp.length; i++) builder.lineToXY(tp[i].x, tp[i].y);
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

const dlg     = Dialog.create('Twist');
const col     = dlg.addColumn();
const grp     = col.addGroup('Parameters');
const angleEd = grp.addUnitValueEditor('Angle (°)', 'px', 'px', 45, -3600, 3600);
angleEd.precision = 1; angleEd.showPopupSlider = true;
const subdivEd = grp.addUnitValueEditor('Mesh Resolution', 'px', 'px', 40, 4, 200);
subdivEd.precision = 0;
const btnGrp  = col.addGroup(''); btnGrp.enableSeparator = true;
const btns    = btnGrp.addButtonSet('', ['Preview', 'Apply'], 0);

applyTwist(45, 40);
let previewActive = true;

let running = true;
while (running) {
  btns.selectedIndex = 0;
  const r         = dlg.show();
  const newAngle  = angleEd.value;
  const newSubdiv = Math.max(4, Math.round(subdivEd.value));
  const doApply   = btns.selectedIndex === 1;

  if (r.value === DialogResult.Ok.value) {
    if (previewActive) doc.executeCommand(DocumentCommand.createUndo());
    applyTwist(newAngle, newSubdiv);
    previewActive = true;
    if (doApply) running = false;
  } else {
    if (previewActive) doc.executeCommand(DocumentCommand.createUndo());
    previewActive = false;
    running = false;
  }
}

} // end
