'use strict';
const { Document } = require('/document');
const { DocumentCommand, NodeChildType, NodeMoveType, AddChildNodesCommandBuilder } = require('/commands');
const { ContainerNodeDefinition, PolyCurveNodeDefinition, ShapeNodeDefinition } = require('/nodes');
const { ShapeRectangle } = require('/shapes');
const { Selection } = require('/selections');
const { DocumentCommandApi } = require('affinity:commands');
const { Dialog, DialogResult } = require('/dialog');
const { UnitType } = require('/units');
const { app } = require('/application');
const { RGBA8 } = require('/colours');
const { CurveBuilder, PolyCurve, Transform } = require('/geometry');
const { FillDescriptor } = require('/fills');
const { LineStyleDescriptor, StrokeAlignment } = require('/linestyle');
const { setTimeout: sdkSetTimeout } = require('/timers');

function sleep(ms) {
    return new Promise(function (resolve) { sdkSetTimeout(ms, function () { resolve(); }); });
}

const MASK_PREFIX = '_VF';
const RESULT_PREFIX = 'Weave_';
const GAUSSIAN_EXTENT_FACTOR = 1.5;
const PREVIEW_CROSSING_LIMIT = 20;
const SAFE_CROSSING_LIMIT = 40;
const THROTTLE_MS = 25;
const DEFAULT_GRID_BATCH_SIZE = 20;
const DEFAULT_GRID_BATCH_PAUSE_SEC = 12;
const DEFAULT_GRID_MATRIX = [[1, 0], [0, 1]];

function bb(n) {
    const b = n.getSpreadBaseBox(false);
    return b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null;
}
function unionBB(list) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of list) {
        const b = bb(n);
        if (!b) continue;
        minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
    }
    if (!isFinite(minX)) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
function boxesOverlap(a, b) {
    return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}
function zIndexOf(node) {
    const parent = node.parent;
    if (!parent) return -1;
    let i = 0;
    for (const ch of parent.children) {
        if (ch.isSameNode(node)) return i;
        i++;
    }
    return -1;
}
function isMaskNamed(n) {
    return (n.description || '').indexOf(MASK_PREFIX) === 0;
}
function isResultNamed(n) {
    return (n.description || '').indexOf(RESULT_PREFIX) === 0;
}

function clearSelection(doc) {
    try {
        doc.executeCommand(DocumentCommand.createSetSelection(Selection.create(doc, [])), false);
    } catch (err) { /* if this fails, just continue */ }
}

function resolveShapesAndMasks(selNodes) {
    const shapes = [];
    const masks = [];
    for (const n of selNodes) {
        if (isMaskNamed(n)) {
            let hadChildren = false;
            if (n.children) {
                for (const ch of n.children) { masks.push(ch); hadChildren = true; }
            }
            if (!hadChildren) masks.push(n);
            continue;
        }
        let hadChildren = false;
        if (n.children) {
            for (const ch of n.children) { shapes.push(ch); hadChildren = true; }
        }
        if (!hadChildren) shapes.push(n);
    }
    return { shapes: shapes, masks: masks };
}

function flattenSelectionOneLevel(selNodes) {
    const flat = [];
    for (const n of selNodes) {
        let hadChildren = false;
        if (n.children) {
            for (const ch of n.children) { flat.push(ch); hadChildren = true; }
        }
        if (!hadChildren) flat.push(n);
    }
    return flat;
}

function sortBySpatialOrder(shapes) {
    const boxes = shapes.map(s => ({ s: s, b: bb(s) }));
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const o of boxes) {
        minX = Math.min(minX, o.b.x); maxX = Math.max(maxX, o.b.x + o.b.w);
        minY = Math.min(minY, o.b.y); maxY = Math.max(maxY, o.b.y + o.b.h);
    }
    const horizontal = (maxX - minX) >= (maxY - minY);
    boxes.sort((a, b) => horizontal ? (a.b.x + a.b.w / 2) - (b.b.x + b.b.w / 2) : (a.b.y + a.b.h / 2) - (b.b.y + b.b.h / 2));
    return boxes.map(o => o.s);
}
function classifyOrientation(shapes) {
    const horiz = [], vert = [];
    for (const s of shapes) {
        const b = bb(s);
        if (b.w >= b.h) horiz.push(s); else vert.push(s);
    }
    return { horiz: horiz, vert: vert };
}
function sortByAxis(shapes, axis) {
    return shapes.slice().sort(function (a, b) {
        const ba = bb(a), bb2 = bb(b);
        const ca = axis === 'x' ? ba.x + ba.w / 2 : ba.y + ba.h / 2;
        const cb = axis === 'x' ? bb2.x + bb2.w / 2 : bb2.y + bb2.h / 2;
        return ca - cb;
    });
}

function assignRolesManual(shapes, masks) {
    const dipMap = new Map();
    const usedMasks = [];
    let skipped = 0;
    for (const mask of masks) {
        const mbb = bb(mask);
        const overlapping = shapes.filter(s => boxesOverlap(bb(s), mbb));
        if (overlapping.length < 2) { skipped++; continue; }
        overlapping.sort((a, b) => zIndexOf(a) - zIndexOf(b));
        const B = overlapping[overlapping.length - 2];
        const A = overlapping[overlapping.length - 1];
        if (!dipMap.has(A)) dipMap.set(A, []);
        dipMap.get(A).push({ mask: mask, target: B });
        usedMasks.push(mask);
    }
    return { dipMap: dipMap, usedMasks: usedMasks, skipped: skipped };
}

function parseWeaveMatrix(text) {
    if (!text || !text.trim()) return null;
    const rowMatches = text.match(/\(([^)]*)\)/g);
    if (!rowMatches || rowMatches.length === 0) return null;
    const rows = rowMatches.map(function (rowStr) {
        const inner = rowStr.slice(1, -1);
        return inner.split(',').map(function (tok) { return parseInt(tok.trim(), 10) === 1 ? 1 : 0; });
    });
    const width = rows[0].length;
    if (width === 0) return null;
    for (const r of rows) { if (r.length !== width) return null; }
    return rows;
}
function parseFlatPattern(text) {
    if (!text || !text.trim()) return null;
    const cleaned = text.trim().replace(/^\(/, '').replace(/\)$/, '');
    const parts = cleaned.split(',').map(function (tok) { return parseInt(tok.trim(), 10) === 1 ? 1 : 0; });
    if (parts.length === 0) return null;
    return parts;
}
function parsePositiveInt(text, fallback) {
    if (!text || !text.trim()) return fallback;
    const n = parseInt(text.trim(), 10);
    if (!isFinite(n) || n <= 0) return fallback;
    return n;
}

function previewCounts(shapes, masks) {
    const manual = masks.length > 0 ? (function () {
        const r = assignRolesManual(shapes, masks);
        let total = 0;
        for (const entries of r.dipMap.values()) total += entries.length;
        return total;
    })() : 0;
    const chain = shapes.length >= 2 ? shapes.length - 1 : 0;
    let zorder = 0;
    for (let i = 0; i < shapes.length; i++) {
        for (let j = i + 1; j < shapes.length; j++) {
            if (boxesOverlap(bb(shapes[i]), bb(shapes[j]))) zorder++;
        }
    }
    const orient = classifyOrientation(shapes);
    let grid = 0;
    if (orient.horiz.length > 0 && orient.vert.length > 0) {
        for (const h of orient.horiz) for (const v of orient.vert) if (boxesOverlap(bb(h), bb(v))) grid++;
    }
    return { manual: manual, chain: chain, zorder: zorder, grid: grid, gridAvailable: orient.horiz.length > 0 && orient.vert.length > 0 };
}

function getRawTransformArray(node) {
    return Array.from(node.transform.data || node.transform);
}
function composeTransformArrays(parentArr, childArr) {
    const a1 = parentArr[0], b1 = parentArr[1], tx1 = parentArr[2], c1 = parentArr[3], d1 = parentArr[4], ty1 = parentArr[5];
    const a2 = childArr[0], b2 = childArr[1], tx2 = childArr[2], c2 = childArr[3], d2 = childArr[4], ty2 = childArr[5];
    return [
        a1 * a2 + b1 * c2, a1 * b2 + b1 * d2, a1 * tx2 + b1 * ty2 + tx1,
        c1 * a2 + d1 * c2, c1 * b2 + d1 * d2, c1 * tx2 + d1 * ty2 + ty1
    ];
}
function getTransformArray(node) {
    let composed = getRawTransformArray(node);
    let current = node.parent;
    while (current && current.transform) {
        composed = composeTransformArrays(getRawTransformArray(current), composed);
        current = current.parent;
    }
    return composed;
}
function localToSpread(pt, tf) {
    return { x: tf[0] * pt.x + tf[1] * pt.y + tf[2], y: tf[3] * pt.x + tf[4] * pt.y + tf[5] };
}

function chordNormal(p0, p1, cx, cy) {
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    let nx = -dy / len, ny = dx / len;
    const midx = (p0.x + p1.x) / 2, midy = (p0.y + p1.y) / 2;
    if (nx * (midx - cx) + ny * (midy - cy) < 0) { nx = -nx; ny = -ny; }
    return { nx: nx, ny: ny };
}
function lineIntersect(p0, d0, p1, d1) {
    const denom = d0.x * d1.y - d0.y * d1.x;
    if (Math.abs(denom) < 1e-9) return null;
    const t = ((p1.x - p0.x) * d1.y - (p1.y - p0.y) * d1.x) / denom;
    return { x: p0.x + t * d0.x, y: p0.y + t * d0.y };
}
function marginAt(marginSpec, nx, ny) {
    if (typeof marginSpec === 'number') return marginSpec;
    let m = marginSpec.isotropic + (marginSpec.fxRadius || 0);
    m += (marginSpec.offsetX || 0) * nx + (marginSpec.offsetY || 0) * ny;
    return Math.max(m, marginSpec.isotropic);
}
function marginMax(marginSpec) {
    if (typeof marginSpec === 'number') return marginSpec;
    const offMag = Math.hypot(marginSpec.offsetX || 0, marginSpec.offsetY || 0);
    return marginSpec.isotropic + (marginSpec.fxRadius || 0) + offMag;
}
function offsetSubCurveSpread(beziers, marginSpec, invertDirection) {
    const n = beziers.length;
    if (n < 2) throw new Error('too few segments for miter offset');
    const sign = invertDirection ? -1 : 1;
    const anchors = beziers.map(bz => bz.start);
    let cx = 0, cy = 0;
    for (const p of anchors) { cx += p.x; cy += p.y; }
    cx /= n; cy /= n;
    const normals = [];
    for (let i = 0; i < n; i++) {
        const nrm = chordNormal(beziers[i].start, beziers[i].end, cx, cy);
        if (!isFinite(nrm.nx) || !isFinite(nrm.ny)) throw new Error('degenerate normal');
        const nx = nrm.nx * sign, ny = nrm.ny * sign;
        normals.push({ nx: nx, ny: ny, m: marginAt(marginSpec, nx, ny) });
    }
    const newAnchors = [];
    for (let i = 0; i < n; i++) {
        const prev = (i - 1 + n) % n;
        const nPrev = normals[prev], nCur = normals[i];
        const p = anchors[i];
        const offPrev = { x: p.x + nPrev.nx * nPrev.m, y: p.y + nPrev.ny * nPrev.m };
        const dPrev = { x: beziers[prev].end.x - beziers[prev].start.x, y: beziers[prev].end.y - beziers[prev].start.y };
        const offCur = { x: p.x + nCur.nx * nCur.m, y: p.y + nCur.ny * nCur.m };
        const dCur = { x: beziers[i].end.x - beziers[i].start.x, y: beziers[i].end.y - beziers[i].start.y };
        const avgM = (nPrev.m + nCur.m) / 2;
        let ip = lineIntersect(offPrev, dPrev, offCur, dCur);
        if (!ip) {
            const anx = (nPrev.nx + nCur.nx) / 2, any = (nPrev.ny + nCur.ny) / 2;
            const len = Math.sqrt(anx * anx + any * any) || 1;
            ip = { x: p.x + (anx / len) * avgM, y: p.y + (any / len) * avgM };
        }
        const dist = Math.hypot(ip.x - p.x, ip.y - p.y);
        if (!isFinite(dist) || dist > avgM * 4 + 0.01) {
            const anx = (nPrev.nx + nCur.nx) / 2, any = (nPrev.ny + nCur.ny) / 2;
            const len = Math.sqrt(anx * anx + any * any) || 1;
            ip = { x: p.x + (anx / len) * avgM, y: p.y + (any / len) * avgM };
        }
        if (!isFinite(ip.x) || !isFinite(ip.y)) throw new Error('invalid miter point');
        newAnchors.push(ip);
    }
    const cb = CurveBuilder.create();
    cb.beginXY(newAnchors[0].x, newAnchors[0].y);
    for (let i = 0; i < n; i++) {
        const bz = beziers[i];
        const nrm = normals[i];
        const newC1 = { x: bz.c1.x + nrm.nx * nrm.m, y: bz.c1.y + nrm.ny * nrm.m };
        const newC2 = { x: bz.c2.x + nrm.nx * nrm.m, y: bz.c2.y + nrm.ny * nrm.m };
        const newEnd = newAnchors[(i + 1) % n];
        cb.addBezier(newC1, newC2, newEnd);
    }
    cb.close();
    return cb.createCurve();
}
function copySubCurveSpread(beziers) {
    const cb = CurveBuilder.create();
    cb.beginXY(beziers[0].start.x, beziers[0].start.y);
    for (const bz of beziers) {
        cb.addBezier(bz.c1, bz.c2, bz.end);
    }
    cb.close();
    return cb.createCurve();
}
function subPathArea(beziers) {
    let area = 0;
    const pts = beziers.map(bz => bz.start);
    for (let i = 0; i < pts.length; i++) {
        const p1 = pts[i], p2 = pts[(i + 1) % pts.length];
        area += p1.x * p2.y - p2.x * p1.y;
    }
    return Math.abs(area) / 2;
}
function subPathBBox(beziers) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const bz of beziers) {
        for (const p of [bz.start, bz.c1, bz.c2, bz.end]) {
            if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
        }
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
function classifySubPaths(subPaths) {
    const boxes = subPaths.map(sp => subPathBBox(sp));
    const isHole = boxes.map(() => false);
    for (let i = 0; i < boxes.length; i++) {
        for (let j = 0; j < boxes.length; j++) {
            if (i === j) continue;
            const inner = boxes[i], outer = boxes[j];
            const contained = inner.x >= outer.x - 0.01 && inner.y >= outer.y - 0.01 &&
                (inner.x + inner.w) <= (outer.x + outer.w) + 0.01 &&
                (inner.y + inner.h) <= (outer.y + outer.h) + 0.01;
            if (contained) { isHole[i] = true; break; }
        }
    }
    return isHole;
}
function getSpreadSubPaths(shape) {
    const tf = getTransformArray(shape);
    const srcPC = shape.curvesInterface.polyCurve;
    const subPaths = [];
    for (let i = 0; i < srcPC.curveCount; i++) {
        const localBeziers = srcPC.at(i).beziers.toArray();
        subPaths.push(localBeziers.map(bz => ({
            start: localToSpread(bz.start, tf),
            c1: localToSpread(bz.c1, tf),
            c2: localToSpread(bz.c2, tf),
            end: localToSpread(bz.end, tf)
        })));
    }
    return subPaths;
}
function buildPolyCurveNode(doc, resultPC, referenceNode) {
    const def = PolyCurveNodeDefinition.create(
        resultPC,
        FillDescriptor.createSolid(RGBA8(255, 255, 255, 255)),
        FillDescriptor.createNone(),
        LineStyleDescriptor.createDefault(1),
        FillDescriptor.createNone()
    );
    const abldr = AddChildNodesCommandBuilder.create();
    abldr.addPolyCurveNode(def);
    const acmd = abldr.createCommand(true, NodeChildType.Main);
    doc.executeCommand(acmd);
    const newNode = acmd.newNodes[0];
    if (referenceNode) {
        doc.executeCommand(DocumentCommand.createMoveNodes(Selection.create(doc, [newNode]), referenceNode, NodeMoveType.After, NodeChildType.Main));
    }
    return newNode;
}

function getFxDirectionalInfo(node) {
    if (!node.layerEffectsInterface || !node.layerEffectsInterface.hasActiveEffects) return null;
    const count = node.layerEffectsInterface.effectCount;
    let best = null, bestReach = -1;
    for (let i = 0; i < count; i++) {
        try {
            const eff = node.layerEffectsInterface.getEffect(i);
            if (eff.enabled === false) continue;
            if (eff.isOuterShadowLayerEffect) {
                const r = eff.radius * GAUSSIAN_EXTENT_FACTOR;
                const off = eff.offset || 0;
                const ang = eff.angle || 0;
                const reach = r + Math.abs(off);
                if (reach > bestReach) { bestReach = reach; best = { fxRadius: r, offsetX: off * Math.cos(ang), offsetY: off * Math.sin(ang) }; }
            } else if (eff.isOuterGlowLayerEffect) {
                const r = eff.radius * GAUSSIAN_EXTENT_FACTOR;
                if (r > bestReach) { bestReach = r; best = { fxRadius: r, offsetX: 0, offsetY: 0 }; }
            }
        } catch (err) { /* ignore unknown effect type */ }
    }
    return best;
}
function getFxMargin(node) {
    const info = getFxDirectionalInfo(node);
    let margin = info ? (info.fxRadius + Math.hypot(info.offsetX, info.offsetY)) : 0;
    if (node.layerEffectsInterface && node.layerEffectsInterface.hasActiveEffects) {
        const count = node.layerEffectsInterface.effectCount;
        for (let i = 0; i < count; i++) {
            try {
                const eff = node.layerEffectsInterface.getEffect(i);
                if (eff.enabled === false) continue;
                if (eff.isOutlineLayerEffect) margin = Math.max(margin, eff.radius);
            } catch (err) { /* ignore */ }
        }
    }
    return margin;
}

function makeHelpers(doc) {
    function duplicate(node) {
        doc.executeCommand(DocumentCommand.createTransform(Selection.create(doc, [node]), null, { duplicateNodes: true }));
        return doc.selection.nodes.toArray()[0];
    }
    function moveAfter(node, target) {
        doc.executeCommand(DocumentCommand.createMoveNodes(Selection.create(doc, [node]), target, NodeMoveType.After, NodeChildType.Main));
    }
    function moveBefore(node, target) {
        doc.executeCommand(DocumentCommand.createMoveNodes(Selection.create(doc, [node]), target, NodeMoveType.Before, NodeChildType.Main));
    }
    function boolIntersect(nodes) {
        doc.executeCommand(new DocumentCommand(DocumentCommandApi.createBoolOpIntersectCommand(Selection.create(doc, nodes).handle)));
        const r = doc.selection.nodes.toArray();
        return r.length ? r[0] : null;
    }
    function boolSubtract(base, sub) {
        moveAfter(sub, base);
        doc.executeCommand(new DocumentCommand(DocumentCommandApi.createBoolOpSubtractCommand(Selection.create(doc, [base, sub]).handle)));
        const r = doc.selection.nodes.toArray();
        return r.length ? r[0] : null;
    }
    function boolUnion(nodes) {
        doc.executeCommand(new DocumentCommand(DocumentCommandApi.createBoolOpUnionCommand(Selection.create(doc, nodes).handle)));
        const r = doc.selection.nodes.toArray();
        return r.length ? r[0] : null;
    }
    function duplicateMaskNear(mask, referenceNode) {
        const dup = duplicate(mask);
        moveAfter(dup, referenceNode);
        return dup;
    }
    function getStrokeOnlyMargin(node) {
        if (!node.hasPenFill) return 0;
        const lsi = node.lineStyleInterface;
        if (!lsi || lsi.isNoFill) return 0;
        const w = lsi.lineWeight;
        const align = lsi.strokeAlignment;
        if (align.value === StrokeAlignment.Outside.value) return w;
        if (align.value === StrokeAlignment.Centre.value) return w / 2;
        return 0;
    }
    function getOutwardStrokeMargin(node) {
        return getStrokeOnlyMargin(node) + getFxMargin(node);
    }
    function growShapeFallback(shape, marginSpec, N) {
        N = N || 8;
        const m = marginMax(marginSpec);
        const copies = [];
        for (let i = 0; i < N; i++) {
            const angle = (2 * Math.PI * i) / N;
            const dx = m * Math.cos(angle);
            const dy = m * Math.sin(angle);
            const dup = duplicate(shape);
            doc.executeCommand(DocumentCommand.createTransform(Selection.create(doc, [dup]), Transform.createTranslate(dx, dy)));
            copies.push(dup);
        }
        copies.push(shape);
        return boolUnion(copies);
    }
    function growShape(shape, marginSpec) {
        const maxM = marginMax(marginSpec);
        if (!(maxM > 0.01)) return { shape: shape, alreadyWhite: false };
        try {
            const subPaths = getSpreadSubPaths(shape);
            if (subPaths.length === 0) throw new Error('no sub-paths');
            const isHole = classifySubPaths(subPaths);
            const resultPC = new PolyCurve();
            for (let i = 0; i < subPaths.length; i++) {
                if (!isHole[i]) resultPC.addCurve(offsetSubCurveSpread(subPaths[i], marginSpec, false));
                else resultPC.addCurve(copySubCurveSpread(subPaths[i]));
            }
            const newNode = buildPolyCurveNode(doc, resultPC, shape);
            doc.executeCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, [shape])));
            return { shape: newNode, alreadyWhite: true };
        } catch (err) {
            try {
                const fb = growShapeFallback(shape, marginSpec);
                return { shape: fb || shape, alreadyWhite: false };
            } catch (err2) {
                return { shape: shape, alreadyWhite: false };
            }
        }
    }
    function growShapeAllContours(shape, marginPx) {
        if (!(marginPx > 0.01)) return shape;
        try {
            const subPaths = getSpreadSubPaths(shape);
            if (subPaths.length === 0) throw new Error('no sub-paths');
            const isHole = classifySubPaths(subPaths);
            const resultPC = new PolyCurve();
            for (let i = 0; i < subPaths.length; i++) {
                resultPC.addCurve(offsetSubCurveSpread(subPaths[i], marginPx, isHole[i]));
            }
            const newNode = buildPolyCurveNode(doc, resultPC, shape);
            doc.executeCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, [shape])));
            return newNode;
        } catch (err) {
            return shape;
        }
    }
    function splitLoops(shape) {
        const subPaths = getSpreadSubPaths(shape);
        const results = [];
        for (const sp of subPaths) {
            results.push(buildNodeFromSpreadCurveHelper(sp, shape));
        }
        doc.executeCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, [shape])));
        results.sort(function (a, b) {
            const ba = bb(a), bbn = bb(b);
            const cya = ba.y + ba.h / 2, cyb = bbn.y + bbn.h / 2;
            if (Math.abs(cya - cyb) > 0.01) return cya - cyb;
            return (ba.x + ba.w / 2) - (bbn.x + bbn.w / 2);
        });
        return results;
    }
    function buildNodeFromSpreadCurveHelper(beziers, referenceNode) {
        const cb = CurveBuilder.create();
        cb.beginXY(beziers[0].start.x, beziers[0].start.y);
        for (const bz of beziers) cb.addBezier(bz.c1, bz.c2, bz.end);
        cb.close();
        const pc = new PolyCurve();
        pc.addCurve(cb.createCurve());
        return buildPolyCurveNode(doc, pc, referenceNode);
    }
    function computeCrossingShape(A, B, M, maskUsage) {
        if (M && maskUsage === 'direct') {
            const dupA = duplicate(A);
            const dupM = duplicateMaskNear(M, dupA);
            return boolIntersect([dupA, dupM]);
        }
        const dupA = duplicate(A);
        const dupB = duplicate(B);
        const overlapAB = boolIntersect([dupA, dupB]);
        if (!overlapAB) return null;
        if (!M) return overlapAB;
        const dupM = duplicateMaskNear(M, overlapAB);
        return boolIntersect([overlapAB, dupM]);
    }
    function buildMarginSpec(A, B, safetyMarginPx) {
        const isotropic = getStrokeOnlyMargin(A) + getStrokeOnlyMargin(B) + safetyMarginPx;
        const fxInfo = getFxDirectionalInfo(A);
        if (!fxInfo) return isotropic;
        return { isotropic: isotropic, fxRadius: fxInfo.fxRadius, offsetX: fxInfo.offsetX, offsetY: fxInfo.offsetY };
    }
    function computeCrossingShapeForHoleStrokeOnly(A, B, M, safetyMarginPx, maskUsage) {
        const baseCrossing = computeCrossingShape(A, B, M, maskUsage);
        if (!baseCrossing) return null;
        const safe = (typeof safetyMarginPx === 'number' && isFinite(safetyMarginPx)) ? safetyMarginPx : 0;
        const totalMargin = getStrokeOnlyMargin(A) + getStrokeOnlyMargin(B) + safe;
        return growShape(baseCrossing, totalMargin);
    }
    function computeCrossingShapeForHole(A, B, M, safetyMarginPx, maskUsage) {
        const baseCrossing = computeCrossingShape(A, B, M, maskUsage);
        if (!baseCrossing) return null;
        const safe = (typeof safetyMarginPx === 'number' && isFinite(safetyMarginPx)) ? safetyMarginPx : 0;
        const marginSpec = buildMarginSpec(A, B, safe);
        return growShape(baseCrossing, marginSpec);
    }
    function buildFittedRect(refShapes, extraPad) {
        const box = unionBB(refShapes);
        const pad = Math.max(extraPad || 0, 20, box.w * 0.15, box.h * 0.15);
        const bldr = AddChildNodesCommandBuilder.create();
        const def = ShapeNodeDefinition.create(ShapeRectangle.create(), {
            x: box.x - pad, y: box.y - pad, width: box.w + 2 * pad, height: box.h + 2 * pad
        });
        bldr.addShapeNode(def);
        const cmd = bldr.createCommand(true, NodeChildType.Main);
        doc.executeCommand(cmd);
        const rect = cmd.newNodes[0];
        doc.executeCommand(DocumentCommand.createMoveNodes(Selection.create(doc, [rect]), refShapes[0], NodeMoveType.After, NodeChildType.Main));
        return rect;
    }
    return {
        duplicate: duplicate, moveAfter: moveAfter, moveBefore: moveBefore,
        boolIntersect: boolIntersect, boolSubtract: boolSubtract, boolUnion: boolUnion,
        duplicateMaskNear: duplicateMaskNear, computeCrossingShape: computeCrossingShape,
        computeCrossingShapeForHole: computeCrossingShapeForHole,
        computeCrossingShapeForHoleStrokeOnly: computeCrossingShapeForHoleStrokeOnly, splitLoops: splitLoops,
        growShape: growShape, growShapeAllContours: growShapeAllContours,
        getOutwardStrokeMargin: getOutwardStrokeMargin, getStrokeOnlyMargin: getStrokeOnlyMargin,
        buildFittedRect: buildFittedRect, buildMarginSpec: buildMarginSpec, marginMax: marginMax
    };
}

async function buildAutoDipMap(doc, h, shapes, mode, spotStrategy, weaveStyle, weaveMatrix, flatPattern) {
    const dipMap = new Map();
    const usedMasks = [];
    let skipped = 0;
    let patternPos = 0;
    let spotCrossingIdx = 0;

    function addSingle(dipper, target, overlap) {
        if (!dipMap.has(dipper)) dipMap.set(dipper, []);
        dipMap.get(dipper).push({ mask: overlap, target: target });
        usedMasks.push(overlap);
    }

    function resolveSpotInvert(chainMode) {
        if (chainMode) {
            if (spotStrategy === 'standard') return false;
            if (spotStrategy === 'invert') return true;
            const evenIsStandard = spotStrategy === 'alternate';
            const isEven = spotCrossingIdx % 2 === 0;
            return isEven ? !evenIsStandard : evenIsStandard;
        }
        return spotStrategy !== 'standard';
    }

    async function tryAddPair(candA, candB, chainMode) {
        const overlap = h.computeCrossingShape(candA, candB, null);
        if (!overlap) { skipped++; return; }
        const loops = h.splitLoops(overlap);
        if (weaveStyle === 'flat') {
            const holeUnion = loops.length === 1 ? loops[0] : h.boolUnion(loops);
            if (!holeUnion) { skipped++; return; }
            addSingle(candA, candB, holeUnion);
            await sleep(THROTTLE_MS);
            return;
        }
        const localInvert = resolveSpotInvert(chainMode);
        const chosenIdx = localInvert ? loops.length - 1 : 0;
        loops.forEach(function (loop, idx) {
            if (idx === chosenIdx) {
                addSingle(candA, candB, loop);
            } else {
                doc.executeCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, [loop])));
            }
        });
        spotCrossingIdx++;
        await sleep(THROTTLE_MS);
    }

    if (mode === 'chain') {
        const ordered = sortBySpatialOrder(shapes);
        for (let i = 0; i < ordered.length - 1; i++) {
            const a = ordered[i], b = ordered[i + 1];
            if (!boxesOverlap(bb(a), bb(b))) continue;
            if (flatPattern) {
                const cell = flatPattern[patternPos % flatPattern.length];
                patternPos++;
                if (cell !== 1) continue;
            }
            const za = zIndexOf(a), zb = zIndexOf(b);
            const aOnTop = za > zb;
            const dipper = aOnTop ? a : b;
            const target = aOnTop ? b : a;
            await tryAddPair(dipper, target, true);
        }
    } else if (mode === 'grid') {
        const orient = classifyOrientation(shapes);
        const rows = sortByAxis(orient.horiz, 'y');
        const cols = sortByAxis(orient.vert, 'x');
        const effectiveMatrix = weaveMatrix || (flatPattern ? null : DEFAULT_GRID_MATRIX);
        for (let i = 0; i < rows.length; i++) {
            for (let j = 0; j < cols.length; j++) {
                if (!boxesOverlap(bb(rows[i]), bb(cols[j]))) continue;
                if (effectiveMatrix) {
                    const cell = effectiveMatrix[i % effectiveMatrix.length][j % effectiveMatrix[0].length];
                    if (cell !== 1) continue;
                } else if (flatPattern) {
                    const cellF = flatPattern[patternPos % flatPattern.length];
                    patternPos++;
                    if (cellF !== 1) continue;
                }
                const zr = zIndexOf(rows[i]), zc = zIndexOf(cols[j]);
                const rowOnTop = zr > zc;
                const dipper = rowOnTop ? rows[i] : cols[j];
                const target = rowOnTop ? cols[j] : rows[i];
                await tryAddPair(dipper, target, false);
            }
        }
    } else {
        for (let i = 0; i < shapes.length; i++) {
            for (let j = i + 1; j < shapes.length; j++) {
                if (!boxesOverlap(bb(shapes[i]), bb(shapes[j]))) continue;
                if (flatPattern) {
                    const cell = flatPattern[patternPos % flatPattern.length];
                    patternPos++;
                    if (cell !== 1) continue;
                }
                const zi = zIndexOf(shapes[i]), zj = zIndexOf(shapes[j]);
                const iOnTop = zi > zj;
                const dipper = iOnTop ? shapes[i] : shapes[j];
                const target = iOnTop ? shapes[j] : shapes[i];
                await tryAddPair(dipper, target, false);
            }
        }
    }
    return { dipMap: dipMap, usedMasks: usedMasks, skipped: skipped };
}

function nameResult(doc, node, counterRef) {
    const name = RESULT_PREFIX + counterRef.n;
    counterRef.n++;
    doc.executeCommand(DocumentCommand.createSetDescription(Selection.create(doc, [node]), name));
}

function hideResult(doc, node) {
    doc.executeCommand(DocumentCommand.createSetVisibility(Selection.create(doc, [node]), false));
}

async function runWeaveBoolean(doc, h, roles, hidePieces, safetyMarginPx, maskUsage) {
    const dipMap = roles.dipMap, usedMasks = roles.usedMasks;
    let skipped = roles.skipped;
    if (dipMap.size === 0) {
        app.alert('No valid crossings found.', 'Weave');
        return;
    }
    const originalsToDelete = [];
    const counter = { n: 1 };
    for (const entry of dipMap.entries()) {
        const A = entry[0];
        const entries = entry[1];

        const holesForKeep = [];
        for (const e of entries) {
            const r = h.computeCrossingShapeForHoleStrokeOnly(A, e.target, e.mask, safetyMarginPx, maskUsage);
            if (r && r.shape) holesForKeep.push(r.shape); else skipped++;
        }
        if (holesForKeep.length === 0) { await sleep(THROTTLE_MS); continue; }
        const aKeepSrc = h.duplicate(A);
        const holesUnion = holesForKeep.length === 1 ? holesForKeep[0] : h.boolUnion(holesForKeep);
        if (!holesUnion) { skipped++; await sleep(THROTTLE_MS); continue; }
        const aKeep = h.boolSubtract(aKeepSrc, holesUnion);
        if (!aKeep) { skipped++; await sleep(THROTTLE_MS); continue; }
        nameResult(doc, aKeep, counter);

        for (const e of entries) {
            const piece = h.computeCrossingShape(A, e.target, e.mask, maskUsage);
            if (piece) {
                h.moveBefore(piece, e.target);
                nameResult(doc, piece, counter);
                if (hidePieces) hideResult(doc, piece);
            }
        }

        originalsToDelete.push(A);
        await sleep(THROTTLE_MS);
    }
    if (originalsToDelete.length) {
        doc.executeCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, originalsToDelete)));
    }
    if (usedMasks.length) {
        doc.executeCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, usedMasks)));
    }
    if (skipped > 0) {
        app.alert(skipped + ' crossing(s) skipped (no valid shape computable).', 'Weave');
    }
}

function prepareMaskShape(doc, h, shape, compensationMargin, alreadyWhite) {
    if (!shape) return shape;
    let target = shape;
    let stillWhite = !!alreadyWhite;
    if (compensationMargin > 0.01) {
        const r = h.growShape(shape, compensationMargin);
        target = r.shape;
        stillWhite = r.alreadyWhite;
    }
    if (!target) return shape;
    if (!stillWhite) {
        doc.executeCommand(DocumentCommand.createSetBrushFill(Selection.create(doc, [target]), RGBA8(255, 255, 255, 255)));
    }
    if (target.hasPenFill) {
        doc.executeCommand(DocumentCommand.createSetPenFill(Selection.create(doc, [target]), RGBA8(255, 255, 255, 255)));
        doc.executeCommand(DocumentCommand.createSetStrokeAlignment(Selection.create(doc, [target]), StrokeAlignment.Inside));
    }
    return target;
}
function buildMaskedGroup(doc, h, mainNode, maskShape, compensationMargin, alreadyWhite) {
    if (!maskShape) return null;
    const preparedMask = prepareMaskShape(doc, h, maskShape, compensationMargin, alreadyWhite);
    if (!preparedMask) return null;
    const gbldr = AddChildNodesCommandBuilder.create();
    const grpDef = ContainerNodeDefinition.createDefault();
    gbldr.addContainerNode(grpDef);
    const gcmd = gbldr.createCommand(false);
    doc.executeCommand(gcmd);
    const grp = gcmd.newNodes[0];
    doc.executeCommand(DocumentCommand.createMoveNodes(Selection.create(doc, [mainNode]), grp, NodeMoveType.Inside, NodeChildType.Main));
    doc.executeCommand(DocumentCommand.createMoveNodes(Selection.create(doc, [preparedMask]), grp, NodeMoveType.Inside, NodeChildType.Enclosure));
    return grp;
}

async function runWeaveMask(doc, h, roles, hidePieces, maskConstruction, safetyMarginPx, maskUsage) {
    const dipMap = roles.dipMap, usedMasks = roles.usedMasks;
    let skipped = roles.skipped;
    if (dipMap.size === 0) {
        app.alert('No valid crossings found.', 'Weave');
        return;
    }
    const safe = (typeof safetyMarginPx === 'number' && isFinite(safetyMarginPx)) ? safetyMarginPx : 0;
    const originalsToHide = [];
    const counter = { n: 1 };
    for (const entry of dipMap.entries()) {
        const A = entry[0];
        const entries = entry[1];

        let keepMaskShape = null;
        let pieceReady = [];

        if (maskConstruction === 'rect') {
            const holeCopies = [];
            for (const e of entries) {
                const baseCrossing = h.computeCrossingShape(A, e.target, e.mask, maskUsage);
                if (!baseCrossing) { skipped++; continue; }
                const marginSpec = h.buildMarginSpec(A, e.target, safe);
                const r = h.growShape(baseCrossing, marginSpec);
                const grown = r.shape;
                if (!grown) { skipped++; continue; }
                const dupForHole = h.duplicate(grown);
                holeCopies.push(dupForHole);
                pieceReady.push({ target: e.target, maskShape: grown, alreadyWhite: r.alreadyWhite });
            }
            if (holeCopies.length === 0) { await sleep(THROTTLE_MS); continue; }
            const holesUnion = holeCopies.length === 1 ? holeCopies[0] : h.boolUnion(holeCopies);
            if (!holesUnion) { skipped++; await sleep(THROTTLE_MS); continue; }
            const fittedRect = h.buildFittedRect([A, holesUnion], safe + 10);
            keepMaskShape = h.boolSubtract(fittedRect, holesUnion);
        } else {
            const crossingShapesForHole = [];
            for (const e of entries) {
                const r = h.computeCrossingShapeForHoleStrokeOnly(A, e.target, e.mask, safe, maskUsage);
                if (r && r.shape) crossingShapesForHole.push(r.shape); else skipped++;
            }
            if (crossingShapesForHole.length === 0) { await sleep(THROTTLE_MS); continue; }
            const aMargin = h.getStrokeOnlyMargin(A);
            const compensatedA = aMargin > 0.01 ? h.growShapeAllContours(h.duplicate(A), aMargin) : h.duplicate(A);
            const holesUnion = crossingShapesForHole.length === 1 ? crossingShapesForHole[0] : h.boolUnion(crossingShapesForHole);
            if (!holesUnion) { skipped++; await sleep(THROTTLE_MS); continue; }
            keepMaskShape = h.boolSubtract(compensatedA, holesUnion);
        }

        if (!keepMaskShape) {
            skipped++;
            await sleep(THROTTLE_MS);
            continue;
        }

        const keepMain = h.duplicate(A);
        const keepGroup = buildMaskedGroup(doc, h, keepMain, keepMaskShape, 0, false);
        if (!keepGroup) { skipped++; await sleep(THROTTLE_MS); continue; }
        nameResult(doc, keepGroup, counter);

        if (maskConstruction === 'rect') {
            for (const pr of pieceReady) {
                const pieceMain = h.duplicate(A);
                const pieceGroup = buildMaskedGroup(doc, h, pieceMain, pr.maskShape, 0, pr.alreadyWhite);
                if (!pieceGroup) { skipped++; continue; }
                h.moveBefore(pieceGroup, pr.target);
                nameResult(doc, pieceGroup, counter);
                if (hidePieces) hideResult(doc, pieceGroup);
            }
        } else {
            for (const e of entries) {
                const pieceMain = h.duplicate(A);
                const pieceMaskShape = h.computeCrossingShape(A, e.target, e.mask, maskUsage);
                if (!pieceMaskShape) continue;
                const pieceMargin = h.getStrokeOnlyMargin(A) + h.getStrokeOnlyMargin(e.target);
                const pieceGroup = buildMaskedGroup(doc, h, pieceMain, pieceMaskShape, pieceMargin, false);
                if (!pieceGroup) { skipped++; continue; }
                h.moveBefore(pieceGroup, e.target);
                nameResult(doc, pieceGroup, counter);
                if (hidePieces) hideResult(doc, pieceGroup);
            }
        }

        originalsToHide.push(A);
        await sleep(THROTTLE_MS);
    }
    if (originalsToHide.length) {
        doc.executeCommand(DocumentCommand.createHideSelection(Selection.create(doc, originalsToHide)));
    }
    if (usedMasks.length) {
        doc.executeCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, usedMasks)));
    }
    if (skipped > 0) {
        app.alert(skipped + ' crossing(s) skipped (no valid shape computable).', 'Weave');
    }
}

function countCrossings(doc, method, maskMode, spotStrategy, weaveStyle, maskConstruction, weaveMatrix, flatPattern, shapes, masks) {
    if (maskMode === 'manual') {
        const r = assignRolesManual(shapes, masks);
        let total = 0;
        for (const entries of r.dipMap.values()) total += entries.length;
        return total;
    }
    if (maskMode === 'grid') {
        const orient = classifyOrientation(shapes);
        const rows = orient.horiz, cols = orient.vert;
        const effectiveMatrix = weaveMatrix || (flatPattern ? null : DEFAULT_GRID_MATRIX);
        let total = 0, pos = 0;
        for (let i = 0; i < rows.length; i++) {
            for (let j = 0; j < cols.length; j++) {
                if (!boxesOverlap(bb(rows[i]), bb(cols[j]))) continue;
                if (effectiveMatrix) {
                    const cell = effectiveMatrix[i % effectiveMatrix.length][j % effectiveMatrix[0].length];
                    if (cell !== 1) continue;
                } else if (flatPattern) {
                    const cellF = flatPattern[pos % flatPattern.length]; pos++;
                    if (cellF !== 1) continue;
                }
                total++;
            }
        }
        return total;
    }
    if (maskMode === 'chain') {
        const ordered = sortBySpatialOrder(shapes);
        let total = 0, pos = 0;
        for (let i = 0; i < ordered.length - 1; i++) {
            if (!boxesOverlap(bb(ordered[i]), bb(ordered[i + 1]))) continue;
            if (flatPattern) {
                const cell = flatPattern[pos % flatPattern.length]; pos++;
                if (cell !== 1) continue;
            }
            total++;
        }
        return total;
    }
    let total = 0, pos = 0;
    for (let i = 0; i < shapes.length; i++) {
        for (let j = i + 1; j < shapes.length; j++) {
            if (!boxesOverlap(bb(shapes[i]), bb(shapes[j]))) continue;
            if (flatPattern) {
                const cell = flatPattern[pos % flatPattern.length]; pos++;
                if (cell !== 1) continue;
            }
            total++;
        }
    }
    return total;
}

async function runWeave(doc, method, maskMode, spotStrategy, weaveStyle, hidePieces, maskConstruction, safetyMarginPx, weaveMatrix, flatPattern, shapes, masks, maskUsage) {
    const h = makeHelpers(doc);
    let roles;
    if (maskMode === 'manual') {
        roles = assignRolesManual(shapes, masks);
    } else {
        roles = await buildAutoDipMap(doc, h, shapes, maskMode, spotStrategy, weaveStyle, weaveMatrix, flatPattern);
    }

    if (method === 'mask') {
        await runWeaveMask(doc, h, roles, hidePieces, maskConstruction, safetyMarginPx, maskUsage);
    } else {
        await runWeaveBoolean(doc, h, roles, hidePieces, safetyMarginPx, maskUsage);
    }
}

function computeGridCandidatePairs(shapes, weaveMatrix, flatPattern) {
    const orient = classifyOrientation(shapes);
    const rows = sortByAxis(orient.horiz, 'y');
    const cols = sortByAxis(orient.vert, 'x');
    const effectiveMatrix = weaveMatrix || (flatPattern ? null : DEFAULT_GRID_MATRIX);
    const pairs = [];
    let patternPos = 0;
    for (let i = 0; i < rows.length; i++) {
        for (let j = 0; j < cols.length; j++) {
            if (!boxesOverlap(bb(rows[i]), bb(cols[j]))) continue;
            if (effectiveMatrix) {
                const cell = effectiveMatrix[i % effectiveMatrix.length][j % effectiveMatrix[0].length];
                if (cell !== 1) continue;
            } else if (flatPattern) {
                const cellF = flatPattern[patternPos % flatPattern.length];
                patternPos++;
                if (cellF !== 1) continue;
            }
            pairs.push({ row: rows[i], col: cols[j] });
        }
    }
    return pairs;
}
function groupPairsByDipper(pairs) {
    const groups = new Map();
    const order = [];
    for (const p of pairs) {
        const zr = zIndexOf(p.row), zc = zIndexOf(p.col);
        const rowOnTop = zr > zc;
        const dipper = rowOnTop ? p.row : p.col;
        const target = rowOnTop ? p.col : p.row;
        if (!groups.has(dipper)) { groups.set(dipper, []); order.push(dipper); }
        groups.get(dipper).push(target);
    }
    return order.map(function (d) { return { dipper: d, targets: groups.get(d) }; });
}
function chunkDipperGroups(groups, maxPerBatch) {
    const batches = [];
    let current = [];
    let currentCount = 0;
    for (const g of groups) {
        if (currentCount > 0 && currentCount + g.targets.length > maxPerBatch) {
            batches.push(current);
            current = [];
            currentCount = 0;
        }
        current.push(g);
        currentCount += g.targets.length;
    }
    if (current.length) batches.push(current);
    return batches;
}
async function buildDipMapFromGroups(doc, h, groups, weaveStyle, spotStrategy) {
    const dipMap = new Map();
    const usedMasks = [];
    let skipped = 0;

    function addSingle(dipper, target, overlap) {
        if (!dipMap.has(dipper)) dipMap.set(dipper, []);
        dipMap.get(dipper).push({ mask: overlap, target: target });
        usedMasks.push(overlap);
    }
    async function tryAddPair(dipper, target) {
        const overlap = h.computeCrossingShape(dipper, target, null);
        if (!overlap) { skipped++; return; }
        const loops = h.splitLoops(overlap);
        if (weaveStyle === 'flat') {
            const holeUnion = loops.length === 1 ? loops[0] : h.boolUnion(loops);
            if (!holeUnion) { skipped++; return; }
            addSingle(dipper, target, holeUnion);
            await sleep(THROTTLE_MS);
            return;
        }
        const localInvert = spotStrategy !== 'standard';
        const chosenIdx = localInvert ? loops.length - 1 : 0;
        loops.forEach(function (loop, idx) {
            if (idx === chosenIdx) addSingle(dipper, target, loop);
            else doc.executeCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, [loop])));
        });
        await sleep(THROTTLE_MS);
    }
    for (const g of groups) {
        for (const target of g.targets) {
            await tryAddPair(g.dipper, target);
        }
    }
    return { dipMap: dipMap, usedMasks: usedMasks, skipped: skipped };
}
function confirmBatchedGridStart(totalCrossings, batchCount, batchSize, pauseSec) {
    const dlg = Dialog.create('Weave - Grid in batches');
    const col = dlg.addColumn();
    const grp = col.addGroup('');
    grp.addStaticText('', totalCrossings + ' crossings will be processed in ' + batchCount + ' batches of at most ' + batchSize + ' each.');
    grp.addStaticText('', 'A pause of about ' + pauseSec + ' seconds will be taken between batches (workaround for a suspected internal Affinity crash on very large runs).');
    grp.addStaticText('', 'No custom restore point - only Ctrl+Z is available to undo. Recommendation: save your document first.');
    const result = dlg.runModal();
    return !!result && result.value !== DialogResult.Cancel.value;
}
function confirmContinueBatch(nextBatchNum, batchCount) {
    const dlg = Dialog.create('Weave - Batch ' + (nextBatchNum - 1) + '/' + batchCount + ' done');
    const col = dlg.addColumn();
    const grp = col.addGroup('');
    grp.addStaticText('', 'Batch ' + (nextBatchNum - 1) + ' of ' + batchCount + ' completed. Pause finished.');
    grp.addStaticText('', 'OK = continue with batch ' + nextBatchNum + ', Cancel = stop here (batches done so far remain applied).');
    const result = dlg.runModal();
    return !!result && result.value !== DialogResult.Cancel.value;
}
async function runWeaveGridBatched(doc, h, resolvedShapes, settings, totalCrossings) {
    const batchSize = settings.gridBatchSize;
    const pauseMs = settings.gridBatchPauseSec * 1000;
    const pairs = computeGridCandidatePairs(resolvedShapes, settings.weaveMatrix, settings.flatPattern);
    const groups = groupPairsByDipper(pairs);
    const batches = chunkDipperGroups(groups, batchSize);
    const proceed = confirmBatchedGridStart(totalCrossings, batches.length, batchSize, settings.gridBatchPauseSec);
    if (!proceed) return;
    let processedCrossings = 0;
    let stoppedEarly = false;
    for (let b = 0; b < batches.length; b++) {
        let batchCrossingCount = 0;
        for (const g of batches[b]) batchCrossingCount += g.targets.length;
        const roles = await buildDipMapFromGroups(doc, h, batches[b], settings.weaveStyle, settings.spotStrategy);
        try {
            if (settings.method === 'mask') {
                await runWeaveMask(doc, h, roles, settings.hidePieces, settings.maskConstruction, settings.safetyMarginPx, settings.maskUsage);
            } else {
                await runWeaveBoolean(doc, h, roles, settings.hidePieces, settings.safetyMarginPx, settings.maskUsage);
            }
        } catch (err) {
            app.alert('Error in batch ' + (b + 1) + ' of ' + batches.length + ': ' + err.message + '\n\nPlease check already-applied batches with Ctrl+Z if needed. ' + processedCrossings + ' crossing(s) were successfully processed before the error.', 'Weave - Error');
            return;
        }
        processedCrossings += batchCrossingCount;
        if (b < batches.length - 1) {
            await sleep(pauseMs);
            const cont = confirmContinueBatch(b + 2, batches.length);
            if (!cont) { stoppedEarly = true; break; }
        }
    }
    if (stoppedEarly) {
        app.alert('Stopped early. ' + processedCrossings + ' of ' + totalCrossings + ' crossing(s) were applied and remain in place.', 'Weave');
    } else {
        app.alert('All ' + batches.length + ' batches completed. ' + processedCrossings + ' crossing(s) processed in total.', 'Weave');
    }
}

function runRestore(doc, sel) {
    const toShow = sel.filter(function (n) { return !n.isVisible && !isResultNamed(n); });
    const toDelete = sel.filter(function (n) { return isResultNamed(n); });
    if (toShow.length) {
        doc.executeCommand(DocumentCommand.createSetVisibility(Selection.create(doc, toShow), true));
    }
    if (toDelete.length) {
        doc.executeCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, toDelete)));
    }
}

function runPreviewConfirm(doc, snapshot) {
    clearSelection(doc);
    const dlg = Dialog.create('Weave - Preview');
    const col = dlg.addColumn();
    const grp = col.addGroup('');
    grp.addStaticText('', 'Result applied. OK = keep, Cancel = discard (undo).');
    const result = dlg.runModal();
    const discard = !result || result.value === DialogResult.Cancel.value;
    clearSelection(doc);
    if (discard) {
        doc.executeCommand(DocumentCommand.createRestoreDocumentSnapshot(snapshot), false);
    }
    doc.executeCommand(DocumentCommand.createDeleteDocumentSnapshot(snapshot), false);
}

function confirmLargeBatch(expectedCrossings) {
    const dlg = Dialog.create('Weave - Warning');
    const col = dlg.addColumn();
    const grp = col.addGroup('');
    grp.addStaticText('', expectedCrossings + ' crossings will be processed, with short pauses in between (experimental).');
    grp.addStaticText('', 'Because of this, NO custom confirmation dialog and NO custom restore point will be created - only Ctrl+Z is available to undo.');
    grp.addStaticText('', 'Recommendation: save your document first. OK to proceed anyway, Cancel to go back to settings (e.g. shrink the matrix/pattern).');
    const result = dlg.runModal();
    return !!result && result.value !== DialogResult.Cancel.value;
}

function showSettingsDialog(doc, resolved, hasManualMasks, counts, prev) {
    const dlg = Dialog.create('Weave');
    dlg.initialWidth = 820;
    dlg.isResizable = true;
    const col1 = dlg.addColumn();
    const col2 = dlg.addColumn();

    const grpL = col1.addGroup('');
    grpL.addStaticText('', 'Weave - detected: ' + resolved.shapes.length + ' object(s), ' + resolved.masks.length + ' mask(s).');

    let maskModeBtn = null;
    let spotCombo = null;
    let weaveStyleBtn = null;
    let matrixBox = null;
    let flatPatternBox = null;
    let maskUsageBtn = null;
    let gridBatchSizeBox = null;
    let gridBatchPauseBox = null;
    let modeOptions = [];
    const spotOptions = ['Standard', 'Invert', 'Alternate', 'Alternate (reversed)'];
    const spotValues = ['standard', 'invert', 'alternate', 'alternate-inv'];
    if (hasManualMasks) {
        grpL.addStaticText('', 'Manual masks (name "' + MASK_PREFIX + '...") - approx. ' + counts.manual + ' crossing(s). Default: mask only narrows down where the cut happens. "Direct": the mask shape itself becomes the hole.');
        maskUsageBtn = grpL.addButtonSet('Mask usage', ['As a marker', 'Direct as cut-out'], prev ? prev.maskUsageIdx : 0);
    } else {
        let previewLine = 'Automatic - preview: Chain ' + counts.chain + ', Layer order ' + counts.zorder;
        if (counts.gridAvailable) previewLine += ', Grid ' + counts.grid;
        previewLine += '. Whoever is on top dips (fixed, guaranteed visible).';
        grpL.addStaticText('', previewLine);
        modeOptions = counts.gridAvailable ? ['Chain', 'Layer order', 'Grid (checkerboard)'] : ['Chain', 'Layer order'];
        const defaultModeIdx = prev ? Math.max(0, modeOptions.indexOf(prev.maskModeLabel)) : (counts.gridAvailable ? 2 : 0);
        maskModeBtn = grpL.addButtonSet('Mask mode', modeOptions, defaultModeIdx);
        if (counts.gridAvailable) {
            grpL.addStaticText('', 'Matrix (grid only), e.g. "(1,1,0,0)(0,1,1,0)": 1=process. Empty = checkerboard (every other crossing, like "(1,0)(0,1)").');
            matrixBox = grpL.addTextBox('Weave-pattern matrix (optional)', prev ? prev.weaveMatrixText : '');
            grpL.addStaticText('', 'Grid only: with many crossings, automatic splitting into batches with a pause in between (workaround for a suspected Affinity crash). Adjustable for your machine.');
            gridBatchSizeBox = grpL.addTextBox('Crossings per batch (grid)', prev && prev.gridBatchSizeText ? prev.gridBatchSizeText : String(DEFAULT_GRID_BATCH_SIZE));
            gridBatchPauseBox = grpL.addTextBox('Pause between batches in seconds (grid)', prev && prev.gridBatchPauseText ? prev.gridBatchPauseText : String(DEFAULT_GRID_BATCH_PAUSE_SEC));
        }
        grpL.addStaticText('', 'Pattern, e.g. "1,0,1": 1=process, 0=skip. Applies to Chain/Layer order, and to Grid only without a matrix.');
        flatPatternBox = grpL.addTextBox('Pattern (optional)', prev ? prev.flatPatternText : '');
        weaveStyleBtn = grpL.addButtonSet('At multiple touch points', ['Interlace (1 cut)', 'All together'], prev ? prev.weaveStyleIdx : 0);
        grpL.addStaticText('', 'Which spot gets cut (hole shape only, not who dips). Chain also allows Alternate; usually no effect for Grid/Layer order.');
        spotCombo = grpL.addComboBox('Which spot', spotOptions, prev ? Math.max(0, spotValues.indexOf(prev.spotStrategy)) : 0);
    }

    const grpR = col2.addGroup('');
    grpR.addStaticText('', 'Boolean cuts (stroke only, no FX). Mask: original stays, just hidden (undo by re-running with the hidden selection).');
    const methodBtn = grpR.addButtonSet('Method', ['Boolean (cuts)', 'Mask (non-destructive)'], prev ? prev.methodIdx : 0);
    grpR.addStaticText('', 'Mask only: Standard = tight, stroke only. Rectangle cut-out = + FX shadow (direction-aware), recommended.');
    const maskConstructionBtn = grpR.addButtonSet('Mask construction', ['Standard', 'Rectangle cut-out'], prev ? prev.maskConstructionIdx : 1);
    const safetyEditor = grpR.addUnitValueEditor('Safety margin', UnitType.Pixel, 0);
    safetyEditor.setValue(prev ? prev.safetyMarginPx : 2);
    safetyEditor.setNoMinValue(false);
    grpR.addStaticText('', '"Piece" = part behind the hole, catches small gaps.');
    const hidePiecesBtn = grpR.addButtonSet('Piece objects', ['Keep visible', 'Hide'], prev ? prev.hidePiecesIdx : 0);

    const result = dlg.runModal();
    if (!result || result.value === DialogResult.Cancel.value) return null;

    const method = methodBtn.selectedIndex === 1 ? 'mask' : 'boolean';
    const hidePieces = hidePiecesBtn.selectedIndex === 1;
    const maskConstruction = maskConstructionBtn.selectedIndex === 1 ? 'rect' : 'standard';
    const rawSafety = safetyEditor.value;
    const safetyMarginPx = (typeof rawSafety === 'number' && isFinite(rawSafety)) ? rawSafety : 0;
    let maskMode, spotStrategy, weaveStyle, weaveMatrix, flatPattern, maskUsage;
    let maskModeLabel = null, weaveStyleIdx = 0, weaveMatrixText = '', flatPatternText = '', maskUsageIdx = 0;
    let gridBatchSizeText = String(DEFAULT_GRID_BATCH_SIZE), gridBatchPauseText = String(DEFAULT_GRID_BATCH_PAUSE_SEC);
    if (hasManualMasks) {
        maskMode = 'manual';
        spotStrategy = 'standard';
        weaveStyle = 'interlace';
        weaveMatrix = null;
        flatPattern = null;
        maskUsageIdx = maskUsageBtn.selectedIndex;
        maskUsage = maskUsageIdx === 1 ? 'direct' : 'marker';
    } else {
        const idx = maskModeBtn.selectedIndex;
        maskModeLabel = modeOptions[idx];
        maskMode = maskModeLabel === 'Layer order' ? 'zorder' : (maskModeLabel === 'Grid (checkerboard)' ? 'grid' : 'chain');
        weaveStyleIdx = weaveStyleBtn.selectedIndex;
        weaveStyle = weaveStyleIdx === 1 ? 'flat' : 'interlace';
        weaveMatrixText = matrixBox ? matrixBox.text : '';
        weaveMatrix = matrixBox ? parseWeaveMatrix(weaveMatrixText) : null;
        flatPatternText = flatPatternBox ? flatPatternBox.text : '';
        flatPattern = flatPatternBox ? parseFlatPattern(flatPatternText) : null;
        spotStrategy = spotValues[spotCombo.selectedIndex];
        maskUsage = 'marker';
        if (gridBatchSizeBox) gridBatchSizeText = gridBatchSizeBox.text;
        if (gridBatchPauseBox) gridBatchPauseText = gridBatchPauseBox.text;
    }

    return {
        method: method, methodIdx: methodBtn.selectedIndex,
        hidePieces: hidePieces, hidePiecesIdx: hidePiecesBtn.selectedIndex,
        maskConstruction: maskConstruction, maskConstructionIdx: maskConstructionBtn.selectedIndex,
        safetyMarginPx: safetyMarginPx,
        maskMode: maskMode, maskModeLabel: maskModeLabel,
        spotStrategy: spotStrategy,
        weaveStyle: weaveStyle, weaveStyleIdx: weaveStyleIdx,
        weaveMatrix: weaveMatrix, weaveMatrixText: weaveMatrixText,
        flatPattern: flatPattern, flatPatternText: flatPatternText,
        maskUsage: maskUsage, maskUsageIdx: maskUsageIdx,
        gridBatchSizeText: gridBatchSizeText,
        gridBatchPauseText: gridBatchPauseText,
        gridBatchSize: parsePositiveInt(gridBatchSizeText, DEFAULT_GRID_BATCH_SIZE),
        gridBatchPauseSec: parsePositiveInt(gridBatchPauseText, DEFAULT_GRID_BATCH_PAUSE_SEC)
    };
}

async function main() {
    const doc = Document.current;
    if (!doc) { app.alert('No document open.', 'Weave'); return; }

    const selNodes = doc.selection ? doc.selection.nodes.toArray() : [];
    if (selNodes.length < 1) {
        app.alert('Please select at least one group, or 2 objects (optionally plus mask shapes/group named "' + MASK_PREFIX + '").', 'Weave');
        return;
    }

    const flatForUndo = flattenSelectionOneLevel(selNodes);
    const hasHidden = flatForUndo.some(function (n) { return !n.isVisible; });
    if (hasHidden) {
        runRestore(doc, flatForUndo);
        return;
    }

    const resolved = resolveShapesAndMasks(selNodes);
    if (resolved.shapes.length < 2) {
        app.alert('At least 2 non-mask objects must be selected (individually or as a group).', 'Weave');
        return;
    }
    const hasManualMasks = resolved.masks.length > 0;
    const counts = previewCounts(resolved.shapes, resolved.masks);

    let settings = null;
    while (true) {
        clearSelection(doc);
        settings = showSettingsDialog(doc, resolved, hasManualMasks, counts, settings);
        if (!settings) return;

        const expectedCrossings = countCrossings(doc, settings.method, settings.maskMode, settings.spotStrategy, settings.weaveStyle, settings.maskConstruction, settings.weaveMatrix, settings.flatPattern, resolved.shapes, resolved.masks);

        if (settings.maskMode === 'grid' && expectedCrossings > settings.gridBatchSize) {
            const h = makeHelpers(doc);
            await runWeaveGridBatched(doc, h, resolved.shapes, settings, expectedCrossings);
            break;
        }

        const isLargeBatch = expectedCrossings > SAFE_CROSSING_LIMIT;

        if (isLargeBatch) {
            const proceed = confirmLargeBatch(expectedCrossings);
            if (!proceed) continue;

            try {
                await runWeave(doc, settings.method, settings.maskMode, settings.spotStrategy, settings.weaveStyle, settings.hidePieces, settings.maskConstruction, settings.safetyMarginPx, settings.weaveMatrix, settings.flatPattern, resolved.shapes, resolved.masks, settings.maskUsage);
            } catch (err) {
                app.alert('Error during processing: ' + err.message + '\n\nPlease undo any already-made changes with Ctrl+Z.', 'Weave - Error');
            }
            break;
        }

        const skipPreview = expectedCrossings > PREVIEW_CROSSING_LIMIT;

        doc.executeCommand(DocumentCommand.createAddDocumentSnapshot('Before Weave'), false);
        const snapshot = doc.snapshots[doc.snapshots.length - 1];

        try {
            await runWeave(doc, settings.method, settings.maskMode, settings.spotStrategy, settings.weaveStyle, settings.hidePieces, settings.maskConstruction, settings.safetyMarginPx, settings.weaveMatrix, settings.flatPattern, resolved.shapes, resolved.masks, settings.maskUsage);
        } catch (err) {
            clearSelection(doc);
            doc.executeCommand(DocumentCommand.createRestoreDocumentSnapshot(snapshot), false);
            doc.executeCommand(DocumentCommand.createDeleteDocumentSnapshot(snapshot), false);
            app.alert('Error during processing: ' + err.message + '\n\nAll changes have been rolled back.', 'Weave - Error');
            return;
        }

        if (skipPreview) {
            app.alert('Weave applied (' + expectedCrossings + ' crossings). With this many crossings the preview confirmation is skipped. Use Ctrl+Z if you need to undo.', 'Weave');
            doc.executeCommand(DocumentCommand.createDeleteDocumentSnapshot(snapshot), false);
        } else {
            runPreviewConfirm(doc, snapshot);
        }
        break;
    }
}

main();
