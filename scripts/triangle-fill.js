// Triangle Fill (v19)
// Fills selected closed vector shapes and artistic text completely with triangles.
//
// NEW v19:
// - Multiple selection: any number of curves/shapes are filled in ONE pass with the same
//   parameters (one group "TriangleFill_N" per object, directly above the object).
//   Selected groups are resolved (contained shapes/texts are filled individually).
// - Artistic text (and frame text): ALL characters at once. The text is converted to curves
//   internally on a duplicate, the glyph outlines (incl. counters as in "O", "e") are read and
//   the conversion is rolled back immediately - the text itself stays unchanged and editable.
//   All triangles of a text end up in ONE group above the text.
//   (v18 filled a wrong contour for text: the curves of a text node are not the glyph outlines.)
// - "Count applies": per object (every object gets the target count, for text distributed
//   over the characters by area) or for all together (distributed over all objects by area).
// - Colour per character taken from the character fill (differently coloured characters are kept).
//
// v18: no curve conversion of the original shape, rollback until group gone, position fix as compound.
// v17: toColour() for gradient stops (3.3.3). v16: angle band [Min..Max]. v15: recalculation on OK.
// v14: Blur-Shadow dialog concept, preset prefix "DF_" (identical to the German version,
//      presets are interchangeable), delete preset.
//
// LIMITATIONS:
// - No true constrained Delaunay with edge recovery.
// - Gradient per triangle is an approximation (3-stop linear along one axis).
// - Grid mode ignores the angle parameters completely.
// - Very small characters get somewhat more triangles than their share due to the minimum
//   number of boundary points.

(function () {
    const { Document } = require('/document');
    const { Selection } = require('/selections');
    const { DocumentCommand, NodeChildType, AddChildNodesCommandBuilder, CompoundCommandBuilder } = require('/commands');
    const { NodeMoveType } = require('affinity:dom');
    const { CurveBuilder, PolyCurve, Transform } = require('/geometry');
    const { Dialog, DialogResult } = require('/dialog');
    const { app } = require('/application');
    const { File, createDirectories, remove } = require('/fs');
    const NodesM = require('/nodes');
    const { FillDescriptor, GradientFill, GradientFillType, BlendMode } = require('/fills');
    const { Colour, Gradient } = require('/colours');

    const TITLE = 'Triangle Fill';
    const GROUP_PREFIX = 'TriangleFill';
    function toColour(c) { return (c instanceof Colour) ? c : new Colour(c); }

    const doc = Document.current;
    if (!doc) { app.alert('No document open.', TITLE); return; }

    // ---------------- Preview management ----------------
    // Every created group is remembered with the number of its history steps. Discarding = undo
    // until the FIRST group is gone (creating it is the first own entry), then a safety net.
    let currentRecs = [];
    function nodeInDoc(n) {
        if (!n) return false;
        try { for (const l of doc.layers.all) if (l.isSameNode(n)) return true; } catch (e) { }
        return false;
    }
    function discardCurrent() {
        const recs = currentRecs; currentRecs = [];
        if (!recs.length) return;
        const first = recs.find(r => r.group);
        let total = 0;
        for (const r of recs) total += r.steps;
        let k = 0;
        if (first) {
            while (nodeInDoc(first.group) && k < total + 4) { try { doc.history.undo(); } catch (e) { break; } k++; }
        }
        const rest = recs.filter(r => r.group && nodeInDoc(r.group)).map(r => r.group);
        if (rest.length) {
            try { doc.executeCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, rest), true)); } catch (e) { }
        }
    }

    function isVectorNode(node) { return !!node.curvesInterface; }
    function isTextNode(node) { try { return !!node.isTextNode || !!node.storyInterface; } catch (e) { return false; } }
    function isClosedNode(node) {
        try {
            const pc = node.curvesInterface.polyCurve;
            if (pc.curveCount === 0) return false;
            for (const c of pc.curves) { if (!c.isClosed) return false; }
            return true;
        } catch (e) { return false; }
    }
    function hasChildren(node) { try { return node.children && node.children.length > 0; } catch (e) { return false; } }

    function mulberry32(seed) {
        let a = seed >>> 0;
        return function () {
            a |= 0; a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function copyData(d) { return { 0: d[0], 1: d[1], 2: d[2], 3: d[3], 4: d[4], 5: d[5] }; }
    function matMulData(A, B) {
        return {
            0: A[0] * B[0] + A[1] * B[3], 1: A[0] * B[1] + A[1] * B[4], 2: A[0] * B[2] + A[1] * B[5] + A[2],
            3: A[3] * B[0] + A[4] * B[3], 4: A[3] * B[1] + A[4] * B[4], 5: A[3] * B[2] + A[4] * B[5] + A[5]
        };
    }
    function invertData(M) {
        const det = M[0] * M[4] - M[1] * M[3];
        if (Math.abs(det) < 1e-12) return null;
        return {
            0: M[4] / det, 1: -M[1] / det, 2: (M[1] * M[5] - M[4] * M[2]) / det,
            3: -M[3] / det, 4: M[0] / det, 5: (M[3] * M[2] - M[0] * M[5]) / det
        };
    }
    function isIdentityData(M) {
        return Math.abs(M[0] - 1) < 1e-9 && Math.abs(M[1]) < 1e-9 && Math.abs(M[2]) < 1e-9 &&
               Math.abs(M[3]) < 1e-9 && Math.abs(M[4] - 1) < 1e-9 && Math.abs(M[5]) < 1e-9;
    }
    function dataToTransform(d) {
        const tf = Transform.createIdentity();
        const td = tf.data;
        td[0] = d[0]; td[1] = d[1]; td[2] = d[2]; td[3] = d[3]; td[4] = d[4]; td[5] = d[5];
        return tf;
    }
    function detData(d) { return Math.abs(d[0] * d[4] - d[1] * d[3]); }

    // ---------------- Geometry core ----------------

    function dist(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); }

    function circumcircle(a, b, c) {
        const ax = a.x, ay = a.y, bx = b.x, by = b.y, cx = c.x, cy = c.y;
        const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
        if (Math.abs(d) < 1e-12) return null;
        const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
        const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
        const r = Math.sqrt((ax - ux) * (ax - ux) + (ay - uy) * (ay - uy));
        return { x: ux, y: uy, r: r };
    }

    function makeSuperTriangle(pts) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of pts) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
        const dx = maxX - minX, dy = maxY - minY, dmax = Math.max(dx, dy, 1) * 20;
        const midx = (minX + maxX) / 2, midy = (minY + maxY) / 2;
        return [{ x: midx - dmax, y: midy - dmax }, { x: midx + dmax, y: midy - dmax }, { x: midx, y: midy + dmax }];
    }

    function makeTri(i, j, k, pts) { return { v: [i, j, k], cc: circumcircle(pts[i], pts[j], pts[k]) }; }

    class Triangulator {
        constructor(boundaryPts, cellSize) {
            const st = makeSuperTriangle(boundaryPts);
            this.pts = boundaryPts.slice();
            this.superStart = this.pts.length;
            this.pts.push(st[0], st[1], st[2]);
            this.superIdx = new Set([this.superStart, this.superStart + 1, this.superStart + 2]);
            this.tris = [makeTri(this.superStart, this.superStart + 1, this.superStart + 2, this.pts)];
            this.cellSize = Math.max(cellSize || 1, 1e-6);
            this.grid = new Map();
            for (let i = 0; i < this.superStart; i++) this._insertExistingIndex(i);
            for (let i = 0; i < this.superStart; i++) this._gridAdd(i);
        }
        _cellKey(x, y) { return Math.floor(x / this.cellSize) + '_' + Math.floor(y / this.cellSize); }
        _gridAdd(idx) {
            const p = this.pts[idx];
            const k = this._cellKey(p.x, p.y);
            let arr = this.grid.get(k);
            if (!arr) { arr = []; this.grid.set(k, arr); }
            arr.push(idx);
        }
        nearAny(p, minDist) {
            const cx = Math.floor(p.x / this.cellSize), cy = Math.floor(p.y / this.cellSize);
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    const arr = this.grid.get((cx + dx) + '_' + (cy + dy));
                    if (!arr) continue;
                    for (const idx of arr) { if (dist(p, this.pts[idx]) < minDist) return true; }
                }
            }
            return false;
        }
        _cavity(p) {
            const bad = [];
            for (const t of this.tris) { const cc = t.cc; if (cc && dist(p, cc) <= cc.r + 1e-7) bad.push(t); }
            const edgeCount = new Map();
            function edgeKey(a, b) { return a < b ? a + '_' + b : b + '_' + a; }
            for (const t of bad) {
                const [a, b, c] = t.v;
                for (const [u, v] of [[a, b], [b, c], [c, a]]) {
                    const k = edgeKey(u, v);
                    if (!edgeCount.has(k)) edgeCount.set(k, { u, v, count: 0 });
                    edgeCount.get(k).count++;
                }
            }
            const boundary = [];
            for (const e of edgeCount.values()) if (e.count === 1) boundary.push([e.u, e.v]);
            return { bad, boundary };
        }
        _removeBad(bad) {
            if (!bad.length) return;
            const s = new Set(bad);
            this.tris = this.tris.filter(t => !s.has(t));
        }
        _insertExistingIndex(pIdx) {
            const { bad, boundary } = this._cavity(this.pts[pIdx]);
            this._removeBad(bad);
            for (const [u, v] of boundary) this.tris.push(makeTri(u, v, pIdx, this.pts));
        }
        insertPoint(p) {
            const idx = this.pts.length;
            this.pts.push(p);
            this._gridAdd(idx);
            const { bad, boundary } = this._cavity(p);
            this._removeBad(bad);
            const added = [];
            for (const [u, v] of boundary) { const nt = makeTri(u, v, idx, this.pts); this.tris.push(nt); added.push(nt); }
            return { idx: idx, removed: bad, added: added };
        }
        rawTriangles() {
            return this.tris.filter(t => !this.superIdx.has(t.v[0]) && !this.superIdx.has(t.v[1]) && !this.superIdx.has(t.v[2]));
        }
        ptsOf(t) { return t.v.map(i => this.pts[i]); }
    }

    function pointInRing(pt, ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i].x, yi = ring[i].y, xj = ring[j].x, yj = ring[j].y;
            const intersect = ((yi > pt.y) !== (yj > pt.y)) && (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }
    function pointInsideDomain(pt, outer, holes) {
        if (!pointInRing(pt, outer)) return false;
        for (const h of holes) if (pointInRing(pt, h)) return false;
        return true;
    }
    function ringArea(ring) {
        let a = 0;
        for (let i = 0; i < ring.length; i++) { const p = ring[i], q = ring[(i + 1) % ring.length]; a += p.x * q.y - q.x * p.y; }
        return Math.abs(a / 2);
    }
    function triAngles(tri) {
        const [a, b, c] = tri;
        const la = dist(b, c), lb = dist(a, c), lc = dist(a, b);
        function angle(opp, s1, s2) {
            let cosv = (s1 * s1 + s2 * s2 - opp * opp) / (2 * s1 * s2);
            cosv = Math.max(-1, Math.min(1, cosv));
            return Math.acos(cosv) * 180 / Math.PI;
        }
        return [angle(la, lb, lc), angle(lb, la, lc), angle(lc, la, lb)];
    }
    function triArea(tri) {
        const [a, b, c] = tri;
        return Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
    }
    function triCentroid(tri) {
        return { x: (tri[0].x + tri[1].x + tri[2].x) / 3, y: (tri[0].y + tri[1].y + tri[2].y) / 3 };
    }
    function densifyRing(ring, maxSeg) {
        const out = [];
        for (let i = 0; i < ring.length; i++) {
            const a = ring[i], b = ring[(i + 1) % ring.length];
            out.push(a);
            const d = dist(a, b);
            const n = Math.max(1, Math.ceil(d / maxSeg));
            for (let s = 1; s < n; s++) { const t = s / n; out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }); }
        }
        return out;
    }
    function pointLineDist(p, a, b) {
        const dx = b.x - a.x, dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        if (len2 < 1e-12) return dist(p, a);
        const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
        return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
    }
    function P(p) { return { x: p.x, y: p.y }; }

    // v19: points are copied as plain numbers (geometry stays valid after the temporary text
    // conversion has been rolled back).
    function extractShapeGroups(node, flatnessTol) {
        const tol = flatnessTol || 0.5;
        const pc = node.curvesInterface.polyCurve;
        const rawRings = [];
        for (const curve of pc.curves) {
            if (!curve.isClosed || curve.isEmpty || curve.pointCount === 0) continue;
            const bezArr = curve.beziers.toArray();
            const pts = [];
            for (const b of bezArr) {
                const s = P(b.start), e = P(b.end), c1 = P(b.c1), c2 = P(b.c2);
                pts.push(s);
                const d1 = pointLineDist(c1, s, e);
                const d2 = pointLineDist(c2, s, e);
                if (Math.max(d1, d2) > tol) { const nSub = 6; for (let i = 1; i < nSub; i++) pts.push(P(b.evaluate(i / nSub))); }
            }
            if (pts.length >= 3 && ringArea(pts) > 1e-6) rawRings.push(pts);
        }
        if (rawRings.length === 0) return null;
        const n = rawRings.length;
        const testPt = rawRings.map(r => r[0]);
        const depth = new Array(n).fill(0);
        for (let i = 0; i < n; i++) {
            let d = 0;
            for (let j = 0; j < n; j++) { if (i !== j && pointInRing(testPt[i], rawRings[j])) d++; }
            depth[i] = d;
        }
        const containerOf = new Array(n).fill(-1);
        for (let i = 0; i < n; i++) {
            let best = -1, bestD = -1;
            for (let j = 0; j < n; j++) {
                if (i === j) continue;
                if (pointInRing(testPt[i], rawRings[j]) && depth[j] > bestD) { bestD = depth[j]; best = j; }
            }
            containerOf[i] = best;
        }
        const groups = [];
        for (let i = 0; i < n; i++) if (depth[i] % 2 === 0) groups.push({ outerIdx: i, holes: [] });
        for (let i = 0; i < n; i++) {
            if (depth[i] % 2 === 1) { const g = groups.find(g => g.outerIdx === containerOf[i]); if (g) g.holes.push(i); }
        }
        return groups.map(g => ({ outer: rawRings[g.outerIdx], holes: g.holes.map(hi => rawRings[hi]) }));
    }
    function groupsArea(groups) {
        let a = 0;
        for (const g of groups) { a += ringArea(g.outer); for (const h of g.holes) a -= ringArea(h); }
        return Math.max(1e-6, a);
    }

    function scatterInteriorPoints(tri, outer, holes, n, minEdgeLen, rng) {
        if (n <= 0) return 0;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of outer) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
        let placed = 0, attempts = 0;
        const maxAttempts = n * 40;
        while (placed < n && attempts < maxAttempts) {
            attempts++;
            const p = { x: minX + rng() * (maxX - minX), y: minY + rng() * (maxY - minY) };
            if (!pointInsideDomain(p, outer, holes)) continue;
            if (tri.nearAny(p, minEdgeLen)) continue;
            tri.insertPoint(p);
            placed++;
        }
        return placed;
    }

    function relaxIntoBand(kept, boundarySet, minA, maxA, rng) {
        const n = kept.length;
        const inc = new Map();
        for (let i = 0; i < n; i++) for (const v of kept[i]) { let a = inc.get(v); if (!a) { a = []; inc.set(v, a); } a.push(i); }
        function cross(t) { return (t[1].x - t[0].x) * (t[2].y - t[0].y) - (t[2].x - t[0].x) * (t[1].y - t[0].y); }
        const sgn = kept.map(t => Math.sign(cross(t)));
        const minAng = t => Math.min(...triAngles(t));
        const viol = m => (m > maxA ? m - maxA : (m < minA ? (minA - m) * 3 : 0));
        let moved = 0;
        for (let pass = 0; pass < 40; pass++) {
            let changed = false;
            for (let i = 0; i < n; i++) {
                const t = kept[i];
                if (!(minAng(t) > maxA)) continue;
                const mov = t.filter(v => !boundarySet.has(v));
                if (!mov.length) continue;
                const v = mov[Math.floor(rng() * mov.length)];
                const e = Math.min(dist(t[0], t[1]), dist(t[1], t[2]), dist(t[2], t[0]));
                const ids = inc.get(v);
                const mBefore = ids.map(j => minAng(kept[j]));
                let before = 0;
                for (const m of mBefore) before += viol(m);
                const ox = v.x, oy = v.y;
                for (let k = 0; k < 6; k++) {
                    const ang = rng() * Math.PI * 2, r = e * (0.15 + 0.35 * rng());
                    v.x = ox + Math.cos(ang) * r; v.y = oy + Math.sin(ang) * r;
                    let ok = true, after = 0;
                    for (let q = 0; q < ids.length; q++) {
                        const tj = kept[ids[q]];
                        const c = cross(tj);
                        if (Math.sign(c) !== sgn[ids[q]] || Math.abs(c) < 1e-9) { ok = false; break; }
                        const m = minAng(tj);
                        if (m < Math.min(minA, mBefore[q])) { ok = false; break; }
                        after += viol(m);
                    }
                    if (ok && after < before - 1e-9) { changed = true; moved++; break; }
                    v.x = ox; v.y = oy;
                }
            }
            if (!changed) break;
        }
        return moved;
    }

    function bandStats(tris, minA, maxA) {
        let aMin = 180, aMax = 0, sum = 0, inBand = 0;
        for (const t of tris) {
            const m = Math.min(...triAngles(t));
            if (m < aMin) aMin = m;
            if (m > aMax) aMax = m;
            sum += m;
            if (m >= minA - 1e-6 && m <= maxA + 1e-6) inBand++;
        }
        return {
            achievedMinAngle: tris.length ? aMin : 0, achievedMaxOfMinAngle: aMax,
            achievedAvgMinAngle: tris.length ? sum / tris.length : 0,
            pctInBand: tris.length ? Math.round(100 * inBand / tris.length) : 0
        };
    }

    function triangulateAndRefine(outerRaw, holesRaw, opts, rng) {
        let bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity;
        for (const p of outerRaw) { if (p.x < bMinX) bMinX = p.x; if (p.x > bMaxX) bMaxX = p.x; if (p.y < bMinY) bMinY = p.y; if (p.y > bMaxY) bMaxY = p.y; }
        const diag = Math.sqrt((bMaxX - bMinX) * (bMaxX - bMinX) + (bMaxY - bMinY) * (bMaxY - bMinY)) || 1;

        const targetPts = Math.max(12, Math.min(4000, Math.round(opts.targetCount * 0.9)));
        function ringPerimeter(ring) {
            let p = 0;
            for (let i = 0; i < ring.length; i++) p += dist(ring[i], ring[(i + 1) % ring.length]);
            return p;
        }
        let perim = ringPerimeter(outerRaw);
        for (const h of holesRaw) perim += ringPerimeter(h);
        let maxSeg = perim > 1e-6 ? (perim / targetPts) : Math.max(diag / targetPts, 0.05);
        if (!isFinite(maxSeg) || maxSeg <= 0) maxSeg = Math.max(diag / targetPts, 0.05);

        let outer = densifyRing(outerRaw, maxSeg);
        let holes = holesRaw.map(h => densifyRing(h, maxSeg));

        const ptsHardCap = Math.min(4000, targetPts * 3 + 150);
        const totalPts = outer.length + holes.reduce((s, h) => s + h.length, 0);
        if (totalPts > ptsHardCap) {
            maxSeg *= (totalPts / ptsHardCap);
            outer = densifyRing(outerRaw, maxSeg);
            holes = holesRaw.map(h => densifyRing(h, maxSeg));
        }

        const boundaryPts = outer.concat(...holes);
        const boundarySet = new Set(boundaryPts);
        const minEdgeLen = Math.max(diag / 1500, 0.05);
        const cellSize = Math.max(minEdgeLen * 0.5, diag / 2000, 1e-6);
        const tri = new Triangulator(boundaryPts, cellSize);

        const targetLow = opts.targetCount * (1 - opts.tolerancePct / 100);
        const targetHigh = opts.targetCount * (1 + opts.tolerancePct / 100);
        const hardCap = Math.min(Math.round(targetHigh) + 60, opts.targetCount * 2 + 100, 2000);

        const innerBudget = Math.max(0, hardCap - boundaryPts.length - 5);
        const innerRequested = opts.innerPts || 0;
        const innerPlaced = scatterInteriorPoints(tri, outer, holes, Math.min(innerRequested, innerBudget), minEdgeLen, rng);

        const keptSet = new Set();
        for (const t of tri.rawTriangles()) {
            if (pointInsideDomain(triCentroid(tri.ptsOf(t)), outer, holes)) keptSet.add(t);
        }
        function applyDelta(delta) {
            for (const t of delta.removed) keptSet.delete(t);
            for (const t of delta.added) {
                if (pointInsideDomain(triCentroid(tri.ptsOf(t)), outer, holes)) keptSet.add(t);
            }
        }
        const minAOf = t => { if (t.mA === undefined) t.mA = Math.min(...triAngles(tri.ptsOf(t))); return t.mA; };
        const areaOf = t => { if (t.ar === undefined) t.ar = triArea(tri.ptsOf(t)); return t.ar; };

        const maxIterations = opts.maxIterations || Math.max(1200, hardCap * 3);
        let iter = 0, cappedOut = false;

        while (iter < maxIterations) {
            if (keptSet.size >= hardCap) { cappedOut = true; break; }
            iter++;
            let worst = null, worstScore = -1;
            for (const t of keptSet) {
                const minA = minAOf(t);
                if (minA < opts.minAngle) {
                    const score = opts.minAngle - minA;
                    if (score > worstScore) { worstScore = score; worst = t; }
                }
            }
            const worstPts = worst ? tri.ptsOf(worst) : null;
            let steiner = null;
            if (worst) {
                const cc = circumcircle(worstPts[0], worstPts[1], worstPts[2]);
                if (cc && pointInsideDomain(cc, outer, holes) && !tri.nearAny(cc, minEdgeLen * 0.5)) {
                    steiner = cc;
                } else {
                    const edges = [[worstPts[0], worstPts[1]], [worstPts[1], worstPts[2]], [worstPts[2], worstPts[0]]];
                    edges.sort((a, b) => dist(b[0], b[1]) - dist(a[0], a[1]));
                    const mid = { x: (edges[0][0].x + edges[0][1].x) / 2, y: (edges[0][0].y + edges[0][1].y) / 2 };
                    if (pointInsideDomain(mid, outer, holes) && !tri.nearAny(mid, minEdgeLen * 0.5)) steiner = mid;
                }
            } else if (keptSet.size < targetLow) {
                let big = null, bigArea = -1;
                for (const t of keptSet) {
                    const a = areaOf(t);
                    if (a > bigArea) { bigArea = a; big = t; }
                }
                if (big) {
                    const c = triCentroid(tri.ptsOf(big));
                    if (!tri.nearAny(c, minEdgeLen * 0.5)) steiner = c;
                }
            }
            if (!steiner) break;
            applyDelta(tri.insertPoint(steiner));
            if (!worst && keptSet.size >= opts.targetCount) break;
        }

        const kept = Array.from(keptSet, t => tri.ptsOf(t));
        const relaxedMoves = relaxIntoBand(kept, boundarySet, opts.minAngle, opts.maxAngleTarget, rng);

        return {
            triangles: kept, iterations: iter, capped: cappedOut, hardCap: hardCap,
            innerPlaced: innerPlaced, innerRequested: innerRequested, relaxedMoves: relaxedMoves
        };
    }

    function triangulateGrid(outerRaw, holesRaw, targetCount) {
        const outerArea = ringArea(outerRaw);
        let holesArea = 0;
        for (const h of holesRaw) holesArea += ringArea(h);
        const netArea = Math.max(1e-6, outerArea - holesArea);
        const s = Math.sqrt(4 * (netArea / Math.max(1, targetCount)) / Math.sqrt(3));

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of outerRaw) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
        const rowH = s * Math.sqrt(3) / 2;
        const cols = Math.min(2000, Math.ceil((maxX - minX) / s) + 3);
        const rows = Math.min(2000, Math.ceil((maxY - minY) / rowH) + 3);

        const ptsGrid = [];
        for (let r = 0; r <= rows; r++) {
            const rowPts = [];
            const offset = (r % 2 === 1) ? s / 2 : 0;
            for (let c = 0; c <= cols; c++) rowPts.push({ x: minX - s + c * s + offset, y: minY - rowH + r * rowH });
            ptsGrid.push(rowPts);
        }
        const tris = [];
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const a = ptsGrid[r][c], b = ptsGrid[r][c + 1], cc = ptsGrid[r + 1][c], d = ptsGrid[r + 1][c + 1];
                if (r % 2 === 0) { tris.push([a, b, cc]); tris.push([b, d, cc]); }
                else { tris.push([a, b, d]); tris.push([a, d, cc]); }
            }
        }
        const kept = tris.filter(t => pointInsideDomain(triCentroid(t), outerRaw, holesRaw));
        return { triangles: kept, iterations: 0, capped: false, hardCap: kept.length, innerPlaced: 0, innerRequested: 0, relaxedMoves: 0 };
    }

    // Fills a shape group (outer contours + holes) - target count distributed over the contours by area.
    function triangulateGroups(groups, opts, rng) {
        const areas = groups.map(g => {
            let a = ringArea(g.outer);
            for (const h of g.holes) a -= ringArea(h);
            return Math.max(1e-6, a);
        });
        const totalArea = areas.reduce((s, a) => s + a, 0);
        const out = { triangles: [], iterations: 0, capped: false, hardCap: 0, innerPlaced: 0, innerRequested: 0, relaxedMoves: 0 };
        for (let gi = 0; gi < groups.length; gi++) {
            const g = groups[gi];
            const groupTarget = Math.max(1, Math.round(opts.targetCount * areas[gi] / totalArea));
            const res = opts.gridMode
                ? triangulateGrid(g.outer, g.holes, groupTarget)
                : triangulateAndRefine(g.outer, g.holes, Object.assign({}, opts, { targetCount: groupTarget }), rng);
            for (const t of res.triangles) out.triangles.push(t);
            out.iterations += res.iterations;
            out.capped = out.capped || res.capped;
            out.innerPlaced += res.innerPlaced;
            out.innerRequested += res.innerRequested;
            out.relaxedMoves += res.relaxedMoves || 0;
            out.hardCap = Math.max(out.hardCap, res.hardCap);
        }
        return out;
    }

    // ---------------- Fill ----------------

    function lerpHsl(a, b, f) {
        let dh = b.h - a.h;
        if (dh > 0.5) dh -= 1;
        if (dh < -0.5) dh += 1;
        let h = a.h + dh * f;
        h = ((h % 1) + 1) % 1;
        return { h: h, s: a.s + (b.s - a.s) * f, l: a.l + (b.l - a.l) * f, alpha: a.alpha + (b.alpha - a.alpha) * f };
    }
    const GREY = function () { return { h: 0, s: 0, l: 0.6, alpha: 1 }; };
    function hslPlain(c) { const v = c.hslaf; return { h: v.h, s: v.s, l: v.l, alpha: v.alpha }; }
    function makeFillSampler(srcNode) {
        try { return makeFillSamplerInner(srcNode); }
        catch (e) { return GREY; }
    }
    // v19: all values are copied as plain numbers right away (sampler stays valid after the
    // temporary text conversion has been rolled back).
    function makeFillSamplerInner(srcNode) {
        const fd = srcNode.brushFillDescriptor;
        if (!fd || !fd.fill) return GREY;
        const ft = fd.fill.fillType.value;
        if (ft === 2) {
            const hsl = hslPlain(fd.fill.colour);
            return function () { return { h: hsl.h, s: hsl.s, l: hsl.l, alpha: hsl.alpha }; };
        }
        if (ft === 3) {
            const g = fd.fill.gradient;
            const gtypeVal = fd.fill.gradientFillType.value;
            const tr = fd.transform;
            const origin = P(tr.origin), xAxis = P(tr.xAxis), yAxis = P(tr.yAxis);
            const stops = [];
            for (let i = 0; i < g.stopCount; i++) {
                const s = g.getStop(i);
                stops.push({ pos: s.position, hsl: hslPlain(toColour(s.colour)) });
            }
            stops.sort((a, b) => a.pos - b.pos);
            function sampleAt(t) {
                t = Math.max(0, Math.min(1, t));
                if (stops.length === 0) return GREY();
                if (t <= stops[0].pos) return stops[0].hsl;
                if (t >= stops[stops.length - 1].pos) return stops[stops.length - 1].hsl;
                for (let i = 0; i < stops.length - 1; i++) {
                    if (t >= stops[i].pos && t <= stops[i + 1].pos) {
                        const span = stops[i + 1].pos - stops[i].pos;
                        return lerpHsl(stops[i].hsl, stops[i + 1].hsl, span < 1e-9 ? 0 : (t - stops[i].pos) / span);
                    }
                }
                return stops[stops.length - 1].hsl;
            }
            const det = xAxis.x * yAxis.y - yAxis.x * xAxis.y;
            function project(pt) {
                const dx = pt.x - origin.x, dy = pt.y - origin.y;
                if (Math.abs(det) < 1e-12) return { u: 0, v: 0 };
                return { u: (dx * yAxis.y - dy * yAxis.x) / det, v: (dy * xAxis.x - dx * xAxis.y) / det };
            }
            return function (pt) {
                const p = project(pt);
                let t;
                if (gtypeVal === 0) t = p.u;
                else if (gtypeVal === 3) { t = Math.atan2(p.v, p.u) / (2 * Math.PI); if (t < 0) t += 1; }
                else t = Math.sqrt(p.u * p.u + p.v * p.v);
                return sampleAt(t);
            };
        }
        return GREY;
    }
    function jitterHSL(hsl, p, rng) {
        const dh = (rng() * (p.hMax - p.hMin) + p.hMin) / 360;
        const ds = (rng() * (p.sMax - p.sMin) + p.sMin) / 100;
        const dl = (rng() * (p.lMax - p.lMin) + p.lMin) / 100;
        let h = hsl.h + dh; h = ((h % 1) + 1) % 1;
        return { h: h, s: Math.max(0, Math.min(1, hsl.s + ds)), l: Math.max(0, Math.min(1, hsl.l + dl)), alpha: hsl.alpha };
    }
    function buildTriangleGradientFD(cornerPts, cornerHsls) {
        const idxs = [0, 1, 2].sort((a, b) => cornerHsls[a].l - cornerHsls[b].l);
        const pA = cornerPts[idxs[0]], pM = cornerPts[idxs[1]], pB = cornerPts[idxs[2]];
        const axisVec = { x: pB.x - pA.x, y: pB.y - pA.y };
        const axisLen2 = axisVec.x * axisVec.x + axisVec.y * axisVec.y;
        if (axisLen2 < 1e-9) return null;
        let tMid = ((pM.x - pA.x) * axisVec.x + (pM.y - pA.y) * axisVec.y) / axisLen2;
        tMid = Math.max(0.02, Math.min(0.98, tMid));
        try {
            const stops = [
                { colour: Colour.createHSLAf(cornerHsls[idxs[0]]), position: 0, midpoint: 0.5 },
                { colour: Colour.createHSLAf(cornerHsls[idxs[1]]), position: tMid, midpoint: 0.5 },
                { colour: Colour.createHSLAf(cornerHsls[idxs[2]]), position: 1, midpoint: 0.5 }
            ];
            const gf = GradientFill.create(Gradient.create(stops), GradientFillType.Linear.value);
            const tr = Transform.createIdentity();
            const d = tr.data;
            d[0] = axisVec.x; d[3] = axisVec.y; d[1] = -axisVec.y; d[4] = axisVec.x; d[2] = pA.x; d[5] = pA.y;
            return FillDescriptor.create(gf, false, tr, BlendMode.Normal.value, false);
        } catch (e) { return null; }
    }

    // ---------------- Node creation ----------------

    function nextIndex(prefix) {
        const re = new RegExp('^' + prefix + '_(\\d+)$');
        let maxIdx = 0;
        for (const l of doc.layers.all) {
            const m = re.exec(l.description);
            if (m) { const n = parseInt(m[1], 10); if (n > maxIdx) maxIdx = n; }
        }
        return maxIdx + 1;
    }

    // parts: [{ triangles, tfData, sampler }] - all triangles of a target in ONE group above anchor.
    // rec = { group, steps } is filled as we go, so that an abort in the middle of building
    // can be rolled back completely as well.
    function buildTriangleGroup(anchor, parts, jitterParams, rng, useGradient, rec) {
        function exec(cmd) { doc.executeCommand(cmd); rec.steps++; }
        const grpDef = NodesM.ContainerNodeDefinition.createDefault();
        grpDef.setUserDescription(GROUP_PREFIX + '_' + nextIndex(GROUP_PREFIX));
        const gBldr = AddChildNodesCommandBuilder.create();
        gBldr.addContainerNode(grpDef);
        const gCmd = gBldr.createCommand(false);
        exec(gCmd);
        const group = gCmd.newNodes[0];
        rec.group = group;

        exec(DocumentCommand.createMoveNodes(group.selfSelection, anchor, NodeMoveType.After, NodeChildType.Main));
        const compTf = group.transform.inverted;
        exec(DocumentCommand.createTransform(group.selfSelection, compTf));

        const bldr2 = AddChildNodesCommandBuilder.create();
        bldr2.setInsertionTarget(group);
        const wantData = [];
        for (const part of parts) {
            const partTf = dataToTransform(part.tfData);
            for (const t of part.triangles) {
                const cb = CurveBuilder.create();
                cb.beginXY(t[0].x, t[0].y);
                cb.lineToXY(t[1].x, t[1].y);
                cb.lineToXY(t[2].x, t[2].y);
                cb.close();
                const pc = PolyCurve.create();
                pc.addCurve(cb.createCurve());

                let fd = null;
                if (useGradient) {
                    const cornerHsls = t.map(pt => jitterHSL(part.sampler(pt), jitterParams, rng));
                    fd = buildTriangleGradientFD(t, cornerHsls);
                }
                if (!fd) {
                    const baseHsl = part.sampler(triCentroid(t));
                    fd = FillDescriptor.createSolid(Colour.createHSLAf(jitterHSL(baseHsl, jitterParams, rng)));
                }
                const def = NodesM.PolyCurveNodeDefinition.createDefault();
                def.setCurves(pc);
                def.setTransform(partTf.clone());
                if (def.brushFillDescriptorCount > 0) {
                    def.setBrushFillDescriptor(fd, 0);
                    while (def.brushFillDescriptorCount > 1) def.removeBrushFillDescriptor(def.brushFillDescriptorCount - 1);
                } else {
                    def.insertBrushFillDescriptor(fd, 0);
                }
                def.currentBrushFillIndex = 0;
                bldr2.addNode(def);
                wantData.push(part.tfData);
            }
        }
        const cmd2 = bldr2.createCommand(false);
        exec(cmd2);

        // Position corrections as ONE compound
        const cbFix = CompoundCommandBuilder.create();
        let nFix = 0;
        const newNodes = cmd2.newNodes;
        for (let i = 0; i < newNodes.length; i++) {
            const tn = newNodes[i];
            const want = wantData[i] || wantData[0];
            const invActual = invertData(tn.transform.data);
            if (!invActual) continue;
            const deltaData = matMulData(want, invActual);
            if (isIdentityData(deltaData)) continue;
            cbFix.addCommand(DocumentCommand.createTransform(tn.selfSelection, dataToTransform(deltaData)));
            nFix++;
        }
        if (nFix > 0) exec(cbFix.createCommand(false));
        return group;
    }

    // ---------------- Collect selection ----------------

    // Local -> parent space of anchor: transform chain from the leaf up to (excluding) stopParent.
    function chainData(node, stopParent) {
        let M = copyData(node.transform.data);
        let p = node.parent;
        let guard = 0;
        while (p && !(stopParent && p.isSameNode(stopParent)) && guard < 64) {
            try { M = matMulData(p.transform.data, M); } catch (e) { }
            p = p.parent; guard++;
        }
        return M;
    }

    // v19: convert text to curves on a duplicate, read glyph outlines + fill, roll the conversion
    // back immediately. Result: list of parts (one part per character).
    function extractTextParts(textNode) {
        const pos0 = doc.history.position;
        let steps = 0;
        const parts = [];
        let created = [];
        try {
            const dupCmd = DocumentCommand.createTransform(Selection.create(doc, [textNode]), Transform.createIdentity(), { duplicateNodes: true });
            doc.executeCommand(dupCmd); steps++;
            const dup = dupCmd.newNodes[0];
            created = [dup];
            const all0 = Array.from(doc.layers.all);
            doc.executeCommand(DocumentCommand.createConvertToCurves(Selection.create(doc, [dup]))); steps++;
            const all1 = Array.from(doc.layers.all);
            created = all1.filter(a => !all0.some(b => b.isSameNode(a)));
            const stop = textNode.parent;
            for (const n of created) {
                if (!isVectorNode(n) || isTextNode(n)) continue;
                let groups = null;
                try { groups = extractShapeGroups(n); } catch (e) { groups = null; }
                if (!groups || !groups.length) continue;
                const tfData = chainData(n, stop);
                parts.push({ groups: groups, tfData: tfData, sampler: makeFillSampler(n), area: groupsArea(groups) * Math.max(1e-9, detData(tfData)) });
            }
        } finally {
            // Roll back: via history (no entries left), otherwise safety net delete
            let k = 0;
            while (doc.history.position > pos0 && k < steps + 2) { try { doc.history.undo(); } catch (e) { break; } k++; }
            const left = created.filter(n => nodeInDoc(n) && !(n.parent && created.some(c => c.isSameNode(n.parent))));
            if (left.length) {
                try { doc.executeCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, left), true)); } catch (e) { }
            }
        }
        return parts;
    }

    const targets = [];       // { anchor, isText, parts: [{groups, tfData, sampler, area}], area }
    let skipped = 0, textCount = 0, charCount = 0;
    function alreadyTarget(n) { return targets.some(t => t.anchor.isSameNode(n)); }
    function collect(node) {
        if (alreadyTarget(node)) return;
        if (isTextNode(node)) {
            const parts = extractTextParts(node);
            if (parts.length) {
                targets.push({ anchor: node, isText: true, parts: parts, area: parts.reduce((s, p) => s + p.area, 0) });
                textCount++; charCount += parts.length;
            } else skipped++;
            return;
        }
        if (isVectorNode(node) && isClosedNode(node)) {
            const groups = extractShapeGroups(node);
            if (groups && groups.length) {
                const tfData = copyData(node.transform.data);
                targets.push({
                    anchor: node, isText: false,
                    parts: [{ groups: groups, tfData: tfData, sampler: makeFillSampler(node), area: groupsArea(groups) * Math.max(1e-9, detData(tfData)) }]
                });
                targets[targets.length - 1].area = targets[targets.length - 1].parts[0].area;
            } else skipped++;
            return;
        }
        if (hasChildren(node)) {
            for (const c of node.children) collect(c);
            return;
        }
        skipped++;
    }

    const selNodes = doc.selection.nodes.toArray();
    if (!selNodes.length) {
        app.alert('Please select one or more closed vector shapes or artistic texts.', TITLE);
        return;
    }
    for (const n of selNodes) {
        try { collect(n); } catch (e) { skipped++; }
    }
    if (!targets.length) {
        app.alert('No closed vector shape and no text found in the selection.' +
            (skipped ? '\n(' + skipped + ' object(s) skipped: open, pixel or similar)' : ''), TITLE);
        return;
    }
    const totalArea = targets.reduce((s, t) => s + t.area, 0);

    // ---------------- Presets ----------------

    const PRESET_KEYS = ['targetCount', 'countMode', 'tolerancePct', 'minAngle', 'maxAngleTarget', 'innerPts', 'deleteSrc', 'seed', 'useGradient', 'gridMode', 'hMin', 'hMax', 'sMin', 'sMax', 'lMin', 'lMax'];
    const PRESET_PREFIX = 'DF_';

    function presetDir() {
        const dirPath = app.userDesktopPath + '/AffinityScriptPresets';
        try { createDirectories(dirPath); } catch (e) { }
        return dirPath;
    }
    function encodePreset(p) {
        const obj = {};
        for (const k of PRESET_KEYS) obj[k] = p[k];
        return JSON.stringify(obj);
    }
    function decodePreset(txt) {
        try {
            const obj = JSON.parse(txt);
            const p = {};
            for (const k of PRESET_KEYS) if (obj[k] != null) p[k] = obj[k];
            return p;
        } catch (e) { return null; }
    }
    function sanitizePresetName(name) {
        return String(name || '').trim().replace(/[^a-zA-Z0-9 _-]/g, '_').slice(0, 80);
    }
    function presetPath(name) {
        return presetDir() + '/' + PRESET_PREFIX + sanitizePresetName(name) + '.json';
    }
    function savePreset(params) {
        const name = app.prompt('Name for the preset:', TITLE, 'Preset1');
        if (!name || !name.trim()) return;
        try {
            const path = presetPath(name);
            const f = File.create(path, 'w');
            f.writeStringAsUtf8(encodePreset(params));
            f.close();
            app.alert('Preset saved as:\n' + path, TITLE);
        } catch (e) {
            app.alert('Preset could not be saved: ' + e.message, TITLE);
        }
    }
    function loadPreset() {
        const path = app.chooseFile();
        if (!path) return null;
        try {
            const txt = File.readAll(path).toString('utf8');
            const p = decodePreset(txt);
            if (!p) { app.alert('The file could not be read as a preset.', TITLE); return null; }
            return p;
        } catch (e) {
            app.alert('Preset could not be loaded: ' + e.message, TITLE);
            return null;
        }
    }
    function deletePreset() {
        const path = app.chooseFile();
        if (!path) return;
        try {
            remove(path);
            app.alert('Preset deleted:\n' + path, TITLE);
        } catch (e) {
            app.alert('Preset could not be deleted: ' + e.message, TITLE);
        }
    }

    // ---------------- Dialog ----------------

    const dlg = Dialog.create(TITLE);
    dlg.initialWidth = 860;
    dlg.setIsResizable(true);
    const col1 = dlg.addColumn();
    const col2 = dlg.addColumn();
    const col3 = dlg.addColumn();

    const gCount = col1.addGroup('Count');
    const edCount = gCount.addUnitValueEditor('Target number of triangles', 'none', 'none', null, 4, 20000);
    edCount.value = 30;
    const cbCountMode = gCount.addComboBox('Count applies', ['per object', 'for all together (by area)'], 0);
    cbCountMode.selectedIndex = 0;
    const edTol = gCount.addUnitValueEditor('Tolerance (%)', 'none', 'none', null, 0, 200);
    edTol.value = 15;
    gCount.addStaticText('', 'A text counts as ONE object - the count is distributed over its characters by area.');

    const gAngle = col1.addGroup('Smallest angle per triangle');
    const edMinA = gAngle.addUnitValueEditor('Min (deg)', 'none', 'none', null, 3, 55);
    edMinA.value = 30;
    const edMaxA = gAngle.addUnitValueEditor('Max (deg)', 'none', 'none', null, 5, 60);
    edMaxA.value = 45;
    gAngle.addStaticText('', 'Band for the SMALLEST angle of each triangle. Not in grid mode.');

    const gInner = col1.addGroup('Inner points');
    const edInner = gInner.addUnitValueEditor('Additional inner points', 'none', 'none', null, 0, 5000);
    edInner.value = 0;
    gInner.addStaticText('', 'Per contour. No symbol of its own - just an extra vertex. Organic mode only.');

    const gH = col2.addGroup('HSL jitter: hue (deg)');
    const edHMin = gH.addUnitValueEditor('Min', 'none', 'none', null, -180, 180);
    edHMin.value = 0;
    const edHMax = gH.addUnitValueEditor('Max', 'none', 'none', null, -180, 180);
    edHMax.value = 0;

    const gS = col2.addGroup('HSL jitter: saturation (%)');
    const edSMin = gS.addUnitValueEditor('Min', 'none', 'none', null, -100, 100);
    edSMin.value = 0;
    const edSMax = gS.addUnitValueEditor('Max', 'none', 'none', null, -100, 100);
    edSMax.value = 0;

    const gL = col2.addGroup('HSL jitter: lightness (%)');
    const edLMin = gL.addUnitValueEditor('Min', 'none', 'none', null, -100, 100);
    edLMin.value = -15;
    const edLMax = gL.addUnitValueEditor('Max', 'none', 'none', null, -100, 100);
    edLMax.value = 15;

    const gSel = col3.addGroup('Selection');
    const shapeCount = targets.length - textCount;
    gSel.addStaticText('', shapeCount + ' shape(s), ' + textCount + ' text(s) with ' + charCount + ' characters' +
        (skipped ? '\n' + skipped + ' object(s) skipped' : ''));

    const gOpt = col3.addGroup('Options');
    const cbDeleteSrc = gOpt.addCheckBox('Delete original(s)', false);
    const cbGradient = gOpt.addCheckBox('Gradient per triangle (instead of solid colour)', false);
    const cbGridMode = gOpt.addCheckBox('Regular grid instead of organic', false);
    const edSeed = gOpt.addUnitValueEditor('Random seed', 'none', 'none', null, 1, 999999);
    edSeed.value = 1;

    const gPreset = col3.addGroup('Preset');
    const presetSaveBtn = gPreset.addButton('Save preset');
    const presetLoadBtn = gPreset.addButton('Load preset');
    const presetDeleteBtn = gPreset.addButton('Delete preset');

    function readParams() {
        const minA = Math.max(3, Math.min(55, edMinA.value));
        const maxA = Math.max(minA, Math.min(60, edMaxA.value));
        return {
            targetCount: edCount.value, countMode: cbCountMode.selectedIndex, tolerancePct: edTol.value,
            minAngle: minA, maxAngleTarget: maxA,
            innerPts: Math.max(0, edInner.value),
            deleteSrc: cbDeleteSrc.value, useGradient: cbGradient.value, gridMode: cbGridMode.value,
            seed: Math.max(1, Math.round(edSeed.value)),
            hMin: edHMin.value, hMax: edHMax.value,
            sMin: edSMin.value, sMax: edSMax.value,
            lMin: edLMin.value, lMax: edLMax.value
        };
    }
    function previewKeyOf(p) {
        const q = Object.assign({}, p);
        delete q.deleteSrc;
        return JSON.stringify(q);
    }
    function applyParams(p) {
        if (p.targetCount != null) edCount.value = p.targetCount;
        if (p.countMode != null) cbCountMode.selectedIndex = p.countMode;
        if (p.tolerancePct != null) edTol.value = p.tolerancePct;
        if (p.minAngle != null) edMinA.value = p.minAngle;
        if (p.maxAngleTarget != null) edMaxA.value = p.maxAngleTarget;
        if (p.innerPts != null) edInner.value = p.innerPts;
        if (p.deleteSrc != null) cbDeleteSrc.value = p.deleteSrc;
        if (p.useGradient != null) cbGradient.value = p.useGradient;
        if (p.gridMode != null) cbGridMode.value = p.gridMode;
        if (p.seed != null) edSeed.value = p.seed;
        if (p.hMin != null) edHMin.value = p.hMin;
        if (p.hMax != null) edHMax.value = p.hMax;
        if (p.sMin != null) edSMin.value = p.sMin;
        if (p.sMax != null) edSMax.value = p.sMax;
        if (p.lMin != null) edLMin.value = p.lMin;
        if (p.lMax != null) edLMax.value = p.lMax;
    }

    // ---------------- Calculation + preview ----------------

    // Target count per object or by area; within an object (text) by character area.
    function computeAll(params, rng) {
        const refineOpts = {
            tolerancePct: params.tolerancePct,
            minAngle: params.minAngle, maxAngleTarget: params.maxAngleTarget,
            innerPts: params.innerPts, gridMode: params.gridMode
        };
        const stats = { triangles: 0, iterations: 0, capped: false, hardCap: 0, innerPlaced: 0, innerRequested: 0, relaxedMoves: 0, allTris: [] };
        const results = [];
        for (const t of targets) {
            const tCount = params.countMode === 1 ? params.targetCount * t.area / totalArea : params.targetCount;
            const parts = [];
            for (const part of t.parts) {
                const partTarget = Math.max(1, Math.round(tCount * part.area / t.area));
                const res = triangulateGroups(part.groups, Object.assign({}, refineOpts, { targetCount: partTarget }), rng);
                if (!res.triangles.length) continue;
                parts.push({ triangles: res.triangles, tfData: part.tfData, sampler: part.sampler });
                stats.triangles += res.triangles.length;
                stats.iterations += res.iterations;
                stats.capped = stats.capped || res.capped;
                stats.hardCap = Math.max(stats.hardCap, res.hardCap);
                stats.innerPlaced += res.innerPlaced;
                stats.innerRequested += res.innerRequested;
                stats.relaxedMoves += res.relaxedMoves;
                for (const tr of res.triangles) stats.allTris.push(tr);
            }
            if (parts.length) results.push({ target: t, parts: parts });
        }
        const st = bandStats(stats.allTris, params.minAngle, params.maxAngleTarget);
        Object.assign(stats, st);
        delete stats.allTris;
        return { results: results, stats: stats };
    }

    let hasPreview = false;
    let previewKey = null;
    let lastStats = null;
    let lastGroups = [];

    function undoPreview() {
        discardCurrent();
        hasPreview = false;
        previewKey = null;
        lastStats = null;
        lastGroups = [];
    }

    function updatePreview() {
        undoPreview();
        const params = readParams();
        if (params.targetCount < 2) return;
        try {
            const rng = mulberry32(params.seed);
            const all = computeAll(params, rng);
            if (!all.results.length) return;
            const jitterParams = {
                hMin: params.hMin, hMax: params.hMax, sMin: params.sMin, sMax: params.sMax,
                lMin: params.lMin, lMax: params.lMax
            };
            const groups = [];
            for (const r of all.results) {
                const rec = { group: null, steps: 0 };
                currentRecs.push(rec);
                groups.push(buildTriangleGroup(r.target.anchor, r.parts, jitterParams, rng, params.useGradient, rec));
            }
            lastStats = all.stats;
            lastGroups = groups;
            hasPreview = true;
            previewKey = previewKeyOf(params);
        } catch (e) {
            discardCurrent();
            hasPreview = false;
            app.alert('Preview failed: ' + e.message, TITLE);
        }
    }

    presetSaveBtn.setOnClickHandler(function () { savePreset(readParams()); });
    presetLoadBtn.setOnClickHandler(function () {
        const p = loadPreset();
        if (p) { applyParams(p); updatePreview(); }
    });
    presetDeleteBtn.setOnClickHandler(function () { deletePreset(); });

    const gPreview = col3.addGroup('Preview');
    const previewBtn = gPreview.addButton('Create preview');
    previewBtn.setOnClickHandler(function () { updatePreview(); });

    updatePreview();

    const result = dlg.runModal();
    if (!result || result.value !== DialogResult.Ok.value) {
        undoPreview();
        return;
    }

    if (!hasPreview || previewKey !== previewKeyOf(readParams())) {
        updatePreview();
    }
    if (!hasPreview) {
        app.alert('No triangles could be created.', TITLE);
        undoPreview();
        return;
    }

    currentRecs = [];   // keep the result

    const finalParams = readParams();
    if (finalParams.deleteSrc) {
        const src = targets.map(t => t.anchor).filter(n => nodeInDoc(n));
        if (src.length) doc.executeCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, src)));
    }

    const s = lastStats;
    const names = lastGroups.slice(0, 6).map(g => '"' + g.description + '"').join(', ') + (lastGroups.length > 6 ? ', ...' : '');
    let msg = 'Done.\n\nTriangles created: ' + s.triangles +
        '\nObjects filled: ' + lastGroups.length + ' (' + shapeCount + ' shape(s), ' + textCount + ' text(s) with ' + charCount + ' characters)' +
        (skipped ? '\nSkipped: ' + skipped : '') +
        '\nCount applies: ' + (finalParams.countMode === 1 ? 'for all together (by area)' : 'per object') +
        '\nGroup(s): ' + names +
        '\nIterations: ' + s.iterations +
        '\nAdditional inner points placed: ' + s.innerPlaced + (s.innerPlaced < s.innerRequested ? ' (of ' + s.innerRequested + ' requested)' : '') +
        '\nMode: ' + (finalParams.gridMode ? 'Regular grid' : 'Organic (Delaunay)') +
        '\nFill: ' + (finalParams.useGradient ? 'Gradient per triangle' : 'Solid colour per triangle') +
        '\nRandom seed: ' + finalParams.seed;
    if (!finalParams.gridMode) {
        msg += '\n\nSmallest angle per triangle (band ' + finalParams.minAngle + '-' + finalParams.maxAngleTarget + ' deg):' +
            '\n  Smallest value overall: ' + s.achievedMinAngle.toFixed(1) + ' deg' +
            '\n  Largest value overall: ' + s.achievedMaxOfMinAngle.toFixed(1) + ' deg' +
            '\n  Average: ' + s.achievedAvgMinAngle.toFixed(1) + ' deg' +
            '\n  Share of triangles in the band: ' + s.pctInBand + '%' +
            '\n  Inner-point moves to keep the band: ' + s.relaxedMoves +
            (s.pctInBand < 100 ? '\n  (Triangles made only of boundary points cannot be deformed.)' : '');
    } else {
        msg += '\n\nGrid mode: angle parameters were ignored (grid triangles are approximately equilateral).';
    }
    if (s.capped) {
        msg += '\n\nNote: the safety limit for the count was reached for at least one contour ' +
            '(probably sharp/concave corners). For more triangles: reduce the min. angle or increase the target count/tolerance.';
    }
    app.alert(msg, TITLE);
})();
