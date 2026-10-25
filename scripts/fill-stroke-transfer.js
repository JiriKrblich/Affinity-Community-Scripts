// Transfer Fills and Strokes v20
// Transfers fills and/or strokes from a "base" group (fewer objects) to a "target" group
// (more objects), including HSL colour jitter and optional geometry jitter.
// v2-v8: anchor undo, bitmap jitter in JS, subgroups, opacity jitter, seed, presets,
//        rotation increment, blend mode.
// v10-v13: "match colour/lightness/saturation", one runModal(), presets subfolder.
// v14-v16: line style via command, undoToBase() via single undo steps (safe at position 0 too).
// v17: text objects (text->text always, shape->text optional, text->shape never).
// v18: OK recalculates when settings changed.
//
// v19: A pass is now ONE history step. Affinity's undo history is limited to roughly
//      1070 steps; so far every target object created 1-5 steps of its own (fill, stroke,
//      line style, blend mode, geometry), so with large groups the oldest preview steps
//      dropped out of the history and were no longer reverted. All changes now run in one
//      CompoundCommand (text via createFormatText).
//
// v20: GUI split into tabs (pages), as in "Transform Objects" v8: on the left a permanently
//      visible column (tab selection, info, preview and presets), on the right two columns per
//      page. The groups of the active page are shown, all others hidden (group.isVisible).
//      Pages: 1 Transfer & assignment, 2 Colour jitter, 3 Geometry jitter, 4 Options. The
//      former combined group "More options" is split into three groups (More options, Text,
//      Matching) for this - the checkboxes themselves are unchanged. Functions unchanged
//      from v19.
(function () {
    const { Document } = require('/document');
    const { Selection } = require('/selections');
    const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
    const { Colour, Gradient } = require('/colours');
    const { FillDescriptor, SolidFill, GradientFill, HatchFill, BitmapFill, FillType } = require('/fills');
    const { Transform } = require('/geometry');
    const { RasterFormat } = require('/rasterobject');
    const { Dialog, DialogResult, UnitType } = require('/dialog');
    const { app } = require('/application');
    const { StoryDelta } = require('/storydelta');

    const TITLE = 'Transfer Fills and Strokes';
    const doc = Document.current;
    if (!doc) { app.alert('No document open.', TITLE); return; }

    // v19: collects commands for ONE CompoundCommand (an empty compound throws INVALID_OP)
    function makeBatch() {
        const builder = CompoundCommandBuilder.create();
        let count = 0;
        return {
            add(cmd) { builder.addCommand(cmd); count++; },
            run() { if (count > 0) doc.executeCommand(builder.createCommand()); return count; }
        };
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

    function jitterRotation(rotMin, rotMax, increment) {
        if (increment && increment > 0) {
            const nSteps = Math.floor((rotMax - rotMin) / increment) + 1;
            const stepIdx = Math.floor(rand(0, nSteps));
            return rotMin + stepIdx * increment;
        }
        return rand(rotMin, rotMax);
    }
    function localBB(node) { return node.curvesInterface.polyCurve.getExactBoundingBox(); }

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
    // v19: add the command to the compound instead of executing it (text via createFormatText)
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

    function isTransferAllowed(srcIsText, dstIsText, allowShapeToText) {
        if (!srcIsText && !dstIsText) return true;
        if (srcIsText && dstIsText) return true;
        if (!srcIsText && dstIsText) return allowShapeToText;
        return false;
    }

    function jitterHSL(col, dh, ds, dl, da) {
        const h = col.hslaf;
        return Colour.createHSLAf({
            h: wrap01(h.h + dh / 360),
            s: clamp01(h.s + ds / 100),
            l: clamp01(h.l + dl / 100),
            alpha: clamp01(h.alpha + (da || 0) / 100)
        });
    }

    function getFirstHue(fill) {
        if (!fill) return null;
        const ft = fill.fillType.value;
        if (ft === FillType.Solid.value) return fill.colour.hslaf.h;
        if (ft === FillType.Gradient.value) {
            if (fill.gradient.stopCount === 0) return null;
            return new Colour(fill.gradient.getStop(0).colour).hslaf.h;
        }
        return null;
    }

    function getAvgSatLum(fill) {
        if (!fill) return null;
        const ft = fill.fillType.value;
        if (ft === FillType.Solid.value) {
            const h = fill.colour.hslaf;
            return { avgS: h.s, avgL: h.l };
        }
        if (ft === FillType.Gradient.value) {
            const g = fill.gradient;
            if (g.stopCount === 0) return null;
            let sumS = 0, sumL = 0;
            for (let i = 0; i < g.stopCount; i++) {
                const hh = new Colour(g.getStop(i).colour).hslaf;
                sumS += hh.s; sumL += hh.l;
            }
            return { avgS: sumS / g.stopCount, avgL: sumL / g.stopCount };
        }
        return null;
    }

    function circularHueDeltaDeg(fromH, toH) {
        let d = toH - fromH;
        d -= Math.round(d);
        return d * 360;
    }

    function computeAlignedDeltas(srcFill, dstFill, p, dh, ds, dl) {
        let dhOut = dh, dsOut = ds, dlOut = dl;
        if (p.alignColor) {
            const srcHue = getFirstHue(srcFill);
            const dstHue = getFirstHue(dstFill);
            if (srcHue !== null && dstHue !== null) dhOut = circularHueDeltaDeg(srcHue, dstHue);
        }
        if (p.alignLum || p.alignSat) {
            const srcAvg = getAvgSatLum(srcFill);
            const dstAvg = getAvgSatLum(dstFill);
            if (srcAvg && dstAvg) {
                if (p.alignLum) dlOut = (dstAvg.avgL - srcAvg.avgL) * 100;
                if (p.alignSat) dsOut = (dstAvg.avgS - srcAvg.avgS) * 100;
            }
        }
        return { dh: dhOut, ds: dsOut, dl: dlOut };
    }

    function remapTransform(srcTr, srcBB, dstBB, preserveAspect) {
        const ox = (srcTr.origin.x - srcBB.x) / (srcBB.width || 1);
        const oy = (srcTr.origin.y - srcBB.y) / (srcBB.height || 1);
        const v1x = srcTr.xAxis.x / (srcBB.width || 1), v1y = srcTr.xAxis.y / (srcBB.height || 1);
        const v2x = srcTr.yAxis.x / (srcBB.width || 1), v2y = srcTr.yAxis.y / (srcBB.height || 1);
        let dw = dstBB.width, dh = dstBB.height, dx0 = dstBB.x, dy0 = dstBB.y;
        if (preserveAspect) {
            const scale = Math.min(dstBB.width / (srcBB.width || 1), dstBB.height / (srcBB.height || 1));
            dw = srcBB.width * scale; dh = srcBB.height * scale;
            dx0 = dstBB.x + (dstBB.width - dw) / 2;
            dy0 = dstBB.y + (dstBB.height - dh) / 2;
        }
        const nt = Transform.createIdentity();
        const d = nt.data;
        d[2] = dx0 + ox * dw;
        d[5] = dy0 + oy * dh;
        d[0] = v1x * dw; d[3] = v1y * dh;
        d[1] = v2x * dw; d[4] = v2y * dh;
        return nt;
    }

    function remapTransformTile(srcTr, srcBB, dstBB) {
        const srcCx = srcBB.x + srcBB.width / 2, srcCy = srcBB.y + srcBB.height / 2;
        const dstCx = dstBB.x + dstBB.width / 2, dstCy = dstBB.y + dstBB.height / 2;
        const offX = srcTr.origin.x - srcCx, offY = srcTr.origin.y - srcCy;
        const nt = Transform.createIdentity();
        const d = nt.data;
        d[2] = dstCx + offX; d[5] = dstCy + offY;
        d[0] = srcTr.xAxis.x; d[3] = srcTr.xAxis.y;
        d[1] = srcTr.yAxis.x; d[4] = srcTr.yAxis.y;
        return nt;
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

    function jitterFillPreserveType(fill, dh, ds, dl, da) {
        const ft = fill.fillType.value;
        if (ft === FillType.Solid.value) {
            return SolidFill.create(jitterHSL(fill.colour, dh, ds, dl, da));
        }
        if (ft === FillType.Gradient.value) {
            const g = fill.gradient;
            const stops = [];
            for (let i = 0; i < g.stopCount; i++) {
                const st = g.getStop(i);
                const col = new Colour(st.colour);
                stops.push({ colour: jitterHSL(col, dh, ds, dl, da), position: st.position, midpoint: st.midpoint });
            }
            return GradientFill.create(Gradient.create(stops), fill.gradientFillType);
        }
        if (ft === FillType.Hatch.value) {
            const nh = fill.clone();
            if (fill.penColour) nh.penColour = jitterHSL(fill.penColour, dh, ds, dl, da);
            if (fill.brushColour) nh.brushColour = jitterHSL(fill.brushColour, dh, ds, dl, da);
            return nh;
        }
        if (ft === FillType.Bitmap.value) {
            const needsJitter = !(dh === 0 && ds === 0 && dl === 0 && da === 0);
            if (!needsJitter) return fill;
            const src = fill.bitmap;
            const w = src.width, h = src.height;
            const fmt = src.format;
            const buf = src.createCompatibleBuffer(true);
            let arr, maxVal;
            if (fmt === RasterFormat.RGBA8.value) { arr = new Uint8Array(buf.buffer); maxVal = 255; }
            else if (fmt === RasterFormat.RGBA16.value) { arr = new Uint16Array(buf.buffer); maxVal = 65535; }
            else if (fmt === RasterFormat.RGBAUF.value) { arr = new Float32Array(buf.buffer); maxVal = 1; }
            else return fill;
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
            return BitmapFill.create(newBm, fill.extendType, fill.upsamplerType, fill.isIgnoreAlpha);
        }
        return fill;
    }

    function buildFD(srcFD, srcBB, dstBB, jitteredFill, bitmapMode, preserveAspect, transferBlend, dstOwnBlend) {
        const blendMode = transferBlend ? srcFD.blendMode : dstOwnBlend;
        if (jitteredFill.fillType.value === FillType.Solid.value) {
            return FillDescriptor.createSolid(jitteredFill.colour, blendMode);
        }
        const useTile = jitteredFill.fillType.value === FillType.Bitmap.value && bitmapMode === 1;
        const nt = useTile
            ? remapTransformTile(srcFD.transform, srcBB, dstBB)
            : remapTransform(srcFD.transform, srcBB, dstBB, preserveAspect);
        return FillDescriptor.create(jitteredFill, true, nt, blendMode, false);
    }

    function buildFDNoRemap(srcFD, jitteredFill, transferBlend, dstOwnBlend) {
        const blendMode = transferBlend ? srcFD.blendMode : dstOwnBlend;
        if (jitteredFill.fillType.value === FillType.Solid.value) {
            return FillDescriptor.createSolid(jitteredFill.colour, blendMode);
        }
        return FillDescriptor.create(jitteredFill, true, srcFD.transform, blendMode, false);
    }

    function jitterOwnFD(fd, dh, ds, dl, da) {
        const jf = jitterFillPreserveType(fd.fill, dh, ds, dl, da);
        if (jf.fillType.value === FillType.Solid.value) {
            return FillDescriptor.createSolid(jf.colour, fd.blendMode);
        }
        return FillDescriptor.create(jf, fd.isScaleWithObject, fd.transform, fd.blendMode, fd.isAnchoredToSpread);
    }

    function addGeoJitter(batch, node, dxPx, dyPx, dRotDeg, scaleFactor) {
        if (dxPx === 0 && dyPx === 0 && dRotDeg === 0 && Math.abs(scaleFactor - 1) < 1e-9) return 0;
        const m = node.transform.data;
        const sx = Math.sqrt(m[0] * m[0] + m[3] * m[3]);
        const sy = Math.sqrt(m[1] * m[1] + m[4] * m[4]);
        const theta = Math.atan2(m[3], m[0]);
        const rad = dRotDeg * Math.PI / 180;
        const cosN = Math.cos(theta + rad), sinN = Math.sin(theta + rad);
        const m11z = sx * scaleFactor * cosN, m12z = -sy * scaleFactor * sinN;
        const m21z = sx * scaleFactor * sinN, m22z = sy * scaleFactor * cosN;
        const det = m[0] * m[4] - m[1] * m[3];
        if (Math.abs(det) < 1e-12) return 0;
        const inv11 = m[4] / det, inv12 = -m[1] / det, inv21 = -m[3] / det, inv22 = m[0] / det;
        const d11 = m11z * inv11 + m12z * inv21, d12 = m11z * inv12 + m12z * inv22;
        const d21 = m21z * inv11 + m22z * inv21, d22 = m21z * inv12 + m22z * inv22;
        const bb = node.getSpreadBaseBox(false);
        const rcx = bb.x + bb.width / 2, rcy = bb.y + bb.height / 2;
        let tx = rcx - (d11 * rcx + d12 * rcy);
        let ty = rcy - (d21 * rcx + d22 * rcy);
        tx += dxPx; ty += dyPx;
        const tf = Transform.createIdentity();
        const d = tf.data;
        d[0] = d11; d[1] = d12; d[2] = tx; d[3] = d21; d[4] = d22; d[5] = ty;
        batch.add(DocumentCommand.createTransform(node.selfSelection, tf));
        return 1;
    }

    function addLineStyleExceptWeight(batch, srcNode, dstNode) {
        const srcLsi = srcNode.lineStyleInterface;
        const dstLsi = dstNode.lineStyleInterface;
        if (!srcLsi || !dstLsi) return;
        const srcLsd = srcLsi.lineStyleDescriptor;
        const dstWeight = dstLsi.lineStyleDescriptor.lineStyle.weight;
        const newLineStyle = srcLsd.lineStyle.clone();
        newLineStyle.weight = dstWeight;
        const newLsd = srcLsd.cloneWithNewLineStyle(newLineStyle);
        batch.add(DocumentCommand.createSetLineStyleDescriptor(dstNode.selfSelection, newLsd));
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

    function findGroups() {
        if (doc.selection.length !== 2) return null;
        const a = doc.selection.at(0).node, b = doc.selection.at(1).node;
        if (!(a.children && a.children.length > 0) || !(b.children && b.children.length > 0)) return null;
        const ca = collectChildren(a).length;
        const cb = collectChildren(b).length;
        if (ca === 0 || cb === 0 || ca === cb) return null;
        return ca < cb ? { src: a, dst: b } : { src: b, dst: a };
    }

    const groups = findGroups();
    if (!groups) {
        app.alert('Please select exactly two groups with different object counts.\n\nBase = group with fewer objects\nTarget = group with more objects', TITLE);
        return;
    }

    const srcCount = collectChildren(groups.src).length;
    const dstCount = collectChildren(groups.dst).length;

    function resetToGroupSelection() {
        doc.executeCommand(DocumentCommand.createSetSelection(Selection.create(doc, [groups.src, groups.dst])));
    }

    // ---------- Dialog (v20: tabbed GUI) ----------
    // On the left a narrow, permanently visible column (tab selection, info, preview, presets),
    // on the right two content columns. Each page consists of groups in these two columns;
    // when switching, the groups of the active page are shown and all others hidden.
    const PAGE_TITLES = ['1  Transfer & assignment', '2  Colour jitter', '3  Geometry jitter', '4  Options'];
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
            // Fallback: hiding not possible -> leave everything visible
            pagedOK = false;
            try { for (const pg of PAGES) for (const g of pg) g.isVisible = true; } catch (e2) { /* ignore */ }
        }
    }

    // Left column: always visible
    const gNav = cNav.addGroup('Tabs');
    const rNav = gNav.addRadioGroup('', PAGE_TITLES, 0);
    const gInfo = cNav.addGroup('Info');
    gInfo.addStaticText('', 'Base: ' + srcCount + ' objects\nTarget: ' + dstCount + ' objects');
    const gAction = cNav.addGroup('Action');
    const btnPreview = gAction.addButton('Preview');
    const btnLoad = gAction.addButton('Load preset');
    const btnSave = gAction.addButton('Save preset');

    // Page 1: Transfer & assignment
    const gMode = pageGroup(0, cA, 'Transfer');
    const rgMode = gMode.addRadioGroup('', ['Fill', 'Stroke', 'Both', 'Colour jitter only'], 2);
    const gBmp = pageGroup(0, cA, 'Bitmap pattern');
    const rgBmp = gBmp.addRadioGroup('', ['Fit size', 'Original size'], 0);
    const gSeq = pageGroup(0, cB, 'Assignment');
    const rgSeq = gSeq.addRadioGroup('', ['Random', 'Sequential', 'Reverse', 'Ping-pong'], 0);
    const edSeed = gSeq.addUnitValueEditor('Random seed (0=random)', UnitType.Number, UnitType.Number, null, 0, 999999); edSeed.value = 0;
    const cbSameJitter = gSeq.addCheckBox('Same jitter per source object', false);

    // Page 2: Colour jitter
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

    // Page 3: Geometry jitter
    const gGeoOn = pageGroup(2, cA, 'Geometry jitter');
    const cbGeo = gGeoOn.addCheckBox('Apply geometry jitter', false);
    const gPos = pageGroup(2, cA, 'Position (px)');
    const edPosXMin = gPos.addUnitValueEditor('X Min', UnitType.Pixel, UnitType.Pixel, null); edPosXMin.value = 0;
    const edPosXMax = gPos.addUnitValueEditor('X Max', UnitType.Pixel, UnitType.Pixel, null); edPosXMax.value = 0;
    const edPosYMin = gPos.addUnitValueEditor('Y Min', UnitType.Pixel, UnitType.Pixel, null); edPosYMin.value = 0;
    const edPosYMax = gPos.addUnitValueEditor('Y Max', UnitType.Pixel, UnitType.Pixel, null); edPosYMax.value = 0;
    const gRot = pageGroup(2, cB, 'Rotation (°)');
    const edRotMin = gRot.addUnitValueEditor('Min', UnitType.Degree, UnitType.Degree, null, -360, 360); edRotMin.value = 0;
    const edRotMax = gRot.addUnitValueEditor('Max', UnitType.Degree, UnitType.Degree, null, -360, 360); edRotMax.value = 0;
    const edRotInc = gRot.addUnitValueEditor('Increment (0=continuous)', UnitType.Degree, UnitType.Degree, null, 0, 360); edRotInc.value = 0;
    const gSizePx = pageGroup(2, cB, 'Size jitter (px)');
    const edSizePxMin = gSizePx.addUnitValueEditor('Min', UnitType.Pixel, UnitType.Pixel, null); edSizePxMin.value = 0;
    const edSizePxMax = gSizePx.addUnitValueEditor('Max', UnitType.Pixel, UnitType.Pixel, null); edSizePxMax.value = 0;
    const gSizePct = pageGroup(2, cB, 'Size jitter (%)');
    const edSizePctMin = gSizePct.addUnitValueEditor('Min', UnitType.Percentage, UnitType.Percentage, null, -100, 500); edSizePctMin.value = 0;
    const edSizePctMax = gSizePct.addUnitValueEditor('Max', UnitType.Percentage, UnitType.Percentage, null, -100, 500); edSizePctMax.value = 0;

    // Page 4: Options
    const gExtra = pageGroup(3, cA, 'More options');
    const cbBlend = gExtra.addCheckBox('Transfer blend mode', true);
    const cbAspect = gExtra.addCheckBox('Keep aspect ratio', false);
    const gText = pageGroup(3, cA, 'Text');
    const cbShapeToText = gText.addCheckBox('Transfer shape fills to text', false);
    const gAlign = pageGroup(3, cB, 'Matching');
    const cbAlignColor = gAlign.addCheckBox('Match colour (hue to target)', false);
    const cbAlignLum = gAlign.addCheckBox('Match lightness (avg. to target)', false);
    const cbAlignSat = gAlign.addCheckBox('Match saturation (avg. to target)', false);

    rNav.selectedIndex = 0;
    showPage(0);
    try { rNav.setOnValueChangedHandler(() => { showPage(rNav.selectedIndex); }); } catch (e) { /* ignore */ }

    function readParams() {
        return {
            mode: rgMode.selectedIndex,
            mapMode: rgSeq.selectedIndex,
            bitmapMode: rgBmp.selectedIndex,
            seed: edSeed.value,
            sameJitterPerSource: cbSameJitter.value,
            hueMin: edHueMin.value, hueMax: edHueMax.value,
            satMin: edSatMin.value, satMax: edSatMax.value,
            lumMin: edLumMin.value, lumMax: edLumMax.value,
            opacityMin: edOpMin.value, opacityMax: edOpMax.value,
            geoJitter: cbGeo.value,
            posXMin: edPosXMin.value, posXMax: edPosXMax.value,
            posYMin: edPosYMin.value, posYMax: edPosYMax.value,
            rotMin: edRotMin.value, rotMax: edRotMax.value, rotIncrement: edRotInc.value,
            sizePxMin: edSizePxMin.value, sizePxMax: edSizePxMax.value,
            sizePctMin: edSizePctMin.value, sizePctMax: edSizePctMax.value,
            transferBlend: cbBlend.value,
            preserveAspect: cbAspect.value,
            alignColor: cbAlignColor.value,
            alignLum: cbAlignLum.value,
            alignSat: cbAlignSat.value,
            allowShapeToText: cbShapeToText.value
        };
    }

    function fx(a, b) { return a <= b ? [a, b] : [b, a]; }
    function fixMinMax(p) {
        [p.hueMin, p.hueMax] = fx(p.hueMin, p.hueMax);
        [p.satMin, p.satMax] = fx(p.satMin, p.satMax);
        [p.lumMin, p.lumMax] = fx(p.lumMin, p.lumMax);
        [p.opacityMin, p.opacityMax] = fx(p.opacityMin, p.opacityMax);
        [p.posXMin, p.posXMax] = fx(p.posXMin, p.posXMax);
        [p.posYMin, p.posYMax] = fx(p.posYMin, p.posYMax);
        [p.rotMin, p.rotMax] = fx(p.rotMin, p.rotMax);
        [p.sizePxMin, p.sizePxMax] = fx(p.sizePxMin, p.sizePxMax);
        [p.sizePctMin, p.sizePctMax] = fx(p.sizePctMin, p.sizePctMax);
        return p;
    }

    function writeParamsToDialog(p) {
        if (p.mode != null) rgMode.selectedIndex = p.mode;
        if (p.mapMode != null) rgSeq.selectedIndex = p.mapMode;
        if (p.bitmapMode != null) rgBmp.selectedIndex = p.bitmapMode;
        if (p.seed != null) edSeed.value = p.seed;
        if (p.sameJitterPerSource != null) cbSameJitter.value = p.sameJitterPerSource;
        if (p.hueMin != null) edHueMin.value = p.hueMin;
        if (p.hueMax != null) edHueMax.value = p.hueMax;
        if (p.satMin != null) edSatMin.value = p.satMin;
        if (p.satMax != null) edSatMax.value = p.satMax;
        if (p.lumMin != null) edLumMin.value = p.lumMin;
        if (p.lumMax != null) edLumMax.value = p.lumMax;
        if (p.opacityMin != null) edOpMin.value = p.opacityMin;
        if (p.opacityMax != null) edOpMax.value = p.opacityMax;
        if (p.geoJitter != null) cbGeo.value = p.geoJitter;
        if (p.posXMin != null) edPosXMin.value = p.posXMin;
        if (p.posXMax != null) edPosXMax.value = p.posXMax;
        if (p.posYMin != null) edPosYMin.value = p.posYMin;
        if (p.posYMax != null) edPosYMax.value = p.posYMax;
        if (p.rotMin != null) edRotMin.value = p.rotMin;
        if (p.rotMax != null) edRotMax.value = p.rotMax;
        if (p.rotIncrement != null) edRotInc.value = p.rotIncrement;
        if (p.sizePxMin != null) edSizePxMin.value = p.sizePxMin;
        if (p.sizePxMax != null) edSizePxMax.value = p.sizePxMax;
        if (p.sizePctMin != null) edSizePctMin.value = p.sizePctMin;
        if (p.sizePctMax != null) edSizePctMax.value = p.sizePctMax;
        if (p.transferBlend != null) cbBlend.value = p.transferBlend;
        if (p.preserveAspect != null) cbAspect.value = p.preserveAspect;
        if (p.alignColor != null) cbAlignColor.value = p.alignColor;
        if (p.alignLum != null) cbAlignLum.value = p.alignLum;
        if (p.alignSat != null) cbAlignSat.value = p.alignSat;
        if (p.allowShapeToText != null) cbShapeToText.value = p.allowShapeToText;
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
            const path = getPresetDir() + '/' + name.trim() + '.fkt-preset.json';
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

    // ---------- Apply (v19: everything in ONE CompoundCommand) ----------
    function doApply(p) {
        setSeed(p.seed);
        const batch = makeBatch();
        const srcArr = collectChildren(groups.src);
        const dstArr = collectChildren(groups.dst);
        const map = buildMapping(srcArr.length, dstArr.length, p.mapMode);
        const jitterCache = {};
        let skipped = 0;
        for (let i = 0; i < dstArr.length; i++) {
            try {
                const dst = dstArr[i];
                let dh, ds, dl, da;
                if (p.sameJitterPerSource && p.mode !== 3) {
                    const key = map[i];
                    if (!(key in jitterCache)) {
                        jitterCache[key] = {
                            dh: rand(p.hueMin, p.hueMax), ds: rand(p.satMin, p.satMax),
                            dl: rand(p.lumMin, p.lumMax), da: rand(p.opacityMin, p.opacityMax)
                        };
                    }
                    ({ dh, ds, dl, da } = jitterCache[key]);
                } else {
                    dh = rand(p.hueMin, p.hueMax); ds = rand(p.satMin, p.satMax);
                    dl = rand(p.lumMin, p.lumMax); da = rand(p.opacityMin, p.opacityMax);
                }

                if (p.mode === 3) {
                    const fd = getFDFromNode(dst, false);
                    if (fd) addFDCommand(batch, dst, jitterOwnFD(fd, dh, ds, dl, da), false);
                    const pfd = getFDFromNode(dst, true);
                    if (pfd) addFDCommand(batch, dst, jitterOwnFD(pfd, dh, ds, dl, da), true);
                } else {
                    const src = srcArr[map[i]];
                    const srcIsText = isTextNode(src);
                    const dstIsText = isTextNode(dst);
                    const bothShapes = !srcIsText && !dstIsText;
                    const transferAllowed = isTransferAllowed(srcIsText, dstIsText, p.allowShapeToText);

                    if (transferAllowed) {
                        if (p.mode === 0 || p.mode === 2) {
                            const srcFD = getFDFromNode(src, false);
                            if (srcFD) {
                                const dstFD = getFDFromNode(dst, false);
                                const deltas = computeAlignedDeltas(srcFD.fill, dstFD ? dstFD.fill : null, p, dh, ds, dl);
                                const jf = jitterFillPreserveType(srcFD.fill, deltas.dh, deltas.ds, deltas.dl, da);
                                const dstOwnBlend = dstFD ? dstFD.blendMode : srcFD.blendMode;
                                const nfd = bothShapes
                                    ? buildFD(srcFD, localBB(src), localBB(dst), jf, p.bitmapMode, p.preserveAspect, p.transferBlend, dstOwnBlend)
                                    : buildFDNoRemap(srcFD, jf, p.transferBlend, dstOwnBlend);
                                addFDCommand(batch, dst, nfd, false);
                            }
                        }
                        if (p.mode === 1 || p.mode === 2) {
                            const srcPFD = getFDFromNode(src, true);
                            if (srcPFD) {
                                const dstPFD = getFDFromNode(dst, true);
                                const deltas = computeAlignedDeltas(srcPFD.fill, dstPFD ? dstPFD.fill : null, p, dh, ds, dl);
                                const jf = jitterFillPreserveType(srcPFD.fill, deltas.dh, deltas.ds, deltas.dl, da);
                                const dstOwnBlend = dstPFD ? dstPFD.blendMode : srcPFD.blendMode;
                                const npfd = bothShapes
                                    ? buildFD(srcPFD, localBB(src), localBB(dst), jf, p.bitmapMode, p.preserveAspect, p.transferBlend, dstOwnBlend)
                                    : buildFDNoRemap(srcPFD, jf, p.transferBlend, dstOwnBlend);
                                addFDCommand(batch, dst, npfd, true);
                                if (bothShapes) {
                                    try { addLineStyleExceptWeight(batch, src, dst); } catch (e2) { /* optional */ }
                                }
                            }
                        }

                        if (p.transferBlend && bothShapes) {
                            try { batch.add(DocumentCommand.createSetBlendMode(dst.selfSelection, src.blendMode)); } catch (e3) { /* optional */ }
                        }
                    }
                }

                if (p.geoJitter) {
                    const bb = dst.getSpreadBaseBox(false);
                    const refDim = (bb.width + bb.height) / 2;
                    const dxPx = rand(p.posXMin, p.posXMax);
                    const dyPx = rand(p.posYMin, p.posYMax);
                    const dRot = jitterRotation(p.rotMin, p.rotMax, p.rotIncrement);
                    const dSizePx = rand(p.sizePxMin, p.sizePxMax);
                    const dSizePct = rand(p.sizePctMin, p.sizePctMax);
                    const scaleFactor = (1 + dSizePct / 100) * (1 + (refDim > 0 ? dSizePx / refDim : 0));
                    addGeoJitter(batch, dst, dxPx, dyPx, dRot, scaleFactor);
                }
            } catch (e) {
                skipped++;
            }
        }
        batch.run();
        return skipped;
    }

    const basePos = doc.history.position;
    // Single undo steps (updates the History panel; safe at position 0)
    function undoToBase() {
        let guard = 0;
        while (doc.history.position > basePos && guard++ < 100000) {
            doc.history.undo();
        }
    }

    let hasPreviewed = false;
    let previewKey = null;

    function updatePreview() {
        undoToBase();
        hasPreviewed = false;
        previewKey = null;
        try {
            const p = fixMinMax(readParams());
            doApply(p);
            hasPreviewed = true;
            previewKey = JSON.stringify(p);
        } catch (e) {
            undoToBase();
            app.alert('Error: ' + e.message, TITLE);
        }
    }

    btnLoad.setOnClickHandler(() => { loadPreset(); });
    btnSave.setOnClickHandler(() => { savePreset(); });
    btnPreview.setOnClickHandler(() => { updatePreview(); });

    const result = dlg.runModal();

    if (!result || result.value === DialogResult.Cancel.value) {
        undoToBase();
    } else {
        const p = fixMinMax(readParams());
        if (!(hasPreviewed && previewKey === JSON.stringify(p))) {
            if (hasPreviewed) undoToBase();
            try {
                const skipped = doApply(p);
                if (skipped > 0) app.alert(skipped + ' object(s) could not be processed and were skipped.', TITLE);
            } catch (e) {
                undoToBase();
                app.alert('Error: ' + e.message, TITLE);
            }
        }
        try { resetToGroupSelection(); } catch (e) { /* selection optional */ }
    }
})();
