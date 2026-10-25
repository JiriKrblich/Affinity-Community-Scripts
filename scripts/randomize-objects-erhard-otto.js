// Randomize Objects v11 (EN)
// Applies random jitter directly to the currently selected objects (a group of objects OR
// single objects, also mixed). There is NO transfer between two groups - each object keeps
// its own shape/fill/stroke, only the values are varied randomly:
// - Colour jitter (hue/saturation/lightness/opacity), on fill only, stroke only, or both.
// - Geometry jitter: position, rotation (with optional increment, e.g. 90°), and size -
//   size separately for X and Y in px AND %, with "keep aspect ratio" option.
//
// v2-v8: selection reset, "treat group as one object", one runModal(), presets subfolder,
//        text support (GlyphAtts/StoryDelta).
// v9:  safe rollback at history position 0, OK recalculates when settings changed.
//
// v10: A pass is now ONE history step. Affinity's undo history is limited to roughly
//      1070 steps; so far every object created 1-3 steps of its own, so with large
//      selections the oldest preview steps dropped out of the history and were no longer
//      reverted. All fills, strokes, text colours (createFormatText) and transforms now run
//      in one CompoundCommand.
//
// v11: GUI split into tabs (pages), as in "Transform Objects" v8: on the left a permanently
//      visible column (tab selection, info, preview and presets), on the right two columns per
//      page. The groups of the active page are shown, all others hidden (group.isVisible).
//      Pages: 1 General, 2 Colour jitter, 3 Geometry jitter. Functions unchanged from v10.
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

    const TITLE = 'Randomize Objects';
    const doc = Document.current;
    if (!doc) { app.alert('No document open.', TITLE); return; }

    // Safe rollback - "doc.history.position = 0" throws COMMAND_FAILED.
    function rollbackTo(pos) {
        if (doc.history.position === pos) return;
        try { doc.history.position = pos; } catch (e) { /* position 0: undo loop below */ }
        let guard = 0;
        while (doc.history.position > pos && guard++ < 100000) doc.history.undo();
    }

    // v10: collects commands for ONE CompoundCommand (an empty compound throws INVALID_OP)
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

    function jitterOwnFillDescriptor(fd, dh, ds, dl, da) {
        const fill = fd.fill;
        const ft = fill.fillType.value;
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
    // v10: add the command to the compound instead of executing it (text via createFormatText)
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

    function addGeoJitter(batch, node, dxPx, dyPx, dRotDeg, scaleFactorX, scaleFactorY) {
        if (dxPx === 0 && dyPx === 0 && dRotDeg === 0 &&
            Math.abs(scaleFactorX - 1) < 1e-9 && Math.abs(scaleFactorY - 1) < 1e-9) return 0;
        const m = node.transform.data;
        const sx = Math.sqrt(m[0] * m[0] + m[3] * m[3]);
        const sy = Math.sqrt(m[1] * m[1] + m[4] * m[4]);
        const theta = Math.atan2(m[3], m[0]);
        const rad = dRotDeg * Math.PI / 180;
        const cosN = Math.cos(theta + rad), sinN = Math.sin(theta + rad);
        const m11z = sx * scaleFactorX * cosN, m12z = -sy * scaleFactorY * sinN;
        const m21z = sx * scaleFactorX * sinN, m22z = sy * scaleFactorY * cosN;
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

    // v10: derive targets from the snapshotted selection (no longer from doc.selection)
    function collectTargets(treatGroupAsObject) {
        if (treatGroupAsObject) return originalSelectionNodes.slice();
        const out = [];
        function walk(n) {
            if (n.children && n.children.length > 0) {
                for (const ch of n.children) walk(ch);
            } else {
                out.push(n);
            }
        }
        for (const n of originalSelectionNodes) walk(n);
        return out;
    }

    const originalSelectionNodes = [];
    for (let i = 0; i < doc.selection.length; i++) originalSelectionNodes.push(doc.selection.at(i).node);
    function resetToOriginalSelection() {
        doc.executeCommand(DocumentCommand.createSetSelection(Selection.create(doc, originalSelectionNodes)));
    }

    const initialTargets = collectTargets(false);
    if (initialTargets.length === 0) {
        app.alert('Please select at least one object or group.', TITLE);
        return;
    }
    const initialCount = initialTargets.length;

    // ---------- Dialog (v11: tabbed GUI) ----------
    // On the left a narrow, permanently visible column (tab selection, info, preview, presets),
    // on the right two content columns. Each page consists of groups in these two columns;
    // when switching, the groups of the active page are shown and all others hidden.
    const PAGE_TITLES = ['1  General', '2  Colour jitter', '3  Geometry jitter'];
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
    gInfo.addStaticText('', initialCount + ' object(s) selected');
    const gAction = cNav.addGroup('Action');
    const btnPreview = gAction.addButton('Preview');
    const btnLoad = gAction.addButton('Load preset');
    const btnSave = gAction.addButton('Save preset');

    // Page 1: General
    const gGen = pageGroup(0, cA, 'General');
    const cbTreatGroup = gGen.addCheckBox('Geometry: move/rotate/scale group as one object', false);
    const edSeed = gGen.addUnitValueEditor('Random seed (0=random)', UnitType.Number, UnitType.Number, null, 0, 999999); edSeed.value = 0;
    const gMode = pageGroup(0, cB, 'Apply colour jitter to');
    const rgMode = gMode.addRadioGroup('', ['Fill only', 'Stroke only', 'Fill and stroke'], 2);
    try { rgMode.selectedIndex = 2; } catch (e) { /* ignore */ }

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
    const gRot = pageGroup(2, cA, 'Rotation (°)');
    const edRotMin = gRot.addUnitValueEditor('Min', UnitType.Degree, UnitType.Degree, null, -360, 360); edRotMin.value = 0;
    const edRotMax = gRot.addUnitValueEditor('Max', UnitType.Degree, UnitType.Degree, null, -360, 360); edRotMax.value = 0;
    const edRotInc = gRot.addUnitValueEditor('Increment (0=continuous)', UnitType.Degree, UnitType.Degree, null, 0, 360); edRotInc.value = 0;
    const gAspect = pageGroup(2, cB, 'Size');
    const cbAspect = gAspect.addCheckBox('Keep aspect ratio (uses X values only)', false);
    const gSizePxX = pageGroup(2, cB, 'Size X jitter (px)');
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
            colorMode: rgMode.selectedIndex,
            treatGroupAsObject: cbTreatGroup.value,
            seed: edSeed.value,
            hueMin: edHueMin.value, hueMax: edHueMax.value,
            satMin: edSatMin.value, satMax: edSatMax.value,
            lumMin: edLumMin.value, lumMax: edLumMax.value,
            opacityMin: edOpMin.value, opacityMax: edOpMax.value,
            geoJitter: cbGeo.value,
            posXMin: edPosXMin.value, posXMax: edPosXMax.value,
            posYMin: edPosYMin.value, posYMax: edPosYMax.value,
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
        [p.posXMin, p.posXMax] = fx(p.posXMin, p.posXMax);
        [p.posYMin, p.posYMax] = fx(p.posYMin, p.posYMax);
        [p.rotMin, p.rotMax] = fx(p.rotMin, p.rotMax);
        [p.sizePxXMin, p.sizePxXMax] = fx(p.sizePxXMin, p.sizePxXMax);
        [p.sizePxYMin, p.sizePxYMax] = fx(p.sizePxYMin, p.sizePxYMax);
        [p.sizePctXMin, p.sizePctXMax] = fx(p.sizePctXMin, p.sizePctXMax);
        [p.sizePctYMin, p.sizePctYMax] = fx(p.sizePctYMin, p.sizePctYMax);
        return p;
    }

    function writeParamsToDialog(p) {
        if (p.colorMode != null) rgMode.selectedIndex = p.colorMode;
        if (p.treatGroupAsObject != null) cbTreatGroup.value = p.treatGroupAsObject;
        if (p.seed != null) edSeed.value = p.seed;
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
            const path = getPresetDir() + '/' + name.trim() + '.ro-preset.json';
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

    // ---------- Apply (v10: everything in ONE CompoundCommand) ----------
    function doApply(p) {
        setSeed(p.seed);
        let skipped = 0;
        const batch = makeBatch();

        const colorTargets = collectTargets(false);
        const geoTargets = p.geoJitter ? collectTargets(p.treatGroupAsObject) : [];

        for (const node of colorTargets) {
            try {
                const dh = rand(p.hueMin, p.hueMax);
                const ds = rand(p.satMin, p.satMax);
                const dl = rand(p.lumMin, p.lumMax);
                const da = rand(p.opacityMin, p.opacityMax);

                if (p.colorMode === 0 || p.colorMode === 2) {
                    const fd = getFDFromNode(node, false);
                    if (fd) addFDCommand(batch, node, jitterOwnFillDescriptor(fd, dh, ds, dl, da), false);
                }
                if (p.colorMode === 1 || p.colorMode === 2) {
                    const pfd = getFDFromNode(node, true);
                    if (pfd) addFDCommand(batch, node, jitterOwnFillDescriptor(pfd, dh, ds, dl, da), true);
                }
            } catch (e) {
                skipped++;
            }
        }

        if (p.geoJitter) {
            for (const node of geoTargets) {
                try {
                    const bb = node.getSpreadBaseBox(false);
                    const refDim = (bb.width + bb.height) / 2;
                    const dxPx = rand(p.posXMin, p.posXMax);
                    const dyPx = rand(p.posYMin, p.posYMax);
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

                    addGeoJitter(batch, node, dxPx, dyPx, dRot, scaleFactorX, scaleFactorY);
                } catch (e) {
                    skipped++;
                }
            }
        }

        batch.run();
        return skipped;
    }

    // ---------- Dialog (ONE runModal() call) ----------
    const basePos = doc.history.position;
    function undoToBase() {
        rollbackTo(basePos);
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
        try { resetToOriginalSelection(); } catch (e) { /* selection optional */ }
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
        try { resetToOriginalSelection(); } catch (e) { /* selection optional */ }
    }
})();
