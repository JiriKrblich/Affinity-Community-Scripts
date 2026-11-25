'use strict';
// ============================================================================
// Mosaic v7  –  turns a base object (vector, image, group, text …) into a
// mosaic of vector tiles. Each tile's fill colour is sampled from the
// rendered base object.
//
// Usage:
//   • Select the base object(s) and run the script.
//   • Custom tile shape: additionally select a template object (name "_MO…",
//     several → mix; otherwise the topmost selected object).
//   • Custom palette: additionally select objects named "_MF…".
//   • Preview button = show result, dialog stays open.
//     OK = apply, Cancel/X/ESC = discard everything.
//   v2: position/size jitter, stroke (width, colour), tabbed interface.
//   v3: colour palette (k-means or "_MF…" objects), HSL jitter, edge
//       orientation, grout area, stroke alignment and width jitter,
//       clip to silhouette, "new seed".
//   v4: adaptive tile size by detail (quadtree), Voronoi mosaic, Colour and
//       Palette tabs merged, rotation increment, size min/max in %.
//   v5: grid rotation – the whole grid (rows, tiles, grout) is rotated by an
//       angle; no effect with Voronoi (greyed out).
//   v6: robust preview undo: with a full undo history (2048 entries)
//       doc.history.position no longer advances – resetting via the position had
//       no effect (old preview remained, base object stayed hidden). Now: undo via
//       the position difference (exact); with a full history the safety net
//       deletes the mosaic groups and shows the base objects again (everything
//       created sits inside the group). The selection is only changed when it
//       actually differs.
//   v7: fewer history entries (per run: 1 create command + 1 group command per base
//       object and one finishing compound; previously 9–12). Insertion directly above
//       the anchor without changing the selection; grout name and stroke alignment are
//       set in the definition already. Undo reverts exactly the script's own commands
//       (count + sentinel object), independent of the history position – exact even
//       with a full history.
// ============================================================================

const { app } = require('/application');
const { Document } = require('/document');
const { DocumentCommand, AddChildNodesCommandBuilder, CompoundCommandBuilder } = require('/commands');
const { Selection } = require('/selections');
const { Dialog, DialogResult } = require('/dialog');
const { UnitType } = require('/units');
const { NodeRenderingEngine, NodeRenderingEngineOptions, RasterFormat } = require('/rasterobject');
const { Curve, CurveBuilder, PolyCurve, Transform } = require('/geometry');
const { PolyCurveNodeDefinition } = require('/nodes');
const { FillDescriptor } = require('/fills');
const { LineStyleDescriptor } = require('/linestyle');
const { RGBA8, Colour } = require('/colours');
const { StrokeAlignment } = require('/linestyle');
const { WindingOrder } = require('affinity:geometry');
const { NodeMoveType, NodeChildType } = require('affinity:dom');
const { File, FileSystemApi } = require('/fs');

const SCRIPT_TITLE = 'Mosaic v7';
const PRESET_DIR = app.userDesktopPath + '/AffinityScriptPresets';
const PRESET_PREFIX = 'Mosaic_';
const TEMPLATE_PREFIX = '_MO';
const PALETTE_PREFIX = '_MF';
const MAX_ELEMENTS = 25000;

// v7: count the current run's own commands; sentinel = first created element
let RUN = null;   // { steps, sentinel }
function docExec(doc, cmd) { doc.executeCommand(cmd); if (RUN) RUN.steps++; }
function nodeInDoc(doc, n) {
    if (!n) return false;
    try { for (const l of doc.layers.all) if (l.isSameNode(n)) return true; } catch (e) { }
    return false;
}
function sameSelection(doc, nodes) {
    let cur = [];
    try { cur = doc.selection.nodes.toArray(); } catch (e) { return false; }
    if (cur.length !== nodes.length) return false;
    for (const n of nodes) if (!cur.some(c => c.isSameNode(n))) return false;
    return true;
}
// Insert new objects directly ABOVE host (same layer, no selection change).
// Tested live: mode 3 (Behind) reverses the order, mode 4 (Top) does not.
function addAbove(host, defs) {
    const b = AddChildNodesCommandBuilder.create();
    let next = null;
    try { const sibs = host.parent.children.toArray(); for (let i = 0; i < sibs.length - 1; i++) if (sibs[i].isSameNode(host)) { next = sibs[i + 1]; break; } } catch (e) { }
    if (next) { b.setInsertionTarget(next); b.setInsertionMode(3); for (let i = defs.length - 1; i >= 0; i--) b.addNode(defs[i]); }
    else      { b.setInsertionTarget(host); b.setInsertionMode(4); for (const d of defs) b.addNode(d); }
    return b.createCommand(false);
}

const FORMS = ['Square', 'Circle', 'Rounded square', 'Diamond', 'Triangle (alternating)',
               'Hexagon (honeycomb)', 'Octagon', 'Star', 'Template (selection / _MO)', 'Voronoi (irregular)'];
const F_SQUARE = 0, F_CIRCLE = 1, F_ROUND = 2, F_DIAMOND = 3, F_TRIANGLE = 4,
      F_HEX = 5, F_OCT = 6, F_STAR = 7, F_TEMPLATE = 8, F_VORONOI = 9;
const ARRANGE = ['Grid', 'Offset (brick)'];
const COLOUR_SRC = ['Area average', 'Centre point'];
const SIZE_MODE = ['Off', 'Dark = large', 'Light = large'];
const BASE_MODE = ['Keep', 'Hide', 'Delete'];
const TPL_MIX = ['Random', 'Alternating'];
const STROKE_COL = ['Fixed colour', 'Same as fill', 'Fill darker', 'Fill lighter'];
const PAGES = ['Tiles', 'Variation', 'Colour', 'Stroke', 'Grout & output'];
const ORIENT = ['Fixed', 'Along edges', 'Across edges'];
const PAL_MODE = ['Off', 'Automatic (k-means)', 'From "_MF…" objects'];
const STROKE_ALIGN = ['Centre', 'Inside', 'Outside'];
const GROUT_MODE = ['Off', 'Cells', 'Bounding box'];

const DEFAULTS = {
    form: F_SQUARE, arrange: 0, size: 40, gap: 4, rotation: 0, rotJitter: 0,
    colourSrc: 0, minCover: 50, useAlpha: false, sizeMode: 0, minSize: 30,
    baseMode: 1, tplMix: 0, seed: 1,
    jitX: 0, jitY: 0, sizeMin: 0, sizeMax: 0, rotInc: 0,
    adaptive: false, adaptMin: 10, detail: 8, irregular: 70, gridRot: 0,
    stroke: false, strokeW: 2, strokeColMode: 0, strokeShade: 40,
    strokeCol: { r: 0, g: 0, b: 0, alpha: 255 },
    orient: 0, edgeThresh: 8,
    palMode: 0, palCount: 12, hJit: 0, sJit: 0, lJit: 0,
    strokeAlign: 0, strokeWJit: 0,
    groutMode: 0, groutCol: { r: 60, g: 60, b: 60, alpha: 255 }, clip: false
};

function mulberry32(a) {
    return function () {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

function isIdentity(tf) {
    const d = tf.data;
    return Math.abs(d[0] - 1) < 1e-9 && Math.abs(d[1]) < 1e-9 && Math.abs(d[2]) < 1e-6 &&
           Math.abs(d[3]) < 1e-9 && Math.abs(d[4] - 1) < 1e-9 && Math.abs(d[5]) < 1e-6;
}

function composedSpreadTF(node) {
    let tf = node.transform ? node.transform.clone() : Transform.createIdentity();
    let p = node.parent;
    while (p && !p.isSpreadNode) {
        if (p.transform) tf = p.transform.multiply(tf);
        p = p.parent;
    }
    return tf;
}

function parentChainIsIdentity(node) {
    let p = node.parent;
    while (p && !p.isSpreadNode) {
        if (p.transform && !isIdentity(p.transform)) return false;
        p = p.parent;
    }
    return true;
}

function insertionAnchor(node) {
    let t = node;
    while (!parentChainIsIdentity(t) && t.parent && !t.parent.isSpreadNode) t = t.parent;
    return t;
}

function nodeName(n) {
    const u = n.userDescription;
    return (u && u.length) ? u : n.defaultDescription;
}

function polyFromPoints(pts) {
    const cb = CurveBuilder.create();
    cb.beginXY(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) cb.lineToXY(pts[i][0], pts[i][1]);
    cb.close();
    const pc = PolyCurve.create();
    pc.addCurve(cb.createCurve());
    return pc;
}

function regularPoly(n, R, startDeg) {
    const pts = [];
    for (let k = 0; k < n; k++) {
        const a = (startDeg + k * 360 / n) * Math.PI / 180;
        pts.push([R * Math.cos(a), R * Math.sin(a)]);
    }
    return polyFromPoints(pts);
}

function unitShape(form, flip) {
    const rc = { x: -0.5, y: -0.5, width: 1, height: 1 };
    const pc = PolyCurve.create();
    switch (form) {
        case F_CIRCLE: pc.addCurve(Curve.createEllipse(rc)); return pc;
        case F_DIAMOND: pc.addCurve(Curve.createDiamond(rc)); return pc;
        case F_ROUND: {
            const r = 0.22, k = 0.5523 * r, a = 0.5;
            const cb = CurveBuilder.create();
            cb.beginXY(-a + r, -a);
            cb.lineToXY(a - r, -a);
            cb.addBezierXY(a - r + k, -a, a, -a + r - k, a, -a + r);
            cb.lineToXY(a, a - r);
            cb.addBezierXY(a, a - r + k, a - r + k, a, a - r, a);
            cb.lineToXY(-a + r, a);
            cb.addBezierXY(-a + r - k, a, -a, a - r + k, -a, a - r);
            cb.lineToXY(-a, -a + r);
            cb.addBezierXY(-a, -a + r - k, -a + r - k, -a, -a + r, -a);
            cb.close();
            pc.addCurve(cb.createCurve());
            return pc;
        }
        case F_TRIANGLE: {
            const h = Math.sqrt(3) / 2;
            const s = flip ? -1 : 1;
            return polyFromPoints([[0, -s * 2 * h / 3], [0.5, s * h / 3], [-0.5, s * h / 3]]);
        }
        case F_HEX: return regularPoly(6, 1 / Math.sqrt(3), -90);
        case F_OCT: return regularPoly(8, 0.5 / Math.cos(Math.PI / 8), 22.5);
        case F_STAR: {
            const pts = [];
            for (let k = 0; k < 10; k++) {
                const R = (k % 2 === 0) ? 0.5 : 0.2;
                const a = (-90 + k * 36) * Math.PI / 180;
                pts.push([R * Math.cos(a), R * Math.sin(a) + 0.04]);
            }
            return polyFromPoints(pts);
        }
        default: pc.addCurve(Curve.createRectangle(rc)); return pc;
    }
}

function collectTemplateCurves(node, out) {
    let used = false;
    try {
        if (node.storyInterface && node.curvesInterface && node.curvesInterface.polyPolyCurves) {
            const ppc = node.curvesInterface.polyPolyCurves;
            const tf = composedSpreadTF(node);
            for (let i = 0; i < ppc.polyCurveCount; i++) {
                const pc = ppc.getTransformedPolyCurve(i);
                pc.transform(tf);
                for (let c = 0; c < pc.curveCount; c++) out.addCurve(pc.at(c));
            }
            used = ppc.polyCurveCount > 0;
        }
    } catch (e) { }
    if (!used) {
        try {
            const ci = node.curvesInterface;
            if (ci && ci.polyCurve && !node.storyInterface) {
                const pc = ci.polyCurve.clone();
                pc.transform(composedSpreadTF(node));
                for (let c = 0; c < pc.curveCount; c++) {
                    const cu = pc.at(c);
                    if (cu.pointCount > 0 && !cu.isEmpty) out.addCurve(cu);
                }
                used = true;
            }
        } catch (e) { }
    }
    if (!used && node.children && node.children.length > 0) {
        for (const ch of node.children.toArray()) collectTemplateCurves(ch, out);
    }
}

function buildTemplateShape(node) {
    const pc = PolyCurve.create();
    collectTemplateCurves(node, pc);
    if (pc.curveCount === 0) return null;
    const bb = pc.exactBoundingBox;
    if (!bb || bb.width <= 0 && bb.height <= 0) return null;
    const m = Math.max(bb.width, bb.height);
    pc.transform(Transform.createScale(1 / m).multiply(
        Transform.createTranslate(-(bb.x + bb.width / 2), -(bb.y + bb.height / 2))));
    return pc;
}

function buildLatticeAxis(bb, p) {
    const cells = [];
    const cxB = bb.x + bb.width / 2, cyB = bb.y + bb.height / 2;
    if (p.form === F_HEX) {
        const px = p.size + p.gap, py = px * Math.sqrt(3) / 2;
        const nx = Math.ceil(bb.width / px) + 2, ny = Math.ceil(bb.height / py) + 2;
        const x0 = cxB - (nx - 1) / 2 * px, y0 = cyB - (ny - 1) / 2 * py;
        for (let j = 0; j < ny; j++)
            for (let i = 0; i < nx; i++)
                cells.push({ x: x0 + i * px + ((j & 1) ? px / 2 : 0), y: y0 + j * py, flip: false, sz: p.size, cp: px });
    } else if (p.form === F_TRIANGLE) {
        const T = p.size + Math.sqrt(3) * p.gap, H = T * Math.sqrt(3) / 2;
        const nx = Math.ceil(bb.width / (T / 2)) + 3, ny = Math.ceil(bb.height / H) + 2;
        const x0 = cxB - (nx - 1) / 2 * (T / 2), y0 = cyB - ny / 2 * H;
        for (let j = 0; j < ny; j++)
            for (let i = 0; i < nx; i++) {
                const up = ((i + j) & 1) === 0;
                cells.push({ x: x0 + i * T / 2, y: y0 + j * H + (up ? 2 * H / 3 : H / 3), flip: !up, sz: p.size, cp: T });
            }
    } else {
        const pt = p.size + p.gap;
        const nx = Math.ceil(bb.width / pt) + 2, ny = Math.ceil(bb.height / pt) + 2;
        const x0 = cxB - (nx - 1) / 2 * pt, y0 = cyB - (ny - 1) / 2 * pt;
        for (let j = 0; j < ny; j++)
            for (let i = 0; i < nx; i++)
                cells.push({ x: x0 + i * pt + ((p.arrange === 1 && (j & 1)) ? pt / 2 : 0), y: y0 + j * pt, flip: false, sz: p.size, cp: pt });
    }
    return cells;
}

// Grid rotation: build the grid in a rotated frame and rotate it about the
// base object's centre; the generation field is a square over the diagonal.
function gridAngleRad(p) {
    return (p.form === F_VORONOI || !p.gridRot) ? 0 : p.gridRot * Math.PI / 180;
}
function buildLattice(bb, p) {
    const a = gridAngleRad(p);
    if (Math.abs(a) < 1e-9) return buildLatticeAxis(bb, p);
    const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
    const D = Math.sqrt(bb.width * bb.width + bb.height * bb.height);
    const sq = { x: cx - D / 2, y: cy - D / 2, width: D, height: D };
    const ca = Math.cos(a), sa = Math.sin(a);
    const out = [];
    for (const c of buildLatticeAxis(sq, p)) {
        const dx = c.x - cx, dy = c.y - cy;
        const x = cx + dx * ca - dy * sa, y = cy + dx * sa + dy * ca;
        const m = c.cp;
        if (x < bb.x - m || x > bb.x + bb.width + m || y < bb.y - m || y > bb.y + bb.height + m) continue;
        c.x = x; c.y = y;
        out.push(c);
    }
    return out;
}

function renderBase(node, pitch) {
    const bb = node.getSpreadBaseBox(false);
    let s = Math.max(0.05, Math.min(2, 10 / Math.max(1, pitch)));
    const maxPix = 16e6;
    if (bb.width * bb.height * s * s > maxPix) s = Math.sqrt(maxPix / (bb.width * bb.height));
    const o = NodeRenderingEngineOptions.create();
    o.scale = s;
    const pb = NodeRenderingEngine.create(node, RasterFormat.RGBA8, o).createCompatibleBuffer(true);
    return { bb: bb, s: s, W: pb.width, H: pb.height, px: new Uint8Array(pb.buffer) };
}

function sampleBox(img, cx, cy, half) {
    const s = img.s;
    let x0 = Math.floor((cx - half - img.bb.x) * s), x1 = Math.ceil((cx + half - img.bb.x) * s);
    let y0 = Math.floor((cy - half - img.bb.y) * s), y1 = Math.ceil((cy + half - img.bb.y) * s);
    if (x1 <= x0) x1 = x0 + 1;
    if (y1 <= y0) y1 = y0 + 1;
    const total = (x1 - x0) * (y1 - y0);
    x0 = Math.max(0, x0); y0 = Math.max(0, y0);
    x1 = Math.min(img.W, x1); y1 = Math.min(img.H, y1);
    let r = 0, g = 0, b = 0, a = 0;
    const W = img.W, u = img.px;
    for (let y = y0; y < y1; y++) {
        let k = (y * W + x0) * 4;
        for (let x = x0; x < x1; x++, k += 4) {
            const al = u[k + 3];
            if (al) { r += u[k] * al; g += u[k + 1] * al; b += u[k + 2] * al; a += al; }
        }
    }
    if (a === 0 || total <= 0) return null;
    return { r: r / a, g: g / a, b: b / a, cover: a / (total * 255) };
}

function rgb2hsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    let h = 0, s = 0;
    if (mx !== mn) {
        const d = mx - mn;
        s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
        if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
        else if (mx === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
    }
    return [h, s, l];
}
function hsl2rgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    if (s <= 0) { const v = Math.round(l * 255); return [v, v, v]; }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const f = t => { t = (t + 1) % 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 0.5) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
    return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)];
}
function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
function colDist(a, b) {
    const rm = (a[0] + b[0]) / 2, dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
    return (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
}
function nearest(c, pal) {
    let best = pal[0], bd = Infinity;
    for (const q of pal) { const d = colDist(c, q); if (d < bd) { bd = d; best = q; } }
    return best;
}
function kmeans(cols, k, rng) {
    if (cols.length <= k) return cols.map(c => c.slice());
    const cent = [cols[Math.floor(rng() * cols.length)].slice()];
    const dist = new Array(cols.length).fill(Infinity);
    while (cent.length < k) {
        let sum = 0;
        const last = cent[cent.length - 1];
        for (let i = 0; i < cols.length; i++) { const d = colDist(cols[i], last); if (d < dist[i]) dist[i] = d; sum += dist[i]; }
        let t = rng() * sum, idx = 0;
        for (; idx < cols.length - 1; idx++) { t -= dist[idx]; if (t <= 0) break; }
        cent.push(cols[idx].slice());
    }
    for (let it = 0; it < 12; it++) {
        const acc = cent.map(() => [0, 0, 0, 0]);
        for (const c of cols) {
            let bi = 0, bd = Infinity;
            for (let j = 0; j < cent.length; j++) { const d = colDist(c, cent[j]); if (d < bd) { bd = d; bi = j; } }
            const a = acc[bi]; a[0] += c[0]; a[1] += c[1]; a[2] += c[2]; a[3]++;
        }
        for (let j = 0; j < cent.length; j++) if (acc[j][3]) cent[j] = [acc[j][0] / acc[j][3], acc[j][1] / acc[j][3], acc[j][2] / acc[j][3]];
    }
    return cent.map(c => [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])]);
}
function colourToRGB(c) {
    let v = null;
    try { v = c.rgba8; } catch (e) { }
    if (!v) { try { v = new Colour(c).rgba8; } catch (e) { } }
    return v ? [v.r, v.g, v.b] : null;
}
function collectPaletteColours(node, out) {
    try {
        const f = node.brushFillDescriptor && node.brushFillDescriptor.fill;
        if (f) {
            if (f.gradient) { for (const st of f.gradient.stops) { const c = colourToRGB(st.colour); if (c) out.push(c); } }
            else if (f.colour) { const c = colourToRGB(f.colour); if (c) out.push(c); }
        }
    } catch (e) { }
    if (node.children && node.children.length > 0) for (const ch of node.children.toArray()) collectPaletteColours(ch, out);
}

function lumBox(img, cx, cy, half) {
    const s = img.s;
    let x0 = Math.floor((cx - half - img.bb.x) * s), x1 = Math.ceil((cx + half - img.bb.x) * s);
    let y0 = Math.floor((cy - half - img.bb.y) * s), y1 = Math.ceil((cy + half - img.bb.y) * s);
    if (x1 <= x0) x1 = x0 + 1;
    if (y1 <= y0) y1 = y0 + 1;
    let sum = 0, n = 0;
    const W = img.W, u = img.px;
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            n++;
            if (x < 0 || y < 0 || x >= img.W || y >= img.H) { sum += 255; continue; }
            const k = (y * W + x) * 4, a = u[k + 3] / 255;
            const L = 0.2126 * u[k] + 0.7152 * u[k + 1] + 0.0722 * u[k + 2];
            sum += L * a + 255 * (1 - a);
        }
    }
    return n ? sum / n : 255;
}
function edgeAngle(img, cx, cy, size) {
    const d = size / 2, h = size / 2;
    const gx = lumBox(img, cx + d, cy, h) - lumBox(img, cx - d, cy, h);
    const gy = lumBox(img, cx, cy + d, h) - lumBox(img, cx, cy - d, h);
    return { angle: Math.atan2(gy, gx) * 180 / Math.PI, strength: Math.sqrt(gx * gx + gy * gy) / 255 };
}

function sampleStats(img, cx, cy, half) {
    const s = img.s;
    let x0 = Math.floor((cx - half - img.bb.x) * s), x1 = Math.ceil((cx + half - img.bb.x) * s);
    let y0 = Math.floor((cy - half - img.bb.y) * s), y1 = Math.ceil((cy + half - img.bb.y) * s);
    if (x1 <= x0) x1 = x0 + 1;
    if (y1 <= y0) y1 = y0 + 1;
    const total = (x1 - x0) * (y1 - y0);
    x0 = Math.max(0, x0); y0 = Math.max(0, y0);
    x1 = Math.min(img.W, x1); y1 = Math.min(img.H, y1);
    let r = 0, g = 0, b = 0, r2 = 0, g2 = 0, b2 = 0, a = 0;
    const W = img.W, u = img.px;
    for (let y = y0; y < y1; y++) {
        let k = (y * W + x0) * 4;
        for (let x = x0; x < x1; x++, k += 4) {
            const al = u[k + 3];
            if (al) {
                const R = u[k], G = u[k + 1], B = u[k + 2];
                r += R * al; g += G * al; b += B * al;
                r2 += R * R * al; g2 += G * G * al; b2 += B * B * al; a += al;
            }
        }
    }
    if (a === 0 || total <= 0) return { cover: 0, std: 0 };
    const mr = r / a, mg = g / a, mb = b / a;
    const v = Math.max(0, r2 / a - mr * mr) + Math.max(0, g2 / a - mg * mg) + Math.max(0, b2 / a - mb * mb);
    return { cover: a / (total * 255), std: Math.sqrt(v / 3) / 255 };
}

function buildAdaptive(img, p) {
    const out = [];
    const base = buildLattice(img.bb, Object.assign({}, p, { arrange: 0 }));
    const ga = gridAngleRad(p), ca = Math.cos(ga), sa = Math.sin(ga);
    function visit(cx, cy, pitch) {
        const st = sampleStats(img, cx, cy, pitch / 2);
        if (st.cover <= 0) return;
        const childPitch = pitch / 2;
        const canSplit = (childPitch - p.gap) >= p.adaptMin;
        const needSplit = st.std * 100 > p.detail || st.cover < 0.95;
        if (canSplit && needSplit) {
            const q = childPitch / 2;
            for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]])
                visit(cx + (sx * ca - sy * sa) * q, cy + (sx * sa + sy * ca) * q, childPitch);
        } else {
            out.push({ x: cx, y: cy, flip: false, sz: Math.max(0.5, pitch - p.gap), cp: pitch });
        }
    }
    for (const c of base) visit(c.x, c.y, p.size + p.gap);
    return out;
}

function clipHalf(poly, px, py, nx, ny, off) {
    const res = [];
    const f = q => (q[0] - px) * nx + (q[1] - py) * ny + off;
    for (let i = 0; i < poly.length; i++) {
        const A = poly[i], B = poly[(i + 1) % poly.length];
        const fa = f(A), fb = f(B);
        if (fa <= 0) res.push(A);
        if ((fa <= 0) !== (fb <= 0)) {
            const t = fa / (fa - fb);
            res.push([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t]);
        }
    }
    return res;
}
function polyCentroid(poly) {
    let A = 0, cx = 0, cy = 0;
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const cr = a[0] * b[1] - b[0] * a[1];
        A += cr; cx += (a[0] + b[0]) * cr; cy += (a[1] + b[1]) * cr;
    }
    if (Math.abs(A) < 1e-9) return [poly[0][0], poly[0][1]];
    return [cx / (3 * A), cy / (3 * A)];
}
function buildVoronoi(bb, p) {
    const P = p.size + p.gap;
    const rng = mulberry32((p.seed | 0) + 101);
    const nx = Math.ceil(bb.width / P) + 4, ny = Math.ceil(bb.height / P) + 4;
    const x0 = bb.x + bb.width / 2 - (nx - 1) / 2 * P, y0 = bb.y + bb.height / 2 - (ny - 1) / 2 * P;
    const amp = Math.max(0, Math.min(100, p.irregular)) / 100 * 0.5 * P;
    const seeds = [];
    for (let j = 0; j < ny; j++) {
        const row = [];
        for (let i = 0; i < nx; i++) row.push([x0 + i * P + (rng() * 2 - 1) * amp, y0 + j * P + (rng() * 2 - 1) * amp]);
        seeds.push(row);
    }
    const cells = [];
    for (let j = 1; j < ny - 1; j++) {
        for (let i = 1; i < nx - 1; i++) {
            const s0 = seeds[j][i];
            const R = 2 * P;
            let tile = [[s0[0] - R, s0[1] - R], [s0[0] + R, s0[1] - R], [s0[0] + R, s0[1] + R], [s0[0] - R, s0[1] + R]];
            let grout = tile.slice();
            for (let dj = -2; dj <= 2 && tile.length >= 3; dj++) {
                for (let di = -2; di <= 2; di++) {
                    if (!di && !dj) continue;
                    const jj = j + dj, ii = i + di;
                    if (jj < 0 || ii < 0 || jj >= ny || ii >= nx) continue;
                    const s1 = seeds[jj][ii];
                    let dx = s1[0] - s0[0], dy = s1[1] - s0[1];
                    const L = Math.sqrt(dx * dx + dy * dy);
                    if (L < 1e-6) continue;
                    dx /= L; dy /= L;
                    const mx = (s0[0] + s1[0]) / 2, my = (s0[1] + s1[1]) / 2;
                    tile = clipHalf(tile, mx, my, dx, dy, p.gap / 2);
                    grout = clipHalf(grout, mx, my, dx, dy, -0.5);
                    if (tile.length < 3) break;
                }
            }
            if (tile.length < 3) continue;
            const c = polyCentroid(tile);
            cells.push({ x: c[0], y: c[1], flip: false, sz: p.size, cp: P, poly: tile, gpoly: grout });
        }
    }
    return cells;
}

function isGridForm(form) {
    return !(form === F_HEX || form === F_TRIANGLE || form === F_VORONOI);
}

function computeElements(base, p, templates, rng) {
    const adaptive = p.adaptive && isGridForm(p.form);
    const isVor = p.form === F_VORONOI;
    const img = renderBase(base, adaptive ? Math.max(1, p.adaptMin + p.gap) : p.size + p.gap);
    let cells;
    if (isVor) cells = buildVoronoi(img.bb, p);
    else if (adaptive) cells = buildAdaptive(img, p);
    else cells = buildLattice(img.bb, p);
    const elems = [];
    let tplIdx = 0;
    const sMin = Math.min(p.sizeMin, p.sizeMax), sMax = Math.max(p.sizeMin, p.sizeMax);
    for (const c of cells) {
        const half = c.sz / 2;
        const sm = (p.colourSrc === 1)
            ? sampleBox(img, c.x, c.y, Math.max(0.75 / img.s, c.sz * 0.08))
            : sampleBox(img, c.x, c.y, half);
        if (!sm) continue;
        const cover = (p.colourSrc === 1) ? (sampleBox(img, c.x, c.y, half) || { cover: 0 }).cover : sm.cover;
        if (cover * 100 < p.minCover) continue;
        let f = 1;
        if (p.sizeMode > 0) {
            const L = (0.2126 * sm.r + 0.7152 * sm.g + 0.0722 * sm.b) / 255;
            const t = (p.sizeMode === 1) ? (1 - L) : L;
            f = p.minSize / 100 + (1 - p.minSize / 100) * t;
        }
        let rot = 0, dx = 0, dy = 0;
        if (!isVor) {
            let baseAng = gridAngleRad(p) * 180 / Math.PI;   // tiles follow the rotated rows
            if (p.orient > 0) {
                const ed = edgeAngle(img, c.x, c.y, c.sz);
                if (ed.strength * 100 >= p.edgeThresh) baseAng = ed.angle + (p.orient === 1 ? 90 : 0);
            }
            let jit = p.rotJitter > 0 ? (rng() * 2 - 1) * p.rotJitter : 0;
            if (p.rotInc > 0) jit = Math.round(jit / p.rotInc) * p.rotInc;
            rot = baseAng + p.rotation + jit;
            dx = p.jitX > 0 ? (rng() * 2 - 1) * p.jitX : 0;
            dy = p.jitY > 0 ? (rng() * 2 - 1) * p.jitY : 0;
        }
        const wj = p.strokeWJit > 0 ? Math.max(0, 1 + (rng() * 2 - 1) * p.strokeWJit / 100) : 1;
        if (sMin !== 0 || sMax !== 0) f *= Math.max(0.01, 1 + (sMin + rng() * (sMax - sMin)) / 100);
        let tpl = -1;
        if (p.form === F_TEMPLATE && templates.length > 0) {
            tpl = (p.tplMix === 0) ? Math.floor(rng() * templates.length) % templates.length
                                   : (tplIdx++ % templates.length);
        }
        elems.push({
            x: c.x + dx, y: c.y + dy, cx: c.x, cy: c.y, flip: c.flip, scale: c.sz * f, f: f, cp: c.cp,
            poly: c.poly || null, gpoly: c.gpoly || null, rot: rot, tpl: tpl, wj: wj,
            r: Math.round(sm.r), g: Math.round(sm.g), b: Math.round(sm.b),
            a: p.useAlpha ? Math.max(1, Math.min(255, Math.round(cover * 255))) : 255
        });
    }
    return { elems: elems, bb: img.bb };
}

function applyColourStage(allLists, p, rng, paletteObjs) {
    const list = [];
    for (const l of allLists) for (const e of l) list.push(e);
    if (p.hJit > 0 || p.sJit > 0 || p.lJit > 0) {
        for (const e of list) {
            const hsl = rgb2hsl(e.r, e.g, e.b);
            const h = hsl[0] + (rng() * 2 - 1) * p.hJit;
            const s = clamp01(hsl[1] + (rng() * 2 - 1) * p.sJit / 100);
            const l = clamp01(hsl[2] + (rng() * 2 - 1) * p.lJit / 100);
            const c = hsl2rgb(h, s, l);
            e.r = c[0]; e.g = c[1]; e.b = c[2];
        }
    }
    let pal = null;
    if (p.palMode === 1) pal = kmeans(list.map(e => [e.r, e.g, e.b]), Math.max(2, Math.round(p.palCount)), mulberry32((p.seed | 0) + 7));
    else if (p.palMode === 2) pal = paletteObjs;
    if (pal && pal.length) {
        for (const e of list) { const c = nearest([e.r, e.g, e.b], pal); e.r = c[0]; e.g = c[1]; e.b = c[2]; }
    }
    return pal ? pal.length : 0;
}

function createMosaic(doc, base, elems, p, templateShapes, baseBB, fin) {
    const anchor = insertionAnchor(base);

    const shapeCache = {};
    function shapeFor(e) {
        if (p.form === F_TEMPLATE) return templateShapes[e.tpl];
        if (p.form === F_VORONOI) return null;
        const key = p.form + (e.flip ? 'f' : '');
        if (!shapeCache[key]) shapeCache[key] = unitShape(p.form, e.flip);
        return shapeCache[key];
    }

    const noFill = FillDescriptor.createNone();
    // v7: stroke alignment directly in the line style (instead of a separate command)
    const align = (p.stroke && p.strokeAlign > 0) ? (p.strokeAlign === 1 ? StrokeAlignment.Inside : StrokeAlignment.Outside) : null;
    function mkLsd(w) {
        const d = LineStyleDescriptor.createDefault(w);
        return align ? LineStyleDescriptor.create(d.lineStyle, { strokeAlignment: align }) : d;
    }
    const lsd = mkLsd(p.stroke ? Math.max(0, p.strokeW) : 0);
    const lsdCache = {};
    function lineStyleFor(e) {
        if (!p.stroke || p.strokeWJit <= 0) return lsd;
        const w = Math.round(Math.max(0, p.strokeW * e.wj) * 100) / 100;
        if (!lsdCache[w]) lsdCache[w] = mkLsd(w);
        return lsdCache[w];
    }
    const fixedStroke = (p.stroke && p.strokeColMode === 0)
        ? FillDescriptor.createSolid(RGBA8(p.strokeCol.r, p.strokeCol.g, p.strokeCol.b, p.strokeCol.alpha)) : null;
    function strokeFill(e) {
        if (!p.stroke || p.strokeW <= 0) return noFill;
        if (fixedStroke) return fixedStroke;
        let k = 0;
        if (p.strokeColMode === 2) k = -p.strokeShade / 100;
        if (p.strokeColMode === 3) k = p.strokeShade / 100;
        const sh = v => Math.round(k < 0 ? v * (1 + k) : v + (255 - v) * k);
        return FillDescriptor.createSolid(RGBA8(sh(e.r), sh(e.g), sh(e.b), e.a));
    }
    const defs = [];
    let n = 0;
    // grout area as the bottom object
    let hasGrout = false;
    if (p.groutMode > 0) {
        const gpc = PolyCurve.create();
        if (p.groutMode === 2) {
            gpc.addCurve(Curve.createRectangle({ x: baseBB.x, y: baseBB.y, width: baseBB.width, height: baseBB.height }));
        } else {
            const cache = {};
            for (const e of elems) {
                if (e.gpoly) {
                    const gp = polyFromPoints(e.gpoly);
                    for (let i = 0; i < gp.curveCount; i++) gpc.addCurve(gp.at(i));
                    continue;
                }
                const cellScale = e.cp;
                const k = (cellScale + 1) / cellScale;
                const key = (p.form === F_TRIANGLE && e.flip) ? 'f' : 'n';
                if (!cache[key]) cache[key] = (p.form === F_HEX || p.form === F_TRIANGLE) ? unitShape(p.form, e.flip) : unitShape(F_SQUARE, false);
                const c = cache[key].clone();
                c.transform(Transform.createTranslate(e.cx, e.cy).multiply(Transform.createRotate(gridAngleRad(p))).multiply(Transform.createScale(cellScale * k)));
                for (let i = 0; i < c.curveCount; i++) gpc.addCurve(c.at(i));
            }
        }
        const gc = p.groutCol;
        const gdef = PolyCurveNodeDefinition.create(gpc, FillDescriptor.createSolid(RGBA8(gc.r, gc.g, gc.b, gc.alpha)), noFill, LineStyleDescriptor.createDefault(0), noFill);
        gdef.userDescription = 'Grout';
        defs.push(gdef);
        hasGrout = true;
    }
    for (const e of elems) {
        let pc;
        if (e.poly) {
            const f = e.f;
            pc = polyFromPoints(f === 1 ? e.poly : e.poly.map(q => [e.cx + (q[0] - e.cx) * f, e.cy + (q[1] - e.cy) * f]));
        } else {
            const unit = shapeFor(e);
            if (!unit) continue;
            const tf = Transform.createTranslate(e.x, e.y)
                .multiply(Transform.createRotate(e.rot * Math.PI / 180))
                .multiply(Transform.createScale(e.scale));
            pc = unit.clone();
            pc.transform(tf);
        }
        const fd = FillDescriptor.createSolid(RGBA8(e.r, e.g, e.b, e.a));
        defs.push(PolyCurveNodeDefinition.create(pc, fd, strokeFill(e), lineStyleFor(e), noFill));
        n++;
    }
    if (n === 0) return null;
    // clip: copy of the base object (moved into the group as a mask by the finishing command)
    let dup = null;
    if (p.clip) {
        const dcmd = DocumentCommand.createTransform(Selection.create(doc, [base]), Transform.createIdentity(), { duplicateNodes: true });
        docExec(doc, dcmd);
        try { dup = Array.from(dcmd.newNodes)[0] || null; } catch (e) { }
        if (dup && !RUN.sentinel) RUN.sentinel = dup;
    }
    const cmd = addAbove(anchor, defs);
    docExec(doc, cmd);
    const newNodes = Array.from(cmd.newNodes);
    if (newNodes.length !== defs.length) throw new Error('Tiles could not be created.');
    RUN.sentinel = RUN.sentinel && RUN.sentinel !== dup ? RUN.sentinel : newNodes[0];
    docExec(doc, DocumentCommand.createGroupNodes(Selection.create(doc, newNodes)));
    const grp = newNodes[0].parent;
    if (hasGrout) {
        let groutNode = null;
        for (const k of newNodes) if (k.userDescription === 'Grout') { groutNode = k; break; }
        if (groutNode) fin.push(DocumentCommand.createSetWindingMode(Selection.create(doc, [groutNode]), WindingOrder.NonZero));
    }
    fin.push(DocumentCommand.createSetDescription(grp.selfSelection, 'Mosaic – ' + nodeName(base)));
    if (dup) {
        fin.push(DocumentCommand.createSetVisibility(Selection.create(doc, [dup]), true));
        fin.push(DocumentCommand.createMoveNodes(Selection.create(doc, [dup]), grp, NodeMoveType.Inside, NodeChildType.Enclosure));
    }
    return grp;
}

function zOrderIndex(doc) {
    const map = [];
    (function walk(n) {
        for (const c of n.children.toArray()) {
            map.push(c);
            if (c.children && c.children.length > 0) walk(c);
        }
    })(doc.currentSpread);
    return function (node) {
        for (let i = 0; i < map.length; i++) if (map[i].isSameNode(node)) return i;
        return -1;
    };
}

function analyseSelection(doc, wantTemplate, given) {
    const sel = given ? given.slice() : doc.selection.nodes.toArray();
    const nm = n => (n.userDescription || '');
    const palNodes = sel.filter(n => nm(n).indexOf(PALETTE_PREFIX) === 0);
    let tplNodes = sel.filter(n => nm(n).indexOf(TEMPLATE_PREFIX) === 0);
    let bases = sel.filter(n => nm(n).indexOf(TEMPLATE_PREFIX) !== 0 && nm(n).indexOf(PALETTE_PREFIX) !== 0);
    if (wantTemplate && tplNodes.length === 0 && bases.length >= 2) {
        const zi = zOrderIndex(doc);
        let top = bases[0], topZ = zi(bases[0]);
        for (const b of bases) { const z = zi(b); if (z > topZ) { top = b; topZ = z; } }
        tplNodes = [top];
        bases = bases.filter(b => !b.isSameNode(top));
    }
    return { all: sel, bases: bases, templates: tplNodes, palette: palNodes };
}

function runMosaic(doc, info, p, finalApply) {
    const wantTpl = p.form === F_TEMPLATE;
    const tplShapes = [];
    if (wantTpl) {
        for (const t of info.templates) { const s = buildTemplateShape(t); if (s) tplShapes.push(s); }
        if (tplShapes.length === 0) return { ok: false, msg: 'No usable template (curve/shape/text, name "_MO…" or topmost object).' };
    }
    let palObjs = null;
    if (p.palMode === 2) {
        palObjs = [];
        for (const n of info.palette) collectPaletteColours(n, palObjs);
        if (palObjs.length === 0) return { ok: false, msg: 'Palette "from objects": no objects named "_MF…" (solid/gradient) selected.' };
    }
    const rng = mulberry32(p.seed | 0);
    const all = [];
    let total = 0;
    for (const b of info.bases) {
        const r = computeElements(b, p, tplShapes, rng);
        total += r.elems.length;
        all.push({ base: b, els: r.elems, bb: r.bb });
    }
    const palN = applyColourStage(all.map(a => a.els), p, mulberry32((p.seed | 0) + 13), palObjs);
    if (total === 0) return { ok: false, msg: 'No mosaic tiles – minimum coverage too high or object empty?' };
    if (total > MAX_ELEMENTS) return { ok: false, msg: total + ' tiles – more than ' + MAX_ELEMENTS + '. Increase the tile size.' };

    const groups = [], fin = [];
    for (const it of all) {
        if (it.els.length === 0) continue;
        const g = createMosaic(doc, it.base, it.els, p, tplShapes, it.bb, fin);
        if (g) groups.push(g);
    }
    if (!groups.length) return { ok: false, msg: 'No mosaic tiles created.' };
    // v7: finish as ONE compound command (grout fill rule, names, mask, base, selection)
    if (p.baseMode === 1 || (p.baseMode === 2 && !finalApply)) {
        fin.push(DocumentCommand.createSetVisibility(Selection.create(doc, info.bases), false));
    } else if (p.baseMode === 2 && finalApply) {
        fin.push(DocumentCommand.createDeleteSelection(Selection.create(doc, info.bases), true));
    }
    fin.push(DocumentCommand.createSetSelection(Selection.create(doc, groups)));
    const cb = CompoundCommandBuilder.create();
    for (const c of fin) cb.addCommand(c);
    docExec(doc, cb.createCommand());
    return { ok: true, msg: total + ' tiles in ' + groups.length + ' group(s)' + (palN ? ', ' + palN + ' palette colours.' : '.'), count: total };
}

// v7: undo exactly the last run's own commands – only if the sentinel object still
// exists (otherwise it was already undone). Independent of the history position.
function rollback(doc) {
    const r = RUN; RUN = null;
    if (!r || r.steps <= 0) return;
    if (r.sentinel && !nodeInDoc(doc, r.sentinel)) return;
    for (let i = 0; i < r.steps; i++) { try { doc.history.undo(); } catch (e) { break; } }
}


function sanitizePresetName(name) {
    return name.trim().replace(/[^a-zA-Z0-9 _-]/g, '_').slice(0, 80);
}

function main() {
    const doc = Document.current;
    if (!doc) { app.alert('No document open.', SCRIPT_TITLE); return; }
    const startInfo = analyseSelection(doc, false);
    if (startInfo.all.length === 0) {
        app.alert('Please select a base object (optionally also a template object).', SCRIPT_TITLE);
        return;
    }
    const originalSel = startInfo.all;
    let hasPreview = false;
    let lastParamsKey = '';

    const dlg = Dialog.create(SCRIPT_TITLE);
    dlg.initialWidth = 900;
    dlg.setIsResizable(true);
    const colNav = dlg.addColumn(); colNav.widthProportion = 0.26;
    const colA = dlg.addColumn(); colA.widthProportion = 0.37;
    const colB = dlg.addColumn(); colB.widthProportion = 0.37;

    const gNav = colNav.addGroup('Tabs');
    const rgPage = gNav.addRadioGroup('', PAGES, 0);
    try { rgPage.selectedIndex = 0; } catch (e) { }
    const gAct = colNav.addGroup('Action');
    const btnPreview = gAct.addButton('Preview'); btnPreview.setIsFullWidth(true);
    const btnSeed = gAct.addButton('New seed + preview'); btnSeed.setIsFullWidth(true);
    const txtStatus = gAct.addStaticText('', 'Selection: ' + startInfo.all.length + ' object(s).');
    const gPre = colNav.addGroup('Presets');
    const btnSave = gPre.addButton('Save'); btnSave.setIsFullWidth(true);
    const btnLoad = gPre.addButton('Load'); btnLoad.setIsFullWidth(true);
    const btnDel = gPre.addButton('Delete'); btnDel.setIsFullWidth(true);

    function uve(g, label, unit, val, min, max) {
        const e = g.addUnitValueEditor(label, unit, unit, val, min, max);
        e.value = val; e.setIsFullWidth(true);
        return e;
    }
    function combo(g, label, items, idx) {
        const c = g.addComboBox(label, items, idx);
        try { c.selectedIndex = idx; } catch (e) { }
        c.setIsFullWidth(true);
        return c;
    }

    const gForm = colA.addGroup('Shape');
    const cbForm = combo(gForm, 'Shape', FORMS, DEFAULTS.form);
    const cbArr = combo(gForm, 'Arrangement', ARRANGE, DEFAULTS.arrange);
    const edGridRot = uve(gForm, 'Grid rotation', UnitType.Degree, DEFAULTS.gridRot, -180, 180);
    const cbMix = combo(gForm, 'Template mix', TPL_MIX, DEFAULTS.tplMix);
    const edIrreg = uve(gForm, 'Voronoi irregularity', UnitType.Percentage, DEFAULTS.irregular, 0, 100);
    const gAdapt = colA.addGroup('Adaptive size (detail)');
    const chkAdapt = gAdapt.addCheckBox('Adapt tile size to detail', DEFAULTS.adaptive);
    const edAdaptMin = uve(gAdapt, 'Smallest size', UnitType.Pixel, DEFAULTS.adaptMin, 1, 5000);
    const edDetail = uve(gAdapt, 'Detail threshold', UnitType.Percentage, DEFAULTS.detail, 0, 100);
    const gSize = colB.addGroup('Size & spacing');
    const edSize = uve(gSize, 'Tile size', UnitType.Pixel, DEFAULTS.size, 1, 5000);
    const edGap = uve(gSize, 'Spacing', UnitType.Pixel, DEFAULTS.gap, 0, 5000);
    gSize.addStaticText('', 'Template: name "_MO…" or topmost selected object.');

    const gRot = colA.addGroup('Rotation');
    const edRot = uve(gRot, 'Angle', UnitType.Degree, DEFAULTS.rotation, -360, 360);
    const edRotJ = uve(gRot, 'Jitter ±', UnitType.Degree, DEFAULTS.rotJitter, 0, 180);
    const edRotInc = uve(gRot, 'Increment (0 = continuous)', UnitType.Degree, DEFAULTS.rotInc, 0, 180);
    const cbOrient = combo(gRot, 'Orientation', ORIENT, DEFAULTS.orient);
    const edEdge = uve(gRot, 'Edge threshold', UnitType.Percentage, DEFAULTS.edgeThresh, 0, 100);
    const gJit = colB.addGroup('Position & size');
    const edJitX = uve(gJit, 'Jitter X ±', UnitType.Pixel, DEFAULTS.jitX, 0, 5000);
    const edJitY = uve(gJit, 'Jitter Y ±', UnitType.Pixel, DEFAULTS.jitY, 0, 5000);
    const edSizeMin = uve(gJit, 'Size min', UnitType.Percentage, DEFAULTS.sizeMin, -95, 500);
    const edSizeMax = uve(gJit, 'Size max', UnitType.Percentage, DEFAULTS.sizeMax, -95, 500);
    const edSeed = uve(gJit, 'Seed', UnitType.Number, DEFAULTS.seed, 0, 999999);
    edSeed.precision = 0;

    const gCol = colA.addGroup('Sampling');
    const cbSrc = combo(gCol, 'Colour source', COLOUR_SRC, DEFAULTS.colourSrc);
    const edCover = uve(gCol, 'Min. coverage', UnitType.Percentage, DEFAULTS.minCover, 0, 100);
    const chkAlpha = gCol.addCheckBox('Use opacity', DEFAULTS.useAlpha);
    const gBright = colA.addGroup('Size by brightness');
    const cbSizeMode = combo(gBright, 'Mode', SIZE_MODE, DEFAULTS.sizeMode);
    const edMinSize = uve(gBright, 'Minimum size', UnitType.Percentage, DEFAULTS.minSize, 1, 100);

    const gPal = colB.addGroup('Colour palette');
    const cbPal = combo(gPal, 'Palette', PAL_MODE, DEFAULTS.palMode);
    const edPalN = uve(gPal, 'Number of colours', UnitType.Number, DEFAULTS.palCount, 2, 256);
    edPalN.precision = 0;
    gPal.addStaticText('', 'Custom palette: also select objects named "_MF…" (solid fills, gradient stops, groups).');
    const gHsl = colB.addGroup('Colour jitter (HSL)');
    const edHJ = uve(gHsl, 'Hue ±', UnitType.Degree, DEFAULTS.hJit, 0, 180);
    const edSJ = uve(gHsl, 'Saturation ±', UnitType.Percentage, DEFAULTS.sJit, 0, 100);
    const edLJ = uve(gHsl, 'Lightness ±', UnitType.Percentage, DEFAULTS.lJit, 0, 100);

    const gStroke = colA.addGroup('Stroke');
    const chkStroke = gStroke.addCheckBox('Draw stroke', DEFAULTS.stroke);
    const edStrokeW = uve(gStroke, 'Width', UnitType.Pixel, DEFAULTS.strokeW, 0, 500);
    const edStrokeWJ = uve(gStroke, 'Width ±', UnitType.Percentage, DEFAULTS.strokeWJit, 0, 100);
    const cbAlign = combo(gStroke, 'Alignment', STROKE_ALIGN, DEFAULTS.strokeAlign);
    const gStrokeCol = colB.addGroup('Stroke colour');
    const cbStrokeCol = combo(gStrokeCol, 'Colour', STROKE_COL, DEFAULTS.strokeColMode);
    const cpStroke = gStrokeCol.addColourPicker('Fixed colour', RGBA8(0, 0, 0, 255));
    const edShade = uve(gStrokeCol, 'Amount', UnitType.Percentage, DEFAULTS.strokeShade, 0, 100);

    const gGrout = colA.addGroup('Grout area');
    const cbGrout = combo(gGrout, 'Grout area', GROUT_MODE, DEFAULTS.groutMode);
    const cpGrout = gGrout.addColourPicker('Grout colour', RGBA8(60, 60, 60, 255));
    const gOut = colB.addGroup('Output');
    const cbBase = combo(gOut, 'Base object', BASE_MODE, DEFAULTS.baseMode);
    const chkClip = gOut.addCheckBox('Clip to silhouette', DEFAULTS.clip);
    gOut.addStaticText('', 'Clip: a copy of the base object is used as mask. Tip: lower the minimum coverage so the edges are filled.');

    const PAGE_GROUPS = [[gForm, gAdapt, gSize], [gRot, gJit], [gCol, gBright, gPal, gHsl], [gStroke, gStrokeCol], [gGrout, gOut]];
    function showPage(idx) {
        try {
            PAGE_GROUPS.forEach((grs, i) => grs.forEach(g => { g.isVisible = (i === idx); }));
        } catch (e) {
            PAGE_GROUPS.forEach(grs => grs.forEach(g => { try { g.isVisible = true; } catch (e2) { } }));
        }
    }
    rgPage.setOnValueChangedHandler(function () { showPage(rgPage.selectedIndex); });
    showPage(0);

    function readParams() {
        return {
            form: cbForm.selectedIndex, arrange: cbArr.selectedIndex, tplMix: cbMix.selectedIndex,
            size: Math.max(1, edSize.value), gap: Math.max(0, edGap.value),
            rotation: edRot.value, rotJitter: Math.max(0, edRotJ.value), seed: Math.round(edSeed.value),
            colourSrc: cbSrc.selectedIndex, minCover: edCover.value, useAlpha: !!chkAlpha.value,
            sizeMode: cbSizeMode.selectedIndex, minSize: edMinSize.value, baseMode: cbBase.selectedIndex,
            jitX: Math.max(0, edJitX.value), jitY: Math.max(0, edJitY.value), sizeMin: edSizeMin.value, sizeMax: edSizeMax.value,
            rotInc: Math.max(0, edRotInc.value), adaptive: !!chkAdapt.value, adaptMin: Math.max(1, edAdaptMin.value),
            detail: edDetail.value, irregular: edIrreg.value, gridRot: edGridRot.value,
            stroke: !!chkStroke.value, strokeW: Math.max(0, edStrokeW.value), strokeColMode: cbStrokeCol.selectedIndex,
            strokeShade: edShade.value, strokeCol: readColour(cpStroke, DEFAULTS.strokeCol),
            orient: cbOrient.selectedIndex, edgeThresh: edEdge.value,
            palMode: cbPal.selectedIndex, palCount: Math.round(edPalN.value),
            hJit: Math.max(0, edHJ.value), sJit: Math.max(0, edSJ.value), lJit: Math.max(0, edLJ.value),
            strokeAlign: cbAlign.selectedIndex, strokeWJit: Math.max(0, edStrokeWJ.value),
            groutMode: cbGrout.selectedIndex, groutCol: readColour(cpGrout, DEFAULTS.groutCol), clip: !!chkClip.value
        };
    }
    function readColour(cp, def) {
        try { const c = cp.value; if (c) { const v = c.rgba8; return { r: v.r, g: v.g, b: v.b, alpha: v.alpha }; } } catch (e) { }
        return Object.assign({}, def);
    }
    function writeParams(q) {
        const v = Object.assign({}, DEFAULTS, q);
        if (q.sizeJit !== undefined && q.sizeMin === undefined) { v.sizeMin = -q.sizeJit; v.sizeMax = q.sizeJit; }
        cbForm.selectedIndex = v.form; cbArr.selectedIndex = v.arrange; cbMix.selectedIndex = v.tplMix;
        edSize.value = v.size; edGap.value = v.gap; edRot.value = v.rotation; edRotJ.value = v.rotJitter;
        edSeed.value = v.seed; cbSrc.selectedIndex = v.colourSrc; edCover.value = v.minCover;
        chkAlpha.value = !!v.useAlpha; cbSizeMode.selectedIndex = v.sizeMode; edMinSize.value = v.minSize;
        cbBase.selectedIndex = v.baseMode;
        edJitX.value = v.jitX; edJitY.value = v.jitY; edSizeMin.value = v.sizeMin; edSizeMax.value = v.sizeMax;
        edRotInc.value = v.rotInc; chkAdapt.value = !!v.adaptive; edAdaptMin.value = v.adaptMin;
        edDetail.value = v.detail; edIrreg.value = v.irregular; edGridRot.value = v.gridRot;
        chkStroke.value = !!v.stroke; edStrokeW.value = v.strokeW; cbStrokeCol.selectedIndex = v.strokeColMode;
        edShade.value = v.strokeShade;
        try { const c = v.strokeCol || DEFAULTS.strokeCol; cpStroke.value = RGBA8(c.r, c.g, c.b, c.alpha); } catch (e) { }
        try { const c = v.groutCol || DEFAULTS.groutCol; cpGrout.value = RGBA8(c.r, c.g, c.b, c.alpha); } catch (e) { }
        cbOrient.selectedIndex = v.orient; edEdge.value = v.edgeThresh;
        cbPal.selectedIndex = v.palMode; edPalN.value = v.palCount;
        edHJ.value = v.hJit; edSJ.value = v.sJit; edLJ.value = v.lJit;
        cbAlign.selectedIndex = v.strokeAlign; edStrokeWJ.value = v.strokeWJit;
        cbGrout.selectedIndex = v.groutMode; chkClip.value = !!v.clip;
        updateEnabled();
    }
    function updateEnabled() {
        try {
            const f = cbForm.selectedIndex;
            const grid = isGridForm(f), vor = (f === F_VORONOI), ad = !!chkAdapt.value;
            chkAdapt.isEnabled = grid;
            edAdaptMin.isEnabled = grid && ad; edDetail.isEnabled = grid && ad;
            cbArr.isEnabled = grid && !ad;
            edIrreg.isEnabled = vor;
            edGridRot.isEnabled = !vor;
            edRot.isEnabled = !vor; edRotJ.isEnabled = !vor; edRotInc.isEnabled = !vor;
            cbOrient.isEnabled = !vor; edJitX.isEnabled = !vor; edJitY.isEnabled = !vor;
            cbMix.isEnabled = (f === F_TEMPLATE);
            edMinSize.isEnabled = cbSizeMode.selectedIndex > 0;
            const st = !!chkStroke.value, cm = cbStrokeCol.selectedIndex;
            edStrokeW.isEnabled = st; cbStrokeCol.isEnabled = st;
            cpStroke.isEnabled = st && cm === 0;
            edShade.isEnabled = st && cm >= 2;
            edStrokeWJ.isEnabled = st; cbAlign.isEnabled = st;
            edEdge.isEnabled = !vor && cbOrient.selectedIndex > 0;
            edPalN.isEnabled = cbPal.selectedIndex === 1;
            cpGrout.isEnabled = cbGrout.selectedIndex > 0;
        } catch (e) { }
    }
    cbForm.setOnValueChangedHandler(updateEnabled);
    chkAdapt.setOnValueChangedHandler(updateEnabled);
    cbSizeMode.setOnValueChangedHandler(updateEnabled);
    chkStroke.setOnValueChangedHandler(updateEnabled);
    cbStrokeCol.setOnValueChangedHandler(updateEnabled);
    cbOrient.setOnValueChangedHandler(updateEnabled);
    cbPal.setOnValueChangedHandler(updateEnabled);
    cbGrout.setOnValueChangedHandler(updateEnabled);
    updateEnabled();

    function doRun(finalApply) {
        const p = readParams();
        rollback(doc);
        hasPreview = false;
        const info = analyseSelection(doc, p.form === F_TEMPLATE, originalSel);
        if (info.bases.length === 0) return { ok: false, msg: 'No base object in the selection (template only?).' };
        let res;
        RUN = { steps: 0, sentinel: null };
        try { res = runMosaic(doc, info, p, finalApply); }
        catch (e) { rollback(doc); return { ok: false, msg: 'Error: ' + e.message }; }
        if (!res.ok) { rollback(doc); return res; }
        hasPreview = true;
        lastParamsKey = JSON.stringify(p);
        return res;
    }

    btnPreview.setOnClickHandler(function () {
        const r = doRun(false);
        txtStatus.text = r.msg;
    });
    btnSeed.setOnClickHandler(function () {
        edSeed.value = 1 + Math.floor(Math.random() * 999998);
        const r = doRun(false);
        txtStatus.text = 'Seed ' + Math.round(edSeed.value) + ': ' + r.msg;
    });

    btnSave.setOnClickHandler(function () {
        const name = app.prompt('Preset name:', SCRIPT_TITLE, 'My mosaic');
        if (!name) return;
        try {
            FileSystemApi.createDirectories(PRESET_DIR);
            const path = PRESET_DIR + '/' + PRESET_PREFIX + sanitizePresetName(name) + '.json';
            const f = File.create(path, 'wb');
            f.writeStringAsUtf8(JSON.stringify(readParams(), null, 2));
            f.close();
            txtStatus.text = 'Preset saved: ' + PRESET_PREFIX + sanitizePresetName(name);
        } catch (e) { txtStatus.text = 'Saving failed: ' + e.message; }
    });
    btnLoad.setOnClickHandler(function () {
        const path = app.chooseFile();
        if (!path) return;
        try {
            writeParams(JSON.parse(File.readAll(path).toString()));
            txtStatus.text = 'Preset loaded.';
        } catch (e) { txtStatus.text = 'Loading failed: ' + e.message; }
    });
    btnDel.setOnClickHandler(function () {
        const path = app.chooseFile();
        if (!path) return;
        if (path.split(/[\\/]/).pop().indexOf(PRESET_PREFIX) !== 0) { txtStatus.text = 'Only mosaic presets can be deleted.'; return; }
        try { FileSystemApi.remove(path); txtStatus.text = 'Preset deleted.'; }
        catch (e) { txtStatus.text = 'Deleting failed: ' + e.message; }
    });

    const result = dlg.runModal();
    if (result.value !== DialogResult.Ok.value) {
        rollback(doc);
        if (!sameSelection(doc, originalSel)) { try { doc.executeCommand(DocumentCommand.createSetSelection(Selection.create(doc, originalSel))); } catch (e) { } }
        return;
    }
    const p = readParams();
    if (!hasPreview || JSON.stringify(p) !== lastParamsKey || p.baseMode === 2) {
        const r = doRun(true);
        if (!r.ok) app.alert(r.msg, SCRIPT_TITLE);
    }
}

main();
