'use strict';
// ============================================================
// Text Fill v7
// Fills a closed shape (also several shapes — each one SEPARATELY
// and independently, each clipped into its own shape —, also with
// holes) with the selected text objects (artistic text and/or
// words/sentences extracted from frame text) using the word-cloud
// principle: spiral search per item, collision test via rotated
// rectangles (SAT), point-in-shape test via a winding-independent
// fill/hole classification of the actual curve.
// Architecture/conventions as in "Object Fill" v32 (Blur Shadow
// dialog concept, composedSpreadTF, makePRNG, presets).
//
// v6: winding-independent hole detection (buildShapePolygons), each
//     fill group clipped into its own target shape.
//
// v7: BUGFIX stale preview: OK used to keep the last preview even
//     when settings were changed afterwards. OK now refills if the
//     settings changed since the preview; with unchanged settings
//     the shown preview is kept (important for seed 0 = time).
// ============================================================
const { Document }                   = require('/document');
const { Dialog, DialogResult }       = require('/dialog');
const { DocumentCommand,
        AddChildNodesCommandBuilder,
        NodeMoveType, NodeChildType } = require('/commands');
const { Selection }                  = require('/selections');
const { ContainerNodeDefinition,
        ArtTextNodeDefinition }      = require('/nodes');
const { StoryBuilder }               = require('/storybuilder');
const { Transform, Polygon }        = require('/geometry');
const { Colour, Gradient }           = require('/colours');
const { FillDescriptor, GradientFill } = require('/fills');
const { StoryDelta }                 = require('/storydelta');
const { app }                        = require('/application');
const { File, FileSystemApi }        = require('/fs');

const TITLE = 'Text Fill';
const doc = Document.current;
if (!doc) { app.alert('No document open.', TITLE); throw new Error(); }
const initSel = doc.selection;
if (!initSel || initSel.length < 2) { app.alert('Please select a closed shape AND at least one text object.', TITLE); throw new Error(); }

// ── Helpers ─────────────────────────────────────────────────
function getBB(n) { try { return n.getSpreadBaseBox(false); } catch (e) { return null; } }
function diag(bb) { return bb ? Math.sqrt(bb.width * bb.width + bb.height * bb.height) : 0; }
function dist(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return Math.sqrt(dx * dx + dy * dy); }
function randBetween(a, b) { return a + Math.random() * (b - a); }
function clamp(v, mn, mx) { return Math.max(mn, Math.min(mx, v)); }

function makePRNG(seed) {
    let s = seed >>> 0;
    return function () { s += 0x6D2B79F5; let t = s; t = Math.imul(t ^ t >>> 15, 1 | t); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

function composedSpreadTF(node) {
    const chain = [];
    let cur = node;
    while (cur && cur.constructor && cur.constructor.name !== 'SpreadNode') {
        chain.push(cur.transform);
        cur = cur.parent;
    }
    chain.reverse();
    return {
        applyToPoint(pt) { let p = pt; for (const tf of chain) p = tf.applyToPoint(p); return p; },
        asTransform() { let tf = Transform.createIdentity(); for (const t of chain) tf = t.multiply(tf); return tf; }
    };
}

function findSpread(node) {
    let cur = node;
    while (cur && cur.constructor && cur.constructor.name !== 'SpreadNode') cur = cur.parent;
    return cur;
}

function deleteGroupFully(grp) {
    if (!grp) return;
    try { const ch = []; for (const c of grp.children) ch.push(c); for (const c of ch) { try { c.delete(); } catch (e) { } } grp.delete(); } catch (e) { }
}
function nextGroupIndex() {
    let max = 0;
    for (const l of doc.layers.all) { const m = (l.userDescription || '').match(/^TextFill_(\d+)$/); if (m) max = Math.max(max, parseInt(m[1])); }
    return max + 1;
}

function quantizedRandom(prng, min, max, steps) {
    if (steps <= 1 || max === min) return min;
    const k = Math.floor(prng() * steps);
    const kk = Math.min(steps - 1, k);
    return min + (kk / (steps - 1)) * (max - min);
}

function angleSetForDivider(div) {
    switch (div) {
        case 1: return [0];
        case 2: return [90, 0, -90];
        case 3: return [90, 30, -30, -90];
        case 4: return [90, 45, 0, -45, -90];
        case 5: return [90, 54, 18, -18, -54, -90];
        case 6: return [90, 60, 30, 0, -30, -60, -90];
        default: return null;
    }
}
function pickAngleDeg(prng, div) {
    const set = angleSetForDivider(div);
    if (!set) return randBetween(-90, 90);
    return set[Math.floor(prng() * set.length) % set.length];
}

function rectCorners(cx, cy, w, h, angRad) {
    const cosA = Math.cos(angRad), sinA = Math.sin(angRad);
    const hw = w / 2, hh = h / 2;
    const local = [{ x: -hw, y: -hh }, { x: hw, y: -hh }, { x: hw, y: hh }, { x: -hw, y: hh }];
    return local.map(p => ({ x: cx + p.x * cosA - p.y * sinA, y: cy + p.x * sinA + p.y * cosA }));
}
function rectsOverlap(a, b) {
    for (const poly of [a, b]) {
        for (let i = 0; i < 4; i++) {
            const p1 = poly[i], p2 = poly[(i + 1) % 4];
            const axisX = -(p2.y - p1.y), axisY = (p2.x - p1.x);
            let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
            for (const p of a) { const d = p.x * axisX + p.y * axisY; minA = Math.min(minA, d); maxA = Math.max(maxA, d); }
            for (const p of b) { const d = p.x * axisX + p.y * axisY; minB = Math.min(minB, d); maxB = Math.max(maxB, d); }
            if (maxA < minB || maxB < minA) return false;
        }
    }
    return true;
}

// ── Split selection: target shapes vs. text sources ──────────
const allNodes = [];
for (let i = 0; i < initSel.length; i++) allNodes.push(initSel.at(i).node);

function hasClosedCurve(node) {
    try {
        const pc = node.curvesInterface.polyCurve;
        for (let i = 0; i < pc.curveCount; i++) { const c = pc.at(i); if (c.isClosed && !c.isEmpty) return true; }
    } catch (e) { }
    return false;
}
function collectTextNodesRecursive(node, out) {
    if (node.isTextNode) { out.push(node); return; }
    if (node.isGroupNode || node.children) {
        try { for (const c of node.children) collectTextNodesRecursive(c, out); } catch (e) { }
    }
}

const textSourceNodes = [];
const shapeCandidates = [];
for (const n of allNodes) {
    if (n.isTextNode) { textSourceNodes.push(n); continue; }
    if (n.isGroupNode) {
        const found = [];
        collectTextNodesRecursive(n, found);
        if (found.length > 0) { textSourceNodes.push(...found); continue; }
    }
    if (hasClosedCurve(n)) shapeCandidates.push(n);
}
if (textSourceNodes.length === 0) { app.alert('No text objects found in the selection.', TITLE); throw new Error(); }
if (shapeCandidates.length === 0) { app.alert('No closed shape found in the selection.', TITLE); throw new Error(); }
const targetNodes = shapeCandidates;
const targetHostNode = targetNodes.reduce((a, b) => diag(getBB(a)) >= diag(getBB(b)) ? a : b);

// ── Build text pool ──────────────────────────────────────────
function splitWords(str) {
    return str.split(/\s+/).map(w => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(w => w.length > 0);
}
function splitSentences(str, keepPeriod) {
    return str.split('.').map(s => s.trim()).filter(s => s.length > 0).map(s => keepPeriod ? s + '.' : s);
}
// Weight via name prefix "_number_" (e.g. "_3_Headline" → 3), otherwise 1.
function getWeight(node) {
    const name = node.userDescription || '';
    const m = name.match(/^_(\d+(?:[.,]\d+)?)_/);
    if (!m) return 1;
    const w = parseFloat(m[1].replace(',', '.'));
    return (isFinite(w) && w > 0) ? w : 1;
}
function buildPool(extractionMode, keepSentencePeriod) {
    const pool = [];
    for (const src of textSourceNodes) {
        const isFrame = !!src.isFrameTextNode;
        if (!isFrame) { pool.push({ src, text: null }); continue; }
        let raw = '';
        try { raw = src.getText(); } catch (e) { raw = ''; }
        if (!raw) continue;
        if (extractionMode !== 1) for (const w of splitWords(raw)) pool.push({ src, text: w });
        if (extractionMode !== 0) for (const s of splitSentences(raw, keepSentencePeriod)) pool.push({ src, text: s });
    }
    return pool;
}

// ── Colour: read/write (text colour lives in the story's GlyphAtts) ─
function toColour(colOrHandle) {
    return (colOrHandle && colOrHandle.hslaf !== undefined) ? colOrHandle : new Colour(colOrHandle);
}
function colourHSLA(colOrHandle) {
    const h = toColour(colOrHandle).hslaf;
    return { h: h.h * 360, s: h.s * 100, l: h.l * 100, a: (h.alpha != null ? h.alpha : 1) * 100 };
}
function getGlyphFD(srcNode, usePen) {
    try {
        const atts = srcNode.story.getGlyphAtts(0);
        return usePen ? atts.penFill : atts.brushFill;
    } catch (e) { return null; }
}
function shiftColour(colOrHandle, hOff, sOff, lOff, aOff) {
    const h = colourHSLA(colOrHandle);
    const newH = ((h.h + hOff) % 360 + 360) % 360;
    const newS = clamp(h.s + sOff, 0, 100);
    const newL = clamp(h.l + lOff, 0, 100);
    const newA = clamp(h.a + aOff, 0, 100);
    return Colour.createHSLAf({ h: newH / 360, s: newS / 100, l: newL / 100, alpha: newA / 100 });
}
function shiftFD(fd, hOff, sOff, lOff, aOff) {
    if (!fd || !fd.fill) return null;
    const kind = fd.fill.constructor.name;
    if (kind === 'SolidFill') {
        return FillDescriptor.createSolid(shiftColour(fd.fill.colour, hOff, sOff, lOff, aOff));
    }
    if (kind === 'GradientFill') {
        const g = fd.fill.gradient;
        const stops = [];
        for (let i = 0; i < g.stopCount; i++) {
            const st = g.getStop(i);
            stops.push({ colour: shiftColour(st.colour, hOff, sOff, lOff, aOff), position: st.position, midpoint: st.midpoint });
        }
        const newGrad = Gradient.create(stops);
        const newGF = GradientFill.create(newGrad, fd.fill.gradientFillType);
        return FillDescriptor.create(newGF, fd.isScaleWithObject, fd.transform, fd.blendMode, fd.isAnchoredToSpread);
    }
    return null;
}
function setGlyphFD(node, fd, usePen) {
    const delta = usePen ? StoryDelta.createPenFill(fd) : StoryDelta.createBrushFill(fd);
    doc.executeCommand(DocumentCommand.createSetSelection(node.selfSelection));
    doc.formatText(delta, doc.selection, false);
}
function getBaseHSL() {
    try {
        const fd = getGlyphFD(textSourceNodes[0], false);
        if (fd && fd.fill && fd.fill.constructor.name === 'SolidFill') return colourHSLA(fd.fill.colour);
        if (fd && fd.fill && fd.fill.constructor.name === 'GradientFill') return colourHSLA(fd.fill.gradient.getStop(0).colour);
    } catch (e) { }
    return { h: 0, s: 0, l: 50, a: 100 };
}
const baseHSL = getBaseHSL();

// ── Target polygons in spread space (winding-independent) ────
function pointInPolygonRaw(pts, x, y) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
        const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}
function signedPolygonArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) { const p1 = pts[i], p2 = pts[(i + 1) % pts.length]; a += p1.x * p2.y - p2.x * p1.y; }
    return a / 2;
}
function buildShapePolygons(node) {
    const tf = composedSpreadTF(node).asTransform();
    const pc = node.curvesInterface.polyCurve;
    const contours = [];
    for (let i = 0; i < pc.curveCount; i++) {
        const curve = pc.at(i);
        if (curve.isEmpty) continue;
        const polyRaw = new Polygon(curve.generatePolygon(0.5));
        const pts = [];
        for (let j = 0; j < polyRaw.pointCount; j++) pts.push(tf.applyToPoint(polyRaw.getPoint(j)));
        if (pts.length < 3) continue;
        contours.push({ pts, area: Math.abs(signedPolygonArea(pts)) });
    }
    contours.sort((a, b) => b.area - a.area);
    const classified = [];
    for (const c of contours) {
        let isHole = false;
        const testPt = c.pts[0];
        for (const prev of classified) {
            if (!prev.isHole && pointInPolygonRaw(prev.pts, testPt.x, testPt.y)) { isHole = true; break; }
        }
        classified.push({ pts: c.pts, isHole });
    }
    return classified;
}
function pointInTarget(shapePolys, x, y) {
    let insideFill = false, insideHole = false;
    for (const p of shapePolys) {
        if (pointInPolygonRaw(p.pts, x, y)) { if (p.isHole) insideHole = true; else insideFill = true; }
    }
    return insideFill && !insideHole;
}
function targetArea(nodes) {
    let total = 0;
    for (const n of nodes) {
        try {
            for (const c of buildShapePolygons(n)) {
                const a = Math.abs(signedPolygonArea(c.pts));
                total += c.isHole ? -a : a;
            }
        } catch (e) { }
    }
    return Math.abs(total);
}

// ── Contour alignment ("Tangential to contour") ──────────────
function bzPtW(bz, t, tf) {
    const mt = 1 - t;
    const lx = mt * mt * mt * bz.start.x + 3 * mt * mt * t * bz.c1.x + 3 * mt * t * t * bz.c2.x + t * t * t * bz.end.x;
    const ly = mt * mt * mt * bz.start.y + 3 * mt * mt * t * bz.c1.y + 3 * mt * t * t * bz.c2.y + t * t * t * bz.end.y;
    return tf.applyToPoint({ x: lx, y: ly });
}
function bzTanW(bz, t, tf) {
    const mt = 1 - t;
    let tlx = 3 * (mt * mt * (bz.c1.x - bz.start.x) + 2 * mt * t * (bz.c2.x - bz.c1.x) + t * t * (bz.end.x - bz.c2.x));
    let tly = 3 * (mt * mt * (bz.c1.y - bz.start.y) + 2 * mt * t * (bz.c2.y - bz.c1.y) + t * t * (bz.end.y - bz.c2.y));
    if (Math.sqrt(tlx * tlx + tly * tly) < 0.001) { tlx = bz.end.x - bz.start.x; tly = bz.end.y - bz.start.y; }
    if (Math.sqrt(tlx * tlx + tly * tly) < 0.001) { tlx = 1; tly = 0; }
    const tw = tf.applyToVector({ x: tlx, y: tly });
    const wl = Math.sqrt(tw.x * tw.x + tw.y * tw.y) || 1;
    return { x: tw.x / wl, y: tw.y / wl };
}
function buildContourSamples(node, stepPx) {
    const tf = composedSpreadTF(node).asTransform();
    const pc = node.curvesInterface.polyCurve;
    const samples = [];
    for (let ci = 0; ci < pc.curveCount; ci++) {
        for (const bz of pc.at(ci).beziers) {
            const bzLenApprox = dist(bz.start.x, bz.start.y, bz.end.x, bz.end.y) || 1;
            const steps = Math.max(2, Math.ceil(bzLenApprox / Math.max(4, stepPx)));
            for (let s = 0; s <= steps; s++) {
                const t = s / steps;
                const pt = bzPtW(bz, t, tf), tan = bzTanW(bz, t, tf);
                samples.push({ x: pt.x, y: pt.y, angle: Math.atan2(tan.y, tan.x) });
            }
        }
    }
    return samples;
}
function nearestTangentAngle(samples, x, y) {
    let best = null, bestD = Infinity;
    for (const s of samples) { const d = (s.x - x) * (s.x - x) + (s.y - y) * (s.y - y); if (d < bestD) { bestD = d; best = s; } }
    return best ? best.angle : 0;
}

// ── Archimedean spiral for placement search ──────────────────
function* spiralPoints(cx, cy, maxR, stepPx) {
    const a = stepPx / (2 * Math.PI);
    let theta = 0.0001;
    while (true) {
        const r = a * theta;
        if (r > maxR) return;
        yield { x: cx + r * Math.cos(theta), y: cy + r * Math.sin(theta) };
        theta += Math.max(0.06, stepPx / Math.max(r, stepPx));
    }
}
function collectSpiralPoints(cx, cy, maxR, stepPx, edgeBias) {
    const pts = [];
    for (const pt of spiralPoints(cx, cy, maxR, stepPx)) { pts.push(pt); if (pts.length >= 2500) break; }
    if (edgeBias) pts.reverse();
    return pts;
}

// ── Place one item ───────────────────────────────────────────
function placeItem(item, params, prng, targetPolys, targetBB, contourSamples, placedRects, fillGroup) {
    let dup;
    if (item.text == null) {
        const dupCmd = DocumentCommand.createTransform(Selection.create(doc, [item.src]), null, { duplicateNodes: true });
        doc.executeCommand(dupCmd);
        dup = dupCmd.newNodes[0];
        if (!dup) return false;
    } else {
        // Word/sentence extracted from frame text: fresh ArtTextNode with the style at position 0.
        try {
            const spread = findSpread(item.src);
            const atts = item.src.story.getGlyphAtts(0);
            const sb = StoryBuilder.create().setToArtisticTextDefaultStyle(96, 1);
            sb.setGlyphAtts(atts);
            sb.addText(item.text);
            const srcBB = getBB(item.src);
            const def = ArtTextNodeDefinition.createFromStoryBuilder({ x: srcBB ? srcBB.x : 0, y: srcBB ? srcBB.y : 0 }, sb);
            const b = AddChildNodesCommandBuilder.create();
            b.addNode(def);
            b.setInsertionTarget(spread);
            const cmd = b.createCommand(false, NodeChildType.Main);
            doc.executeCommand(cmd);
            dup = cmd.newNodes[0];
            if (!dup) return false;
        } catch (e) { return false; }
    }

    // getSpreadBaseBox() is the correct way for text (polyCurve box is too small).
    let localBB = getBB(dup);
    if (!localBB || localBB.width < 0.01 || localBB.height < 0.01) { try { dup.delete(); } catch (e) { } return false; }

    let sizeScale = clamp(1 + randBetween(-params.sizeVariance, params.sizeVariance) / 100, 0.05, 20);
    if (params.minSizePx > 0) sizeScale = Math.max(sizeScale, params.minSizePx / localBB.height);
    if (params.maxSizePx > 0) sizeScale = Math.min(sizeScale, params.maxSizePx / localBB.height);
    const useContourAngle = params.angleDivider === 7 && contourSamples && contourSamples.length > 0;
    const fixedAngleDeg = useContourAngle ? null : pickAngleDeg(prng, params.angleDivider);
    const fixedAngleRad = fixedAngleDeg != null ? fixedAngleDeg * Math.PI / 180 : null;
    const rectW = localBB.width * sizeScale, rectH = localBB.height * sizeScale;
    const pad = Math.max(0, params.padding || 0);
    const padRectW = rectW + 2 * pad, padRectH = rectH + 2 * pad;
    const stepPx = Math.max(3, Math.min(padRectW, padRectH) * 0.35);
    const maxR = diag(targetBB) * 0.75 + Math.max(padRectW, padRectH);
    const cx0 = targetBB.x + targetBB.width / 2, cy0 = targetBB.y + targetBB.height / 2;
    const candidatePts = collectSpiralPoints(cx0, cy0, maxR, stepPx, !!params.edgeBias);

    let found = null, foundAngleRad = fixedAngleRad;
    for (const pt of candidatePts) {
        const angleRad = useContourAngle ? nearestTangentAngle(contourSamples, pt.x, pt.y) : fixedAngleRad;
        const corners = rectCorners(pt.x, pt.y, padRectW, padRectH, angleRad);
        let allInside = true;
        for (const c of corners) if (!pointInTarget(targetPolys, c.x, c.y)) { allInside = false; break; }
        if (!allInside || !pointInTarget(targetPolys, pt.x, pt.y)) continue;
        let overlaps = false;
        for (const pr of placedRects) if (rectsOverlap(corners, pr)) { overlaps = true; break; }
        if (overlaps) continue;
        found = { pt, corners };
        foundAngleRad = angleRad;
        break;
    }
    if (!found) { try { dup.delete(); } catch (e) { } return false; }

    const localCx = localBB.x + localBB.width / 2, localCy = localBB.y + localBB.height / 2;
    const placeTF = Transform.createTranslate(found.pt.x, found.pt.y)
        .multiply(Transform.createRotate(foundAngleRad))
        .multiply(Transform.createScale(sizeScale, sizeScale))
        .multiply(Transform.createTranslate(-localCx, -localCy));
    try {
        const sel = Selection.createEmpty(doc);
        sel.addNode(dup);
        doc.applyTransform(placeTF, sel);
    } catch (e) {
        try { doc.executeCommand(DocumentCommand.createTransform(Selection.create(doc, [dup]), placeTF)); } catch (e2) { }
    }

    // Colour jitter (HSL + opacity) — additive, one shared offset for fill and stroke.
    try {
        const hOff = quantizedRandom(prng, params.hMin, params.hMax, params.hSteps);
        const sOff = quantizedRandom(prng, params.sMin, params.sMax, params.sSteps);
        const lOff = quantizedRandom(prng, params.lMin, params.lMax, params.lSteps);
        const aOff = quantizedRandom(prng, params.aMin, params.aMax, params.aSteps);

        const fdBrush = getGlyphFD(item.src, false);
        if (fdBrush && fdBrush.fill && fdBrush.fill.constructor.name !== 'NoFill') {
            const shifted = shiftFD(fdBrush, hOff, sOff, lOff, aOff);
            if (shifted) setGlyphFD(dup, shifted, false);
        }
        const fdPen = getGlyphFD(item.src, true);
        if (fdPen && fdPen.fill && fdPen.fill.constructor.name !== 'NoFill') {
            const shiftedPen = shiftFD(fdPen, hOff, sOff, lOff, aOff);
            if (shiftedPen) setGlyphFD(dup, shiftedPen, true);
        }
    } catch (e) { }

    try { doc.executeCommand(DocumentCommand.createMoveNodes(Selection.create(doc, [dup]), fillGroup, NodeMoveType.Inside, NodeChildType.Main)); } catch (e) { }
    placedRects.push(found.corners);
    return rectW * rectH;
}

// ── Main pass ────────────────────────────────────────────────
function performFill(params) {
    const baseName = 'TextFill_' + nextGroupIndex();
    let totalPlaced = 0, totalSkipped = 0, totalFilledArea = 0, totalTargetArea = 0;
    const subGroups = [];
    let shapeIdx = 0;
    for (const shapeNode of targetNodes) {
        shapeIdx++;
        const targetBB = getBB(shapeNode); if (!targetBB) continue;
        const pool = buildPool(params.extractionMode, params.keepSentencePeriod);
        if (pool.length === 0) continue;

        let work = [];
        for (const item of pool) {
            const n = Math.max(1, Math.round(params.repeat * getWeight(item.src)));
            for (let r = 0; r < n; r++) work.push(item);
        }
        const prng = makePRNG((params.seed === 0 ? (Date.now() >>> 0) : params.seed) + shapeIdx * 104729);
        for (let i = work.length - 1; i > 0; i--) { const j = Math.floor(prng() * (i + 1)); [work[i], work[j]] = [work[j], work[i]]; }

        const shapePolys = buildShapePolygons(shapeNode);
        const contourSamples = params.angleDivider === 7 ? buildContourSamples(shapeNode, 6) : null;

        const subGrpDef = ContainerNodeDefinition.create(shapeNode.userDescription || ('Shape' + shapeIdx));
        const subGrpB = AddChildNodesCommandBuilder.create();
        subGrpB.addContainerNode(subGrpDef);
        const subGrpCmd = subGrpB.createCommand(false);
        doc.executeCommand(subGrpCmd);
        const subGroup = subGrpCmd.newNodes[0];
        if (!subGroup) continue;

        const placedRects = [];
        let placed = 0, skipped = 0, filledArea = 0;
        for (const item of work) {
            try {
                const area = placeItem(item, params, prng, shapePolys, targetBB, contourSamples, placedRects, subGroup);
                if (area) { placed++; filledArea += area; } else skipped++;
            }
            catch (e) { console.log('Text Fill error: ' + e); skipped++; }
        }
        try { doc.executeCommand(DocumentCommand.createMoveNodes(subGroup.selfSelection, shapeNode, NodeMoveType.Inside, NodeChildType.Main)); } catch (e) { }
        subGroups.push(subGroup);

        totalPlaced += placed; totalSkipped += skipped; totalFilledArea += filledArea;
        totalTargetArea += targetArea([shapeNode]);
    }

    const pct = totalTargetArea > 0 ? Math.round(totalFilledArea / totalTargetArea * 100) : 0;
    const summary = 'Placed: ' + totalPlaced + '\nSkipped: ' + totalSkipped + '\nCovered area: ~' + pct + '%' +
        (targetNodes.length > 1 ? '\n(' + targetNodes.length + ' shapes filled/clipped separately)' : '');
    console.log('Text Fill v7: ' + summary.replace(/\n/g, ' | ') + ' → "' + baseName + '"');
    return { groups: subGroups, summary };
}

// ── Dialog ───────────────────────────────────────────────────
function buildDialog() {
    const dlg = Dialog.create(TITLE);
    dlg.initialWidth = 900;
    dlg.setIsResizable(true);

    const c1 = dlg.addColumn(); c1.widthProportion = 1.1;
    const gInfo = c1.addGroup('Starting point');
    gInfo.addStaticText('', 'Target: ' + targetNodes.length + (targetNodes.length === 1 ? ' shape' : ' shapes') +
        ' (' + (targetHostNode.userDescription || targetHostNode.defaultDescription || 'Shape') + (targetNodes.length > 1 ? ' etc.' : '') + ')' +
        '   Text sources: ' + textSourceNodes.length);
    gInfo.addStaticText('', 'Base colour (1st text object): H' + Math.round(baseHSL.h) + '° S' + Math.round(baseHSL.s) + '% L' + Math.round(baseHSL.l) + '% O' + Math.round(baseHSL.a) + '%');
    gInfo.addStaticText('', 'Jitter affects fill + stroke, solid + gradient (all stops).');

    const gSize = c1.addGroup('Size & repetition');
    const edVar = gSize.addUnitValueEditor('Text size variance (%)', 'none', 'none', null, 0, 200); edVar.value = 30;
    const edMinPx = gSize.addUnitValueEditor('Min. text height (px, 0=off)', 'none', 'none', null, 0, 10000); edMinPx.value = 0;
    const edMaxPx = gSize.addUnitValueEditor('Max. text height (px, 0=off)', 'none', 'none', null, 0, 10000); edMaxPx.value = 0;
    const edRep = gSize.addUnitValueEditor('Repetitions per text object', 'none', 'none', null, 1, 50); edRep.value = 3;
    const edPad = gSize.addUnitValueEditor('Minimum spacing (px)', 'none', 'none', null, 0, 500); edPad.value = 0;

    const gDir = c1.addGroup('Direction');
    const cbDir = gDir.addComboBox('Divider (180°)', [
        '0 = Random', '1 = Horizontal only', '2 = 90/0/-90', '3 = 90/30/-30/-90',
        '4 = 90/45/0/-45/-90', '5 = 90/54/18/-18/-54/-90', '6 = 90/60/30/0/-30/-60/-90',
        '7 = Tangential to contour']);
    cbDir.selectedIndex = 0;
    const cbEdgeBias = gDir.addComboBox('Fill direction', ['From the centre', 'From the edge inwards']);
    cbEdgeBias.selectedIndex = 0;

    const gExtr = c1.addGroup('Extraction from frame text');
    const cbExtr = gExtr.addComboBox('Mode', ['Words', 'Sentences', 'Both']); cbExtr.selectedIndex = 2;
    const cbKeepPeriod = gExtr.addCheckBox('Keep full stop at sentence end', true);

    const gSeed = c1.addGroup('Random value');
    const edSeed = gSeed.addUnitValueEditor('Seed (0 = time)', 'none', 'none', null, 0, 999999); edSeed.value = 0;
    const btnReseed = gSeed.addButton('Reroll');
    btnReseed.setOnClickHandler(() => { edSeed.value = Math.floor(Math.random() * 999999); });

    const c2 = dlg.addColumn(); c2.widthProportion = 1.0;
    const gH = c2.addGroup('Jitter — Hue (±°, additive)');
    const edHMin = gH.addUnitValueEditor('Min', 'none', 'none', null, -360, 360); edHMin.value = 0;
    const edHMax = gH.addUnitValueEditor('Max', 'none', 'none', null, -360, 360); edHMax.value = 0;
    const edHSteps = gH.addUnitValueEditor('Steps', 'none', 'none', null, 1, 72); edHSteps.value = 1;

    const gS = c2.addGroup('Jitter — Saturation (±%, additive)');
    const edSMin = gS.addUnitValueEditor('Min', 'none', 'none', null, -100, 100); edSMin.value = 0;
    const edSMax = gS.addUnitValueEditor('Max', 'none', 'none', null, -100, 100); edSMax.value = 0;
    const edSSteps = gS.addUnitValueEditor('Steps', 'none', 'none', null, 1, 50); edSSteps.value = 1;

    const gL = c2.addGroup('Jitter — Lightness (±%, additive)');
    const edLMin = gL.addUnitValueEditor('Min', 'none', 'none', null, -100, 100); edLMin.value = 0;
    const edLMax = gL.addUnitValueEditor('Max', 'none', 'none', null, -100, 100); edLMax.value = 0;
    const edLSteps = gL.addUnitValueEditor('Steps', 'none', 'none', null, 1, 50); edLSteps.value = 1;

    const gA = c2.addGroup('Jitter — Opacity (±%, additive)');
    const edAMin = gA.addUnitValueEditor('Min', 'none', 'none', null, -100, 100); edAMin.value = 0;
    const edAMax = gA.addUnitValueEditor('Max', 'none', 'none', null, -100, 100); edAMax.value = 0;
    const edASteps = gA.addUnitValueEditor('Steps', 'none', 'none', null, 1, 50); edASteps.value = 1;

    const c3 = dlg.addColumn(); c3.widthProportion = 0.8;
    const gAct = c3.addGroup('Action');
    const btnPreview = gAct.addButton('Preview');
    const gStatus = c3.addGroup('Fill level');
    const tbStatus = gStatus.addTextBox('', 'No preview created yet.');
    tbStatus.setIsMultiLine(true);
    tbStatus.setRowSpan(4);
    const gPreset = c3.addGroup('Preset');
    const btnSave = gPreset.addButton('Save');
    const btnLoad = gPreset.addButton('Load');
    const btnDelete = gPreset.addButton('Delete');

    function readParams() {
        return {
            sizeVariance: Math.max(0, edVar.value || 0),
            minSizePx: Math.max(0, edMinPx.value || 0),
            maxSizePx: Math.max(0, edMaxPx.value || 0),
            padding: Math.max(0, edPad.value || 0),
            repeat: Math.max(1, Math.round(edRep.value || 1)),
            angleDivider: cbDir.selectedIndex,
            edgeBias: cbEdgeBias.selectedIndex === 1,
            keepSentencePeriod: cbKeepPeriod.value,
            extractionMode: cbExtr.selectedIndex,
            seed: Math.round(edSeed.value || 0),
            hMin: edHMin.value, hMax: edHMax.value, hSteps: Math.max(1, Math.round(edHSteps.value || 1)),
            sMin: edSMin.value, sMax: edSMax.value, sSteps: Math.max(1, Math.round(edSSteps.value || 1)),
            lMin: edLMin.value, lMax: edLMax.value, lSteps: Math.max(1, Math.round(edLSteps.value || 1)),
            aMin: edAMin.value, aMax: edAMax.value, aSteps: Math.max(1, Math.round(edASteps.value || 1)),
        };
    }
    function collectParams() { return readParams(); }
    function applyParams(p) {
        if (p.sizeVariance != null) edVar.value = p.sizeVariance;
        if (p.minSizePx != null) edMinPx.value = p.minSizePx;
        if (p.maxSizePx != null) edMaxPx.value = p.maxSizePx;
        if (p.padding != null) edPad.value = p.padding;
        if (p.repeat != null) edRep.value = p.repeat;
        if (p.angleDivider != null) cbDir.selectedIndex = p.angleDivider;
        if (p.edgeBias != null) cbEdgeBias.selectedIndex = p.edgeBias ? 1 : 0;
        if (p.keepSentencePeriod != null) cbKeepPeriod.value = p.keepSentencePeriod;
        if (p.extractionMode != null) cbExtr.selectedIndex = p.extractionMode;
        if (p.seed != null) edSeed.value = p.seed;
        if (p.hMin != null) edHMin.value = p.hMin; if (p.hMax != null) edHMax.value = p.hMax; if (p.hSteps != null) edHSteps.value = p.hSteps;
        if (p.sMin != null) edSMin.value = p.sMin; if (p.sMax != null) edSMax.value = p.sMax; if (p.sSteps != null) edSSteps.value = p.sSteps;
        if (p.lMin != null) edLMin.value = p.lMin; if (p.lMax != null) edLMax.value = p.lMax; if (p.lSteps != null) edLSteps.value = p.lSteps;
        if (p.aMin != null) edAMin.value = p.aMin; if (p.aMax != null) edAMax.value = p.aMax; if (p.aSteps != null) edASteps.value = p.aSteps;
    }

    const PRESET_PREFIX = 'TF_';
    function getPresetDir() {
        const dir = app.userDesktopPath + '/AffinityScriptPresets';
        try { if (!FileSystemApi.exists(dir)) FileSystemApi.createDirectories(dir); } catch (e) { try { FileSystemApi.createDirectories(dir); } catch (e2) { } }
        return dir;
    }
    function savePreset() {
        try {
            const dir = getPresetDir();
            const nameIn = app.prompt('Enter preset name (prefix ' + PRESET_PREFIX + ' is added):', 'Save preset', '');
            if (!nameIn || !nameIn.trim()) return;
            let base = nameIn.trim();
            if (base.toUpperCase().startsWith(PRESET_PREFIX.toUpperCase())) base = base.substring(PRESET_PREFIX.length);
            const path = dir + '/' + PRESET_PREFIX + base + '.json';
            const f = File.create(path, 'wb'); f.writeStringAsUtf8(JSON.stringify(collectParams(), null, 2)); f.close();
            app.alert('Preset saved:\n' + path, TITLE);
        } catch (e) { app.alert('Error while saving:\n' + e.message, TITLE); }
    }
    function loadPreset() {
        try {
            getPresetDir();
            const path = app.chooseFile(); if (!path) return false;
            let buf; try { buf = File.readAll(path); } catch (e) { app.alert('File not readable.', TITLE); return false; }
            applyParams(JSON.parse(buf.toString('utf8'))); return true;
        } catch (e) { app.alert('Error while loading:\n' + e.message, TITLE); return false; }
    }
    function deletePreset() {
        try {
            getPresetDir();
            const path = app.chooseFile(); if (!path) return;
            if (!/\.json$/i.test(path)) { app.alert('Only .json preset files can be deleted.', TITLE); return; }
            FileSystemApi.remove(path);
            app.alert('Preset deleted:\n' + path, TITLE);
        } catch (e) { app.alert('Error while deleting:\n' + e.message, TITLE); }
    }

    let previewResult = null;
    let previewKey = null;   // v7: settings of the last shown preview
    function cleanupPreview() {
        if (previewResult) { for (const g of previewResult.groups) deleteGroupFully(g); }
        previewResult = null;
        previewKey = null;
    }
    btnPreview.setOnClickHandler(() => {
        cleanupPreview();
        const p = readParams();
        previewResult = performFill(p);
        previewKey = previewResult ? JSON.stringify(p) : null;
        tbStatus.text = previewResult ? previewResult.summary : 'No text placed — check selection/parameters.';
    });
    btnSave.setOnClickHandler(() => { savePreset(); });
    btnLoad.setOnClickHandler(() => { loadPreset(); });
    btnDelete.setOnClickHandler(() => { deletePreset(); });

    return {
        dlg, readParams, cleanupPreview,
        isPreviewCurrent: (p) => !!previewResult && previewKey === JSON.stringify(p)
    };
}

// ── Run dialog (Blur Shadow concept: 1x runModal) ────────────
const { dlg, readParams, cleanupPreview, isPreviewCurrent } = buildDialog();
const result = dlg.runModal();
if (result && result.value === DialogResult.Ok.value) {
    const p = readParams();
    // v7: keep the preview only if the settings have not changed since
    if (!isPreviewCurrent(p)) {
        cleanupPreview();
        performFill(p);
    }
} else {
    cleanupPreview();
}
