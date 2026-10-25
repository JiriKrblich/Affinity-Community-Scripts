/**
 * name: Word Art
 * version: 0.1.0
 * description: Arranges selected Art Text objects inside (or around) a key shape by changing their size, angle and position. Modes: Packed (dense word cloud on real glyph outlines), Flow (readable rows clipped to the shape, optional flow angle) and Outline (words as rays or along the edge). Optional repeat-to-fill with duplicates, seeded randomness and native live preview.
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
const { UnitType } = require('/units');
const { Timer } = require('/timers.js');

const SCRIPT_NAME = 'Word Art';
const VERSION = '0.1.0';
const SCRIPT_TITLE = SCRIPT_NAME + ' v' + VERSION;

const PREVIEW_DEBOUNCE_MS = 250;
const QUALITY_CELLS = [100, 150, 230];          // grid cells along the longer side of the region

const MODES = ['Packed', 'Flow', 'Outline'];
const KEY_PICKS = ['Auto (non-text)', 'First selected', 'Last selected'];
const WORD_ORDERS = ['Selection', 'Shuffle'];
const SIZE_BY = ['Selection order', 'Original size', 'Shorter is larger', 'Random', 'Uniform'];
const ROTATIONS = ['None', 'Horizontal + Vertical', 'Steps', 'Random'];
const OUTLINE_STYLES = ['Rays outward', 'Rays inward', 'Along edge'];
const REGIONS = ['Inside', 'Outside'];
const COLLISIONS = ['Glyphs', 'Boxes'];
const PLACEMENTS = ['Center out', 'Random', 'Top to bottom'];
const ALIGNMENTS = ['Fit width', 'Justify', 'Center', 'Left', 'Right'];
const FIT_MIN_SHRINK = 0.7;                     // Flow / Fit width: smallest line scale
const QUALITIES = ['Draft', 'Normal', 'Fine'];

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function makeRandom(seed) {
    let a = (Math.floor(Math.abs(seed)) * 2654435761 + 0x9E3779B9) >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function shuffle(list, rand) {
    for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        const t = list[i]; list[i] = list[j]; list[j] = t;
    }
    return list;
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

function compactError(error) {
    return String(error && error.message ? error.message : error).replace(/\s+/g, ' ').trim();
}

function nodeName(node) {
    try { return node.userDescription || node.defaultDescription || 'Element'; } catch (_) { return 'Element'; }
}

function isHidden(node) {
    try { return node.isVisibleInDomain === false; } catch (_) { return false; }
}

function childList(node) {
    const list = [];
    try { for (const child of node.children) list.push(child); } catch (_) { /* no children */ }
    return list;
}

function getCurvesInterface(node) {
    try { return node.curvesInterface || null; } catch (_) { return null; }
}

function isArtText(node) {
    try { return node.isArtTextNode === true; } catch (_) { return false; }
}

function isTextLike(node) {
    try { return node.isTextNode === true || node.isArtTextNode === true; } catch (_) { return false; }
}

function maxScale(d) {
    const a = d[0], b = d[1], c = d[3], e = d[4];
    const s1 = a * a + b * b + c * c + e * e;
    const det = a * e - b * c;
    const disc = Math.sqrt(Math.max(0, s1 * s1 - 4 * det * det));
    return Math.sqrt(Math.max(1e-12, (s1 + disc) / 2));
}

// ---------------------------------------------------------------------------
// Outline extraction. A part is a set of rings filled with one fill rule.
// ---------------------------------------------------------------------------

function makeRing(xs, ys) {
    let n = xs.length;
    if (n > 2 && Math.abs(xs[0] - xs[n - 1]) < 1e-9 && Math.abs(ys[0] - ys[n - 1]) < 1e-9) n -= 1;
    if (n < 3) return null;
    const X = new Float64Array(n), Y = new Float64Array(n);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
        X[i] = xs[i]; Y[i] = ys[i];
        if (X[i] < minX) minX = X[i]; if (X[i] > maxX) maxX = X[i];
        if (Y[i] < minY) minY = Y[i]; if (Y[i] > maxY) maxY = Y[i];
    }
    return { X, Y, n, minX, minY, maxX, maxY };
}

function makePart(rings, nonZero) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of rings) {
        minX = Math.min(minX, r.minX); minY = Math.min(minY, r.minY);
        maxX = Math.max(maxX, r.maxX); maxY = Math.max(maxY, r.maxY);
    }
    return { rings, nonZero, minX, minY, maxX, maxY };
}

function partsBounds(parts) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of parts) {
        minX = Math.min(minX, p.minX); minY = Math.min(minY, p.minY);
        maxX = Math.max(maxX, p.maxX); maxY = Math.max(maxY, p.maxY);
    }
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

// Reads the curves of `node`; `d` maps base coordinates to the output space
// (null = keep base coordinates). Every poly curve becomes one part.
function curvesToParts(node, ci, d, tolerance, nonZero, out) {
    const ppc = ci.polyPolyCurves;
    for (let j = 0; j < ppc.polyCurveCount; j++) {
        const pc = ppc.getTransformedPolyCurve(j);
        const rings = [];
        for (let i = 0; i < pc.curveCount; i++) {
            const poly = new Polygon(pc.at(i).generatePolygon(tolerance));
            const count = poly.pointCount;
            if (count < 3) continue;
            const xs = new Array(count), ys = new Array(count);
            for (let k = 0; k < count; k++) {
                const p = poly.getPoint(k);
                if (d) {
                    xs[k] = d[0] * p.x + d[1] * p.y + d[2];
                    ys[k] = d[3] * p.x + d[4] * p.y + d[5];
                } else {
                    xs[k] = p.x; ys[k] = p.y;
                }
            }
            const ring = makeRing(xs, ys);   // Affinity fills open curves as if closed
            if (ring) rings.push(ring);
        }
        if (rings.length) out.push(makePart(rings, nonZero));
    }
}

function addBoxPart(node, out) {
    try {
        const b = node.baseBox;
        const d = node.baseToSpreadTransform.data;
        const pts = [[b.x, b.y], [b.x + b.width, b.y], [b.x + b.width, b.y + b.height], [b.x, b.y + b.height]];
        const ring = makeRing(pts.map(p => d[0] * p[0] + d[1] * p[1] + d[2]), pts.map(p => d[3] * p[0] + d[4] * p[1] + d[5]));
        if (ring) out.push(makePart([ring], false));
    } catch (_) { /* no box */ }
}

// Key object outline in spread coordinates (curves, shapes, text, groups, images).
function collectShapeParts(node, out, depth) {
    if (depth > 64 || (depth > 0 && isHidden(node))) return;
    const ci = getCurvesInterface(node);
    if (ci) {
        const d = node.baseToSpreadTransform.data;
        let size = 1000;
        try { const bb = node.getSpreadBaseBox(); size = Math.max(bb.width, bb.height); } catch (_) { /* default */ }
        const tol = Math.max(1e-4, size / 3000) / maxScale(d);
        curvesToParts(node, ci, d, tol, isTextLike(node), out);
        return;
    }
    const kids = childList(node);
    if (kids.length) { for (const kid of kids) collectShapeParts(kid, out, depth + 1); return; }
    if (node.isImageNode || node.isRasterNode) addBoxPart(node, out);
}

// ---------------------------------------------------------------------------
// Scanline helpers
// ---------------------------------------------------------------------------

// NOTE: Affinity's script engine runs closures (functions that capture outer
// variables) far slower than top-level functions. Every hot loop below is a
// top-level function that only touches its parameters and locals.

function makeScanBuffer(parts) {
    let edges = 4;
    for (const p of parts) for (const r of p.rings) edges += r.n;
    return { X: new Float64Array(edges), D: new Int8Array(edges) };
}

// Sorted edge crossings of `part` with the horizontal line y; returns the count.
function scanCrossings(part, y, buf) {
    const BX = buf.X, BD = buf.D;
    const rings = part.rings;
    let m = 0;
    for (let r = 0; r < rings.length; r++) {
        const ring = rings[r];
        if (y < ring.minY || y > ring.maxY) continue;
        const X = ring.X, Y = ring.Y, n = ring.n;
        let j = n - 1;
        for (let i = 0; i < n; i++) {
            const y0 = Y[j], y1 = Y[i];
            if ((y0 <= y) !== (y1 <= y)) {
                BX[m] = X[j] + (y - y0) * (X[i] - X[j]) / (y1 - y0);
                BD[m] = y1 > y0 ? 1 : -1;
                m++;
            }
            j = i;
        }
    }
    for (let a = 1; a < m; a++) {
        const x = BX[a], d = BD[a];
        let b = a - 1;
        while (b >= 0 && BX[b] > x) { BX[b + 1] = BX[b]; BD[b + 1] = BD[b]; b--; }
        BX[b + 1] = x; BD[b + 1] = d;
    }
    return m;
}

// Pushes inside intervals [a0, b0, a1, b1, ...] of `part` on the horizontal line y.
function partIntervals(part, y, out, buf) {
    if (y < part.minY || y > part.maxY) return;
    const m = scanCrossings(part, y, buf);
    const BX = buf.X, BD = buf.D, nonZero = part.nonZero;
    let w = 0, start = 0;
    for (let k = 0; k < m; k++) {
        const was = nonZero ? w !== 0 : (w & 1) === 1;
        w += nonZero ? BD[k] : 1;
        const now = nonZero ? w !== 0 : (w & 1) === 1;
        if (!was && now) start = BX[k];
        else if (was && !now && BX[k] > start) out.push(start, BX[k]);
    }
}

function mergeIntervals(flat) {
    const list = [];
    for (let i = 0; i < flat.length; i += 2) list.push([flat[i], flat[i + 1]]);
    list.sort((p, q) => p[0] - q[0]);
    const merged = [];
    for (const iv of list) {
        const last = merged[merged.length - 1];
        if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
        else merged.push([iv[0], iv[1]]);
    }
    return merged;
}

function unionIntervalsAt(parts, y, buf) {
    const flat = [];
    for (let i = 0; i < parts.length; i++) partIntervals(parts[i], y, flat, buf);
    return mergeIntervals(flat);
}

function intersectIntervals(a, b) {
    const out = [];
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
        const lo = Math.max(a[i][0], b[j][0]), hi = Math.min(a[i][1], b[j][1]);
        if (hi > lo) out.push([lo, hi]);
        if (a[i][1] < b[j][1]) i++; else j++;
    }
    return out;
}

function pointInParts(parts, x, y, buf) {
    for (const p of parts) {
        if (x < p.minX || x > p.maxX || y < p.minY || y > p.maxY) continue;
        const flat = [];
        partIntervals(p, y, flat, buf);
        for (let k = 0; k < flat.length; k += 2) if (x >= flat[k] && x <= flat[k + 1]) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Raster grids
// ---------------------------------------------------------------------------

// grid = { x0, y0, c, W, H }: cell (i, j) covers [x0 + i c, x0 + (i + 1) c) x [y0 + j c, ...).
// Cells whose centre lies inside the parts are set to 1.
function rasterInterior(parts, grid, cells, buf) {
    const x0 = grid.x0, y0 = grid.y0, c = grid.c, W = grid.W, H = grid.H;
    const BX = buf.X, BD = buf.D;
    for (let p = 0; p < parts.length; p++) {
        const part = parts[p];
        const nonZero = part.nonZero;
        let jStart = Math.floor((part.minY - y0) / c - 0.5);
        let jEnd = Math.ceil((part.maxY - y0) / c - 0.5);
        if (jStart < 0) jStart = 0;
        if (jEnd > H - 1) jEnd = H - 1;
        for (let j = jStart; j <= jEnd; j++) {
            const y = y0 + (j + 0.5) * c;
            const m = scanCrossings(part, y, buf);
            let w = 0, start = 0;
            for (let k = 0; k < m; k++) {
                const was = nonZero ? w !== 0 : (w & 1) === 1;
                w += nonZero ? BD[k] : 1;
                const now = nonZero ? w !== 0 : (w & 1) === 1;
                if (!was && now) { start = BX[k]; continue; }
                if (!(was && !now)) continue;
                let i0 = Math.ceil((start - x0) / c - 0.5);
                let i1 = Math.floor((BX[k] - x0) / c - 0.5);
                if (i0 < 0) i0 = 0;
                if (i1 > W - 1) i1 = W - 1;
                const row = j * W;
                for (let i = i0; i <= i1; i++) cells[row + i] = 1;
            }
        }
    }
}

// Marks the cells along every outline segment (sampled at half-cell steps).
function rasterEdges(parts, grid, cells) {
    const x0 = grid.x0, y0 = grid.y0, inv = 1 / grid.c, W = grid.W, H = grid.H;
    for (let p = 0; p < parts.length; p++) {
        const rings = parts[p].rings;
        for (let r = 0; r < rings.length; r++) {
            const X = rings[r].X, Y = rings[r].Y, n = rings[r].n;
            let px = (X[n - 1] - x0) * inv, py = (Y[n - 1] - y0) * inv;
            for (let i = 0; i < n; i++) {
                const qx = (X[i] - x0) * inv, qy = (Y[i] - y0) * inv;
                const dx = qx - px, dy = qy - py;
                const adx = dx < 0 ? -dx : dx, ady = dy < 0 ? -dy : dy;
                const steps = (((adx > ady ? adx : ady) * 2) | 0) + 1;
                const sx = dx / steps, sy = dy / steps;
                let x = px, y = py;
                for (let k = 0; k <= steps; k++) {
                    if (x >= 0 && y >= 0) {
                        const ci = x | 0, cj = y | 0;
                        if (ci < W && cj < H) cells[cj * W + ci] = 1;
                    }
                    x += sx; y += sy;
                }
                px = qx; py = qy;
            }
        }
    }
}

// One 1-D pass of the Felzenszwalb squared distance transform.
function edtPass(f, d, v, z, len) {
    let k = 0;
    v[0] = 0; z[0] = -1e20; z[1] = 1e20;
    for (let q = 1; q < len; q++) {
        const fq = f[q] + q * q;
        let vk = v[k];
        let s = (fq - (f[vk] + vk * vk)) / (2 * (q - vk));
        while (s <= z[k]) {
            k--;
            vk = v[k];
            s = (fq - (f[vk] + vk * vk)) / (2 * (q - vk));
        }
        k++; v[k] = q; z[k] = s; z[k + 1] = 1e20;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
        while (z[k + 1] < q) k++;
        const dq = q - v[k];
        d[q] = dq * dq + f[v[k]];
    }
}

// Squared Euclidean distance (in cells) to the nearest cell where feature[k] != 0.
function distanceTransform(feature, W, H) {
    const out = new Float64Array(W * H);
    const n = W > H ? W : H;
    const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
    for (let i = 0; i < W; i++) {
        for (let j = 0; j < H; j++) f[j] = feature[j * W + i] ? 0 : 1e20;
        edtPass(f, d, v, z, H);
        for (let j = 0; j < H; j++) out[j * W + i] = d[j];
    }
    for (let j = 0; j < H; j++) {
        const row = j * W;
        for (let i = 0; i < W; i++) f[i] = out[row + i];
        edtPass(f, d, v, z, W);
        for (let i = 0; i < W; i++) out[row + i] = d[i];
    }
    return out;
}

// Converts a cell mask into row runs: flat [dy, a, b, ...] relative to (offI, offJ).
function maskToRuns(cells, W, H, offI, offJ) {
    const runs = [];
    for (let j = 0; j < H; j++) {
        const row = j * W;
        let i = 0;
        while (i < W) {
            if (!cells[row + i]) { i++; continue; }
            const a = i;
            while (i < W && cells[row + i]) i++;
            runs.push(j + offJ, a + offI, i - 1 + offI);
        }
    }
    return runs;
}

// Test order: runs of the middle rows first, they collide most often.
function orderRuns(runs) {
    const count = runs.length / 3;
    let minJ = 0, maxJ = 0;
    for (let k = 0; k < runs.length; k += 3) {
        if (k === 0 || runs[k] < minJ) minJ = runs[k];
        if (k === 0 || runs[k] > maxJ) maxJ = runs[k];
    }
    const mid = (minJ + maxJ) >> 1;
    const span = maxJ - minJ + 2;
    const start = new Int32Array(span + 1);
    for (let k = 0; k < runs.length; k += 3) { const dist = runs[k] - mid; start[(dist < 0 ? -dist : dist) + 1]++; }
    for (let b = 1; b <= span; b++) start[b] += start[b - 1];
    const out = new Int32Array(count * 3);
    for (let k = 0; k < runs.length; k += 3) {
        const dist = runs[k] - mid;
        const at = start[dist < 0 ? -dist : dist]++ * 3;
        out[at] = runs[k]; out[at + 1] = runs[k + 1]; out[at + 2] = runs[k + 2];
    }
    return out;
}

// Longest test run per sprite row (index dy - minDy).
function rowNeeds(test, minDy, maxDy) {
    const need = new Int32Array(maxDy - minDy + 1);
    for (let k = 0; k < test.length; k += 3) {
        const len = test[k + 2] - test[k + 1] + 1;
        const at = test[k] - minDy;
        if (len > need[at]) need[at] = len;
    }
    return need;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

function readFontSize(node) {
    try {
        const story = node.storyInterface.story;
        let best = 0;
        const len = Math.min(story.length, 64);
        for (let i = 0; i < len; i++) {
            const h = story.getGlyphAtts(i).height;
            if (Number.isFinite(h) && h > best) best = h;
        }
        if (best > 0) return best;
    } catch (_) { /* fall through */ }
    return 0;
}

function buildWord(node, index) {
    const ci = getCurvesInterface(node);
    if (!ci) return null;
    let font = readFontSize(node);
    let parts = [];
    const tol = Math.max(1e-3, (font || 20) * 0.004);
    curvesToParts(node, ci, null, tol, true, parts);
    if (!parts.length) return null;
    const b = partsBounds(parts);
    if (!(b.width > 0) || !(b.height > 0)) return null;
    if (!(font > 0)) font = b.height;
    const B = node.baseToSpreadTransform;
    const spreadFont = font * Math.sqrt(Math.abs(B.data[0] * B.data[4] - B.data[1] * B.data[3]));
    let text = '';
    try { text = node.storyInterface.story.text || ''; } catch (_) { /* no text */ }
    return {
        node, index, parts, font, spreadFont,
        minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY,
        cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2,
        widthEm: b.width / font, heightEm: b.height / font,
        ascEm: Math.max(0, -b.minY / font), descEm: Math.max(0, b.maxY / font),
        name: nodeName(node), text,
        B,
        scratch: null, scanBuf: null, sprites: new Map()
    };
}

// Reusable transformed copy of the word outline (avoids allocations per sprite).
function wordScratch(word, boxes) {
    if (boxes) {
        if (!word.boxScratch) {
            const ring = { X: new Float64Array(4), Y: new Float64Array(4), n: 4, minX: 0, minY: 0, maxX: 0, maxY: 0 };
            const bx = [word.minX, word.maxX, word.maxX, word.minX], by = [word.minY, word.minY, word.maxY, word.maxY];
            word.boxScratch = {
                parts: [{ rings: [ring], nonZero: true, minX: 0, minY: 0, maxX: 0, maxY: 0 }],
                src: [{ rings: [{ X: Float64Array.from(bx), Y: Float64Array.from(by), n: 4 }] }],
                buf: { X: new Float64Array(8), D: new Int8Array(8) }
            };
        }
        return word.boxScratch;
    }
    if (!word.scratch) {
        word.scratch = {
            parts: word.parts.map(part => ({
                rings: part.rings.map(r => ({ X: new Float64Array(r.n), Y: new Float64Array(r.n), n: r.n, minX: 0, minY: 0, maxX: 0, maxY: 0 })),
                nonZero: true, minX: 0, minY: 0, maxX: 0, maxY: 0
            })),
            src: word.parts,
            buf: makeScanBuffer(word.parts)
        };
    }
    return word.scratch;
}

// Writes src -> dst with the affine (a b; d e) about (ax, ay); updates bounds. Returns overall bounds.
function transformScratch(src, dst, a, b, d, e, ax, ay, out) {
    let gMinX = Infinity, gMinY = Infinity, gMaxX = -Infinity, gMaxY = -Infinity;
    for (let p = 0; p < src.length; p++) {
        const sr = src[p].rings, dp = dst[p], dr = dp.rings;
        let pMinX = Infinity, pMinY = Infinity, pMaxX = -Infinity, pMaxY = -Infinity;
        for (let r = 0; r < sr.length; r++) {
            const SX = sr[r].X, SY = sr[r].Y, n = sr[r].n, DX = dr[r].X, DY = dr[r].Y;
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (let k = 0; k < n; k++) {
                const u = SX[k] - ax, v = SY[k] - ay;
                const x = a * u + b * v, y = d * u + e * v;
                DX[k] = x; DY[k] = y;
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
            }
            const ring = dr[r];
            ring.minX = minX; ring.minY = minY; ring.maxX = maxX; ring.maxY = maxY;
            if (minX < pMinX) pMinX = minX; if (maxX > pMaxX) pMaxX = maxX;
            if (minY < pMinY) pMinY = minY; if (maxY > pMaxY) pMaxY = maxY;
        }
        dp.minX = pMinX; dp.minY = pMinY; dp.maxX = pMaxX; dp.maxY = pMaxY;
        if (pMinX < gMinX) gMinX = pMinX; if (pMaxX > gMaxX) gMaxX = pMaxX;
        if (pMinY < gMinY) gMinY = pMinY; if (pMaxY > gMaxY) gMaxY = pMaxY;
    }
    out.minX = gMinX; out.minY = gMinY; out.maxX = gMaxX; out.maxY = gMaxY;
    return out;
}

function cachedSprite(word, em, deg, c, padCells, boxes) {
    const key = c.toFixed(4) + '|' + padCells.toFixed(3) + '|' + (boxes ? 1 : 0) + '|' + deg.toFixed(2) + '|' + em.toFixed(3);
    let sp = word.sprites.get(key);
    if (!sp) {
        if (word.sprites.size > 400) word.sprites.clear();
        sp = buildSprite(word, em, -deg * Math.PI / 180, c, padCells, boxes);
        word.sprites.set(key, sp);
    }
    return sp;
}

// Raster sprite of a word scaled to em size `em` (spread px) and rotated by `r` (command radians).
function buildSprite(word, em, r, c, padCells, boxes) {
    const s = em / word.font;
    const cos = Math.cos(r), sin = Math.sin(r);
    const sc = wordScratch(word, boxes);
    const bb = transformScratch(sc.src, sc.parts, s * cos, -s * sin, s * sin, s * cos, word.cx, word.cy, {});
    const parts = sc.parts;
    const pad = Math.ceil(padCells) + 1;
    const iMin = Math.floor(bb.minX / c + 0.5) - pad, iMax = Math.floor(bb.maxX / c + 0.5) + pad;
    const jMin = Math.floor(bb.minY / c + 0.5) - pad, jMax = Math.floor(bb.maxY / c + 0.5) + pad;
    const W = iMax - iMin + 1, H = jMax - jMin + 1;
    const grid = { x0: (iMin - 0.5) * c, y0: (jMin - 0.5) * c, c, W, H };
    const cells = new Uint8Array(W * H);
    rasterInterior(parts, grid, cells, sc.buf);
    rasterEdges(parts, grid, cells);
    const body = maskToRuns(cells, W, H, iMin, jMin);
    let test = body;
    if (padCells >= 0.5) {
        const d2 = distanceTransform(cells, W, H);
        const lim = padCells * padCells;
        const dil = new Uint8Array(W * H);
        for (let k = 0; k < W * H; k++) dil[k] = d2[k] <= lim ? 1 : 0;
        test = maskToRuns(dil, W, H, iMin, jMin);
    }
    let minDy = 0, maxDy = 0, minDx = 0, maxDx = 0;
    for (let k = 0; k < test.length; k += 3) {
        if (test[k] < minDy) minDy = test[k];
        if (test[k] > maxDy) maxDy = test[k];
        if (test[k + 1] < minDx) minDx = test[k + 1];
        if (test[k + 2] > maxDx) maxDx = test[k + 2];
    }
    return { body: new Int32Array(body), test: orderRuns(test), need: rowNeeds(test, minDy, maxDy), scale: s, r, minDx, maxDx, minDy, maxDy };
}

// ---------------------------------------------------------------------------
// Packed mode
// ---------------------------------------------------------------------------

// Occupancy grid with per-row prefix sums: a run [a, b] in row j is free when
// pre[j][b + 1] === pre[j][a]. maxRun[j] is the longest free run of row j.
function makeOccupancy(W, H, blocked) {
    const o = { W, H, cells: blocked, pre: new Int32Array(H * (W + 1)), maxRun: new Int32Array(H), rowOK: new Uint8Array(H) };
    for (let j = 0; j < H; j++) occUpdateRow(o.cells, o.pre, o.maxRun, W, j);
    return o;
}

function occUpdateRow(cells, pre, maxRun, W, j) {
    const base = j * (W + 1), row = j * W;
    let sum = 0, run = 0, best = 0;
    pre[base] = 0;
    for (let i = 0; i < W; i++) {
        const v = cells[row + i];
        sum += v;
        pre[base + i + 1] = sum;
        if (v) run = 0; else { run++; if (run > best) best = run; }
    }
    maxRun[j] = best;
}

function occPlace(o, body, ci, cj) {
    const W = o.W, H = o.H, cells = o.cells;
    for (let k = 0; k < body.length; k += 3) {
        const j = cj + body[k];
        if (j < 0 || j >= H) continue;
        let a = ci + body[k + 1], b = ci + body[k + 2];
        if (a < 0) a = 0;
        if (b > W - 1) b = W - 1;
        const row = j * W;
        for (let i = a; i <= b; i++) cells[row + i] = 1;
    }
    // Runs are stored row by row, so each touched row is refreshed once.
    let lastRow = -1;
    for (let k = 0; k < body.length; k += 3) {
        const j = cj + body[k];
        if (j < 0 || j >= H || j === lastRow) continue;
        occUpdateRow(cells, o.pre, o.maxRun, W, j);
        lastRow = j;
    }
}

// Marks the centre rows where every sprite row could still find a long enough
// free run; returns how many rows qualify.
function feasibleRows(o, sp) {
    const H = o.H, maxRun = o.maxRun, rowOK = o.rowOK, need = sp.need, minDy = sp.minDy, h = need.length;
    const jLo = -sp.minDy, jHi = H - 1 - sp.maxDy;
    let count = 0;
    for (let cj = 0; cj < H; cj++) {
        let ok = cj >= jLo && cj <= jHi;
        if (ok) {
            const top = cj + minDy;
            for (let t = 0; t < h; t++) { if (need[t] > maxRun[top + t]) { ok = false; break; } }
        }
        rowOK[cj] = ok ? 1 : 0;
        if (ok) count++;
    }
    return count;
}

// First candidate cell where the sprite fits, or -1.
function findSpot(o, sp, cand, candRow, candLen) {
    if (!feasibleRows(o, sp)) return -1;
    const W = o.W, cells = o.cells, pre = o.pre, rowOK = o.rowOK, W1 = W + 1;
    const test = sp.test, tl = test.length;
    const iLo = -sp.minDx, iHi = W - 1 - sp.maxDx;
    for (let k = 0; k < candLen; k++) {
        const cj = candRow[k];
        if (!rowOK[cj]) continue;
        const idx = cand[k];
        if (cells[idx]) continue;
        const ci = idx - cj * W;
        if (ci < iLo || ci > iHi) continue;
        let ok = true;
        for (let t = 0; t < tl; t += 3) {
            const base = (cj + test[t]) * W1 + ci;
            if (pre[base + test[t + 2] + 1] !== pre[base + test[t + 1]]) { ok = false; break; }
        }
        if (ok) return idx;
    }
    return -1;
}

function compactCandidates(cand, candRow, candLen, cells) {
    let m = 0;
    for (let k = 0; k < candLen; k++) {
        const idx = cand[k];
        if (!cells[idx]) { cand[m] = idx; candRow[m] = candRow[k]; m++; }
    }
    return m;
}

function candidateRows(cand, W) {
    const rows = new Int32Array(cand.length);
    for (let k = 0; k < cand.length; k++) rows[k] = (cand[k] / W) | 0;
    return rows;
}

function hash32(k, seed) {
    let h = Math.imul(k ^ seed, 0x9E3779B1);
    h ^= h >>> 15; h = Math.imul(h, 0x85EBCA77); h ^= h >>> 13;
    return h >>> 0;
}

// Free cells ordered by preference, via counting sort on integer keys.
function candidateOrder(region, placement, seed) {
    const W = region.grid.W, H = region.grid.H, blocked = region.blocked;
    const N = W * H;
    const keys = new Int32Array(N);
    let maxKey = 0, count = 0;
    const ci = region.ci, cj = region.cj;
    for (let k = 0; k < N; k++) {
        if (blocked[k]) continue;
        count++;
        let key;
        if (placement === 1) key = hash32(k, seed) & 0xFFFF;
        else if (placement === 2) key = 0;
        else {
            const j = (k / W) | 0, i = k - j * W;
            const di = i - ci, dj = j - cj;
            key = (Math.sqrt(di * di + dj * dj) * 2 + (hash32(k, seed) & 255) / 85) | 0;
        }
        keys[k] = key;
        if (key > maxKey) maxKey = key;
    }
    const start = new Int32Array(maxKey + 2);
    for (let k = 0; k < N; k++) if (!blocked[k]) start[keys[k] + 1]++;
    for (let b = 1; b <= maxKey + 1; b++) start[b] += start[b - 1];
    const out = new Int32Array(count);
    for (let k = 0; k < N; k++) if (!blocked[k]) out[start[keys[k]]++] = k;
    return out;
}

function buildRegion(shapeParts, options) {
    const sb = partsBounds(shapeParts);
    const outside = options.region === 1;
    let fx0 = sb.minX, fy0 = sb.minY, fx1 = sb.maxX, fy1 = sb.maxY;
    if (outside) {
        const e = Math.max(sb.width, sb.height) * options.extent / 100;
        fx0 -= e; fy0 -= e; fx1 += e; fy1 += e;
    }
    const longSide = Math.max(fx1 - fx0, fy1 - fy0);
    const c = longSide / QUALITY_CELLS[options.quality];
    const W = Math.max(4, Math.ceil((fx1 - fx0) / c) + 2), H = Math.max(4, Math.ceil((fy1 - fy0) / c) + 2);
    const grid = { x0: fx0 - c, y0: fy0 - c, c, W, H };
    const inside = new Uint8Array(W * H);
    rasterInterior(shapeParts, grid, inside, makeScanBuffer(shapeParts));
    const blocked = new Uint8Array(W * H);
    rasterEdges(shapeParts, grid, blocked);          // edge cells are never free
    markRegion(blocked, inside, W, H, outside);
    const marginCells = options.margin / c;
    let d2 = distanceTransform(blocked, W, H);
    if (marginCells >= 0.5) {
        erodeFree(blocked, d2, marginCells * marginCells);
        d2 = distanceTransform(blocked, W, H);
    }
    // Center: pole of inaccessibility for Inside, shape center for Outside.
    let ci = 0, cj = 0;
    if (outside) {
        ci = Math.floor(((sb.minX + sb.maxX) / 2 - grid.x0) / c);
        cj = Math.floor(((sb.minY + sb.maxY) / 2 - grid.y0) / c);
    } else {
        const best = argMaxFree(blocked, d2);
        ci = best % W; cj = (best / W) | 0;
    }
    let freeCount = 0;
    for (let k = 0; k < W * H; k++) if (!blocked[k]) freeCount++;
    return { grid, blocked, ci, cj, freeCount, shapeBounds: sb };
}

function markRegion(blocked, inside, W, H, outside) {
    for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
            const k = j * W + i;
            if (blocked[k]) continue;
            if (i === 0 || j === 0 || i === W - 1 || j === H - 1) { blocked[k] = 1; continue; }
            blocked[k] = (outside ? !inside[k] : inside[k]) ? 0 : 1;
        }
    }
}

function erodeFree(blocked, d2, lim) {
    for (let k = 0; k < blocked.length; k++) if (!blocked[k] && d2[k] <= lim) blocked[k] = 1;
}

function argMaxFree(blocked, d2) {
    let best = -1, at = 0;
    for (let k = 0; k < blocked.length; k++) if (!blocked[k] && d2[k] > best) { best = d2[k]; at = k; }
    return at;
}

function wordAngles(options, rand) {
    // Returns [primary, ...alternatives] in visible degrees (counter-clockwise positive).
    const mode = options.rotation;
    if (mode === 0) return [0];
    if (mode === 1) {
        const vertical = rand() * 100 < options.vRatio;
        return vertical ? [90, 0] : [0, 90];
    }
    const range = Math.abs(options.angleRange);
    if (mode === 2) {
        const steps = Math.max(1, Math.round(options.angleSteps));
        const set = [];
        if (steps === 1) set.push(0);
        else for (let k = 0; k < steps; k++) set.push(-range + 2 * range * k / (steps - 1));
        shuffle(set, rand);
        return set.slice(0, 4);
    }
    return [0, 1, 2].map(() => (rand() * 2 - 1) * range);
}

function targetSizes(words, options, maxEm, floorEm, minEm, rand) {
    const n = words.length;
    const gamma = clamp(options.sizeCurve, 0.1, 10);
    const out = new Map();
    const byRank = list => list.forEach((w, rank) => {
        const t = n > 1 ? rank / (n - 1) : 0;
        out.set(w, maxEm * Math.pow(floorEm / maxEm, Math.pow(t, gamma)));
    });
    switch (options.sizeBy) {
        case 1: {
            const top = Math.max(...words.map(w => w.spreadFont));
            for (const w of words) out.set(w, Math.max(minEm, maxEm * w.spreadFont / top));
            break;
        }
        case 2: byRank(words.slice().sort((a, b) => a.widthEm - b.widthEm)); break;
        case 3: for (const w of words) out.set(w, maxEm * Math.pow(floorEm / maxEm, Math.pow(rand(), gamma))); break;
        case 4: for (const w of words) out.set(w, maxEm); break;
        default: byRank(words);
    }
    return out;
}

// Sizes snap to a geometric ladder so sprites can be cached and failures pruned.
const SIZE_STEP = 0.93;

function ladderIndex(em, maxEm) { return Math.max(0, Math.round(Math.log(em / maxEm) / Math.log(SIZE_STEP))); }
function ladderEm(k, maxEm) { return maxEm * Math.pow(SIZE_STEP, k); }

function getRegion(state, shapeParts, options) {
    const key = [options.region, options.extent, options.margin, options.quality].join('|');
    if (!state.regionCache) state.regionCache = new Map();
    let entry = state.regionCache.get(key);
    if (!entry) {
        entry = buildRegion(shapeParts, options);
        state.regionCache.set(key, entry);
    }
    // Occupancy mutates the blocked mask, so every solve works on a copy.
    return Object.assign({}, entry, { blocked: Uint8Array.from(entry.blocked) });
}

function solvePacked(words, shapeParts, options, rand, state) {
    const region = getRegion(state, shapeParts, options);
    if (!region.freeCount) throw new Error('The key object leaves no free area (check Margin).');
    const grid = region.grid;
    const c = grid.c, W = grid.W;
    const cand = candidateOrder(region, options.placement, options.seed | 0);
    const candRow = candidateRows(cand, W);
    const occ = makeOccupancy(grid.W, grid.H, region.blocked);
    const ctx = { candLen: cand.length };
    const ref = region.shapeBounds.height || region.shapeBounds.width;
    const maxEm = Math.max(c * 2, ref * options.maxSize / 100);
    const minEm = Math.max(c * 1.5, Math.min(maxEm, ref * options.minSize / 100));
    const kMin = ladderIndex(minEm, maxEm);
    const repeat = options.repeat;
    const midEm = repeat ? Math.sqrt(maxEm * minEm) : minEm;
    const padCells = Math.max(0, options.padding) / c;
    const boxes = options.collision === 1;
    // failK.get(word) = largest ladder index (smallest size) known not to fit; the
    // occupancy only grows, so every size at or above it keeps failing.
    const failK = new Map();

    const tryPlace = (word, k, angles) => {
        if (k <= (failK.has(word) ? failK.get(word) : -1)) return null;
        const em = ladderEm(k, maxEm);
        for (const deg of angles) {
            const sprite = cachedSprite(word, em, deg, c, padCells, boxes);
            const idx = findSpot(occ, sprite, cand, candRow, ctx.candLen);
            if (idx < 0) continue;
            const ci = idx % W, cj = (idx / W) | 0;
            occPlace(occ, sprite.body, ci, cj);
            ctx.candLen = compactCandidates(cand, candRow, ctx.candLen, occ.cells);
            return {
                word, s: sprite.scale, r: sprite.r,
                ax: word.cx, ay: word.cy,
                px: grid.x0 + (ci + 0.5) * c, py: grid.y0 + (cj + 0.5) * c,
                em, k
            };
        }
        failK.set(word, Math.max(k, failK.has(word) ? failK.get(word) : -1));
        return null;
    };

    const placements = [];
    const unplaced = [];
    const sizes = targetSizes(words, options, maxEm, midEm, minEm, rand);
    const queue = words.slice().sort((a, b) => sizes.get(b) - sizes.get(a));
    let smallestK = 0;
    for (const word of queue) {
        const angles = wordAngles(options, rand);
        let placed = null;
        for (let k = ladderIndex(sizes.get(word), maxEm); !placed && k <= kMin && ctx.candLen; k++) {
            placed = tryPlace(word, k, angles);
        }
        if (placed) { placements.push(placed); smallestK = Math.max(smallestK, placed.k); }
        else unplaced.push(word);
    }

    let copies = 0;
    if (repeat && ctx.candLen) {
        let level = Math.max(smallestK, ladderIndex(midEm, maxEm)) + 1;
        let fails = 0, pointer = 0;
        const failLimit = Math.max(3, Math.min(words.length, 8));
        while (copies < options.maxCopies && level <= kMin && ctx.candLen) {
            // Skip the level as soon as every word is known not to fit at it.
            let anyLeft = false;
            for (const w of words) if (level > (failK.has(w) ? failK.get(w) : -1)) { anyLeft = true; break; }
            if (!anyLeft) { level++; fails = 0; continue; }
            const word = words[pointer % words.length];
            pointer++;
            const k = Math.min(kMin, level + (rand() < 0.35 ? 1 : 0));
            const placed = tryPlace(word, k, wordAngles(options, rand));
            if (placed) { placed.dup = true; placements.push(placed); copies++; fails = 0; }
            else if (++fails >= failLimit) { level++; fails = 0; }
        }
    }
    return { placements, unplaced, copies, info: 'Grid ' + grid.W + 'x' + grid.H };
}

// ---------------------------------------------------------------------------
// Flow mode
// ---------------------------------------------------------------------------

function solveFlow(words, shapeParts, options, rand) {
    const sb = partsBounds(shapeParts);
    const ox = (sb.minX + sb.maxX) / 2, oy = (sb.minY + sb.maxY) / 2;
    const r = -options.flowAngle * Math.PI / 180;
    const cos = Math.cos(r), sin = Math.sin(r);
    // Shape in the flow frame (rows are horizontal there).
    const frameParts = shapeParts.map(part => makePart(part.rings.map(ring => {
        const xs = new Array(ring.n), ys = new Array(ring.n);
        for (let k = 0; k < ring.n; k++) {
            const dx = ring.X[k] - ox, dy = ring.Y[k] - oy;
            xs[k] = cos * dx + sin * dy;
            ys[k] = -sin * dx + cos * dy;
        }
        return makeRing(xs, ys);
    }).filter(Boolean), part.nonZero));
    const fb = partsBounds(frameParts);
    const scanBuf = makeScanBuffer(frameParts);
    const margin = Math.max(0, options.margin);
    const usableH = fb.height - 2 * margin;
    if (!(usableH > 0)) throw new Error('Margin is larger than the key object.');
    const asc = Math.max(0.3, ...words.map(w => w.ascEm));
    const desc = Math.max(0.05, ...words.map(w => w.descEm));
    const gap = clamp(options.lineGap, 0, 90) / 100;
    const spacingEm = Math.max(0, options.spacing) / 100;
    const sampleStep = Math.max(fb.width, fb.height) / 240;

    const rowIntervals = (top, bottom) => {
        const y0 = top - margin, y1 = bottom + margin;
        const k = clamp(Math.ceil((y1 - y0) / sampleStep), 3, 32);
        let acc = null;
        for (let i = 0; i <= k; i++) {
            const y = y0 + (y1 - y0) * (0.001 + 0.998 * i / k);
            const iv = unionIntervalsAt(frameParts, y, scanBuf);
            acc = acc ? intersectIntervals(acc, iv) : iv;
            if (!acc.length) return acc;
        }
        return acc.map(iv => [iv[0] + margin, iv[1] - margin]).filter(iv => iv[1] > iv[0]);
    };

    const toSpread = (u, v) => ({ x: ox + cos * u - sin * v, y: oy + sin * u + cos * v });

    // Lays out `rows` rows; returns placements and how many source words were consumed.
    // Lays out rows of height H; returns placements and how many source words were used.
    const layout = (H, repeat) => {
        const rows = Math.max(1, Math.floor(usableH / H + 1e-9));
        const startY = fb.minY + margin + (usableH - rows * H) / 2;
        const em = H * (1 - gap) / (asc + desc);
        const out = [];
        const limit = words.length + options.maxCopies;
        let pointer = 0;
        const pending = [];
        const cycle = words;
        const nextWord = () => {
            if (pending.length) return pending.shift();
            if (!repeat && pointer >= cycle.length) return null;
            return cycle[pointer++ % cycle.length];
        };
        const widthOf = w => w.widthEm * em;
        const fit = options.align === 0;
        let stop = false;
        for (let row = 0; row < rows && !stop; row++) {
            const top = startY + row * H;
            const bandTop = top + H * gap / 2;
            const baseline = bandTop + asc * em;
            const intervals = rowIntervals(bandTop, bandTop + (asc + desc) * em);
            for (const iv of intervals) {
                if (stop) break;
                const avail = iv[1] - iv[0];
                if (avail < em * 0.4) continue;
                const line = [];
                let width = 0;
                const deferred = [];
                while (true) {
                    if (repeat && out.length + line.length >= limit) { stop = true; break; }
                    const w = nextWord();
                    if (!w) { if (!repeat) stop = true; break; }
                    const need = widthOf(w) + (line.length ? spacingEm * em : 0);
                    if (width + need <= avail) { line.push(w); width += need; continue; }
                    // Fit width: take one more word and shrink the line when that wastes less space.
                    if (fit && avail / (width + need) >= FIT_MIN_SHRINK
                        && (avail - width) / avail > 1 - avail / (width + need)) {
                        line.push(w); width += need;
                        break;
                    }
                    deferred.push(w);
                    // Without Repeat the word order is kept; with Repeat a shorter word may fill the gap.
                    if (!repeat || deferred.length >= cycle.length) break;
                }
                pending.unshift(...deferred);
                if (!line.length) continue;
                const f = width > avail ? avail / width : 1;
                const lineEm = em * f;
                const free = Math.max(0, avail - width * f);
                let x = iv[0], extra = 0;
                if (options.align <= 1) { if (line.length > 1) extra = free / (line.length - 1); else x += free / 2; }
                else if (options.align === 2) x += free / 2;
                else if (options.align === 4) x += free;
                for (const w of line) {
                    const p = toSpread(x, baseline);
                    out.push({ word: w, s: lineEm / w.font, r, ax: w.minX, ay: 0, px: p.x, py: p.y, em: lineEm });
                    x += (widthOf(w) + spacingEm * em) * f + extra;
                }
            }
        }
        // Mark duplicates: first use of each word keeps the original node.
        const seen = new Set();
        for (const p of out) { if (seen.has(p.word)) p.dup = true; else seen.add(p.word); }
        return { out, usedCount: seen.size, copies: out.length - seen.size, em };
    };

    let result;
    if (options.repeat) {
        result = layout(usableH / Math.max(1, Math.round(options.rows)), true);
    } else {
        // Largest row height that still fits every word (bisection on a log scale).
        const fitsAll = H => layout(H, false).usedCount >= words.length;
        let lo = usableH / 600, hi = usableH;
        if (!fitsAll(lo)) hi = lo;
        else if (fitsAll(hi)) lo = hi;
        for (let k = 0; k < 28 && hi / lo > 1.002; k++) {
            const mid = Math.sqrt(lo * hi);
            if (fitsAll(mid)) lo = mid; else hi = mid;
        }
        result = layout(lo, false);
        result.rows = Math.max(1, Math.floor(usableH / lo + 1e-9));
    }
    const placedSet = new Set(result.out.map(p => p.word));
    return {
        placements: result.out,
        unplaced: words.filter(w => !placedSet.has(w)),
        copies: result.copies,
        info: (result.rows ? 'Auto rows ' + result.rows + ', ' : '') + 'text size ' + result.em.toFixed(1) + ' px'
    };
}

// ---------------------------------------------------------------------------
// Outline mode
// ---------------------------------------------------------------------------

function solveOutline(words, shapeParts, options, rand) {
    const sb = partsBounds(shapeParts);
    const ref = sb.height || sb.width;
    const baseEm = Math.max(0.5, ref * options.textSize / 100);
    const variation = clamp(options.sizeVar, 0, 95) / 100;
    const spacingEm = Math.max(0, options.spacing) / 100;
    const style = options.outlineStyle;
    const scanBuf = makeScanBuffer(shapeParts);
    const offset = options.offset;

    // Rings as polylines with cumulative arc length.
    const paths = [];
    for (const part of shapeParts) {
        for (const src of part.rings) {
            const ring = { X: Float64Array.from(src.X), Y: Float64Array.from(src.Y), n: src.n };
            const n = ring.n;
            const L = new Float64Array(n + 1);
            for (let i = 1; i <= n; i++) {
                const a = i - 1, b = i % n;
                L[i] = L[i - 1] + Math.hypot(ring.X[b] - ring.X[a], ring.Y[b] - ring.Y[a]);
            }
            if (L[n] > 1e-6) paths.push({ ring, L, length: L[n] });
        }
    }
    if (!paths.length) throw new Error('The key object has no outline to follow.');

    const pointAt = (path, t) => {
        const { ring, L, length } = path;
        t = ((t % length) + length) % length;
        let lo = 0, hi = ring.n;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (L[mid] <= t) lo = mid; else hi = mid; }
        const a = lo, b = (lo + 1) % ring.n;
        const seg = L[lo + 1] - L[lo];
        const u = seg > 0 ? (t - L[lo]) / seg : 0;
        return { x: ring.X[a] + (ring.X[b] - ring.X[a]) * u, y: ring.Y[a] + (ring.Y[b] - ring.Y[a]) * u };
    };
    const frameAt = (path, t, smooth) => {
        const p = pointAt(path, t);
        const p0 = pointAt(path, t - smooth), p1 = pointAt(path, t + smooth);
        let tx = p1.x - p0.x, ty = p1.y - p0.y;
        const len = Math.hypot(tx, ty) || 1;
        tx /= len; ty /= len;
        let nx = ty, ny = -tx;
        const eps = Math.max(ref * 1e-3, 0.05);
        if (pointInParts(shapeParts, p.x + nx * eps, p.y + ny * eps, scanBuf)) { nx = -nx; ny = -ny; }
        return { x: p.x, y: p.y, tx, ty, nx, ny };
    };

    const upright = options.keepUpright;
    const placementFor = (word, em, path, t) => {
        const s = em / word.font;
        const f = frameAt(path, t, Math.max(em * 0.5, path.length / 2000));
        let r, ax, ay, px, py;
        if (style === 2) {
            // Letters stand on the edge (up = outward normal); upside-down words hang from it instead.
            r = Math.atan2(f.nx, -f.ny);
            ax = word.cx; ay = 0;
            if (upright && f.ny > 1e-6) { r += Math.PI; ay = word.minY; }
            px = f.x + f.nx * offset; py = f.y + f.ny * offset;
        } else {
            const dirX = style === 0 ? f.nx : -f.nx, dirY = style === 0 ? f.ny : -f.ny;
            r = Math.atan2(dirY, dirX);
            ax = word.minX; ay = word.cy;
            // Words pointing left are turned 180 degrees and end at the edge instead of starting there.
            if (upright && dirX < -1e-6) { r += Math.PI; ax = word.maxX; }
            px = f.x + dirX * offset; py = f.y + dirY * offset;
        }
        return withBox({ word, s, r, ax, ay, px, py, em }, spacingEm * em * 0.35);
    };
    // Along-edge text should read left to right with letters standing outward.
    if (style === 2) {
        for (const path of paths) {
            const f = frameAt(path, path.length * 0.25, path.length / 200);
            const rx = -f.ny, ry = f.nx; // reading direction for "up = outward"
            if (rx * f.tx + ry * f.ty < 0) {
                const ring = path.ring;
                ring.X.reverse(); ring.Y.reverse();
                const n = ring.n, L = path.L;
                for (let i = 1; i <= n; i++) {
                    const a = i - 1, b = i % n;
                    L[i] = L[i - 1] + Math.hypot(ring.X[b] - ring.X[a], ring.Y[b] - ring.Y[a]);
                }
            }
        }
    }

    const emFor = () => baseEm * (1 - variation * rand());
    const extentOf = (word, em) => (style === 2 ? word.widthEm : word.heightEm) * em;
    const cycle = words;
    const placements = [];
    const used = new Set();
    let copies = 0;

    if (!options.repeat) {
        // Each word once, spread evenly over the total outline length.
        const total = paths.reduce((sum, p) => sum + p.length, 0);
        const items = cycle.map(w => { const em = emFor(); return { w, em, ext: extentOf(w, em) }; });
        const need = items.reduce((sum, it) => sum + it.ext, 0);
        const gapEach = (total - need) / items.length;
        let pos = gapEach / 2;
        for (const it of items) {
            let center = pos + it.ext / 2;
            let pi = 0;
            while (pi < paths.length - 1 && center > paths[pi].length) { center -= paths[pi].length; pi++; }
            placements.push(placementFor(it.w, it.em, paths[pi], center));
            pos += it.ext + gapEach;
        }
        return {
            placements, unplaced: [], copies: 0,
            info: gapEach < 0 ? 'Outline too short: words overlap.' : 'Outline ' + total.toFixed(0) + ' px'
        };
    }

    // Repeat: walk each outline; where a word would overlap an earlier one
    // (concave corners), slide it further along the path.
    let pointer = 0, skipped = 0;
    const limit = words.length + options.maxCopies;
    for (const path of paths) {
        let pos = 0;
        while (placements.length < limit) {
            const w = cycle[pointer % cycle.length];
            const em = emFor();
            const ext = extentOf(w, em);
            const gap = spacingEm * em;
            const step = Math.max(ext * 0.15, gap * 0.5, path.length / 4000);
            let t = pos + gap / 2 + ext / 2;
            let p = null;
            while (t + ext / 2 + gap / 2 <= path.length + 1e-6) {
                const cand = placementFor(w, em, path, t);
                if (!collidesAny(cand, placements)) { p = cand; break; }
                t += step;
                skipped++;
            }
            if (!p) break;
            if (used.has(w)) { p.dup = true; copies++; } else used.add(w);
            placements.push(p);
            pos = t + ext / 2 + gap / 2;
            pointer++;
        }
    }
    return { placements, unplaced: words.filter(w => !used.has(w)), copies, info: skipped ? 'Slid past ' + skipped + ' overlap(s)' : '' };
}

// Oriented box of a placement (spread coordinates), inflated by `pad`.
function withBox(p, pad) {
    const w = p.word;
    const cos = Math.cos(p.r), sin = Math.sin(p.r), s = p.s;
    const xs = [w.minX - pad / s, w.maxX + pad / s, w.maxX + pad / s, w.minX - pad / s];
    const ys = [w.minY - pad / s, w.minY - pad / s, w.maxY + pad / s, w.maxY + pad / s];
    const X = new Float64Array(4), Y = new Float64Array(4);
    let cx = 0, cy = 0;
    for (let k = 0; k < 4; k++) {
        const u = (xs[k] - p.ax) * s, v = (ys[k] - p.ay) * s;
        X[k] = p.px + cos * u - sin * v;
        Y[k] = p.py + sin * u + cos * v;
        cx += X[k] / 4; cy += Y[k] / 4;
    }
    let rad = 0;
    for (let k = 0; k < 4; k++) rad = Math.max(rad, Math.hypot(X[k] - cx, Y[k] - cy));
    p.box = { X, Y, cx, cy, rad };
    return p;
}

function separatedOnAxes(A, B) {
    for (let k = 0; k < 4; k++) {
        const k2 = (k + 1) & 3;
        const ax = -(A.Y[k2] - A.Y[k]), ay = A.X[k2] - A.X[k];
        let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
        for (let i = 0; i < 4; i++) {
            const pa = A.X[i] * ax + A.Y[i] * ay, pb = B.X[i] * ax + B.Y[i] * ay;
            if (pa < aMin) aMin = pa; if (pa > aMax) aMax = pa;
            if (pb < bMin) bMin = pb; if (pb > bMax) bMax = pb;
        }
        if (aMax < bMin || bMax < aMin) return true;
    }
    return false;
}

function boxesOverlap(A, B) {
    const dx = A.cx - B.cx, dy = A.cy - B.cy, rr = A.rad + B.rad;
    if (dx * dx + dy * dy > rr * rr) return false;
    return !separatedOnAxes(A, B) && !separatedOnAxes(B, A);
}

function collidesAny(p, list) {
    for (let i = list.length - 1; i >= 0; i--) if (boxesOverlap(p.box, list[i].box)) return true;
    return false;
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

function boxArea(node) {
    try { const b = node.getSpreadBaseBox(); return b.width * b.height; } catch (_) { return 0; }
}

function pickKey(nodes, keyPick) {
    if (keyPick === 1) return nodes[0];
    if (keyPick === 2) return nodes[nodes.length - 1];
    const shapes = nodes.filter(n => !isArtText(n));
    if (!shapes.length) return null;
    let best = shapes[0];
    for (const n of shapes) if (boxArea(n) > boxArea(best)) best = n;
    return best;
}

function buildState(nodes, keyPick) {
    const key = pickKey(nodes, keyPick);
    if (!key) throw new Error('Select one shape (the key object) together with the Art Text objects.');
    const shapeParts = [];
    collectShapeParts(key, shapeParts, 0);
    if (!shapeParts.length) throw new Error('The key object "' + nodeName(key) + '" has no usable outline.');
    const words = [];
    const skipped = [];
    nodes.forEach((node, index) => {
        if (node.isSameNode(key)) return;
        if (!isArtText(node)) { skipped.push(nodeName(node) + ' (not Art Text)'); return; }
        const w = buildWord(node, index);
        if (w) words.push(w); else skipped.push(nodeName(node) + ' (empty)');
    });
    if (!words.length) throw new Error('Select at least one Art Text object besides the key object.');
    return { key, shapeParts, words, skipped };
}

function solve(state, options) {
    const rand = makeRandom(options.seed);
    let words = state.words.slice();
    if (options.order === 1) words = shuffle(words, makeRandom(options.seed + 101));
    const t0 = Date.now();
    let result;
    if (options.mode === 1) result = solveFlow(words, state.shapeParts, options, rand);
    else if (options.mode === 2) result = solveOutline(words, state.shapeParts, options, rand);
    else result = solvePacked(words, state.shapeParts, options, rand, state);
    result.ms = Date.now() - t0;
    return result;
}

function placementTransform(p) {
    const F = Transform.createTranslate(p.px, p.py)
        .multiply(Transform.createRotate(p.r))
        .multiply(Transform.createScale(p.s, p.s))
        .multiply(Transform.createTranslate(-p.ax, -p.ay));
    return F.multiply(p.word.B.inverted);
}

function buildCommand(doc, state, result, options) {
    const builder = CompoundCommandBuilder.create();
    let count = 0;
    // Duplicates first (they copy the untouched original), then move the originals.
    const ordered = result.placements.filter(p => p.dup).concat(result.placements.filter(p => !p.dup));
    for (const p of ordered) {
        const sel = Selection.create(doc, p.word.node);
        const xf = placementTransform(p);
        builder.addCommand(p.dup
            ? DocumentCommand.createTransform(sel, xf, { duplicateNodes: true })
            : DocumentCommand.createTransform(sel, xf));
        count++;
    }
    const toHide = [];
    if (options.hideUnplaced) for (const w of result.unplaced) toHide.push(w.node);
    if (options.hideKey) toHide.push(state.key);
    if (toHide.length) {
        const sel = Selection.create(doc, toHide[0]);
        for (let i = 1; i < toHide.length; i++) sel.add(toHide[i]);
        builder.addCommand(DocumentCommand.createSetVisibility(sel, false));
        count++;
    }
    return count ? builder.createCommand() : null;
}

function summarize(state, result, options) {
    const originals = result.placements.filter(p => !p.dup).length;
    const lines = [];
    lines.push('Placed ' + originals + ' of ' + state.words.length + ' word(s)'
        + (result.copies ? ' + ' + result.copies + ' copies' : '') + '.');
    if (result.unplaced.length) {
        lines.push(result.unplaced.length + ' word(s) did not fit' + (options.hideUnplaced ? ' (hidden).' : ' (left in place).'));
    }
    if (state.skipped.length) lines.push('Skipped: ' + state.skipped.slice(0, 4).join(', ') + (state.skipped.length > 4 ? ', ...' : ''));
    lines.push((result.info ? result.info + ' · ' : '') + result.ms + ' ms');
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

function buildDialog(doc, initialKeyPick) {
    const dialog = Dialog.create(SCRIPT_TITLE);
    dialog.initialWidth = 760;
    const px = (group, label, value, min, max) => group.addUnitValueEditor(label, UnitType.Pixel, doc.units, value, min, max);
    const num = (group, label, value, min, max) => group.addUnitValueEditor(label, UnitType.Number, UnitType.Number, value, min, max);
    const deg = (group, label, value, min, max) => group.addUnitValueEditor(label, UnitType.Degree, UnitType.Degree, value, min, max);

    const left = dialog.addColumn();
    const layout = left.addGroup('Layout');
    dialog.mode = layout.addButtonSet('Mode', MODES, 0);
    dialog.keyPick = layout.addComboBox('Key object', KEY_PICKS, initialKeyPick);
    dialog.order = layout.addComboBox('Word order', WORD_ORDERS, 0);
    dialog.repeat = layout.addSwitch('Repeat words to fill', true);
    dialog.maxCopies = num(layout, 'Max copies', 250, 0, 3000);
    dialog.seed = num(layout, 'Seed', 1, 0, 99999);
    dialog.modeInfo = layout.addStaticText(null, '').setIsFullWidth();

    const size = left.addGroup('Size');
    dialog.sizeBy = size.addComboBox('Size by', SIZE_BY, 0);
    dialog.maxSize = num(size, 'Largest size (% of shape)', 20, 0.5, 100);
    dialog.minSize = num(size, 'Smallest size (% of shape)', 2.5, 0.2, 100);
    dialog.sizeCurve = num(size, 'Size curve', 1, 0.1, 10);
    dialog.rows = num(size, 'Rows', 16, 1, 500);
    dialog.lineGap = num(size, 'Line gap (%)', 8, 0, 90);
    dialog.textSize = num(size, 'Text size (% of shape)', 6, 0.2, 100);
    dialog.sizeVar = num(size, 'Size variation (%)', 0, 0, 95);
    dialog.spacing = num(size, 'Word spacing (% of size)', 30, 0, 500);

    const right = dialog.addColumn();
    const rot = right.addGroup('Rotation');
    dialog.rotation = rot.addComboBox('Rotation', ROTATIONS, 1);
    dialog.vRatio = num(rot, 'Vertical share (%)', 30, 0, 100);
    dialog.angleRange = deg(rot, 'Angle range (±)', 45, 0, 180);
    dialog.angleSteps = num(rot, 'Angle steps', 3, 1, 36);
    dialog.flowAngle = deg(rot, 'Flow angle', 0, -180, 180);
    dialog.outlineStyle = rot.addComboBox('Outline style', OUTLINE_STYLES, 0);
    dialog.keepUpright = rot.addSwitch('Keep text upright', true);

    const fit = right.addGroup('Fit');
    dialog.region = fit.addButtonSet('Region', REGIONS, 0);
    dialog.extent = num(fit, 'Outside extent (%)', 15, 1, 200);
    dialog.margin = px(fit, 'Margin', 0, 0, 100000);
    dialog.padding = px(fit, 'Padding', 2, 0, 100000);
    dialog.offset = px(fit, 'Edge offset', 4, -100000, 100000);
    dialog.collision = fit.addButtonSet('Collision', COLLISIONS, 0);
    dialog.placement = fit.addComboBox('Placement', PLACEMENTS, 0);
    dialog.align = fit.addComboBox('Alignment', ALIGNMENTS, 0);
    dialog.quality = fit.addButtonSet('Quality', QUALITIES, 1);

    const output = right.addGroup('Output');
    dialog.hideUnplaced = output.addSwitch("Hide words that don't fit", true);
    dialog.hideKey = output.addSwitch('Hide key object', false);
    dialog.preview = output.addSwitch('Preview', true);
    dialog.status = output.addStaticText(null, 'Preview updates the canvas as you change options.').setIsFullWidth();
    return dialog;
}

const MODE_INFO = [
    'Packed: a dense word cloud. Biggest words go first; each word shrinks until it fits. Repeat fills the gaps with smaller copies.',
    'Flow: readable rows clipped to the shape. Without Repeat the row count is chosen automatically so every word fits.',
    'Outline: words follow the edge of the key object as rays or along the edge. Without Repeat each word is used once, evenly spaced.'
];

function updateControls(dialog) {
    const mode = dialog.mode.selectedIndex;
    const packed = mode === 0, flow = mode === 1, outline = mode === 2;
    const repeat = !!dialog.repeat.value;
    const rotation = dialog.rotation.selectedIndex;
    dialog.modeInfo.text = MODE_INFO[mode] || '';
    dialog.maxCopies.isEnabled = repeat;
    dialog.sizeBy.isEnabled = packed;
    dialog.maxSize.isEnabled = packed;
    dialog.minSize.isEnabled = packed;
    dialog.sizeCurve.isEnabled = packed && dialog.sizeBy.selectedIndex !== 1 && dialog.sizeBy.selectedIndex !== 4;
    dialog.rows.isEnabled = flow && repeat;
    dialog.lineGap.isEnabled = flow;
    dialog.textSize.isEnabled = outline;
    dialog.sizeVar.isEnabled = outline;
    dialog.spacing.isEnabled = flow || (outline && repeat);
    dialog.rotation.isEnabled = packed;
    dialog.vRatio.isEnabled = packed && rotation === 1;
    dialog.angleRange.isEnabled = packed && (rotation === 2 || rotation === 3);
    dialog.angleSteps.isEnabled = packed && rotation === 2;
    dialog.flowAngle.isEnabled = flow;
    dialog.outlineStyle.isEnabled = outline;
    dialog.keepUpright.isEnabled = outline;
    dialog.region.isEnabled = packed;
    dialog.extent.isEnabled = packed && dialog.region.selectedIndex === 1;
    dialog.margin.isEnabled = packed || flow;
    dialog.padding.isEnabled = packed;
    dialog.offset.isEnabled = outline;
    dialog.collision.isEnabled = packed;
    dialog.placement.isEnabled = packed;
    dialog.align.isEnabled = flow;
    dialog.quality.isEnabled = packed;
}

function readOptions(dialog) {
    const n = (ctrl, fallback) => { const v = Number(ctrl.value); return Number.isFinite(v) ? v : fallback; };
    return {
        mode: dialog.mode.selectedIndex,
        keyPick: dialog.keyPick.selectedIndex,
        order: dialog.order.selectedIndex,
        repeat: !!dialog.repeat.value,
        maxCopies: Math.max(0, Math.round(n(dialog.maxCopies, 250))),
        seed: Math.round(n(dialog.seed, 1)),
        sizeBy: dialog.sizeBy.selectedIndex,
        maxSize: n(dialog.maxSize, 20),
        minSize: n(dialog.minSize, 2.5),
        sizeCurve: n(dialog.sizeCurve, 1),
        rows: n(dialog.rows, 16),
        lineGap: n(dialog.lineGap, 8),
        textSize: n(dialog.textSize, 6),
        sizeVar: n(dialog.sizeVar, 0),
        spacing: n(dialog.spacing, 30),
        rotation: dialog.rotation.selectedIndex,
        vRatio: n(dialog.vRatio, 30),
        angleRange: n(dialog.angleRange, 45),
        angleSteps: n(dialog.angleSteps, 3),
        flowAngle: n(dialog.flowAngle, 0),
        outlineStyle: dialog.outlineStyle.selectedIndex,
        keepUpright: !!dialog.keepUpright.value,
        region: dialog.region.selectedIndex,
        extent: n(dialog.extent, 15),
        margin: n(dialog.margin, 0),
        padding: n(dialog.padding, 2),
        offset: n(dialog.offset, 4),
        collision: dialog.collision.selectedIndex,
        placement: dialog.placement.selectedIndex,
        align: dialog.align.selectedIndex,
        quality: clamp(dialog.quality.selectedIndex, 0, 2),
        hideUnplaced: !!dialog.hideUnplaced.value,
        hideKey: !!dialog.hideKey.value
    };
}

function makeStateProvider(nodes) {
    const cache = new Map();
    return keyPick => {
        if (!cache.has(keyPick)) {
            try { cache.set(keyPick, { state: buildState(nodes, keyPick) }); }
            catch (error) { cache.set(keyPick, { error }); }
        }
        const entry = cache.get(keyPick);
        if (entry.error) throw entry.error;
        return entry.state;
    };
}

function main() {
    const doc = Document.current;
    if (!doc) { app.alert('Please open a document first.', SCRIPT_TITLE); return; }
    try {
        const nodes = selectedNodes(doc);
        if (nodes.length < 2) throw new Error('Select one shape (key object) and one or more Art Text objects.');
        const spread = nodes[0].spread;
        if (!nodes.every(n => n.spread && n.spread.isSameNode(spread))) throw new Error('All selected elements must be on the same spread.');
        if (doc.currentSpread && !doc.currentSpread.isSameNode(spread)) {
            doc.executeCommand(DocumentCommand.createSetCurrentSpread(spread));
        }
        const getState = makeStateProvider(nodes);
        // Auto needs a non-text key object; with text only, the last selected text becomes the shape.
        const initialKeyPick = nodes.some(n => !isArtText(n)) ? 0 : 2;
        getState(initialKeyPick);   // validates the selection before the panel opens

        const dialog = buildDialog(doc, initialKeyPick);
        updateControls(dialog);

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
                const state = getState(options.keyPick);
                const result = solve(state, options);
                const command = buildCommand(doc, state, result, options);
                if (command) doc.executeCommand(command, true);
                dialog.status.text = summarize(state, result, options);
                lastSignature = signature;
            } catch (error) {
                clearPreview();
                lastSignature = null;
                dialog.status.text = 'Preview failed: ' + compactError(error);
            }
        };
        const schedule = () => {
            if (closing) return;
            updateControls(dialog);
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
        const state = getState(options.keyPick);
        const result = solve(state, options);
        const command = buildCommand(doc, state, result, options);
        if (!command) { app.alert('Nothing to arrange.', SCRIPT_TITLE); return; }
        doc.executeCommand(command, false);

        // Select the arranged words (originals + new copies) and the key object.
        try {
            const sel = Selection.create(doc, state.key);
            for (const p of result.placements) if (!p.dup) sel.add(p.word.node);
            for (const n of command.newNodes) sel.add(n);
            doc.executeCommand(DocumentCommand.createSetSelection(sel));
        } catch (_) { /* selection is cosmetic */ }

        if (result.unplaced.length && !options.hideUnplaced) {
            app.alert(result.unplaced.length + " word(s) did not fit and were left in place.", SCRIPT_TITLE);
        }
    } catch (error) {
        try { doc.clearPreviews(); } catch (_) { /* nothing to clear */ }
        app.alert(compactError(error), SCRIPT_TITLE);
    }
}

main();
