// Objects on Nodes v14
// Places duplicates of the objects of a "base" group onto the curve nodes (anchor points) of
// the objects of a "target" group, including all subgroups. Each node receives exactly one
// base-object duplicate, centred on the node. Nodes closer than the distance tolerance are
// merged into one insertion point. The base→node assignment follows a selectable sequence
// (Random/Sequential/Reverse/Ping-pong). Colour, rotation and size jitter as in
// "Replace Objects"; the target objects stay unchanged.
//
// v2-v8: new group for all duplicates, one runModal(), presets subfolder,
//        group name "Node_Objects_<index>", text support.
// v9:  base/target via "_" name prefix, otherwise object count.
// v10: safe rollback at history position 0, OK recalculates when settings changed.
// v11: few history steps (duplicating in rounds, CompoundCommands).
// v12: GUI split into tabs (pages), as in "Transform Objects" v8.
// v13: Affinity 3.3.3 - toColour() for gradient stops.
//
// v14: performance and robust undo (result unchanged, compared live against v13):
//   • Duplicate and place in ONE command: every copy is created directly with its placement
//     matrix (createTransform with duplicateNodes). v13 duplicated in "rounds" (as many
//     commands as nodes received by the most frequent base object, e.g. 50 for 6 base objects
//     and 296 nodes) and checked every round with a signature comparison.
//   • Only 3 history steps in total: group (named right away), all copies, then colours +
//     sorting-in + group behind the target.
//   • Node points and placement are computed in JavaScript across the parent chain (no engine
//     query per point); tolerance merging via a grid instead of pairwise comparison.
//   • Placement now in spread coordinates: with a rotated base group of unequal X/Y size, the
//     position/size of the copies used to be distorted.
//   • Undo (preview/cancel/error) as in Power Duplicate v61: undo via the position difference,
//     otherwise a safety net deletes exactly the nodes this run created. Replaces the comparison
//     of all document nodes with a start list, which ran quadratically with the document size on
//     every preview and on cancel.
//   • Degenerate copies are no longer placed (determinant 0 → skipped instead of left at the
//     original position); notices (no nodes / skipped) are shown for the preview too.
(function () {
    const { Document } = require('/document');
    const { Selection } = require('/selections');
    const { DocumentCommand, AddChildNodesCommandBuilder, CompoundCommandBuilder } = require('/commands');
    const { ContainerNodeDefinition } = require('/nodes');
    const { Colour, Gradient } = require('/colours');
    const { FillDescriptor, SolidFill, GradientFill, HatchFill, BitmapFill, FillType, BlendMode } = require('/fills');
    const { Transform } = require('/geometry');
    const { RasterFormat } = require('/rasterobject');
    const { NodeMoveType, NodeChildType } = require('affinity:dom');
    const { Dialog, DialogResult, UnitType } = require('/dialog');
    const { app } = require('/application');
    const { StoryDelta } = require('/storydelta');

    const TITLE = 'Objects on Nodes';
    const doc = Document.current;
    if (!doc) { app.alert('No document open.', TITLE); return; }

    // Collects commands for ONE CompoundCommand (an empty compound throws INVALID_OP)
    function makeBatch() {
        const builder = CompoundCommandBuilder.create();
        let count = 0;
        return {
            add(cmd) { builder.addCommand(cmd); count++; },
            run() { let c = null; if (count > 0) { c = builder.createCommand(); doc.executeCommand(c); } return c; }
        };
    }

    function toArr(x) { try { return x.toArray ? x.toArray() : Array.from(x); } catch (e) { return []; } }

    // v13: version-safe wrapping (3.3.3+: already a Colour)
    function toColour(c) { return (c instanceof Colour) ? c : new Colour(c); }

    // ---------- v14: matrices (affine, [a,b,c,d,e,f]: x'=a*x+b*y+c, y'=d*x+e*y+f) ----------
    function mMul(A, B) { return [A[0]*B[0]+A[1]*B[3], A[0]*B[1]+A[1]*B[4], A[0]*B[2]+A[1]*B[5]+A[2], A[3]*B[0]+A[4]*B[3], A[3]*B[1]+A[4]*B[4], A[3]*B[2]+A[4]*B[5]+A[5]]; }
    function mApply(M, x, y) { return { x: M[0]*x+M[1]*y+M[2], y: M[3]*x+M[4]*y+M[5] }; }
    // Spread matrix of a node across the whole parent chain (node.transform is parent-local only)
    function spreadMat(node) {
        const d = node.transform.data; let m = [d[0], d[1], d[2], d[3], d[4], d[5]];
        let p = node.parent;
        while (p) { const q = p.transform.data; m = mMul([q[0], q[1], q[2], q[3], q[4], q[5]], m); p = p.parent; }
        return m;
    }

    // ---------- v14: undo without counting ----------
    // Undo via the difference of doc.history.position (exact). With a full history the position
    // does not rise (or too little) - then the safety net deletes everything this run created that
    // still exists. A node exists if its parent chain reaches the spread (verified live: undone
    // nodes have parent=null, and so do children of deleted groups).
    function isAlive(n) {
        try { let p = n ? n.parent : null; for (let i = 0; p && i < 64; i++) { if ((p[Symbol.toStringTag] || '') === 'SpreadNode') return true; p = p.parent; } } catch (e) { /* dead */ }
        return false;
    }
    function rollback(pos0, created) {
        const delta = doc.history.position - pos0;
        for (let i = 0; i < delta; i++) { try { doc.history.undo(); } catch (e) { break; } }
        if (created) for (const n of created) { if (isAlive(n)) { try { n.delete(); } catch (e) { /* ignore */ } } }
    }

    // ---------- Helpers ----------
    let rngFunc = Math.random;
    function mulberry32(seed) {
        let t = seed >>> 0;
        return function () {
            t += 0x6D2B79F5;
            let r = t;
            r = Math.imul(r ^ (r >>> 15), r | 1);
            r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
            return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
        };
    }
    function setSeed(seed) {
        rngFunc = (seed === 0 || seed == null) ? Math.random : mulberry32(seed);
    }
    function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
    function wrap01(v) { v = v % 1; if (v < 0) v += 1; return v; }
    function rand(min, max) { return min + rngFunc() * (max - min); }

    function jitterHSL(col, dh, ds, dl, da) {
        const h = col.hslaf;
        return Colour.createHSLAf({
            h: wrap01(h.h + dh / 360),
            s: clamp01(h.s + ds / 100),
            l: clamp01(h.l + dl / 100),
            alpha: clamp01(h.alpha + (da || 0) / 100)
        });
    }

    function rgbToHslJS(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        let hh = 0, ss = 0;
        const ll = (max + min) / 2;
        if (max !== min) {
            const d = max - min;
            ss = ll > 0.5 ? d / (2 - max - min) : d / (max + min);
            if (max === r) hh = ((g - b) / d + (g < b ? 6 : 0)) / 6;
            else if (max === g) hh = ((b - r) / d + 2) / 6;
            else hh = ((r - g) / d + 4) / 6;
        }
        return { h: hh, s: ss, l: ll };
    }
    function hslToRgbJS(h, s, l, maxVal) {
        let r, g, b;
        if (s === 0) {
            r = g = b = l;
        } else {
            const hue2rgb = (p, q, t) => {
                if (t < 0) t += 1;
                if (t > 1) t -= 1;
                if (t < 1 / 6) return p + (q - p) * 6 * t;
                if (t < 1 / 2) return q;
                if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
                return p;
            };
            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;
            r = hue2rgb(p, q, h + 1 / 3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1 / 3);
        }
        return { r: Math.round(r * maxVal), g: Math.round(g * maxVal), b: Math.round(b * maxVal) };
    }

    function jitterOwnFillDescriptor(fd, dh, ds, dl, da, transferBlend) {
        const fill = fd.fill;
        const ft = fill.fillType.value;
        const blendMode = transferBlend ? fd.blendMode : BlendMode.Normal;
        if (ft === FillType.Solid.value) {
            return FillDescriptor.createSolid(jitterHSL(fill.colour, dh, ds, dl, da), blendMode);
        }
        if (ft === FillType.Gradient.value) {
            const g = fill.gradient;
            const stops = [];
            for (let i = 0; i < g.stopCount; i++) {
                const st = g.getStop(i);
                const col = toColour(st.colour);
                stops.push({ colour: jitterHSL(col, dh, ds, dl, da), position: st.position, midpoint: st.midpoint });
            }
            const nf = GradientFill.create(Gradient.create(stops), fill.gradientFillType);
            return FillDescriptor.create(nf, fd.isScaleWithObject, fd.transform, blendMode, fd.isAnchoredToSpread);
        }
        if (ft === FillType.Hatch.value) {
            const nh = fill.clone();
            if (fill.penColour) nh.penColour = jitterHSL(fill.penColour, dh, ds, dl, da);
            if (fill.brushColour) nh.brushColour = jitterHSL(fill.brushColour, dh, ds, dl, da);
            return FillDescriptor.create(nh, fd.isScaleWithObject, fd.transform, blendMode, fd.isAnchoredToSpread);
        }
        if (ft === FillType.Bitmap.value) {
            const needsJitter = !(dh === 0 && ds === 0 && dl === 0 && da === 0);
            if (!needsJitter) {
                return transferBlend ? fd : FillDescriptor.create(fill, fd.isScaleWithObject, fd.transform, blendMode, fd.isAnchoredToSpread);
            }
            const src = fill.bitmap;
            const w = src.width, h = src.height;
            const fmt = src.format;
            const buf = src.createCompatibleBuffer(true);
            let arr, maxVal;
            if (fmt === RasterFormat.RGBA8.value) { arr = new Uint8Array(buf.buffer); maxVal = 255; }
            else if (fmt === RasterFormat.RGBA16.value) { arr = new Uint16Array(buf.buffer); maxVal = 65535; }
            else if (fmt === RasterFormat.RGBAUF.value) { arr = new Float32Array(buf.buffer); maxVal = 1; }
            else return fd;
            const dhFrac = dh / 360, dsFrac = ds / 100, dlFrac = dl / 100, daFrac = da / 100;
            for (let p = 0; p < w * h; p++) {
                const o = p * 4;
                if (arr[o + 3] === 0 && daFrac <= 0) continue;
                const hsl = rgbToHslJS(arr[o], arr[o + 1], arr[o + 2]);
                let nhh = hsl.h + dhFrac; nhh -= Math.floor(nhh);
                const nss = clamp01(hsl.s + dsFrac);
                const nll = clamp01(hsl.l + dlFrac);
                const rgb = hslToRgbJS(nhh, nss, nll, maxVal);
                arr[o] = rgb.r; arr[o + 1] = rgb.g; arr[o + 2] = rgb.b;
                if (daFrac !== 0) arr[o + 3] = Math.round(clamp01(arr[o + 3] / maxVal + daFrac) * maxVal);
            }
            const newBm = src.createCompatibleBitmap(false);
            buf.copyTo(newBm, { x: 0, y: 0, width: w, height: h }, 0, 0);
            const newFill = BitmapFill.create(newBm, fill.extendType, fill.upsamplerType, fill.isIgnoreAlpha);
            return FillDescriptor.create(newFill, fd.isScaleWithObject, fd.transform, blendMode, fd.isAnchoredToSpread);
        }
        return fd;
    }

    function isTextNode(node) {
        const tag = node[Symbol.toStringTag] || '';
        return tag === 'ArtTextNode' || tag === 'FrameTextNode';
    }
    function getFDFromNode(node, usePen) {
        if (isTextNode(node)) {
            const story = node.storyInterface && node.storyInterface.story;
            if (!story || story.length === 0) return null;
            const a = story.getGlyphAtts(0);
            return (usePen ? a.penFill : a.brushFill) || null;
        }
        if (usePen) return node.hasPenFill ? node.penFillDescriptor : null;
        return node.hasBrushFill ? node.brushFillDescriptor : null;
    }
    function addFDCommand(batch, node, fd, usePen) {
        if (isTextNode(node)) {
            const delta = usePen ? StoryDelta.createPenFill(fd) : StoryDelta.createBrushFill(fd);
            batch.add(DocumentCommand.createFormatText(node.selfSelection, delta));
        } else if (usePen) {
            batch.add(DocumentCommand.createSetPenFill(node.selfSelection, fd));
        } else {
            batch.add(DocumentCommand.createSetBrushFill(node.selfSelection, fd));
        }
    }

    function jitterRotation(rotMin, rotMax, increment) {
        if (increment && increment > 0) {
            const nSteps = Math.floor((rotMax - rotMin) / increment) + 1;
            const stepIdx = Math.floor(rand(0, nSteps));
            return rotMin + stepIdx * increment;
        }
        return rand(rotMin, rotMax);
    }

    // v14: placement transform from source data read in advance (spread matrix m, spread bbox bb).
    // Same random sequence as v13. Returns null for a degenerate matrix.
    function placeAtPointTF(si, point, p) {
        const m = si.m, bb = si.bb;
        const sx = Math.sqrt(m[0] * m[0] + m[3] * m[3]);
        const sy = Math.sqrt(m[1] * m[1] + m[4] * m[4]);
        const theta = Math.atan2(m[3], m[0]);
        const refDim = (bb.width + bb.height) / 2;

        const dRot = jitterRotation(p.rotMin, p.rotMax, p.rotIncrement);
        let scaleFactorX, scaleFactorY;
        if (p.preserveAspect) {
            const dSizePx = rand(p.sizePxXMin, p.sizePxXMax);
            const dSizePct = rand(p.sizePctXMin, p.sizePctXMax);
            const sf = (1 + dSizePct / 100) * (1 + (refDim > 0 ? dSizePx / refDim : 0));
            scaleFactorX = sf; scaleFactorY = sf;
        } else {
            const dSizePxX = rand(p.sizePxXMin, p.sizePxXMax);
            const dSizePctX = rand(p.sizePctXMin, p.sizePctXMax);
            scaleFactorX = (1 + dSizePctX / 100) * (1 + (refDim > 0 ? dSizePxX / refDim : 0));
            const dSizePxY = rand(p.sizePxYMin, p.sizePxYMax);
            const dSizePctY = rand(p.sizePctYMin, p.sizePctYMax);
            scaleFactorY = (1 + dSizePctY / 100) * (1 + (refDim > 0 ? dSizePxY / refDim : 0));
        }

        const finalSx = sx * scaleFactorX;
        const finalSy = sy * scaleFactorY;
        const finalTheta = theta + dRot * Math.PI / 180;

        const cosN = Math.cos(finalTheta), sinN = Math.sin(finalTheta);
        const m11z = finalSx * cosN, m12z = -finalSy * sinN;
        const m21z = finalSx * sinN, m22z = finalSy * cosN;

        const det = m[0] * m[4] - m[1] * m[3];
        if (Math.abs(det) < 1e-12) return null;
        const inv11 = m[4] / det, inv12 = -m[1] / det, inv21 = -m[3] / det, inv22 = m[0] / det;
        const d11 = m11z * inv11 + m12z * inv21, d12 = m11z * inv12 + m12z * inv22;
        const d21 = m21z * inv11 + m22z * inv21, d22 = m21z * inv12 + m22z * inv22;

        const rcx = bb.x + bb.width / 2, rcy = bb.y + bb.height / 2;
        const tx = point.x - (d11 * rcx + d12 * rcy);
        const ty = point.y - (d21 * rcx + d22 * rcy);

        const tf = Transform.createIdentity();
        const d = tf.data;
        d[0] = d11; d[1] = d12; d[2] = tx; d[3] = d21; d[4] = d22; d[5] = ty;
        return tf;
    }

    function buildMapping(nSrc, nDst, mode) {
        const map = [];
        if (mode === 0) {
            let prev = -1;
            for (let i = 0; i < nDst; i++) {
                let idx = Math.floor(rand(0, nSrc));
                if (nSrc > 1) { while (idx === prev) idx = Math.floor(rand(0, nSrc)); }
                map.push(idx); prev = idx;
            }
        } else if (mode === 1) {
            for (let i = 0; i < nDst; i++) map.push(i % nSrc);
        } else if (mode === 2) {
            for (let i = 0; i < nDst; i++) map.push((nSrc - 1) - (i % nSrc));
        } else {
            const period = nSrc === 1 ? 1 : 2 * (nSrc - 1);
            for (let i = 0; i < nDst; i++) { const mm = i % period; map.push(mm < nSrc ? mm : period - mm); }
        }
        return map;
    }

    function collectChildren(node) {
        const out = [];
        function walk(n) {
            if (n.children && n.children.length > 0) {
                for (const ch of n.children) walk(ch);
            } else {
                out.push(n);
            }
        }
        for (const ch of node.children) walk(ch);
        return out;
    }

    // v14: node points via ONE spread matrix per object (instead of an engine call per point and level)
    function getObjectAnchorPointsSpread(node) {
        if (!node.curvesInterface) return [];
        const pc = node.curvesInterface.polyCurve;
        const M = spreadMat(node);
        const pts = [];
        for (let ci = 0; ci < pc.curveCount; ci++) {
            const curve = pc.at(ci);
            const bez = curve.beziers.toArray();
            if (bez.length === 0) continue;
            for (let k = 0; k < bez.length; k++) pts.push(mApply(M, bez[k].start.x, bez[k].start.y));
            if (!curve.isClosed) { const e = bez[bez.length - 1].end; pts.push(mApply(M, e.x, e.y)); }
        }
        return pts;
    }

    // v14: tolerance merging via a grid (cell size = tolerance) instead of pairwise comparison;
    // same result as the linear search (a point is dropped as soon as an earlier insertion point
    // lies within the tolerance).
    function dedupeNodePoints(entries, tolerance) {
        const cs = tolerance > 0 ? tolerance : 1;
        const grid = new Map();
        const clusters = [];
        for (const e of entries) {
            const gx = Math.floor(e.x / cs), gy = Math.floor(e.y / cs);
            let found = false;
            for (let ix = gx - 1; ix <= gx + 1 && !found; ix++) {
                for (let iy = gy - 1; iy <= gy + 1 && !found; iy++) {
                    const cell = grid.get(ix + ',' + iy);
                    if (!cell) continue;
                    for (const c of cell) {
                        const dx = e.x - c.x, dy = e.y - c.y;
                        if (Math.sqrt(dx * dx + dy * dy) <= tolerance) { found = true; break; }
                    }
                }
            }
            if (found) continue;
            const c = { x: e.x, y: e.y, sourceNode: e.sourceNode };
            const key = gx + ',' + gy;
            let cell = grid.get(key); if (!cell) { cell = []; grid.set(key, cell); }
            cell.push(c);
            clusters.push(c);
        }
        return clusters;
    }

    function getNextGroupIndex() {
        let maxIdx = 0;
        for (const l of doc.layers.all) {
            let desc = null;
            try { desc = l.description; } catch (e) { continue; }
            if (typeof desc === 'string') {
                const m = desc.match(/^Node_Objects_(\d+)$/);
                if (m) {
                    const n = parseInt(m[1], 10);
                    if (n > maxIdx) maxIdx = n;
                }
            }
        }
        return maxIdx + 1;
    }

    // ---------- Determine groups ----------
    function findGroups() {
        if (doc.selection.length !== 2) return null;
        const a = doc.selection.at(0).node, b = doc.selection.at(1).node;
        if (!(a.children && a.children.length > 0) || !(b.children && b.children.length > 0)) return null;

        let aName = '', bName = '';
        try { aName = (a.description || '').toString(); } catch (e) { /* ignore */ }
        try { bName = (b.description || '').toString(); } catch (e) { /* ignore */ }
        const aIsSrcByName = aName.charAt(0) === '_';
        const bIsSrcByName = bName.charAt(0) === '_';

        if (aIsSrcByName && !bIsSrcByName) return { src: a, dst: b };
        if (bIsSrcByName && !aIsSrcByName) return { src: b, dst: a };

        const ca = collectChildren(a).length;
        const cb = collectChildren(b).length;
        if (ca === 0 || cb === 0 || ca === cb) return null;
        return ca < cb ? { src: a, dst: b } : { src: b, dst: a };
    }

    const groups = findGroups();
    if (!groups) {
        app.alert('Please select exactly two groups.\n\nBase = the group whose name starts with "_" (supplies the objects, is kept)\nTarget = the other group (supplies the curve nodes, stays unchanged)\n\nIf neither group name starts with "_", the group with fewer objects is used as base (this requires different object counts).', TITLE);
        return;
    }

    const srcCount = collectChildren(groups.src).length;
    const dstLeaves = collectChildren(groups.dst);

    // ---------- Dialog (v12: tabbed GUI) ----------
    const PAGE_TITLES = ['1  Nodes & assignment', '2  Colour jitter', '3  Rotation & size'];
    const dlg = Dialog.create(TITLE);
    dlg.initialWidth = 1000;
    dlg.setIsResizable(true);
    const cNav = dlg.addColumn(); cNav.widthProportion = 0.8;
    const cA = dlg.addColumn(); cA.widthProportion = 1;
    const cB = dlg.addColumn(); cB.widthProportion = 1;

    const PAGES = PAGE_TITLES.map(() => []);
    function pageGroup(pageIdx, col, title) { const g = col.addGroup(title); PAGES[pageIdx].push(g); return g; }
    let pagedOK = true;
    function showPage(i) {
        if (!pagedOK) return;
        try {
            for (let k = 0; k < PAGES.length; k++) for (const g of PAGES[k]) g.isVisible = (k === i);
        } catch (e) {
            pagedOK = false;
            try { for (const pg of PAGES) for (const g of pg) g.isVisible = true; } catch (e2) { /* ignore */ }
        }
    }

    // Left column: always visible
    const gNav = cNav.addGroup('Tabs');
    const rNav = gNav.addRadioGroup('', PAGE_TITLES, 0);
    const gInfo = cNav.addGroup('Info');
    gInfo.addStaticText('', 'Base: ' + srcCount + ' objects\nTarget: ' + dstLeaves.length + ' objects (supply nodes)');
    const gAction = cNav.addGroup('Action');
    const btnPreview = gAction.addButton('Preview');
    const btnLoad = gAction.addButton('Load preset');
    const btnSave = gAction.addButton('Save preset');

    // Page 1: Nodes & assignment
    const gTol = pageGroup(0, cA, 'Nodes');
    const edTol = gTol.addUnitValueEditor('Distance tolerance (px)', UnitType.Pixel, UnitType.Pixel, null); edTol.value = 5;
    const gSeq = pageGroup(0, cB, 'Assignment');
    const rgSeq = gSeq.addRadioGroup('', ['Random', 'Sequential', 'Reverse', 'Ping-pong'], 0);
    const edSeed = gSeq.addUnitValueEditor('Random seed (0=random)', UnitType.Number, UnitType.Number, null, 0, 999999); edSeed.value = 0;

    // Page 2: Colour jitter
    const gMode = pageGroup(1, cA, 'Apply colour jitter to');
    const rgMode = gMode.addRadioGroup('', ['Fill only', 'Stroke only', 'Fill and stroke'], 2);
    try { rgMode.selectedIndex = 2; } catch (e) { /* ignore */ }
    const gHue = pageGroup(1, cA, 'Jitter: Hue (°)');
    const edHueMin = gHue.addUnitValueEditor('Min', UnitType.Degree, UnitType.Degree, null, -180, 180); edHueMin.value = 0;
    const edHueMax = gHue.addUnitValueEditor('Max', UnitType.Degree, UnitType.Degree, null, -180, 180); edHueMax.value = 0;
    const gSat = pageGroup(1, cA, 'Jitter: Saturation (%)');
    const edSatMin = gSat.addUnitValueEditor('Min', UnitType.Percentage, UnitType.Percentage, null, -100, 100); edSatMin.value = 0;
    const edSatMax = gSat.addUnitValueEditor('Max', UnitType.Percentage, UnitType.Percentage, null, -100, 100); edSatMax.value = 0;
    const gLum = pageGroup(1, cB, 'Jitter: Lightness (%)');
    const edLumMin = gLum.addUnitValueEditor('Min', UnitType.Percentage, UnitType.Percentage, null, -100, 100); edLumMin.value = 0;
    const edLumMax = gLum.addUnitValueEditor('Max', UnitType.Percentage, UnitType.Percentage, null, -100, 100); edLumMax.value = 0;
    const gOp = pageGroup(1, cB, 'Jitter: Opacity (%)');
    const edOpMin = gOp.addUnitValueEditor('Min', UnitType.Percentage, UnitType.Percentage, null, -100, 100); edOpMin.value = 0;
    const edOpMax = gOp.addUnitValueEditor('Max', UnitType.Percentage, UnitType.Percentage, null, -100, 100); edOpMax.value = 0;
    const gBlend = pageGroup(1, cB, 'More options');
    const cbBlend = gBlend.addCheckBox('Transfer blend mode', true);

    // Page 3: Rotation & size
    const gRot = pageGroup(2, cA, 'Rotation (°)');
    const edRotMin = gRot.addUnitValueEditor('Min', UnitType.Degree, UnitType.Degree, null, -360, 360); edRotMin.value = 0;
    const edRotMax = gRot.addUnitValueEditor('Max', UnitType.Degree, UnitType.Degree, null, -360, 360); edRotMax.value = 0;
    const edRotInc = gRot.addUnitValueEditor('Increment (0=continuous)', UnitType.Degree, UnitType.Degree, null, 0, 360); edRotInc.value = 0;
    const gAspect = pageGroup(2, cA, 'Size');
    const cbAspect = gAspect.addCheckBox('Keep aspect ratio (uses X values only)', false);
    const gSizePxX = pageGroup(2, cA, 'Size X jitter (px)');
    const edSizePxXMin = gSizePxX.addUnitValueEditor('Min', UnitType.Pixel, UnitType.Pixel, null); edSizePxXMin.value = 0;
    const edSizePxXMax = gSizePxX.addUnitValueEditor('Max', UnitType.Pixel, UnitType.Pixel, null); edSizePxXMax.value = 0;
    const gSizePxY = pageGroup(2, cB, 'Size Y jitter (px)');
    const edSizePxYMin = gSizePxY.addUnitValueEditor('Min', UnitType.Pixel, UnitType.Pixel, null); edSizePxYMin.value = 0;
    const edSizePxYMax = gSizePxY.addUnitValueEditor('Max', UnitType.Pixel, UnitType.Pixel, null); edSizePxYMax.value = 0;
    const gSizePctX = pageGroup(2, cB, 'Size X jitter (%)');
    const edSizePctXMin = gSizePctX.addUnitValueEditor('Min', UnitType.Percentage, UnitType.Percentage, null, -100, 500); edSizePctXMin.value = 0;
    const edSizePctXMax = gSizePctX.addUnitValueEditor('Max', UnitType.Percentage, UnitType.Percentage, null, -100, 500); edSizePctXMax.value = 0;
    const gSizePctY = pageGroup(2, cB, 'Size Y jitter (%)');
    const edSizePctYMin = gSizePctY.addUnitValueEditor('Min', UnitType.Percentage, UnitType.Percentage, null, -100, 500); edSizePctYMin.value = 0;
    const edSizePctYMax = gSizePctY.addUnitValueEditor('Max', UnitType.Percentage, UnitType.Percentage, null, -100, 500); edSizePctYMax.value = 0;

    rNav.selectedIndex = 0;
    showPage(0);
    try { rNav.setOnValueChangedHandler(() => { showPage(rNav.selectedIndex); }); } catch (e) { /* ignore */ }

    function readParams() {
        return {
            tolerance: edTol.value,
            mapMode: rgSeq.selectedIndex,
            seed: edSeed.value,
            colorMode: rgMode.selectedIndex,
            hueMin: edHueMin.value, hueMax: edHueMax.value,
            satMin: edSatMin.value, satMax: edSatMax.value,
            lumMin: edLumMin.value, lumMax: edLumMax.value,
            opacityMin: edOpMin.value, opacityMax: edOpMax.value,
            transferBlend: cbBlend.value,
            rotMin: edRotMin.value, rotMax: edRotMax.value, rotIncrement: edRotInc.value,
            preserveAspect: cbAspect.value,
            sizePxXMin: edSizePxXMin.value, sizePxXMax: edSizePxXMax.value,
            sizePxYMin: edSizePxYMin.value, sizePxYMax: edSizePxYMax.value,
            sizePctXMin: edSizePctXMin.value, sizePctXMax: edSizePctXMax.value,
            sizePctYMin: edSizePctYMin.value, sizePctYMax: edSizePctYMax.value
        };
    }

    function fx(a, b) { return a <= b ? [a, b] : [b, a]; }
    function fixMinMax(p) {
        [p.hueMin, p.hueMax] = fx(p.hueMin, p.hueMax);
        [p.satMin, p.satMax] = fx(p.satMin, p.satMax);
        [p.lumMin, p.lumMax] = fx(p.lumMin, p.lumMax);
        [p.opacityMin, p.opacityMax] = fx(p.opacityMin, p.opacityMax);
        [p.rotMin, p.rotMax] = fx(p.rotMin, p.rotMax);
        [p.sizePxXMin, p.sizePxXMax] = fx(p.sizePxXMin, p.sizePxXMax);
        [p.sizePxYMin, p.sizePxYMax] = fx(p.sizePxYMin, p.sizePxYMax);
        [p.sizePctXMin, p.sizePctXMax] = fx(p.sizePctXMin, p.sizePctXMax);
        [p.sizePctYMin, p.sizePctYMax] = fx(p.sizePctYMin, p.sizePctYMax);
        if (p.tolerance < 0) p.tolerance = 0;
        return p;
    }

    function writeParamsToDialog(p) {
        if (p.tolerance != null) edTol.value = p.tolerance;
        if (p.mapMode != null) rgSeq.selectedIndex = p.mapMode;
        if (p.seed != null) edSeed.value = p.seed;
        if (p.colorMode != null) rgMode.selectedIndex = p.colorMode;
        if (p.hueMin != null) edHueMin.value = p.hueMin;
        if (p.hueMax != null) edHueMax.value = p.hueMax;
        if (p.satMin != null) edSatMin.value = p.satMin;
        if (p.satMax != null) edSatMax.value = p.satMax;
        if (p.lumMin != null) edLumMin.value = p.lumMin;
        if (p.lumMax != null) edLumMax.value = p.lumMax;
        if (p.opacityMin != null) edOpMin.value = p.opacityMin;
        if (p.opacityMax != null) edOpMax.value = p.opacityMax;
        if (p.transferBlend != null) cbBlend.value = p.transferBlend;
        if (p.rotMin != null) edRotMin.value = p.rotMin;
        if (p.rotMax != null) edRotMax.value = p.rotMax;
        if (p.rotIncrement != null) edRotInc.value = p.rotIncrement;
        if (p.preserveAspect != null) cbAspect.value = p.preserveAspect;
        if (p.sizePxXMin != null) edSizePxXMin.value = p.sizePxXMin;
        if (p.sizePxXMax != null) edSizePxXMax.value = p.sizePxXMax;
        if (p.sizePxYMin != null) edSizePxYMin.value = p.sizePxYMin;
        if (p.sizePxYMax != null) edSizePxYMax.value = p.sizePxYMax;
        if (p.sizePctXMin != null) edSizePctXMin.value = p.sizePctXMin;
        if (p.sizePctXMax != null) edSizePctXMax.value = p.sizePctXMax;
        if (p.sizePctYMin != null) edSizePctYMin.value = p.sizePctYMin;
        if (p.sizePctYMax != null) edSizePctYMax.value = p.sizePctYMax;
    }

    function getPresetDir() {
        const { FileSystemApi } = require('/fs');
        const dir = app.userDesktopPath + '/AffinityScriptPresets';
        FileSystemApi.createDirectories(dir);
        return dir;
    }

    function savePreset() {
        const name = app.prompt('Preset name:', TITLE, 'Preset1');
        if (!name || !name.trim()) return;
        try {
            const { File } = require('/fs');
            const path = getPresetDir() + '/' + name.trim() + '.oak-preset.json';
            const f = File.create(path, 'wb');
            f.writeStringAsUtf8(JSON.stringify(fixMinMax(readParams())));
            f.close();
            app.alert('Preset saved:\n' + path, TITLE);
        } catch (e) {
            app.alert('Preset could not be saved: ' + e.message, TITLE);
        }
    }

    function loadPreset() {
        try {
            const path = app.chooseFile();
            if (!path) return;
            const { File } = require('/fs');
            const txt = File.readAll(path).toString();
            writeParamsToDialog(JSON.parse(txt));
        } catch (e) {
            app.alert('Preset could not be loaded: ' + e.message, TITLE);
        }
    }

    // ---------- Apply (v14) ----------
    // created: list receiving every newly created node (safety net of the undo)
    function doApply(p, created) {
        setSeed(p.seed);
        const srcArr = collectChildren(groups.src);

        const allPoints = [];
        for (const leaf of dstLeaves) {
            const pts = getObjectAnchorPointsSpread(leaf);
            for (const pt of pts) allPoints.push({ x: pt.x, y: pt.y, sourceNode: leaf });
        }
        const uniquePoints = dedupeNodePoints(allPoints, p.tolerance);

        if (uniquePoints.length === 0) {
            return { skipped: 0, placed: 0, noNodes: true };
        }

        const map = buildMapping(srcArr.length, uniquePoints.length, p.mapMode);

        // Phase A: everything computed in JS (same random sequence as v13)
        const srcInfo = srcArr.map(n => {
            let m = null, bb = null;
            try { m = spreadMat(n); bb = n.getSpreadBaseBox(false); } catch (e) { m = null; }
            return { m, bb };
        });
        const plan = [];
        let skipped = 0;
        for (let i = 0; i < uniquePoints.length; i++) {
            const dh = rand(p.hueMin, p.hueMax);
            const ds = rand(p.satMin, p.satMax);
            const dl = rand(p.lumMin, p.lumMax);
            const da = rand(p.opacityMin, p.opacityMax);
            const s = map[i], si = srcInfo[s];
            if (!si.m || !si.bb) { skipped++; continue; }
            const tf = placeAtPointTF(si, uniquePoints[i], p);
            if (!tf) { skipped++; continue; }
            plan.push({ s, tf, dh, ds, dl, da });
        }
        if (plan.length === 0) return { skipped, placed: 0, noNodes: false };

        // Phase B: 3 history steps
        // 1) create the target group, named right away
        const bldr = AddChildNodesCommandBuilder.create();
        bldr.addContainerNode(ContainerNodeDefinition.create('Node_Objects_' + getNextGroupIndex()));
        const gcmd = bldr.createCommand(false);
        doc.executeCommand(gcmd);
        const newGroup = toArr(gcmd.newNodes)[0] || null;
        if (newGroup) created.push(newGroup);
        if (!newGroup) throw new Error('Group could not be created');

        // 2) all copies: duplicate + place in ONE compound (newNodes in command order)
        const b1 = makeBatch();
        for (const pl of plan) b1.add(DocumentCommand.createTransform(Selection.create(doc, [srcArr[pl.s]]), pl.tf, { duplicateNodes: true }));
        const c1 = b1.run();
        const dups = c1 ? toArr(c1.newNodes) : [];
        for (const d of dups) created.push(d);
        if (dups.length !== plan.length) throw new Error('Copies: ' + dups.length + ' instead of ' + plan.length);

        // 3) colour jitter, sorting-in (same order as v13) and group behind the target as ONE compound
        const b2 = makeBatch();
        for (let k = 0; k < plan.length; k++) {
            const pl = plan[k], dup = dups[k], src = srcArr[pl.s];
            try {
                if (p.colorMode === 0 || p.colorMode === 2) {
                    const fd = getFDFromNode(src, false);
                    if (fd) addFDCommand(b2, dup, jitterOwnFillDescriptor(fd, pl.dh, pl.ds, pl.dl, pl.da, p.transferBlend), false);
                }
                if (p.colorMode === 1 || p.colorMode === 2) {
                    const pfd = getFDFromNode(src, true);
                    if (pfd) addFDCommand(b2, dup, jitterOwnFillDescriptor(pfd, pl.dh, pl.ds, pl.dl, pl.da, p.transferBlend), true);
                }
            } catch (e) { /* colour not changeable: copy keeps its original colour */ }
        }
        for (const d of dups) b2.add(DocumentCommand.createMoveNodes(d.selfSelection, newGroup, NodeMoveType.Inside, NodeChildType.Main));
        b2.add(DocumentCommand.createMoveNodes(newGroup.selfSelection, groups.dst, NodeMoveType.After, NodeChildType.Main));
        b2.run();

        return { skipped, placed: plan.length, noNodes: false };
    }

    // ---------- Dialog (ONE runModal() call) ----------
    let hasPreview = false;
    let previewKey = null;
    let previewPos0 = 0, previewCreated = null;

    function discardPreview() {
        if (hasPreview) rollback(previewPos0, previewCreated);
        hasPreview = false; previewKey = null; previewCreated = null;
    }

    function reportResult(res) {
        if (res.noNodes) app.alert('No curve nodes found in the target group.', TITLE);
        else if (res.skipped > 0) app.alert(res.skipped + ' node point(s) could not be filled and were skipped.', TITLE);
    }

    // One run with complete undo on error
    function run(p) {
        const pos0 = doc.history.position, created = [];
        try {
            const res = doApply(p, created);
            return { res, pos0, created };
        } catch (e) {
            rollback(pos0, created);
            throw e;
        }
    }

    function updatePreview() {
        discardPreview();
        try {
            const p = fixMinMax(readParams());
            const r = run(p);
            if (r.res.placed > 0) { hasPreview = true; previewKey = JSON.stringify(p); previewPos0 = r.pos0; previewCreated = r.created; }
            reportResult(r.res);
        } catch (e) {
            app.alert('Error: ' + e.message, TITLE);
        }
    }

    btnLoad.setOnClickHandler(() => { loadPreset(); });
    btnSave.setOnClickHandler(() => { savePreset(); });
    btnPreview.setOnClickHandler(() => { updatePreview(); });

    const result = dlg.runModal();

    if (!result || result.value === DialogResult.Cancel.value) {
        discardPreview();
    } else {
        const p = fixMinMax(readParams());
        if (!(hasPreview && previewKey === JSON.stringify(p))) {
            discardPreview();
            try {
                reportResult(run(p).res);
            } catch (e) {
                app.alert('Error: ' + e.message, TITLE);
            }
        }
    }
})();
