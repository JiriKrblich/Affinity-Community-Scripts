/**
 * name: Curvature Comb
 * description: Select 1 curve object, then run. Generates a curvature comb for curve quality analysis.
 * version: 1.0.2
 * author: Moryn Sun
 */

"use strict";

// ============================================================
// Curvature Comb v1.0 — Curve Quality Analysis Tool
//
// Usage: Select a vector curve in Affinity, then run this script.
// The script samples the curve at equal arc-length intervals,
// computes the signed curvature at each sample point
//   κ = (x'y'' − y'x'') / (x'² + y'²)^1.5
// and draws comb teeth proportional to κ along the normal direction,
// plus an envelope line, all placed into a new Group without
// modifying the original curve.
//
// ============================================================

const { Document } = require("/document");
const { Dialog, DialogResult } = require("/dialog");
const {
  PolyCurveNodeDefinition,
  ContainerNodeDefinition,
  NodeChildType,
} = require("/nodes");
const { AddChildNodesCommandBuilder } = require("/commands");
const { PolyCurve, CurveBuilder } = require("/geometry");
const { FillDescriptor } = require("/fills");
const { LineStyle, LineStyleDescriptor } = require("/linestyle");
const { RGBA8 } = require("/colours");
const { BlendMode } = require("affinity:common");
const { UnitType } = require("/units");

// ── Basic math ────────────────────────────────────────────────
function lerp(a, b, t) { return a + (b - a) * t; }
function lerpPt(a, b, t) { return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) }; }
function dist(p, q) { return Math.hypot(p.x - q.x, p.y - q.y); }

const ARC_SAMPLE_STEPS = 64; // Number of subdivision steps per bezier segment for the arc-length table

// Evaluate a cubic Bezier: B(t)
function evalBez(b, t) {
  const u = 1 - t;
  return {
    x: u*u*u*b.start.x + 3*u*u*t*b.c1.x + 3*u*t*t*b.c2.x + t*t*t*b.end.x,
    y: u*u*u*b.start.y + 3*u*u*t*b.c1.y + 3*u*t*t*b.c2.y + t*t*t*b.end.y,
  };
}

// First derivative B'(t) = 3(1-t)²(c1-p0) + 6(1-t)t(c2-c1) + 3t²(p3-c2)
function bezD1(b, t) {
  const u = 1 - t;
  return {
    x: 3*u*u*(b.c1.x - b.start.x) + 6*u*t*(b.c2.x - b.c1.x) + 3*t*t*(b.end.x - b.c2.x),
    y: 3*u*u*(b.c1.y - b.start.y) + 6*u*t*(b.c2.y - b.c1.y) + 3*t*t*(b.end.y - b.c2.y),
  };
}

// Second derivative B''(t) = 6(1-t)(c2-2c1+p0) + 6t(p3-2c2+c1)
function bezD2(b, t) {
  const u = 1 - t;
  return {
    x: 6*u*(b.c2.x - 2*b.c1.x + b.start.x) + 6*t*(b.end.x - 2*b.c2.x + b.c1.x),
    y: 6*u*(b.c2.y - 2*b.c1.y + b.start.y) + 6*t*(b.end.y - 2*b.c2.y + b.c1.y),
  };
}

// Signed curvature κ = (x'y'' − y'x'') / |B'|³
// At endpoints B' may degenerate (c1 coincides with the anchor point);
// in that case nudge t slightly and recompute.
function signedCurvature(b, t) {
  let d1 = bezD1(b, t);
  let len2 = d1.x*d1.x + d1.y*d1.y;
  if (len2 < 1e-12) {
    const t2 = t < 0.5 ? t + 1e-4 : t - 1e-4;
    d1 = bezD1(b, t2);
    len2 = d1.x*d1.x + d1.y*d1.y;
    if (len2 < 1e-12) return { kappa: 0, tangent: null };
    const d2b = bezD2(b, t2);
    return {
      kappa: (d1.x*d2b.y - d1.y*d2b.x) / Math.pow(len2, 1.5),
      tangent: d1,
    };
  }
  const d2 = bezD2(b, t);
  return {
    kappa: (d1.x*d2.y - d1.y*d2.x) / Math.pow(len2, 1.5),
    tangent: d1,
  };
}

// ── World-coordinate conversion ─────────────────────────
function bezToWorld(xf, seg) {
  return {
    start: xf.applyToPoint(seg.start),
    c1: xf.applyToPoint(seg.c1),
    c2: xf.applyToPoint(seg.c2),
    end: xf.applyToPoint(seg.end),
  };
}

// ── PolyCurve subcurve traversal (defensive style) ──────
function polyCurveAt(pc, index) {
  if (!pc || typeof pc.at !== "function") return null;
  try {
    const curve = pc.at(index);
    return curve && curve.beziers ? curve : null;
  } catch (e) {
    return null;
  }
}
function polyCurveCount(pc) {
  if (!pc) return 0;
  let reported = null;
  try {
    if (typeof pc.curveCount === "number") reported = pc.curveCount;
    else if (typeof pc.curveCount === "function") reported = pc.curveCount();
    else if (typeof pc.count === "number") reported = pc.count;
    else if (typeof pc.count === "function") reported = pc.count();
    else if (typeof pc.length === "number") reported = pc.length;
  } catch (e) { reported = null; }
  if (reported && reported > 0) return reported;
  if (!polyCurveAt(pc, 0)) return 0;
  let n = 0, prev = null;
  for (; n < 2048; n++) {
    const curve = polyCurveAt(pc, n);
    if (!curve || curve === prev) break;
    prev = curve;
  }
  return Math.max(1, n);
}

// Get all subcurves of the selected object (in world coordinates)
// Returns [{ bez: [...], isClosed: bool }, ...]
function getWorldSubcurves(node) {
  const xf = node.transformInterface.transform;
  const pc = node.polyCurve;
  const subs = [];
  const total = polyCurveCount(pc);
  for (let i = 0; i < total; i++) {
    const curve = polyCurveAt(pc, i);
    if (!curve) continue;
    const bez = [...curve.beziers].map((s) => bezToWorld(xf, s));
    if (bez.length) subs.push({ bez, isClosed: curve.isClosed });
  }
  return subs;
}

// ── Selection node resolution ────────────────────────────────────────────
// In some environments sel.at(i).node is required; in others sel.at(i)
// itself is already the node. Try both.
function resolveNode(item) {
  if (!item) return null;
  try {
    if (item.node && item.node.polyCurve) return item.node;
  } catch (e) {}
  try {
    if (item.polyCurve) return item;
  } catch (e) {}
  try {
    if (item.node) return item.node;
  } catch (e) {}
  return item;
}

function hasCurveData(node) {
  try {
    return !!node && !!node.polyCurve &&
      polyCurveCount(node.polyCurve) > 0 && !!node.transformInterface;
  } catch (e) { return false; }
}

// ── Arc-length table and uniform sampling ────────────────────────────────────────
// Build an arc-length table for a subcurve (array of beziers);
// each entry is { bi, t, cum }.
function buildArcTable(beziers) {
  const tbl = [];
  let cum = 0;
  for (let bi = 0; bi < beziers.length; bi++) {
    const b = beziers[bi];
    let prev = evalBez(b, 0);
    if (bi === 0) tbl.push({ bi, t: 0, cum: 0 });
    for (let s = 1; s <= ARC_SAMPLE_STEPS; s++) {
      const t = s / ARC_SAMPLE_STEPS;
      const pt = evalBez(b, t);
      cum += dist(pt, prev);
      tbl.push({ bi, t, cum });
      prev = pt;
    }
  }
  return tbl;
}

// Look up the parameter position { bi, t } for a given arc-length fraction frac ∈ [0,1]
function paramAtFrac(tbl, frac) {
  const total = tbl[tbl.length - 1].cum;
  const c = Math.min(Math.max(frac, 0), 1) * total;
  let lo = 0, hi = tbl.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (tbl[mid].cum <= c) lo = mid;
    else hi = mid;
  }
  const a = tbl[lo], b = tbl[hi];
  const span = b.cum - a.cum;
  const f = span < 1e-9 ? 0 : (c - a.cum) / span;
  // When crossing a bezier boundary, take the segment with the larger share
  // and interpolate t within that segment
  if (a.bi === b.bi) return { bi: a.bi, t: a.t + (b.t - a.t) * f };
  return f < 0.5 ? { bi: a.bi, t: a.t + (1 - a.t) * f * 2 }
                 : { bi: b.bi, t: b.t * (f - 0.5) * 2 };
}

// Take n equal-arc-length samples of a subcurve, returning
// [{ pos, normal, kappa }]; normal is the unit normal (tangent rotated 90° left)
function sampleSubcurve(sub, n) {
  const tbl = buildArcTable(sub.bez);
  const total = tbl[tbl.length - 1].cum;
  if (total < 1e-9) return [];
  const out = [];
  for (let i = 0; i < n; i++) {
    // Closed curves don't repeat the start/end point; open curves include both ends
    const frac = sub.isClosed ? i / n : i / (n - 1);
    const { bi, t } = paramAtFrac(tbl, frac);
    const b = sub.bez[bi];
    const pos = evalBez(b, t);
    const { kappa, tangent } = signedCurvature(b, t);
    if (!tangent) { out.push({ pos, normal: null, kappa: 0 }); continue; }
    const tl = Math.hypot(tangent.x, tangent.y);
    // Unit normal: tangent (tx,ty) rotated 90° left → (-ty, tx)
    out.push({
      pos,
      normal: { x: -tangent.y / tl, y: tangent.x / tl },
      kappa,
    });
  }
  return out;
}

// ── Generate stroke node definitions ────────
// subPaths: [{ bez: [...], isClosed }], generates a stroke-only node with no fill
function makeStrokedDef(subPaths, name, rgba, weight) {
  const pc = PolyCurve.create();
  for (const sp of subPaths) {
    if (!sp.bez.length) continue;
    const builder = CurveBuilder.create();
    builder.begin(sp.bez[0].start);
    for (const b of sp.bez) builder.addBezier(b.c1, b.c2, b.end);
    if (sp.isClosed) builder.close();
    pc.addCurve(builder.createCurve());
  }
  const def = PolyCurveNodeDefinition.createDefault();
  def.setCurves(pc);
  def.setBrushFillDescriptor(FillDescriptor.createNone(), 0);
  def.setLineDescriptors(
    FillDescriptor.createSolid(RGBA8(rgba[0], rgba[1], rgba[2], rgba[3]), BlendMode.Normal),
    LineStyleDescriptor.create(LineStyle.createDefaultWithWeight(weight)),
    0,
  );
  def.userDescription = name;
  return def;
}

// Express a straight line segment between two points as a bezier (control points at 1/3 and 2/3)
function lineBez(p, q) {
  return { start: p, c1: lerpPt(p, q, 1/3), c2: lerpPt(p, q, 2/3), end: q };
}

// ── Error dialog ────────────────────────────────────────────────
function showError(msg) {
  const d = Dialog.create("Curvature Comb");
  d.initialWidth = 420;
  const col = d.addColumn();
  const grp = col.addGroup("Error");
  const txt = grp.addStaticText("", msg);
  txt.isFullWidth = true;
  d.runModal();
}

function dialogOk(result) {
  try {
    if (result && DialogResult.Ok && result.value !== undefined) {
      return result.value === DialogResult.Ok.value;
    }
  } catch (e) {}
  return result === DialogResult.Ok;
}

// ════════════════════════════════════════════════════════════
// Main flow
// ════════════════════════════════════════════════════════════
function main() {
  console.log("[comb] Script started");

  const doc = Document.current;
  if (!doc) { showError("No document is open."); return; }

  // ---- Read selection ----
  const sel = doc.selection;
  if (!sel || sel.length < 1) {
    showError("Please select a vector curve first, then run the script.");
    return;
  }
  const node = resolveNode(sel.at(0));
  if (!hasCurveData(node)) {
    showError("The selected object is not an editable curve (needs to be a Curve, or a shape converted to curves).");
    return;
  }
  const nodeName = node.userDescription || node.defaultDescription || "Curve";
  const subs = getWorldSubcurves(node);
  if (!subs.length) {
    showError("The selected curve has no usable bezier segments.");
    return;
  }
  console.log("[comb] Curve \"" + nodeName + "\": " + subs.length + " subcurve(s)");

  // ---- Parameter dialog ----
  const dlg = Dialog.create("Curvature Comb");
  dlg.initialWidth = 380;
  const col = dlg.addColumn();

  const gS = col.addGroup("Sampling");
  const samplesCtrl = gS.addUnitValueEditor("Sample Count", UnitType.Number, UnitType.Number, 120, 8, 2000);
  samplesCtrl.precision = 0;
  samplesCtrl.showPopupSlider = true;

  const gL = col.addGroup("Comb Teeth");
  const lenCtrl = gL.addUnitValueEditor("Max Tooth Length (px)", UnitType.Number, UnitType.Number, 60, 1, 5000);
  lenCtrl.precision = 0;
  lenCtrl.showPopupSlider = true;
  const flipCtrl = gL.addSwitch("Flip Direction", false);
  const signedCtrl = gL.addSwitch("Split by Curvature Sign (show inflection points)", true);
  const scaleMode = gL.addComboBox("Length Mapping", [
    "Linear (tooth length ∝ κ)",
    "Square Root (compresses high-curvature differences)",
  ], 0);

  const gE = col.addGroup("Envelope");
  const envCtrl = gE.addSwitch("Generate Envelope", true);

  const gI = col.addGroup("Info");
  const infoTxt = gI.addStaticText("", "Target: " + nodeName + " (" + subs.length + " subcurve(s))");
  infoTxt.isFullWidth = true;

  const result = dlg.runModal();
  console.log("[comb] runModal returned value=" +
    (result && result.value !== undefined ? result.value : String(result)));
  if (!dialogOk(result)) {
    console.log("[comb] Cancelled by user");
    return;
  }

  const nSamples = Math.max(8, Math.min(2000, Math.round(Number(samplesCtrl.value)) || 120));
  const maxLen = Math.max(1, Number(lenCtrl.value) || 60);
  // The Affinity document Y axis points downward, so the base direction must be
  // inverted to match intuition; if the switch is enabled, flip it back again
  const flip = flipCtrl.value ? 1 : -1;
  const useSigned = signedCtrl.value;
  const useSqrt = scaleMode.selectedIndex === 1;
  const drawEnvelope = envCtrl.value;

  try {
    // ---- Sampling and curvature computation ----
    // Distribute sample counts proportionally to subcurve length, at least 8 per subcurve
    const lengths = subs.map((s) => {
      const t = buildArcTable(s.bez);
      return t[t.length - 1].cum;
    });
    const totalLen = lengths.reduce((a, v) => a + v, 0);
    if (totalLen < 1e-9) { showError("Curve length is 0."); return; }

    const allSamples = []; // One array per subcurve
    let kMax = 0;
    for (let i = 0; i < subs.length; i++) {
      const n = Math.max(8, Math.round(nSamples * (lengths[i] / totalLen)));
      const samples = sampleSubcurve(subs[i], n);
      for (const s of samples) kMax = Math.max(kMax, Math.abs(s.kappa));
      allSamples.push(samples);
    }
    console.log("[comb] κmax = " + kMax);
    if (kMax < 1e-12) {
      showError("This curve's curvature is close to 0 everywhere (nearly a straight line); there are no comb teeth to display.");
      return;
    }

    // ---- Generate comb teeth and envelope ----
    const teethBez = [];        // All teeth: open straight-line segments
    const envelopeSubs = [];    // One envelope polyline per subcurve
    for (let i = 0; i < subs.length; i++) {
      const tips = [];
      for (const s of allSamples[i]) {
        if (!s.normal) { tips.push(s.pos); continue; }
        let ratio = Math.abs(s.kappa) / kMax;
        if (useSqrt) ratio = Math.sqrt(ratio);
        // Signed mode: tooth direction flips with the sign of κ,
        // switching sides at inflection points
        const side = useSigned ? Math.sign(s.kappa) || 1 : 1;
        const L = ratio * maxLen * side * flip;
        const tip = { x: s.pos.x + s.normal.x * L, y: s.pos.y + s.normal.y * L };
        tips.push(tip);
        if (ratio * maxLen > 0.25) teethBez.push(lineBez(s.pos, tip));
      }
      if (drawEnvelope && tips.length > 1) {
        const envBez = [];
        for (let k = 0; k < tips.length - 1; k++) envBez.push(lineBez(tips[k], tips[k + 1]));
        if (subs[i].isClosed) envBez.push(lineBez(tips[tips.length - 1], tips[0]));
        envelopeSubs.push({ bez: envBez, isClosed: subs[i].isClosed });
      }
    }
    console.log("[comb] " + teethBez.length + " tooth/teeth generated");

    // ---- Insert into document: Group( teeth + envelope ) ----
    const cb = AddChildNodesCommandBuilder.create();
    cb.addContainerNode(ContainerNodeDefinition.create("Curvature Comb: " + nodeName));
    const ccmd = cb.createCommand(false, NodeChildType.Main);
    doc.executeCommand(ccmd);
    const group = ccmd.newNodes[0];

    const ch = AddChildNodesCommandBuilder.create();
    ch.setInsertionTarget(group);
    // Put all teeth into a single PolyCurve node (one subcurve per tooth),
    // to avoid generating hundreds of separate layers
    ch.addNode(makeStrokedDef(
      teethBez.map((b) => ({ bez: [b], isClosed: false })),
      "Comb Teeth", [255, 60, 60, 255], 0.5,
    ));
    if (drawEnvelope && envelopeSubs.length) {
      ch.addNode(makeStrokedDef(envelopeSubs, "Comb Envelope", [60, 120, 255, 255], 1));
    }
    doc.executeCommand(ch.createCommand(false, NodeChildType.Main));

    console.log("[comb] Done: inserted Group \"Curvature Comb: " + nodeName + "\"");
  } catch (e) {
    console.log("[comb] Failed: " + e.message + "\n" + e.stack);
    showError("Generation failed: " + e.message);
  }
}

main();
