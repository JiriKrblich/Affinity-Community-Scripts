"use strict";

// =============================================================================
// PATH SIMPLIFY PRO v1a (Advanced Vector Simplification Engine)
// Serif Affinity Designer / Photo / Publisher (v3g Multi-Effect Standard & In-Place)
//
// Key Features in v1a:
// 1. Full Hierarchical Group Support & Multi-Object Live Preview:
//    - Deep recursive traversal of GroupNode, LayerNode, and nested container structures.
//    - Preserves child transforms so EVERY path inside groups renders at its exact position in live preview.
//    - Applies simplification individually to every vector path inside selected groups.
//    - Preserves exact group hierarchies, stacking orders, and parent group selection.
// 2. High-Precision Mathematical Pipeline:
//    - Uniform polyline decomposition & recursive Bézier subdivision (ConvertEvenLines).
//    - Exponential + binary search with step halving (step = 64, 32, 16, 8, 4, 2, 1).
//    - Least-squares cubic Bézier fitting (FitCubic) using Bernstein polynomial basis.
//    - Newton-Raphson parameter refinement (RaffineTk) for sub-pixel curvature matching.
//    - Splotch-Killer algorithm to prevent loops and bulges on small segments.
// 3. Intelligent Corner Preservation:
//    - Detects sharp turns (configurable corner angle, e.g. 60°) and anchors them.
//    - Sharp corners remain 100% crisp while smooth curves are aggressively simplified.
// 4. Node Count Guard:
//    - Never increases the node count: if a curve already has minimal nodes, it is preserved.
// 5. Dual Workflow Support:
//    - In-Place Replacement (Default): Direct, instant replacement on canvas with single-step Undo (Cmd+Z).
//    - Non-Destructive Container (v3g Standard): Wraps in "Simplify Effect" container with
//      hidden Source and red-tagged Result (#FF0000), fully compatible with Expand Effects.
// 6. Interactive Dialog with Real-Time Live Preview:
//    - Pop-up slider for Threshold (1 to 500, default 20 = 0.0020).
//    - Live node count statistics across all paths in groups: "Nodes: 1600 ➔ 42 (-97.4%)".
//    - Canvas units tolerance feedback: "Tolerance: ±2.4 px".
// =============================================================================

const { Document } = require("/document");
const {
  DocumentCommand,
  AddChildNodesCommandBuilder,
  CompoundCommandBuilder,
  InsertionMode,
  NodeChildType,
  NodeMoveType
} = require("/commands");
const {
  PolyCurve,
  Curve,
  CurveBuilder,
  CubicBezier,
  Transform,
  Point
} = require("/geometry");
const {
  ContainerNodeDefinition,
  PolyCurveNodeDefinition
} = require("/nodes");
const { Dialog, DialogResult, HorizontalAlignment } = require("/dialog");
const { Selection } = require("/selections");
const { UnitType } = require("/units");
const { RGB8 } = require("/colours");
const { FillDescriptor, BlendMode } = require("/fills");
const { LineStyleDescriptor } = require("/linestyle");
const { setTimeout } = require("/timers");

// =============================================================================
// CONSTANTS & REGISTRY
// =============================================================================

const SCRIPT_TITLE = "Path Simplify Pro v1a";
const CURRENT_EFFECT_ID = "simplify";
const EFFECT_SIMPLIFY = "simplify";
const EFFECT_ZIGZAG = "zigzag";
const EFFECT_ROUGHEN = "roughen";
const EFFECT_PUCKER_BLOAT = "pucker_bloat";
const EFFECT_TWIST = "twist";

const KNOWN_GROUP_PREFIXES = [
  "Simplify Effect", "Zig Zag Effect", "Roughen Effect", "Pucker & Bloat", "Twist Effect",
  "Effects [", "Effect Container"
];
const SOURCE_PREFIX = "Source";
const RESULT_PREFIX = "Result";

const EffectRegistry = {
  [EFFECT_SIMPLIFY]: {
    id: EFFECT_SIMPLIFY,
    name: "Simplify Path",
    defaultParams: {
      threshold: 0.0020,
      keepCorners: true,
      cornerAngle: 60,
      isContainerMode: false
    },
    sanitizeParams: function(p) {
      const threshold = (p && typeof p.threshold === "number" && !isNaN(p.threshold))
        ? Math.max(0.0001, Math.min(0.1, p.threshold))
        : 0.0020;
      const keepCorners = (p && p.keepCorners !== undefined) ? !!p.keepCorners : true;
      const cornerAngle = (p && typeof p.cornerAngle === "number" && !isNaN(p.cornerAngle))
        ? Math.max(1, Math.min(179, Math.round(p.cornerAngle)))
        : 60;
      const isContainerMode = (p && p.isContainerMode !== undefined) ? !!p.isContainerMode : false;
      return { threshold, keepCorners, cornerAngle, isContainerMode };
    },
    evaluate: function(polyCurve, params) {
      const p = EffectRegistry[EFFECT_SIMPLIFY].sanitizeParams(params);
      return simplifyPolyCurve(polyCurve, p.threshold, p.keepCorners, p.cornerAngle);
    },
    formatSummary: function(params) {
      const p = EffectRegistry[EFFECT_SIMPLIFY].sanitizeParams(params);
      return `Simplify (${(p.threshold * 100).toFixed(2)}% tol${p.keepCorners ? `, ${p.cornerAngle}° corners` : ""})`;
    }
  },
  [EFFECT_ZIGZAG]: {
    id: EFFECT_ZIGZAG,
    name: "Zig Zag",
    defaultParams: { amp: 10, ridges: 8, smooth: false },
    sanitizeParams: p => ({
      amp: (p && typeof p.amp === "number") ? Math.max(0, p.amp) : 10,
      ridges: (p && typeof p.ridges === "number") ? Math.max(1, Math.round(p.ridges)) : 8,
      smooth: !!(p && p.smooth)
    }),
    evaluate: (pc, p) => pc.clone(),
    formatSummary: p => `Zig Zag (${p.amp || 10}px)`
  },
  [EFFECT_ROUGHEN]: {
    id: EFFECT_ROUGHEN,
    name: "Roughen",
    defaultParams: { size: 5, isRelative: true, detail: 10, smooth: false, seed: 42 },
    sanitizeParams: p => ({
      size: (p && typeof p.size === "number") ? Math.max(0, p.size) : 5,
      isRelative: (p && p.isRelative !== undefined) ? !!p.isRelative : true,
      detail: (p && typeof p.detail === "number") ? Math.max(1, Math.round(p.detail)) : 10,
      smooth: !!(p && p.smooth),
      seed: (p && typeof p.seed === "number") ? Math.round(p.seed) : 42
    }),
    evaluate: (pc, p) => pc.clone(),
    formatSummary: p => `Roughen (${p.size || 5}px)`
  },
  [EFFECT_PUCKER_BLOAT]: {
    id: EFFECT_PUCKER_BLOAT,
    name: "Pucker & Bloat",
    defaultParams: { amount: 50 },
    sanitizeParams: p => ({
      amount: (p && typeof p.amount === "number") ? Math.max(-200, Math.min(200, p.amount)) : 50
    }),
    evaluate: (pc, p) => pc.clone(),
    formatSummary: p => `Pucker & Bloat (${p.amount || 50}%)`
  },
  [EFFECT_TWIST]: {
    id: EFFECT_TWIST,
    name: "Twist",
    defaultParams: { angle: 45, subdiv: 40 },
    sanitizeParams: p => ({
      angle: (p && typeof p.angle === "number") ? Math.max(-3600, Math.min(3600, p.angle)) : 45,
      subdiv: (p && typeof p.subdiv === "number") ? Math.max(4, Math.round(p.subdiv)) : 40
    }),
    evaluate: (pc, p) => pc.clone(),
    formatSummary: p => `Twist (${p.angle || 45}°)`
  }
};

const doc = Document.current;

// =============================================================================
// COMPUTATIONAL GEOMETRY ENGINE (LEAST-SQUARES CUBIC FITTING)
// =============================================================================

// Bernstein polynomial cubic basis (N03..N33), quadratic (N02..N22), linear (N01..N11)
function N03(t) { return (1.0 - t) * (1.0 - t) * (1.0 - t); }
function N13(t) { return 3.0 * t * (1.0 - t) * (1.0 - t); }
function N23(t) { return 3.0 * t * t * (1.0 - t); }
function N33(t) { return t * t * t; }

function N02(t) { return (1.0 - t) * (1.0 - t); }
function N12(t) { return 2.0 * t * (1.0 - t); }
function N22(t) { return t * t; }

function N01(t) { return 1.0 - t; }
function N11(t) { return t; }

/**
 * RaffineTk: Newton-Raphson parameter refinement.
 * Refines the parameter t along the cubic Bézier curve to find the minimum distance to point pt.
 */
function refineTk(pt, p0, p1, p2, p3, it) {
  const Ax = pt.x - p0.x * N03(it) - p1.x * N13(it) - p2.x * N23(it) - p3.x * N33(it);
  const Bx = (p1.x - p0.x) * N02(it) + (p2.x - p1.x) * N12(it) + (p3.x - p2.x) * N22(it);
  const Cx = (p0.x - 2 * p1.x + p2.x) * N01(it) + (p3.x - 2 * p2.x + p1.x) * N11(it);

  const Ay = pt.y - p0.y * N03(it) - p1.y * N13(it) - p2.y * N23(it) - p3.y * N33(it);
  const By = (p1.y - p0.y) * N02(it) + (p2.y - p1.y) * N12(it) + (p3.y - p2.y) * N22(it);
  const Cy = (p0.y - 2 * p1.y + p2.y) * N01(it) + (p3.y - 2 * p2.y + p1.y) * N11(it);

  const dF = -6.0 * (Ax * Bx + Ay * By);
  const ddF = 18.0 * (Bx * Bx + By * By) - 12.0 * (Ax * Cx + Ay * Cy);

  if (Math.abs(ddF) > 1e-7) {
    return it - dF / ddF;
  }
  return it;
}

/**
 * FitCubic: solves 2x2 normal equations for least-squares cubic fitting.
 */
function fitCubic(pts, tk, startIdx, count) {
  const p0 = pts[startIdx];
  const p3 = pts[startIdx + count - 1];

  let M00 = 0, M01 = 0, M11 = 0;
  for (let i = 1; i < count - 1; i++) {
    const t = tk[i];
    const n1 = N13(t);
    const n2 = N23(t);
    M00 += n1 * n1;
    M01 += n1 * n2;
    M11 += n2 * n2;
  }
  const M10 = M01;

  const det = M00 * M11 - M01 * M10;
  if (Math.abs(det) < 1e-9) {
    return {
      c1: { x: p0.x + (p3.x - p0.x) / 3, y: p0.y + (p3.y - p0.y) / 3 },
      c2: { x: p0.x + 2 * (p3.x - p0.x) / 3, y: p0.y + 2 * (p3.y - p0.y) / 3 },
      ok: false
    };
  }

  const iM00 = M11 / det;
  const iM01 = -M01 / det;
  const iM10 = -M10 / det;
  const iM11 = M00 / det;

  let Qx0 = 0, Qx1 = 0;
  let Qy0 = 0, Qy1 = 0;

  for (let i = 1; i < count - 1; i++) {
    const t = tk[i];
    const pt = pts[startIdx + i];
    const qx = pt.x - N03(t) * p0.x - N33(t) * p3.x;
    const qy = pt.y - N03(t) * p0.y - N33(t) * p3.y;
    const n1 = N13(t);
    const n2 = N23(t);
    Qx0 += n1 * qx;
    Qx1 += n2 * qx;
    Qy0 += n1 * qy;
    Qy1 += n2 * qy;
  }

  const c1x = iM00 * Qx0 + iM01 * Qx1;
  const c2x = iM10 * Qx0 + iM11 * Qx1;
  const c1y = iM00 * Qy0 + iM01 * Qy1;
  const c2y = iM10 * Qy0 + iM11 * Qy1;

  return {
    c1: { x: c1x, y: c1y },
    c2: { x: c2x, y: c2y },
    ok: true
  };
}

/**
 * Computes chord-length parameterization for points in range.
 */
function computeChordParameters(pts, startIdx, count) {
  const tk = new Float64Array(count);
  const lk = new Float64Array(count);
  tk[0] = 0;
  lk[0] = 0;
  let totalLen = 0;

  for (let i = 1; i < count; i++) {
    const prev = pts[startIdx + i - 1];
    const cur = pts[startIdx + i];
    const len = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    lk[i] = len;
    totalLen += len;
    tk[i] = totalLen;
  }

  if (totalLen > 1e-9) {
    for (let i = 1; i < count; i++) {
      tk[i] /= totalLen;
    }
  } else {
    for (let i = 1; i < count; i++) {
      tk[i] = i / (count - 1);
    }
  }
  tk[count - 1] = 1.0;

  return { tk, lk, totalLen };
}

/**
 * AttemptSimplify: tests if a cubic fits the sequence within threshold,
 * applies the Splotch Killer, and refines parameters using Newton-Raphson.
 */
function attemptSimplify(pts, startIdx, count, threshold) {
  if (count <= 2) {
    const p0 = pts[startIdx];
    const p3 = pts[startIdx + 1];
    return {
      ok: true,
      c1: { x: p0.x + (p3.x - p0.x) / 3, y: p0.y + (p3.y - p0.y) / 3 },
      c2: { x: p0.x + 2 * (p3.x - p0.x) / 3, y: p0.y + 2 * (p3.y - p0.y) / 3 },
      worstDist: 0
    };
  }

  const { tk, lk, totalLen } = computeChordParameters(pts, startIdx, count);
  let fit = fitCubic(pts, tk, startIdx, count);
  if (!fit.ok) return { ok: false, c1: fit.c1, c2: fit.c2, worstDist: 1e9 };

  const p0 = pts[startIdx];
  const p3 = pts[startIdx + count - 1];
  let c1 = fit.c1;
  let c2 = fit.c2;

  const threshSq = threshold * threshold;

  // Pass 1: Quick deviation check
  let maxSqDist = 0;
  for (let i = 1; i < count - 1; i++) {
    const t = tk[i];
    const curPt = pts[startIdx + i];
    const px = N03(t) * p0.x + N13(t) * c1.x + N23(t) * c2.x + N33(t) * p3.x;
    const py = N03(t) * p0.y + N13(t) * c1.y + N23(t) * c2.y + N33(t) * p3.y;
    const dSq = (px - curPt.x) ** 2 + (py - curPt.y) ** 2;
    if (dSq > maxSqDist) maxSqDist = dSq;
  }

  if (maxSqDist > 3.0 * threshSq) {
    return { ok: false, c1, c2, worstDist: maxSqDist };
  }

  // Pass 2: Parameter refinement with Newton-Raphson (RaffineTk)
  for (let i = 1; i < count - 1; i++) {
    const curPt = pts[startIdx + i];
    tk[i] = refineTk(curPt, p0, c1, c2, p3, tk[i]);
    if (tk[i] < tk[i - 1]) tk[i] = tk[i - 1];
    if (tk[i] > 1.0) tk[i] = 1.0;
  }

  const refinedFit = fitCubic(pts, tk, startIdx, count);
  if (refinedFit.ok) {
    c1 = refinedFit.c1;
    c2 = refinedFit.c2;
  }

  // Pass 3: Splotch Killer & Error Evaluation on refined curve
  let refMaxSqDist = 0;
  let delta = 0;
  let prevPt = p0;
  let prevDist = 0;

  if (count <= 20) {
    for (let i = 1; i < count - 1; i++) {
      const t = tk[i];
      const curPt = pts[startIdx + i];
      const curApp = {
        x: N03(t) * p0.x + N13(t) * c1.x + N23(t) * c2.x + N33(t) * p3.x,
        y: N03(t) * p0.y + N13(t) * c1.y + N23(t) * c2.y + N33(t) * p3.y
      };
      const mtk = 0.5 * (t + tk[i - 1]);
      const midApp = {
        x: N03(mtk) * p0.x + N13(mtk) * c1.x + N23(mtk) * c2.x + N33(mtk) * p3.x,
        y: N03(mtk) * p0.y + N13(mtk) * c1.y + N23(mtk) * c2.y + N33(mtk) * p3.y
      };
      const midPt = {
        x: 0.5 * (curPt.x + prevPt.x),
        y: 0.5 * (curPt.y + prevPt.y)
      };

      const curDist = (curApp.x - curPt.x) ** 2 + (curApp.y - curPt.y) ** 2;
      const midDist = (midApp.x - midPt.x) ** 2 + (midApp.y - midPt.y) ** 2;

      delta += 0.3333 * (curDist + prevDist + midDist) * lk[i];
      if (curDist > refMaxSqDist) refMaxSqDist = curDist;

      prevPt = curPt;
      prevDist = curDist;
    }
    if (totalLen > 1e-9) delta /= totalLen;
  } else {
    for (let i = 1; i < count - 1; i++) {
      const t = tk[i];
      const curPt = pts[startIdx + i];
      const px = N03(t) * p0.x + N13(t) * c1.x + N23(t) * c2.x + N33(t) * p3.x;
      const py = N03(t) * p0.y + N13(t) * c1.y + N23(t) * c2.y + N33(t) * p3.y;
      const dSq = (px - curPt.x) ** 2 + (py - curPt.y) ** 2;
      delta += dSq;
      if (dSq > refMaxSqDist) refMaxSqDist = dSq;
    }
    delta /= (count - 2);
  }

  const ok = (refMaxSqDist <= threshSq) || (delta <= threshSq && refMaxSqDist <= 2.25 * threshSq);
  return { ok, c1, c2, worstDist: refMaxSqDist };
}

/**
 * DoSimplify: searches for the longest segment fittable within threshold,
 * using exponential search followed by binary search (step halving: 64, 32, 16, 8, 4, 2, 1).
 */
function doSimplifySubChain(pts, threshold, curveBuilder) {
  const N = pts.length;
  if (N <= 1) return;
  if (N === 2) {
    curveBuilder.lineToXY(pts[1].x, pts[1].y);
    return;
  }

  let curP = 0;
  while (curP < N - 1) {
    let lastP = curP + 1;
    let M = 2;
    let bestFit = null;

    let step = 64;
    while (step > 0) {
      while (lastP + step < N) {
        const testM = (lastP + step) - curP + 1;
        const testFit = attemptSimplify(pts, curP, testM, threshold);
        if (testFit.ok) {
          lastP += step;
          M = testM;
          bestFit = testFit;
        } else {
          break;
        }
      }
      step = Math.floor(step / 2);
    }

    const endPt = pts[lastP];
    if (M <= 2 || !bestFit) {
      curveBuilder.lineToXY(endPt.x, endPt.y);
    } else {
      curveBuilder.addBezierXY(bestFit.c1.x, bestFit.c1.y, bestFit.c2.x, bestFit.c2.y, endPt.x, endPt.y);
    }

    curP = lastP;
  }
}

function getEndTangent(b) {
  let dx = b.end.x - b.c2.x;
  let dy = b.end.y - b.c2.y;
  if (Math.hypot(dx, dy) < 1e-6) {
    dx = b.end.x - b.start.x;
    dy = b.end.y - b.start.y;
  }
  return { dx, dy };
}

function getStartTangent(b) {
  let dx = b.c1.x - b.start.x;
  let dy = b.c1.y - b.start.y;
  if (Math.hypot(dx, dy) < 1e-6) {
    dx = b.end.x - b.start.x;
    dy = b.end.y - b.start.y;
  }
  return { dx, dy };
}

/**
 * ConvertEvenLines: converts vector curve into polyline sample points,
 * subdividing straight lines and recursively subdividing Béziers.
 */
function convertCurveToPolyline(curve, threshold, keepCorners, cornerAngleDeg) {
  const beziers = [...curve.beziers];
  if (!beziers.length) return [];

  const pts = [];
  pts.push({ x: beziers[0].start.x, y: beziers[0].start.y, isCorner: false });
  const cornerCos = Math.cos((cornerAngleDeg || 60) * Math.PI / 180);

  for (let bi = 0; bi < beziers.length; bi++) {
    const b = beziers[bi];
    const segLen = Math.hypot(b.end.x - b.start.x, b.end.y - b.start.y);

    const isLine = (
      Math.hypot(b.c1.x - b.start.x, b.c1.y - b.start.y) < 1e-4 &&
      Math.hypot(b.c2.x - b.end.x, b.c2.y - b.end.y) < 1e-4
    ) || (
      Math.abs((b.c1.x - b.start.x) - (b.end.x - b.start.x) / 3) < 1e-3 &&
      Math.abs((b.c1.y - b.start.y) - (b.end.y - b.start.y) / 3) < 1e-3 &&
      Math.abs((b.c2.x - b.start.x) - 2 * (b.end.x - b.start.x) / 3) < 1e-3 &&
      Math.abs((b.c2.y - b.start.y) - 2 * (b.end.y - b.start.y) / 3) < 1e-3
    );

    if (isLine) {
      if (segLen > threshold && threshold > 0) {
        for (let i = threshold; i < segLen; i += threshold) {
          const u = i / segLen;
          pts.push({
            x: (1 - u) * b.start.x + u * b.end.x,
            y: (1 - u) * b.start.y + u * b.end.y,
            isCorner: false
          });
        }
      }
      pts.push({ x: b.end.x, y: b.end.y, isCorner: false });
    } else {
      const stepN = Math.max(4, Math.min(64, Math.ceil(segLen / threshold)));
      for (let i = 1; i <= stepN; i++) {
        const t = i / stepN;
        pts.push({
          x: N03(t) * b.start.x + N13(t) * b.c1.x + N23(t) * b.c2.x + N33(t) * b.end.x,
          y: N03(t) * b.start.y + N13(t) * b.c1.y + N23(t) * b.c2.y + N33(t) * b.end.y,
          isCorner: false
        });
      }
    }

    // Check junction corner angle with next segment
    if (keepCorners && bi < beziers.length - 1) {
      const nextB = beziers[bi + 1];
      const tIn = getEndTangent(b);
      const tOut = getStartTangent(nextB);
      const lIn = Math.hypot(tIn.dx, tIn.dy) || 1e-9;
      const lOut = Math.hypot(tOut.dx, tOut.dy) || 1e-9;
      const dot = (tIn.dx * tOut.dx + tIn.dy * tOut.dy) / (lIn * lOut);

      if (dot < cornerCos) {
        pts[pts.length - 1].isCorner = true;
      }
    }
  }

  return pts;
}

/**
 * Simplifies an individual Curve using least-squares cubic fitting.
 */
function simplifyCurve(curve, threshold, keepCorners, cornerAngleDeg) {
  const origNodeCount = countAnchorNodes(curve);
  const pts = convertCurveToPolyline(curve, threshold, keepCorners, cornerAngleDeg);
  if (!pts.length) return curve.clone();

  // Partition polyline into sub-chains at sharp corners
  const chains = [];
  let currentChain = [pts[0]];

  for (let i = 1; i < pts.length; i++) {
    currentChain.push(pts[i]);
    if (pts[i].isCorner && i < pts.length - 1) {
      chains.push(currentChain);
      currentChain = [pts[i]];
    }
  }
  if (currentChain.length > 1) {
    chains.push(currentChain);
  }

  const builder = CurveBuilder.create();
  builder.beginXY(pts[0].x, pts[0].y);

  for (const chain of chains) {
    doSimplifySubChain(chain, threshold, builder);
  }

  if (curve.isClosed) {
    builder.close();
  }

  const simplified = builder.createCurve();
  const newNodeCount = countAnchorNodes(simplified);

  // Node Count Guard: if simplify created MORE nodes than original, preserve original!
  if (newNodeCount > origNodeCount && origNodeCount > 0) {
    return curve.clone();
  }

  return simplified;
}

function getPolyCurveBounds(polyCurve) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let count = 0;
  for (const curve of polyCurve) {
    for (const b of curve.beziers) {
      minX = Math.min(minX, b.start.x, b.c1.x, b.c2.x, b.end.x);
      maxX = Math.max(maxX, b.start.x, b.c1.x, b.c2.x, b.end.x);
      minY = Math.min(minY, b.start.y, b.c1.y, b.c2.y, b.end.y);
      maxY = Math.max(maxY, b.start.y, b.c1.y, b.c2.y, b.end.y);
      count++;
    }
  }
  if (count === 0) return { width: 1000, height: 1000, diagonal: 1414 };
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const diagonal = Math.hypot(width, height);
  return { minX, maxX, minY, maxY, width, height, diagonal };
}

/**
 * Main PolyCurve simplification entry point.
 * Bounding box diagonal scaling: tresh = thresholdRatio * size.
 */
function simplifyPolyCurve(polyCurve, thresholdRatio, keepCorners, cornerAngleDeg) {
  if (!polyCurve) return PolyCurve.create();

  const bounds = getPolyCurveBounds(polyCurve);
  const size = bounds.diagonal;
  const effectiveThreshold = Math.max(0.05, (thresholdRatio || 0.0020) * size);

  const outPolyCurve = PolyCurve.create();

  for (const curve of polyCurve) {
    const simplified = simplifyCurve(curve, effectiveThreshold, keepCorners, cornerAngleDeg);
    if (simplified) {
      outPolyCurve.addCurve(simplified);
    }
  }

  return outPolyCurve;
}

function countAnchorNodes(curve) {
  if (!curve) return 0;
  const bCount = [...curve.beziers].length;
  if (bCount === 0) return 0;
  return curve.isClosed ? bCount : (bCount + 1);
}

function countPolyCurveNodes(polyCurve) {
  if (!polyCurve) return 0;
  let total = 0;
  try {
    for (const curve of polyCurve) {
      total += countAnchorNodes(curve);
    }
  } catch (e) {}
  return total;
}

// =============================================================================
// DOM, STYLE & SELECTION UTILITIES (WITH DEEP GROUP SUPPORT)
// =============================================================================

function mkSel(node) {
  return Selection.create(doc, node, true);
}

function getNodeName(node) {
  try { return node.userDescription || node.name || ""; } catch (e) { return ""; }
}

function isSameNode(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  try {
    if (typeof a.isSameNode === "function") {
      return a.isSameNode(b);
    }
  } catch (e) {}
  try {
    if (a.id && b.id && a.id === b.id) return true;
  } catch (e) {}
  return false;
}

function pushUnique(arr, item) {
  for (let i = 0; i < arr.length; i++) {
    if (isSameNode(arr[i], item)) return;
  }
  arr.push(item);
}

function isEffectGroup(node) {
  if (!node) return false;
  try {
    if (node.tagInterface && node.tagInterface.hasKey("effectPipeline")) return true;
  } catch (e) {}
  const name = getNodeName(node);
  return KNOWN_GROUP_PREFIXES.some(p => name.indexOf(p) === 0);
}

function isGroupNode(node) {
  if (!node) return false;
  if (node.isGroupNode) return true;
  if (node.isContainerNode && !isEffectGroup(node)) return true;
  if (node.constructor) {
    const cName = node.constructor.name;
    if (cName === "GroupNode" || cName === "LayerNode" || (cName === "ContainerNode" && !isEffectGroup(node))) {
      return true;
    }
  }
  if ("children" in node && typeof node.children === "object" && !node.curvesInterface && !node.shapeInterface) {
    return true;
  }
  return false;
}

function getChildren(container) {
  const result = [];
  if (!container) return result;
  try {
    if (container.children && typeof container.children.length === "number") {
      for (let i = 0; i < container.children.length; i++) {
        const ch = container.children.at(i);
        if (ch) result.push(ch);
      }
      return result;
    }
  } catch (e) {}
  try {
    let cur = container.firstChild;
    while (cur) {
      result.push(cur);
      cur = cur.nextSibling;
    }
  } catch (e) {}
  return result;
}

function isVectorCandidate(node) {
  if (!node) return false;
  if (isGroupNode(node)) return false;
  if (node.curvesInterface && node.curvesInterface.polyCurve) return true;
  if (node.shapeInterface) return true;
  return false;
}

/**
 * Recursively inspects selection and traverses any GroupNode or LayerNode,
 * returning every individual vector path inside the group(s).
 */
function collectVectorNodes(nodes) {
  const result = [];
  for (const node of nodes) {
    if (!node) continue;
    if (isGroupNode(node)) {
      const children = getChildren(node);
      const sub = collectVectorNodes(children);
      for (const s of sub) {
        pushUnique(result, s);
      }
    } else if (isVectorCandidate(node)) {
      pushUnique(result, node);
    }
  }
  return result;
}

function getSelectionNodes() {
  const nodes = [];
  if (!doc || !doc.selection) return nodes;
  try {
    const sel = doc.selection;
    if (typeof sel.length === "number") {
      for (let i = 0; i < sel.length; i++) {
        const item = sel.at(i);
        if (item && item.node) {
          pushUnique(nodes, item.node);
        } else if (item && item.isNode) {
          pushUnique(nodes, item);
        }
      }
    }
  } catch (e) {}
  if (!nodes.length) {
    try {
      if (doc.selection.nodes) {
        for (const n of doc.selection.nodes) pushUnique(nodes, n);
      }
    } catch (e) {}
  }
  return nodes;
}

function getNodeStyle(node) {
  const defaultStyle = {
    brushFill: FillDescriptor.createNone(),
    lineStyle: LineStyleDescriptor.createDefault(0),
    lineFill: FillDescriptor.createNone(),
    transparencyFill: FillDescriptor.createNone(),
    opacity: 1.0,
    blendMode: null,
    hasStroke: false
  };

  if (!node) return defaultStyle;

  let brushFill = FillDescriptor.createNone();
  let lineStyle = LineStyleDescriptor.createDefault(0);
  let lineFill = FillDescriptor.createNone();
  let transparencyFill = FillDescriptor.createNone();
  let hasStroke = false;
  let opacity = 1.0;
  let blendMode = null;

  try {
    if (node.visibilityInterface && typeof node.visibilityInterface.globalOpacity === "number") {
      opacity = node.visibilityInterface.globalOpacity;
    }
  } catch (e) {}

  try {
    if (node.blendModeInterface && node.blendModeInterface.blendMode) {
      blendMode = node.blendModeInterface.blendMode;
    } else if (node.blendMode) {
      blendMode = node.blendMode;
    }
  } catch (e) {}

  try {
    if (node.lineStyleInterface) {
      const lsi = node.lineStyleInterface;
      const isNoFill = lsi.isNoFill;
      const isVisible = (typeof lsi.isLineStyleVisible === "boolean") ? lsi.isLineStyleVisible : true;
      const lsDesc = lsi.lineStyleDescriptor;
      const penFill = lsi.penFillDescriptor;
      const weight = (lsDesc && lsDesc.lineStyle && typeof lsDesc.lineStyle.weight === "number")
        ? lsDesc.lineStyle.weight
        : (typeof lsi.lineWeight === "number" ? lsi.lineWeight : 0);

      if (isVisible && !isNoFill && weight > 0 && penFill && !penFill.isNoFill) {
        hasStroke = true;
        lineFill = penFill.clone();
        lineStyle = lsDesc ? lsDesc.clone() : LineStyleDescriptor.createDefault(weight);
      } else {
        hasStroke = false;
        lineFill = FillDescriptor.createNone();
        lineStyle = LineStyleDescriptor.createDefault(0);
      }
    }
  } catch (e) {}

  try {
    if (node.brushFillInterface && !node.brushFillInterface.isNoFill && node.brushFillInterface.currentDescriptor) {
      brushFill = node.brushFillInterface.currentDescriptor.clone();
    }
  } catch (e) {}

  try {
    if (node.transparencyInterface && !node.transparencyInterface.isTransparencyNone && node.transparencyInterface.fillDescriptor) {
      transparencyFill = node.transparencyInterface.fillDescriptor.clone();
    }
  } catch (e) {}

  return {
    brushFill,
    lineStyle,
    lineFill,
    transparencyFill,
    hasStroke,
    opacity,
    blendMode
  };
}

function applyOpacityAndBlendToFillDescriptor(fillDesc, opacity, targetBlendMode) {
  if (!fillDesc || fillDesc.isNoFill) return FillDescriptor.createNone();
  try {
    const typedFill = fillDesc.fill;
    if (typedFill) {
      const clonedFill = typedFill.clone();
      if (typeof opacity === "number" && opacity < 0.999 && opacity >= 0) {
        const currentAlpha = (typeof clonedFill.alpha === "number") ? clonedFill.alpha : 1.0;
        clonedFill.alpha = Math.max(0, Math.min(1, currentAlpha * opacity));
      }
      const finalBlendMode = targetBlendMode || fillDesc.blendMode || BlendMode.Normal;
      return FillDescriptor.create(
        clonedFill,
        fillDesc.isScaleWithObject,
        fillDesc.transform,
        finalBlendMode,
        fillDesc.isAnchoredToSpread
      );
    }
  } catch (e) {}
  return fillDesc;
}

/**
 * Extracts vector curves directly in their LOCAL coordinate space along with child transforms.
 * Preserving child node transforms ensures all paths inside groups render accurately in live preview.
 */
function extractSourceEntriesFromNodes(nodes) {
  const entries = [];
  for (const node of nodes) {
    try {
      if (node && node.curvesInterface && node.curvesInterface.polyCurve) {
        const pcLocal = node.curvesInterface.polyCurve.clone();
        let transform = null;
        try {
          if (node.transformInterface && node.transformInterface.transform) {
            transform = node.transformInterface.transform.clone();
          }
        } catch (e) {}
        entries.push({
          sourceNode: node,
          sourcePolyCurveLocal: pcLocal,
          transform: transform,
          style: getNodeStyle(node),
          name: getNodeName(node)
        });
      }
    } catch (e) {}
  }
  return entries;
}

// =============================================================================
// PIPELINE EVALUATION & METADATA MANAGEMENT
// =============================================================================

function evaluatePipeline(sourcePolyCurve, pipeline) {
  if (!sourcePolyCurve) return PolyCurve.create();
  if (!pipeline || !pipeline.length) {
    return sourcePolyCurve.clone();
  }

  let current = sourcePolyCurve.clone();
  for (const stage of pipeline) {
    if (!stage || !stage.id) continue;
    const handler = EffectRegistry[stage.id];
    if (handler && handler.evaluate) {
      current = handler.evaluate(current, stage.params);
    }
  }
  return current;
}

function formatPipelineGroupName(pipeline) {
  if (!pipeline || !pipeline.length) return "Simplify Effect";
  if (pipeline.length === 1) {
    const handler = EffectRegistry[pipeline[0].id];
    return handler ? (handler.name + " Effect") : "Simplify Effect";
  }
  const names = pipeline.map(s => {
    const h = EffectRegistry[s.id];
    return h ? h.name : s.id;
  });
  return "Effects [" + names.join(" + ") + "]";
}

function setContainerMetadata(document, groupNode, pipeline) {
  if (!groupNode) return;
  try {
    const groupSel = mkSel(groupNode);
    document.executeCommand(
      DocumentCommand.createSetTagValueForKey(groupSel, "effectPipeline", JSON.stringify(pipeline)),
      false
    );
    const title = formatPipelineGroupName(pipeline);
    document.executeCommand(DocumentCommand.createSetDescription(groupSel, title), false);
  } catch (e) {}
}

function tagNodeRed(node) {
  if (!node) return;
  try {
    doc.executeCommand(DocumentCommand.createSetTagColour(mkSel(node), RGB8(255, 0, 0)), false);
  } catch (e) {}
}

function clearPreviews(document) {
  try {
    document.executeCommand(DocumentCommand.createClearPreviews());
  } catch (e) {}
}

function makeSourceDefinitions(entries) {
  return entries.map((entry, index) => {
    const s = entry.style;
    const def = PolyCurveNodeDefinition.create(
      entry.sourcePolyCurveLocal.clone(),
      s.brushFill ? s.brushFill.clone() : FillDescriptor.createNone(),
      s.lineStyle ? s.lineStyle.clone() : LineStyleDescriptor.createDefault(0),
      s.lineFill ? s.lineFill.clone() : FillDescriptor.createNone(),
      s.transparencyFill ? s.transparencyFill.clone() : FillDescriptor.createNone()
    );
    if (entry.transform) {
      def.transform = entry.transform.clone();
    }
    def.name = `${SOURCE_PREFIX} ${index + 1}`;
    return def;
  });
}

function makeResultDefinitions(entries, pipeline) {
  return entries.map((entry, index) => {
    const s = entry.style;
    const resPolyCurve = evaluatePipeline(entry.sourcePolyCurveLocal, pipeline);

    const def = PolyCurveNodeDefinition.create(
      resPolyCurve,
      s.brushFill ? s.brushFill.clone() : FillDescriptor.createNone(),
      s.lineStyle ? s.lineStyle.clone() : LineStyleDescriptor.createDefault(0),
      s.lineFill ? s.lineFill.clone() : FillDescriptor.createNone(),
      s.transparencyFill ? s.transparencyFill.clone() : FillDescriptor.createNone()
    );
    if (entry.transform) {
      def.transform = entry.transform.clone();
    }
    def.name = `${RESULT_PREFIX} ${index + 1}`;
    return def;
  });
}

function addDefinitionsInsideGroup(group, definitions) {
  if (!definitions || !definitions.length) return [];
  const builder = AddChildNodesCommandBuilder.create();
  builder.setInsertionTargetSelection(mkSel(group));
  builder.setInsertionMode(InsertionMode.Inside);

  for (const def of definitions) {
    builder.addPolyCurveNode(def);
  }
  const cmd = builder.createCommand(false, NodeChildType.Main);
  doc.executeCommand(cmd);

  return Array.from(cmd.newNodes || []);
}

/**
 * Preview generator: inserts a preview PolyCurve directly next to each path in its parent group.
 * Copies the exact child node transform to guarantee all grouped paths render in their correct position.
 */
function doPreviewPipeline(document, previewEntries, pipeline) {
  clearPreviews(document);
  if (!previewEntries || !previewEntries.length) return;

  const cb = CompoundCommandBuilder.create();

  for (const entry of previewEntries) {
    const localCurve = entry.sourcePolyCurveLocal;
    if (!localCurve) continue;

    const resPolyCurve = evaluatePipeline(localCurve, pipeline);
    const s = entry.style;
    const op = (typeof s.opacity === "number") ? s.opacity : 1.0;
    const bm = s.blendMode || null;

    const previewBrushFill = (s.brushFill && !s.brushFill.isNoFill)
      ? applyOpacityAndBlendToFillDescriptor(s.brushFill, op, bm)
      : FillDescriptor.createNone();

    const previewLineFill = (s.hasStroke && s.lineFill && !s.lineFill.isNoFill)
      ? applyOpacityAndBlendToFillDescriptor(s.lineFill, op, bm)
      : FillDescriptor.createNone();

    const previewLineStyle = s.hasStroke
      ? (s.lineStyle || LineStyleDescriptor.createDefault(1))
      : LineStyleDescriptor.createDefault(0);

    const def = PolyCurveNodeDefinition.create(
      resPolyCurve,
      previewBrushFill,
      previewLineStyle,
      previewLineFill,
      s.transparencyFill || FillDescriptor.createNone()
    );

    // Apply child transform so preview aligns with original child position in group
    if (entry.transform) {
      def.transform = entry.transform.clone();
    }

    const addB = AddChildNodesCommandBuilder.create();
    addB.setInsertionTargetSelection(mkSel(entry.sourceNode));
    addB.setInsertionMode(InsertionMode.Before);
    addB.addNode(def);

    const cmd = addB.createCommand(false, NodeChildType.Main);
    if (cmd) {
      cb.addCommand(cmd);
    }
  }

  const compoundCmd = cb.createCommand();
  if (compoundCmd) {
    document.executeCommand(compoundCmd, true);
  }
}

// =============================================================================
// INTERACTIVE DIALOG & LIVE PREVIEW
// =============================================================================

function showDialog(title, initialParams, entries, onPreview) {
  let inPreview = false;
  let previewTimer = null;

  // Initial node count calculation across all paths (standalone and within groups)
  let totalOrigNodes = 0;
  let totalDiag = 1000;
  for (const entry of entries) {
    totalOrigNodes += countPolyCurveNodes(entry.sourcePolyCurveLocal);
    const b = getPolyCurveBounds(entry.sourcePolyCurveLocal);
    totalDiag = Math.max(totalDiag, b.diagonal);
  }

  const dlg = Dialog.create(title);
  dlg.initialWidth = 380;

  const col = dlg.addColumn();
  const grp = col.addGroup("Simplification Settings");

  // Threshold slider: 1 to 500 (where 20 = 0.0020 default)
  const threshScaledInitial = Math.max(1, Math.min(500, Math.round(initialParams.threshold * 10000)));
  const threshEd = grp.addUnitValueEditor("Threshold", UnitType.Number, UnitType.Number, threshScaledInitial, 1, 500);
  threshEd.precision = 0;
  threshEd.showPopupSlider = true;

  const cornerSw = grp.addSwitch("Keep sharp corners", initialParams.keepCorners);

  const cornerAngleEd = grp.addUnitValueEditor("Corner Angle Threshold", UnitType.Degree, UnitType.Degree, initialParams.cornerAngle, 10, 150);
  cornerAngleEd.precision = 0;
  cornerAngleEd.showPopupSlider = true;

  const modeSw = grp.addSwitch("Non-destructive container (v3g)", initialParams.isContainerMode);

  const statsGrp = col.addGroup("Real-Time Curve Analysis");
  const statsText = statsGrp.addStaticText(null, `Original Nodes: ${totalOrigNodes} (${entries.length} path${entries.length > 1 ? "s" : ""})`).setIsFullWidth(true);
  statsText.textHorizontalAlignment = HorizontalAlignment.Centre;

  const tolText = statsGrp.addStaticText(null, `Tolerance: ±${(initialParams.threshold * totalDiag).toFixed(2)} px`).setIsFullWidth(true);
  tolText.textHorizontalAlignment = HorizontalAlignment.Centre;

  function readValues() {
    const rawThresh = Math.max(1, Math.min(500, threshEd.value));
    const threshold = rawThresh / 10000.0;
    const keepCorners = !!cornerSw.value;
    const cornerAngle = Math.max(10, Math.min(150, Math.round(cornerAngleEd.value)));
    const isContainerMode = !!modeSw.value;

    return {
      threshold,
      keepCorners,
      cornerAngle,
      isContainerMode
    };
  }

  function triggerPreview() {
    if (previewTimer) previewTimer.cancel();
    previewTimer = setTimeout(50, (err) => {
      if (err || inPreview) return;
      inPreview = true;
      try {
        const currentParams = readValues();

        // Calculate simplified nodes count across all paths in groups
        let totalSimpNodes = 0;
        let maxTolerance = 0;

        for (const entry of entries) {
          const simpPc = simplifyPolyCurve(
            entry.sourcePolyCurveLocal,
            currentParams.threshold,
            currentParams.keepCorners,
            currentParams.cornerAngle
          );
          totalSimpNodes += countPolyCurveNodes(simpPc);

          const b = getPolyCurveBounds(entry.sourcePolyCurveLocal);
          maxTolerance = Math.max(maxTolerance, currentParams.threshold * b.diagonal);
        }

        const pct = totalOrigNodes > 0
          ? ((totalSimpNodes - totalOrigNodes) / totalOrigNodes * 100).toFixed(1)
          : 0;

        statsText.text = `Nodes: ${totalOrigNodes}  ➔  ${totalSimpNodes} (${pct > 0 ? "+" : ""}${pct}%) [${entries.length} paths]`;
        tolText.text = `Tolerance: ±${maxTolerance.toFixed(2)} px (${(currentParams.threshold * 100).toFixed(2)}%)`;

        onPreview(currentParams);
      } catch (e) {
        console.log(SCRIPT_TITLE + " preview error: " + e);
        clearPreviews(doc);
      } finally {
        inPreview = false;
      }
    });
  }

  threshEd.onValueChangedHandler = triggerPreview;
  cornerSw.onValueChangedHandler = triggerPreview;
  cornerAngleEd.onValueChangedHandler = triggerPreview;
  modeSw.onValueChangedHandler = triggerPreview;
  dlg.onControlValueChangedHandler = triggerPreview;

  triggerPreview();

  const result = dlg.show();
  if (previewTimer) previewTimer.cancel();
  clearPreviews(doc);

  return {
    ok: result.value === DialogResult.Ok.value,
    params: readValues()
  };
}

// =============================================================================
// EXECUTION WORKFLOWS (IN-PLACE & CONTAINER)
// =============================================================================

/**
 * In-Place execution: modifies each path directly in its parent container/group,
 * preserving group hierarchies, child orders, and original selection.
 */
function executeInPlace(entries, params, originalSelectedNodes) {
  const cb = CompoundCommandBuilder.create();
  const replacedNodes = [];

  for (const entry of entries) {
    const { sourceNode, sourcePolyCurveLocal, style, name, transform } = entry;
    const simplifiedPolyCurve = simplifyPolyCurve(
      sourcePolyCurveLocal,
      params.threshold,
      params.keepCorners,
      params.cornerAngle
    );

    // If node curvesInterface is mutable, update geometry directly in-place!
    if (sourceNode.curvesInterface && sourceNode.curvesInterface.isMutable) {
      cb.addCommand(DocumentCommand.createSetCurves(sourceNode.curvesInterface, simplifiedPolyCurve));
      replacedNodes.push(sourceNode);
    } else {
      // Create new node right next to original inside its parent, copy styles, delete original
      const addB = AddChildNodesCommandBuilder.create();
      addB.setInsertionTargetSelection(mkSel(sourceNode));
      addB.setInsertionMode(InsertionMode.Before);

      const def = PolyCurveNodeDefinition.create(
        simplifiedPolyCurve,
        style.brushFill ? style.brushFill.clone() : FillDescriptor.createNone(),
        style.lineStyle ? style.lineStyle.clone() : LineStyleDescriptor.createDefault(0),
        style.lineFill ? style.lineFill.clone() : FillDescriptor.createNone(),
        style.transparencyFill ? style.transparencyFill.clone() : FillDescriptor.createNone()
      );
      if (transform) {
        def.transform = transform.clone();
      }
      if (name) def.name = name;
      addB.addNode(def);

      const addCmd = addB.createCommand();
      cb.addCommand(addCmd);
      cb.addCommand(DocumentCommand.createDeleteSelection(mkSel(sourceNode)));
    }
  }

  doc.executeCommand(cb.createCommand());

  // Restore the user's original selection (e.g. GroupNode)
  if (originalSelectedNodes && originalSelectedNodes.length) {
    try {
      doc.selection = Selection.create(doc, originalSelectedNodes, true);
    } catch (e) {
      if (replacedNodes.length) {
        doc.selection = Selection.create(doc, replacedNodes, true);
      }
    }
  } else if (replacedNodes.length) {
    doc.selection = Selection.create(doc, replacedNodes, true);
  }
}

function executeContainer(entries, sourceNodes, params, originalSelectedNodes) {
  const pipeline = [{ id: CURRENT_EFFECT_ID, params: params }];

  // 1. Create Container Group at position of first source node
  const groupName = formatPipelineGroupName(pipeline);
  const gBuilder = AddChildNodesCommandBuilder.create();
  gBuilder.setInsertionTargetSelection(mkSel(sourceNodes[0]));
  gBuilder.setInsertionMode(InsertionMode.Before);
  gBuilder.addContainerNode(ContainerNodeDefinition.create(groupName));
  const gCmd = gBuilder.createCommand(false, NodeChildType.Main);
  doc.executeCommand(gCmd);
  const targetGroup = gCmd.newNodes[0];

  // 2. Add pristine Sources inside Container Group (Hidden)
  const sourceDefs = makeSourceDefinitions(entries);
  const createdSources = addDefinitionsInsideGroup(targetGroup, sourceDefs);
  if (createdSources.length) {
    const sSel = Selection.create(doc, createdSources, true);
    doc.executeCommand(DocumentCommand.createSetVisibility(sSel, false), false);
  }

  // 3. Generate Results inside Container Group with Red Tag (#FF0000)
  const resultDefs = makeResultDefinitions(entries, pipeline);
  const createdResults = addDefinitionsInsideGroup(targetGroup, resultDefs);

  for (let i = 0; i < createdResults.length; i++) {
    const resNode = createdResults[i];
    tagNodeRed(resNode);
    doc.executeCommand(DocumentCommand.createSetVisibility(mkSel(resNode), true), false);
    doc.executeCommand(DocumentCommand.createSetDescription(mkSel(resNode), `${RESULT_PREFIX} ${i + 1}`), false);

    const srcStyle = entries[i] ? entries[i].style : null;
    if (srcStyle) {
      if (typeof srcStyle.opacity === "number" && srcStyle.opacity < 0.999) {
        try { doc.executeCommand(DocumentCommand.createSetOpacity(mkSel(resNode), srcStyle.opacity), false); } catch (e) {}
      }
      if (srcStyle.blendMode) {
        try { doc.executeCommand(DocumentCommand.createSetBlendMode(mkSel(resNode), srcStyle.blendMode), false); } catch (e) {}
      }
    }
  }

  // 4. Save metadata on container
  setContainerMetadata(doc, targetGroup, pipeline);

  // 5. Delete original selected source nodes outside the container
  const delSel = Selection.create(doc, sourceNodes, true);
  doc.executeCommand(DocumentCommand.createDeleteSelection(delSel));

  doc.selection = Selection.create(doc, targetGroup, true);
}

function mainCreate(sourceNodes, originalSelectedNodes) {
  const entries = extractSourceEntriesFromNodes(sourceNodes);
  if (!entries.length) {
    alert("No usable vector curves were found in the selection or selected groups.");
    return;
  }

  const initialParams = EffectRegistry[CURRENT_EFFECT_ID].defaultParams;

  // Hide primary source shapes during preview
  const hideCb = CompoundCommandBuilder.create();
  for (const n of sourceNodes) {
    hideCb.addCommand(DocumentCommand.createSetVisibility(mkSel(n), false));
  }
  doc.executeCommand(hideCb.createCommand());

  const dialogResult = showDialog(
    SCRIPT_TITLE,
    initialParams,
    entries,
    function(currentParams) {
      const pipeline = [{ id: CURRENT_EFFECT_ID, params: currentParams }];
      doPreviewPipeline(doc, entries, pipeline);
    }
  );

  clearPreviews(doc);

  // Unhide original shapes before applying final changes or if cancelled
  const unhideCb = CompoundCommandBuilder.create();
  for (const n of sourceNodes) {
    unhideCb.addCommand(DocumentCommand.createSetVisibility(mkSel(n), true));
  }
  doc.executeCommand(unhideCb.createCommand());

  if (dialogResult.ok) {
    const params = dialogResult.params;
    if (params.isContainerMode) {
      executeContainer(entries, sourceNodes, params, originalSelectedNodes);
    } else {
      executeInPlace(entries, params, originalSelectedNodes);
    }
  } else {
    // Restore selection if cancelled
    if (originalSelectedNodes && originalSelectedNodes.length) {
      try {
        doc.selection = Selection.create(doc, originalSelectedNodes, true);
      } catch (e) {}
    }
  }
}

// =============================================================================
// MAIN ENTRY POINT
// =============================================================================

function main() {
  if (!doc) {
    alert("Please open a document in Serif Affinity first.");
    return;
  }

  const originalSelectedNodes = getSelectionNodes();
  if (!originalSelectedNodes.length) {
    alert("Please select at least one vector curve, shape, or group to simplify.");
    return;
  }

  // Traverses all selected nodes and extracts all vector paths inside groups
  const vectorNodes = collectVectorNodes(originalSelectedNodes);
  if (!vectorNodes.length) {
    alert("No valid vector paths or shapes found in the current selection or selected groups.");
    return;
  }

  mainCreate(vectorNodes, originalSelectedNodes);
}

module.exports.main = main;
module.exports.SCRIPT_TITLE = SCRIPT_TITLE;
module.exports.EffectRegistry = EffectRegistry;
module.exports.simplifyPolyCurve = simplifyPolyCurve;
module.exports.simplifyCurve = simplifyCurve;
module.exports.convertCurveToPolyline = convertCurveToPolyline;
module.exports.countPolyCurveNodes = countPolyCurveNodes;
module.exports.getPolyCurveBounds = getPolyCurveBounds;
module.exports.collectVectorNodes = collectVectorNodes;

main();
