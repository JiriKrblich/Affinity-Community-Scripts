"use strict";
// ═══════════════════════════════════════════════════════════
// BLEND TOOL v9
// Author: S1m0np1@github
// Selection rules:
// • 2 objects → blend between them (A to B)
// • 3 objects → first 2 are blend targets, THIRD is path
// regardless of open/closed or type — lines, curves,
// shapes, text groups all work as blend targets or paths
//
// Supported blend target types:
// • Vector nodes (shapes, curves, open lines)
// • Group nodes (text converted to curves)
// Both types work with or without a path.
//
// Changes from v8.9:
// • Fix: "Could not identify 2 shapes" on lines/open paths
// — replaced open-path heuristic with simple rule:
// items[0]+[1] = targets, item[2] = path.
// • Path node retained on Apply, renamed
// "Path Spine: " and hidden.
// • Dialog: status text left-aligned, initial copy updated,
// ButtonSet reduced to [Preview, Apply] (2 buttons),
// native Cancel / OK remain at dialog bottom.
// • Default steps: 15.
// • Angular best-match bezier alignment.
// • Compound paths (letters with holes) preserved.
// ═══════════════════════════════════════════════════════════

const { Document } = require("/document");
const { Dialog, DialogResult, HorizontalAlignment } = require("/dialog");
const {
  PolyCurveNodeDefinition,
  ContainerNodeDefinition,
  NodeChildType,
} = require("/nodes");
const { AddChildNodesCommandBuilder, DocumentCommand } = require("/commands");
const { PolyCurve, CurveBuilder, Transform } = require("/geometry");
const { FillDescriptor, GradientFill, FillType } = require("/fills");
const { LineStyle, LineStyleDescriptor } = require("/linestyle");
const { Gradient, Colour, RGBA8 } = require("/colours");
const { BlendMode } = require("affinity:common");
const { UnitType } = require("/units");

// ── Math ──────────────────────────────────────────────────
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function lerpPt(a, b, t) {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
}
function dist(p, q) {
  return Math.hypot(p.x - q.x, p.y - q.y);
}

// ── World-space transform ─────────────────────────────────
function applyDecomp(d, pt) {
  const r = d.rotation || 0,
    sh = d.shear || 0,
    sx = d.scaleX || 1,
    sy = d.scaleY || 1;
  const m11 = sx * Math.cos(r),
    m12 = sx * Math.sin(r),
    m21 = -sy * Math.sin(r + sh),
    m22 = sy * Math.cos(r + sh);
  return {
    x: m11 * pt.x + m21 * pt.y + (d.translateX || 0),
    y: m12 * pt.x + m22 * pt.y + (d.translateY || 0),
  };
}
function bezToWorld(d, seg) {
  return {
    start: applyDecomp(d, seg.start),
    c1: applyDecomp(d, seg.c1),
    c2: applyDecomp(d, seg.c2),
    end: applyDecomp(d, seg.end),
  };
}
function getWorldBeziers(node) {
  const d = node.transformInterface.transform.decompose();
  return [...node.polyCurve.at(0).beziers].map((s) => bezToWorld(d, s));
}

// ── Bezier subdivision ─────────────────────────────────────
function splitBezAt(seg, t) {
  const { start: p0, c1: p1, c2: p2, end: p3 } = seg;
  const p01 = lerpPt(p0, p1, t),
    p12 = lerpPt(p1, p2, t),
    p23 = lerpPt(p2, p3, t);
  const p012 = lerpPt(p01, p12, t),
    p123 = lerpPt(p12, p23, t),
    mid = lerpPt(p012, p123, t);
  return [
    { start: p0, c1: p01, c2: p012, end: mid },
    { start: mid, c1: p123, c2: p23, end: p3 },
  ];
}
function splitBezIntoN(seg, n) {
  if (n <= 1) return [{ ...seg }];
  const out = [];
  let rem = { ...seg };
  for (let i = n; i > 1; i--) {
    const [l, r] = splitBezAt(rem, 1 / i);
    out.push(l);
    rem = r;
  }
  out.push(rem);
  return out;
}
function splitToCount(beziers, target) {
  if (beziers.length >= target) return beziers.map((b) => ({ ...b }));
  const extra = target - beziers.length;
  const lens = beziers.map((b) => Math.max(1e-6, dist(b.end, b.start)));
  const total = lens.reduce((s, v) => s + v, 0);
  const counts = lens.map((l) => 1 + Math.floor((l / total) * extra));
  let used = counts.reduce((s, v) => s + v, 0);
  const rems = lens
    .map((l, i) => ({
      i,
      r: (l / total) * extra - Math.floor((l / total) * extra),
    }))
    .sort((a, b) => b.r - a.r);
  for (let i = 0; used < target; i++, used++) counts[rems[i % rems.length].i]++;
  const out = [];
  for (let i = 0; i < beziers.length; i++)
    out.push(...splitBezIntoN(beziers[i], counts[i]));
  return out;
}

// ── Angular best-match (morph v9) ─────────────────────────
function segsCentroid(s) {
  let x = 0,
    y = 0;
  for (const v of s) {
    x += v.start.x;
    y += v.start.y;
  }
  return { x: x / s.length, y: y / s.length };
}
function rotateSegs(s, r) {
  const n = s.length;
  r = ((r % n) + n) % n;
  return r === 0 ? s : [...s.slice(r), ...s.slice(0, r)];
}
function reverseSegs(s) {
  return s
    .slice()
    .reverse()
    .map((v) => ({ start: v.end, c1: v.c2, c2: v.c1, end: v.start }));
}
function angDiff(a, b) {
  let d = Math.abs(a - b) % (2 * Math.PI);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}
function bestMatchB(sA, sB) {
  const n = sA.length,
    cA = segsCentroid(sA),
    cB = segsCentroid(sB);
  const angA = sA.map((v) => Math.atan2(v.start.y - cA.y, v.start.x - cA.x));
  let best = Infinity,
    out = sB;
  for (const cand of [sB, reverseSegs(sB)]) {
    const angC = cand.map((v) =>
      Math.atan2(v.start.y - cB.y, v.start.x - cB.x),
    );
    for (let r = 0; r < n; r++) {
      let sc = 0;
      for (let i = 0; i < n; i++) sc += angDiff(angA[i], angC[(i + r) % n]);
      if (sc < best) {
        best = sc;
        out = rotateSegs(cand, r);
      }
    }
  }
  return out;
}

// ── Blend curve ────────────────────────────────────────────
function buildBlendCurve(bezA, bezB, t, shouldClose) {
  const tgt = Math.max(bezA.length, bezB.length);
  const sA = splitToCount(bezA, tgt);
  let sB = splitToCount(bezB, tgt);
  if (shouldClose) sB = bestMatchB(sA, sB);
  const b = CurveBuilder.create();
  b.begin(lerpPt(sA[0].start, sB[0].start, t));
  for (let i = 0; i < sA.length; i++) {
    const a = sA[i],
      v = sB[i];
    b.addBezier(
      lerpPt(a.c1, v.c1, t),
      lerpPt(a.c2, v.c2, t),
      lerpPt(a.end, v.end, t),
    );
  }
  if (shouldClose) b.close();
  return b.createCurve();
}

// ── Arc-length path sampling ───────────────────────────────
function evalBez(b, t) {
  const u = 1 - t;
  return {
    x:
      u * u * u * b.start.x +
      3 * u * u * t * b.c1.x +
      3 * u * t * t * b.c2.x +
      t * t * t * b.end.x,
    y:
      u * u * u * b.start.y +
      3 * u * u * t * b.c1.y +
      3 * u * t * t * b.c2.y +
      t * t * t * b.end.y,
  };
}
function buildArcTable(beziers) {
  const tbl = [];
  let cum = 0;
  for (let bi = 0; bi < beziers.length; bi++) {
    const b = beziers[bi];
    let prev = evalBez(b, 0);
    if (bi === 0) tbl.push({ bi, t: 0, cum: 0 });
    for (let s = 1; s <= 200; s++) {
      const t = s / 200,
        pt = evalBez(b, t);
      cum += dist(pt, prev);
      tbl.push({ bi, t, cum });
      prev = pt;
    }
  }
  return tbl;
}
function samplePath(tbl, beziers, frac) {
  const total = tbl[tbl.length - 1].cum;
  const c = Math.min(Math.max(frac, 0), 1) * total;
  let lo = 0,
    hi = tbl.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (tbl[mid].cum <= c) lo = mid;
    else hi = mid;
  }
  const a = tbl[lo],
    be = tbl[hi],
    span = be.cum - a.cum;
  const f = span < 1e-9 ? 0 : (c - a.cum) / span;
  return evalBez(beziers[f < 0.5 ? a.bi : be.bi], a.t + (be.t - a.t) * f);
}

// ── Centroid helpers ───────────────────────────────────────
function bezCentroid(bez) {
  let x = 0,
    y = 0;
  for (const b of bez) {
    x += b.start.x;
    y += b.start.y;
  }
  return { x: x / bez.length, y: y / bez.length };
}
function glyphsListCentroid(glyphs) {
  let x = 0,
    y = 0,
    n = 0;
  for (const g of glyphs)
    for (const sc of g.subCurves)
      for (const b of sc.bez) {
        x += b.start.x;
        y += b.start.y;
        n++;
      }
  return n > 0 ? { x: x / n, y: y / n } : { x: 0, y: 0 };
}
function nodeCentroid(node) {
  if (node.isGroupNode) {
    const g = extractGroupGlyphs(node);
    return glyphsListCentroid(g);
  }
  return bezCentroid(getWorldBeziers(node));
}
function translateBez(beziers, from, to) {
  const dx = to.x - from.x,
    dy = to.y - from.y;
  return beziers.map((b) => ({
    start: { x: b.start.x + dx, y: b.start.y + dy },
    c1: { x: b.c1.x + dx, y: b.c1.y + dy },
    c2: { x: b.c2.x + dx, y: b.c2.y + dy },
    end: { x: b.end.x + dx, y: b.end.y + dy },
  }));
}
function shiftGlyph(g, dx, dy) {
  return {
    ...g,
    subCurves: g.subCurves.map((sc) => ({
      ...sc,
      bez: sc.bez.map((b) => ({
        start: { x: b.start.x + dx, y: b.start.y + dy },
        c1: { x: b.c1.x + dx, y: b.c1.y + dy },
        c2: { x: b.c2.x + dx, y: b.c2.y + dy },
        end: { x: b.end.x + dx, y: b.end.y + dy },
      })),
    })),
  };
}

// ── Fill helpers ───────────────────────────────────────────
function extractFillData(node) {
  try {
    const fd = node.brushFillInterface.fillDescriptor,
      fill = fd.fill;
    if (fill.fillType.value === FillType.None.value) return { type: "none" };
    if (fill.fillType.value === FillType.Gradient.value) {
      const grad = fill.gradient,
        stops = [];
      for (let i = 0; i < grad.stopCount; i++) {
        const s = grad.getStop(i),
          rgba = new Colour(s.colour).rgba8;
        stops.push({
          r: rgba.r,
          g: rgba.g,
          b: rgba.b,
          a: rgba.alpha,
          pos: s.position,
          mid: s.midpoint,
        });
      }
      return { type: "gradient", gradFillType: fill.gradientFillType, stops };
    }
    const rgba = fill.colour.rgba8;
    return { type: "solid", r: rgba.r, g: rgba.g, b: rgba.b, a: rgba.alpha };
  } catch (e) {
    return { type: "solid", r: 180, g: 180, b: 180, a: 255 };
  }
}
function extractFillXf(node) {
  try {
    const fd = node.brushFillInterface.fillDescriptor;
    if (fd.fill.fillType.value === FillType.Gradient.value)
      return fd.transform.decompose();
  } catch (e) {}
  const bb = node.getSpreadBaseBox();
  return {
    translateX: bb.x,
    translateY: bb.y + bb.height * 0.5,
    scaleX: bb.width,
    scaleY: 0,
    rotation: 0,
    shear: 0,
  };
}
function lerpDecomp(dA, dB, t) {
  return {
    translateX: lerp(dA.translateX, dB.translateX, t),
    translateY: lerp(dA.translateY, dB.translateY, t),
    scaleX: lerp(dA.scaleX, dB.scaleX, t),
    scaleY: lerp(dA.scaleY, dB.scaleY, t),
    rotation: lerp(dA.rotation, dB.rotation, t),
    shear: lerp(dA.shear, dB.shear, t),
  };
}
function solidToStops(d) {
  return [
    { r: d.r, g: d.g, b: d.b, a: d.a, pos: 0, mid: 0.5 },
    { r: d.r, g: d.g, b: d.b, a: d.a, pos: 1, mid: 0.5 },
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
    const hi = Math.min(lo + 1, stops.length - 1),
      span = stops[hi].pos - stops[lo].pos,
      t2 = span < 0.0001 ? 0 : (f - stops[lo].pos) / span,
      a = stops[lo],
      bv = stops[hi];
    out.push({
      r: Math.round(lerp(a.r, bv.r, t2)),
      g: Math.round(lerp(a.g, bv.g, t2)),
      b: Math.round(lerp(a.b, bv.b, t2)),
      a: Math.round(lerp(a.a, bv.a, t2)),
      pos: f,
      mid: lerp(a.mid, bv.mid, t2),
    });
  }
  return out;
}
function buildFill(fA, fB, dA, dB, t, doInterp) {
  if (!doInterp) {
    fB = fA;
    dB = dA;
  }
  if (fA.type === "none" || fB.type === "none")
    return FillDescriptor.createNone();
  if (fA.type === "gradient" || fB.type === "gradient") {
    const sA = fA.type === "gradient" ? fA.stops : solidToStops(fA),
      sB = fB.type === "gradient" ? fB.stops : solidToStops(fB);
    const tgt = Math.max(sA.length, sB.length);
    const rsA = resampleStops(sA, tgt),
      rsB = resampleStops(sB, tgt);
    const bs = rsA.map((sa, i) => {
      const sb = rsB[i];
      return {
        colour: RGBA8(
          Math.round(lerp(sa.r, sb.r, t)),
          Math.round(lerp(sa.g, sb.g, t)),
          Math.round(lerp(sa.b, sb.b, t)),
          Math.round(lerp(sa.a, sb.a, t)),
        ),
        position: lerp(sa.pos, sb.pos, t),
        midpoint: lerp(sa.mid, sb.mid, t),
      };
    });
    const gft = fA.type === "gradient" ? fA.gradFillType : fB.gradFillType || 0;
    const gf = GradientFill.create(Gradient.create(bs), gft);
    const ld = lerpDecomp(dA, dB, t);
    const xf = Transform.createIdentity();
    xf.compose(ld);
    return FillDescriptor.create(gf, true, xf, BlendMode.Normal, false);
  }
  return FillDescriptor.createSolid(
    RGBA8(
      Math.round(lerp(fA.r, fB.r, t)),
      Math.round(lerp(fA.g, fB.g, t)),
      Math.round(lerp(fA.b, fB.b, t)),
      Math.round(lerp(fA.a, fB.a, t)),
    ),
    BlendMode.Normal,
  );
}
function extractStroke(node) {
  try {
    const lsi = node.lineStyleInterface,
      rgba = lsi.penFillDescriptor.fill.colour.rgba8;
    return {
      r: rgba.r,
      g: rgba.g,
      b: rgba.b,
      a: rgba.alpha,
      weight: lsi.lineStyle.weight,
    };
  } catch (e) {
    return { r: 0, g: 0, b: 0, a: 0, weight: 0 };
  }
}
function lerpStroke(sA, sB, t, doInterp) {
  return {
    r: Math.round(doInterp ? lerp(sA.r, sB.r, t) : sA.r),
    g: Math.round(doInterp ? lerp(sA.g, sB.g, t) : sA.g),
    b: Math.round(doInterp ? lerp(sA.b, sB.b, t) : sA.b),
    a: Math.round(doInterp ? lerp(sA.a, sB.a, t) : sA.a),
    weight: doInterp ? lerp(sA.weight, sB.weight, t) : sA.weight,
  };
}

// ── PolyCurveNodeDef builder ───────────────────────────────
function makeDef(beziers, fill, stroke, name, shouldClose) {
  const builder = CurveBuilder.create();
  builder.begin(beziers[0].start);
  for (const b of beziers) builder.addBezier(b.c1, b.c2, b.end);
  if (shouldClose) builder.close();
  const pc = PolyCurve.create();
  pc.addCurve(builder.createCurve());
  const def = PolyCurveNodeDefinition.createDefault();
  def.setCurves(pc);
  def.setBrushFillDescriptor(0, fill);
  def.setLineDescriptors(
    0,
    FillDescriptor.createSolid(
      RGBA8(stroke.r, stroke.g, stroke.b, stroke.a),
      BlendMode.Normal,
    ),
    LineStyleDescriptor.create(
      LineStyle.createDefaultWithWeight(stroke.weight),
    ),
  );
  def.userDescription = name;
  return def;
}

// ── Group / compound-path glyph extraction ─────────────────
function extractGroupGlyphs(groupNode) {
  const glyphs = [];
  const gd = groupNode.transformInterface.transform.decompose();
  let child = groupNode.firstChild;
  while (child) {
    if (child.isVectorNode) {
      const cd = child.transformInterface.transform.decompose();
      const pc = child.polyCurve;
      const subCurves = [];
      for (let sc = 0; sc < pc.curveCount; sc++) {
        const bez = [...pc.at(sc).beziers]
          .map((s) => bezToWorld(cd, s))
          .map((s) => bezToWorld(gd, s));
        subCurves.push({ bez, isClosed: pc.at(sc).isClosed });
      }
      glyphs.push({
        subCurves,
        fill: extractFillData(child),
        fillXf: extractFillXf(child),
        stroke: extractStroke(child),
      });
    }
    child = child.nextSibling;
  }
  return glyphs;
}
function padGlyphs(glyphs, target) {
  if (glyphs.length >= target) return glyphs.slice(0, target);
  const out = [...glyphs];
  const last = glyphs[glyphs.length - 1];
  const pts = last.subCurves[0].bez.flatMap((s) => [s.start, s.end]);
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length,
    cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const ptSubs = last.subCurves.map((sc) => ({
    bez: sc.bez.map(() => ({
      start: { x: cx, y: cy },
      c1: { x: cx, y: cy },
      c2: { x: cx, y: cy },
      end: { x: cx, y: cy },
    })),
    isClosed: sc.isClosed,
  }));
  while (out.length < target)
    out.push({
      subCurves: ptSubs,
      fill: last.fill,
      fillXf: last.fillXf,
      stroke: last.stroke,
    });
  return out;
}
function buildGlyphDef(gA, gB, t, doFill, doStroke, name) {
  const pc = PolyCurve.create();
  const subCount = Math.max(gA.subCurves.length, gB.subCurves.length);
  for (let sc = 0; sc < subCount; sc++) {
    const sA = sc < gA.subCurves.length ? gA.subCurves[sc] : null,
      sB = sc < gB.subCurves.length ? gB.subCurves[sc] : null;
    let bA, bB, closed;
    if (!sA) {
      const pts = sB.bez.flatMap((s) => [s.start, s.end]);
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length,
        cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      bA = sB.bez.map(() => ({
        start: { x: cx, y: cy },
        c1: { x: cx, y: cy },
        c2: { x: cx, y: cy },
        end: { x: cx, y: cy },
      }));
      bB = sB.bez;
      closed = sB.isClosed;
    } else if (!sB) {
      const pts = sA.bez.flatMap((s) => [s.start, s.end]);
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length,
        cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      bA = sA.bez;
      bB = sA.bez.map(() => ({
        start: { x: cx, y: cy },
        c1: { x: cx, y: cy },
        c2: { x: cx, y: cy },
        end: { x: cx, y: cy },
      }));
      closed = sA.isClosed;
    } else {
      bA = sA.bez;
      bB = sB.bez;
      closed = sA.isClosed && sB.isClosed;
    }
    pc.addCurve(buildBlendCurve(bA, bB, t, closed));
  }
  const fill = buildFill(gA.fill, gB.fill, gA.fillXf, gB.fillXf, t, doFill);
  const stk = lerpStroke(gA.stroke, gB.stroke, t, doStroke);
  const def = PolyCurveNodeDefinition.createDefault();
  def.setCurves(pc);
  def.setBrushFillDescriptor(0, fill);
  def.setLineDescriptors(
    0,
    FillDescriptor.createSolid(
      RGBA8(stk.r, stk.g, stk.b, stk.a),
      BlendMode.Normal,
    ),
    LineStyleDescriptor.create(LineStyle.createDefaultWithWeight(stk.weight)),
  );
  def.userDescription = name;
  return def;
}

// ── Vector blend def builders ──────────────────────────────
function buildVectorDefs(
  bezA,
  bezB,
  shouldClose,
  fillA,
  fillB,
  xfA,
  xfB,
  stkA,
  stkB,
  steps,
  doFill,
  doStroke,
) {
  const defs = [];
  defs.push(
    makeDef(
      bezA,
      buildFill(fillA, fillA, xfA, xfA, 0, false),
      stkA,
      "Sh 1",
      shouldClose,
    ),
  );
  for (let s = 1; s <= steps; s++) {
    const t = s / (steps + 1);
    const pc = PolyCurve.create();
    pc.addCurve(buildBlendCurve(bezA, bezB, t, shouldClose));
    const def = PolyCurveNodeDefinition.createDefault();
    def.setCurves(pc);
    def.setBrushFillDescriptor(0, buildFill(fillA, fillB, xfA, xfB, t, doFill));
    const stk = lerpStroke(stkA, stkB, t, doStroke);
    def.setLineDescriptors(
      0,
      FillDescriptor.createSolid(
        RGBA8(stk.r, stk.g, stk.b, stk.a),
        BlendMode.Normal,
      ),
      LineStyleDescriptor.create(LineStyle.createDefaultWithWeight(stk.weight)),
    );
    def.userDescription = "Step " + s;
    defs.push(def);
  }
  defs.push(
    makeDef(
      bezB,
      buildFill(fillB, fillB, xfB, xfB, 0, false),
      stkB,
      "Sh 2",
      shouldClose,
    ),
  );
  return defs;
}
function buildPathVectorDefs(
  bezA,
  bezB,
  shouldClose,
  pathBeziers,
  fillA,
  fillB,
  xfA,
  xfB,
  stkA,
  stkB,
  steps,
  doFill,
  doStroke,
) {
  const tbl = buildArcTable(pathBeziers);
  const defs = [];
  const ptS = samplePath(tbl, pathBeziers, 0);
  defs.push(
    makeDef(
      translateBez(bezA, bezCentroid(bezA), ptS),
      buildFill(fillA, fillA, xfA, xfA, 0, false),
      stkA,
      "Sh 1",
      shouldClose,
    ),
  );
  for (let s = 1; s <= steps; s++) {
    const frac = s / (steps + 1);
    const pathPt = samplePath(tbl, pathBeziers, frac);
    const tgt = Math.max(bezA.length, bezB.length);
    const sA = splitToCount(bezA, tgt);
    let sB = splitToCount(bezB, tgt);
    if (shouldClose) sB = bestMatchB(sA, sB);
    const interp = sA.map((a, i) => {
      const v = sB[i];
      return {
        start: lerpPt(a.start, v.start, frac),
        c1: lerpPt(a.c1, v.c1, frac),
        c2: lerpPt(a.c2, v.c2, frac),
        end: lerpPt(a.end, v.end, frac),
      };
    });
    defs.push(
      makeDef(
        translateBez(interp, bezCentroid(interp), pathPt),
        buildFill(fillA, fillB, xfA, xfB, frac, doFill),
        lerpStroke(stkA, stkB, frac, doStroke),
        "Step " + s,
        shouldClose,
      ),
    );
  }
  const ptE = samplePath(tbl, pathBeziers, 1);
  defs.push(
    makeDef(
      translateBez(bezB, bezCentroid(bezB), ptE),
      buildFill(fillB, fillB, xfB, xfB, 0, false),
      stkB,
      "Sh 2",
      shouldClose,
    ),
  );
  return defs;
}

// ── Document execution helpers ────────────────────────────
function exec(doc, cmd) {
  doc.executeCommand(cmd);
}
function undoN(doc, n) {
  for (let i = 0; i < n; i++) exec(doc, DocumentCommand.createUndo());
}
function deleteNode(doc, node) {
  exec(doc, DocumentCommand.createSetSelection(node.selfSelection));
  doc.deleteSelection();
}

function execVectorBlend(doc, defs, label) {
  const cb = AddChildNodesCommandBuilder.create();
  cb.addContainerNode(ContainerNodeDefinition.create(label));
  const ccmd = cb.createCommand(false, NodeChildType.Main);
  exec(doc, ccmd);
  const cont = ccmd.newNodes[0];
  const ch = AddChildNodesCommandBuilder.create();
  ch.setInsertionTarget(cont);
  for (const d of defs) ch.addNode(d);
  exec(doc, ch.createCommand(false, NodeChildType.Main));
  return 2;
}

function execGroupBlend(
  doc,
  nodeA,
  nodeB,
  steps,
  doFill,
  doStroke,
  label,
  pathBeziers,
) {
  const glyphsA = extractGroupGlyphs(nodeA),
    glyphsB = extractGroupGlyphs(nodeB);
  const count = Math.max(glyphsA.length, glyphsB.length);
  const paddedA = padGlyphs(glyphsA, count),
    paddedB = padGlyphs(glyphsB, count);
  const onPath = !!pathBeziers;
  const tbl = onPath ? buildArcTable(pathBeziers) : null;
  const centA = onPath ? glyphsListCentroid(glyphsA) : null;
  const centB = onPath ? glyphsListCentroid(glyphsB) : null;
  let n = 0;
  const cb = AddChildNodesCommandBuilder.create();
  cb.addContainerNode(ContainerNodeDefinition.create(label));
  const ccmd = cb.createCommand(false, NodeChildType.Main);
  exec(doc, ccmd);
  n++;
  const main = ccmd.newNodes[0];
  function addStep(name, gA_arr, gB_arr, t, dx, dy) {
    const scb = AddChildNodesCommandBuilder.create();
    scb.setInsertionTarget(main);
    scb.addContainerNode(ContainerNodeDefinition.create(name));
    const scmd = scb.createCommand(false, NodeChildType.Main);
    exec(doc, scmd);
    n++;
    const stepC = scmd.newNodes[0];
    const gcb = AddChildNodesCommandBuilder.create();
    gcb.setInsertionTarget(stepC);
    for (let g = 0; g < count; g++) {
      const sA = onPath ? shiftGlyph(gA_arr[g], dx, dy) : gA_arr[g];
      const sB = onPath ? shiftGlyph(gB_arr[g], dx, dy) : gB_arr[g];
      gcb.addNode(
        buildGlyphDef(sA, sB, t, doFill, doStroke, "Glyph " + (g + 1)),
      );
    }
    exec(doc, gcb.createCommand(false, NodeChildType.Main));
    n++;
  }
  if (onPath) {
    const ptS = samplePath(tbl, pathBeziers, 0);
    addStep("Sh 1", paddedA, paddedA, 0, ptS.x - centA.x, ptS.y - centA.y);
  } else addStep("Sh 1", paddedA, paddedA, 0, 0, 0);
  for (let s = 1; s <= steps; s++) {
    const frac = s / (steps + 1);
    if (onPath) {
      const pathPt = samplePath(tbl, pathBeziers, frac);
      const interpC = lerpPt(centA, centB, frac);
      addStep(
        "Step " + s,
        paddedA,
        paddedB,
        frac,
        pathPt.x - interpC.x,
        pathPt.y - interpC.y,
      );
    } else addStep("Step " + s, paddedA, paddedB, frac, 0, 0);
  }
  if (onPath) {
    const ptE = samplePath(tbl, pathBeziers, 1);
    addStep("Sh 2", paddedB, paddedB, 0, ptE.x - centB.x, ptE.y - centB.y);
  } else addStep("Sh 2", paddedB, paddedB, 0, 0, 0);
  return n;
}

// ── Error dialog (fixed: isFullWidth prevents text being obscured) ──
function showError(msg) {
  const d = Dialog.create("Blend Tool");
  d.initialWidth = 420;
  const col = d.addColumn();
  const grp = col.addGroup("Error");
  const txt = grp.addStaticText("", msg);
  txt.isFullWidth = true;
  d.runModal();
}
// ════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════
const doc = Document.current;
const sel = doc.selection;
const selLen = sel ? sel.length : 0;

if (selLen < 2 || selLen > 3) {
  showError(
    "Select 2 objects to blend, or 3 objects for Blend on Path (3rd = path).\n\nAny type works as a blend target:\n • Vector shapes (closed or open / lines)\n • Groups (text \u2192 Convert to Curves)",
  );
} else {
  // ── SIMPLE classification: first 2 = targets, third = path ──
  // No open/closed detection. Selection order is the contract.
  const allNodes = [];
  for (let i = 0; i < selLen; i++) allNodes.push(sel.at(i).node);
  const nodeA = allNodes[0],
    nodeB = allNodes[1];
  const pathNode = selLen === 3 ? allNodes[2] : null;
  const onPath = pathNode !== null;

  // Validate blend targets
  const bothVec = nodeA.isVectorNode && nodeB.isVectorNode;
  const bothGroup = nodeA.isGroupNode && nodeB.isGroupNode;
  if (!bothVec && !bothGroup) {
    showError(
      "Both blend targets (1st and 2nd selected) must be the same type.\n\n \u2022 Two vector objects \u2192 direct blend\n \u2022 Two groups (Convert to Curves) \u2192 text blend\n\nFor Blend on Path: select targets first, then the path last.",
    );
  } else if (onPath && !pathNode.isVectorNode) {
    showError(
      "The 3rd selected object (path/spine) must be a vector node.\nSelect your 2 blend targets first, then the path last.",
    );
  } else {
    // ── Extract geometry ──────────────────────────────────
    let bezA,
      bezB,
      shouldClose,
      fillA,
      fillB,
      xfA,
      xfB,
      stkA,
      stkB,
      pathBeziers;
    if (bothVec) {
      bezA = getWorldBeziers(nodeA);
      bezB = getWorldBeziers(nodeB);
      shouldClose =
        nodeA.polyCurve.at(0).isClosed && nodeB.polyCurve.at(0).isClosed;
      fillA = extractFillData(nodeA);
      fillB = extractFillData(nodeB);
      xfA = extractFillXf(nodeA);
      xfB = extractFillXf(nodeB);
      stkA = extractStroke(nodeA);
      stkB = extractStroke(nodeB);
    }
    if (onPath) {
      // Path may be open OR closed — we sample it in full either way
      pathBeziers = getWorldBeziers(pathNode);
    }

    // ── Auto-orient for path: shape closer to path start → Sh 1 ──
    let autoSwap = false;
    if (onPath) {
      const tbl0 = buildArcTable(pathBeziers);
      const ptStart = samplePath(tbl0, pathBeziers, 0);
      autoSwap =
        dist(nodeCentroid(nodeB), ptStart) < dist(nodeCentroid(nodeA), ptStart);
    }

    const nameA =
      nodeA.userDescription || nodeA.defaultDescription || "Shape A";
    const nameB =
      nodeB.userDescription || nodeB.defaultDescription || "Shape B";
    const pathName = onPath
      ? pathNode.userDescription || pathNode.defaultDescription || "Path"
      : "";

    // ── Build dialog ──────────────────────────────────────
    const dlg = Dialog.create("Blend Tool");
    dlg.initialWidth = 360;
    const col = dlg.addColumn();
    const modeLabel = onPath
      ? "Blend on Path"
      : bothGroup
        ? "Blend (grouped curves)"
        : "Blend";
    const selGrp = col.addGroup(modeLabel);
    selGrp.addStaticText("Sh 1", nameA);
    selGrp.addStaticText("Sh 2", nameB);
    if (onPath) {
      selGrp.addStaticText("Path", pathName);
      if (autoSwap)
        selGrp.addStaticText(
          "Auto-orient",
          nameB + " \u2192 Sh 1 (closer to path start)",
        );
    }

    const blendGrp = col.addGroup("Blend");
    const stepsCtrl = blendGrp.addUnitValueEditor(
      "Steps",
      UnitType.Number,
      UnitType.Number,
      15,
      1,
      9999,
    );
    stepsCtrl.precision = 0;
    stepsCtrl.showPopupSlider = true;

    const orientGrp = col.addGroup("Orientation");
    const reverseCtrl = orientGrp.addSwitch(
      "Reverse direction (swap Sh 1 \u2194 Sh 2)",
      false,
    );

    const colGrp = col.addGroup("Colour");
    const fillCtrl = colGrp.addSwitch("Interpolate fill colour", true);
    const strokeCtrl = colGrp.addSwitch("Interpolate stroke", true);

    // Status + buttons
    const actGrp = col.addGroup("");
    actGrp.enableSeparator = true;
    // Status text: use empty label so text spans full width, then force left-align.
    const statusCtrl = actGrp.addStaticText("", "");
    statusCtrl.text =
      "• Preview active - click OK to update after changing settings";
    statusCtrl.textHorizontalAlignment = HorizontalAlignment.Left;
    // 2-button set: Preview (0) and Apply (1).
    // Native Cancel / OK sit below automatically.
    const btns = actGrp.addButtonSet("", ["↺  Preview", "✓  Apply"], 0);
    btns.isFullWidth = true;

    // ── doApply helper ────────────────────────────────────
    function doApply(steps, doFill, doStroke, reverse) {
      const swap = onPath ? autoSwap !== reverse : reverse;
      const nA = swap ? nodeB : nodeA,
        nB = swap ? nodeA : nodeB;
      const lA = swap ? nameB : nameA,
        lB = swap ? nameA : nameB;
      const label = onPath
        ? "Blend on Path: " + lA + " \u2192 " + lB
        : "Blend: " + lA + " \u2192 " + lB;
      if (bothGroup) {
        const gA = swap ? nodeB : nodeA,
          gB = swap ? nodeA : nodeB;
        return execGroupBlend(
          doc,
          gA,
          gB,
          steps,
          doFill,
          doStroke,
          label,
          onPath ? pathBeziers : null,
        );
      }
      const bA = swap ? bezB : bezA,
        bB = swap ? bezA : bezB;
      const fA = swap ? fillB : fillA,
        fB = swap ? fillA : fillB;
      const fxA = swap ? xfB : xfA,
        fxB = swap ? xfA : xfB;
      const stA = swap ? stkB : stkA,
        stB = swap ? stkA : stkB;
      const defs = onPath
        ? buildPathVectorDefs(
            bA,
            bB,
            shouldClose,
            pathBeziers,
            fA,
            fB,
            fxA,
            fxB,
            stA,
            stB,
            steps,
            doFill,
            doStroke,
          )
        : buildVectorDefs(
            bA,
            bB,
            shouldClose,
            fA,
            fB,
            fxA,
            fxB,
            stA,
            stB,
            steps,
            doFill,
            doStroke,
          );
      return execVectorBlend(doc, defs, label);
    }

    // ── Initial preview ───────────────────────────────────
    let cmdCount = 0,
      previewActive = false,
      blendLabel = "";
    try {
      const swap = onPath ? autoSwap !== false : false;
      const lA = swap ? nameB : nameA,
        lB = swap ? nameA : nameB;
      blendLabel = onPath
        ? "Blend on Path: " + lA + " \u2192 " + lB
        : "Blend: " + lA + " \u2192 " + lB;
      cmdCount = doApply(15, true, true, false);
      previewActive = true;
    } catch (e) {
      statusCtrl.text = "Preview failed: " + e.message;
      console.log("Blend initial error:", e.stack);
    }

    // ── Dialog loop ───────────────────────────────────────
    //  ButtonSet index: 0 = Preview, 1 = Apply
    //  Native OK closes with DialogResult.Ok
    //  Native Cancel closes with non-Ok → undo + exit
    let running = true;
    while (running) {
      btns.selectedIndex = 0;
      const result = dlg.runModal();
      const steps = Math.max(1, Math.round(stepsCtrl.value));
      const doFill = fillCtrl.value,
        doStroke = strokeCtrl.value,
        reverse = reverseCtrl.value;
      const mode = btns.selectedIndex; // 0=Preview, 1=Apply

      if (result.value !== DialogResult.Ok.value) {
        // Native Cancel or window close — undo preview and exit
        if (previewActive) {
          undoN(doc, cmdCount);
          previewActive = false;
        }
        running = false;
      } else if (mode === 1) {
        // Apply: refresh with current settings, commit, tidy up path
        if (previewActive) {
          undoN(doc, cmdCount);
          previewActive = false;
        }
        try {
          // Recompute label with current reverse state
          const swap = onPath ? autoSwap !== reverse : reverse;
          const lA = swap ? nameB : nameA,
            lB = swap ? nameA : nameB;
          blendLabel = onPath
            ? "Blend on Path: " + lA + " \u2192 " + lB
            : "Blend: " + lA + " \u2192 " + lB;
          cmdCount = doApply(steps, doFill, doStroke, reverse);
          previewActive = true;
          // Delete source shapes
          deleteNode(doc, nodeA);
          deleteNode(doc, nodeB);
          // Path: rename to "Path Spine: <blend name>" and hide it
          if (onPath) {
            const spineName = "Path Spine: " + blendLabel;
            exec(
              doc,
              DocumentCommand.createSetDescription(
                pathNode.selfSelection,
                spineName,
              ),
            );
            exec(
              doc,
              DocumentCommand.createSetVisibility(
                pathNode.selfSelection,
                false,
              ),
            );
          }
        } catch (e) {
          showError("Blend failed: " + e.message);
          console.log("Blend error:", e.stack);
        }
        running = false;
      } else {
        // Preview: undo old, apply new, update status, reopen
        if (previewActive) {
          undoN(doc, cmdCount);
          previewActive = false;
          cmdCount = 0;
        }
        try {
          const swap = onPath ? autoSwap !== reverse : reverse;
          const lA = swap ? nameB : nameA,
            lB = swap ? nameA : nameB;
          blendLabel = onPath
            ? "Blend on Path: " + lA + " \u2192 " + lB
            : "Blend: " + lA + " \u2192 " + lB;
          cmdCount = doApply(steps, doFill, doStroke, reverse);
          previewActive = true;
          statusCtrl.text =
            "• Preview: " +
            steps +
            " step" +
            (steps === 1 ? "" : "s") +
            (onPath ? " on path" : "") +
            (reverse ? " \u00b7 reversed" : "") +
            " - click OK to update";
        } catch (e) {
          statusCtrl.text = "Preview failed: " + e.message;
          console.log("Blend preview error:", e.stack);
        }
        // continue loop → runModal called again
      }
    }
  }
}
