'use strict';

/**
 * name: add_anchor_points_1.0
 * description: Add Anchor Points — inserts N evenly-spaced anchor points into
 *              every segment of the selected curve(s), exactly like Illustrator's
 *              Object > Path > Add Anchor Points. Uses a De Casteljau split so the
 *              path shape is preserved exactly (curves are NOT flattened). Fills a
 *              gap in Affinity, which only lets you add nodes one click at a time.
 * version: 1.0.0
 * author: olliollio - analog digitalagentur
 */

const { app } = require('/application');
const { Document } = require('/document');
const { CurveBuilder, PolyCurve } = require('/geometry');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
const { Dialog, DialogResult } = require('/dialog');

const VERSION = 'v1.0';
const TITLE = 'Add Anchor Points';

// ---------------------------------------------------------------------
// Geometry — De Casteljau subdivision of a single cubic bezier segment.
// ---------------------------------------------------------------------

function lerp(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

// Split one segment {start, c1, c2, end} at parameter t into [left, right].
// A straight segment (handles collapsed onto its anchors) splits into two
// straight halves, so lines stay lines and curves keep their exact shape.
function split(s, t) {
  const a = lerp(s.start, s.c1, t);
  const b = lerp(s.c1, s.c2, t);
  const c = lerp(s.c2, s.end, t);
  const d = lerp(a, b, t);
  const e = lerp(b, c, t);
  const m = lerp(d, e, t); // the new on-curve anchor
  return [
    { start: s.start, c1: a, c2: d, end: m },
    { start: m, c1: e, c2: c, end: s.end },
  ];
}

// Point on the cubic at parameter t.
function bezAt(s, t) {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * s.start.x + b * s.c1.x + c * s.c2.x + d * s.end.x,
    y: a * s.start.y + b * s.c1.y + c * s.c2.y + d * s.end.y,
  };
}

// Global parameters at equal ARC-LENGTH fractions along the segment. We must
// distribute by arc length, not by curve parameter: Affinity stores a straight
// segment as a cubic with handles collapsed onto its anchors, whose
// parametrisation is NOT constant-speed — so equal-parameter cuts bunch toward
// the ends (t=0.5 is the only exception, which is why a single point looked
// correct). Sampling arc length fixes this for lines and curves alike.
function equalArcParams(seg, count) {
  const N = 256; // arc-length samples
  const cum = [0];
  let prev = bezAt(seg, 0);
  let acc = 0;
  for (let i = 1; i <= N; i++) {
    const p = bezAt(seg, i / N);
    acc += Math.hypot(p.x - prev.x, p.y - prev.y);
    cum.push(acc);
    prev = p;
  }
  const total = acc;
  const params = [];
  if (total < 1e-9) {
    // Degenerate (zero-length) segment: fall back to even parameter spacing.
    for (let k = 1; k < count; k++) params.push(k / count);
    return params;
  }
  let lo = 0;
  for (let k = 1; k < count; k++) {
    const target = (total * k) / count;
    while (lo < N && cum[lo + 1] < target) lo++;
    const a = cum[lo];
    const b = cum[lo + 1];
    const frac = b > a ? (target - a) / (b - a) : 0;
    params.push((lo + frac) / N);
  }
  return params;
}

// Subdivide one segment so `count - 1` interior anchors land at equal
// arc-length spacing. Each cut is remapped into the LOCAL parameter of the
// shrinking right-hand remainder, so the geometry (via exact De Casteljau
// splits) is preserved regardless of where the anchors fall.
function subdivide(seg, count) {
  if (count <= 1) return [seg];
  const globals = equalArcParams(seg, count);
  const out = [];
  let cur = seg;
  let prevGlobal = 0;
  for (const g of globals) {
    const localT = (g - prevGlobal) / (1 - prevGlobal);
    const parts = split(cur, localT);
    out.push(parts[0]);
    cur = parts[1];
    prevGlobal = g;
  }
  out.push(cur);
  return out;
}

function buildCurve(segs, isClosed) {
  const cb = CurveBuilder.create();
  cb.begin(segs[0].start);
  for (const s of segs) cb.addBezier(s.c1, s.c2, s.end);
  if (isClosed) cb.close();
  return cb.createCurve();
}

// ---------------------------------------------------------------------
// Per-node planning (pure computation — does not touch the document).
// ---------------------------------------------------------------------

// Returns { ci, newPolyCurve, added } for one node, or null if it has no
// editable curve geometry.
function planNode(node, count) {
  const ci = node.curvesInterface;
  if (!ci) return null;

  const pc = ci.polyCurve;
  const newPolyCurve = PolyCurve.create();
  let added = 0;

  for (let c = 0; c < pc.curveCount; c++) {
    const curve = pc.at(c);
    const segs = [];
    for (const bz of curve.beziers) {
      const pieces = subdivide(
        { start: bz.start, c1: bz.c1, c2: bz.c2, end: bz.end },
        count,
      );
      for (const p of pieces) segs.push(p);
      added += count - 1;
    }
    if (segs.length === 0) continue;
    newPolyCurve.addCurve(buildCurve(segs, curve.isClosed));
  }

  if (added === 0) return null;
  return { ci, newPolyCurve, added };
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

function main() {
  const doc = Document.current;
  if (!doc) {
    app.alert('No active document.', TITLE);
    return;
  }

  // Only editable curve shapes. A live shape (unconverted rectangle etc.) is
  // parametric — adding anchors to it isn't meaningful, so require curves,
  // exactly as Illustrator does (Convert to Curves first).
  const nodes = doc.selection.nodes.filter((n) => n.isPolyCurveNode);
  if (nodes.isEmpty) {
    app.alert(
      'Please select one or more vector (curve) shapes first.\n' +
        '(For a live shape, run Convert to Curves first.)',
      TITLE,
    );
    return;
  }

  // -- Dialog: how many anchors to add per segment. -----------------------
  const dlg = Dialog.create(TITLE + ' ' + VERSION);
  dlg.initialWidth = 320;
  const col = dlg.addColumn();
  const grp = col.addGroup('Anchor points to add per segment');
  const combo = grp.addComboBox('Per segment', ['1', '2', '3', '4', '5'], 0);

  if (dlg.runModal() !== DialogResult.Ok) return;

  const perSegment = combo.selectedIndex + 1; // 1..5
  const count = perSegment + 1; // resulting pieces per original segment

  // Plan every selected shape before mutating the document.
  const plans = [];
  let totalAdded = 0;
  for (const node of nodes) {
    const plan = planNode(node, count);
    if (plan) {
      plans.push(plan);
      totalAdded += plan.added;
    }
  }

  if (plans.length === 0) {
    app.alert('The selected shape(s) have no segments to add anchors to.', TITLE);
    return;
  }

  const cmds = plans.map((p) =>
    DocumentCommand.createSetCurves(p.ci, p.newPolyCurve),
  );
  if (cmds.length === 1) {
    doc.executeCommand(cmds[0]);
  } else {
    const builder = CompoundCommandBuilder.create();
    for (const cmd of cmds) builder.addCommand(cmd);
    doc.executeCommand(builder.createCommand());
  }

  const shapeWord = plans.length === 1 ? 'shape' : 'shapes';
  app.alert(
    `Added ${totalAdded} anchor point${totalAdded === 1 ? '' : 's'} ` +
      `across ${plans.length} ${shapeWord}.`,
    TITLE,
  );
}

main();
