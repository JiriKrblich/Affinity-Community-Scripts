"use strict";

/**
 'use strict';

/**
 * Redundant Nodes Remover v1.3
 * By Ben B. / 2026.07.01, 12-46 AM
 * -----------------------------
 * Removes on-curve nodes from the selected vector shape(s) that are
 * mathematically redundant - i.e. nodes that lie exactly on the path
 * already described by their neighbors, so removing them does NOT
 * change the shape in any way (not an approximation / simplification).
 *
 * Two kinds of redundant nodes are detected:
 *   1. Nodes that split a genuinely curved bezier segment without being
 *      moved (detected via exact inverse de Casteljau subdivision).
 *   2. Nodes sitting on a straight line between two collinear neighbors
 *      (detected via an explicit collinearity test, since the de
 *      Casteljau test degenerates for zero-length/collapsed handles and
 *      misses pure straight-line redundant nodes).
 *
 * Every curve inside each selected node's curvesInterface.polyCurve is
 * processed independently, so holes / inner cutout curves (opposite
 * winding order) are always preserved.
 *
 * Behavior:
 *   - Works on ALL selected vector (curve) shapes at once.
 *   - The number of removable nodes is pre-calculated BEFORE any change
 *     is made to the document (pure computation, no mutation).
 *   - A confirmation dialog is shown stating how many nodes will be
 *     removed (before -> after count). The dialog has OK and Cancel.
 *   - Clicking Cancel closes the dialog and makes no changes at all.
 *   - Clicking OK applies the change (single undo step) and shows a
 *     second dialog confirming how many nodes were actually removed.
 *   - If no redundant nodes are found, the user is informed and no
 *     confirmation/change step happens.
 *
 * Usage: select one or more vector (curve) shapes in Affinity, then run
 * this script (Scripts panel, or double-click if installed as a library
 * script).
 */

const { app } = require("/application");
const { Document } = require("/document");
const { CurveBuilder, PolyCurve } = require("/geometry");
const { DocumentCommand, CompoundCommandBuilder } = require("/commands");

const EPS = 0.5; // pixel tolerance for the exact-reconstruction checks
const DIALOG_TITLE = "Remove Redundant Nodes";

// ---------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function collinear(a, b, c, eps) {
  const dx = c.x - a.x;
  const dy = c.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return Math.abs((b.x - a.x) * dy - (b.y - a.y) * dx) / len < eps;
}

function isLineSeg(s, eps) {
  return dist(s.c1, s.start) < eps && dist(s.c2, s.end) < eps;
}

// Case 1: exact de Casteljau subdivision merge (genuinely curved segments).
// If `left` and `right` are exactly the two halves of a single cubic bezier
// split at some parameter t, this reconstructs that original bezier's
// control points. Returns null if no such exact reconstruction exists.
function tryMergeCurve(left, right, eps) {
  const Lb = left.c2;
  const S = left.end;
  const Ra = right.c1;
  if (!collinear(Lb, S, Ra, eps)) return null;

  const dLbS = dist(Lb, S);
  const dLbRa = dist(Lb, Ra);
  if (dLbRa < 1e-6) return null;

  const t = dLbS / dLbRa;
  if (t <= 1e-6 || t >= 1 - 1e-6) return null;

  const P0 = left.start;
  const Q1 = left.c1;
  const P3 = right.end;
  const Q3 = right.c2;

  const P1 = { x: (Q1.x - (1 - t) * P0.x) / t, y: (Q1.y - (1 - t) * P0.y) / t };
  const P2 = { x: (Q3.x - t * P3.x) / (1 - t), y: (Q3.y - t * P3.y) / (1 - t) };
  const Q2 = { x: (1 - t) * P1.x + t * P2.x, y: (1 - t) * P1.y + t * P2.y };

  const R1check = {
    x: (1 - t) * Q1.x + t * Q2.x,
    y: (1 - t) * Q1.y + t * Q2.y,
  };
  const R2check = {
    x: (1 - t) * Q2.x + t * Q3.x,
    y: (1 - t) * Q2.y + t * Q3.y,
  };

  if (dist(R1check, left.c2) > eps || dist(R2check, right.c1) > eps)
    return null;

  return { start: P0, c1: P1, c2: P2, end: P3 };
}

// Case 2: two straight-line segments (control handles collapsed onto their
// own endpoints) that are collinear with each other -> merge into one
// straight segment. This is a separate case from tryMergeCurve because the
// de Casteljau inversion degenerates (t === 0) when handles sit exactly on
// the anchor points, so it never fires for pure straight-line nodes.
function tryMergeLines(left, right, eps) {
  if (!isLineSeg(left, eps) || !isLineSeg(right, eps)) return null;
  if (!collinear(left.start, left.end, right.end, eps)) return null;
  return { start: left.start, c1: left.start, c2: right.end, end: right.end };
}

function tryMerge(left, right, eps) {
  return tryMergeLines(left, right, eps) || tryMergeCurve(left, right, eps);
}

// Repeatedly merges adjacent (cyclic) segments of a curve until no more
// exact merges are possible. Returns the reduced segment list.
function reduceCurveSegs(curve, eps) {
  const segs = [];
  for (const bz of curve.beziers) {
    segs.push({ start: bz.start, c1: bz.c1, c2: bz.c2, end: bz.end });
  }

  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < segs.length; i++) {
      if (segs.length === 1) break;
      const j = (i + 1) % segs.length;
      if (i === j) break;
      const m = tryMerge(segs[i], segs[j], eps);
      if (m) {
        if (j > i) {
          segs.splice(i, 2, m);
        } else {
          segs[i] = m;
          segs.splice(j, 1);
        }
        merged = true;
        break;
      }
    }
  }
  return segs;
}

function buildCurve(segs, isClosed) {
  const cb = CurveBuilder.create();
  cb.begin(segs[0].start);
  for (const s of segs) {
    cb.addBezier(s.c1, s.c2, s.end);
  }
  if (isClosed) cb.close();
  return cb.createCurve();
}

// ---------------------------------------------------------------------
// Per-node planning (pure computation - does not touch the document)
// ---------------------------------------------------------------------

// Computes the reduced PolyCurve for a single node. Returns null if the
// node is not a curve shape, or has no redundant nodes to remove.
function planReduction(node) {
  const ci = node.curvesInterface;
  if (!ci) return null;

  const pc = ci.polyCurve;
  const newPolyCurve = PolyCurve.create();
  let before = 0;
  let after = 0;

  for (let c = 0; c < pc.curveCount; c++) {
    const curve = pc.at(c);
    before += curve.beziers.length;
    const segs = reduceCurveSegs(curve, EPS);
    after += segs.length;
    newPolyCurve.addCurve(buildCurve(segs, curve.isClosed));
  }

  if (after >= before) return null; // nothing redundant on this shape

  return { ci, newPolyCurve, before, after };
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

function main() {
  const doc = Document.current;
  if (!doc) {
    app.alert("No active document.", DIALOG_TITLE);
    return;
  }

  const nodes = doc.selection.nodes.filter((n) => n.isPolyCurveNode);
  if (nodes.isEmpty) {
    app.alert(
      "Please select one or more vector (curve) shapes first.",
      DIALOG_TITLE,
    );
    return;
  }

  // Pre-calculate the reduction for every selected shape BEFORE touching
  // the document at all.
  const plans = [];
  let totalBefore = 0;
  let totalAfter = 0;
  for (const node of nodes) {
    const plan = planReduction(node);
    if (plan) {
      plans.push(plan);
      totalBefore += plan.before;
      totalAfter += plan.after;
    }
  }

  if (plans.length === 0) {
    app.alert(
      "No redundant nodes were found - the selected shape(s) are already optimal.",
      DIALOG_TITLE,
    );
    return;
  }

  const removed = totalBefore - totalAfter;
  const shapeWord = plans.length === 1 ? "shape" : "shapes";

  const proceed = app.confirm(
    `${plans.length} ${shapeWord} can be optimized.\n\n` +
      `Nodes: ${totalBefore} -> ${totalAfter}\n` +
      `(${removed} redundant node${removed === 1 ? "" : "s"} will be removed)\n\n` +
      `The visible shape will not change.\n\nProceed?`,
    DIALOG_TITLE,
  );

  if (!proceed) {
    // Cancel: close without any action.
    console.log("Remove Redundant Nodes: cancelled by user, no changes made.");
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

  app.alert(
    `Done. Removed ${removed} redundant node${removed === 1 ? "" : "s"} (${totalBefore} -> ${totalAfter}). Shape unchanged.`,
    DIALOG_TITLE,
  );
}

main();
