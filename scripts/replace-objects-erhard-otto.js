// Replace Objects v11
// Replaces the objects of the "target" group (more objects) with duplicates of the objects of
// the "base" group (fewer objects). Each target object is replaced at its position/size by a
// duplicate of the assigned base object (the original stays in the base group).
// Fill/stroke of the duplicates are varied via colour jitter (hue/saturation/lightness/opacity),
// position/rotation/size via geometry jitter. Rotation supports an increment (e.g. 90°).
//
// v2-v8: bitmap jitter in JS, cleanupBasisLeaks(), selection reset, one runModal(),
//        presets subfolder, text support (GlyphAtts/StoryDelta).
// v9:  safe rollback at history position 0, OK recalculates when settings changed.
//
// v10: Few history steps instead of about 7 per target object. Affinity's undo history is
//      limited to roughly 1070 steps; from about 150 targets on, the oldest preview steps
//      dropped out of the history and were no longer reverted.
//      1) Duplicating in rounds: per round ONE command that duplicates all base objects
//         needed in that round (number of rounds = highest use count of a base object).
//         The new objects come back via cmd.newNodes in document order; every match is
//         checked by signature (type, box, fill colour), on mismatch the round is
//         duplicated one by one.
//      2) Placing, colour jitter, reordering and deleting the targets run in ONE
//         CompoundCommand. Tested live: 300 targets, 3 base objects -> 101 instead of
//         about 2100 steps, rollback exact.
//
// v11: GUI split into tabs (pages), as in "Transform Objects" v8: on the left a permanently
//      visible column (tab selection, info, preview and presets), on the right two columns per
//      page. The groups of the active page are shown, all others hidden (group.isVisible).
//      Pages: 1 Assignment, 2 Colour jitter, 3 Geometry jitter. Functions unchanged from v10.
(function () {
    const { Document } = require('/document');
    const { Selection } = require('/selections');
    const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
    const { Colour } = require('/colours');
    const { FillDescriptor, FillType } = require('/fills');
    const { Transform } = require('/geometry');
    const { NodeMoveType, NodeChildType } = require('affinity:dom');
    const { Dialog, DialogResult, UnitType } = require('/dialog');
    const { app } = require('/application');
    const { StoryDelta } = require('/storydelta');

    const TITLE = 'Replace Objects';
    const doc = Document.current;
    if (!doc) { app.alert('No document open.', TITLE); return; }

    // Safe rollback - "doc.history.position = 0" throws COMMAND_FAILED.
    function rollbackTo(pos) {
        if (doc.history.position === pos) return;
        try { doc.history.position = pos; } catch (e) { /* position 0: undo loop below */ }
        let guard = 0;
        while (doc.history.position > pos && guard++ < 100000) doc.history.undo();
    }

    // Collects commands for ONE CompoundCommand (an empty compound throws INVALID_OP)
    function makeBatch() {
        const builder = CompoundCommandBuilder.create();
        let count = 0;
        return {
            add(cmd) { builder.addCommand(cmd); count++; },
            run() { if (count > 0) doc.executeCommand(builder.createCommand()); return count; }
        };
    }

    function toArr(x) { try { return x.toArray ? x.toArray() : Array.from(x); } catch (e) { return []; } }

    // Comparison signature for matching duplicate <-> base object
    function nodeSig(n) {
        let s = (n[Symbol.toStringTag] || '') + '|';
        try { const b = n.getSpreadBaseBox(false); s += [b.x, b.y, b.width, b.height].map(v => v.toFixed(2)).join(','); } catch (e) { s += '?'; }
        try {
            const fd = n.brushFillDescriptor;
            if (fd && fd.fill) {
                s += '|' + fd.fill.fillType.value;
                if (fd.fill.colour) { const c = fd.fill.colour.rgba8; s += ':' + c.r + ',' + c.g + ',' + c.b + ',' + c.alpha; }
            }
        } catch (e) { /* no fill */ }
        return s;
    }

    // v10: duplicates srcArr[map[t]] for every target t in as few commands as possible.
    function duplicateRounds(srcArr, map) {
        const docIdx = srcArr.map(() => -1);
        let i = 0;
        for (const l of doc.layers.all) {
            for (let s = 0; s < srcArr.length; s++) if (docIdx[s] < 0 && l.isSameNode(srcArr[s])) docIdx[s] = i;
            i++;
        }
        const perSrc = srcArr.map(() => []);
        map.forEach((s, t) => perSrc[s].push(t));
        let rounds = 0;
        for (const a of perSrc) rounds = Math.max(rounds, a.length);
        const dups = new Array(map.length).fill(null);
        for (let r = 0; r < rounds; r++) {
            const needed = [];
            for (let s = 0; s < srcArr.length; s++) if (perSrc[s].length > r) needed.push(s);
            needed.sort((a, b) => docIdx[a] - docIdx[b]);
            const cmd = DocumentCommand.createTransform(Selection.create(doc, needed.map(s => srcArr[s])), null, { duplicateNodes: true });
            doc.executeCommand(cmd);
            const nn = toArr(cmd.newNodes);
            let ok = nn.length === needed.length;
            for (let k = 0; ok && k < nn.length; k++) if (nodeSig(nn[k]) !== nodeSig(srcArr[needed[k]])) ok = false;
            if (ok) { needed.forEach((s, k) => { dups[perSrc[s][r]] = nn[k]; }); continue; }
            // Matching not unique -> discard this round and duplicate one by one
            if (nn.length) doc.executeCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, nn)));
            for (const s of needed) {
                const c1 = DocumentCommand.createTransform(Selection.create(doc, [srcArr[s]]), null, { duplicateNodes: true });
                doc.executeCommand(c1);
                dups[perSrc[s][r]] = toArr(c1.newNodes)[0] || null;
            }
        }
        return dups;
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

    function jitterRotation(rotMin, rotMax, increment) {
        if (increment && increment > 0) {
            const nSteps = Math.floor((rotMax - rotMin) / increment) + 1;
            const stepIdx = Math.floor(rand(0, nSteps));
            return rotMin + stepIdx * increment;
        }
        return rand(rotMin, rotMax);
    }

    // v10: returns the placement transform (added to the compound)
    function placeAndJitterTF(node, targetBB, p) {
        const m = node.transform.data;
        const sx = Math.sqrt(m[0] * m[0] + m[3] * m[3]);
        const sy = Math.sqrt(m[1] * m[1] + m[4] * m[4]);
        const theta = Math.atan2(m[3], m[0]);

        const srcBB = node.getSpreadBaseBox(false);
        let fitScaleX = targetBB.width / (srcBB.width || 1);
        let fitScaleY = targetBB.height / (srcBB.height || 1);
        if (p.preserveAspect) {
            const u = Math.min(fitScaleX, fitScaleY);
            fitScaleX = u; fitScaleY = u;
        }

        let dRot = 0, dxPx = 0, dyPx = 0, extraScale = 1;
        if (p.geoJitter) {
            dRot = jitterRotation(p.rotMin, p.rotMax, p.rotIncrement);
            const dSizePx = rand(p.sizePxMin, p.sizePxMax);
            const dSizePct = rand(p.sizePctMin, p.sizePctMax);
            const refDim = (targetBB.width + targetBB.height) / 2;
            extraScale = (1 + dSizePct / 100) * (1 + (refDim > 0 ? dSizePx / refDim : 0));
            dxPx = rand(p.posXMin, p.posXMax);
            dyPx = rand(p.posYMin, p.posYMax);
        }

        const finalSx = sx * fitScaleX * extraScale;
        const finalSy = sy * fitScaleY * extraScale;
        const finalTheta = theta + dRot * Math.PI / 180;

        const cosN = Math.cos(finalTheta), sinN = Math.sin(finalTheta);
        const m11z = finalSx * cosN, m12z = -finalSy * sinN, m21z = finalSx * sinN, m22z = finalSy * cosN;

        const det = m[0] * m[4] - m[1] * m[3];
        if (Math.abs(det) < 1e-12) return null;
        const inv11 = m[4] / det, inv12 = -m[1] / det, inv21 = -m[3] / det, inv22 = m[0] / det;
        const d11 = m11z * inv11 + m12z * inv21, d12 = m11z * inv12 + m12z * inv22;
        const d21 = m21z * inv11 + m22z * inv21, d22 = m21z * inv12 + m22z * inv22;

        const srcCx = srcBB.x + srcBB.width / 2, srcCy = srcBB.y + srcBB.height / 2;
        const tgtCx = targetBB.x + targetBB.width / 2 + dxPx, tgtCy = targetBB.y + targetBB.height / 2 + dyPx;
        const tx = tgtCx - (d11 * srcCx + d12 * srcCy);
        const ty = tgtCy - (d21 * srcCx + d22 * srcCy);

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

    // ---------- Determine groups ----------
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
        app.alert('Please select exactly two groups with different object counts.\n\nBase = group with fewer objects (is kept)\nTarget = group with more objects (gets replaced)', TITLE);
        return;
    }

    const srcCount = collectChildren(groups.src).length;
    const dstCount = collectChildren(groups.dst).length;

    const originalSrcChildren = collectChildren(groups.src);

    function resetToGroupSelection() {
        doc.executeCommand(DocumentCommand.createSetSelection(Selection.create(doc, [groups.src, groups.dst])));
    }

    // ---------- Dialog (v11: tabbed GUI) ----------
    // On the left a narrow, permanently visible column (tab selection, info, preview, presets),
    // on the right two content columns. Each page consists of groups in these two columns;
    // when switching, the groups of the active page are shown and all others hidden.
    const PAGE_TITLES = ['1  Assignment', '2  Colour jitter', '3  Geometry jitter'];
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
    gInfo.addStaticText('', 'Base: ' + srcCount + ' objects\nTarget: ' + dstCount + ' objects (will be replaced)');
    const gAction = cNav.addGroup('Action');
    const btnPreview = gAction.addButton('Preview');
    const btnLoad = gAction.addButton('Load preset');
    const btnSave = gAction.addButton('Save preset');

    // Page 1: Assignment
    const gSeq = pageGroup(0, cA, 'Assignment');
    const rgSeq = gSeq.addRadioGroup('', ['Random', 'Sequential', 'Reverse', 'Ping-pong'], 0);
    const edSeed = gSeq.addUnitValueEditor('Random seed (0=random)', UnitType.Number, UnitType.Number, null, 0, 999999); edSeed.value = 0;
    const cbSameJitter = gSeq.addCheckBox('Same jitter per source object', false);
    const gFit = pageGroup(0, cB, 'Placement');
    const cbAspect = gFit.addCheckBox('Keep aspect ratio', false);

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

    rNav.selectedIndex = 0;
    showPage(0);
    try { rNav.setOnValueChangedHandler(() => { showPage(rNav.selectedIndex); }); } catch (e) { /* ignore */ }

    function readParams() {
        return {
            mapMode: rgSeq.selectedIndex,
            seed: edSeed.value,
            sameJitterPerSource: cbSameJitter.value,
            preserveAspect: cbAspect.value,
            hueMin: edHueMin.value, hueMax: edHueMax.value,
            satMin: edSatMin.value, satMax: edSatMax.value,
            lumMin: edLumMin.value, lumMax: edLumMax.value,
            opacityMin: edOpMin.value, opacityMax: edOpMax.value,
            geoJitter: cbGeo.value,
            posXMin: edPosXMin.value, posXMax: edPosXMax.value,
            posYMin: edPosYMin.value, posYMax: edPosYMax.value,
            rotMin: edRotMin.value, rotMax: edRotMax.value,
            rotIncrement: edRotInc.value,
            sizePxMin: edSizePxMin.value, sizePxMax: edSizePxMax.value,
            sizePctMin: edSizePctMin.value, sizePctMax: edSizePctMax.value
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
        if (p.mapMode != null) rgSeq.selectedIndex = p.mapMode;
        if (p.seed != null) edSeed.value = p.seed;
        if (p.sameJitterPerSource != null) cbSameJitter.value = p.sameJitterPerSource;
        if (p.preserveAspect != null) cbAspect.value = p.preserveAspect;
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
            const path = getPresetDir() + '/' + name.trim() + '.oe-preset.json';
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

    // ---------- Apply ----------
    function jitterOwnFillDescriptor(fd, dh, ds, dl, da) {
        const fill = fd.fill;
        const ft = fill.fillType.value;
        const { GradientFill, BitmapFill } = require('/fills');
        const { Gradient } = require('/colours');
        if (ft === FillType.Solid.value) {
            return FillDescriptor.createSolid(jitterHSL(fill.colour, dh, ds, dl, da), fd.blendMode);
        }
        if (ft === FillType.Gradient.value) {
            const g = fill.gradient;
            const stops = [];
            for (let i = 0; i < g.stopCount; i++) {
                const st = g.getStop(i);
                const col = new Colour(st.colour);
                stops.push({ colour: jitterHSL(col, dh, ds, dl, da), position: st.position, midpoint: st.midpoint });
            }
            const nf = GradientFill.create(Gradient.create(stops), fill.gradientFillType);
            return FillDescriptor.create(nf, fd.isScaleWithObject, fd.transform, fd.blendMode, fd.isAnchoredToSpread);
        }
        if (ft === FillType.Hatch.value) {
            const nh = fill.clone();
            if (fill.penColour) nh.penColour = jitterHSL(fill.penColour, dh, ds, dl, da);
            if (fill.brushColour) nh.brushColour = jitterHSL(fill.brushColour, dh, ds, dl, da);
            return FillDescriptor.create(nh, fd.isScaleWithObject, fd.transform, fd.blendMode, fd.isAnchoredToSpread);
        }
        if (ft === FillType.Bitmap.value) {
            const needsJitter = !(dh === 0 && ds === 0 && dl === 0 && da === 0);
            if (!needsJitter) return fd;
            const { RasterFormat } = require('/rasterobject');
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
            return FillDescriptor.create(newFill, fd.isScaleWithObject, fd.transform, fd.blendMode, fd.isAnchoredToSpread);
        }
        return fd;
    }

    function doApply(p) {
        setSeed(p.seed);
        const srcArr = collectChildren(groups.src);
        const dstArr = collectChildren(groups.dst);
        const map = buildMapping(srcArr.length, dstArr.length, p.mapMode);
        const targetBoxes = dstArr.map(d => d.getSpreadBaseBox(false));

        // Step 1: create all duplicates in few commands
        const dups = duplicateRounds(srcArr, map);

        // Step 2: place, colour, reorder and delete in ONE CompoundCommand
        const batch = makeBatch();
        const jitterCache = {};
        let skipped = 0;
        for (let i = 0; i < dstArr.length; i++) {
            try {
                const dst = dstArr[i];
                const dup = dups[i];
                let dh, ds, dl, da;
                if (p.sameJitterPerSource) {
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
                if (!dup) throw new Error('no duplicate');

                const tf = placeAndJitterTF(dup, targetBoxes[i], p);
                if (tf) batch.add(DocumentCommand.createTransform(dup.selfSelection, tf));

                const fd = getFDFromNode(dup, false);
                if (fd) addFDCommand(batch, dup, jitterOwnFillDescriptor(fd, dh, ds, dl, da), false);
                const pfd = getFDFromNode(dup, true);
                if (pfd) addFDCommand(batch, dup, jitterOwnFillDescriptor(pfd, dh, ds, dl, da), true);

                batch.add(DocumentCommand.createMoveNodes(dup.selfSelection, dst, NodeMoveType.Before, NodeChildType.Main));
                batch.add(DocumentCommand.createDeleteSelection(dst.selfSelection));
            } catch (e) {
                skipped++;
            }
        }
        batch.run();
        return skipped;
    }

    // ---------- Dialog (ONE runModal() call) ----------
    const basePos = doc.history.position;

    function cleanupBasisLeaks() {
        const current = collectChildren(groups.src);
        for (const ch of current) {
            let isOriginal = false;
            for (const orig of originalSrcChildren) {
                if (ch.isSameNode(orig)) { isOriginal = true; break; }
            }
            if (!isOriginal) {
                try { doc.executeCommand(DocumentCommand.createDeleteSelection(ch.selfSelection)); } catch (e) { /* ignore */ }
            }
        }
    }

    function undoToBase() {
        rollbackTo(basePos);
        cleanupBasisLeaks();
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
                if (skipped > 0) app.alert(skipped + ' object(s) could not be replaced and were skipped.', TITLE);
            } catch (e) {
                undoToBase();
                app.alert('Error: ' + e.message, TITLE);
            }
        }
        cleanupBasisLeaks();
        try { resetToGroupSelection(); } catch (e) { /* selection optional */ }
    }
})();
