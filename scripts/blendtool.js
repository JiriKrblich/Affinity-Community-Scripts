'use strict';
// ═══════════════════════════════════════════════════════════
// BLEND TOOL v7.1
// Author: robinsnest56
// Select 2 vector objects, then run.
// - Open paths stay open (not forced closed)
// - No-fill paths keep no fill in blend steps
// - Solid and gradient fill interpolation
// - Stroke colour + weight interpolation
// - All steps grouped in a named layer
// - Smooth bezier morphing via De Casteljau subdivision
// ═══════════════════════════════════════════════════════════

const { Document } = require('/document');
const { Dialog, DialogResult } = require('/dialog');
const { PolyCurveNodeDefinition,
ContainerNodeDefinition,
NodeChildType } = require('/nodes');
const { AddChildNodesCommandBuilder,
DocumentCommand } = require('/commands');
const { PolyCurve, CurveBuilder } = require('/geometry');
const { FillDescriptor, GradientFill,
FillType } = require('/fills');
const { GradientFillType } = require('affinity:fills');
const { LineStyle, LineStyleDescriptor } = require('/linestyle');
const { Gradient, Colour, RGBA8 } = require('/colours');
const { BlendMode } = require('affinity:common');
const { UnitType } = require('/units');

// ── Math helpers ──────────────────────────────────────────
function lerp(a, b, t) { return a + (b - a) * t; }
function lerpPt(a, b, t) { return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) }; }

// ── Bezier geometry ───────────────────────────────────────
function subdivideBezier(seg, t) {
const { start: p0, c1: p1, c2: p2, end: p3 } = seg;
const p01 = lerpPt(p0, p1, t), p12 = lerpPt(p1, p2, t), p23 = lerpPt(p2, p3, t);
const p012 = lerpPt(p01, p12, t), p123 = lerpPt(p12, p23, t);
const mid = lerpPt(p012, p123, t);
return [
{ start: p0, c1: p01, c2: p012, end: mid },
{ start: mid, c1: p123, c2: p23, end: p3 }
];
}

function splitToCount(beziers, target) {
const segs = beziers.map(b => ({ ...b }));
while (segs.length < target) {
let maxLen = -1, maxIdx = 0;
for (let i = 0; i < segs.length; i++) {
const s = segs[i];
const len = Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y);
if (len > maxLen) { maxLen = len; maxIdx = i; }
}
segs.splice(maxIdx, 1, ...subdivideBezier(segs[maxIdx], 0.5));
}
return segs;
}

// shouldClose: only close the curve if both source paths were closed
function buildBlendCurve(segA, segB, t, shouldClose) {
const builder = CurveBuilder.create();
builder.begin(lerpPt(segA[0].start, segB[0].start, t));
for (let i = 0; i < segA.length; i++) {
const a = segA[i], b = segB[i];
builder.addBezier(lerpPt(a.c1, b.c1, t), lerpPt(a.c2, b.c2, t), lerpPt(a.end, b.end, t));
}
if (shouldClose) builder.close();
return builder.createCurve();
}

// ── Fill extraction ───────────────────────────────────────
// NOTE: gradient stop.colour is a raw ColourHandle — wrap in new Colour()
// NOTE: rgba alpha field is rgba.alpha, NOT rgba.a
// NOTE: FillType.None (value 1) is returned as { type: 'none' }
function extractFillData(node) {
try {
const fd = node.brushFillInterface.fillDescriptor;
const fill = fd.fill;
if (fill.fillType.value === FillType.None.value) {
return { type: 'none' };
} else if (fill.fillType.value === FillType.Gradient.value) {
const grad = fill.gradient;
const stops = [];
for (let i = 0; i < grad.stopCount; i++) {
const s = grad.getStop(i);
const rgba = new Colour(s.colour).rgba8;
stops.push({ r: rgba.r, g: rgba.g, b: rgba.b, a: rgba.alpha,
pos: s.position, mid: s.midpoint });
}
return { type: 'gradient', gradFillType: fill.gradientFillType, stops };
} else {
const rgba = fill.colour.rgba8;
return { type: 'solid', r: rgba.r, g: rgba.g, b: rgba.b, a: rgba.alpha };
}
} catch(e) {
return { type: 'solid', r: 180, g: 180, b: 180, a: 255 };
}
}

function solidToStops(d) {
return [
{ r: d.r, g: d.g, b: d.b, a: d.a, pos: 0.0, mid: 0.5 },
{ r: d.r, g: d.g, b: d.b, a: d.a, pos: 1.0, mid: 0.5 }
];
}

function resampleStops(stops, n) {
if (stops.length === n) return stops;
const out = [];
for (let i = 0; i < n; i++) {
const f = i / (n - 1);
let lo = 0;
for (let j = 0; j < stops.length - 1; j++) {
if (stops[j].pos <= f) lo = j;
}
const hi = Math.min(lo + 1, stops.length - 1);
const span = stops[hi].pos - stops[lo].pos;
const t2 = span < 0.0001 ? 0 : (f - stops[lo].pos) / span;
const a = stops[lo], b = stops[hi];
out.push({
r: Math.round(lerp(a.r, b.r, t2)), g: Math.round(lerp(a.g, b.g, t2)),
b: Math.round(lerp(a.b, b.b, t2)), a: Math.round(lerp(a.a, b.a, t2)),
pos: f, mid: lerp(a.mid, b.mid, t2)
});
}
return out;
}

// If either fill is 'none', preserve no-fill in all blend steps
function buildInterpolatedFill(fA, fB, t, doInterpolate) {
if (!doInterpolate) fB = fA;
if (fA.type === 'none' || fB.type === 'none') return FillDescriptor.createNone();

const isGrad = fA.type === 'gradient' || fB.type === 'gradient';
if (isGrad) {
const sA = fA.type === 'gradient' ? fA.stops : solidToStops(fA);
const sB = fB.type === 'gradient' ? fB.stops : solidToStops(fB);
const tgt = Math.max(sA.length, sB.length);
const rsA = resampleStops(sA, tgt), rsB = resampleStops(sB, tgt);

const blendedStops = rsA.map((sa, i) => {
  const sb = rsB[i];
  return {
    colour:   RGBA8(Math.round(lerp(sa.r, sb.r, t)), Math.round(lerp(sa.g, sb.g, t)),
                    Math.round(lerp(sa.b, sb.b, t)), Math.round(lerp(sa.a, sb.a, t))),
    position: lerp(sa.pos, sb.pos, t),
    midpoint: lerp(sa.mid, sb.mid, t)
  };
});

const gradFillType = fA.type === 'gradient' ? fA.gradFillType
                   : fB.type === 'gradient'  ? fB.gradFillType : 0;
const gf = GradientFill.create(Gradient.create(blendedStops), gradFillType);
return FillDescriptor.create(gf, true, null, BlendMode.Normal, false);
} else {
return FillDescriptor.createSolid(RGBA8(
Math.round(lerp(fA.r, fB.r, t)), Math.round(lerp(fA.g, fB.g, t)),
Math.round(lerp(fA.b, fB.b, t)), Math.round(lerp(fA.a, fB.a, t))
), BlendMode.Normal);
}
}

// ── Stroke extraction ─────────────────────────────────────
function extractStroke(node) {
try {
const lsi = node.lineStyleInterface;
const rgba = lsi.penFillDescriptor.fill.colour.rgba8;
return { r: rgba.r, g: rgba.g, b: rgba.b, a: rgba.alpha, weight: lsi.lineStyle.weight };
} catch(e) { return { r: 0, g: 0, b: 0, a: 0, weight: 0 }; }
}

// ── Error dialog ──────────────────────────────────────────
function showError(msg) {
const d = Dialog.create('Blend Tool');
d.addColumn().addGroup('Error').addStaticText('', msg);
d.runModal();
}

// ════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════
const doc = Document.current;
const sel = doc.selection;

if (!sel || sel.length < 2) {
showError('Please select exactly 2 vector objects before running Blend Tool.');
} else {
// sel.at(i) returns SelectionItem — use .node to get the actual Node
const nodeA = sel.at(0).node;
const nodeB = sel.at(1).node;

if (!nodeA || !nodeB || !nodeA.isVectorNode || !nodeB.isVectorNode) {
showError('Both selected objects must be vector (curve/shape) nodes.');
} else {
const nameA = nodeA.userDescription || nodeA.defaultDescription || 'Object A';
const nameB = nodeB.userDescription || nodeB.defaultDescription || 'Object B';

// ── Dialog ────────────────────────────────────────────
const dlg = Dialog.create('Blend Tool');
dlg.initialWidth = 340;
const col = dlg.addColumn();

const infoGrp = col.addGroup('Selection');
infoGrp.addStaticText('From', nameA);
infoGrp.addStaticText('To',   nameB);

const blendGrp  = col.addGroup('Blend');
const stepsCtrl = blendGrp.addUnitValueEditor(
  'Steps (incl. endpoints)', UnitType.Number, UnitType.Number, 7, 2, 50);
stepsCtrl.precision = 0;
stepsCtrl.showPopupSlider = true;

const colGrp        = col.addGroup('Colour');
const colCtrl       = colGrp.addSwitch('Interpolate fill colour', true);
const strokeColCtrl = colGrp.addSwitch('Interpolate stroke', true);

const outGrp      = col.addGroup('Output');
const replaceCtrl = outGrp.addCheckBox('Delete source objects after blend', false);

const result = dlg.runModal();

// DialogResult must be compared via .value, not ===
if (result.value === DialogResult.Ok.value) {
  const steps       = Math.max(2, Math.round(stepsCtrl.value));
  const doFillColor = colCtrl.value;
  const doStroke    = strokeColCtrl.value;
  const doDelete    = replaceCtrl.value;

  try {
    // ── Extract geometry ──────────────────────────────
    const cA = nodeA.polyCurve.at(0);
    const cB = nodeB.polyCurve.at(0);

    // Blend steps are open unless BOTH sources are closed
    const shouldClose = cA.isClosed && cB.isClosed;

    const bezA   = [...cA.beziers];
    const bezB   = [...cB.beziers];
    const target = Math.max(bezA.length, bezB.length);
    const segA   = splitToCount(bezA, target);
    const segB   = splitToCount(bezB, target);

    // ── Extract fills and stroke ─────────────────────
    const fillA   = extractFillData(nodeA);
    const fillB   = extractFillData(nodeB);
    const strokeA = extractStroke(nodeA);
    const strokeB = extractStroke(nodeB);

    // ── Step 1: create the named container layer ──────
    const containerBuilder = AddChildNodesCommandBuilder.create();
    containerBuilder.addContainerNode(
      ContainerNodeDefinition.create('Blend: ' + nameA + ' to ' + nameB));
    const containerCmd = containerBuilder.createCommand(false, NodeChildType.Main);
    doc.executeCommand(containerCmd);
    const container = containerCmd.newNodes[0];

    // ── Step 2: add blend steps INTO the container ────
    const shapesBuilder = AddChildNodesCommandBuilder.create();
    shapesBuilder.setInsertionTarget(container);

    for (let s = 0; s < steps; s++) {
      const t = s / (steps - 1);

      // Interpolated shape — open or closed based on shouldClose
      const curve = buildBlendCurve(segA, segB, t, shouldClose);
      const pc = PolyCurve.create();
      pc.addCurve(curve);

      // Interpolated fill — 'none' preserved if either source has no fill
      const brushFill = buildInterpolatedFill(fillA, fillB, t, doFillColor);

      // Interpolated stroke
      const sr  = Math.round(doStroke ? lerp(strokeA.r, strokeB.r, t) : strokeA.r);
      const sg  = Math.round(doStroke ? lerp(strokeA.g, strokeB.g, t) : strokeA.g);
      const sb  = Math.round(doStroke ? lerp(strokeA.b, strokeB.b, t) : strokeA.b);
      const sa  = Math.round(doStroke ? lerp(strokeA.a, strokeB.a, t) : strokeA.a);
      const sw  = doStroke ? lerp(strokeA.weight, strokeB.weight, t) : strokeA.weight;
      const penFill       = FillDescriptor.createSolid(RGBA8(sr, sg, sb, sa), BlendMode.Normal);
      const lineStyleDesc = LineStyleDescriptor.create(LineStyle.createDefaultWithWeight(sw));

      const def = PolyCurveNodeDefinition.createDefault();
      def.setCurves(pc);
      // setBrushFillDescriptor(0) replaces default NoFill slot — do not use add
      def.setBrushFillDescriptor(0, brushFill);
      def.setLineDescriptors(0, penFill, lineStyleDesc);
      def.userDescription = 'Step ' + (s + 1);
      shapesBuilder.addNode(def);
    }

    doc.executeCommand(shapesBuilder.createCommand(false, NodeChildType.Main));

    // ── Optionally delete source objects ──────────────
    if (doDelete) {
      doc.executeCommand(DocumentCommand.createSetSelection(nodeA.selfSelection));
      doc.deleteSelection();
      doc.executeCommand(DocumentCommand.createSetSelection(nodeB.selfSelection));
      doc.deleteSelection();
    }

    console.log('Blend Tool v7: ' + steps + ' steps, shouldClose=' + shouldClose +
                ', in "' + container.userDescription + '"');

  } catch(e) {
    showError('Blend failed: ' + e.message);
    console.log('Blend error:', e.stack);
  }
}
}
}