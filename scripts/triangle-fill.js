// Triangle Fill (v16)
// Fills a selected closed vector shape completely with triangles.
//
// CHANGES v16:
// - ANGLE BAND: "Min" and "Max" now BOTH refer to the SMALLEST angle of each
//   triangle (band [Min..Max]). Min stays the hard limit (refinement). NEW: Max
//   is now actively pursued too - triangles whose smallest angle is above Max
//   (too regular) are deformed by moving INNER points with a seeded random
//   displacement (topology stays, no triangle is flipped, Min is never violated).
//   Triangles consisting only of boundary points cannot be changed this way and
//   are counted as outside the band in the final message. Still ignored in grid mode.
// - MULTIPLE GROUPS: the preview used to be reset through the undo history
//   (history.position / undo loop). That depends on the state of the document
//   history and occasionally left old preview groups behind. All created
//   preview groups are now tracked and deleted explicitly - independent of the
//   history. Half-built groups (error while building) are removed as well.
// v15: rollback hardening, recalculation on OK if settings changed.
// v14: Blur-Shadow dialog concept (preview/preset buttons, native OK/Cancel),
//      preset prefix "DF_" (identical to the German version, presets are
//      interchangeable), delete preset.
//
// LIMITATIONS:
// - No true constrained Delaunay with edge recovery.
// - Gradient per triangle is an approximation (3-stop linear along one axis).
// - Grid mode ignores the angle parameters completely.

(function () {
    const { Document } = require('/document');
    const { Selection } = require('/selections');
    const { DocumentCommand, NodeChildType, AddChildNodesCommandBuilder } = require('/commands');
    const { NodeMoveType } = require('affinity:dom');
    const { CurveBuilder, PolyCurve, Transform } = require('/geometry');
    const { Dialog, DialogResult } = require('/dialog');
    const { app } = require('/application');
    const { File, createDirectories, remove } = require('/fs');
    const NodesM = require('/nodes');
    const { FillDescriptor, GradientFill, GradientFillType, BlendMode } = require('/fills');
    const { Colour, Gradient } = require('/colours');

    const doc = Document.current;
    if (!doc) {
        app.alert('No document open.', 'Triangle Fill');
        return;
    }

    // Rollback via history - only still used for the initial curve conversion
    // on Cancel (preview groups are deleted explicitly).
    function rollbackTo(pos) {
        if (doc.history.position === pos) return;
        try { doc.history.position = pos; } catch (e) { /* position 0: undo loop below */ }
        let guard = 0;
        while (doc.history.position > pos && guard++ < 100000) doc.history.undo();
    }

    // v16: track all created preview groups and delete them explicitly.
    const createdGroups = [];
    function clearCreatedGroups() {
        for (const g of createdGroups) {
            try {
                doc.executeCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, [g]), true));
            } catch (e) { /* group no longer exists */ }
        }
        createdGroups.length = 0;
    }

    function snapshotAll(doc) {
        const arr = [];
        for (const l of doc.layers.all) arr.push(l);
        return arr;
    }
    function diffNewNodes(doc, beforeArr) {
        const after = snapshotAll(doc);
        return after.filter(a => !beforeArr.some(b => b.isSameNode(a)));
    }
    function ensureMutable(doc, node) {
        if (node.curvesInterface && node.curvesInterface.isMutable) return node;
        const before = snapshotAll(doc);
        doc.executeCommand(DocumentCommand.createConvertToCurves(Selection.create(doc, [node])));
        const created = diffNewNodes(doc, before);
        return created.length ? created[0] : node;
    }
    function isVectorNode(node) { return !!node.curvesInterface; }
    function isClosedNode(node) {
        const pc = node.curvesInterface.polyCurve;
        if (pc.curveCount === 0) return false;
        for (const c of pc.curves) { if (!c.isClosed) return false; }
        return true;
    }

    function mulberry32(seed) {
        let a = seed >>> 0;
        return function () {
            a |= 0; a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

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
        _insertExistingIndex(pIdx) {
            const { bad, boundary } = this._cavity(this.pts[pIdx]);
            this.tris = this.tris.filter(t => bad.indexOf(t) === -1);
            for (const [u, v] of boundary) this.tris.push(makeTri(u, v, pIdx, this.pts));
        }
        insertPoint(p) {
            const idx = this.pts.length;
            this.pts.push(p);
            this._gridAdd(idx);
            const { bad, boundary } = this._cavity(p);
            this.tris = this.tris.filter(t => bad.indexOf(t) === -1);
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

    function extractShapeGroups(node, flatnessTol) {
        const tol = flatnessTol || 0.5;
        const pc = node.curvesInterface.polyCurve;
        const rawRings = [];
        for (const curve of pc.curves) {
            if (!curve.isClosed || curve.isEmpty) continue;
            const bezArr = curve.beziers.toArray();
            const pts = [];
            for (const b of bezArr) {
                pts.push(b.start);
                const d1 = pointLineDist(b.c1, b.start, b.end);
                const d2 = pointLineDist(b.c2, b.start, b.end);
                if (Math.max(d1, d2) > tol) { const nSub = 6; for (let i = 1; i < nSub; i++) pts.push(b.evaluate(i / nSub)); }
            }
            if (pts.length >= 3) rawRings.push(pts);
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

    // v16: angle band [minA..maxA] for the SMALLEST angle of each triangle.
    // Triangles with smallest angle > maxA (too regular) are deformed by moving one
    // of their INNER vertices (seeded). Topology stays, no flips, no triangle drops
    // below minA (unless it already was below).
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

        const maxIterations = opts.maxIterations || Math.max(1200, hardCap * 3);
        let iter = 0, cappedOut = false;

        while (iter < maxIterations) {
            if (keptSet.size >= hardCap) { cappedOut = true; break; }
            iter++;
            let worst = null, worstScore = -1, worstPts = null;
            for (const t of keptSet) {
                const pts = tri.ptsOf(t);
                const minA = Math.min(...triAngles(pts));
                if (minA < opts.minAngle) {
                    const score = opts.minAngle - minA;
                    if (score > worstScore) { worstScore = score; worst = t; worstPts = pts; }
                }
            }
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
                let big = null, bigArea = -1, bigPts = null;
                for (const t of keptSet) {
                    const pts = tri.ptsOf(t);
                    const a = triArea(pts);
                    if (a > bigArea) { bigArea = a; big = t; bigPts = pts; }
                }
                if (big) {
                    const c = triCentroid(bigPts);
                    if (!tri.nearAny(c, minEdgeLen * 0.5)) steiner = c;
                }
            }
            if (!steiner) break;
            applyDelta(tri.insertPoint(steiner));
            if (!worst && keptSet.size >= opts.targetCount) break;
        }

        const kept = Array.from(keptSet, t => tri.ptsOf(t));

        // v16: actively pursue the upper limit of the angle band.
        const relaxedMoves = relaxIntoBand(kept, boundarySet, opts.minAngle, opts.maxAngleTarget, rng);

        const st = bandStats(kept, opts.minAngle, opts.maxAngleTarget);
        return {
            triangles: kept, iterations: iter, capped: cappedOut, hardCap: hardCap,
            innerPlaced: innerPlaced, innerRequested: innerRequested, relaxedMoves: relaxedMoves,
            achievedMinAngle: st.achievedMinAngle, achievedMaxOfMinAngle: st.achievedMaxOfMinAngle,
            achievedAvgMinAngle: st.achievedAvgMinAngle, pctInBand: st.pctInBand
        };
    }

    function triangulateGrid(outerRaw, holesRaw, targetCount) {
        const outerArea = ringArea(outerRaw);
        let holesArea = 0;
        for (const h of holesRaw) holesArea += ringArea(h);
        const netArea = Math.max(1, outerArea - holesArea);
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

    function triangulateWholeShape(groups, opts, rng) {
        const areas = groups.map(g => {
            let a = ringArea(g.outer);
            for (const h of g.holes) a -= ringArea(h);
            return Math.max(1, a);
        });
        const totalArea = areas.reduce((s, a) => s + a, 0);
        const allTriangles = [];
        let sumIter = 0, anyCapped = false, sumInnerPlaced = 0, sumInnerRequested = 0, maxHardCap = 0, sumRelaxed = 0;
        for (let gi = 0; gi < groups.length; gi++) {
            const g = groups[gi];
            const groupTarget = Math.max(1, Math.round(opts.targetCount * areas[gi] / totalArea));
            const res = opts.gridMode
                ? triangulateGrid(g.outer, g.holes, groupTarget)
                : triangulateAndRefine(g.outer, g.holes, Object.assign({}, opts, { targetCount: groupTarget }), rng);
            allTriangles.push(...res.triangles);
            sumIter += res.iterations;
            anyCapped = anyCapped || res.capped;
            sumInnerPlaced += res.innerPlaced;
            sumInnerRequested += res.innerRequested;
            sumRelaxed += res.relaxedMoves || 0;
            maxHardCap = Math.max(maxHardCap, res.hardCap);
        }
        const st = bandStats(allTriangles, opts.minAngle, opts.maxAngleTarget);
        return {
            triangles: allTriangles, iterations: sumIter, capped: anyCapped, hardCap: maxHardCap,
            innerPlaced: sumInnerPlaced, innerRequested: sumInnerRequested, relaxedMoves: sumRelaxed,
            achievedMinAngle: st.achievedMinAngle, achievedMaxOfMinAngle: st.achievedMaxOfMinAngle,
            achievedAvgMinAngle: st.achievedAvgMinAngle, pctInBand: st.pctInBand,
            groupCount: groups.length
        };
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
    function makeFillSampler(srcNode) {
        try { return makeFillSamplerInner(srcNode); }
        catch (e) { return function () { return { h: 0, s: 0, l: 0.6, alpha: 1 }; }; }
    }
    function makeFillSamplerInner(srcNode) {
        const fd = srcNode.brushFillDescriptor;
        if (!fd || !fd.fill) return function () { return { h: 0, s: 0, l: 0.6, alpha: 1 }; };
        const ft = fd.fill.fillType.value;
        if (ft === 2) {
            const hsl = fd.fill.colour.hslaf;
            return function () { return { h: hsl.h, s: hsl.s, l: hsl.l, alpha: hsl.alpha }; };
        }
        if (ft === 3) {
            const g = fd.fill.gradient;
            const gtypeVal = fd.fill.gradientFillType.value;
            const tr = fd.transform;
            const origin = tr.origin, xAxis = tr.xAxis, yAxis = tr.yAxis;
            const stops = [];
            for (let i = 0; i < g.stopCount; i++) {
                const s = g.getStop(i);
                stops.push({ pos: s.position, hsl: new Colour(s.colour).hslaf });
            }
            stops.sort((a, b) => a.pos - b.pos);
            function sampleAt(t) {
                t = Math.max(0, Math.min(1, t));
                if (stops.length === 0) return { h: 0, s: 0, l: 0.6, alpha: 1 };
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
        return function () { return { h: 0, s: 0, l: 0.6, alpha: 1 }; };
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

    function nextIndex(doc, prefix) {
        const re = new RegExp('^' + prefix + '_(\\d+)$');
        let maxIdx = 0;
        for (const l of doc.layers.all) {
            const m = re.exec(l.description);
            if (m) { const n = parseInt(m[1], 10); if (n > maxIdx) maxIdx = n; }
        }
        return maxIdx + 1;
    }

    function buildTriangleGroup(doc, srcNode, triangles, sampler, jitterParams, rng, useGradient) {
        const grpDef = NodesM.ContainerNodeDefinition.createDefault();
        grpDef.setUserDescription('TriangleFill_' + nextIndex(doc, 'TriangleFill'));
        const gBldr = AddChildNodesCommandBuilder.create();
        gBldr.addContainerNode(grpDef);
        const gCmd = gBldr.createCommand(false);
        doc.executeCommand(gCmd);
        const group = gCmd.newNodes[0];
        createdGroups.push(group); // v16: track immediately, even if a later build step fails

        doc.executeCommand(DocumentCommand.createMoveNodes(group.selfSelection, srcNode, NodeMoveType.After, NodeChildType.Main));
        const compTf = group.transform.inverted;
        doc.executeCommand(DocumentCommand.createTransform(group.selfSelection, compTf));

        const nodeTF = srcNode.transform;
        const nodeTFData = nodeTF.data;
        const bldr2 = AddChildNodesCommandBuilder.create();
        bldr2.setInsertionTarget(group);
        for (const t of triangles) {
            const cb = CurveBuilder.create();
            cb.beginXY(t[0].x, t[0].y);
            cb.lineToXY(t[1].x, t[1].y);
            cb.lineToXY(t[2].x, t[2].y);
            cb.close();
            const pc = PolyCurve.create();
            pc.addCurve(cb.createCurve());

            let fd = null;
            if (useGradient) {
                const cornerHsls = t.map(pt => jitterHSL(sampler(pt), jitterParams, rng));
                fd = buildTriangleGradientFD(t, cornerHsls);
            }
            if (!fd) {
                const baseHsl = sampler(triCentroid(t));
                fd = FillDescriptor.createSolid(Colour.createHSLAf(jitterHSL(baseHsl, jitterParams, rng)));
            }
            const def = NodesM.PolyCurveNodeDefinition.createDefault();
            def.setCurves(pc);
            def.setTransform(nodeTF.clone());
            if (def.brushFillDescriptorCount > 0) {
                def.setBrushFillDescriptor(fd, 0);
                while (def.brushFillDescriptorCount > 1) def.removeBrushFillDescriptor(def.brushFillDescriptorCount - 1);
            } else {
                def.insertBrushFillDescriptor(fd, 0);
            }
            def.currentBrushFillIndex = 0;
            bldr2.addNode(def);
        }
        const cmd2 = bldr2.createCommand(false);
        doc.executeCommand(cmd2);

        for (const tn of cmd2.newNodes) {
            const invActual = invertData(tn.transform.data);
            if (!invActual) continue;
            const deltaData = matMulData(nodeTFData, invActual);
            if (isIdentityData(deltaData)) continue;
            doc.executeCommand(DocumentCommand.createTransform(tn.selfSelection, dataToTransform(deltaData)));
        }
        return group;
    }

    // ---------------- Check selection ----------------

    const sel = doc.selection;
    if (sel.length !== 1 || !isVectorNode(sel.at(0).node)) {
        app.alert('Please select exactly one closed vector shape.', 'Triangle Fill');
        return;
    }
    const srcNodeOrig = sel.at(0).node;

    const posStart = doc.history.position;
    const srcNode = ensureMutable(doc, srcNodeOrig);
    const conversionHappened = !srcNode.isSameNode(srcNodeOrig);
    if (!isClosedNode(srcNode)) {
        app.alert('The selected shape must be closed.', 'Triangle Fill');
        if (conversionHappened) rollbackTo(posStart);
        return;
    }
    const shapeGroups = extractShapeGroups(srcNode);
    if (!shapeGroups || shapeGroups.length === 0) {
        app.alert('No closed contour found in the shape.', 'Triangle Fill');
        if (conversionHappened) rollbackTo(posStart);
        return;
    }
    const sampler = makeFillSampler(srcNode);

    // ---------------- Presets ----------------

    const PRESET_KEYS = ['targetCount', 'tolerancePct', 'minAngle', 'maxAngleTarget', 'innerPts', 'deleteSrc', 'seed', 'useGradient', 'gridMode', 'hMin', 'hMax', 'sMin', 'sMax', 'lMin', 'lMax'];
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
        const name = app.prompt('Name for the preset:', 'Triangle Fill', 'Preset1');
        if (!name || !name.trim()) return;
        try {
            const path = presetPath(name);
            const f = File.create(path, 'w');
            f.writeStringAsUtf8(encodePreset(params));
            f.close();
            app.alert('Preset saved as:\n' + path, 'Triangle Fill');
        } catch (e) {
            app.alert('Preset could not be saved: ' + e.message, 'Triangle Fill');
        }
    }
    function loadPreset() {
        const path = app.chooseFile();
        if (!path) return null;
        try {
            const txt = File.readAll(path).toString('utf8');
            const p = decodePreset(txt);
            if (!p) { app.alert('The file could not be read as a preset.', 'Triangle Fill'); return null; }
            return p;
        } catch (e) {
            app.alert('Preset could not be loaded: ' + e.message, 'Triangle Fill');
            return null;
        }
    }
    function deletePreset() {
        const path = app.chooseFile();
        if (!path) return;
        try {
            remove(path);
            app.alert('Preset deleted:\n' + path, 'Triangle Fill');
        } catch (e) {
            app.alert('Preset could not be deleted: ' + e.message, 'Triangle Fill');
        }
    }

    // ---------------- Dialog ----------------

    const dlg = Dialog.create('Triangle Fill');
    dlg.initialWidth = 820;
    dlg.setIsResizable(true);
    const col1 = dlg.addColumn();
    const col2 = dlg.addColumn();
    const col3 = dlg.addColumn();

    const gCount = col1.addGroup('Count');
    const edCount = gCount.addUnitValueEditor('Target number of triangles', 'none', 'none', null, 4, 20000);
    edCount.value = 30;
    const edTol = gCount.addUnitValueEditor('Tolerance (%)', 'none', 'none', null, 0, 200);
    edTol.value = 15;

    const gAngle = col1.addGroup('Smallest angle per triangle');
    const edMinA = gAngle.addUnitValueEditor('Min (deg)', 'none', 'none', null, 3, 55);
    edMinA.value = 10;
    const edMaxA = gAngle.addUnitValueEditor('Max (deg)', 'none', 'none', null, 5, 60);
    edMaxA.value = 30;
    gAngle.addStaticText('', 'Band for the SMALLEST angle of each triangle. Not in grid mode.');

    const gInner = col1.addGroup('Inner points');
    const edInner = gInner.addUnitValueEditor('Additional inner points', 'none', 'none', null, 0, 5000);
    edInner.value = 0;
    gInner.addStaticText('', 'No symbol of its own - just an extra vertex. Organic mode only.');

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

    const gOpt = col3.addGroup('Options');
    const cbDeleteSrc = gOpt.addCheckBox('Delete original shape', false);
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
            targetCount: edCount.value, tolerancePct: edTol.value,
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

    // ---------------- Preview ----------------

    let hasPreview = false;
    let previewKey = null;
    let lastRes = null;
    let lastGroup = null;

    // v16: explicit deletion of all preview groups instead of history rollback.
    function undoPreview() {
        clearCreatedGroups();
        hasPreview = false;
        previewKey = null;
        lastRes = null;
        lastGroup = null;
    }

    function updatePreview() {
        undoPreview();
        const params = readParams();
        if (params.targetCount < 2) return;
        try {
            const rng = mulberry32(params.seed);
            const refineOpts = {
                targetCount: params.targetCount, tolerancePct: params.tolerancePct,
                minAngle: params.minAngle, maxAngleTarget: params.maxAngleTarget,
                innerPts: params.innerPts, gridMode: params.gridMode
            };
            const res = triangulateWholeShape(shapeGroups, refineOpts, rng);
            if (!res.triangles || res.triangles.length === 0) return;
            const jitterParams = {
                hMin: params.hMin, hMax: params.hMax, sMin: params.sMin, sMax: params.sMax,
                lMin: params.lMin, lMax: params.lMax
            };
            const group = buildTriangleGroup(doc, srcNode, res.triangles, sampler, jitterParams, rng, params.useGradient);
            lastRes = res;
            lastGroup = group;
            hasPreview = true;
            previewKey = previewKeyOf(params);
        } catch (e) {
            clearCreatedGroups(); // do not leave a half-built group behind
            hasPreview = false;
            app.alert('Preview failed: ' + e.message, 'Triangle Fill');
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
        if (conversionHappened) rollbackTo(posStart);
        return;
    }

    if (!hasPreview || previewKey !== previewKeyOf(readParams())) {
        updatePreview();
    }
    if (!hasPreview) {
        app.alert('No triangles could be created.', 'Triangle Fill');
        undoPreview();
        if (conversionHappened) rollbackTo(posStart);
        return;
    }

    // The accepted group stays - no longer tracked as a preview.
    createdGroups.length = 0;

    const finalParams = readParams();
    if (finalParams.deleteSrc) {
        doc.executeCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, [srcNode])));
    }

    let msg = 'Done.\n\nTriangles created: ' + lastRes.triangles.length +
        '\nShape parts detected (separate outer contours): ' + lastRes.groupCount +
        '\nIterations: ' + lastRes.iterations +
        '\nUpper limit (diagnostic): ' + lastRes.hardCap +
        '\nAdditional inner points placed: ' + lastRes.innerPlaced + (lastRes.innerPlaced < lastRes.innerRequested ? ' (of ' + lastRes.innerRequested + ' requested)' : '') +
        '\nGroup: "' + lastGroup.description + '"' +
        '\nMode: ' + (finalParams.gridMode ? 'Regular grid' : 'Organic (Delaunay)') +
        '\nFill: ' + (finalParams.useGradient ? 'Gradient per triangle' : 'Solid colour per triangle') +
        '\nRandom seed: ' + finalParams.seed;
    if (!finalParams.gridMode) {
        msg += '\n\nSmallest angle per triangle (band ' + finalParams.minAngle + '-' + finalParams.maxAngleTarget + ' deg):' +
            '\n  Smallest value overall: ' + lastRes.achievedMinAngle.toFixed(1) + ' deg' +
            '\n  Largest value overall: ' + lastRes.achievedMaxOfMinAngle.toFixed(1) + ' deg' +
            '\n  Average: ' + lastRes.achievedAvgMinAngle.toFixed(1) + ' deg' +
            '\n  Share of triangles in the band: ' + lastRes.pctInBand + '%' +
            '\n  Inner-point moves to keep the band: ' + lastRes.relaxedMoves +
            (lastRes.pctInBand < 100 ? '\n  (Triangles made only of boundary points cannot be deformed.)' : '');
    } else {
        msg += '\n\nGrid mode: angle parameters were ignored (grid triangles are approximately equilateral).';
    }
    if (lastRes.capped) {
        msg += '\n\nNote: the safety limit for the total count was reached ' +
            '(probably sharp/concave corners in the shape). For more triangles: reduce the min. ' +
            'angle or increase the target count/tolerance.';
    }
    app.alert(msg, 'Triangle Fill');
})();
