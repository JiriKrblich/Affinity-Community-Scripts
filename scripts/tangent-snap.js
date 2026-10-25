/**
 * name: Tangent Snap
 * version: 0.2.0
 * description: Moves selected elements along the shortest distance until their outlines touch (tangent contact, no gap). External tangency snaps elements against each other; Internal tangency inscribes elements inside a container until they touch its inner edge. Works on real outlines (curves, shapes, text glyphs, groups), optionally including strokes, and can push overlapping elements apart until they just touch.
 * author: WaveF
 * email: wavef@live.com
 * website: https://minicg.com
 */
'use strict';

const { app } = require('/application');
const { Document } = require('/document');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
const { Transform, Polygon } = require('/geometry');
const { Selection } = require('/selections');
const { Dialog, DialogResult } = require('/dialog');
const { NoFill } = require('/fills');
const { Timer } = require('/timers.js');

const SCRIPT_NAME = 'Tangent Snap';
const VERSION = '0.2.0';
const SCRIPT_TITLE = SCRIPT_NAME + ' v' + VERSION;

const FLATTEN_TOLERANCE = 0.01;   // max chord deviation in spread pixels
const CONTACT_EPS = 1e-4;         // clearance treated as "touching" (px)
const CROSS_EPS = 1e-6;           // penetration below this is not an overlap (px)
const PREVIEW_DEBOUNCE_MS = 250;

const MODES = ['Cluster', 'To Anchor', 'Chain'];
const ANCHORS = ['Largest', 'First selected', 'Last selected'];
const TANGENCIES = ['External', 'Internal'];

// ---------------------------------------------------------------------------
// Geometry extraction
// ---------------------------------------------------------------------------

function isNoFill(fill) {
    try { return !fill || fill instanceof NoFill || String(fill) === '[object NoFill]'; } catch (_) { return true; }
}

// How far the stroke reaches beyond the outline (outer) and into the shape (inner).
function strokeExtents(node) {
    try {
        const weight = Number(node.lineWeight);
        if (!(weight > 0)) return { outer: 0, inner: 0 };
        if (isNoFill(node.penFill)) return { outer: 0, inner: 0 };
        const align = node.lineStyleDescriptor.strokeAlignment;
        const value = align && align.value !== undefined ? align.value : align;
        if (value === 1) return { outer: 0, inner: weight };        // Inside
        if (value === 2) return { outer: weight, inner: 0 };        // Outside
        return { outer: weight / 2, inner: weight / 2 };            // Centre
    } catch (_) {
        return { outer: 0, inner: 0 };
    }
}

function hasBrushFill(node) {
    try { return !isNoFill(node.brushFill); } catch (_) { return false; }
}

function maxScale(d) {
    // Largest singular value of the 2x2 linear part.
    const a = d[0], b = d[1], c = d[3], e = d[4];
    const s1 = a * a + b * b + c * c + e * e;
    const det = a * e - b * c;
    const disc = Math.sqrt(Math.max(0, s1 * s1 - 4 * det * det));
    return Math.sqrt(Math.max(1e-12, (s1 + disc) / 2));
}

function makeRing(xs, ys, closed) {
    let n = xs.length;
    if (closed && n > 2 && Math.abs(xs[0] - xs[n - 1]) < 1e-9 && Math.abs(ys[0] - ys[n - 1]) < 1e-9) n -= 1;
    if (n < 1) return null;
    if (n < 3) closed = false;
    const X = new Float64Array(n), Y = new Float64Array(n);
    for (let i = 0; i < n; i++) { X[i] = xs[i]; Y[i] = ys[i]; }
    const segCount = n === 1 ? 1 : (closed ? n : n - 1);
    const sx0 = new Float64Array(segCount), sy0 = new Float64Array(segCount);
    const sx1 = new Float64Array(segCount), sy1 = new Float64Array(segCount);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < segCount; i++) {
        const j = n === 1 ? 0 : (i + 1) % n;
        sx0[i] = Math.min(X[i], X[j]); sx1[i] = Math.max(X[i], X[j]);
        sy0[i] = Math.min(Y[i], Y[j]); sy1[i] = Math.max(Y[i], Y[j]);
        if (sx0[i] < minX) minX = sx0[i];
        if (sy0[i] < minY) minY = sy0[i];
        if (sx1[i] > maxX) maxX = sx1[i];
        if (sy1[i] > maxY) maxY = sy1[i];
    }
    return { X, Y, n, closed, segCount, sx0, sy0, sx1, sy1, minX, minY, maxX, maxY };
}

// r: stroke reach outside the outline, rIn: stroke reach inside (used when the part is a container).
function makePart(rings, r, rIn) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ring of rings) {
        minX = Math.min(minX, ring.minX); minY = Math.min(minY, ring.minY);
        maxX = Math.max(maxX, ring.maxX); maxY = Math.max(maxY, ring.maxY);
    }
    return { rings, r, rIn: rIn || 0, solid: rings.some(ring => ring.closed), minX, minY, maxX, maxY };
}

function addCurveParts(node, curvesInterface, options, out) {
    const ppc = curvesInterface.polyPolyCurves;
    const d = node.baseToSpreadTransform.data;
    const tolerance = Math.max(1e-5, FLATTEN_TOLERANCE / maxScale(d));
    const ext = options.includeStroke ? strokeExtents(node) : { outer: 0, inner: 0 };
    const filled = hasBrushFill(node);
    for (let j = 0; j < ppc.polyCurveCount; j++) {
        const pc = ppc.getTransformedPolyCurve(j);
        const rings = [];
        for (let i = 0; i < pc.curveCount; i++) {
            const curve = pc.at(i);
            const poly = new Polygon(curve.generatePolygon(tolerance));
            const count = poly.pointCount;
            if (!count) continue;
            const xs = new Array(count), ys = new Array(count);
            for (let k = 0; k < count; k++) {
                const p = poly.getPoint(k);
                xs[k] = d[0] * p.x + d[1] * p.y + d[2];
                ys[k] = d[3] * p.x + d[4] * p.y + d[5];
            }
            // Affinity fills open curves as if they were closed.
            const ring = makeRing(xs, ys, curve.isClosed || filled);
            if (ring) rings.push(ring);
        }
        if (rings.length) out.push(makePart(rings, ext.outer, ext.inner));
    }
}

function addBoxPart(node, out) {
    let xs, ys;
    try {
        const b = node.baseBox;
        const d = node.baseToSpreadTransform.data;
        const corners = [[b.x, b.y], [b.x + b.width, b.y], [b.x + b.width, b.y + b.height], [b.x, b.y + b.height]];
        xs = corners.map(p => d[0] * p[0] + d[1] * p[1] + d[2]);
        ys = corners.map(p => d[3] * p[0] + d[4] * p[1] + d[5]);
        if (![...xs, ...ys].every(Number.isFinite) || !(b.width > 0) || !(b.height > 0)) throw new Error('bad box');
    } catch (_) {
        const b = node.getExactSpreadBaseBox();
        if (!b || !(b.width > 0) || !(b.height > 0)) return;
        xs = [b.x, b.x + b.width, b.x + b.width, b.x];
        ys = [b.y, b.y, b.y + b.height, b.y + b.height];
    }
    const ring = makeRing(xs, ys, true);
    if (ring) out.push(makePart([ring], 0, 0));
}

function getCurvesInterface(node) {
    try { return node.curvesInterface || null; } catch (_) { return null; }
}

function isHidden(node) {
    try { return node.isVisibleInDomain === false; } catch (_) { return false; }
}

function isArtboard(node) {
    try { return node.isArtboardEnabled === true; } catch (_) { return false; }
}

function childList(node) {
    const list = [];
    try { for (const child of node.children) list.push(child); } catch (_) { /* no children */ }
    return list;
}

function collectParts(node, options, out, depth) {
    if (depth > 64 || isHidden(node)) return;
    const ci = getCurvesInterface(node);
    if (ci) { addCurveParts(node, ci, options, out); return; }
    const kids = childList(node);
    if (kids.length) {
        for (const kid of kids) collectParts(kid, options, out, depth + 1);
        return;
    }
    if (node.isImageNode || node.isRasterNode) addBoxPart(node, out);
}

function buildObject(node, options, index) {
    const parts = [];
    collectParts(node, options, parts, 0);
    if (!parts.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxR = 0;
    for (const part of parts) {
        minX = Math.min(minX, part.minX); minY = Math.min(minY, part.minY);
        maxX = Math.max(maxX, part.maxX); maxY = Math.max(maxY, part.maxY);
        maxR = Math.max(maxR, part.r);
    }
    return {
        node, index, parts, maxR,
        minX, minY, maxX, maxY,
        cx: (minX + maxX) / 2, cy: (minY + maxY) / 2,
        area: (maxX - minX) * (maxY - minY),
        ox: 0, oy: 0,
        name: node.userDescription || node.defaultDescription || 'Element'
    };
}

// ---------------------------------------------------------------------------
// Distance / overlap primitives. Object B is shifted by (sx, sy) relative to A.
// ---------------------------------------------------------------------------

function boxGap(aMinX, aMinY, aMaxX, aMaxY, bMinX, bMinY, bMaxX, bMaxY) {
    const dx = Math.max(0, bMinX - aMaxX, aMinX - bMaxX);
    const dy = Math.max(0, bMinY - aMaxY, aMinY - bMaxY);
    return Math.sqrt(dx * dx + dy * dy);
}

// Closest points between segments P0P1 and Q0Q1; writes into tmp {d2, px, py, qx, qy}.
function segSeg(p0x, p0y, p1x, p1y, q0x, q0y, q1x, q1y, tmp) {
    const ux = p1x - p0x, uy = p1y - p0y, vx = q1x - q0x, vy = q1y - q0y;
    const wx = p0x - q0x, wy = p0y - q0y;
    const den = ux * vy - uy * vx;
    if (den !== 0) {
        const s = (vx * wy - vy * wx) / den;
        const t = (ux * wy - uy * wx) / den;
        if (s >= 0 && s <= 1 && t >= 0 && t <= 1) {
            const x = p0x + s * ux, y = p0y + s * uy;
            tmp.d2 = 0; tmp.px = x; tmp.py = y; tmp.qx = x; tmp.qy = y;
            return;
        }
    }
    tmp.d2 = Infinity;
    pointSeg(p0x, p0y, q0x, q0y, vx, vy, tmp, false);
    pointSeg(p1x, p1y, q0x, q0y, vx, vy, tmp, false);
    pointSeg(q0x, q0y, p0x, p0y, ux, uy, tmp, true);
    pointSeg(q1x, q1y, p0x, p0y, ux, uy, tmp, true);
}

// Distance from point (x, y) to segment A + t*(vx, vy). swap: the point belongs to Q.
function pointSeg(x, y, ax, ay, vx, vy, tmp, swap) {
    const len2 = vx * vx + vy * vy;
    let t = len2 > 0 ? ((x - ax) * vx + (y - ay) * vy) / len2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const cx = ax + t * vx, cy = ay + t * vy;
    const dx = x - cx, dy = y - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 < tmp.d2) {
        tmp.d2 = d2;
        if (swap) { tmp.px = cx; tmp.py = cy; tmp.qx = x; tmp.qy = y; }
        else { tmp.px = x; tmp.py = y; tmp.qx = cx; tmp.qy = cy; }
    }
}

const SEG_TMP = { d2: 0, px: 0, py: 0, qx: 0, qy: 0 };

function ringDistance(ra, rb, sx, sy, r, best) {
    const AX = ra.X, AY = ra.Y, an = ra.n, BX = rb.X, BY = rb.Y, bn = rb.n;
    const bMinX = rb.minX + sx, bMinY = rb.minY + sy, bMaxX = rb.maxX + sx, bMaxY = rb.maxY + sy;
    for (let i = 0; i < ra.segCount; i++) {
        let limit = best.d + r;
        if (limit <= 0) return;
        const a0x = ra.sx0[i], a0y = ra.sy0[i], a1x = ra.sx1[i], a1y = ra.sy1[i];
        let gx = Math.max(0, bMinX - a1x, a0x - bMaxX), gy = Math.max(0, bMinY - a1y, a0y - bMaxY);
        if (gx * gx + gy * gy >= limit * limit) continue;
        const i2 = an === 1 ? 0 : (i + 1) % an;
        const px0 = AX[i], py0 = AY[i], px1 = AX[i2], py1 = AY[i2];
        for (let j = 0; j < rb.segCount; j++) {
            gx = Math.max(0, rb.sx0[j] + sx - a1x, a0x - (rb.sx1[j] + sx));
            gy = Math.max(0, rb.sy0[j] + sy - a1y, a0y - (rb.sy1[j] + sy));
            if (gx * gx + gy * gy >= limit * limit) continue;
            const j2 = bn === 1 ? 0 : (j + 1) % bn;
            segSeg(px0, py0, px1, py1, BX[j] + sx, BY[j] + sy, BX[j2] + sx, BY[j2] + sy, SEG_TMP);
            const c = Math.sqrt(SEG_TMP.d2) - r;
            if (c < best.d) {
                best.d = c; best.found = true;
                best.ax = SEG_TMP.px; best.ay = SEG_TMP.py; best.bx = SEG_TMP.qx; best.by = SEG_TMP.qy;
                limit = best.d + r;
                if (limit <= 0) return;
            }
        }
    }
}

// Inflated clearance between object A and object B (both at their current offsets).
// Points are reported in spread coordinates.
function objectClearance(A, B, limit) {
    const sx = B.ox - A.ox, sy = B.oy - A.oy;
    const best = { d: limit, found: false, ax: 0, ay: 0, bx: 0, by: 0 };
    if (boxGap(A.minX, A.minY, A.maxX, A.maxY, B.minX + sx, B.minY + sy, B.maxX + sx, B.maxY + sy) - A.maxR - B.maxR >= limit) return best;
    for (const pa of A.parts) {
        for (const pb of B.parts) {
            const r = pa.r + pb.r;
            if (boxGap(pa.minX, pa.minY, pa.maxX, pa.maxY, pb.minX + sx, pb.minY + sy, pb.maxX + sx, pb.maxY + sy) - r >= best.d) continue;
            for (const ra of pa.rings) {
                for (const rb of pb.rings) {
                    if (boxGap(ra.minX, ra.minY, ra.maxX, ra.maxY, rb.minX + sx, rb.minY + sy, rb.maxX + sx, rb.maxY + sy) - r >= best.d) continue;
                    ringDistance(ra, rb, sx, sy, r, best);
                }
            }
        }
    }
    if (best.found) {
        best.ax += A.ox; best.ay += A.oy; best.bx += A.ox; best.by += A.oy;
    }
    return best;
}

function orient(ax, ay, bx, by, cx, cy) {
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function ringsCross(ra, rb, sx, sy) {
    if (ra.maxX < rb.minX + sx || rb.maxX + sx < ra.minX || ra.maxY < rb.minY + sy || rb.maxY + sy < ra.minY) return false;
    const AX = ra.X, AY = ra.Y, an = ra.n, BX = rb.X, BY = rb.Y, bn = rb.n;
    for (let i = 0; i < ra.segCount; i++) {
        if (ra.sx1[i] < rb.minX + sx || rb.maxX + sx < ra.sx0[i] || ra.sy1[i] < rb.minY + sy || rb.maxY + sy < ra.sy0[i]) continue;
        const i2 = an === 1 ? 0 : (i + 1) % an;
        const ax = AX[i], ay = AY[i], bx = AX[i2], by = AY[i2];
        const la = Math.hypot(bx - ax, by - ay);
        if (la === 0) continue;
        for (let j = 0; j < rb.segCount; j++) {
            if (ra.sx1[i] < rb.sx0[j] + sx || rb.sx1[j] + sx < ra.sx0[i] || ra.sy1[i] < rb.sy0[j] + sy || rb.sy1[j] + sy < ra.sy0[i]) continue;
            const j2 = bn === 1 ? 0 : (j + 1) % bn;
            const cx = BX[j] + sx, cy = BY[j] + sy, dx = BX[j2] + sx, dy = BY[j2] + sy;
            const lb = Math.hypot(dx - cx, dy - cy);
            if (lb === 0) continue;
            const o1 = orient(ax, ay, bx, by, cx, cy) / la, o2 = orient(ax, ay, bx, by, dx, dy) / la;
            const o3 = orient(cx, cy, dx, dy, ax, ay) / lb, o4 = orient(cx, cy, dx, dy, bx, by) / lb;
            if (((o1 > CROSS_EPS && o2 < -CROSS_EPS) || (o1 < -CROSS_EPS && o2 > CROSS_EPS))
                && ((o3 > CROSS_EPS && o4 < -CROSS_EPS) || (o3 < -CROSS_EPS && o4 > CROSS_EPS))) return true;
        }
    }
    return false;
}

// Even-odd point in solid part + distance to its boundary.
function pointInPart(part, x, y) {
    let inside = false, d2 = Infinity;
    for (const ring of part.rings) {
        const X = ring.X, Y = ring.Y, n = ring.n;
        for (let i = 0; i < ring.segCount; i++) {
            const i2 = n === 1 ? 0 : (i + 1) % n;
            const x0 = X[i], y0 = Y[i], x1 = X[i2], y1 = Y[i2];
            if (ring.closed && ((y0 > y) !== (y1 > y)) && x < x0 + (y - y0) * (x1 - x0) / (y1 - y0)) inside = !inside;
            const vx = x1 - x0, vy = y1 - y0, len2 = vx * vx + vy * vy;
            let t = len2 > 0 ? ((x - x0) * vx + (y - y0) * vy) / len2 : 0;
            if (t < 0) t = 0; else if (t > 1) t = 1;
            const ex = x0 + t * vx - x, ey = y0 + t * vy - y;
            const dd = ex * ex + ey * ey;
            if (dd < d2) d2 = dd;
        }
    }
    return { inside, dist: Math.sqrt(d2) };
}

// Is some ring of `inner` (shifted by sx, sy) strictly inside the solid `part`?
function partContainsAny(part, inner, sx, sy) {
    if (!part.solid) return false;
    for (const ring of inner.rings) {
        if (ring.maxX + sx < part.minX || ring.minX + sx > part.maxX || ring.maxY + sy < part.minY || ring.minY + sy > part.maxY) continue;
        const tries = Math.min(ring.n, 9);
        for (let k = 0; k < tries; k++) {
            const idx = Math.floor(k * ring.n / tries);
            const res = pointInPart(part, ring.X[idx] + sx, ring.Y[idx] + sy);
            if (res.dist > CROSS_EPS * 10) {
                if (res.inside) return true;
                break; // without crossings, the whole ring is on one side
            }
        }
    }
    return false;
}

// True when the raw (un-inflated) outlines of A and B overlap (not just touch).
function objectsOverlap(A, B) {
    const sx = B.ox - A.ox, sy = B.oy - A.oy;
    if (A.maxX < B.minX + sx || B.maxX + sx < A.minX || A.maxY < B.minY + sy || B.maxY + sy < A.minY) return false;
    for (const pa of A.parts) {
        for (const pb of B.parts) {
            if (pa.maxX < pb.minX + sx || pb.maxX + sx < pa.minX || pa.maxY < pb.minY + sy || pb.maxY + sy < pa.minY) continue;
            for (const ra of pa.rings) for (const rb of pb.rings) if (ringsCross(ra, rb, sx, sy)) return true;
        }
    }
    for (const pa of A.parts) {
        for (const pb of B.parts) {
            if (pa.maxX < pb.minX + sx || pb.maxX + sx < pa.minX || pa.maxY < pb.minY + sy || pb.maxY + sy < pa.minY) continue;
            if (partContainsAny(pa, pb, sx, sy)) return true;
            if (partContainsAny(pb, pa, -sx, -sy)) return true;
        }
    }
    return false;
}

function overlapsAny(U, set) {
    for (const P of set) if (objectsOverlap(P, U)) return P;
    return null;
}

function clearanceToSet(U, set, limit) {
    let best = { d: limit === undefined ? Infinity : limit, found: false, other: null };
    for (const P of set) {
        const res = objectClearance(U, P, best.d);
        if (res.found && res.d < best.d) { best = res; best.other = P; }
    }
    return best;
}

// ---------------------------------------------------------------------------
// Motion strategies
// ---------------------------------------------------------------------------

function sizeOf(obj) {
    return Math.hypot(obj.maxX - obj.minX, obj.maxY - obj.minY) + 2 * obj.maxR;
}

// Walk U along (ux, uy) from its current offset and return the smallest t >= 0
// where U neither overlaps nor (with strokes) intrudes into any object of `set`.
function firstFreeAlong(U, set, ux, uy, tMax) {
    const baseX = U.ox, baseY = U.oy;
    const place = t => { U.ox = baseX + ux * t; U.oy = baseY + uy * t; };
    let step = 0;
    for (const P of set) step = Math.max(step, Math.min(sizeOf(P), sizeOf(U)));
    step = Math.max(step / 24, 0.25);
    let t = 0;
    let result = Infinity;
    for (let outer = 0; outer < 40; outer++) {
        place(t);
        if (overlapsAny(U, set)) {
            let lo = t, hi = t + step;
            place(hi);
            while (overlapsAny(U, set)) {
                lo = hi; hi += step;
                if (hi > tMax) { place(0); U.ox = baseX; U.oy = baseY; return Infinity; }
                place(hi);
            }
            for (let k = 0; k < 40 && hi - lo > 1e-9; k++) {
                const mid = (lo + hi) / 2;
                place(mid);
                if (overlapsAny(U, set)) lo = mid; else hi = mid;
            }
            t = hi;
            place(t);
        }
        // Raw outlines are free here; now honour stroke widths with conservative advancement.
        let ok = false;
        for (let k = 0; k < 200; k++) {
            const c = clearanceToSet(U, set).d;
            if (c >= -CONTACT_EPS) { ok = true; break; }
            t += -c;
            if (t > tMax) break;
            place(t);
            if (overlapsAny(U, set)) break;
        }
        if (ok) { result = t; break; }
        if (t > tMax) break;
    }
    U.ox = baseX; U.oy = baseY;
    return result;
}

// Find the shortest translation that separates U from `set` so that it just touches.
function pushOut(U, set) {
    const baseX = U.ox, baseY = U.oy;
    let tMax = sizeOf(U);
    for (const P of set) tMax += sizeOf(P);
    tMax *= 2;
    const tryAngle = angle => {
        const ux = Math.cos(angle), uy = Math.sin(angle);
        return { angle, ux, uy, t: firstFreeAlong(U, set, ux, uy, tMax) };
    };
    const N = 24;
    let best = null;
    const consider = cand => { if (cand.t < Infinity && (!best || cand.t < best.t - 1e-9)) best = cand; };
    for (let i = 0; i < N; i++) consider(tryAngle(i * 2 * Math.PI / N));
    const hit = overlapsAny(U, set);
    if (hit) {
        const ucx = U.cx + U.ox, ucy = U.cy + U.oy, pcx = hit.cx + hit.ox, pcy = hit.cy + hit.oy;
        if (Math.hypot(ucx - pcx, ucy - pcy) > 1e-9) consider(tryAngle(Math.atan2(ucy - pcy, ucx - pcx)));
    }
    if (!best) return false;
    let span = Math.PI / N;
    for (let level = 0; level < 6; level++) {
        const center = best.angle;
        consider(tryAngle(center - span));
        consider(tryAngle(center + span));
        span /= 2;
    }
    U.ox = baseX + best.ux * best.t;
    U.oy = baseY + best.uy * best.t;
    return true;
}

// Close the gap between U and `set` along the shortest connecting vector.
function closeGapShortest(U, set) {
    const res = clearanceToSet(U, set);
    if (!res.found || res.d <= CONTACT_EPS) return res.found;
    const vx = res.bx - res.ax, vy = res.by - res.ay;
    const len = Math.hypot(vx, vy);
    if (len < 1e-12) return false;
    U.ox += vx / len * res.d;
    U.oy += vy / len * res.d;
    return true;
}

// Move U toward `target` (shortest direction to target), stopping at the first
// contact with anything in `set` (conservative advancement, never tunnels).
function closeGapToward(U, target, set) {
    const res = objectClearance(U, target, Infinity);
    if (!res.found || res.d <= CONTACT_EPS) return;
    const vx = res.bx - res.ax, vy = res.by - res.ay;
    const len = Math.hypot(vx, vy);
    if (len < 1e-12) return;
    const ux = vx / len, uy = vy / len;
    const baseX = U.ox, baseY = U.oy;
    let t = 0;
    for (let k = 0; k < 600; k++) {
        U.ox = baseX + ux * t; U.oy = baseY + uy * t;
        const c = clearanceToSet(U, set).d;
        if (c <= CONTACT_EPS) return;
        t += c;
        if (t > res.d + CONTACT_EPS) { t = res.d; U.ox = baseX + ux * t; U.oy = baseY + uy * t; return; }
    }
}

function needsSeparation(U, set) {
    if (overlapsAny(U, set)) return true;
    return clearanceToSet(U, set).d < -CONTACT_EPS;
}

function attach(U, placed, target, options, report) {
    if (needsSeparation(U, placed)) {
        if (!options.separate) { report.keptOverlap.push(U.name); return; }
        if (!pushOut(U, placed)) report.failed.push(U.name);
        return;
    }
    if (target) closeGapToward(U, target, placed);
    else closeGapShortest(U, placed);
}

function chooseAnchor(objects, anchorMode) {
    if (anchorMode === 1) return objects[0];
    if (anchorMode === 2) return objects[objects.length - 1];
    let best = objects[0];
    for (const obj of objects) if (obj.area > best.area + 1e-9) best = obj;
    return best;
}

// ---------------------------------------------------------------------------
// Internal tangency: an element is moved inside a container until it touches
// the container's inner edge (or an element already placed inside it).
// ---------------------------------------------------------------------------

const COARSE_DIVISOR = 600;       // coarse outline tolerance = element size / this
const INSIDE_DIRECTIONS = 24;

function ownCache(obj, key, make) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) obj[key] = make();
    return obj[key];
}

// Views share the object's offsets (ox, oy are read through the prototype),
// so they must never be written to.
function viewWithParts(obj, parts) {
    const view = Object.create(obj);
    view.parts = parts;
    view.maxR = parts.reduce((m, p) => Math.max(m, p.r), 0);
    return view;
}

// The container seen from inside: its stroke reaches inward by rIn.
function innerView(C) {
    return ownCache(C, '_inner', () => viewWithParts(C, C.parts.map(part => {
        const q = Object.create(part);
        q.r = part.rIn;
        return q;
    })));
}

// Douglas-Peucker simplified ring (used only to search for a position quickly).
function simplifyRing(ring, tol) {
    const n = ring.n;
    if (n <= 12) return ring;
    const X = ring.X, Y = ring.Y, tol2 = tol * tol;
    const keep = new Uint8Array(n);
    let far = 0, farD = -1;
    for (let i = 1; i < n; i++) {
        const d = (X[i] - X[0]) * (X[i] - X[0]) + (Y[i] - Y[0]) * (Y[i] - Y[0]);
        if (d > farD) { farD = d; far = i; }
    }
    keep[0] = 1; keep[far] = 1;
    const stack = [];
    if (ring.closed) stack.push(0, far, far, n);
    else { keep[n - 1] = 1; stack.push(0, n - 1); }
    while (stack.length) {
        const b = stack.pop(), a = stack.pop();
        if (b - a < 2) continue;
        const ax = X[a], ay = Y[a], bx = X[b % n], by = Y[b % n];
        const vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy;
        let maxD = -1, at = -1;
        for (let k = a + 1; k < b; k++) {
            const px = X[k] - ax, py = Y[k] - ay;
            let t = len2 > 0 ? (px * vx + py * vy) / len2 : 0;
            if (t < 0) t = 0; else if (t > 1) t = 1;
            const dx = px - t * vx, dy = py - t * vy;
            const d = dx * dx + dy * dy;
            if (d > maxD) { maxD = d; at = k; }
        }
        if (maxD > tol2) { keep[at] = 1; stack.push(a, at, at, b); }
    }
    const xs = [], ys = [];
    for (let i = 0; i < n; i++) if (keep[i]) { xs.push(X[i]); ys.push(Y[i]); }
    return makeRing(xs, ys, ring.closed) || ring;
}

function coarseTolerance(obj) {
    return Math.max(FLATTEN_TOLERANCE, sizeOf(obj) / COARSE_DIVISOR);
}

function coarseView(obj) {
    return ownCache(obj, '_coarse', () => {
        const tol = coarseTolerance(obj);
        return viewWithParts(obj, obj.parts.map(part => {
            const q = makePart(part.rings.map(ring => simplifyRing(ring, tol)), part.r, part.rIn);
            q.solid = part.solid;
            return q;
        }));
    });
}

function coarseInnerView(C) {
    return ownCache(C, '_coarseInner', () => innerView(coarseView(C)));
}

function hasArea(obj) {
    return obj.parts.some(part => part.solid);
}

// True when the raw outline of U lies entirely inside the filled area of C.
function containedIn(U, C) {
    const sx = U.ox - C.ox, sy = U.oy - C.oy;
    if (U.minX + sx < C.minX || U.maxX + sx > C.maxX || U.minY + sy < C.minY || U.maxY + sy > C.maxY) return false;
    for (const pc of C.parts) {
        for (const pu of U.parts) {
            if (pc.maxX < pu.minX + sx || pu.maxX + sx < pc.minX || pc.maxY < pu.minY + sy || pu.maxY + sy < pc.minY) continue;
            for (const rc of pc.rings) for (const ru of pu.rings) if (ringsCross(rc, ru, sx, sy)) return false;
        }
    }
    for (const pu of U.parts) {
        let inside = false;
        for (const pc of C.parts) if (partContainsAny(pc, pu, sx, sy)) { inside = true; break; }
        if (!inside) return false;
    }
    // A hole (or another part) of C inside U means U is not in the filled area.
    for (const pc of C.parts) for (const pu of U.parts) if (partContainsAny(pu, pc, -sx, -sy)) return false;
    return true;
}

// U is inside C (strokes included) and overlaps none of the siblings.
function insideValid(U, C, Cin, sibs) {
    if (!containedIn(U, C)) return false;
    if (objectClearance(U, Cin, 0).d < -CONTACT_EPS) return false;
    for (let i = 0; i < sibs.length; i++) {
        if (objectsOverlap(sibs[i], U)) return false;
        if (objectClearance(U, sibs[i], 0).d < -CONTACT_EPS) return false;
    }
    return true;
}

// q = { real, U, C, Cin, sibs, baseX, baseY }: U/C/Cin/sibs are the geometry
// used for testing, `real` is the element whose offset is moved.
function insideValidAt(q, ux, uy, t) {
    q.real.ox = q.baseX + ux * t;
    q.real.oy = q.baseY + uy * t;
    return insideValid(q.U, q.C, q.Cin, q.sibs);
}

// Smallest t in (0, tMax] where the element is valid when moved along (ux, uy).
function firstInsideAlong(q, ux, uy, tMax, step, precision) {
    for (let t = step; t <= tMax + step * 1e-6; t += step) {
        if (!insideValidAt(q, ux, uy, t)) continue;
        let lo = t - step, hi = t;
        while (hi - lo > precision) {
            const mid = (lo + hi) / 2;
            if (insideValidAt(q, ux, uy, mid)) hi = mid; else lo = mid;
        }
        return hi;
    }
    return Infinity;
}

// Exact contact near the coarse result tc (t = 0 is known to be invalid).
function refineInsideAlong(q, ux, uy, tc, w) {
    let hi = tc + w, tries = 0;
    while (!insideValidAt(q, ux, uy, hi)) {
        if (++tries > 8) return Infinity;
        hi += w;
    }
    let lo = Math.max(0, tc - w);
    if (lo > 0 && insideValidAt(q, ux, uy, lo)) lo = 0;
    while (hi - lo > 1e-5) {
        const mid = (lo + hi) / 2;
        if (insideValidAt(q, ux, uy, mid)) hi = mid; else lo = mid;
    }
    return hi;
}

// Shortest translation that brings U fully inside C (touching), clear of sibs.
// Searches on simplified outlines first, then refines on the exact outlines.
function pushInside(U, C, sibs) {
    const baseX = U.ox, baseY = U.oy;
    const coarse = { real: U, U: coarseView(U), C: coarseView(C), Cin: coarseInnerView(C), sibs: sibs.map(coarseView), baseX, baseY };
    const tol = Math.max(coarseTolerance(U), coarseTolerance(C), ...sibs.map(coarseTolerance));
    const dcx = (C.cx + C.ox) - (U.cx + U.ox), dcy = (C.cy + C.oy) - (U.cy + U.oy);
    const tMax = Math.hypot(dcx, dcy) + sizeOf(U) + sizeOf(C);
    let step = Math.max(Math.min(sizeOf(U), sizeOf(C)) / 40, 0.25);
    let best = null;
    const consider = angle => {
        const ux = Math.cos(angle), uy = Math.sin(angle);
        const limit = best ? best.t : tMax;
        const t = firstInsideAlong(coarse, ux, uy, limit, step, tol / 4);
        if (t < limit - 1e-9) best = { angle, ux, uy, t };
    };
    for (let pass = 0; pass < 2 && !best; pass++) {
        if (Math.hypot(dcx, dcy) > 1e-9) consider(Math.atan2(dcy, dcx));
        for (let i = 0; i < INSIDE_DIRECTIONS; i++) consider(i * 2 * Math.PI / INSIDE_DIRECTIONS);
        step /= 4;   // second pass for elements that only just fit
    }
    if (!best) { U.ox = baseX; U.oy = baseY; return false; }
    let span = Math.PI / INSIDE_DIRECTIONS;
    for (let level = 0; level < 6; level++) {
        const center = best.angle;
        consider(center - span);
        consider(center + span);
        span /= 2;
    }
    const exact = { real: U, U, C, Cin: innerView(C), sibs, baseX, baseY };
    const t = refineInsideAlong(exact, best.ux, best.uy, best.t, 3 * tol + 1e-3);
    if (t === Infinity) { U.ox = baseX; U.oy = baseY; return false; }
    U.ox = baseX + best.ux * t;
    U.oy = baseY + best.uy * t;
    return true;
}

function overlapsSibling(U, sibs) {
    for (const S of sibs) if (objectsOverlap(S, U) || objectClearance(U, S, 0).d < -CONTACT_EPS) return true;
    return false;
}

function attachInside(U, C, sibs, toward, options, report) {
    if (!hasArea(C)) { report.noFit.push(U.name); return; }
    const Cin = innerView(C);
    const inside = containedIn(U, C) && objectClearance(U, Cin, 0).d >= -CONTACT_EPS;
    const hit = overlapsSibling(U, sibs);
    if (inside && hit && !options.separate) { report.keptOverlap.push(U.name); return; }
    if (!inside || hit) {
        if (!pushInside(U, C, sibs)) report.noFit.push(U.name);
        return;
    }
    const set = [Cin].concat(sibs);
    if (toward) closeGapToward(U, Cin, set);
    else closeGapShortest(U, set);
}

// Ordering key: elements already inside first, then by distance to the inner edge
// (Cluster also counts elements already placed inside).
function insideOrderKey(U, C, placed) {
    const Uc = coarseView(U);
    let d = objectClearance(Uc, coarseInnerView(C), Infinity).d;
    for (const S of placed) d = Math.min(d, objectClearance(Uc, coarseView(S), d).d);
    return (containedIn(Uc, coarseView(C)) ? 0 : 1e12) + d;
}

// Single selection: the smallest unselected element that overlaps (or contains)
// the element and is larger than it; otherwise the nearest larger one.
function pickContainer(U, obstacles) {
    const larger = obstacles.filter(o => hasArea(o) && o.area > U.area + 1e-9);
    if (!larger.length) return null;
    const over = larger.filter(o => objectsOverlap(o, U));
    if (over.length) return over.reduce((a, b) => (b.area < a.area ? b : a));
    let best = null, bestD = Infinity;
    for (const o of larger) {
        const d = objectClearance(coarseView(U), coarseView(o), bestD).d;
        if (d < bestD) { bestD = d; best = o; }
    }
    return best || larger[0];
}

function solveInside(state, options, report) {
    const objects = state.objects;
    if (state.single) {
        const U = objects[0];
        const C = pickContainer(U, state.obstacles);
        if (!C) throw new Error('No unselected closed shape larger than the element was found to snap into.');
        report.container = C.name;
        attachInside(U, C, [], false, options, report);
        return report;
    }
    if (options.mode === 2) {
        // Chain: each element is inscribed in the previous one.
        for (let i = 1; i < objects.length; i++) attachInside(objects[i], objects[i - 1], [], false, options, report);
        return report;
    }
    const C = chooseAnchor(objects, options.anchor);
    if (!hasArea(C)) throw new Error('The anchor "' + C.name + '" has no closed area to hold other elements.');
    report.container = C.name;
    const placed = [];
    const remaining = objects.filter(o => o !== C);
    if (options.mode === 1) {
        // To Anchor: nearest first, each moves straight toward the closest point of the inner edge.
        const order = remaining.map(o => ({ o, k: insideOrderKey(o, C, []) })).sort((a, b) => a.k - b.k).map(e => e.o);
        for (const U of order) { attachInside(U, C, placed, true, options, report); placed.push(U); }
        return report;
    }
    // Cluster: repeatedly place the element closest to the inner edge or to an element already placed.
    while (remaining.length) {
        let pick = 0, pickK = Infinity;
        for (let i = 0; i < remaining.length; i++) {
            const k = insideOrderKey(remaining[i], C, placed);
            if (k < pickK) { pickK = k; pick = i; }
        }
        const U = remaining.splice(pick, 1)[0];
        attachInside(U, C, placed, false, options, report);
        placed.push(U);
    }
    return report;
}

function solve(state, options) {
    const objects = state.objects;
    for (const obj of objects) { obj.ox = 0; obj.oy = 0; }
    for (const obs of state.obstacles) { obs.ox = 0; obs.oy = 0; }
    const report = { keptOverlap: [], failed: [], ignored: [], noFit: [], container: null };
    if (options.inside) return solveInside(state, options, report);

    if (state.single) {
        const U = objects[0];
        // Obstacles the element already sits on (e.g. a background) are ignored.
        const usable = state.obstacles.filter(o => !objectsOverlap(o, U));
        report.ignored = state.obstacles.filter(o => !usable.includes(o)).map(o => o.name);
        if (!usable.length) throw new Error('No unselected element is available to snap to.');
        const res = clearanceToSet(U, usable);
        if (res.d < -CONTACT_EPS) {
            if (options.separate) pushOut(U, usable); else report.keptOverlap.push(U.name);
        } else {
            closeGapShortest(U, usable);
        }
        return report;
    }

    if (options.mode === 2) {
        // Chain: selection order, each element joins the previous one.
        const placed = [objects[0]];
        for (let i = 1; i < objects.length; i++) {
            attach(objects[i], placed, objects[i - 1], options, report);
            placed.push(objects[i]);
        }
        return report;
    }

    const anchor = chooseAnchor(objects, options.anchor);
    const placed = [anchor];
    const remaining = objects.filter(o => o !== anchor);

    if (options.mode === 1) {
        // To Anchor: nearest elements first, each moves straight toward the anchor.
        const order = remaining.map(o => ({ o, d: objectClearance(o, anchor, Infinity).d }))
            .sort((a, b) => a.d - b.d).map(e => e.o);
        for (const U of order) {
            attach(U, placed, anchor, options, report);
            placed.push(U);
        }
        return report;
    }

    // Cluster: repeatedly attach the element closest to the already-placed group.
    const info = new Map();
    for (const U of remaining) {
        info.set(U, overlapsAny(U, placed) ? { d: -Infinity, found: true } : clearanceToSet(U, placed));
    }
    while (remaining.length) {
        let pick = 0, pickD = Infinity;
        for (let i = 0; i < remaining.length; i++) {
            const d = info.get(remaining[i]).d;
            if (d < pickD) { pickD = d; pick = i; }
        }
        const U = remaining.splice(pick, 1)[0];
        attach(U, placed, null, options, report);
        placed.push(U);
        for (const other of remaining) {
            const current = info.get(other);
            if (current.d === -Infinity) continue;
            if (objectsOverlap(U, other)) { info.set(other, { d: -Infinity, found: true }); continue; }
            const res = objectClearance(other, U, current.d);
            if (res.found && res.d < current.d) info.set(other, res);
        }
    }
    return report;
}

// ---------------------------------------------------------------------------
// Document integration
// ---------------------------------------------------------------------------

function selectedNodes(doc) {
    const nodes = [];
    for (let i = 0; i < doc.selection.length; i++) {
        const node = doc.selection.at(i).node;
        if (node) nodes.push(node);
    }
    return nodes;
}

function rejectNestedSelection(nodes) {
    for (const node of nodes) {
        let parent = node.parent;
        while (parent) {
            if (nodes.some(other => other.isSameNode(parent))) {
                throw new Error('Select either a group or its children, not both.');
            }
            parent = parent.parent;
        }
    }
}

function isObstacleCandidate(node) {
    if (getCurvesInterface(node)) return true;
    return !!(node.isGroupNode || node.isImageNode || node.isRasterNode);
}

function collectObstacles(spread, selected, options) {
    const result = [];
    const isSelected = n => selected.some(s => s.isSameNode(n));
    const containsSelected = n => selected.some(s => {
        for (let p = s.parent; p; p = p.parent) if (p.isSameNode(n)) return true;
        return false;
    });
    const walk = (node, depth) => {
        if (depth > 64 || isHidden(node) || isSelected(node)) return;
        if (containsSelected(node) || isArtboard(node) || (node.isContainerNode && !getCurvesInterface(node))) {
            for (const child of childList(node)) walk(child, depth + 1);
            return;
        }
        if (!isObstacleCandidate(node)) return;
        const obj = buildObject(node, options, -1);
        if (obj) result.push(obj);
    };
    for (const child of childList(spread)) walk(child, 0);
    return result;
}

function buildState(doc, nodes, options) {
    const objects = [];
    const skipped = [];
    nodes.forEach((node, index) => {
        const name = node.userDescription || node.defaultDescription || 'Element';
        if (isArtboard(node)) { skipped.push(name + ' (artboard)'); return; }
        const obj = buildObject(node, options, index);
        if (obj) objects.push(obj); else skipped.push(name + ' (no outline)');
    });
    if (!objects.length) throw new Error('None of the selected elements has an outline that can be used.');
    const single = objects.length === 1;
    const obstacles = single ? collectObstacles(nodes[0].spread, nodes, options) : [];
    if (single && !obstacles.length) throw new Error('Only one element is selected and there is no other element on this spread to snap it to.');
    return { objects, obstacles, single, skipped };
}

function buildCommand(doc, objects) {
    const commands = [];
    for (const obj of objects) {
        if (Math.hypot(obj.ox, obj.oy) < 1e-9) continue;
        commands.push(DocumentCommand.createTransform(Selection.create(doc, obj.node), Transform.createTranslate(obj.ox, obj.oy)));
    }
    if (!commands.length) return { command: null, moved: 0 };
    if (commands.length === 1) return { command: commands[0], moved: 1 };
    const builder = CompoundCommandBuilder.create();
    for (const command of commands) builder.addCommand(command);
    return { command: builder.createCommand(), moved: commands.length };
}

// Geometry depends on whether strokes count, so cache one state per stroke setting.
function makeStateProvider(doc, nodes) {
    const cache = new Map();
    return options => {
        const key = options.includeStroke ? 'stroke' : 'geometry';
        if (!cache.has(key)) cache.set(key, buildState(doc, nodes, options));
        return cache.get(key);
    };
}

function compute(getState, options) {
    const state = getState(options);
    const report = solve(state, options);
    return { state, report, options };
}

function summarize(result, moved) {
    const lines = [];
    const { state, report } = result;
    const problems = report.keptOverlap.length + report.failed.length + report.noFit.length;
    lines.push(moved ? 'Moves ' + moved + ' element(s) into ' + (result.options.inside ? 'internal' : 'tangent') + ' contact.'
        : (problems ? 'Nothing to move.' : 'Elements already touch; nothing to move.'));
    if (report.keptOverlap.length) lines.push('Overlapping, left in place: ' + report.keptOverlap.join(', '));
    if (report.failed.length) lines.push('Could not separate: ' + report.failed.join(', '));
    if (report.noFit.length) lines.push('Does not fit inside: ' + report.noFit.join(', '));
    if (report.container) lines.push('Container: ' + report.container);
    if (report.ignored.length) lines.push('Ignored (already overlapping): ' + report.ignored.length + ' element(s).');
    if (state.skipped.length) lines.push('Skipped: ' + state.skipped.join(', '));
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

function buildDialog() {
    const dialog = Dialog.create(SCRIPT_TITLE);
    dialog.initialWidth = 420;
    const column = dialog.addColumn();
    const arrange = column.addGroup('Arrangement');
    dialog.tangency = arrange.addButtonSet('Tangency', TANGENCIES, 0);
    dialog.mode = arrange.addButtonSet('Mode', MODES, 0);
    dialog.anchor = arrange.addComboBox('Anchor', ANCHORS, 0);
    dialog.info = arrange.addStaticText(null, '').setIsFullWidth();
    const contact = column.addGroup('Contact');
    dialog.includeStroke = contact.addSwitch('Include stroke width', true);
    dialog.separate = contact.addSwitch('Separate overlapping elements', true);
    const preview = column.addGroup('Preview');
    dialog.preview = preview.addSwitch('Preview', true);
    dialog.status = preview.addStaticText(null, 'Preview updates the canvas as you change options.').setIsFullWidth();
    return dialog;
}

function infoText(single, count, inside, mode) {
    if (single) {
        return inside
            ? 'One element selected: it moves inside the smallest unselected shape that overlaps it (or the nearest larger one) until it touches its inner edge.'
            : 'One element selected: it moves to touch the nearest unselected element.';
    }
    if (!inside) {
        return count + ' elements selected. Cluster: each joins the nearest placed element. To Anchor: each moves straight toward the anchor. Chain: selection order, each touches the previous one.';
    }
    return [
        count + ' elements selected. The anchor is the container: each element moves inside it along the shortest path until it touches the inner edge or an element already placed.',
        count + ' elements selected. The anchor is the container: nearest first, each element moves straight toward the closest point of its inner edge and stops at the first contact.',
        count + ' elements selected. Selection order: each element is inscribed in the previous one, touching its inner edge.'
    ][mode] || '';
}

function updateControls(dialog, single, count) {
    dialog.mode.isEnabled = !single;
    dialog.anchor.isEnabled = !single && dialog.mode.selectedIndex !== 2;
    dialog.info.text = infoText(single, count, dialog.tangency.selectedIndex === 1, dialog.mode.selectedIndex);
}

function readOptions(dialog) {
    return {
        inside: dialog.tangency.selectedIndex === 1,
        mode: dialog.mode.selectedIndex,
        anchor: dialog.anchor.selectedIndex,
        includeStroke: !!dialog.includeStroke.value,
        separate: !!dialog.separate.value
    };
}

function compactError(error) {
    return String(error && error.message ? error.message : error).replace(/\s+/g, ' ').trim();
}

function main() {
    const doc = Document.current;
    if (!doc) { app.alert('Please open a document first.', SCRIPT_TITLE); return; }
    try {
        const nodes = selectedNodes(doc);
        if (!nodes.length) throw new Error('Select one or more elements first.');
        rejectNestedSelection(nodes);
        const spread = nodes[0].spread;
        if (!nodes.every(n => n.spread && n.spread.isSameNode(spread))) throw new Error('All selected elements must be on the same spread.');
        if (doc.currentSpread && !doc.currentSpread.isSameNode(spread)) {
            doc.executeCommand(DocumentCommand.createSetCurrentSpread(spread));
        }

        const getState = makeStateProvider(doc, nodes);
        const single = getState({ includeStroke: true }).single;
        const count = getState({ includeStroke: true }).objects.length;
        const dialog = buildDialog();
        updateControls(dialog, single, count);

        let pendingTimer = null;
        let generation = 0;
        let closing = false;
        let lastSignature = null;
        const clearPreview = () => { try { doc.clearPreviews(); } catch (_) { /* nothing to clear */ } };
        const cancelPending = () => {
            generation += 1;
            const timer = pendingTimer;
            pendingTimer = null;
            if (!timer) return;
            try { timer.cancel(); } catch (_) { /* already fired */ }
            try { timer.dispose(); } catch (_) { /* already disposed */ }
        };
        const refresh = () => {
            if (closing) return;
            const options = readOptions(dialog);
            const enabled = !!dialog.preview.value;
            const signature = JSON.stringify({ options, enabled });
            if (signature === lastSignature) return;
            clearPreview();
            if (!enabled) { dialog.status.text = 'Preview is off.'; lastSignature = signature; return; }
            try {
                const result = compute(getState, options);
                const built = buildCommand(doc, result.state.objects);
                if (built.command) doc.executeCommand(built.command, true);
                dialog.status.text = summarize(result, built.moved);
                lastSignature = signature;
            } catch (error) {
                clearPreview();
                lastSignature = null;
                dialog.status.text = 'Preview failed: ' + compactError(error);
            }
        };
        const schedule = () => {
            if (closing) return;
            updateControls(dialog, single, count);
            cancelPending();
            const myGeneration = generation;
            const timer = Timer.create();
            pendingTimer = timer;
            try {
                timer.expiryFromNow = PREVIEW_DEBOUNCE_MS;
                timer.waitAsync(errorCode => {
                    if (pendingTimer === timer) pendingTimer = null;
                    try { timer.dispose(); } catch (_) { /* disposed */ }
                    if (errorCode || closing || myGeneration !== generation) return;
                    refresh();
                });
            } catch (error) {
                if (pendingTimer === timer) pendingTimer = null;
                dialog.status.text = 'Preview could not be scheduled: ' + compactError(error);
            }
        };
        dialog.onControlValueChangedHandler = schedule;
        schedule();

        let dialogResult;
        try {
            dialogResult = dialog.runModal();
        } finally {
            closing = true;
            cancelPending();
            clearPreview();
        }
        if ((dialogResult?.value ?? dialogResult) !== DialogResult.Ok.value) return;

        const options = readOptions(dialog);
        const result = compute(getState, options);
        const built = buildCommand(doc, result.state.objects);
        if (built.command) doc.executeCommand(built.command, false);
        const { report, state } = result;
        const warnings = [...report.keptOverlap.map(n => 'Overlapping, left in place: ' + n),
            ...report.failed.map(n => 'Could not separate: ' + n),
            ...report.noFit.map(n => 'Does not fit inside: ' + n),
            ...state.skipped.map(n => 'Skipped: ' + n)];
        if (!built.command) app.alert((warnings.length ? 'Nothing was moved.' : 'The selected elements already touch. Nothing was moved.') + (warnings.length ? '\n\n' + warnings.join('\n') : ''), SCRIPT_TITLE);
        else if (warnings.length) app.alert('Moved ' + built.moved + ' element(s).\n\n' + warnings.join('\n'), SCRIPT_TITLE);
    } catch (error) {
        try { doc.clearPreviews(); } catch (_) { /* nothing to clear */ }
        app.alert(compactError(error), SCRIPT_TITLE);
    }
}

main();
