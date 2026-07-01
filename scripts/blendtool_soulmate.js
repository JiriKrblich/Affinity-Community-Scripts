/**
 * name: Blend Tool (混合工具)
 * description: Select multiple shapes Blend it together or use last selected path as blend path. 选择多个形状混合，支持将最后选择的一个形状作为混合路径。Rewrite from Blend-tool by robinsnest56.
 * version: 2.0.0
 * author: Soulmate
 */

"use strict";
// Blend-tool v2.0.0 (2026-06-30) by Soulmate
// Changes from v1.0.0:
//   - Add multi-shape blending support
//   - Add Stroke to Filled shape blending support
//   - Optimize UI
//   - Change last selected shape as blend path as switchable option

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
const PATH_SAMPLE_STEPS = 80;

// ── World-space transform ─────────────────────────────────
function applyXf(xf, pt) {
  return xf.applyToPoint(pt);
}
function bezToWorld(xf, seg) {
  return {
    start: applyXf(xf, seg.start),
    c1: applyXf(xf, seg.c1),
    c2: applyXf(xf, seg.c2),
    end: applyXf(xf, seg.end),
  };
}
function getWorldBeziers(node) {
  const xf = node.transformInterface.transform;
  return [...node.polyCurve.at(0).beziers].map((s) => bezToWorld(xf, s));
}
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
  } catch (e) {
    reported = null;
  }
  if (reported && reported > 0) return reported;
  if (!polyCurveAt(pc, 0)) return 0;

  let n = 0;
  let prev = null;
  for (; n < 2048; n++) {
    const curve = polyCurveAt(pc, n);
    if (!curve || curve === prev) break;
    prev = curve;
  }
  return Math.max(1, n);
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
function openPathMatchB(sA, sB) {
  const lastA = sA[sA.length - 1],
    lastB = sB[sB.length - 1];
  const same = dist(sA[0].start, sB[0].start) + dist(lastA.end, lastB.end);
  const flipped = dist(sA[0].start, lastB.end) + dist(lastA.end, sB[0].start);
  return flipped < same ? reverseSegs(sB) : sB;
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
function matchBToA(sA, sB, shouldClose) {
  return shouldClose ? bestMatchB(sA, sB) : openPathMatchB(sA, sB);
}

// ── Blend curve ────────────────────────────────────────────
function prepareBlendSegments(bezA, bezB, shouldClose) {
  const tgt = Math.max(bezA.length, bezB.length);
  const sA = splitToCount(bezA, tgt);
  const sB = matchBToA(sA, splitToCount(bezB, tgt), shouldClose);
  return { sA, sB };
}
function buildBlendCurveFromSegments(sA, sB, t, shouldClose) {
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
function buildBlendCurve(bezA, bezB, t, shouldClose) {
  const pair = prepareBlendSegments(bezA, bezB, shouldClose);
  return buildBlendCurveFromSegments(pair.sA, pair.sB, t, shouldClose);
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
    for (let s = 1; s <= PATH_SAMPLE_STEPS; s++) {
      const t = s / PATH_SAMPLE_STEPS,
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
function defaultFillData() {
  return { type: "solid", r: 180, g: 180, b: 180, a: 255 };
}
function extractFillDataFromDescriptor(fd, fallback) {
  try {
    const fill = fd.fill;
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
    return fallback;
  }
}
function defaultFillXf(node) {
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
function extractFillXfFromDescriptor(fd, node) {
  try {
    if (fd.fill.fillType.value === FillType.Gradient.value)
      return fd.transform.decompose();
  } catch (e) {}
  return defaultFillXf(node);
}
function extractFillData(node) {
  try {
    return extractFillDataFromDescriptor(
      node.brushFillInterface.fillDescriptor,
      defaultFillData(),
    );
  } catch (e) {
    return defaultFillData();
  }
}
function extractFillXf(node) {
  try {
    return extractFillXfFromDescriptor(
      node.brushFillInterface.fillDescriptor,
      node,
    );
  } catch (e) {
    return defaultFillXf(node);
  }
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
function transparentFillLike(f) {
  if (f.type === "gradient") {
    return {
      type: "gradient",
      gradFillType: f.gradFillType,
      stops: f.stops.map((s) => ({ ...s, a: 0 })),
    };
  }
  if (f.type === "solid") return { ...f, a: 0 };
  return { type: "none" };
}
function normalizeFillPair(fA, fB, dA, dB, doInterp) {
  if (!doInterp) return { fA, fB: fA, dA, dB: dA };
  if (fA.type === "none" && fB.type === "none") return { fA, fB, dA, dB };
  if (fA.type === "none") return { fA: transparentFillLike(fB), fB, dA: dB, dB };
  if (fB.type === "none") return { fA, fB: transparentFillLike(fA), dA, dB: dA };
  return { fA, fB, dA, dB };
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
  const fillPair = normalizeFillPair(fA, fB, dA, dB, doInterp);
  fA = fillPair.fA;
  fB = fillPair.fB;
  dA = fillPair.dA;
  dB = fillPair.dB;
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
      fd = lsi.penFillDescriptor,
      fill = extractFillDataFromDescriptor(fd, { type: "none" });
    return {
      fill,
      fillXf: extractFillXfFromDescriptor(fd, node),
      weight: fill.type === "none" ? 0 : lsi.lineStyle.weight,
    };
  } catch (e) {
    return { fill: { type: "none" }, fillXf: defaultFillXf(node), weight: 0 };
  }
}
function strokeFillDescriptor(stroke) {
  if (stroke.fillDescriptor) return stroke.fillDescriptor;
  return buildFill(
    stroke.fill,
    stroke.fill,
    stroke.fillXf,
    stroke.fillXf,
    0,
    false,
  );
}
function lerpStroke(sA, sB, t, doInterp) {
  return {
    fillDescriptor: buildFill(
      sA.fill,
      sB.fill,
      sA.fillXf,
      sB.fillXf,
      t,
      doInterp,
    ),
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
  def.setBrushFillDescriptor(fill, 0);
  def.setLineDescriptors(
    strokeFillDescriptor(stroke),
    LineStyleDescriptor.create(
      LineStyle.createDefaultWithWeight(stroke.weight),
    ),
    0,
  );
  def.userDescription = name;
  return def;
}

// ── Group / compound-path glyph extraction ─────────────────
function extractGroupGlyphs(groupNode) {
  const glyphs = [];
  const groupXf = groupNode.transformInterface.transform;
  let child = groupNode.firstChild;
  while (child) {
    if (child.isVectorNode || child.polyCurve) {
      const childXf = child.transformInterface.transform;
      const pc = child.polyCurve;
      const subCurves = [];
      for (let sc = 0, curveTotal = polyCurveCount(pc); sc < curveTotal; sc++) {
        const curve = polyCurveAt(pc, sc);
        if (!curve) continue;
        const bez = [...curve.beziers]
          .map((s) => bezToWorld(childXf, s))
          .map((s) => bezToWorld(groupXf, s));
        subCurves.push({ bez, isClosed: curve.isClosed });
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
  def.setBrushFillDescriptor(fill, 0);
  def.setLineDescriptors(
    strokeFillDescriptor(stk),
    LineStyleDescriptor.create(LineStyle.createDefaultWithWeight(stk.weight)),
    0,
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
  const pair = prepareBlendSegments(bezA, bezB, shouldClose);
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
    pc.addCurve(buildBlendCurveFromSegments(pair.sA, pair.sB, t, shouldClose));
    const def = PolyCurveNodeDefinition.createDefault();
    def.setCurves(pc);
    def.setBrushFillDescriptor(buildFill(fillA, fillB, xfA, xfB, t, doFill), 0);
    const stk = lerpStroke(stkA, stkB, t, doStroke);
    def.setLineDescriptors(
      strokeFillDescriptor(stk),
      LineStyleDescriptor.create(LineStyle.createDefaultWithWeight(stk.weight)),
      0,
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
  const pair = prepareBlendSegments(bezA, bezB, shouldClose);
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
    const interp = pair.sA.map((a, i) => {
      const v = pair.sB[i];
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

if (selLen < 2) {
  showError("Select at least 2 vector objects or 2 grouped curve objects.");
} else {
  const rawSelectionItems = [];
  const allNodes = [];
  for (let i = 0; i < selLen; i++) {
    const raw = sel.at(i);
    rawSelectionItems.push(raw);
    allNodes.push(resolveSelectionNode(raw));
  }

  function nodeName(node, fallback) {
    if (!node) return fallback;
    return node.userDescription || node.defaultDescription || fallback;
  }

  function clampSteps(value) {
    const n = Math.round(Number(value));
    if (!isFinite(n)) return 1;
    return Math.max(1, Math.min(9999, n));
  }

  function nodeIndex(node) {
    for (let i = 0; i < allNodes.length; i++) if (allNodes[i] === node) return i;
    return -1;
  }

  function maybeNodeLike(obj) {
    try {
      return !!obj && (
        !!obj.selfSelection ||
        !!obj.polyCurve ||
        !!obj.firstChild ||
        !!obj.transformInterface ||
        obj.isVectorNode !== undefined ||
        obj.isGroupNode !== undefined ||
        obj.userDescription !== undefined ||
        obj.defaultDescription !== undefined
      );
    } catch (e) {
      return false;
    }
  }

  function unwrapCandidate(obj, key) {
    try {
      const v = obj && obj[key];
      return typeof v === "function" ? v.call(obj) : v;
    } catch (e) {
      return null;
    }
  }

  function readablePropertyNames(obj) {
    const out = [];
    const seen = {};
    function addName(name) {
      if (!name || name === "constructor" || seen[name]) return;
      seen[name] = true;
      out.push(name);
    }
    try { Object.getOwnPropertyNames(obj || {}).forEach(addName); } catch (e) {}
    try { Object.keys(obj || {}).forEach(addName); } catch (e) {}
    try {
      const proto = Object.getPrototypeOf(obj);
      if (proto) Object.getOwnPropertyNames(proto).forEach(addName);
    } catch (e) {}
    return out;
  }

  function readProperty(obj, key) {
    try {
      const v = obj && obj[key];
      return typeof v === "function" ? null : v;
    } catch (e) {
      return null;
    }
  }

  function resolveSelectionNode(item, depthLimit) {
    if (depthLimit === undefined) depthLimit = 0;
    if (depthLimit > 6) return item;
    let current = item;
    const keys = [
      "node",
      "item",
      "object",
      "target",
      "selectedNode",
      "selectionNode",
      "source",
      "content",
      "value",
      "entity",
      "model",
      "documentNode",
      "nodeRef",
      "shape",
      "layer",
      "child",
      "curve",
      "getNode",
      "getItem",
      "getObject",
      "getTarget",
      "getSelectedNode",
      "getDocumentNode",
    ];

    for (let depth = 0; depth < 5; depth++) {
      if (maybeNodeLike(current) && current.constructor && current.constructor.name !== "SelectionItem") return current;
      for (const key of keys) {
        const candidate = unwrapCandidate(current, key);
        if (candidate && candidate !== current) {
          if (maybeNodeLike(candidate) && (!candidate.constructor || candidate.constructor.name !== "SelectionItem")) return candidate;
          const nested = resolveSelectionNode(candidate, depthLimit + 1);
          if (nested && nested !== candidate) return nested;
        }
      }
      for (const key of readablePropertyNames(current)) {
        const candidate = readProperty(current, key);
        if (candidate && candidate !== current && typeof candidate === "object") {
          if (maybeNodeLike(candidate) && (!candidate.constructor || candidate.constructor.name !== "SelectionItem")) return candidate;
        }
      }
      break;
    }
    return item;
  }

  function shortValue(v) {
    try {
      if (v === null) return "null";
      if (v === undefined) return "undefined";
      if (typeof v === "function") return "function";
      if (typeof v === "object") return "object";
      return String(v);
    } catch (e) {
      return "?";
    }
  }

  function objectKeysText(obj) {
    try {
      const keys = readablePropertyNames(obj || {});
      return keys.length ? keys.slice(0, 32).join(",") : "none";
    } catch (e) {
      return "ERR";
    }
  }

  function nodeDebugLine(node, index, label) {
    const parts = [];
    parts.push((label || "node") + "#" + (index + 1) + " " + nodeName(node, "?"));
    try { parts.push("type=" + shortValue(node && node.type)); } catch (e) {}
    try { parts.push("class=" + shortValue(node && node.constructor && node.constructor.name)); } catch (e) {}
    try { parts.push("keys=" + objectKeysText(node)); } catch (e) {}
    try { parts.push("isVector=" + shortValue(node && node.isVectorNode)); } catch (e) {}
    try { parts.push("isGroup=" + shortValue(node && node.isGroupNode)); } catch (e) {}
    try { parts.push("hasSelfSel=" + (!!(node && node.selfSelection))); } catch (e) { parts.push("hasSelfSel=ERR"); }
    try { parts.push("hasPoly=" + (!!(node && node.polyCurve))); } catch (e) { parts.push("hasPoly=ERR"); }
    try { parts.push("pcCount=" + (node && node.polyCurve ? polyCurveCount(node.polyCurve) : "none")); } catch (e) { parts.push("pcCount=ERR:" + e.message); }
    try { parts.push("at0=" + (!!(node && node.polyCurve && polyCurveAt(node.polyCurve, 0)))); } catch (e) { parts.push("at0=ERR"); }
    try { parts.push("hasChildren=" + hasChildNodes(node)); } catch (e) { parts.push("hasChildren=ERR"); }
    try { parts.push("curveChildren=" + hasCurveChildren(node)); } catch (e) { parts.push("curveChildren=ERR"); }
    return parts.join(" | ");
  }

  function friendlyError(message) {
    const e = Error(message);
    e.userFriendly = true;
    return e;
  }

  function selectionDebugText(err) {
    if (err && err.userFriendly) return err.message;
    const lines = [err.message, "Selection diagnostics:"];
    for (let i = 0; i < allNodes.length; i++) {
      lines.push(nodeDebugLine(rawSelectionItems[i], i, "raw"));
      if (allNodes[i] !== rawSelectionItems[i]) lines.push(nodeDebugLine(allNodes[i], i, "resolved"));
    }
    return lines.join("\n");
  }

  function hasCurveData(node) {
    try {
      return !!node && !!node.polyCurve && polyCurveCount(node.polyCurve) > 0 && !!node.transformInterface;
    } catch (e) {
      return false;
    }
  }

  function hasChildNodes(node) {
    try {
      return !!node && !!node.firstChild;
    } catch (e) {
      return false;
    }
  }

  function hasCurveChildren(node, depth) {
    if (depth === undefined) depth = 0;
    if (depth > 12) return false;
    try {
      let child = node.firstChild;
      while (child) {
        if (hasCurveData(child) || hasCurveChildren(child, depth + 1)) return true;
        child = child.nextSibling;
      }
    } catch (e) {
      return false;
    }
    return false;
  }

  function isBlendTargetNode(node) {
    return !!node && (hasCurveData(node) || node.isVectorNode || hasCurveChildren(node));
  }

  function vectorItem(node, index) {
    if (!hasCurveData(node)) throw Error("Selected target " + (index + 1) + " is not a curve object.");
    const curves = node.polyCurve;
    const bez = getWorldBeziers(node);
    if (!bez.length) throw Error("Selected target " + (index + 1) + " has no editable curve segments.");
    return {
      node,
      name: nodeName(node, "Shape " + (index + 1)),
      bez,
      fill: extractFillData(node),
      fillXf: extractFillXf(node),
      stroke: extractStroke(node),
      isClosed: curves && polyCurveCount(curves) > 0 ? curves.at(0).isClosed : false,
    };
  }

  function curveGlyphs(node, index) {
    if (!hasCurveData(node)) throw Error("Selected target " + (index + 1) + " is not a curve object.");
    const xf = node.transformInterface.transform;
    const pc = node.polyCurve;
    const subCurves = [];
    for (let sc = 0, curveTotal = polyCurveCount(pc); sc < curveTotal; sc++) {
      const curve = polyCurveAt(pc, sc);
      if (!curve) continue;
      const bez = [...curve.beziers].map((s) => bezToWorld(xf, s));
      if (bez.length) subCurves.push({ bez, isClosed: curve.isClosed });
    }
    if (!subCurves.length) throw Error("Selected target " + (index + 1) + " has no editable curve segments.");
    return [
      {
        subCurves,
        fill: extractFillData(node),
        fillXf: extractFillXf(node),
        stroke: extractStroke(node),
      },
    ];
  }

  function transformGlyph(glyph, xf) {
    return {
      subCurves: glyph.subCurves.map((sc) => ({
        bez: sc.bez.map((s) => bezToWorld(xf, s)),
        isClosed: sc.isClosed,
      })),
      fill: glyph.fill,
      fillXf: glyph.fillXf,
      stroke: glyph.stroke,
    };
  }

  function containerGlyphs(node, index, depth) {
    if (depth === undefined) depth = 0;
    if (depth > 12) return [];
    const glyphs = [];
    const parentXf = node.transformInterface ? node.transformInterface.transform : null;
    let child = node.firstChild;
    while (child) {
      let childGlyphs = [];
      if (hasCurveData(child)) childGlyphs = curveGlyphs(child, index);
      else if (hasChildNodes(child)) childGlyphs = containerGlyphs(child, index, depth + 1);
      if (parentXf && childGlyphs.length) childGlyphs = childGlyphs.map((g) => transformGlyph(g, parentXf));
      glyphs.push(...childGlyphs);
      child = child.nextSibling;
    }
    return glyphs;
  }

  function targetGlyphs(node, index) {
    if (hasCurveData(node)) return curveGlyphs(node, index);
    if (hasChildNodes(node)) {
      const glyphs = containerGlyphs(node, index);
      if (glyphs.length) return glyphs;
      throw Error("Selected target " + (index + 1) + " contains no editable curve objects.");
    }
    throw Error("Selected target " + (index + 1) + " is not a curve or curve container.");
  }

  const vectorItemCache = [];
  const glyphCache = [];
  let pathCacheNode = null;
  let pathCacheBeziers = null;

  function cachedVectorItem(node, index) {
    const k = nodeIndex(node);
    if (k >= 0 && vectorItemCache[k]) return vectorItemCache[k];
    const item = vectorItem(node, index);
    if (k >= 0) vectorItemCache[k] = item;
    return item;
  }

  function cachedTargetGlyphs(node, index) {
    const k = nodeIndex(node);
    if (k >= 0 && glyphCache[k]) return glyphCache[k];
    const glyphs = targetGlyphs(node, index);
    if (k >= 0) glyphCache[k] = glyphs;
    return glyphs;
  }

  function cachedPathBeziers(node) {
    if (!node) return null;
    if (pathCacheNode === node && pathCacheBeziers) return pathCacheBeziers;
    pathCacheNode = node;
    pathCacheBeziers = getWorldBeziers(node);
    return pathCacheBeziers;
  }

  function getSetup(useLastAsPath) {
    if (useLastAsPath && allNodes.length < 3) {
      throw friendlyError("Path mode needs at least 2 blend shapes plus 1 path. Turn off path mode or select one more path object.");
    }

    const onPath = !!useLastAsPath;
    const pathNode = onPath ? allNodes[allNodes.length - 1] : null;
    if (onPath && !hasCurveData(pathNode)) {
      throw friendlyError("Last selected object must be an editable curve path. Turn off path mode or select the path last.");
    }

    const targetNodes = onPath ? allNodes.slice(0, allNodes.length - 1) : allNodes.slice();
    if (targetNodes.length < 2) throw friendlyError("Select at least 2 blend target shapes.");

    const allTargetsBlendable = targetNodes.every((n) => isBlendTargetNode(n));
    if (!allTargetsBlendable) {
      throw Error("Each blend target must be a curve object or contain editable curves.");
    }
    const allSingleCurveTargets = targetNodes.every((n) => hasCurveData(n) && polyCurveCount(n.polyCurve) === 1);

    return {
      onPath,
      pathNode,
      targetNodes,
      type: allSingleCurveTargets ? "vector" : "glyph",
    };
  }

  function labelFor(setup, targets) {
    const first = nodeName(targets[0], "Shape 1");
    const last = nodeName(targets[targets.length - 1], "Shape " + targets.length);
    return (setup.onPath ? "Blend on Path: " : "Blend: ") + first + " → " + last;
  }

  function addEndpoint(defs, item, label, pathPoint) {
    const bez = pathPoint ? translateBez(item.bez, bezCentroid(item.bez), pathPoint) : item.bez;
    defs.push(
      makeDef(
        bez,
        buildFill(item.fill, item.fill, item.fillXf, item.fillXf, 0, false),
        item.stroke,
        label,
        item.isClosed,
      ),
    );
  }

  function addInterpolated(defs, a, b, pair, t, label, shouldClose, pathPoint, doFill, doStroke) {
    const interp = pair.sA.map((segA, i) => {
      const segB = pair.sB[i];
      return {
        start: lerpPt(segA.start, segB.start, t),
        c1: lerpPt(segA.c1, segB.c1, t),
        c2: lerpPt(segA.c2, segB.c2, t),
        end: lerpPt(segA.end, segB.end, t),
      };
    });
    const bez = pathPoint ? translateBez(interp, bezCentroid(interp), pathPoint) : interp;
    defs.push(
      makeDef(
        bez,
        buildFill(a.fill, b.fill, a.fillXf, b.fillXf, t, doFill),
        lerpStroke(a.stroke, b.stroke, t, doStroke),
        label,
        shouldClose,
      ),
    );
  }

  function buildMultiVectorDefs(items, steps, doFill, doStroke) {
    const defs = [];
    let stepNo = 1;
    for (let i = 0; i < items.length - 1; i++) {
      const a = items[i], b = items[i + 1];
      const shouldClose = a.isClosed && b.isClosed;
      const pair = prepareBlendSegments(a.bez, b.bez, shouldClose);
      if (i === 0) addEndpoint(defs, a, "Sh 1", null);
      for (let s = 1; s <= steps; s++) {
        const t = s / (steps + 1);
        addInterpolated(defs, a, b, pair, t, "Step " + stepNo++, shouldClose, null, doFill, doStroke);
      }
      addEndpoint(defs, b, "Sh " + (i + 2), null);
    }
    return defs;
  }

  function buildMultiPathVectorDefs(items, pathBeziers, steps, doFill, doStroke) {
    if (!pathBeziers.length) throw Error("Blend path has no editable curve segments.");
    const tbl = buildArcTable(pathBeziers);
    const defs = [];
    let stepNo = 1;
    const segmentCount = items.length - 1;
    for (let i = 0; i < segmentCount; i++) {
      const a = items[i], b = items[i + 1];
      const shouldClose = a.isClosed && b.isClosed;
      const pair = prepareBlendSegments(a.bez, b.bez, shouldClose);
      const startFrac = i / segmentCount;
      const endFrac = (i + 1) / segmentCount;

      if (i === 0) {
        addEndpoint(defs, a, "Sh 1", samplePath(tbl, pathBeziers, startFrac));
      }
      for (let s = 1; s <= steps; s++) {
        const t = s / (steps + 1);
        const frac = startFrac + (endFrac - startFrac) * t;
        addInterpolated(
          defs,
          a,
          b,
          pair,
          t,
          "Step " + stepNo++,
          shouldClose,
          samplePath(tbl, pathBeziers, frac),
          doFill,
          doStroke,
        );
      }
      addEndpoint(defs, b, "Sh " + (i + 2), samplePath(tbl, pathBeziers, endFrac));
    }
    return defs;
  }

  function execMultiGlyphBlend(doc, glyphLists, steps, doFill, doStroke, label, pathBeziers) {
    const onPath = !!pathBeziers;
    if (onPath && !pathBeziers.length) throw Error("Blend path has no editable curve segments.");
    const tbl = onPath ? buildArcTable(pathBeziers) : null;
    let commandCount = 0;

    const cb = AddChildNodesCommandBuilder.create();
    cb.addContainerNode(ContainerNodeDefinition.create(label));
    const ccmd = cb.createCommand(false, NodeChildType.Main);
    exec(doc, ccmd);
    commandCount++;
    const main = ccmd.newNodes[0];

    function addGlyphStep(name, glyphsA, glyphsB, t, dx, dy) {
      const count = Math.max(glyphsA.length, glyphsB.length);
      const paddedA = padGlyphs(glyphsA, count);
      const paddedB = padGlyphs(glyphsB, count);

      const scb = AddChildNodesCommandBuilder.create();
      scb.setInsertionTarget(main);
      scb.addContainerNode(ContainerNodeDefinition.create(name));
      const scmd = scb.createCommand(false, NodeChildType.Main);
      exec(doc, scmd);
      commandCount++;
      const stepC = scmd.newNodes[0];

      const gcb = AddChildNodesCommandBuilder.create();
      gcb.setInsertionTarget(stepC);
      for (let g = 0; g < count; g++) {
        const sA = onPath ? shiftGlyph(paddedA[g], dx, dy) : paddedA[g];
        const sB = onPath ? shiftGlyph(paddedB[g], dx, dy) : paddedB[g];
        gcb.addNode(buildGlyphDef(sA, sB, t, doFill, doStroke, "Glyph " + (g + 1)));
      }
      exec(doc, gcb.createCommand(false, NodeChildType.Main));
      commandCount++;
    }

    let stepNo = 1;
    const segmentCount = glyphLists.length - 1;
    for (let i = 0; i < segmentCount; i++) {
      const glyphsA = glyphLists[i];
      const glyphsB = glyphLists[i + 1];
      if (!glyphsA.length || !glyphsB.length) throw Error("One blend target has no editable curve objects.");
      const centA = onPath ? glyphsListCentroid(glyphsA) : null;
      const centB = onPath ? glyphsListCentroid(glyphsB) : null;
      const startFrac = i / segmentCount;
      const endFrac = (i + 1) / segmentCount;

      if (i === 0) {
        if (onPath) {
          const ptS = samplePath(tbl, pathBeziers, startFrac);
          addGlyphStep("Sh 1", glyphsA, glyphsA, 0, ptS.x - centA.x, ptS.y - centA.y);
        } else {
          addGlyphStep("Sh 1", glyphsA, glyphsA, 0, 0, 0);
        }
      }

      for (let s = 1; s <= steps; s++) {
        const t = s / (steps + 1);
        if (onPath) {
          const frac = startFrac + (endFrac - startFrac) * t;
          const pathPt = samplePath(tbl, pathBeziers, frac);
          const interpC = lerpPt(centA, centB, t);
          addGlyphStep("Step " + stepNo++, glyphsA, glyphsB, t, pathPt.x - interpC.x, pathPt.y - interpC.y);
        } else {
          addGlyphStep("Step " + stepNo++, glyphsA, glyphsB, t, 0, 0);
        }
      }

      if (onPath) {
        const ptE = samplePath(tbl, pathBeziers, endFrac);
        addGlyphStep("Sh " + (i + 2), glyphsB, glyphsB, 0, ptE.x - centB.x, ptE.y - centB.y);
      } else {
        addGlyphStep("Sh " + (i + 2), glyphsB, glyphsB, 0, 0, 0);
      }
    }
    return commandCount;
  }

  function doApply(steps, doFill, doStroke, reverse, useLastAsPath) {
    const setup = getSetup(useLastAsPath);
    const targets = setup.targetNodes.slice();
    if (reverse) targets.reverse();
    const label = labelFor(setup, targets);

    if (setup.type === "glyph") {
      const glyphLists = targets.map((node, index) => cachedTargetGlyphs(node, index));
      const pathBeziers = setup.onPath ? cachedPathBeziers(setup.pathNode) : null;
      return execMultiGlyphBlend(doc, glyphLists, steps, doFill, doStroke, label, pathBeziers);
    }

    const items = targets.map((node, index) => cachedVectorItem(node, index));
    const defs = setup.onPath
      ? buildMultiPathVectorDefs(items, cachedPathBeziers(setup.pathNode), steps, doFill, doStroke)
      : buildMultiVectorDefs(items, steps, doFill, doStroke);
    return execVectorBlend(doc, defs, label);
  }

  function cleanupSources(useLastAsPath, label) {
    const setup = getSetup(useLastAsPath);
    for (const node of setup.targetNodes) deleteNode(doc, node);
    if (setup.onPath) {
      exec(
        doc,
        DocumentCommand.createSetDescription(
          setup.pathNode.selfSelection,
          "Path Spine: " + label,
        ),
      );
      exec(
        doc,
        DocumentCommand.createSetVisibility(setup.pathNode.selfSelection, false),
      );
    }
  }

  function currentLabel(reverse, useLastAsPath) {
    const setup = getSetup(useLastAsPath);
    const targets = setup.targetNodes.slice();
    if (reverse) targets.reverse();
    return labelFor(setup, targets);
  }

  // ── Build dialog ──────────────────────────────────────
  const dlg = Dialog.create("Blend Tool");
  dlg.initialWidth = 360;
  dlg.initialHeight = 560;
  const col = dlg.addColumn();

  const selGrp = col.addGroup("Selection");
  selGrp.addStaticText("Selected", selLen + " object" + (selLen === 1 ? "" : "s"));
  selGrp.addStaticText("First", nodeName(allNodes[0], "Shape 1"));
  selGrp.addStaticText("Last", nodeName(allNodes[allNodes.length - 1], "Shape " + allNodes.length));

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
  const reverseCtrl = orientGrp.addSwitch("Reverse target order", false);
  const pathCtrl = orientGrp.addSwitch("Last selected path as blend path", false);

  const colGrp = col.addGroup("Colour");
  const fillCtrl = colGrp.addSwitch("Interpolate fill colour", true);
  const strokeCtrl = colGrp.addSwitch("Interpolate stroke", true);

  const actGrp = col.addGroup("Actions");
  actGrp.enableSeparator = true;
  const statusCtrl = actGrp.addStaticText("", "");
  statusCtrl.text = "Preview is temporary. Apply commits the blend.";
  statusCtrl.isFullWidth = true;
  statusCtrl.textHorizontalAlignment = HorizontalAlignment.Left;
  const btns = actGrp.addButtonSet("", ["Preview", "Apply"], 0);
  btns.isFullWidth = true;

  // ── Initial preview ───────────────────────────────────
  let cmdCount = 0,
    previewActive = false,
    blendLabel = "";
  try {
    blendLabel = currentLabel(false, pathCtrl.value);
    cmdCount = doApply(clampSteps(stepsCtrl.value), fillCtrl.value, strokeCtrl.value, false, pathCtrl.value);
    previewActive = true;
    statusCtrl.text = "• Preview: " + clampSteps(stepsCtrl.value) + " steps" + (pathCtrl.value ? " on path" : "") + " - Preview active";
  } catch (e) {
    statusCtrl.text = "Preview failed: " + selectionDebugText(e);
    console.log("Blend initial error:", e.stack);
  }

  // ── Dialog loop ───────────────────────────────────────
  // ButtonSet index: 0 = Preview, 1 = Apply. Native OK uses Preview by default.
  let running = true;
  while (running) {
    btns.selectedIndex = 0;
    const result = dlg.runModal();
    const steps = clampSteps(stepsCtrl.value);
    const doFill = fillCtrl.value,
      doStroke = strokeCtrl.value,
      reverse = reverseCtrl.value,
      useLastAsPath = pathCtrl.value;
    const mode = btns.selectedIndex;

    if (result.value !== DialogResult.Ok.value) {
      if (previewActive) {
        undoN(doc, cmdCount);
        previewActive = false;
      }
      running = false;
    } else if (mode === 1) {
      if (previewActive) {
        undoN(doc, cmdCount);
        previewActive = false;
      }
      try {
        blendLabel = currentLabel(reverse, useLastAsPath);
        cmdCount = doApply(steps, doFill, doStroke, reverse, useLastAsPath);
        previewActive = true;
        cleanupSources(useLastAsPath, blendLabel);
      } catch (e) {
        showError("Blend failed: " + selectionDebugText(e));
        console.log("Blend error:", e.stack);
      }
      running = false;
    } else {
      if (previewActive) {
        undoN(doc, cmdCount);
        previewActive = false;
        cmdCount = 0;
      }
      try {
        blendLabel = currentLabel(reverse, useLastAsPath);
        cmdCount = doApply(steps, doFill, doStroke, reverse, useLastAsPath);
        previewActive = true;
        statusCtrl.text =
          "• Preview: " +
          steps +
          " step" +
          (steps === 1 ? "" : "s") +
          (useLastAsPath ? " on path" : "") +
          (reverse ? " · reversed" : "") +
          " - Preview active";
      } catch (e) {
        statusCtrl.text = "Preview failed: " + selectionDebugText(e);
        console.log("Blend preview error:", e.stack);
      }
    }
  }
}