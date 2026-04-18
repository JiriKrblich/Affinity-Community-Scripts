'use strict';

// ═══════════════════════════════════════════════════════════

// BLEND TOOL v5 (final)

// Select 2 vector objects, then run.

// - Smooth bezier morphing via De Casteljau subdivision

// - Fill colour correctly interpolated (rgba.alpha fix)

// - Stroke colour + weight interpolated

// ═══════════════════════════════════════════════════════════

const { Document } = require('/document');

const { Dialog, DialogResult } = require('/dialog');

const { PolyCurveNodeDefinition,

ContainerNodeDefinition,

NodeChildType } = require('/nodes');

const { AddChildNodesCommandBuilder,

DocumentCommand } = require('/commands');

const { PolyCurve, CurveBuilder } = require('/geometry');

const { FillDescriptor } = require('/fills');

const { LineStyle, LineStyleDescriptor } = require('/linestyle');

const { RGBA8 } = require('/colours');

const { BlendMode } = require('affinity:common');

const { UnitType } = require('/units');

// ── helpers ───────────────────────────────────────────────

function lerp(a, b, t) { return a + (b - a) * t; }

function lerpPt(a, b, t) { return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) }; }

// De Casteljau subdivision of one cubic bezier at parameter t

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

// Grow a bezier array to targetCount by repeatedly splitting the longest segment

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

// Build one interpolated closed curve at parameter t from two matched segment arrays

function buildBlendCurve(segA, segB, t) {

const builder = CurveBuilder.create();

builder.begin(lerpPt(segA[0].start, segB[0].start, t));

for (let i = 0; i < segA.length; i++) {

const a = segA[i], b = segB[i];

builder.addBezier(lerpPt(a.c1, b.c1, t), lerpPt(a.c2, b.c2, t), lerpPt(a.end, b.end, t));

}

builder.close();

return builder.createCurve();

}

// NOTE: RGBA field is rgba.alpha, NOT rgba.a

function extractFill(node) {

try {

const rgba = node.brushFillInterface.fillDescriptor.fill.colour.rgba8;

return { r: rgba.r, g: rgba.g, b: rgba.b, a: rgba.alpha };

} catch(e) { return { r: 180, g: 180, b: 180, a: 255 }; }

}

function extractStroke(node) {

try {

const lsi = node.lineStyleInterface;

const rgba = lsi.penFillDescriptor.fill.colour.rgba8;

return { r: rgba.r, g: rgba.g, b: rgba.b, a: rgba.alpha, weight: lsi.lineStyle.weight };

} catch(e) { return { r: 0, g: 0, b: 0, a: 255, weight: 0 }; }

}

function showError(msg) {

const d = Dialog.create('Blend Tool');

d.addColumn().addGroup('Error').addStaticText('', msg);

d.runModal();

}

// ── validation ────────────────────────────────────────────

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

// ── dialog ──────────────────────────────────────────────

const dlg = Dialog.create('Blend Tool');

dlg.initialWidth = 340;

const col = dlg.addColumn();

const infoGrp = col.addGroup('Selection');

infoGrp.addStaticText('From', nameA);

infoGrp.addStaticText('To', nameB);

const blendGrp = col.addGroup('Blend');

const stepsCtrl = blendGrp.addUnitValueEditor(

'Steps (incl. endpoints)', UnitType.Number, UnitType.Number, 7, 2, 50);

stepsCtrl.precision = 0;

stepsCtrl.showPopupSlider = true;

const colGrp = col.addGroup('Colour');

const colCtrl = colGrp.addSwitch('Interpolate fill colour', true);

const strokeColCtrl = colGrp.addSwitch('Interpolate stroke', true);

const outGrp = col.addGroup('Output');

const groupCtrl = outGrp.addCheckBox('Group result in layer', true);

const replaceCtrl = outGrp.addCheckBox('Delete source objects after blend', false);

const result = dlg.runModal();

// DialogResult must be compared via .value, not ===

if (result.value === DialogResult.Ok.value) {

const steps = Math.max(2, Math.round(stepsCtrl.value));

const doFillColor = colCtrl.value;

const doStroke = strokeColCtrl.value;

const doGroup = groupCtrl.value;

const doDelete = replaceCtrl.value;

try {

// ── geometry ─────────────────────────────────────────

const bezA = [...nodeA.polyCurve.at(0).beziers];

const bezB = [...nodeB.polyCurve.at(0).beziers];

const target = Math.max(bezA.length, bezB.length);

const segA = splitToCount(bezA, target);

const segB = splitToCount(bezB, target);

// ── colour ───────────────────────────────────────────

const fillA = extractFill(nodeA);

const fillB = extractFill(nodeB);

const strokeA = extractStroke(nodeA);

const strokeB = extractStroke(nodeB);

// ── build blend ───────────────────────────────────────

const acnBuilder = AddChildNodesCommandBuilder.create();

if (doGroup) {

acnBuilder.addContainerNode(

ContainerNodeDefinition.create('Blend: ' + nameA + ' to ' + nameB));

}

for (let s = 0; s < steps; s++) {

const t = s / (steps - 1);

const curve = buildBlendCurve(segA, segB, t);

const pc = PolyCurve.create();

pc.addCurve(curve);

// Interpolated fill

const fr = Math.round(doFillColor ? lerp(fillA.r, fillB.r, t) : fillA.r);

const fg = Math.round(doFillColor ? lerp(fillA.g, fillB.g, t) : fillA.g);

const fb = Math.round(doFillColor ? lerp(fillA.b, fillB.b, t) : fillA.b);

const fa = Math.round(doFillColor ? lerp(fillA.a, fillB.a, t) : fillA.a);

const brushFill = FillDescriptor.createSolid(RGBA8(fr, fg, fb, fa), BlendMode.Normal);

// Interpolated stroke

const sr = Math.round(doStroke ? lerp(strokeA.r, strokeB.r, t) : strokeA.r);

const sg = Math.round(doStroke ? lerp(strokeA.g, strokeB.g, t) : strokeA.g);

const sb = Math.round(doStroke ? lerp(strokeA.b, strokeB.b, t) : strokeA.b);

const sa = Math.round(doStroke ? lerp(strokeA.a, strokeB.a, t) : strokeA.a);

const sw = doStroke ? lerp(strokeA.weight, strokeB.weight, t) : strokeA.weight;

const penFill = FillDescriptor.createSolid(RGBA8(sr, sg, sb, sa), BlendMode.Normal);

const lineStyleDesc = LineStyleDescriptor.create(LineStyle.createDefaultWithWeight(sw));

const def = PolyCurveNodeDefinition.createDefault();

def.setCurves(pc);

// Use set (index 0) not add — createDefault() already has 1 descriptor slot each

def.setBrushFillDescriptor(0, brushFill);

def.setLineDescriptors(0, penFill, lineStyleDesc);

def.userDescription = 'Step ' + (s + 1);

acnBuilder.addNode(def);

}

doc.executeCommand(acnBuilder.createCommand(true, NodeChildType.Main));

if (doDelete) {

doc.executeCommand(DocumentCommand.createSetSelection(nodeA.selfSelection));

doc.deleteSelection();

doc.executeCommand(DocumentCommand.createSetSelection(nodeB.selfSelection));

doc.deleteSelection();

}

console.log('Blend Tool v5: ' + steps + ' steps created.');

} catch(e) {

showError('Blend failed: ' + e.message);

console.log('Blend error:', e.stack);

}

}

}

}