'use strict';

/**
 * Image Trace Superior v1.1
 *
 * Description:
 * Converts raster/image layers into clean, scalable black-and-white vectors
 * directly inside Affinity Designer / Publisher / Photo — no external tools needed.
 *
 * Engine: marching-squares contour tracer with adaptive Bezier smoothing,
 * corner-aware RDP simplification, and anti-staircase curve fitting.
 *
 * Controls:
 *   Edge fit      — brightness threshold (lower = trace lighter edges)
 *   Detail        — how much fine detail to capture (0–100)
 *   Curve fidelity — how closely curves follow the original (0=smooth, 100=exact)
 *   Cleanup px    — remove noisy specks up to N px
 *   Min detail    — minimum shape area to keep
 *   Speckle px    — secondary despeckle pass radius
 *   Anti alias    — softening before trace (reduces pixel staircasing)
 *   Simplify      — reduce node count (higher = fewer nodes, less detail)
 *
 * Preview/Apply workflow:
 *   Preview → see result on canvas immediately (undoable)
 *   Apply   → commit result permanently to undo history
 *   Cancel  → revert any uncommitted preview and exit
 * 
 * Version: 1.1
 * Author: Dimas Nirwan
 * 
 */



const { Document } = require('/document');
const { AddChildNodesCommandBuilder, DocumentCommand, NodeMoveType } = require('/commands');
const { Dialog, DialogResult } = require('/dialog');
const { UnitType } = require('/units');
const { NodeChildType, PolyCurveNodeDefinition } = require('/nodes');
const { BlendMode } = require('affinity:common');
const { RGBA8 } = require('/colours');
const { FillDescriptor } = require('/fills');
const { CurveBuilder, PolyCurve } = require('/geometry');
const { LineStyleDescriptor } = require('/linestyle');
const { PixelReaderRGBA8 } = require('/pixelaccessor');
const { Selection } = require('/selections');

// ── state ──────────────────────────────────────────────────────────────────────
let OPTIONS = {
    threshold: 170, paths: 88, corners: 70, noise: 5,
    despeckle: 2, blur: 0.1, optimize: 0.58, minArea: 2,
    previewOriginal: false,
    // internal (not exposed in dialog)
    preset: 0, engine: 0, mode: 0, method: 0, create: 0,
    palette: 0, scans: 10, colors: 2, maxStroke: 2,
    centerline: false, removeBackground: true, stacked: false,
    outputSwatches: false
};

const TRACE_OUTPUT_DESCRIPTIONS = [
    'Image Trace Superior Auto Curves',
    'Image Trace Superior Background',
    'Image Trace Superior Bounds Keeper',
    'Image Trace Superior Output Group'
];

const METHODS  = ['Abutting', 'Overlapping'];
const CREATES  = ['Fills', 'Strokes', 'Fills + Strokes'];
const PRESET_SLUGS = ['logo-clean', 'high-detail', 'illustration', 'line-art', 'tiny-file'];
const ENGINE_SLUGS = ['auto-best', 'vtracer-color', 'potrace-bw', 'autotrace-centerline', 'inkscape-potrace'];
const MODES    = ['B/W', 'Color', 'Grayscale', 'Centerline'];

// ── helpers ────────────────────────────────────────────────────────────────────
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function luminance(px) { return 0.2126 * px.r + 0.7152 * px.g + 0.0722 * px.b; }
function contourKey(p) { return Math.round(p.x * 1000) + ',' + Math.round(p.y * 1000); }
function pointKey(p) { return p.x + ',' + p.y; }
function distanceBetween(a, b) { const dx = a.x-b.x, dy = a.y-b.y; return Math.sqrt(dx*dx+dy*dy); }
function loopArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) { const b = pts[(i+1)%pts.length]; a += pts[i].x*b.y - b.x*pts[i].y; }
    return Math.abs(a) / 2;
}
function loopPerimeter(pts) {
    let t = 0;
    for (let i = 0; i < pts.length; i++) t += distanceBetween(pts[i], pts[(i+1)%pts.length]);
    return t;
}
function loopCompactness(pts) { const p = loopPerimeter(pts), a = loopArea(pts); return p > 0 ? (4*Math.PI*a)/(p*p) : 1; }
function isTraceOutputNode(n) { return n && TRACE_OUTPUT_DESCRIPTIONS.indexOf(n.userDescription) >= 0; }
function modeName() { return OPTIONS.mode === 0 ? 'bw' : OPTIONS.mode === 3 ? 'centerline' : MODES[OPTIONS.mode].toLowerCase(); }
function presetName() { return PRESET_SLUGS[OPTIONS.preset] || 'custom'; }
function engineName() { return ENGINE_SLUGS[OPTIONS.engine] || 'auto-best'; }

// ── raster detection ───────────────────────────────────────────────────────────
function rasterIsUsable(node) {
    if (!node || !node.rasterInterface || isTraceOutputNode(node)) return false;
    const ri = node.rasterInterface;
    const bmp = ri.createCompatibleBitmap(true);
    const reader = PixelReaderRGBA8.create(bmp);
    const step = Math.max(1, Math.floor(Math.max(ri.width, ri.height) / 80));
    let samples = 0, opaque = 0, dark = 0, alphaMax = 0, lumMin = 255, lumMax = 0;
    for (let y = 0; y < ri.height; y += step) {
        for (let x = 0; x < ri.width; x += step) {
            const px = reader.readPixel(x, y);
            const lum = luminance(px);
            samples++;
            alphaMax = Math.max(alphaMax, px.alpha);
            lumMin = Math.min(lumMin, lum);
            lumMax = Math.max(lumMax, lum);
            if (px.alpha > 8) { opaque++; if (lum < 180) dark++; }
        }
    }
    if (alphaMax <= 8) return false;
    if (samples <= 0) return false;
    // FIX: use sample-relative thresholds, not pixel-count absolute
    if (opaque < Math.max(4, samples * 0.005)) return false;
    if (dark < Math.max(2, samples * 0.001)) return false;     // was pixelCount*0.00004 — too strict
    if (lumMax - lumMin < 18) return false;
    return true;
}

function selectedRasterNode(doc) {
    const sel = doc.selection && doc.selection.nodes ? doc.selection.nodes : null;
    const selectedNodes = sel && !sel.isEmpty ? [...sel] : [];
    let best = null, bestScore = -1;

    function score(node) {
        if (!rasterIsUsable(node)) return -1;
        const box = node.getSpreadVisibleBox && node.getSpreadVisibleBox();
        const area = box ? box.width * box.height : node.rasterInterface.width * node.rasterInterface.height;
        const selBoost = selectedNodes.indexOf(node) >= 0 ? 4 : 1;
        return area * selBoost * (node.isImageNode ? 2.2 : 1);
    }

    for (const node of selectedNodes) {
        const s = score(node);
        if (s > bestScore) { best = node; bestScore = s; }
    }
    for (const node of doc.layers) {
        const s = score(node);
        if (s > bestScore) { best = node; bestScore = s; }
    }
    return best;
}

function previousTraceNodes(doc) {
    const out = [];
    for (const n of doc.layers) if (isTraceOutputNode(n)) out.push(n);
    return out;
}

// ── image sampling ─────────────────────────────────────────────────────────────
function boxBlur(vals, w, h, r) {
    if (r <= 0) return vals;
    let src = vals;
    for (let p = 0; p < r; p++) {
        const dst = new Array(w * h);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                let total = 0, count = 0;
                for (let dy = -1; dy <= 1; dy++) {
                    const sy = y + dy; if (sy < 0 || sy >= h) continue;
                    for (let dx = -1; dx <= 1; dx++) {
                        const sx = x + dx; if (sx < 0 || sx >= w) continue;
                        total += src[sy*w+sx]; count++;
                    }
                }
                dst[y*w+x] = total / count;
            }
        }
        src = dst;
    }
    return src;
}

function histogramThreshold(vals) {
    const hist = new Array(256).fill(0);
    for (const v of vals) hist[clamp(Math.round(v), 0, 255)]++;
    const total = vals.length;
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let bgW = 0, bgS = 0, best = -1, bestT = 128;
    for (let i = 0; i < 256; i++) {
        bgW += hist[i]; if (!bgW) continue;
        const fgW = total - bgW; if (!fgW) break;
        bgS += i * hist[i];
        const diff = bgS/bgW - (sum-bgS)/fgW;
        const between = bgW * fgW * diff * diff;
        if (between > best) { best = between; bestT = i; }
    }
    return bestT;
}

function contrastStretch(vals, blend) {
    const hist = new Array(256).fill(0);
    for (const v of vals) hist[clamp(Math.round(v), 0, 255)]++;
    const total = vals.length;
    let count = 0, lo = 0, hi = 255;
    for (let i = 0; i < 256; i++) { count += hist[i]; if (count >= total*0.012) { lo = i; break; } }
    count = 0;
    for (let i = 0; i < 256; i++) { count += hist[i]; if (count >= total*0.988) { hi = i; break; } }
    if (hi - lo < 18) return vals;
    return vals.map(v => v*(1-blend) + clamp((v-lo)*255/(hi-lo), 0, 255)*blend);
}

function sampleBilinear(vals, w, h, x, y) {
    const x0 = clamp(Math.floor(x),0,w-1), y0 = clamp(Math.floor(y),0,h-1);
    const x1 = clamp(x0+1,0,w-1), y1 = clamp(y0+1,0,h-1);
    const tx = clamp(x-x0,0,1), ty = clamp(y-y0,0,1);
    const a = vals[y0*w+x0]*(1-tx) + vals[y0*w+x1]*tx;
    const b = vals[y1*w+x0]*(1-tx) + vals[y1*w+x1]*tx;
    return a*(1-ty) + b*ty;
}

function sampleField(node) {
    const ri = node.rasterInterface;
    const bmp = ri.createCompatibleBitmap(true);
    const reader = PixelReaderRGBA8.create(bmp);
    const base = new Array(ri.width * ri.height);
    let opaque = 0, dark = 0, alphaMax = 0, lumMin = 255, lumMax = 0;

    for (let y = 0; y < ri.height; y++) {
        for (let x = 0; x < ri.width; x++) {
            const px = reader.readPixel(x, y);
            const alpha = px.alpha / 255;
            const lum = luminance(px);
            alphaMax = Math.max(alphaMax, px.alpha);
            lumMin = Math.min(lumMin, lum); lumMax = Math.max(lumMax, lum);
            if (px.alpha > 8) { opaque++; if (lum < 180) dark++; }
            base[y * ri.width + x] = 255 - (255 - lum) * alpha;
        }
    }

    // FIX: same relaxed threshold as rasterIsUsable
    const pixelCount = Math.max(1, ri.width * ri.height);
    if (alphaMax <= 8 || opaque < Math.max(12, pixelCount * 0.001) ||
        dark < Math.max(4, pixelCount * 0.0001) || lumMax - lumMin < 18) {
        throw new Error(
            'Layer pixel data is empty or unreadable.\n' +
            'Select/place the original PNG or JPG layer, then run again.\n' +
            '(Avoid pasted or rasterized layers — Affinity may return transparent pixels.)'
        );
    }

    const maxDim = 3200;
    const targetScale = OPTIONS.preset === 4 ? 2.4 : OPTIONS.preset === 1 ? 5.2 : OPTIONS.preset === 0 ? 5.8 : 4.4;
    const scale = clamp(Math.min(targetScale, maxDim / Math.max(ri.width, ri.height)), 1, targetScale);
    const w = Math.max(2, Math.round(ri.width * scale));
    const h = Math.max(2, Math.round(ri.height * scale));
    const vals = new Array(w * h);

    for (let y = 0; y < h; y++) {
        const srcY = (y + 0.5) / scale - 0.5;
        for (let x = 0; x < w; x++) {
            vals[y*w+x] = sampleBilinear(base, ri.width, ri.height, (x+0.5)/scale - 0.5, srcY);
        }
    }

    const blurR = Math.max(0, Math.min(2, Math.round(OPTIONS.blur * scale * 0.28 + OPTIONS.despeckle / 52)));
    const softened = boxBlur(vals, w, h, blurR);
    const geometry = contrastStretch(softened, OPTIONS.preset === 4 ? 0.04 : 0.08);
    const autoT = histogramThreshold(geometry);
    const threshold = clamp(Math.round(OPTIONS.threshold * 0.94 + autoT * 0.06), 42, 230);
    return { values: geometry, width: w, height: h, scale, threshold, sourcePixels: pixelCount };
}

// ── marching squares ───────────────────────────────────────────────────────────
function edgePoint(a, b, thr) {
    const d = b.value - a.value;
    const t = Math.abs(d) < 0.0001 ? 0.5 : clamp((thr - a.value) / d, 0, 1);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function simplifyCollinear(pts) {
    if (pts.length <= 3) return pts;
    const r = [];
    for (let i = 0; i < pts.length; i++) {
        const prev = pts[(i-1+pts.length)%pts.length], curr = pts[i], next = pts[(i+1)%pts.length];
        if ((curr.x-prev.x)*(next.y-curr.y) !== (curr.y-prev.y)*(next.x-curr.x)) r.push(curr);
    }
    return r;
}

function perpDist(p, a, b) {
    const dx = b.x-a.x, dy = b.y-a.y;
    if (!dx && !dy) return distanceBetween(p, a);
    return Math.abs(dy*p.x - dx*p.y + b.x*a.y - b.y*a.x) / Math.sqrt(dx*dx+dy*dy);
}

function rdpOpen(pts, eps) {
    if (pts.length < 3 || eps <= 0) return pts;
    let maxD = 0, idx = 0;
    for (let i = 1; i < pts.length-1; i++) { const d = perpDist(pts[i], pts[0], pts[pts.length-1]); if (d > maxD) { maxD = d; idx = i; } }
    if (maxD <= eps) return [pts[0], pts[pts.length-1]];
    return rdpOpen(pts.slice(0, idx+1), eps).slice(0,-1).concat(rdpOpen(pts.slice(idx), eps));
}

function simplifyLoop(pts, eps) {
    const c = simplifyCollinear(pts);
    if (c.length < 4 || eps <= 0) return c;
    const open = c.concat([c[0]]);
    const s = rdpOpen(open, eps); s.pop();
    return simplifyCollinear(s);
}

function removeClosePoints(pts, minD) {
    if (pts.length < 4 || minD <= 0) return pts;
    const r = [pts[0]]; let last = pts[0];
    for (let i = 1; i < pts.length; i++) {
        if (distanceBetween(pts[i], last) >= minD) { r.push(pts[i]); last = pts[i]; }
    }
    if (r.length > 3 && distanceBetween(r[0], r[r.length-1]) < minD) r.pop();
    return r.length >= 3 ? r : pts;
}

function buildLoops(segs, minArea, fineArea, finePerim, simplify) {
    const S = segs.map(s => ({ a: s[0], b: s[1], used: false }));
    const byPt = {};
    for (let i = 0; i < S.length; i++) {
        const ak = contourKey(S[i].a), bk = contourKey(S[i].b);
        (byPt[ak] = byPt[ak]||[]).push(i);
        (byPt[bk] = byPt[bk]||[]).push(i);
    }
    function takeNext(k) {
        const list = byPt[k]; if (!list) return -1;
        while (list.length) { const i = list.pop(); if (!S[i].used) return i; }
        return -1;
    }
    const loops = [];
    for (let i = 0; i < S.length; i++) {
        if (S[i].used) continue;
        S[i].used = true;
        const startK = contourKey(S[i].a);
        let cur = S[i].b, curK = contourKey(cur);
        const pts = [S[i].a, S[i].b]; let guard = 0;
        while (curK !== startK && guard < S.length + 8) {
            const ni = takeNext(curK); if (ni < 0) break;
            S[ni].used = true;
            const ak = contourKey(S[ni].a), bk = contourKey(S[ni].b);
            cur = ak === curK ? S[ni].b : S[ni].a;
            curK = ak === curK ? bk : ak;
            pts.push(cur); guard++;
        }
        if (curK === startK && pts.length >= 4) {
            pts.pop();
            const rawA = loopArea(pts), rawP = loopPerimeter(pts);
            if (rawA < minArea && (rawA < fineArea || rawP < finePerim)) continue;
            const compact = rawP > 0 ? (4*Math.PI*rawA)/(rawP*rawP) : 1;
            const isFine = rawA < minArea * 3.4 && compact < 0.46;
            const isLarge = rawA > minArea * 28;
            const adaptSimp = simplify * (isFine ? 0.58 : isLarge ? 1.18 : 0.9);
            const s = simplifyLoop(pts, adaptSimp);
            if (s.length >= 3) loops.push(s);
        }
    }
    return loops;
}

function traceField(vals, w, h, thr, minArea, fineArea, finePerim, simplify) {
    const segs = [];
    function add(a, b) { if (contourKey(a) !== contourKey(b)) segs.push([a, b]); }
    for (let y = 0; y < h-1; y++) {
        for (let x = 0; x < w-1; x++) {
            const tl = {x,y,value:vals[y*w+x]}, tr = {x:x+1,y,value:vals[y*w+x+1]};
            const br = {x:x+1,y:y+1,value:vals[(y+1)*w+x+1]}, bl = {x,y:y+1,value:vals[(y+1)*w+x]};
            const code = (tl.value<thr?1:0)|(tr.value<thr?2:0)|(br.value<thr?4:0)|(bl.value<thr?8:0);
            if (!code || code === 15) continue;
            const top=edgePoint(tl,tr,thr), right=edgePoint(tr,br,thr);
            const bottom=edgePoint(bl,br,thr), left=edgePoint(tl,bl,thr);
            switch(code) {
                case 1:add(left,top);break; case 2:add(top,right);break;
                case 3:add(left,right);break; case 4:add(right,bottom);break;
                case 5:add(left,top);add(right,bottom);break; case 6:add(top,bottom);break;
                case 7:add(left,bottom);break; case 8:add(bottom,left);break;
                case 9:add(bottom,top);break; case 10:add(top,right);add(bottom,left);break;
                case 11:add(bottom,right);break; case 12:add(right,left);break;
                case 13:add(right,top);break; case 14:add(top,left);break;
            }
        }
    }
    return buildLoops(segs, minArea, fineArea, finePerim, simplify);
}

// ── transform helpers ──────────────────────────────────────────────────────────
function numbersFromString(v) {
    const m = String(v).match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi);
    return m ? m.map(Number) : [];
}

function spreadMatrix(node) {
    if (!node || !node.baseToSpreadTransform) return null;
    const n = numbersFromString(node.baseToSpreadTransform);
    if (n.length >= 6) return { a:n[0], b:n[1], c:n[2], d:n[3], e:n[4], f:n[5] };
    if (typeof node.baseToSpreadTransform.decompose === 'function') {
        const d = numbersFromString(node.baseToSpreadTransform.decompose());
        if (d.length >= 6 && Math.abs(d[2]) < 0.0001 && Math.abs(d[3]) < 0.0001)
            return { a:d[0], b:0, c:d[4], d:0, e:d[1], f:d[5] };
    }
    return null;
}

function toSpreadPoint(p, mapping, gw, gh) {
    if (mapping && mapping.matrix) {
        const sx = p.x / Math.max(0.0001, mapping.scale||1);
        const sy = p.y / Math.max(0.0001, mapping.scale||1);
        const m = mapping.matrix;
        return { x: m.a*sx + m.b*sy + m.c, y: m.d*sx + m.e*sy + m.f };
    }
    const box = mapping.box || mapping;
    return { x: box.x + (p.x / Math.max(1, gw-1)) * box.width, y: box.y + (p.y / Math.max(1, gh-1)) * box.height };
}

// ── curve building ─────────────────────────────────────────────────────────────
function cornerTurn(prev, p, next) {
    const ax = prev.x-p.x, ay = prev.y-p.y, bx = next.x-p.x, by = next.y-p.y;
    const al = Math.sqrt(ax*ax+ay*ay), bl = Math.sqrt(bx*bx+by*by);
    if (al < 0.001 || bl < 0.001) return 0;
    return 180 - Math.acos(clamp((ax*bx+ay*by)/(al*bl), -1, 1)) * 180 / Math.PI;
}

function isTrueCorner(pts, i, isFine, avgSeg) {
    const prev = pts[(i-1+pts.length)%pts.length], p = pts[i], next = pts[(i+1)%pts.length];
    const turn = cornerTurn(prev, p, next);
    const thr = isFine ? clamp(42 - OPTIONS.corners*0.14, 24, 42) : clamp(50 - OPTIONS.corners*0.18, 28, 50);
    const minLeg = Math.min(distanceBetween(prev,p), distanceBetween(p,next));
    const reqLeg = Math.max((avgSeg||0) * (isFine ? 1.15 : 1.55), 0.12);
    if (minLeg < reqLeg && turn < 122) return false;
    return turn >= thr;
}

function smoothSpreadPts(pts, passes, amount, isFine) {
    if (pts.length < 5 || !passes || !amount) return pts;
    let cur = pts;
    for (let pass = 0; pass < passes; pass++) {
        const next = [];
        const avgSeg = loopPerimeter(cur) / Math.max(1, cur.length);
        for (let i = 0; i < cur.length; i++) {
            const prev = cur[(i-1+cur.length)%cur.length], p = cur[i], nx = cur[(i+1)%cur.length];
            if (isTrueCorner(cur, i, isFine, avgSeg)) { next.push(p); continue; }
            const turn = cornerTurn(prev, p, nx);
            const damp = clamp((turn-54)/92, 0, 0.72);
            next.push({ x: p.x+((prev.x+nx.x)*0.5-p.x)*amount*(1-damp), y: p.y+((prev.y+nx.y)*0.5-p.y)*amount*(1-damp) });
        }
        cur = next;
    }
    return cur;
}

function smoothLoopPts(pts, passes, amount, angleLimit) {
    if (pts.length < 5 || !passes || !amount) return pts;
    let cur = pts;
    for (let pass = 0; pass < passes; pass++) {
        const next = [];
        for (let i = 0; i < cur.length; i++) {
            const prev = cur[(i-1+cur.length)%cur.length], p = cur[i], nx = cur[(i+1)%cur.length];
            const ax = prev.x-p.x, ay = prev.y-p.y, bx = nx.x-p.x, by = nx.y-p.y;
            const al = Math.sqrt(ax*ax+ay*ay), bl = Math.sqrt(bx*bx+by*by);
            let isCorner = false;
            if (al > 0.001 && bl > 0.001) {
                const dot = clamp((ax*bx+ay*by)/(al*bl), -1, 1);
                isCorner = Math.acos(dot)*180/Math.PI < angleLimit;
            }
            if (isCorner) { next.push(p); continue; }
            next.push({ x: p.x+((prev.x+nx.x)*0.5-p.x)*amount, y: p.y+((prev.y+nx.y)*0.5-p.y)*amount });
        }
        cur = next;
    }
    return cur;
}

function limitedControl(anchor, target, prev, scale, limitFactor) {
    const c = { x: anchor.x+(target.x-prev.x)*scale, y: anchor.y+(target.y-prev.y)*scale };
    const hl = distanceBetween(anchor, c);
    const sl = Math.max(0.01, distanceBetween(anchor, target) * limitFactor);
    if (hl <= sl) return c;
    const ratio = sl / hl;
    return { x: anchor.x+(c.x-anchor.x)*ratio, y: anchor.y+(c.y-anchor.y)*ratio };
}

function buildCurveFromLoop(loop, mapping, gw, gh, isFine) {
    const rawPts = loop.map(p => toSpreadPoint(p, mapping, gw, gh));
    const sPass = isFine ? 2 : 3;
    const sAmt = isFine ? clamp((100-OPTIONS.corners)/250+OPTIONS.blur*0.06, 0.04, 0.12)
                        : clamp((100-OPTIONS.corners)/190+OPTIONS.blur*0.08, 0.07, 0.2);
    const pts = smoothSpreadPts(rawPts, sPass, sAmt, isFine);
    const builder = CurveBuilder.create();
    if (pts.length < 4) {
        pts.forEach((p, i) => i === 0 ? builder.begin(p) : builder.lineTo(p));
        builder.close(); return builder.createCurve();
    }
    const scale = isFine ? clamp(0.075+(100-OPTIONS.corners)/900+OPTIONS.blur*0.015, 0.07, 0.13)
                         : clamp(0.105+(100-OPTIONS.corners)/760+OPTIONS.blur*0.02, 0.09, 0.17);
    const limitF = isFine ? 0.34 : 0.46;
    const avgSeg = loopPerimeter(pts) / Math.max(1, pts.length);
    builder.begin(pts[0]);
    for (let i = 0; i < pts.length; i++) {
        const p0 = pts[(i-1+pts.length)%pts.length], p1 = pts[i];
        const p2 = pts[(i+1)%pts.length], p3 = pts[(i+2)%pts.length];
        const c1i = isTrueCorner(pts, i, isFine, avgSeg);
        const c2i = isTrueCorner(pts, (i+1)%pts.length, isFine, avgSeg);
        const ls = scale * (c1i||c2i ? 0.42 : 1), ll = limitF * (c1i||c2i ? 0.5 : 1);
        builder.addBezier(limitedControl(p1,p2,p0,ls,ll), limitedControl(p2,p1,p3,ls,ll), p2);
    }
    builder.close(); return builder.createCurve();
}

function buildBoundsRect(box) {
    const b = CurveBuilder.create();
    b.begin({x:box.x,y:box.y}); b.lineTo({x:box.x+box.width,y:box.y});
    b.lineTo({x:box.x+box.width,y:box.y+box.height}); b.lineTo({x:box.x,y:box.y+box.height});
    b.close(); return b.createCurve();
}

// ── createTraceNode ────────────────────────────────────────────────────────────
// Unchanged logic from original v1.1 — only threshold relaxed above.
function createTraceNode(doc, sourceNode) {
    const sample = sampleField(sourceNode);
    const box = sourceNode.getSpreadVisibleBox();
    if (!box) throw new Error('Could not read selected image bounds.');
    const mapping = { box, matrix: spreadMatrix(sourceNode), scale: sample.scale||1 };

    const ss = sample.scale || 1;
    const minArea = Math.max(1, OPTIONS.minArea * ss * 1.45);
    const fineArea = Math.max(0.7, OPTIONS.minArea * ss * 0.22);
    const finePer = Math.max(7, ss * (6 + OPTIONS.paths / 9));
    const simpBase = clamp(0.54 + OPTIONS.optimize*1.72 + OPTIONS.noise/26 - OPTIONS.paths/260, 0.2, 3.8);
    const simplify = simpBase * ss * (OPTIONS.preset === 4 ? 1 : 0.62);
    const thr = sample.threshold || OPTIONS.threshold;

    const loops = traceField(sample.values, sample.width, sample.height, thr, minArea, fineArea, finePer, simplify);
    if (!loops.length) throw new Error('No dark shapes found. Try a lower Edge fit value.');

    const poly = PolyCurve.create();
    const maxLoops = OPTIONS.preset === 1 ? 1200 : 700;
    loops.sort((a,b) => loopArea(b) - loopArea(a));

    for (const loop of loops.slice(0, maxLoops)) {
        const area = loopArea(loop), perim = loopPerimeter(loop);
        const compact = loopCompactness(loop);
        const isFine = area < minArea*3.2 && compact < 0.46;
        const minPtD = clamp(0.2+OPTIONS.optimize*0.48+OPTIONS.noise/110, 0.1, 1.35) * ss * (isFine ? 0.46 : 0.92);
        const sPass = isFine ? 1 : 0;
        const sAmt = clamp((100-OPTIONS.corners)/260+OPTIONS.blur*0.08, 0.04, 0.18) * (isFine ? 0.55 : 0);
        const cornerAng = clamp(62 + OPTIONS.corners*0.72, 75, 136);
        const cleaned = removeClosePoints(loop, minPtD);
        const smoothed = smoothLoopPts(cleaned, sPass, sAmt, cornerAng);
        poly.addCurve(buildCurveFromLoop(smoothed, mapping, sample.width, sample.height, isFine));
    }

    const black = RGBA8(0,0,0,255), white = RGBA8(255,255,255,255);
    const fill = FillDescriptor.createSolid(black, BlendMode.Normal);
    const whiteFill = FillDescriptor.createSolid(white, BlendMode.Normal);
    const noStroke = FillDescriptor.createNone();
    const lineStyle = LineStyleDescriptor.createDefault(0);

    const curveDef = PolyCurveNodeDefinition.create(poly, fill, lineStyle, noStroke, FillDescriptor.createNone());
    curveDef.userDescription = 'Image Trace Superior Auto Curves';

    const bgPoly = PolyCurve.create();
    bgPoly.addCurve(buildBoundsRect(box));
    const bgDef = PolyCurveNodeDefinition.create(bgPoly, whiteFill, lineStyle, noStroke, FillDescriptor.createNone());
    bgDef.userDescription = 'Image Trace Superior Background';

    const bgBuilder = AddChildNodesCommandBuilder.create();
    bgBuilder.addNode(bgDef);
    const bgCmd = bgBuilder.createCommand(false, NodeChildType.Main);

    const traceBuilder = AddChildNodesCommandBuilder.create();
    traceBuilder.addNode(curveDef);
    const traceCmd = traceBuilder.createCommand(true, NodeChildType.Main);

    // Delete old
    const old = previousTraceNodes(doc);
    if (old.length) doc.executeCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, old)));

    // Add background
    doc.executeCommand(bgCmd);
    const bgNodes = bgCmd.newNodes ? [...bgCmd.newNodes] : [];

    // Add trace
    doc.executeCommand(traceCmd);
    const traceNodes = traceCmd.newNodes ? [...traceCmd.newNodes] : [];
    if (traceNodes.length) doc.executeCommand(DocumentCommand.createSetBrushFill(Selection.create(doc, traceNodes), black));

    // Reorder: background behind trace
    if (bgNodes.length && traceNodes.length) {
        doc.executeCommand(DocumentCommand.createMoveNodes(
            Selection.create(doc, bgNodes), traceNodes[0], NodeMoveType.Before, NodeChildType.Main));
    }

    // Select both
    const allNew = bgNodes.concat(traceNodes);
    if (allNew.length) doc.executeCommand(DocumentCommand.createSetSelection(Selection.create(doc, allNew)));

    // Hide source
    if (!OPTIONS.previewOriginal) doc.executeCommand(DocumentCommand.createHideSelection(Selection.create(doc, sourceNode)));

    return {
        loops: Math.min(loops.length, maxLoops),
        width: sample.width,
        height: sample.height
    };
}

// ── dialog ─────────────────────────────────────────────────────────────────────
// FIX: footer ButtonSet added to col1, NOT dlg (dlg.addGroup is not a function)
function buildDialog(status, actionIdx) {
    const dlg = Dialog.create('Image Trace Superior v1.1');
    dlg.initialWidth = 760;

    const col1 = dlg.addColumn();
    const col2 = dlg.addColumn();
    col1.widthProportion = 1;
    col2.widthProportion = 1;

    // ── Fidelity (col1) ──────────────────────────────────────────────────────
    const gFid = col1.addGroup('Trace');
    dlg.threshold = gFid.addUnitValueEditor('Edge fit',      UnitType.Pixel, UnitType.Pixel, OPTIONS.threshold, 1,   255);
    dlg.paths     = gFid.addUnitValueEditor('Detail',        UnitType.Pixel, UnitType.Pixel, OPTIONS.paths,     0,   100);
    dlg.corners   = gFid.addUnitValueEditor('Curve fidelity',UnitType.Pixel, UnitType.Pixel, OPTIONS.corners,   0,   100);
    dlg.noise     = gFid.addUnitValueEditor('Cleanup px',    UnitType.Pixel, UnitType.Pixel, OPTIONS.noise,     0,    80);
    dlg.minArea   = gFid.addUnitValueEditor('Min detail',    UnitType.Pixel, UnitType.Pixel, OPTIONS.minArea,   0,   200);

    // ── Quality + Output (col2) ───────────────────────────────────────────────
    const gQual = col2.addGroup('Quality');
    dlg.despeckle = gQual.addUnitValueEditor('Speckle px',  UnitType.Pixel, UnitType.Pixel, OPTIONS.despeckle,  0,  80);
    dlg.blur      = gQual.addUnitValueEditor('Anti alias',  UnitType.Pixel, UnitType.Pixel, OPTIONS.blur,        0,   2);
    dlg.optimize  = gQual.addUnitValueEditor('Simplify',    UnitType.Pixel, UnitType.Pixel, OPTIONS.optimize,    0,   2);

    const gOut = col2.addGroup('Output');
    dlg.previewOriginal = gOut.addSwitch('Keep original visible', OPTIONS.previewOriginal);

    // ── Footer on col1: status label + Preview/Apply ButtonSet ───────────────
    // MUST be on a column, not on dlg directly (dlg.addGroup is not a function).
    const gFooter = col1.addGroup('');
    gFooter.enableSeparator = false;
    dlg.actionSet = gFooter.addButtonSet(
        status,
        ['\u21BA  Preview', '\u2713  Apply'],
        actionIdx
    );

    return dlg;
}

function syncOptions(dlg) {
    OPTIONS.threshold       = clamp(Math.round(dlg.threshold.value), 1, 255);
    OPTIONS.paths           = clamp(dlg.paths.value, 0, 100);
    OPTIONS.corners         = clamp(dlg.corners.value, 0, 100);
    OPTIONS.noise           = clamp(dlg.noise.value, 0, 80);
    OPTIONS.minArea         = clamp(Math.round(dlg.minArea.value), 0, 200);
    OPTIONS.despeckle       = clamp(dlg.despeckle.value, 0, 80);
    OPTIONS.blur            = clamp(dlg.blur.value, 0, 2);
    OPTIONS.optimize        = clamp(dlg.optimize.value, 0, 2);
    OPTIONS.previewOriginal = dlg.previewOriginal.value;
}

function isOk(result) {
    const okVal = DialogResult.Ok.value;
    const rv = (typeof result === 'object' && 'value' in result) ? result.value : result;
    return rv === okVal;
}

// ── main ───────────────────────────────────────────────────────────────────────
function main() {
    const doc = Document.current;
    if (!doc) { alert('Open an Affinity document first.'); return; }

    const node = selectedRasterNode(doc);
    if (!node) {
        alert(
            'No readable image layer found.\n\n' +
            'Select or place a PNG/JPG image layer, then run Image Trace Superior again.\n' +
            '(Pasted or rasterized layers may have empty pixel data.)'
        );
        return;
    }

    let previewActive = false;
    let status    = 'Adjust settings \u2014 Preview to see on canvas, Apply to commit';
    let actionIdx = 0; // 0 = Preview pre-selected

    while (true) {
        const dlg = buildDialog(status, actionIdx);
        const result = dlg.runModal();

        // Cancel → undo any uncommitted preview and exit
        if (!isOk(result)) {
            if (previewActive) {
                for (let i = 0; i < 20; i++) {
                    if (!previousTraceNodes(doc).length) break;
                    if (!doc.canUndo) break;
                    doc.undo();
                }
            }
            return;
        }

        syncOptions(dlg);
        const intent = dlg.actionSet.selectedIndex; // 0 = Preview, 1 = Apply

        try {
            const res = createTraceNode(doc, node);
            const n = res.loops;

            if (intent === 0) {
                // Preview
                previewActive = true;
                status    = `Previewing \u2014 ${n} curves from ${res.width}\xd7${res.height}px \u2014 adjust & Preview again, or Apply`;
                actionIdx = 0;
            } else {
                // Apply — committed, Cancel will no longer revert
                previewActive = false;
                status    = `\u2713 Applied \u2014 ${n} curves \u2014 tweak & Preview, or Apply again`;
                actionIdx = 1;
            }
        } catch (err) {
            status    = '\u26A0  ' + (err && err.message ? err.message : 'Trace failed \u2014 try adjusting settings');
            actionIdx = intent;
        }
    }
}

module.exports.main = main;
main();
