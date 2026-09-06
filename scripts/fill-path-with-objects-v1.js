/**
 * name: Fill Path with Objects v3aaf
 */
'use strict';

// =============================================================================
// FILL PATH WITH OBJECTS v3aaf (Rock-Solid Container Resize Detection & Group Stretch)
// Affinity Designer / Photo / Publisher (v3e & Multi-Effect Standard)
//
// Key Features & Fixes in v3aaf:
// 1. Updated workflow notice in dialog UI to standard procedural effect text:
//    - "✨ Non-destructive Procedural Effect ✨"
//    - "Run this script again on the container to edit parameters, or run other effect scripts to stack effects."
// 2. Fixed Critical Dialog Undefined Property & Transform Point Bug:
//    - Corrected initialValues.xfm.* bindings in UI dialog.
//    - Replaced all non-existent transformPoint calls with applyToPoint / data
//      access via robust transformPt() helper to prevent runtime exceptions.
// 3. Automatic Container Resize Detection & Auto-Stretch:
//    - Robustly extracts scaling from container transform matrix baseToSpreadTransform.
//    - When the container has been resized or stretched on canvas, automatically
//      sets the default scaling mode to "Stretch (Fit W & H)" (dimensionMode = 1).
// 4. Full Group Support in Stretch & Proportional Modes:
//    - getNodeLocalCenterAndDim accurately computes the geometric centroid and
//      bounding box across all child curves/shapes within Groups in Local Container space.
//    - Group templates are stretched, scaled, and placed with 100% mathematical precision
//      in both Live Preview and final Apply.
// 5. Permanent Source Dimension Compensation on Replace:
//    - Replaced external sources (single curves or Groups) are permanently scaled
//      before moving into the container as Source 1..N, ensuring 3rd and subsequent
//      runs maintain the exact same size.
// 6. Unconditional Deterministic Sequential Z-Order:
//    - Duplicate nodes sequenced using NodeMoveType.After matching Live Preview 1:1.
// 7. Expand Effects Compatibility:
//    - Generated duplicate objects are tagged Red (#FF0000).
// =============================================================================

const { Document } = require('/document');
const { Dialog, DialogResult, HorizontalAlignment } = require('/dialog');
const {
  DocumentCommand,
  CompoundCommandBuilder,
  AddChildNodesCommandBuilder,
  InsertionMode,
  NodeChildType,
  NodeMoveType
} = require('/commands');
const { PolyCurveNodeDefinition, ContainerNodeDefinition } = require('/nodes');
const { Transform, PolyCurve } = require('/geometry');
const { UnitType } = require('/units');
const { RGB8 } = require('/colours');
const { FillDescriptor, BlendMode } = require('/fills');
const { LineStyleDescriptor } = require('/linestyle');
const { Selection } = require('/selections');
const { setTimeout } = require('/timers');

// =============================================================================
// CONSTANTS & REGISTRY
// =============================================================================

const SCRIPT_TITLE = 'Fill Path with Objects v3aaf';
const TAG_KEY = 'fillPathSettings';
const GROUP_PREFIX = 'Fill Path Effect';
const PATH_PREFIX = 'Source Path';
const SOURCE_PREFIX = 'Source';
const RESULT_PREFIX = 'Result';
const MAX_POINTS_LIMIT = 5000;

const DEFAULT_VALUES = {
  spacing: 40,
  gridType: 0, // 0: Rectangular, 1: Hexagonal, 2: Circular, 3: Diamond, 4: Sunflower, 5: Radial
  margin: 5,
  scaleBase: 100,
  globalRot: 0,
  adoptDimensions: true,
  dimensionMode: 0, // 0: Proportional (Keep Aspect), 1: Stretch (Fit W & H)
  xfm: {
    mode: 0, // 0: Circular, 1: Rect Up/Down, 2: Rect Left/Right
    scaleStart: 100,
    scaleEnd: 100,
    scaleCurve: 0,
    rotStart: 0,
    rotEnd: 0,
    scatStart: 100,
    scatEnd: 100
  },
  rnd: {
    enabled: false,
    shuffleSeed: 0,
    jitterSeed: 0,
    jitterAmt: 40,
    scatterSeed: 0,
    scatterAmt: 70,
    rotSeed: 0,
    rotMaxDeg: 180,
    sizeSeed: 0,
    sizeAmt: 30,
    zSeed: 0
  }
};

const doc = Document.current;

// =============================================================================
// MATH & PSEUDO-RANDOM NUMBER GENERATOR
// =============================================================================

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}

function makePRNG(seed) {
  let s = (seed || 1) >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleArray(arr, seed) {
  const a = [...arr];
  const rand = makePRNG(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

function applyCurve(t, curve) {
  if (!curve || Math.abs(curve) < 0.5) return t;
  return Math.pow(Math.max(0, Math.min(1, t)), Math.pow(2, curve / 50));
}

// =============================================================================
// GEOMETRY & CONTAINER TRANSFORM MANAGEMENT
// =============================================================================

function getContainerTransform(containerNode) {
  if (!containerNode) return null;
  try {
    const xf = containerNode.baseToSpreadTransform || (containerNode.transformInterface ? containerNode.transformInterface.transform : null);
    if (xf) return xf.clone();
  } catch (e) {}
  return null;
}

function transformPt(xf, x, y) {
  if (!xf) return { x, y };
  try {
    if (xf.applyToPoint) {
      const p = xf.applyToPoint({ x, y });
      return { x: p.x, y: p.y };
    }
  } catch (e) {}
  try {
    if (xf.data && xf.data.length >= 6) {
      const nx = xf.data[0] * x + xf.data[1] * y + xf.data[2];
      const ny = xf.data[3] * x + xf.data[4] * y + xf.data[5];
      return { x: nx, y: ny };
    }
  } catch (e) {}
  return { x, y };
}

function detectContainerScale(containerNode) {
  if (!containerNode) return { isResized: false, isNonUniform: false, scaleX: 1.0, scaleY: 1.0 };
  const xf = getContainerTransform(containerNode);
  if (!xf) return { isResized: false, isNonUniform: false, scaleX: 1.0, scaleY: 1.0 };

  try {
    let sx = 1.0, sy = 1.0;
    if (xf.xAxis && xf.yAxis) {
      sx = Math.hypot(xf.xAxis.x, xf.xAxis.y);
      sy = Math.hypot(xf.yAxis.x, xf.yAxis.y);
    } else if (xf.data && xf.data.length >= 6) {
      sx = Math.hypot(xf.data[0], xf.data[3]);
      sy = Math.hypot(xf.data[1], xf.data[4]);
    } else if (xf.applyToPoint) {
      const p0 = xf.applyToPoint({ x: 0, y: 0 });
      const px = xf.applyToPoint({ x: 1, y: 0 });
      const py = xf.applyToPoint({ x: 0, y: 1 });
      sx = Math.hypot(px.x - p0.x, px.y - p0.y);
      sy = Math.hypot(py.x - p0.y, py.y - p0.y);
    }

    const isNonUniform = Math.abs(sx - sy) > 0.005;
    const isResized = Math.abs(sx - 1.0) > 0.005 || Math.abs(sy - 1.0) > 0.005;

    return { isResized, isNonUniform, scaleX: sx, scaleY: sy };
  } catch (e) {
    return { isResized: false, isNonUniform: false, scaleX: 1.0, scaleY: 1.0 };
  }
}

function evalBez(b, t) {
  const u = 1 - t;
  return {
    x: u * u * u * b.start.x + 3 * u * u * t * b.c1.x + 3 * u * t * t * b.c2.x + t * t * t * b.end.x,
    y: u * u * u * b.start.y + 3 * u * u * t * b.c1.y + 3 * u * t * t * b.c2.y + t * t * t * b.end.y
  };
}

function getSpreadPolyCurve(node) {
  if (!node) return null;
  try {
    let pc = null;
    if (node.curvesInterface) {
      try { pc = node.curvesInterface.polyCurve ? node.curvesInterface.polyCurve.clone() : null; } catch (e) {}
      if (!pc) {
        try { pc = node.curvesInterface.corneredPolyCurve ? node.curvesInterface.corneredPolyCurve.clone() : null; } catch (e) {}
      }
    }
    if (!pc && node.polyCurve) {
      try { pc = node.polyCurve.clone(); } catch (e) {}
    }
    if (pc) {
      const xf = node.baseToSpreadTransform || (node.transformInterface ? node.transformInterface.transform : null);
      if (xf) {
        try { pc.transform(xf); } catch (e) {}
      }
      return pc;
    }
  } catch (e) {}
  return null;
}

function getLocalPolyCurve(node, containerTransform) {
  const pc = getSpreadPolyCurve(node);
  if (!pc) return null;
  if (containerTransform && containerTransform.inverted) {
    try { pc.transform(containerTransform.inverted); } catch (e) {}
  }
  return pc;
}

function getLocalBeziers(node, containerTransform) {
  if (!node) return [];
  try {
    const pc = getLocalPolyCurve(node, containerTransform);
    if (pc && pc.at && pc.at(0) && pc.at(0).beziers) {
      return [...pc.at(0).beziers];
    }
  } catch (e) {}
  return [];
}

function sampleBezierPolygon(beziers, baseSteps) {
  const pts = [];
  const steps = baseSteps || 60;
  for (let bi = 0; bi < beziers.length; bi++) {
    const b = beziers[bi];
    const ch = Math.hypot(b.end.x - b.start.x, b.end.y - b.start.y);
    const cp =
      Math.hypot(b.c1.x - b.start.x, b.c1.y - b.start.y) +
      Math.hypot(b.c2.x - b.c1.x, b.c2.y - b.c1.y) +
      Math.hypot(b.end.x - b.c2.x, b.end.y - b.c2.y);
    const r = ch > 0.01 ? cp / ch : 1;
    const ss = Math.max(steps, Math.round(steps * r));
    for (let s = 0; s < ss; s++) {
      pts.push(evalBez(b, s / ss));
    }
  }
  return pts;
}

function pointInPolygonRC(px, py, pp) {
  let inside = false;
  for (let i = 0, j = pp.length - 1; i < pp.length; j = i++) {
    const xi = pp[i].x, yi = pp[i].y;
    const xj = pp[j].x, yj = pp[j].y;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInsideWithMargin(px, py, pp, margin) {
  if (!pointInPolygonRC(px, py, pp)) return false;
  if (margin <= 0) return true;
  const dirs = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [0.7071, 0.7071], [-0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, -0.7071]
  ];
  for (const dir of dirs) {
    if (!pointInPolygonRC(px + dir[0] * margin, py + dir[1] * margin, pp)) {
      return false;
    }
  }
  return true;
}

function polyBBox(pts) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const p of pts) {
    if (p.x < x1) x1 = p.x;
    if (p.x > x2) x2 = p.x;
    if (p.y < y1) y1 = p.y;
    if (p.y > y2) y2 = p.y;
  }
  return { x: x1, y: y1, w: Math.max(1, x2 - x1), h: Math.max(1, y2 - y1) };
}

function polyCentroid(pts) {
  let sx = 0, sy = 0;
  for (const p of pts) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / pts.length, y: sy / pts.length };
}

// Universal extractor for single curves, shapes, groups, and nested groups
function getNodeLocalCenterAndDim(node, containerTransform) {
  if (!node) return { center: { x: 0, y: 0 }, dim: { w: 0, h: 0, maxDim: 0 } };

  // 1. If it's a single curve or shape with polycurve:
  try {
    const pc = getLocalPolyCurve(node, containerTransform);
    if (pc && pc.at && pc.at(0) && pc.at(0).beziers) {
      const pts = sampleBezierPolygon([...pc.at(0).beziers], 30);
      if (pts.length > 0) {
        const bb = polyBBox(pts);
        const cen = polyCentroid(pts);
        return {
          center: cen,
          dim: { w: bb.w, h: bb.h, maxDim: Math.max(bb.w, bb.h) }
        };
      }
    }
  } catch (e) {}

  // 2. If it's a Group node, collect geometries from all children
  try {
    const geoms = extractLocalGeomEntriesFromNode(node, containerTransform);
    if (geoms && geoms.length > 0) {
      const allPts = [];
      for (const g of geoms) {
        if (g && g.polyCurve) {
          try {
            const numCurves = typeof g.polyCurve.length === 'number' ? g.polyCurve.length : 1;
            for (let ci = 0; ci < numCurves; ci++) {
              const c = g.polyCurve.at ? g.polyCurve.at(ci) : null;
              if (c && c.beziers) {
                const pts = sampleBezierPolygon([...c.beziers], 20);
                for (const p of pts) allPts.push(p);
              }
            }
          } catch (e) {}
        }
      }
      if (allPts.length > 0) {
        const bb = polyBBox(allPts);
        const cen = polyCentroid(allPts);
        return {
          center: cen,
          dim: { w: bb.w, h: bb.h, maxDim: Math.max(bb.w, bb.h) }
        };
      }
    }
  } catch (e) {}

  // 3. Fallback: BaseBox transformed to local container space
  try {
    const b = node.getSpreadBaseBox(false);
    if (b && Number.isFinite(b.width) && b.width > 0 && Number.isFinite(b.height) && b.height > 0) {
      const inv = (containerTransform && containerTransform.inverted) ? containerTransform.inverted : null;
      if (inv) {
        const p1 = transformPt(inv, b.x, b.y);
        const p2 = transformPt(inv, b.x + b.width, b.y);
        const p3 = transformPt(inv, b.x, b.y + b.height);
        const p4 = transformPt(inv, b.x + b.width, b.y + b.height);
        const minX = Math.min(p1.x, p2.x, p3.x, p4.x);
        const maxX = Math.max(p1.x, p2.x, p3.x, p4.x);
        const minY = Math.min(p1.y, p2.y, p3.y, p4.y);
        const maxY = Math.max(p1.y, p2.y, p3.y, p4.y);
        const lw = Math.max(1, maxX - minX);
        const lh = Math.max(1, maxY - minY);
        return {
          center: { x: minX + lw / 2, y: minY + lh / 2 },
          dim: { w: lw, h: lh, maxDim: Math.max(lw, lh) }
        };
      }
      return {
        center: { x: b.x + b.width / 2, y: b.y + b.height / 2 },
        dim: { w: b.width, h: b.height, maxDim: Math.max(b.width, b.height) }
      };
    }
  } catch (e) {}

  return { center: { x: 0, y: 0 }, dim: { w: 0, h: 0, maxDim: 0 } };
}

function getBBoxArea(node) {
  try {
    const b = node.getSpreadBaseBox(false);
    return b.width * b.height;
  } catch (e) {
    return 0;
  }
}

function hasNoFill(node) {
  if (!node || !node.isVectorNode || !node.polyCurve) return false;
  try {
    return !node.hasBrushFill;
  } catch (e) {
    return false;
  }
}

function autoDetectPathIndex(nodes) {
  const nf = [], hf = [];
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i] && nodes[i].isVectorNode && nodes[i].polyCurve && hasNoFill(nodes[i])) {
      nf.push(i);
    } else {
      hf.push(i);
    }
  }
  if (nf.length > 0 && hf.length > 0) {
    let bc = -1, ba = -1;
    for (const idx of nf) {
      try {
        if (nodes[idx].polyCurve.at(0).isClosed) {
          const a = getBBoxArea(nodes[idx]);
          if (a > ba) { ba = a; bc = idx; }
        }
      } catch (e) {}
    }
    if (bc >= 0) return bc;
    return nf[0];
  }
  let best = -1, bA = -1;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n && n.isVectorNode && n.polyCurve) {
      try {
        if (n.polyCurve.at(0).isClosed) {
          const a = getBBoxArea(n);
          if (a > bA) { bA = a; best = i; }
        }
      } catch (e) {}
    }
  }
  return best >= 0 ? best : 0;
}

// =============================================================================
// POINT DISTRIBUTION & TRANSFORM ENGINE
// =============================================================================

function generatePoints(pp, spacing, gridType, margin, jitterSeed, jitterAmt, nT, scatterSeed, scatterAmt) {
  const bb = polyBBox(pp);
  const jR = (jitterSeed > 0 && jitterAmt > 0) ? makePRNG(jitterSeed) : null;
  const scR = (scatterSeed > 0 && scatterAmt < 100) ? makePRNG(scatterSeed) : null;
  const cen = polyCentroid(pp);
  const mR = Math.max(bb.w, bb.h) / 2;
  const pts = [], ri = [];

  function add(px, py, r) {
    if (!pointInsideWithMargin(px, py, pp, margin)) return;
    if (scR && scR() * 100 >= scatterAmt) return;
    if (pts.length >= MAX_POINTS_LIMIT) return;
    pts.push({ x: px, y: py });
    ri.push(r);
  }

  function jit(px, py, sx, sy) {
    if (jR) {
      px += (jR() - 0.5) * sx * jitterAmt;
      py += (jR() - 0.5) * sy * jitterAmt;
    }
    return { x: px, y: py };
  }

  if (gridType === 0 || gridType === 1) {
    const isH = gridType === 1;
    const rH = isH ? (spacing * Math.sqrt(3)) / 2 : spacing;
    let row = 0, idx = 0;
    for (let y = bb.y; y <= bb.y + bb.h; y += rH) {
      const ox = (isH && row % 2 === 1) ? spacing / 2 : 0;
      for (let x = bb.x + ox; x <= bb.x + bb.w; x += spacing) {
        const j = jit(x, y, spacing, rH);
        add(j.x, j.y, idx);
        idx++;
      }
      row++;
    }
  } else if (gridType === 2) {
    const j0 = jit(cen.x, cen.y, spacing, spacing);
    add(j0.x, j0.y, 0);
    let ring = 1;
    for (let r = spacing; r <= mR + spacing; r += spacing) {
      const nP = Math.max(6, Math.round((2 * Math.PI * r) / spacing));
      const ao = (ring % 2 === 0) ? 0 : Math.PI / nP;
      for (let i = 0; i < nP; i++) {
        const a = (2 * Math.PI * i) / nP + ao;
        const j = jit(cen.x + r * Math.cos(a), cen.y + r * Math.sin(a), spacing, spacing);
        add(j.x, j.y, ring);
      }
      ring++;
    }
  } else if (gridType === 3) {
    const c45 = Math.cos(Math.PI / 4), s45 = Math.sin(Math.PI / 4);
    const md = Math.hypot(bb.w, bb.h) / 2 + spacing * 2;
    const cx = bb.x + bb.w / 2, cy = bb.y + bb.h / 2;
    let idx = 0;
    for (let gy = -md; gy <= md; gy += spacing) {
      for (let gx = -md; gx <= md; gx += spacing) {
        const rx = cx + gx * c45 - gy * s45;
        const ry = cy + gx * s45 + gy * c45;
        const j = jit(rx, ry, spacing, spacing);
        add(j.x, j.y, idx);
        idx++;
      }
    }
  } else if (gridType === 4) {
    const ga = Math.PI * (3 - Math.sqrt(5));
    const maxN = Math.min(MAX_POINTS_LIMIT, Math.max(10, Math.round((bb.w * bb.h) / (spacing * spacing) * 1.5)));
    const sf = spacing / Math.sqrt(Math.PI);
    for (let i = 0; i < maxN; i++) {
      const r = sf * Math.sqrt(i);
      const th = i * ga;
      const j = jit(cen.x + r * Math.cos(th), cen.y + r * Math.sin(th), spacing, spacing);
      add(j.x, j.y, i);
    }
  } else if (gridType === 5) {
    const maxSp = Math.max(4, Math.round((2 * Math.PI * mR) / spacing / 1.5));
    const j0 = jit(cen.x, cen.y, spacing, spacing);
    add(j0.x, j0.y, 0);
    let idx = 0;
    for (let r = spacing; r <= mR + spacing; r += spacing) {
      const fit = Math.max(1, Math.floor((2 * Math.PI * r) / spacing));
      const sp = Math.min(maxSp, fit);
      for (let s = 0; s < sp; s++) {
        const a = (2 * Math.PI * s) / sp;
        const j = jit(cen.x + r * Math.cos(a), cen.y + r * Math.sin(a), spacing, spacing);
        add(j.x, j.y, idx);
        idx++;
      }
    }
  }
  return { points: pts, ringIndices: ri };
}

function computeTransformT(pt, bb, cen, mR, mode) {
  if (mode === 0) return mR > 0 ? Math.min(Math.hypot(pt.x - cen.x, pt.y - cen.y) / mR, 1) : 0;
  if (mode === 1) return bb.h > 0 ? (pt.y - bb.y) / bb.h : 0;
  if (mode === 2) return bb.w > 0 ? (pt.x - bb.x) / bb.w : 0;
  return 0;
}

function calculatePlacements(pathPolygon, templateItems, params, adoptDimensions) {
  const nT = Math.max(1, templateItems.length);
  const rnd = params.rnd || {};
  const re = !!rnd.enabled;
  const jS = re ? Math.round(rnd.jitterSeed || 0) : 0;
  const sS = re ? Math.round(rnd.scatterSeed || 0) : 0;

  const gen = generatePoints(
    pathPolygon,
    params.spacing,
    params.gridType,
    params.margin,
    jS,
    re && jS > 0 ? (rnd.jitterAmt || 0) / 100 : 0,
    nT,
    sS,
    re && sS > 0 ? (rnd.scatterAmt || 100) : 100
  );

  const xfm = params.xfm || DEFAULT_VALUES.xfm;
  const bb = polyBBox(pathPolygon);
  const cen = polyCentroid(pathPolygon);
  const mR = Math.max(bb.w, bb.h) / 2;
  let pts = gen.points, rings = gen.ringIndices;

  if (xfm.scatStart < 100 || xfm.scatEnd < 100) {
    const sR = makePRNG(7919);
    const fp = [], fr = [];
    for (let i = 0; i < pts.length; i++) {
      const t = computeTransformT(pts[i], bb, cen, mR, xfm.mode);
      const d = xfm.scatStart + (xfm.scatEnd - xfm.scatStart) * t;
      if (sR() * 100 < d) {
        fp.push(pts[i]);
        fr.push(rings[i]);
      }
    }
    pts = fp;
    rings = fr;
  }

  const n = pts.length;
  if (n === 0) return [];

  let tI = [];
  if (params.gridType === 2) {
    for (let i = 0; i < n; i++) tI.push(rings[i] % nT);
  } else {
    for (let i = 0; i < n; i++) tI.push(i % nT);
  }

  if (re && rnd.shuffleSeed > 0) {
    tI = shuffleArray(tI, rnd.shuffleSeed);
  }

  const rRnd = makePRNG(rnd.rotSeed || 1);
  const sRnd = makePRNG(rnd.sizeSeed || 1);
  const mxR = ((rnd.rotMaxDeg || 0) * Math.PI) / 180;
  const sAmp = (rnd.sizeAmt || 0) / 100;
  const pRot = new Array(n);
  const pSc = new Array(n);

  for (let i = 0; i < n; i++) {
    pRot[i] = re && rnd.rotSeed > 0 ? (rRnd() - 0.5) * 2 * mxR : 0;
    pSc[i] = re && rnd.sizeSeed > 0 ? 1 + (sRnd() - 0.5) * 2 * sAmp : 1;
  }

  const gR = ((params.globalRot || 0) * Math.PI) / 180;
  const bS = (params.scaleBase || 100) / 100;

  const placements = [];
  for (let i = 0; i < n; i++) {
    const pt = pts[i];
    const tmplIdx = tI[i] % nT;
    const tmplItem = templateItems[tmplIdx];
    const dimScale = (adoptDimensions && tmplItem && tmplItem.dimScale) ? tmplItem.dimScale : { sx: 1.0, sy: 1.0 };

    const rawT = computeTransformT(pt, bb, cen, mR, xfm.mode);
    const xScale = (xfm.scaleStart + (xfm.scaleEnd - xfm.scaleStart) * applyCurve(rawT, xfm.scaleCurve)) / 100;
    const xRot = ((xfm.rotStart + (xfm.rotEnd - xfm.rotStart) * rawT) * Math.PI) / 180;
    const tRot = gR + xRot + pRot[i];
    const tSc = Math.max(0.001, bS * xScale * pSc[i]);

    placements.push({
      x: pt.x,
      y: pt.y,
      templateIndex: tmplIdx,
      rotation: tRot,
      scale: tSc,
      scaleX: tSc * dimScale.sx,
      scaleY: tSc * dimScale.sy
    });
  }

  return placements;
}

function buildPlacementTransform(localSourceCenter, placement) {
  return Transform.createTranslate(placement.x, placement.y)
    .multiply(Transform.createRotate(placement.rotation))
    .multiply(Transform.createScale(placement.scaleX, placement.scaleY))
    .multiply(Transform.createTranslate(-localSourceCenter.x, -localSourceCenter.y));
}

// =============================================================================
// DOM, TAGS & CONTAINER DETECTION HELPERS
// =============================================================================

const mkSel = n => Selection.create(doc, n, true);

function nodeTag(node) {
  try {
    return node && node[Symbol.toStringTag] ? String(node[Symbol.toStringTag]) : '';
  } catch (e) {
    return '';
  }
}

function isSameNode(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  try {
    if (a.isSameNode && a.isSameNode(b)) return true;
  } catch (e) {}
  return false;
}

function isChildOf(child, parent) {
  if (!child || !parent) return false;
  let p = child.parent;
  while (p) {
    if (isSameNode(p, parent)) return true;
    p = p.parent;
  }
  return false;
}

function getNodeName(node) {
  try { return node.userDescription || node.name || ''; } catch (e) { return ''; }
}

function getChildren(node) {
  if (!node) return [];
  const children = [];
  let child = null;
  try { child = node.firstChild; } catch (e) { child = null; }
  while (child) {
    children.push(child);
    try { child = child.nextSibling; } catch (e) { child = null; }
  }
  return children;
}

function isRedTagColour(colour) {
  if (!colour) return false;
  try {
    const rgba = colour.rgba8 || (colour.getRGBA8 ? colour.getRGBA8() : null);
    if (!rgba) return false;
    const r = rgba.r !== undefined ? rgba.r : rgba.red;
    const g = rgba.g !== undefined ? rgba.green : rgba.green;
    const b = rgba.b !== undefined ? rgba.blue : rgba.blue;
    if (r === undefined || g === undefined || b === undefined) return false;
    if (r === 255 && g === 0 && b === 0) return true;
    if (r >= 180 && g <= 100 && b <= 100 && (r - Math.max(g, b) >= 80)) return true;
    return false;
  } catch (e) {
    return false;
  }
}

function hasRedTag(node) {
  if (!node) return false;
  try { if (node.tagColour && isRedTagColour(node.tagColour)) return true; } catch (e) {}
  try { if (node.layerColour && isRedTagColour(node.layerColour)) return true; } catch (e) {}
  return false;
}

function tagNodeRed(node) {
  if (!node) return;
  try {
    doc.executeCommand(DocumentCommand.createSetTagColour(mkSel(node), RGB8(255, 0, 0)), false);
  } catch (e) {}
}

function isFillPathContainer(node) {
  if (!node) return false;
  try {
    if (node.tagInterface) {
      if (node.tagInterface.hasKey(TAG_KEY)) return true;
      if (node.tagInterface.hasKey('effectPipeline')) {
        const json = node.tagInterface.getValueForKey('effectPipeline');
        if (json && json.indexOf('fill_path') >= 0) return true;
      }
    }
  } catch (e) {}
  const name = getNodeName(node);
  if (name === GROUP_PREFIX || name.indexOf(GROUP_PREFIX) === 0 || name.indexOf('Fill Path') === 0) return true;
  const children = getChildren(node);
  const hasPath = children.some(c => getNodeName(c).indexOf(PATH_PREFIX) === 0);
  const hasSource = children.some(c => getNodeName(c).indexOf(SOURCE_PREFIX) === 0);
  return hasPath && hasSource;
}

function getFillPathContainerOf(node) {
  let cur = node;
  while (cur) {
    if (isFillPathContainer(cur)) return cur;
    cur = cur.parent;
  }
  return null;
}

function isSourcePathNode(node) {
  if (!node) return false;
  const name = getNodeName(node);
  return name.indexOf(PATH_PREFIX) === 0 || name.toLowerCase() === 'path';
}

function isSourceTemplateNode(node) {
  if (!node) return false;
  const name = getNodeName(node);
  return name.indexOf(SOURCE_PREFIX) === 0 && name.indexOf(PATH_PREFIX) !== 0;
}

function isResultNode(node) {
  if (!node) return false;
  if (hasRedTag(node)) return true;
  const name = getNodeName(node);
  return name.indexOf(RESULT_PREFIX) === 0 || name.indexOf('Result') === 0 || name.indexOf('filled_') === 0;
}

function extractContainerSourcesAndPath(group) {
  const children = getChildren(group);
  let path = null;
  const sources = [];
  const results = [];

  for (const child of children) {
    if (isResultNode(child)) {
      results.push(child);
    } else if (isSourcePathNode(child)) {
      path = child;
    } else if (isSourceTemplateNode(child)) {
      sources.push(child);
    }
  }

  if (!path) {
    path = children.find(c => !isResultNode(c) && c.isVectorNode && c.polyCurve && c.polyCurve.at(0) && c.polyCurve.at(0).isClosed);
  }

  if (sources.length === 0) {
    for (const child of children) {
      if (!isResultNode(child) && (!path || !isSameNode(child, path))) {
        sources.push(child);
      }
    }
  }

  return { path, sources, results };
}

function readGroupValues(group) {
  try {
    if (group.tagInterface && group.tagInterface.hasKey(TAG_KEY)) {
      const parsed = JSON.parse(group.tagInterface.getValueForKey(TAG_KEY));
      return sanitizeValues(parsed);
    }
  } catch (e) {}
  return sanitizeValues(DEFAULT_VALUES);
}

function sanitizeValues(v) {
  const x = v.xfm || {};
  const r = v.rnd || {};
  return {
    spacing: clamp(typeof v.spacing === 'number' ? v.spacing : DEFAULT_VALUES.spacing, 5, 5000),
    gridType: clamp(typeof v.gridType === 'number' ? v.gridType : DEFAULT_VALUES.gridType, 0, 5),
    margin: clamp(typeof v.margin === 'number' ? v.margin : DEFAULT_VALUES.margin, -1000, 2000),
    scaleBase: clamp(typeof v.scaleBase === 'number' ? v.scaleBase : DEFAULT_VALUES.scaleBase, 1, 1000),
    globalRot: clamp(typeof v.globalRot === 'number' ? v.globalRot : DEFAULT_VALUES.globalRot, -3600, 3600),
    adoptDimensions: v.adoptDimensions !== undefined ? !!v.adoptDimensions : DEFAULT_VALUES.adoptDimensions,
    dimensionMode: clamp(typeof v.dimensionMode === 'number' ? v.dimensionMode : DEFAULT_VALUES.dimensionMode, 0, 1),
    xfm: {
      mode: clamp(typeof x.mode === 'number' ? x.mode : DEFAULT_VALUES.xfm.mode, 0, 2),
      scaleStart: clamp(typeof x.scaleStart === 'number' ? x.scaleStart : DEFAULT_VALUES.xfm.scaleStart, 1, 1000),
      scaleEnd: clamp(typeof x.scaleEnd === 'number' ? x.scaleEnd : DEFAULT_VALUES.xfm.scaleEnd, 1, 1000),
      scaleCurve: clamp(typeof x.scaleCurve === 'number' ? x.scaleCurve : DEFAULT_VALUES.xfm.scaleCurve, -100, 100),
      rotStart: clamp(typeof x.rotStart === 'number' ? x.rotStart : DEFAULT_VALUES.xfm.rotStart, -3600, 3600),
      rotEnd: clamp(typeof x.rotEnd === 'number' ? x.rotEnd : DEFAULT_VALUES.xfm.rotEnd, -3600, 3600),
      scatStart: clamp(typeof x.scatStart === 'number' ? x.scatStart : DEFAULT_VALUES.xfm.scatStart, 0, 100),
      scatEnd: clamp(typeof x.scatEnd === 'number' ? x.scatEnd : DEFAULT_VALUES.xfm.scatEnd, 0, 100)
    },
    rnd: {
      enabled: !!r.enabled,
      shuffleSeed: clamp(Math.round(typeof r.shuffleSeed === 'number' ? r.shuffleSeed : 0), 0, 99999),
      jitterSeed: clamp(Math.round(typeof r.jitterSeed === 'number' ? r.jitterSeed : 0), 0, 99999),
      jitterAmt: clamp(typeof r.jitterAmt === 'number' ? r.jitterAmt : 40, 1, 100),
      scatterSeed: clamp(Math.round(typeof r.scatterSeed === 'number' ? r.scatterSeed : 0), 0, 99999),
      scatterAmt: clamp(typeof r.scatterAmt === 'number' ? r.scatterAmt : 70, 1, 100),
      rotSeed: clamp(Math.round(typeof r.rotSeed === 'number' ? r.rotSeed : 0), 0, 99999),
      rotMaxDeg: clamp(typeof r.rotMaxDeg === 'number' ? r.rotMaxDeg : 180, 1, 360),
      sizeSeed: clamp(Math.round(typeof r.sizeSeed === 'number' ? r.sizeSeed : 0), 0, 99999),
      sizeAmt: clamp(typeof r.sizeAmt === 'number' ? r.sizeAmt : 30, 1, 100),
      zSeed: clamp(Math.round(typeof r.zSeed === 'number' ? r.zSeed : 0), 0, 99999)
    }
  };
}

function setContainerMetadata(document, group, params) {
  try {
    const sel = mkSel(group);
    document.executeCommand(
      DocumentCommand.createSetTagValueForKey(sel, TAG_KEY, JSON.stringify(params)),
      false
    );
    const pipeline = [{ id: 'fill_path', name: GROUP_PREFIX, params }];
    document.executeCommand(
      DocumentCommand.createSetTagValueForKey(sel, 'effectPipeline', JSON.stringify(pipeline)),
      false
    );
  } catch (e) {
    console.log('setContainerMetadata error: ' + e);
  }
}

// =============================================================================
// GEOMETRY & STYLE EXTRACTION FOR HIGH-FIDELITY LIVE PREVIEW
// =============================================================================

function getNodeStyle(node) {
  let brushFill = FillDescriptor.createNone();
  let lineStyle = LineStyleDescriptor.createDefault(0);
  let lineFill = FillDescriptor.createNone();
  let transparencyFill = FillDescriptor.createNone();
  let opacity = 1.0;
  let blendMode = null;

  try {
    if (node.visibilityInterface && typeof node.visibilityInterface.globalOpacity === 'number') {
      opacity = node.visibilityInterface.globalOpacity;
    }
  } catch (e) {}

  try {
    blendMode = (node.blendModeInterface && node.blendModeInterface.blendMode) || node.blendMode || null;
  } catch (e) {}

  try {
    if (node.lineStyleInterface) {
      const lsi = node.lineStyleInterface;
      const lsDesc = lsi.lineStyleDescriptor;
      const penFill = lsi.penFillDescriptor;
      const weight =
        lsDesc && lsDesc.lineStyle && typeof lsDesc.lineStyle.weight === 'number'
          ? lsDesc.lineStyle.weight
          : typeof lsi.lineWeight === 'number' ? lsi.lineWeight : 0;

      if (lsDesc) {
        lineStyle = lsDesc.clone();
      } else if (weight > 0) {
        lineStyle = LineStyleDescriptor.createDefault(weight);
      }

      if (penFill && !penFill.isNoFill) {
        lineFill = penFill.clone();
      }
    }
  } catch (e) {}

  try {
    if (node.brushFillInterface && node.brushFillInterface.currentDescriptor) {
      const bf = node.brushFillInterface.currentDescriptor;
      if (bf && !bf.isNoFill) brushFill = bf.clone();
    } else if (node.brushFillDescriptor && !node.brushFillDescriptor.isNoFill) {
      brushFill = node.brushFillDescriptor.clone();
    }
  } catch (e) {}

  try {
    if (node.transparencyInterface && node.transparencyInterface.fillDescriptor) {
      const tf = node.transparencyInterface.fillDescriptor;
      if (tf && !tf.isNoFill) transparencyFill = tf.clone();
    }
  } catch (e) {}

  return { brushFill, lineStyle, lineFill, transparencyFill, opacity, blendMode };
}

function extractLocalGeomEntriesFromNode(node, containerTransform) {
  const entries = [];
  if (!node) return entries;

  const children = getChildren(node);
  if (children.length > 0) {
    for (const child of children) {
      const sub = extractLocalGeomEntriesFromNode(child, containerTransform);
      for (const s of sub) entries.push(s);
    }
    if (entries.length > 0) return entries;
  }

  const localPc = getLocalPolyCurve(node, containerTransform);
  if (localPc) {
    entries.push({ polyCurve: localPc, style: getNodeStyle(node) });
    return entries;
  }

  return entries;
}

function clearPreviews(document) {
  try {
    document.executeCommand(DocumentCommand.createClearPreviews());
  } catch (e) {}
}

function doPreviewPolyCurves(document, targetNode, localPathPolygon, templateItems, params, adoptDimensions, containerTransform) {
  clearPreviews(document);
  if (!localPathPolygon || !localPathPolygon.length || !templateItems || !templateItems.length) return;

  const placements = calculatePlacements(localPathPolygon, templateItems, params, adoptDimensions);
  if (!placements.length) return;

  const rnd = params.rnd || {};
  let renderOrder = Array.from({ length: placements.length }, (_, i) => i);
  if (rnd.enabled && rnd.zSeed > 0) {
    renderOrder = shuffleArray(renderOrder, rnd.zSeed);
  }

  const addBuilder = AddChildNodesCommandBuilder.create();
  if (targetNode) {
    addBuilder.setInsertionTargetSelection(mkSel(targetNode));
    addBuilder.setInsertionMode(InsertionMode.Top);
  }

  for (let orderIdx = 0; orderIdx < renderOrder.length; orderIdx++) {
    const plIdx = renderOrder[orderIdx];
    const pl = placements[plIdx];
    const item = templateItems[pl.templateIndex];
    if (!item) continue;

    const localXform = buildPlacementTransform(item.localCenter, pl);
    const previewXform = containerTransform ? containerTransform.multiply(localXform) : localXform;

    for (const geom of item.localGeomEntries) {
      if (!geom || !geom.polyCurve) continue;
      const pc = geom.polyCurve.clone();
      try { pc.transform(previewXform); } catch (e) {}

      const s = geom.style;
      const def = PolyCurveNodeDefinition.create(
        pc,
        s.brushFill || FillDescriptor.createNone(),
        s.lineStyle || LineStyleDescriptor.createDefault(0),
        s.lineFill || FillDescriptor.createNone(),
        s.transparencyFill || FillDescriptor.createNone()
      );
      addBuilder.addNode(def);
    }
  }

  const cmd = addBuilder.createCommand(false, NodeChildType.Main);
  if (cmd) {
    document.executeCommand(cmd, true);
  }
}

// =============================================================================
// APPLY WORKFLOW (Permanent Scaled Source Placement & Deterministic Z-Order)
// =============================================================================

function doApply(document, pathNode, templateNodes, templateItems, localPathPolygon, params, existingGroup, oldContainerSources, adoptDimensions, containerTransform) {
  let targetGroup = existingGroup;
  const placements = calculatePlacements(localPathPolygon, templateItems, params, adoptDimensions);
  if (!placements.length) {
    throw new Error('No points generated inside the path. Try reducing spacing or margin.');
  }

  const rnd = params.rnd || {};
  let renderOrder = Array.from({ length: placements.length }, (_, i) => i);
  if (rnd.enabled && rnd.zSeed > 0) {
    renderOrder = shuffleArray(renderOrder, rnd.zSeed);
  }

  const containerInv = (containerTransform && containerTransform.inverted) ? containerTransform.inverted : null;

  // ---------------------------------------------------------------------------
  // STEP 1: DUPLICATE TEMPLATE OBJECTS (1:1 Conjugate Spread Matching in renderOrder)
  // ---------------------------------------------------------------------------
  const dupCb = CompoundCommandBuilder.create();
  for (let orderIdx = 0; orderIdx < renderOrder.length; orderIdx++) {
    const plIdx = renderOrder[orderIdx];
    const pl = placements[plIdx];
    const tN = templateNodes[pl.templateIndex];
    const item = templateItems[pl.templateIndex];

    const localXform = buildPlacementTransform(item.localCenter, pl);

    const spreadTransform = (containerTransform && containerInv)
      ? containerTransform.multiply(localXform).multiply(containerInv)
      : localXform;

    dupCb.addCommand(DocumentCommand.createTransform(mkSel(tN), spreadTransform, { duplicateNodes: true }), false);
  }

  const dupCmd = dupCb.createCommand();
  document.executeCommand(dupCmd);
  const dupNodes = Array.from(dupCmd.newNodes || []);

  if (dupNodes.length === 0) {
    throw new Error('Failed to generate duplicate objects.');
  }

  // ---------------------------------------------------------------------------
  // STEP 2: CONTAINER REORGANIZATION & UNCONDITIONAL SEQUENTIAL Z-ORDER REBUILD
  // ---------------------------------------------------------------------------
  if (existingGroup) {
    const oldResults = getChildren(existingGroup).filter(isResultNode);
    const updateCb = CompoundCommandBuilder.create();

    // 2a. Delete old result items
    if (oldResults.length > 0) {
      updateCb.addCommand(DocumentCommand.createDeleteSelection(Selection.create(document, oldResults, true)));
    }

    updateCb.addCommand(DocumentCommand.createSetDescription(mkSel(existingGroup), GROUP_PREFIX));

    // 2b. Ensure Source Path is hidden
    updateCb.addCommand(DocumentCommand.createSetDescription(mkSel(pathNode), PATH_PREFIX));
    updateCb.addCommand(DocumentCommand.createSetVisibility(mkSel(pathNode), false));

    // 2c. Template Sources replacement
    const anyTemplateExternal = templateNodes.some(t => !isChildOf(t, existingGroup));
    if (anyTemplateExternal && oldContainerSources && oldContainerSources.length > 0) {
      for (const oldSrc of oldContainerSources) {
        if (!templateNodes.some(t => isSameNode(t, oldSrc))) {
          updateCb.addCommand(DocumentCommand.createDeleteSelection(mkSel(oldSrc)));
        }
      }
    }

    for (let i = 0; i < templateNodes.length; i++) {
      const src = templateNodes[i];
      const item = templateItems[i];
      updateCb.addCommand(DocumentCommand.createSetDescription(mkSel(src), `${SOURCE_PREFIX} ${i + 1}`));

      if (!isChildOf(src, existingGroup)) {
        // Permanently scale external source node (curve or group) to match adopted dimensions before moving inside container
        if (adoptDimensions && item && item.dimScale && (Math.abs(item.dimScale.sx - 1.0) > 0.0001 || Math.abs(item.dimScale.sy - 1.0) > 0.0001)) {
          const localScaleXf = Transform.createTranslate(item.localCenter.x, item.localCenter.y)
            .multiply(Transform.createScale(item.dimScale.sx, item.dimScale.sy))
            .multiply(Transform.createTranslate(-item.localCenter.x, -item.localCenter.y));
          const spreadScaleXf = (containerTransform && containerInv)
            ? containerTransform.multiply(localScaleXf).multiply(containerInv)
            : localScaleXf;
          updateCb.addCommand(DocumentCommand.createTransform(mkSel(src), spreadScaleXf, { duplicateNodes: false }));
        }
        updateCb.addCommand(DocumentCommand.createMoveNodes(mkSel(src), existingGroup, NodeMoveType.Inside, NodeChildType.Main));
      }
      updateCb.addCommand(DocumentCommand.createSetVisibility(mkSel(src), false));
    }

    // 2d. Move duplicate results into container UNCONDITIONALLY in exact sequential Z-order
    if (dupNodes.length > 0) {
      updateCb.addCommand(DocumentCommand.createMoveNodes(mkSel(dupNodes[0]), existingGroup, NodeMoveType.Inside, NodeChildType.Main));
      updateCb.addCommand(DocumentCommand.createSetVisibility(mkSel(dupNodes[0]), true));
      updateCb.addCommand(DocumentCommand.createSetDescription(mkSel(dupNodes[0]), `${RESULT_PREFIX} 1`));

      for (let i = 1; i < dupNodes.length; i++) {
        const node = dupNodes[i];
        updateCb.addCommand(DocumentCommand.createMoveNodes(mkSel(node), dupNodes[i - 1], NodeMoveType.After, NodeChildType.Main));
        updateCb.addCommand(DocumentCommand.createSetVisibility(mkSel(node), true));
        updateCb.addCommand(DocumentCommand.createSetDescription(mkSel(node), `${RESULT_PREFIX} ${i + 1}`));
      }
    }

    document.executeCommand(updateCb.createCommand());
    setContainerMetadata(document, existingGroup, params);

  } else {
    // Fresh container creation
    const gBuilder = AddChildNodesCommandBuilder.create();
    gBuilder.setInsertionTargetSelection(mkSel(pathNode));
    gBuilder.setInsertionMode(InsertionMode.Top);
    gBuilder.addContainerNode(ContainerNodeDefinition.create(GROUP_PREFIX));
    const gCmd = gBuilder.createCommand(false, NodeChildType.Main);
    document.executeCommand(gCmd);
    targetGroup = gCmd.newNodes[0];

    const prepCompound = CompoundCommandBuilder.create();

    // Move boundary path inside container as hidden Source Path
    prepCompound.addCommand(DocumentCommand.createSetDescription(mkSel(pathNode), PATH_PREFIX));
    prepCompound.addCommand(DocumentCommand.createMoveNodes(mkSel(pathNode), targetGroup, NodeMoveType.Inside, NodeChildType.Main));
    prepCompound.addCommand(DocumentCommand.createSetVisibility(mkSel(pathNode), false));

    // Move template objects inside container as hidden Sources
    for (let i = 0; i < templateNodes.length; i++) {
      const src = templateNodes[i];
      prepCompound.addCommand(DocumentCommand.createSetDescription(mkSel(src), `${SOURCE_PREFIX} ${i + 1}`));
      prepCompound.addCommand(DocumentCommand.createMoveNodes(mkSel(src), targetGroup, NodeMoveType.Inside, NodeChildType.Main));
      prepCompound.addCommand(DocumentCommand.createSetVisibility(mkSel(src), false));
    }

    // Move duplicate results inside container sequentially
    if (dupNodes.length > 0) {
      prepCompound.addCommand(DocumentCommand.createMoveNodes(mkSel(dupNodes[0]), targetGroup, NodeMoveType.Inside, NodeChildType.Main));
      prepCompound.addCommand(DocumentCommand.createSetVisibility(mkSel(dupNodes[0]), true));
      prepCompound.addCommand(DocumentCommand.createSetDescription(mkSel(dupNodes[0]), `${RESULT_PREFIX} 1`));

      for (let i = 1; i < dupNodes.length; i++) {
        const node = dupNodes[i];
        prepCompound.addCommand(DocumentCommand.createMoveNodes(mkSel(node), dupNodes[i - 1], NodeMoveType.After, NodeChildType.Main));
        prepCompound.addCommand(DocumentCommand.createSetVisibility(mkSel(node), true));
        prepCompound.addCommand(DocumentCommand.createSetDescription(mkSel(node), `${RESULT_PREFIX} ${i + 1}`));
      }
    }

    document.executeCommand(prepCompound.createCommand());
    setContainerMetadata(document, targetGroup, params);
  }

  // ---------------------------------------------------------------------------
  // STEP 3: RED TAG RESULTS
  // ---------------------------------------------------------------------------
  for (const node of dupNodes) {
    tagNodeRed(node);
  }

  try {
    document.selection = mkSel(targetGroup);
  } catch (e) {}
}

// =============================================================================
// MAIN WORKFLOW & UI DIALOG
// =============================================================================

function showError(msg) {
  const d = Dialog.create(SCRIPT_TITLE);
  d.addColumn().addGroup('Notice').addStaticText('', msg);
  d.show();
}

function getSelectedNodes(sel) {
  const nodes = [];
  if (!sel) return nodes;
  try {
    if (sel.nodes) {
      for (const n of sel.nodes) if (n) nodes.push(n);
      if (nodes.length) return nodes;
    }
  } catch (e) {}
  try {
    const l = sel.length;
    for (let i = 0; i < l; i++) {
      const it = sel.at(i);
      if (it && it.node) nodes.push(it.node);
      else if (it) nodes.push(it);
    }
  } catch (e) {}
  return nodes;
}

function getTopLevelNodes(nodes) {
  return nodes.filter(n => {
    let p = n.parent;
    while (p) {
      if (nodes.some(s => isSameNode(s, p))) return false;
      p = p.parent;
    }
    return true;
  });
}

function runFillPath(document, rawSelection) {
  const topNodes = getTopLevelNodes(rawSelection);
  if (!topNodes.length) {
    showError('Please select at least 1 closed path and 1 template object, or an existing Fill Path container.');
    return;
  }

  let existingGroup = null;
  let externalNodes = [];

  // Identify container and external nodes
  for (const node of topNodes) {
    if (!existingGroup && isFillPathContainer(node)) {
      existingGroup = node;
    } else {
      const pGrp = getFillPathContainerOf(node);
      if (pGrp && !existingGroup) {
        existingGroup = pGrp;
      } else if (!pGrp || (existingGroup && !isChildOf(node, existingGroup) && !isSameNode(node, existingGroup))) {
        externalNodes.push(node);
      }
    }
  }

  const containerTransform = existingGroup ? getContainerTransform(existingGroup) : null;
  const containerScaleInfo = detectContainerScale(existingGroup);

  let activePath = null;
  let activeTemplates = [];
  let oldContainerSources = [];
  const isReplacingSources = !!(existingGroup && externalNodes.length > 0);

  if (existingGroup) {
    const extracted = extractContainerSourcesAndPath(existingGroup);
    activePath = extracted.path;
    oldContainerSources = extracted.sources;

    if (externalNodes.length > 0) {
      // Container + External objects: new external objects replace the template sources
      activeTemplates = externalNodes;
    } else {
      // Container only: edit settings on existing sources
      activeTemplates = extracted.sources;
    }
  } else {
    // Raw canvas selection (No container)
    if (topNodes.length < 2) {
      showError('Please select at least 1 closed boundary path and 1 template object.');
      return;
    }
    const pathIdx = autoDetectPathIndex(topNodes);
    activePath = topNodes[pathIdx];
    activeTemplates = topNodes.filter((_, i) => i !== pathIdx);
  }

  if (!activePath || !activeTemplates.length) {
    showError('Could not determine boundary path and template objects from selection.');
    return;
  }

  let initialValues = existingGroup ? readGroupValues(existingGroup) : sanitizeValues(DEFAULT_VALUES);

  // Auto-detect container resize: if container was resized, auto-switch default mode to Stretch (1)
  if (existingGroup && (containerScaleInfo.isNonUniform || containerScaleInfo.isResized)) {
    initialValues.dimensionMode = 1; // Stretch (Fit W & H)
  }

  // Pre-calculate local centers and dimension scaling in local container space (universal for curves and groups)
  function buildTemplateItems(dimMode) {
    return activeTemplates.map((node, i) => {
      const extracted = getNodeLocalCenterAndDim(node, containerTransform);
      let dimScale = { sx: 1.0, sy: 1.0 };

      if (isReplacingSources && oldContainerSources.length > 0) {
        const targetOldSrc = oldContainerSources[i % oldContainerSources.length];
        const oldExtracted = getNodeLocalCenterAndDim(targetOldSrc, containerTransform);

        if (oldExtracted.dim.w > 0.001 && oldExtracted.dim.h > 0.001 && extracted.dim.w > 0.001 && extracted.dim.h > 0.001) {
          if (dimMode === 1) {
            // Stretch mode (Fit W & H)
            dimScale = {
              sx: oldExtracted.dim.w / extracted.dim.w,
              sy: oldExtracted.dim.h / extracted.dim.h
            };
          } else {
            // Proportional mode (Keep Aspect Ratio)
            const s = Math.max(oldExtracted.dim.w, oldExtracted.dim.h) / Math.max(extracted.dim.w, extracted.dim.h);
            dimScale = { sx: s, sy: s };
          }
        }
      }

      return {
        node,
        localCenter: extracted.center,
        localDim: extracted.dim,
        dimScale,
        localGeomEntries: extractLocalGeomEntriesFromNode(node, containerTransform)
      };
    });
  }

  let templateItems = buildTemplateItems(initialValues.dimensionMode);

  // Hide old results in container and external objects during preview
  let oldResultsToHide = [];
  if (existingGroup) {
    oldResultsToHide = getChildren(existingGroup).filter(isResultNode);
    if (oldResultsToHide.length > 0) {
      const hideOldCb = CompoundCommandBuilder.create();
      for (const res of oldResultsToHide) {
        hideOldCb.addCommand(DocumentCommand.createSetVisibility(mkSel(res), false));
      }
      document.executeCommand(hideOldCb.createCommand());
    }
  }

  if (externalNodes.length > 0) {
    const hideExtCb = CompoundCommandBuilder.create();
    for (const ext of externalNodes) {
      hideExtCb.addCommand(DocumentCommand.createSetVisibility(mkSel(ext), true));
    }
    document.executeCommand(hideExtCb.createCommand());
  } else if (!existingGroup) {
    const hidePrimariesCb = CompoundCommandBuilder.create();
    for (const t of activeTemplates) {
      hidePrimariesCb.addCommand(DocumentCommand.createSetVisibility(mkSel(t), false));
    }
    document.executeCommand(hidePrimariesCb.createCommand());
  }

  // ---------------------------------------------------------------------------
  // DIALOG UI
  // ---------------------------------------------------------------------------
  const dlg = Dialog.create(SCRIPT_TITLE);
  dlg.initialWidth = 760;

  const col1 = dlg.addColumn();

  let adoptDimSwitch = null;
  let dimModeCombo = null;

  if (isReplacingSources) {
    const sG = col1.addGroup('Source Dimension Compensation');
    adoptDimSwitch = sG.addSwitch('Adopt old source dimensions', initialValues.adoptDimensions);
    adoptDimSwitch.isFullWidth = true;
    dimModeCombo = sG.addComboBox('Scaling mode', ['Proportional (Keep Aspect)', 'Stretch (Fit W & H)'], initialValues.dimensionMode);
  }

  const gG = col1.addGroup('Grid & Placement');
  const gtC = gG.addComboBox('Grid type', ['Rectangular', 'Hexagonal', 'Circular', 'Diamond', 'Sunflower', 'Radial'], initialValues.gridType);
  const spC = gG.addUnitValueEditor('Spacing', UnitType.Number, UnitType.Number, initialValues.spacing, 5, 1000);
  spC.precision = 1;
  spC.showPopupSlider = true;
  const mgC = gG.addUnitValueEditor('Margin from edge', UnitType.Number, UnitType.Number, initialValues.margin, -200, 500);
  mgC.precision = 1;
  mgC.showPopupSlider = true;
  const scC = gG.addUnitValueEditor('Object scale', UnitType.Percentage, UnitType.Percentage, initialValues.scaleBase, 5, 500);
  scC.precision = 1;
  scC.showPopupSlider = true;
  const grC = gG.addUnitValueEditor('Object rotation', UnitType.Degree, UnitType.Degree, initialValues.globalRot, -360, 360);
  grC.precision = 1;
  grC.showPopupSlider = true;

  const xG = col1.addGroup('Transform Progression');
  const xmC = xG.addComboBox('Mode', ['Circular (Radial)', 'Rect Up / Down', 'Rect Left / Right'], initialValues.xfm.mode);
  const xssC = xG.addUnitValueEditor('Scale start', UnitType.Percentage, UnitType.Percentage, initialValues.xfm.scaleStart, 1, 1000);
  xssC.precision = 1;
  xssC.showPopupSlider = true;
  const xseC = xG.addUnitValueEditor('Scale end', UnitType.Percentage, UnitType.Percentage, initialValues.xfm.scaleEnd, 1, 1000);
  xseC.precision = 1;
  xseC.showPopupSlider = true;
  const xscvC = xG.addUnitValueEditor('  Scale curve', UnitType.Number, UnitType.Number, initialValues.xfm.scaleCurve, -100, 100);
  xscvC.precision = 0;
  xscvC.showPopupSlider = true;
  const xrsC = xG.addUnitValueEditor('Rotation start', UnitType.Degree, UnitType.Degree, initialValues.xfm.rotStart, -3600, 3600);
  xrsC.precision = 1;
  const xreC = xG.addUnitValueEditor('Rotation end', UnitType.Degree, UnitType.Degree, initialValues.xfm.rotEnd, -3600, 3600);
  xreC.precision = 1;
  const xscsC = xG.addUnitValueEditor('Scatter start', UnitType.Percentage, UnitType.Percentage, initialValues.xfm.scatStart, 0, 100);
  xscsC.precision = 0;
  xscsC.showPopupSlider = true;
  const xsceC = xG.addUnitValueEditor('Scatter end', UnitType.Percentage, UnitType.Percentage, initialValues.xfm.scatEnd, 0, 100);
  xsceC.precision = 0;
  xsceC.showPopupSlider = true;

  const col2 = dlg.addColumn();

  const rG = col2.addGroup('Randomize (Seed 0 = Off)');
  const rnC = rG.addSwitch('Enable randomize', initialValues.rnd.enabled);
  const shC = rG.addUnitValueEditor('Shuffle seed', UnitType.Number, UnitType.Number, initialValues.rnd.shuffleSeed, 0, 99999);
  shC.precision = 0;
  const jkC = rG.addUnitValueEditor('Position jitter seed', UnitType.Number, UnitType.Number, initialValues.rnd.jitterSeed, 0, 99999);
  jkC.precision = 0;
  const jaC = rG.addUnitValueEditor('Jitter amount', UnitType.Percentage, UnitType.Percentage, initialValues.rnd.jitterAmt, 1, 100);
  jaC.precision = 0;
  jaC.showPopupSlider = true;
  const ssC = rG.addUnitValueEditor('Scatter seed', UnitType.Number, UnitType.Number, initialValues.rnd.scatterSeed, 0, 99999);
  ssC.precision = 0;
  const saC = rG.addUnitValueEditor('Scatter density', UnitType.Percentage, UnitType.Percentage, initialValues.rnd.scatterAmt, 1, 100);
  saC.precision = 0;
  saC.showPopupSlider = true;
  const rsC = rG.addUnitValueEditor('Rotation seed', UnitType.Number, UnitType.Number, initialValues.rnd.rotSeed, 0, 99999);
  rsC.precision = 0;
  const rmC = rG.addUnitValueEditor('Rotation max angle', UnitType.Degree, UnitType.Degree, initialValues.rnd.rotMaxDeg, 1, 360);
  rmC.precision = 0;
  rmC.showPopupSlider = true;
  const szC = rG.addUnitValueEditor('Size seed', UnitType.Number, UnitType.Number, initialValues.rnd.sizeSeed, 0, 99999);
  szC.precision = 0;
  const smC = rG.addUnitValueEditor('Size amount', UnitType.Percentage, UnitType.Percentage, initialValues.rnd.sizeAmt, 1, 100);
  smC.precision = 0;
  smC.showPopupSlider = true;
  const zC = rG.addUnitValueEditor('Z-order seed', UnitType.Number, UnitType.Number, initialValues.rnd.zSeed, 0, 99999);
  zC.precision = 0;

  const noteGrp = col2.addGroup('');
  const txt1 = noteGrp.addStaticText(null, existingGroup ? '✨ Editing Fill Path in Stack ✨' : '✨ Non-destructive Procedural Effect ✨').setIsFullWidth(true);
  txt1.textHorizontalAlignment = HorizontalAlignment.Centre;

  const txt2 = noteGrp.addStaticText(null, 'Run this script again on the container to edit parameters, or run other effect scripts to stack effects.').setIsFullWidth(true);
  txt2.textHorizontalAlignment = HorizontalAlignment.Centre;

  const randomControls = [shC, jkC, jaC, ssC, saC, rsC, rmC, szC, smC, zC];
  function updateRandomControls() {
    for (const ctrl of randomControls) ctrl.isEnabled = rnC.value;
  }

  function readValues() {
    return sanitizeValues({
      spacing: spC.value,
      gridType: gtC.selectedIndex,
      margin: mgC.value,
      scaleBase: scC.value,
      globalRot: grC.value,
      adoptDimensions: adoptDimSwitch ? adoptDimSwitch.value : true,
      dimensionMode: dimModeCombo ? dimModeCombo.selectedIndex : initialValues.dimensionMode,
      xfm: {
        mode: xmC.selectedIndex,
        scaleStart: xssC.value,
        scaleEnd: xseC.value,
        scaleCurve: xscvC.value,
        rotStart: xrsC.value,
        rotEnd: xreC.value,
        scatStart: xscsC.value,
        scatEnd: xsceC.value
      },
      rnd: {
        enabled: rnC.value,
        shuffleSeed: shC.value,
        jitterSeed: jkC.value,
        jitterAmt: jaC.value,
        scatterSeed: ssC.value,
        scatterAmt: saC.value,
        rotSeed: rsC.value,
        rotMaxDeg: rmC.value,
        sizeSeed: szC.value,
        sizeAmt: smC.value,
        zSeed: zC.value
      }
    });
  }

  // Debounced Live Preview
  let inPreview = false, previewTimer = null;
  function applyPreview() {
    const curValues = readValues();
    templateItems = buildTemplateItems(curValues.dimensionMode);

    if (previewTimer) previewTimer.cancel();
    previewTimer = setTimeout(60, (err) => {
      if (err || inPreview) return;
      inPreview = true;
      try {
        if (!activePath || !templateItems.length) {
          clearPreviews(document);
          return;
        }

        const localBez = getLocalBeziers(activePath, containerTransform);
        if (!localBez || !localBez.length) {
          clearPreviews(document);
          return;
        }
        const localPathPolygon = sampleBezierPolygon(localBez, 60);
        if (localPathPolygon.length < 3) {
          clearPreviews(document);
          return;
        }

        const previewTargetNode = existingGroup || activePath;
        const adoptDim = adoptDimSwitch ? adoptDimSwitch.value : true;
        doPreviewPolyCurves(document, previewTargetNode, localPathPolygon, templateItems, curValues, adoptDim, containerTransform);
      } catch (e) {
        console.log('applyPreview error: ' + e);
        clearPreviews(document);
      } finally {
        inPreview = false;
      }
    });
  }

  const previewControls = [
    gtC, spC, mgC, scC, grC,
    xmC, xssC, xseC, xscvC, xrsC, xreC, xscsC, xsceC,
    shC, jkC, jaC, ssC, saC, rsC, rmC, szC, smC, zC
  ];
  if (adoptDimSwitch) adoptDimSwitch.onValueChangedHandler = applyPreview;
  if (dimModeCombo) dimModeCombo.onValueChangedHandler = applyPreview;
  for (const ctrl of previewControls) ctrl.onValueChangedHandler = applyPreview;
  rnC.onValueChangedHandler = function() {
    updateRandomControls();
    applyPreview();
  };
  dlg.onControlValueChangedHandler = applyPreview;

  updateRandomControls();
  applyPreview();

  const result = dlg.show();
  if (previewTimer) previewTimer.cancel();
  clearPreviews(document);

  if (result.value === DialogResult.Ok.value) {
    const finalValues = readValues();
    const adoptDim = adoptDimSwitch ? adoptDimSwitch.value : true;
    templateItems = buildTemplateItems(finalValues.dimensionMode);

    try {
      const localBez = getLocalBeziers(activePath, containerTransform);
      const localPathPolygon = sampleBezierPolygon(localBez, 60);

      doApply(
        document,
        activePath,
        activeTemplates,
        templateItems,
        localPathPolygon,
        finalValues,
        existingGroup,
        oldContainerSources,
        adoptDim,
        containerTransform
      );
    } catch (e) {
      showError('Fill failed:\n' + e.message);
    }
  } else {
    // Restore visibility if cancelled
    const restoreCb = CompoundCommandBuilder.create();
    if (existingGroup) {
      for (const res of oldResultsToHide) {
        restoreCb.addCommand(DocumentCommand.createSetVisibility(mkSel(res), true));
      }
    }
    if (externalNodes.length > 0) {
      for (const ext of externalNodes) {
        restoreCb.addCommand(DocumentCommand.createSetVisibility(mkSel(ext), true));
      }
    } else if (!existingGroup) {
      for (const t of activeTemplates) {
        restoreCb.addCommand(DocumentCommand.createSetVisibility(mkSel(t), true));
      }
    }
    document.executeCommand(restoreCb.createCommand());
  }
}

// =============================================================================
// ENTRY POINT
// =============================================================================

function main() {
  if (!doc) {
    showError('No document open.');
    return;
  }
  const selNodes = getSelectedNodes(doc.selection);
  if (!selNodes.length) {
    showError('Please select at least 1 closed path and 1 template object, or an existing Fill Path container.');
    return;
  }
  runFillPath(doc, selNodes);
}

main();
