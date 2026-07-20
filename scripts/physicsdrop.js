// Physics Drop — a physics simulator for Affinity.
// v1.1: replay scrubber. When the sim finishes, drag the Frame slider to replay
// the drop in realtime on canvas. OK keeps the frame you're viewing; Cancel
// keeps the settled result. Optional 30fps PNG/JPEG image sequence export —
// the export runs from the start of the drop up to the frame you are viewing.
const { app } = require('/application');
const { Transform, Polygon } = require('/geometry');
const { Selection } = require('/selections');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
const { setInterval, Timer } = require('/timers');
const { Dialog, DialogResult, UnitType } = require('/dialog');
const { NodeRenderingEngine, RasterFormat } = require('/rasterobject');
const { PixelReaderRGBA8 } = require('/pixelaccessor');
const { FileExportOptions, FileExportArea } = require('/document');
const fsys = require('/fs');

const WALL_RE = /^(wall|floor|ramp|static)/i;

const doc = app.documents.current;
if (!doc) { app.alert('Open a document first.'); }
else {
  const selNodes = [...doc.selection.nodes];
  if (selNodes.length === 0) {
    app.alert('Select at least one object to drop.');
  } else {
    const ext = doc.currentSpread.getSpreadExtents();

    const dlg = Dialog.create('Physics Drop');
    dlg.initialWidth = 480;
    const col = dlg.addColumn();
    const grp = col.addGroup('Simulation');
    const gravityCtl = grp.addUnitValueEditor('Gravity', UnitType.Number, UnitType.Number, 3000, 200, 10000);
    gravityCtl.setShowPopupSlider(true); gravityCtl.precision = 0;
    const angleCtl = grp.addUnitValueEditor('Angle (0=down 90=right)', UnitType.Number, UnitType.Number, 0, 0, 360);
    angleCtl.setShowPopupSlider(true); angleCtl.precision = 0;
    const bounceCtl = grp.addUnitValueEditor('Bounciness %', UnitType.Number, UnitType.Number, 45, 0, 95);
    bounceCtl.setShowPopupSlider(true); bounceCtl.precision = 0;
    const durCtl = grp.addUnitValueEditor('Max duration (s)', UnitType.Number, UnitType.Number, 5, 1, 30);
    durCtl.setShowPopupSlider(true); durCtl.precision = 0;
    const exportCtl = grp.addCheckBox('Export image sequence when settled', false);

    const help = col.addGroup('How to use');
    help.addStaticText('', 'Select objects and run. Convert text to curves first.').setIsFullWidth(true);
    help.addStaticText('', 'Name a line or shape "wall", "floor" or "ramp" to make it solid — convert shapes to curves and objects will follow their true outline, including spirals and containers.').setIsFullWidth(true);
    help.addStaticText('', 'When the sim settles a Finished dialog appears: drag the Frame slider to replay the drop on canvas. OK keeps the frame you are viewing, Cancel keeps the settled result.').setIsFullWidth(true);
    help.addStaticText('', 'Exporting: tick the box above to also save the drop as a 30fps PNG or JPEG image sequence in a PhysicsDrop folder on your Desktop, from the start of the drop up to the frame you are viewing, ready to import into DaVinci Resolve or similar as an image sequence at 30fps.').setIsFullWidth(true);
    help.addStaticText('', ' ').setIsFullWidth(true);

    const result = dlg.runModal();
    if (result?.value === DialogResult.Ok.value) {
      const WANT_EXPORT = !!exportCtl.value;
      const GRAV = Math.max(200, gravityCtl.value || 3000);
      const rad = ((angleCtl.value ?? 0) % 360) * Math.PI / 180;
      const GUX = Math.sin(rad), GUY = Math.cos(rad);
      const GX = GRAV * GUX, GY = GRAV * GUY;
      const REST = Math.min(0.95, Math.max(0, (bounceCtl.value ?? 45) / 100));
      const REST_THRESHOLD = 150;
      const MARGIN = 60;
      const FLOOR = ext.y + ext.height - MARGIN;
      const CEIL = ext.y + MARGIN;
      const LEFT = ext.x + MARGIN, RIGHT = ext.x + ext.width - MARGIN;
      const MU = 0.4, SLOP = 1.5;
      const SEG_CAP = 1600;

      const PLANES = [
        { qx: 0, qy: FLOOR, nx: 0, ny: -1 },
        { qx: 0, qy: CEIL,  nx: 0, ny: 1 },
        { qx: LEFT, qy: 0,  nx: 1, ny: 0 },
        { qx: RIGHT, qy: 0, nx: -1, ny: 0 },
      ];

      let seed = Date.now() & 0x7fffffff;
      const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

      let simNodes = selNodes;
      if (selNodes.length === 1 && /GroupNode/.test(String(selNodes[0])) && selNodes[0].children) {
        simNodes = [...selNodes[0].children];
      }
      simNodes = simNodes.filter(n => !WALL_RE.test(String(n.description ?? '')));

      const wallNodes = [];
      (function findWalls(parent, depth) {
        if (!parent.children) return;
        for (const c of parent.children) {
          if (WALL_RE.test(String(c.description ?? ''))) wallNodes.push(c);
          else if (depth < 3 && c.children) findWalls(c, depth + 1);
        }
      })(doc.currentSpread, 0);

      doc.executeCommand(DocumentCommand.createSetSelection(Selection.createEmpty(doc)), false);

      function worldMatrix(n) {
        let m = n.transformInterface.transform.data;
        let c = [m[0], m[1], m[2], m[3], m[4], m[5]];
        let p = n.parent;
        while (p && !/SpreadNode|DocumentNode/.test(String(p)) && p.transformInterface) {
          const P = p.transformInterface.transform.data;
          c = [
            P[0]*c[0] + P[1]*c[3],
            P[0]*c[1] + P[1]*c[4],
            P[0]*c[2] + P[1]*c[5] + P[2],
            P[3]*c[0] + P[4]*c[3],
            P[3]*c[1] + P[4]*c[4],
            P[3]*c[2] + P[4]*c[5] + P[5]
          ];
          p = p.parent;
        }
        return c;
      }

      function convexHull(pts) {
        const P = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        if (P.length <= 3) return P;
        const cross = (o, a, b) => (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0]);
        const lower = [];
        for (const p of P) {
          while (lower.length >= 2 && cross(lower[lower.length-2], lower[lower.length-1], p) <= 0) lower.pop();
          lower.push(p);
        }
        const upper = [];
        for (let i = P.length - 1; i >= 0; i--) {
          const p = P[i];
          while (upper.length >= 2 && cross(upper[upper.length-2], upper[upper.length-1], p) <= 0) upper.pop();
          upper.push(p);
        }
        lower.pop(); upper.pop();
        return lower.concat(upper);
      }

      function glyphHullOffsets(n, lcx, lcy, scale) {
        try {
          const pc = n.curvesInterface?.polyCurve;
          if (!pc || !pc.curveCount) return null;
          const pts = [];
          for (let i = 0; i < pc.curveCount; i++) {
            for (const p of pc.at(i).points) pts.push([p.x, p.y]);
          }
          if (pts.length < 3) return null;
          const hull = convexHull(pts);
          if (hull.length < 3) return null;
          return hull.map(([x, y]) => [(x - lcx) * scale, (y - lcy) * scale]);
        } catch (e) { return null; }
      }

      function imageHullOffsets(n, bb, lcx, lcy, scale) {
        try {
          let bm = null;
          if (typeof n.createCompatibleBitmap === 'function') {
            bm = n.createCompatibleBitmap(true);
          } else {
            const eng = NodeRenderingEngine.createDefault(n, RasterFormat.RGBA8);
            bm = eng.createCompatibleBitmap(true);
          }
          if (!bm || !bm.width || !bm.height) return null;
          const rd = PixelReaderRGBA8.create(bm);
          const GRID = 48;
          const pts = [];
          let transparent = 0, samples = 0;
          for (let gy = 0; gy <= GRID; gy++) {
            const py = Math.min(bm.height - 1, Math.round(gy * bm.height / GRID));
            for (let gx = 0; gx <= GRID; gx++) {
              const px = Math.min(bm.width - 1, Math.round(gx * bm.width / GRID));
              const p = rd.readPixel(px, py);
              const a = p.alpha ?? 255;
              samples++;
              if (a < 40) { transparent++; continue; }
              pts.push([
                bb.x + (px / bm.width) * bb.width,
                bb.y + (py / bm.height) * bb.height
              ]);
            }
          }
          rd.dispose();
          if (transparent < samples * 0.05) return null;
          if (pts.length < 3) return null;
          const hull = convexHull(pts);
          if (hull.length < 3) return null;
          return hull.map(([x, y]) => [(x - lcx) * scale, (y - lcy) * scale]);
        } catch (e) { return null; }
      }

      const segments = [];
      let segWarned = false;
      function pushSeg(seg) {
        if (!seg) return;
        if (segments.length >= SEG_CAP) {
          if (!segWarned) { console.log('static segment cap (' + SEG_CAP + ') reached — remaining path geometry skipped'); segWarned = true; }
          return;
        }
        segments.push(seg);
      }

      function readHalfStroke(n, scale) {
        try {
          const w = n.lineStyleInterface?.lineWeight;
          return (typeof w === 'number' && w > 0) ? (w * scale) / 2 : 0;
        } catch (e) { return 0; }
      }

      function finishSegment(E0, E1, halfW) {
        const dx = E1[0]-E0[0], dy = E1[1]-E0[1];
        const len = Math.hypot(dx, dy);
        if (len < 2) return null;
        const tx = dx/len, ty = dy/len;
        return { E0, E1, tx, ty, nx: -ty, ny: tx, len,
          halfW: halfW || 0,
          minX: Math.min(E0[0], E1[0]), maxX: Math.max(E0[0], E1[0]),
          minY: Math.min(E0[1], E1[1]), maxY: Math.max(E0[1], E1[1]) };
      }

      function makeSegment(n) {
        const m = worldMatrix(n);
        const scale = Math.hypot(m[0], m[3]) || 1;
        const halfW = readHalfStroke(n, scale);
        const W = (x, y) => [m[0]*x + m[1]*y + m[2], m[3]*x + m[4]*y + m[5]];
        try {
          const pc = n.curvesInterface?.polyCurve;
          if (pc && pc.curveCount === 1) {
            const c0 = pc.at(0);
            const distinct = [];
            for (const p of c0.points) {
              if (!distinct.some(q => Math.abs(q.x - p.x) < 0.1 && Math.abs(q.y - p.y) < 0.1)) distinct.push({x: p.x, y: p.y});
            }
            if (distinct.length === 2) {
              const E0 = W(distinct[0].x, distinct[0].y), E1 = W(distinct[1].x, distinct[1].y);
              return finishSegment(E0, E1, halfW);
            }
          }
        } catch (e) {}
        const bb = n.artboardBaseBox ?? n.shapeBoundingBox;
        if (!bb || !n.transformInterface) return null;
        const w = bb.width * scale, h = bb.height * scale;
        if (Math.min(w, h) >= 4 || Math.max(w, h) < 2) return null;
        const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
        let E0, E1;
        if (h > w) { E0 = W(cx, bb.y); E1 = W(cx, bb.y + bb.height); }
        else { E0 = W(bb.x, cy); E1 = W(bb.x + bb.width, cy); }
        return finishSegment(E0, E1, 0);
      }

      // flatten a static curve node into segments along its true drawn path
      function addStaticCurveSegments(n) {
        let added = 0;
        try {
          const pc = n.curvesInterface?.polyCurve;
          if (!pc || !pc.curveCount) return 0;
          const m = worldMatrix(n);
          const scale = Math.hypot(m[0], m[3]) || 1;
          const halfW = readHalfStroke(n, scale);
          const W = (x, y) => [m[0]*x + m[1]*y + m[2], m[3]*x + m[4]*y + m[5]];
          const tol = Math.min(5, Math.max(0.25, 2 / scale));
          for (let c = 0; c < pc.curveCount; c++) {
            const curve = pc.at(c);
            let poly = null;
            try { poly = new Polygon(curve.generatePolygon(tol)); } catch (e) { poly = null; }
            if (!poly || !(poly.pointCount >= 2)) continue;
            let worldLen = 0;
            try { worldLen = (curve.length || 0) * scale; } catch (e) {}
            const minSeg = Math.max(6, worldLen / 1200);
            const pts = [];
            const nP = poly.pointCount;
            for (let i = 0; i < nP; i++) {
              const p = poly.getPoint(i);
              pts.push(W(p.x, p.y));
            }
            const dec = [pts[0]];
            for (let i = 1; i < pts.length; i++) {
              const q = dec[dec.length - 1];
              if (Math.hypot(pts[i][0]-q[0], pts[i][1]-q[1]) >= minSeg) dec.push(pts[i]);
            }
            let closed = false;
            try { closed = curve.isClosed; } catch (e) {}
            if (closed && dec.length > 2) {
              const f = dec[0], l = dec[dec.length - 1];
              if (Math.hypot(f[0]-l[0], f[1]-l[1]) > 1) dec.push(f);
            }
            for (let i = 0; i + 1 < dec.length; i++) {
              const seg = finishSegment(dec[i], dec[i+1], halfW);
              if (seg) { pushSeg(seg); added++; }
            }
          }
        } catch (e) { return added; }
        return added;
      }

      function makeBody(n, isStatic) {
        let bb = n.artboardBaseBox ?? n.shapeBoundingBox;
        if (!bb && n.rasterWidth && n.rasterHeight) {
          bb = { x: 0, y: 0, width: n.rasterWidth, height: n.rasterHeight };
        }
        if (!bb || !n.transformInterface || !bb.width || !bb.height) return null;
        const m = worldMatrix(n);
        const lcx = bb.x + bb.width / 2, lcy = bb.y + bb.height / 2;
        const wx = m[0]*lcx + m[1]*lcy + m[2];
        const wy = m[3]*lcx + m[4]*lcy + m[5];
        const theta0 = Math.atan2(m[3], m[0]);
        const scale = Math.hypot(m[0], m[3]);
        const hw = (bb.width / 2) * scale, hh = (bb.height / 2) * scale;
        const isCircle = /Ellipse/.test(String(n.shape ?? ''));
        let hull = isCircle ? null : glyphHullOffsets(n, lcx, lcy, scale);
        if (!hull && !isCircle && /ImageNode|RasterNode/.test(String(n))) {
          hull = imageHullOffsets(n, bb, lcx, lcy, scale);
          if (hull) console.log('alpha silhouette hull (' + hull.length + ' pts):', String(n));
        }
        let r;
        if (isCircle) r = Math.max(hw, hh);
        else if (hull) r = Math.max(...hull.map(([x, y]) => Math.hypot(x, y)));
        else r = Math.hypot(hw, hh);
        const mass = Math.max(1, hw * hh * 4);
        const I = isCircle ? mass * r * r / 2 : mass * (hw * hw + hh * hh) / 3;
        const sel = Selection.createEmpty(doc); sel.addNode(n);
        return { sel, hw, hh, r, isCircle, hull, theta0,
          static: isStatic,
          invMass: isStatic ? 0 : 1 / mass,
          invI: isStatic ? 0 : 1 / I,
          ox: wx, oy: wy, cx: wx, cy: wy,
          vx: isStatic ? 0 : (rand() - 0.5) * 400, vy: 0,
          a: 0, va: isStatic ? 0 : (rand() - 0.5) * 3,
          asleep: isStatic, touchedSleeper: false, flatSupport: false,
          slowFrames: 0, stuckFrames: 0, maxPen: 0, segSide: [],
          ax: wx, ay: wy, aa: 0, stillFrames: 0 };
      }

      const bodies = [];
      const skipped = [];
      for (const n of wallNodes) {
        const seg = makeSegment(n);
        if (seg) { pushSeg(seg); continue; }
        const nSegs = addStaticCurveSegments(n);
        if (nSegs > 0) {
          console.log('static "' + String(n.description ?? '') + '": ' + nSegs + ' path segments');
          continue;
        }
        const b = makeBody(n, true);
        if (b) {
          bodies.push(b);
          console.log('static "' + String(n.description ?? '') + '": no usable path — using box/hull (convert to curves for true-shape collision)');
        } else skipped.push('static ' + String(n));
      }
      const staticCount = bodies.length;
      for (const n of simNodes) {
        const b = makeBody(n, false);
        if (b) bodies.push(b); else skipped.push(String(n));
      }
      for (const b of bodies) {
        b.segSide = segments.map(seg => {
          const d = (b.cx - seg.E0[0]) * seg.nx + (b.cy - seg.E0[1]) * seg.ny;
          return d >= 0 ? 1 : -1;
        });
      }
      if (skipped.length) console.log('skipped:', skipped.join(', '));
      if (bodies.length === staticCount) { app.alert('None of the selected objects could be simulated.'); }
      else {

      const DT = 1 / 30;
      const MAXF = Math.max(30, Math.round((durCtl.value ?? 5) * 1000 / 33));
      const FREEZE_V = 70, FREEZE_VA = 0.6;
      const HARDSTOP_V = 22, HARDSTOP_VA = 0.18;
      const FLAT_DOT = 0.95;
      const RAMP_FRAMES = 5;
      const SLEEP_MAX_PEN = 5;
      const STUCK_FRAMES = 6;
      // displacement-window settle: net movement under these bounds for
      // STILL_FRAMES consecutive frames = settled, whatever velocity claims
      const STILL_POS = 3.0, STILL_ANG = 0.03, STILL_FRAMES = 8;
      const CALM_V = 8, CALM_VA = 0.03, CALM_FRAMES = 15;
      const STEP_PX = 16, MAX_SUB = 8;
      const MAX_SPEED = STEP_PX * MAX_SUB / DT;
      let frame = 0, done = false, calmFrames = 0;

      const dynBodies = bodies.filter(b => !b.static);
      const recording = []; // per frame: flat [cx,cy,a, ...] for dynBodies

      const angle = b => b.theta0 + b.a;

      function polygon(b) {
        const t = angle(b), ca = Math.cos(t), sa = Math.sin(t);
        const offs = b.hull ?? [[-b.hw,-b.hh],[b.hw,-b.hh],[b.hw,b.hh],[-b.hw,b.hh]];
        return offs.map(([x, y]) => [b.cx + x*ca - y*sa, b.cy + x*sa + y*ca]);
      }

      function collidePolyPoly(A, B) {
        const CA = polygon(A), CB = polygon(B);
        let best = null;
        for (const [P, Q, flip] of [[CA, CB, false], [CB, CA, true]]) {
          const nP = P.length;
          for (let i = 0; i < nP; i++) {
            const e0 = P[i], e1 = P[(i+1)%nP];
            let nx = e1[1]-e0[1], ny = -(e1[0]-e0[0]);
            const L = Math.hypot(nx, ny);
            if (L < 1e-9) continue;
            nx/=L; ny/=L;
            let minP=Infinity,maxP=-Infinity,minQ=Infinity,maxQ=-Infinity;
            for (const c of P) { const d=c[0]*nx+c[1]*ny; if(d<minP)minP=d; if(d>maxP)maxP=d; }
            for (const c of Q) { const d=c[0]*nx+c[1]*ny; if(d<minQ)minQ=d; if(d>maxQ)maxQ=d; }
            const overlap = Math.min(maxP, maxQ) - Math.max(minP, minQ);
            if (overlap <= 0) return null;
            if (!best || overlap < best.pen) {
              const own = flip ? B : A, other = flip ? A : B;
              const centreD = (other.cx - own.cx) * nx + (other.cy - own.cy) * ny;
              if (centreD < 0) { nx=-nx; ny=-ny; }
              let deep=null, deepD=Infinity;
              for (const c of (flip ? CA : CB)) { const d=c[0]*nx+c[1]*ny; if(d<deepD){deepD=d; deep=c;} }
              best = { pen: overlap,
                nx: flip ? -nx : nx, ny: flip ? -ny : ny,
                px: deep[0], py: deep[1] };
            }
          }
        }
        return best;
      }

      function collideCirclePoly(C, B) {
        const poly = polygon(B);
        let bestD = Infinity, bestQ = null;
        const nV = poly.length;
        let inside = true;
        for (let i = 0; i < nV; i++) {
          const p0 = poly[i], p1 = poly[(i+1)%nV];
          const ex = p1[0]-p0[0], ey = p1[1]-p0[1];
          const wx = C.cx - p0[0], wy = C.cy - p0[1];
          if (ex * wy - ey * wx > 0) inside = false;
          const t = Math.max(0, Math.min(1, (wx*ex + wy*ey) / (ex*ex + ey*ey || 1)));
          const qx = p0[0] + t*ex, qy = p0[1] + t*ey;
          const d = Math.hypot(C.cx - qx, C.cy - qy);
          if (d < bestD) { bestD = d; bestQ = [qx, qy]; }
        }
        if (!inside && bestD >= C.r) return null;
        let nx, ny, pen;
        if (bestD > 0.0001 && !inside) {
          nx = (bestQ[0] - C.cx) / bestD; ny = (bestQ[1] - C.cy) / bestD;
          pen = C.r - bestD;
        } else {
          nx = (bestQ[0] - C.cx); ny = (bestQ[1] - C.cy);
          const L = Math.hypot(nx, ny) || 1;
          nx = nx / L; ny = ny / L;
          pen = C.r + bestD;
        }
        return { nx, ny, pen, px: bestQ[0], py: bestQ[1] };
      }

      function collideCircleCircle(A, B) {
        const dx = B.cx - A.cx, dy = B.cy - A.cy;
        const d = Math.hypot(dx, dy), min = A.r + B.r;
        if (d >= min || d < 0.001) return null;
        const nx = dx/d, ny = dy/d;
        return { nx, ny, pen: min - d, px: A.cx + nx*A.r, py: A.cy + ny*A.r };
      }

      function narrowPhase(A, B) {
        if (A.isCircle && B.isCircle) return collideCircleCircle(A, B);
        if (A.isCircle) return collideCirclePoly(A, B);
        if (B.isCircle) { const cc = collideCirclePoly(B, A); return cc ? { nx:-cc.nx, ny:-cc.ny, pen:cc.pen, px:cc.px, py:cc.py } : null; }
        return collidePolyPoly(A, B);
      }

      function isSlow(b) {
        return Math.abs(b.vx) < FREEZE_V && Math.abs(b.vy) < FREEZE_V && Math.abs(b.va) < FREEZE_VA;
      }

      function resolve(A, B, c, useRestitution) {
        const { nx, ny, pen, px, py } = c;
        A.maxPen = Math.max(A.maxPen, pen); B.maxPen = Math.max(B.maxPen, pen);
        const gDot = nx * GUX + ny * GUY;
        if (B.asleep || B.static) {
          A.touchedSleeper = true;
          if (gDot > FLAT_DOT) A.flatSupport = true;
        }
        if (A.asleep || A.static) {
          B.touchedSleeper = true;
          if (gDot < -FLAT_DOT) B.flatSupport = true;
        }
        const iA = A.asleep ? 0 : A.invMass, iB = B.asleep ? 0 : B.invMass;
        const iIA = A.asleep ? 0 : A.invI,  iIB = B.asleep ? 0 : B.invI;
        const invSum = iA + iB;
        if (invSum === 0) return;
        if (pen > SLOP) {
          const slowPair = isSlow(A) && isSlow(B);
          const k = slowPair ? 0.15 : 0.4;
          const corr = Math.min((pen - SLOP) * k, slowPair ? 1.0 : 8.0);
          A.cx -= nx*corr*(iA/invSum); A.cy -= ny*corr*(iA/invSum);
          B.cx += nx*corr*(iB/invSum); B.cy += ny*corr*(iB/invSum);
        }
        const rax = px - A.cx, ray = py - A.cy;
        const rbx = px - B.cx, rby = py - B.cy;
        const vax = A.vx - A.va*ray, vay = A.vy + A.va*rax;
        const vbx = B.vx - B.va*rby, vby = B.vy + B.va*rbx;
        const rvx = vbx - vax, rvy = vby - vay;
        const vn = rvx*nx + rvy*ny;
        if (vn >= 0) return;
        const raXn = rax*ny - ray*nx, rbXn = rbx*ny - rby*nx;
        const invMass = iA + iB + (raXn*raXn)*iIA + (rbXn*rbXn)*iIB;
        const e = (useRestitution && Math.abs(vn) > REST_THRESHOLD) ? REST : 0;
        const j = -(1 + e) * vn / invMass;
        A.vx -= j*nx*iA; A.vy -= j*ny*iA; A.va -= j*raXn*iIA;
        B.vx += j*nx*iB; B.vy += j*ny*iB; B.va += j*rbXn*iIB;
        const tx = -ny, ty = nx;
        const vt = rvx*tx + rvy*ty;
        const raXt = rax*ty - ray*tx, rbXt = rbx*ty - rby*tx;
        const invMassT = iA + iB + (raXt*raXt)*iIA + (rbXt*rbXt)*iIB;
        let jt = -vt / invMassT;
        const maxF = MU * Math.abs(j);
        jt = Math.max(-maxF, Math.min(maxF, jt));
        A.vx -= jt*tx*iA; A.vy -= jt*ty*iA; A.va -= jt*raXt*iIA;
        B.vx += jt*tx*iB; B.vy += jt*ty*iB; B.va += jt*rbXt*iIB;
      }

      function applySurfaceContact(b, nx, ny, pen, cpx, cpy) {
        const slow = isSlow(b);
        const push = slow ? Math.min(pen, 1.0) : pen;
        b.cx += nx * push; b.cy += ny * push;
        const rx = cpx + nx * push - b.cx, ry = cpy + ny * push - b.cy;
        const vpx = b.vx - b.va * ry, vpy = b.vy + b.va * rx;
        const vin = -(vpx * nx + vpy * ny);
        const rXn = rx * ny - ry * nx;
        let jn = 0;
        if (vin > 0) {
          const e = vin > REST_THRESHOLD ? REST : 0;
          jn = (1 + e) * vin / (b.invMass + (rXn * rXn) * b.invI);
          b.vx += nx * jn * b.invMass;
          b.vy += ny * jn * b.invMass;
          b.va += jn * rXn * b.invI;
        }
        const tx = -ny, ty = nx;
        const vt = vpx * tx + vpy * ty;
        const rXt = rx * ty - ry * tx;
        let jt = vt / (b.invMass + (rXt * rXt) * b.invI);
        const maxF = MU * jn;
        jt = Math.max(-maxF, Math.min(maxF, jt));
        b.vx -= tx * jt * b.invMass;
        b.vy -= ty * jt * b.invMass;
        b.va -= jt * rXt * b.invI;
        b.maxPen = Math.max(b.maxPen, pen);
        b.touchedSleeper = true;
        if ((nx * GUX + ny * GUY) < -FLAT_DOT) b.flatSupport = true;
      }

      function planeContact(b, P) {
        if (b.isCircle) {
          const pen = b.r - ((b.cx - P.qx) * P.nx + (b.cy - P.qy) * P.ny);
          if (pen <= 0) return false;
          applySurfaceContact(b, P.nx, P.ny, pen, b.cx - P.nx * b.r, b.cy - P.ny * b.r);
          return true;
        }
        const verts = polygon(b);
        let deep = null, deepD = Infinity;
        for (const v of verts) {
          const d = (v[0] - P.qx) * P.nx + (v[1] - P.qy) * P.ny;
          if (d < deepD) { deepD = d; deep = v; }
        }
        if (-deepD <= 0) return false;
        applySurfaceContact(b, P.nx, P.ny, -deepD, deep[0], deep[1]);
        return true;
      }

      function segmentContact(b, seg, si) {
        const reach = b.r + seg.halfW + 2;
        if (b.cx + reach < seg.minX || b.cx - reach > seg.maxX ||
            b.cy + reach < seg.minY || b.cy - reach > seg.maxY) {
          const d = (b.cx - seg.E0[0]) * seg.nx + (b.cy - seg.E0[1]) * seg.ny;
          b.segSide[si] = d >= 0 ? 1 : -1;
          return;
        }
        const hwS = seg.halfW;
        if (b.isCircle) {
          const s = (b.cx - seg.E0[0]) * seg.tx + (b.cy - seg.E0[1]) * seg.ty;
          if (s < -(b.r + hwS) || s > seg.len + b.r + hwS) {
            const d = (b.cx - seg.E0[0]) * seg.nx + (b.cy - seg.E0[1]) * seg.ny;
            b.segSide[si] = d >= 0 ? 1 : -1;
            return;
          }
          const home = b.segSide[si];
          const nx = seg.nx * home, ny = seg.ny * home;
          if (s >= 0 && s <= seg.len) {
            const d = (b.cx - seg.E0[0]) * nx + (b.cy - seg.E0[1]) * ny;
            const pen = (b.r + hwS) - d;
            if (pen > 0) applySurfaceContact(b, nx, ny, pen, b.cx - nx * b.r, b.cy - ny * b.r);
          } else {
            const E = s < 0 ? seg.E0 : seg.E1;
            const dx = b.cx - E[0], dy = b.cy - E[1];
            const dist = Math.hypot(dx, dy);
            if (dist < b.r + hwS && dist > 0.001) {
              applySurfaceContact(b, dx/dist, dy/dist, (b.r + hwS) - dist, E[0], E[1]);
            }
          }
          return;
        }
        const verts = polygon(b);
        let minS = Infinity, maxS = -Infinity;
        for (const v of verts) {
          const s = (v[0] - seg.E0[0]) * seg.tx + (v[1] - seg.E0[1]) * seg.ty;
          if (s < minS) minS = s;
          if (s > maxS) maxS = s;
        }
        if (maxS < 0 || minS > seg.len) {
          const d = (b.cx - seg.E0[0]) * seg.nx + (b.cy - seg.E0[1]) * seg.ny;
          b.segSide[si] = d >= 0 ? 1 : -1;
          return;
        }
        const home = b.segSide[si];
        const nx = seg.nx * home, ny = seg.ny * home;
        let deep = null, deepD = Infinity;
        for (const v of verts) {
          const s = (v[0] - seg.E0[0]) * seg.tx + (v[1] - seg.E0[1]) * seg.ty;
          if (s < 0 || s > seg.len) continue;
          const d = (v[0] - seg.E0[0]) * nx + (v[1] - seg.E0[1]) * ny;
          if (d < deepD) { deepD = d; deep = v; }
        }
        if (!deep || deepD >= hwS) return;
        applySurfaceContact(b, nx, ny, hwS - deepD, deep[0], deep[1]);
      }

      function boundaries(b) {
        for (const P of PLANES) planeContact(b, P);
        for (let si = 0; si < segments.length; si++) segmentContact(b, segments[si], si);
      }

      function isLegal(b) {
        if (b.isCircle) {
          for (const P of PLANES) {
            if (b.r - ((b.cx - P.qx) * P.nx + (b.cy - P.qy) * P.ny) > 0.5) return false;
          }
          return true;
        }
        const verts = polygon(b);
        for (const P of PLANES) {
          for (const v of verts) {
            if ((v[0] - P.qx) * P.nx + (v[1] - P.qy) * P.ny < -0.5) return false;
          }
        }
        return true;
      }

      function step() {
        let maxV = 0;
        for (const b of bodies) {
          b.maxPen = 0; b.touchedSleeper = false; b.flatSupport = false;
          if (b.asleep) continue;
          const sp = Math.max(Math.abs(b.vx + GX * DT), Math.abs(b.vy + GY * DT));
          if (sp > maxV) maxV = sp;
        }
        const nSub = Math.max(1, Math.min(MAX_SUB, Math.ceil(maxV * DT / STEP_PX)));
        const sdt = DT / nSub;
        const iters = nSub > 1 ? 3 : (maxV > 120 ? 4 : 3);

        for (let s = 0; s < nSub; s++) {
          for (const b of bodies) {
            if (b.asleep) continue;
            b.vx += GX * sdt; b.vy += GY * sdt;
            const sp = Math.hypot(b.vx, b.vy);
            if (sp > MAX_SPEED) { const k = MAX_SPEED / sp; b.vx *= k; b.vy *= k; }
            b.cx += b.vx * sdt; b.cy += b.vy * sdt;
            b.a += b.va * sdt;
          }
          for (let it = 0; it < iters; it++) {
            for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
              const A = bodies[i], B = bodies[j];
              if (A.asleep && B.asleep) continue;
              const dx = B.cx - A.cx, dy = B.cy - A.cy;
              if (Math.hypot(dx, dy) > A.r + B.r) continue;
              const c = narrowPhase(A, B);
              if (c) resolve(A, B, c, s === 0 && it === 0);
            }
            for (const b of bodies) {
              if (b.asleep) continue;
              boundaries(b);
            }
          }
        }
        for (const b of bodies) {
          if (b.asleep) continue;
          b.vx *= 0.997; b.vy *= 0.997; b.va *= 0.995;
          if (b.touchedSleeper &&
              Math.abs(b.vx) < HARDSTOP_V && Math.abs(b.vy) < HARDSTOP_V &&
              Math.abs(b.va) < HARDSTOP_VA) {
            b.vx = 0; b.vy = 0; b.va = 0;
          } else if (b.flatSupport && Math.abs(b.vx) + Math.abs(b.vy) < 120) {
            b.vx *= 0.8; b.vy *= 0.8; b.va *= 0.8;
          }
        }
        for (const b of bodies) {
          if (b.asleep) continue;

          // DISPLACEMENT-WINDOW SETTLE: oscillating bodies read as fast on
          // every instantaneous velocity check, so velocity-based sleep never
          // fires. Net movement over a window can't be fooled.
          const dpos = Math.hypot(b.cx - b.ax, b.cy - b.ay);
          const dang = Math.abs(b.a - b.aa);
          if (dpos < STILL_POS && dang < STILL_ANG) {
            b.stillFrames++;
            if (b.stillFrames >= STILL_FRAMES && b.touchedSleeper) {
              b.cx = b.ax; b.cy = b.ay; b.a = b.aa;
              b.asleep = true; b.vx = 0; b.vy = 0; b.va = 0;
              b.slowFrames = 0; b.stuckFrames = 0; b.stillFrames = 0;
              continue;
            }
          } else {
            b.ax = b.cx; b.ay = b.cy; b.aa = b.a;
            b.stillFrames = 0;
          }

          const slow = isSlow(b);
          if (b.touchedSleeper && slow && isLegal(b)) {
            b.slowFrames++;
            const ready = b.flatSupport || b.slowFrames >= RAMP_FRAMES;
            if (ready && (b.maxPen < SLEEP_MAX_PEN || ++b.stuckFrames >= STUCK_FRAMES)) {
              b.asleep = true; b.vx = 0; b.vy = 0; b.va = 0;
              b.slowFrames = 0; b.stuckFrames = 0; b.stillFrames = 0;
            }
          } else {
            b.slowFrames = 0; b.stuckFrames = 0;
          }
        }
        const allSlow = bodies.every(b => b.static || b.asleep ||
          (Math.abs(b.vx) < CALM_V && Math.abs(b.vy) < CALM_V && Math.abs(b.va) < CALM_VA));
        calmFrames = allSlow ? calmFrames + 1 : 0;
      }

      function commandFromState(state) {
        const cc = CompoundCommandBuilder.create();
        for (let i = 0; i < dynBodies.length; i++) {
          const b = dynBodies[i];
          const cx = state[i*3], cy = state[i*3+1], a = state[i*3+2];
          const rot = Transform.createRotate(a).around(b.ox, b.oy);
          const xf = Transform.createTranslate(cx - b.ox, cy - b.oy).multiply(rot);
          cc.addCommand(DocumentCommand.createTransform(b.sel, xf, { mergeable: false }));
        }
        return cc.createCommand();
      }

      function snapshotState() {
        const s = new Array(dynBodies.length * 3);
        for (let i = 0; i < dynBodies.length; i++) {
          s[i*3] = dynBodies[i].cx; s[i*3+1] = dynBodies[i].cy; s[i*3+2] = dynBodies[i].a;
        }
        return s;
      }

      // ---------- EXPORT (replay recording up to the chosen frame) ----------
      function runExport(useJpeg, chosenIdx) {
        const EXT = useJpeg ? 'jpg' : 'png';
        const PRESET = useJpeg ? 'JPEG' : 'PNG';
        const desk = app.userDesktopPath;
        const st = new Date();
        const p2 = v => String(v).padStart(2, '0');
        const outDir = desk + '/PhysicsDrop_' + st.getFullYear() + p2(st.getMonth()+1) + p2(st.getDate()) + '_' + p2(st.getHours()) + p2(st.getMinutes()) + p2(st.getSeconds());
        const exportOpts = FileExportOptions.createWithPresetName(PRESET);
        const exportArea = FileExportArea.createForCurrentSpread();
        const fp = f => outDir + '/drop_' + String(f).padStart(4, '0') + '.' + EXT;
        const totalFiles = chosenIdx + 2; // initial frame + recording[0..chosenIdx]

        try {
          fsys.createDirectories(outDir);
          if (!fsys.isDirectory(outDir)) throw new Error('folder not created');
        } catch (e) {
          app.alert('Could not create export folder: ' + e + ' — chosen frame kept, no export.');
          return;
        }

        let ef = 0, exportDone = false, started = false;
        setInterval(5, (err) => {
          if (exportDone) return;
          if (err) { exportDone = true; Timer.cancelAll(); app.alert('Export timer error: ' + err + ' — no export.'); return; }
          try {
            if (!started) { started = true; doc.undo(); } // remove chosen-frame bake; replay from originals
            if (ef === 0) {
              doc.export(fp(0), exportOpts, exportArea);
            } else if (ef <= chosenIdx) {
              doc.executeCommand(commandFromState(recording[ef - 1]), false);
              doc.export(fp(ef), exportOpts, exportArea);
              doc.undo();
            } else {
              // final frame of the sequence IS the chosen frame: bake and KEEP
              exportDone = true;
              Timer.cancelAll();
              doc.executeCommand(commandFromState(recording[chosenIdx]), false);
              doc.export(fp(ef), exportOpts, exportArea);
              app.alert('Export complete: ' + totalFiles + ' frames in ' + outDir + '\nResolve: File > Import Media (image sequence on), clip fps 30.');
              return;
            }
            ef++;
          } catch (e) {
            exportDone = true;
            Timer.cancelAll();
            try {
              if (started) doc.executeCommand(commandFromState(recording[chosenIdx]), false);
            } catch (e2) {}
            app.alert('Export failed at frame ' + ef + ': ' + e + '\nIf PNG hangs, re-run and choose JPEG.');
          }
        });
      }

      // ---------- FINISHED DIALOG (replay scrubber + export) ----------
      function showFinished() {
        const lastIdx = recording.length - 1;
        const secs = (recording.length / 30).toFixed(1);
        const dlg2 = Dialog.create('Physics Drop — Finished');
        dlg2.initialWidth = 480;
        const c2 = dlg2.addColumn();

        const rg = c2.addGroup('Replay');
        const frameCtl = rg.addUnitValueEditor('Frame', UnitType.Number, UnitType.Number, lastIdx, 0, lastIdx);
        frameCtl.setShowPopupSlider(true); frameCtl.precision = 0;
        rg.addStaticText('', recording.length + ' frames (' + secs + 's @ 30fps). Drag the Frame slider to replay the drop on canvas. OK keeps the frame you are viewing. Cancel keeps the settled result.').setIsFullWidth(true);

        let fmtCtl = null;
        if (WANT_EXPORT) {
          const eg = c2.addGroup('Export image sequence');
          fmtCtl = eg.addRadioGroup('Format', ['PNG', 'JPEG'], 0);
          eg.addStaticText('', 'OK exports the drop from the start up to the frame you are viewing, to a folder on your Desktop. Do not touch the document while exporting.').setIsFullWidth(true);
        }
        c2.addGroup(' ').addStaticText('', ' ').setIsFullWidth(true);

        // live scrub: preview transforms replace each other, so each change
        // simply previews the recorded state for the slider's frame
        let shownIdx = lastIdx;
        frameCtl.setOnValueChangedHandler(() => {
          try {
            const v = Math.max(0, Math.min(lastIdx, Math.round(frameCtl.value ?? lastIdx)));
            shownIdx = v;
            doc.executeCommand(commandFromState(recording[v]), true);
          } catch (e) {}
        });

        // show the settled state as the starting preview
        doc.executeCommand(commandFromState(recording[lastIdx]), true);

        const r2 = dlg2.runModal();
        doc.clearPreviews();

        if (r2?.value === DialogResult.Ok.value) {
          const chosenIdx = Math.max(0, Math.min(lastIdx, shownIdx));
          doc.executeCommand(commandFromState(recording[chosenIdx]), false);
          if (WANT_EXPORT) runExport(fmtCtl ? fmtCtl.selectedIndex === 1 : false, chosenIdx);
        } else {
          // Cancel: keep the settled result, no export
          doc.executeCommand(commandFromState(recording[lastIdx]), false);
        }
      }

      // ---------- LIVE SIM LOOP ----------
      setInterval(33, (err) => {
        if (err || done) return;
        try {
          frame++;
          step();
          recording.push(snapshotState());
          const allAsleep = bodies.every(b => b.static || b.asleep);
          const settled = frame > 20 && (allAsleep || calmFrames >= CALM_FRAMES);
          if (frame >= MAXF || settled) {
            done = true;
            Timer.cancelAll();
            showFinished();
          } else {
            doc.executeCommand(commandFromState(recording[recording.length - 1]), true);
          }
        } catch (e) {
          done = true;
          Timer.cancelAll();
          try { doc.clearPreviews(); } catch (e2) {}
          app.alert('Physics Drop error: ' + e);
        }
      });
      console.log('Physics Drop v1.1:', dynBodies.length, 'dynamic,',
        staticCount, 'static hulls,', segments.length, 'path segments' +
        (WANT_EXPORT ? ' — export enabled' : ''));
      }
    }
  }
}
