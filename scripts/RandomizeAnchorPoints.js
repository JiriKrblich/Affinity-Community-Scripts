// Randomize Anchor Points v12 (EN)
// v12: Native preview instead of history entries.
//      - "Preview" no longer creates a history entry (doc.executeCommand(cmd,true));
//        previously one entry per preview plus an undo on the next roll.
//      - After the first preview, every value change in the dialog is shown live
//        immediately (with the displayed seed). "Preview" rolls a new seed as before
//        if the seed is unchanged.
//      - "Apply" calculates with the displayed values and the displayed seed
//        (deterministic, therefore identical to the preview) - ONE history entry.
//      - No history position any more: Cancel discards the preview and only undoes
//        the script's own conversion to curves (counted, with a sentinel object).
// v11: preview remembered its settings incl. seed (replaced by the native preview in v12).
// v10: composedSpreadTF() instead of bestTransform() (transformed groups).

(function () {
    const { app } = require('/application');
    const { Document } = require('/document');
    const { PolyCurve, CurveBuilder } = require('/geometry');
    const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
    const { Dialog, DialogResult, UnitType } = require('/dialog');
    const { SubSelectionType, Selection } = require('/selections');
    const { File, FileSystemApi } = require('/fs');

    const doc = Document.current;
    if (!doc) return;

    function mulberry32(seed) {
        let a = seed >>> 0;
        return function () {
            a |= 0; a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function composedSpreadTF(node) {
        const chain = [];
        let cur = node;
        while (cur) {
            const tag = cur[Symbol.toStringTag] || '';
            if (tag === 'SpreadNode' || tag === 'DocumentNode') break;
            chain.push(cur.transform);
            cur = cur.parent;
        }
        let m = [1,0,0, 0,1,0];
        for (let i = 0; i < chain.length; i++) {
            const d = chain[i].data;
            const a=d[0],b=d[1],tx=d[2],c=d[3],e=d[4],ty=d[5];
            m = [
                m[0]*a + m[1]*c,  m[0]*b + m[1]*e,  m[0]*tx + m[1]*ty + m[2],
                m[3]*a + m[4]*c,  m[3]*b + m[4]*e,  m[3]*tx + m[4]*ty + m[5],
            ];
        }
        const det = m[0]*m[4] - m[1]*m[3];
        const inv = Math.abs(det) < 1e-12
            ? [1,0,0, 0,1,0]
            : [  m[4]/det, -m[1]/det, (m[1]*m[5]-m[4]*m[2])/det,
                -m[3]/det,  m[0]/det, (m[3]*m[2]-m[0]*m[5])/det ];
        return {
            applyToPoint(pt) {
                return { x: m[0]*pt.x + m[1]*pt.y + m[2],
                         y: m[3]*pt.x + m[4]*pt.y + m[5] };
            },
            applyToVector(v) {
                return { x: m[0]*v.x + m[1]*v.y,
                         y: m[3]*v.x + m[4]*v.y };
            },
            inverted: {
                applyToPoint(pt) {
                    return { x: inv[0]*pt.x + inv[1]*pt.y + inv[2],
                             y: inv[3]*pt.x + inv[4]*pt.y + inv[5] };
                }
            }
        };
    }

    function getObjectCenterSpread(node) {
        const bb = node.getSpreadBaseBox(false);
        return { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
    }

    function getFocalPointSpread(node) {
        try {
            const fp = node.transformInterface.focalPoint;
            if (fp.isValid) {
                const tf = composedSpreadTF(node);
                return tf.applyToPoint(fp.point);
            }
        } catch (e) { }
        return getObjectCenterSpread(node);
    }

    function countNodeAnchors(node) {
        let total = 0;
        const cc = node.polyCurve.curveCount;
        for (let ci = 0; ci < cc; ci++) {
            const c = node.polyCurve.at(ci);
            const bez = c.beziers.toArray();
            const nSeg = bez.length;
            if (nSeg === 0) continue;
            total += c.isClosed ? nSeg : nSeg + 1;
        }
        return total;
    }

    function countEligibleAnchors(t) {
        if (t.anchors === null) return countNodeAnchors(t.node);
        let sum = 0;
        for (const s of t.anchors.values()) sum += s.size;
        return sum;
    }

    function getSelectedAnchorMap(node, item) {
        let cns;
        try {
            cns = item.getSubSelectionOfType(SubSelectionType.CurveNode);
        } catch (e) {
            return null;
        }
        if (!cns || cns.isEmpty) return null;

        const curveIndexMaps = new Map();
        function getCurveMap(curveID) {
            if (curveIndexMaps.has(curveID)) return curveIndexMaps.get(curveID);
            const curve = node.polyCurve.at(curveID);
            const m = new Map();
            const onCurveIds = [];
            for (let i = 0; i < curve.nodeCount; i++) {
                if (curve.getNode(i).type.value === 0) onCurveIds.push(i);
            }
            const isClosed = curve.isClosed;
            for (let idx = 0; idx < onCurveIds.length; idx++) {
                const aIdx = (isClosed && idx === onCurveIds.length - 1) ? 0 : idx;
                m.set(onCurveIds[idx], aIdx);
            }
            curveIndexMaps.set(curveID, m);
            return m;
        }

        const map = new Map();
        for (let k = 0; k < cns.itemCount; k++) {
            const it = cns.getItem(k);
            const cMap = getCurveMap(it.curveID);
            if (!cMap.has(it.nodeID)) continue;
            const aIdx = cMap.get(it.nodeID);
            if (!map.has(it.curveID)) map.set(it.curveID, new Set());
            map.get(it.curveID).add(aIdx);
        }
        return map;
    }

    function buildCurveList() {
        const list = [];
        for (const l of doc.layers.all) {
            if (l.polyCurve !== undefined) list.push(l);
        }
        return list;
    }
    function nodeInDoc(n) {
        if (!n) return false;
        try { for (const l of doc.layers.all) if (l.isSameNode(n)) return true; } catch (e) { }
        return false;
    }

    if (doc.selection.length === 0) {
        app.alert('Please select at least one object first.', 'Randomize Anchor Points');
        return;
    }

    let targetInfos = [];
    const roots = [];
    for (let i = 0; i < doc.selection.length; i++) {
        const item = doc.selection.at(i);
        const node = item.node;
        roots.push(node);
        if (node.polyCurve === undefined) continue;
        const anchorMap = getSelectedAnchorMap(node, item);
        if (anchorMap === null) {
            targetInfos.push({ node: node, anchors: null });
        } else if (anchorMap.size > 0) {
            targetInfos.push({ node: node, anchors: anchorMap });
        }
    }

    if (targetInfos.length === 0) {
        app.alert('No selectable anchor points found.\nPlease either select objects without a point selection (whole object) or mark individual anchor points with the Node tool.', 'Randomize Anchor Points');
        return;
    }

    // v12: conversion counted + sentinel object (instead of history position)
    const CONV = { steps: 0, sentinel: null };
    function undoConversion() {
        if (CONV.steps > 0 && nodeInDoc(CONV.sentinel)) {
            for (let i = 0; i < CONV.steps; i++) { try { doc.history.undo(); } catch (e) { break; } }
        }
        CONV.steps = 0; CONV.sentinel = null;
    }

    const needConversion = targetInfos.filter(t => !(t.node.curvesInterface && t.node.curvesInterface.isMutable));
    if (needConversion.length > 0) {
        const curveListBefore = buildCurveList();
        const infos = needConversion.map(t => {
            let seqIdx = -1;
            for (let i = 0; i < curveListBefore.length; i++) {
                if (curveListBefore[i].isSameNode(t.node)) { seqIdx = i; break; }
            }
            return { target: t, seqIdx: seqIdx };
        });
        for (const info of infos) {
            if (info.seqIdx < 0) continue;
            try {
                doc.executeCommand(DocumentCommand.createConvertToCurves(info.target.node.selfSelection));
                CONV.steps++;
            } catch (e) { continue; }
            const curveListAfter = buildCurveList();
            const fresh = curveListAfter[info.seqIdx];
            if (fresh) {
                info.target.node = fresh;
                if (!CONV.sentinel) CONV.sentinel = fresh;
            }
        }
    }

    targetInfos = targetInfos.filter(t => t.node.curvesInterface && t.node.curvesInterface.isMutable);

    if (targetInfos.length === 0) {
        app.alert('The objects could not be converted into editable curves.', 'Randomize Anchor Points');
        undoConversion();
        return;
    }

    const objCenters = targetInfos.map(t => getObjectCenterSpread(t.node));
    const focalCenters = targetInfos.map(t => getFocalPointSpread(t.node));
    const diags = targetInfos.map(t => {
        const bb = t.node.getSpreadBaseBox(false);
        return Math.sqrt(bb.width * bb.width + bb.height * bb.height);
    });
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const t of targetInfos) {
        const bb = t.node.getSpreadBaseBox(false);
        minX = Math.min(minX, bb.x); minY = Math.min(minY, bb.y);
        maxX = Math.max(maxX, bb.x + bb.width); maxY = Math.max(maxY, bb.y + bb.height);
    }
    const selectionCenter = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };

    const totalEligibleAnchors = targetInfos.reduce((acc, t) => acc + countEligibleAnchors(t), 0);
    const wholeObjectAnchorCount = targetInfos.filter(t => t.anchors === null).reduce((acc, t) => acc + countNodeAnchors(t.node), 0);
    const manualAnchorCount = totalEligibleAnchors - wholeObjectAnchorCount;

    function buildJitteredCurve(node, params, center, anchorRestriction, rng, keepHandles, percent) {
        const tf = composedSpreadTF(node);
        const inv = tf.inverted;
        const newPC = PolyCurve.create();
        const curveCount = node.polyCurve.curveCount;
        for (let ci = 0; ci < curveCount; ci++) {
            const curve = node.polyCurve.at(ci);
            const bez = curve.beziers.toArray();
            const nSeg = bez.length;
            if (nSeg === 0) continue;
            const isClosed = curve.isClosed;
            const nAnchors = isClosed ? nSeg : nSeg + 1;
            const anchors = [];
            for (let i = 0; i < nSeg; i++) anchors.push(bez[i].start);
            if (!isClosed) anchors.push(bez[nSeg - 1].end);

            const eligibleSet = anchorRestriction === null ? null : (anchorRestriction.get(ci) || new Set());

            const deltas = anchors.map((a, aIdx) => {
                let isEligible;
                if (eligibleSet === null) {
                    isEligible = (percent >= 100) ? true : (rng() < percent / 100);
                } else {
                    isEligible = eligibleSet.has(aIdx);
                }
                if (!isEligible) return { x: 0, y: 0 };

                const sp = tf.applyToPoint(a);
                let dx = 0, dy = 0;

                if (params.jitterXMin !== 0 || params.jitterXMax !== 0 || params.jitterYMin !== 0 || params.jitterYMax !== 0) {
                    dx += params.jitterXMin + rng() * (params.jitterXMax - params.jitterXMin);
                    dy += params.jitterYMin + rng() * (params.jitterYMax - params.jitterYMin);
                }
                if (params.directionMin !== 0 || params.directionMax !== 0) {
                    const angRad = params.angleDeg * Math.PI / 180;
                    const dist = params.directionMin + rng() * (params.directionMax - params.directionMin);
                    dx += Math.cos(angRad) * dist;
                    dy += Math.sin(angRad) * dist;
                }
                if (params.radialMin !== 0 || params.radialMax !== 0) {
                    let vx = sp.x - center.x, vy = sp.y - center.y;
                    let dist2 = Math.sqrt(vx * vx + vy * vy);
                    if (dist2 < 1e-9) {
                        const ang = rng() * Math.PI * 2;
                        vx = Math.cos(ang); vy = Math.sin(ang); dist2 = 1;
                    }
                    const ux = vx / dist2, uy = vy / dist2;
                    const r = params.radialMin + rng() * (params.radialMax - params.radialMin);
                    dx += ux * r;
                    dy += uy * r;
                }

                const newSp = { x: sp.x + dx, y: sp.y + dy };
                const nl = inv.applyToPoint(newSp);
                return { x: nl.x - a.x, y: nl.y - a.y };
            });

            const addPt = (p, d) => ({ x: p.x + d.x, y: p.y + d.y });
            const builder = CurveBuilder.create();
            const a0 = addPt(anchors[0], deltas[0]);
            builder.beginXY(a0.x, a0.y);
            for (let k = 0; k < nSeg; k++) {
                const nextIdx = (k + 1) % nAnchors;
                const c1 = keepHandles ? bez[k].c1 : addPt(bez[k].c1, deltas[k]);
                const c2 = keepHandles ? bez[k].c2 : addPt(bez[k].c2, deltas[nextIdx]);
                const end = addPt(bez[k].end, deltas[nextIdx]);
                builder.addBezierXY(c1.x, c1.y, c2.x, c2.y, end.x, end.y);
            }
            if (isClosed) builder.close();
            newPC.addCurve(builder.createCurve());
        }
        return newPC;
    }

    // v12: returns ONE compound command (preview or apply), executes nothing.
    // Call doc.clearPreviews() first so it works from the original.
    function makeJitterCommand(centerModeIdx, params, relative, keepHandles, seed, percent) {
        const rng = mulberry32(seed);
        const builder = CompoundCommandBuilder.create();
        for (let i = 0; i < targetInfos.length; i++) {
            const t = targetInfos[i];
            let center;
            if (centerModeIdx === 0) center = selectionCenter;
            else if (centerModeIdx === 1) center = objCenters[i];
            else center = focalCenters[i];

            const scale = relative ? (diags[i] / 100) : 1;
            const scaledParams = {
                jitterXMin: params.jitterXMin * scale,
                jitterXMax: params.jitterXMax * scale,
                jitterYMin: params.jitterYMin * scale,
                jitterYMax: params.jitterYMax * scale,
                radialMin: params.radialMin * scale,
                radialMax: params.radialMax * scale,
                directionMin: params.directionMin * scale,
                directionMax: params.directionMax * scale,
                angleDeg: params.angleDeg
            };
            const newPC = buildJitteredCurve(t.node, scaledParams, center, t.anchors, rng, keepHandles, percent);
            builder.addCommand(DocumentCommand.createSetCurves(t.node.curvesInterface, newPC));
        }
        return builder.createCommand();
    }

    function buildParams(jx, jy, r, d, angle) {
        return {
            jitterXMin: Math.min(jx[0], jx[1]),
            jitterXMax: Math.max(jx[0], jx[1]),
            jitterYMin: Math.min(jy[0], jy[1]),
            jitterYMax: Math.max(jy[0], jy[1]),
            radialMin: Math.min(r[0], r[1]),
            radialMax: Math.max(r[0], r[1]),
            directionMin: Math.min(d[0], d[1]),
            directionMax: Math.max(d[0], d[1]),
            angleDeg: angle
        };
    }

    // v12: native preview (no history entry; replaces the previous preview)
    function showPreview(centerModeIdx, params, relative, keepHandles, seed, percent) {
        doc.clearPreviews();
        try {
            doc.executeCommand(makeJitterCommand(centerModeIdx, params, relative, keepHandles, seed, percent), true);
        } catch (e) {
            doc.clearPreviews();
        }
    }

    function readRadioIndex(rg) {
        const raw = (rg.selectedIndex !== undefined && rg.selectedIndex !== null) ? rg.selectedIndex : rg.value;
        const n = Number(raw);
        return isNaN(n) ? 0 : n;
    }
    function setRadioIndex(rg, idx) {
        try { rg.selectedIndex = idx; } catch (e) { }
        try { rg.value = idx; } catch (e) { }
    }

    const PRESETS_DIR = app.userDesktopPath + '/AffinityScriptPresets';
    const PRESET_PREFIX = 'RandomizeAnchorPoints_';

    function sanitizePresetName(name) {
        return String(name || '').trim().replace(/[^a-zA-Z0-9 _-]/g, '_').slice(0, 80);
    }
    function presetPath(name) {
        return PRESETS_DIR + '/' + PRESET_PREFIX + sanitizePresetName(name) + '.json';
    }
    function savePresetToDisk(name, dataObj) {
        try {
            FileSystemApi.createDirectories(PRESETS_DIR);
            const f = File.create(presetPath(name), 'w');
            f.writeStringAsUtf8(JSON.stringify(dataObj, null, 2));
            f.close();
            return true;
        } catch (e) {
            app.alert('Could not save preset:\n' + e.message, 'Randomize Anchor Points');
            return false;
        }
    }
    function loadPresetFromPath(path) {
        try {
            const buf = File.readAll(path);
            return JSON.parse(buf.toString());
        } catch (e) {
            app.alert('Could not load preset:\n' + e.message, 'Randomize Anchor Points');
            return null;
        }
    }
    function deletePresetAtPath(path) {
        try {
            FileSystemApi.remove(path);
            return true;
        } catch (e) {
            app.alert('Could not delete preset:\n' + e.message, 'Randomize Anchor Points');
            return false;
        }
    }

    function formatLiveCountText(percent) {
        let txt = 'Anchor points in selection: ' + totalEligibleAnchors;
        if (percent < 100 && wholeObjectAnchorCount > 0) {
            const estimated = manualAnchorCount + Math.round(wholeObjectAnchorCount * percent / 100);
            txt += '\nAt ' + percent + '% approx. ' + estimated + ' affected (' + manualAnchorCount + ' of them selected exactly, independent of the percentage)';
        }
        return txt;
    }

    let hasPreview = false;

    let lastCenterMode = 0;
    let lastJX = [0, 0], lastJY = [0, 0], lastR = [0, 0], lastD = [0, 0], lastAngle = 0;
    let lastRelative = false, lastKeepHandles = false;
    let lastPercent = 100;
    let lastSeed = Math.floor(Math.random() * 1000000000);
    let lastUsedSeed = null;
    let applyResult = false;

    while (true) {
        const dlg = Dialog.create('Randomize Anchor Points');
        dlg.initialWidth = 760;
        dlg.setIsResizable(true);

        const col1 = dlg.addColumn();

        const jxLabel = 'Jitter X min' + (lastRelative ? ' (%)' : '');
        const gJXMin = col1.addGroup(jxLabel);
        const edJXMin = gJXMin.addUnitValueEditor(jxLabel, lastRelative ? UnitType.Percentage : UnitType.Pixel, lastRelative ? UnitType.Percentage : UnitType.Pixel, null, -100000, 100000);
        edJXMin.value = lastJX[0];

        const jxMaxLabel = 'Jitter X max' + (lastRelative ? ' (%)' : '');
        const gJXMax = col1.addGroup(jxMaxLabel);
        const edJXMax = gJXMax.addUnitValueEditor(jxMaxLabel, lastRelative ? UnitType.Percentage : UnitType.Pixel, lastRelative ? UnitType.Percentage : UnitType.Pixel, null, -100000, 100000);
        edJXMax.value = lastJX[1];

        const jyLabel = 'Jitter Y min' + (lastRelative ? ' (%)' : '');
        const gJYMin = col1.addGroup(jyLabel);
        const edJYMin = gJYMin.addUnitValueEditor(jyLabel, lastRelative ? UnitType.Percentage : UnitType.Pixel, lastRelative ? UnitType.Percentage : UnitType.Pixel, null, -100000, 100000);
        edJYMin.value = lastJY[0];

        const jyMaxLabel = 'Jitter Y max' + (lastRelative ? ' (%)' : '');
        const gJYMax = col1.addGroup(jyMaxLabel);
        const edJYMax = gJYMax.addUnitValueEditor(jyMaxLabel, lastRelative ? UnitType.Percentage : UnitType.Pixel, lastRelative ? UnitType.Percentage : UnitType.Pixel, null, -100000, 100000);
        edJYMax.value = lastJY[1];

        const col2 = dlg.addColumn();

        const gAngle = col2.addGroup('Angle (direction)');
        const edAngle = gAngle.addUnitValueEditor('Angle (direction)', UnitType.Degree, UnitType.Degree, null, -100000, 100000);
        edAngle.value = lastAngle;

        const dLabel = 'Distance min (direction)' + (lastRelative ? ' (%)' : '');
        const gDMin = col2.addGroup(dLabel);
        const edDMin = gDMin.addUnitValueEditor(dLabel, lastRelative ? UnitType.Percentage : UnitType.Pixel, lastRelative ? UnitType.Percentage : UnitType.Pixel, null, -100000, 100000);
        edDMin.value = lastD[0];

        const dMaxLabel = 'Distance max (direction)' + (lastRelative ? ' (%)' : '');
        const gDMax = col2.addGroup(dMaxLabel);
        const edDMax = gDMax.addUnitValueEditor(dMaxLabel, lastRelative ? UnitType.Percentage : UnitType.Pixel, lastRelative ? UnitType.Percentage : UnitType.Pixel, null, -100000, 100000);
        edDMax.value = lastD[1];

        const rLabel = 'Radial min' + (lastRelative ? ' (%)' : '');
        const gRMin = col2.addGroup(rLabel);
        const edRMin = gRMin.addUnitValueEditor(rLabel, lastRelative ? UnitType.Percentage : UnitType.Pixel, lastRelative ? UnitType.Percentage : UnitType.Pixel, null, -100000, 100000);
        edRMin.value = lastR[0];

        const rMaxLabel = 'Radial max' + (lastRelative ? ' (%)' : '');
        const gRMax = col2.addGroup(rMaxLabel);
        const edRMax = gRMax.addUnitValueEditor(rMaxLabel, lastRelative ? UnitType.Percentage : UnitType.Pixel, lastRelative ? UnitType.Percentage : UnitType.Pixel, null, -100000, 100000);
        edRMax.value = lastR[1];

        const col3 = dlg.addColumn();

        const gCenter = col3.addGroup('Centre (radial only)');
        const rgCenter = gCenter.addRadioGroup('', ['Selection centre', 'Object centre', 'Focal point']);
        setRadioIndex(rgCenter, lastCenterMode);

        const gSeed = col3.addGroup('Seed (random)');
        const edSeed = gSeed.addUnitValueEditor('Seed (random)', UnitType.Number, UnitType.Number, null, 0, 999999999);
        edSeed.value = lastSeed;

        const gPercent = col3.addGroup('Share of affected points (%)');
        const edPercent = gPercent.addUnitValueEditor('Share of affected points (%)', UnitType.Percentage, UnitType.Percentage, null, 0, 100);
        edPercent.value = lastPercent;

        const gLiveCount = col3.addGroup('');
        const stLiveCount = gLiveCount.addStaticText('', formatLiveCountText(lastPercent));
        edPercent.setOnValueChangedHandler(() => {
            stLiveCount.setText(formatLiveCountText(edPercent.value));
        });

        const col4 = dlg.addColumn();

        const gRelative = col4.addGroup('');
        const cbRelative = gRelative.addCheckBox('Values relative to object size (%)', lastRelative);
        cbRelative.value = lastRelative;

        const gKeepHandles = col4.addGroup('');
        const cbKeepHandles = gKeepHandles.addCheckBox("Don't move handles (distort curve)", lastKeepHandles);
        cbKeepHandles.value = lastKeepHandles;

        const gPreset = col4.addGroup('Presets');
        const presetSaveBtn = gPreset.addButton('Save preset...');
        const presetLoadBtn = gPreset.addButton('Load preset...');
        const presetDeleteBtn = gPreset.addButton('Delete preset...');

        // v12: live preview with the current dialog values (only after the first preview)
        function livePreview() {
            if (!hasPreview) return;
            const p = buildParams([edJXMin.value, edJXMax.value], [edJYMin.value, edJYMax.value],
                                  [edRMin.value, edRMax.value], [edDMin.value, edDMax.value], edAngle.value);
            showPreview(readRadioIndex(rgCenter), p, !!cbRelative.value, !!cbKeepHandles.value, edSeed.value, edPercent.value);
        }

        presetSaveBtn.setOnClickHandler(() => {
            const name = app.prompt('Enter preset name:', 'Randomize Anchor Points - Save preset', '');
            if (!name || !name.trim()) return;
            const data = {
                jitterXMin: edJXMin.value, jitterXMax: edJXMax.value,
                jitterYMin: edJYMin.value, jitterYMax: edJYMax.value,
                radialMin: edRMin.value, radialMax: edRMax.value,
                angleDeg: edAngle.value, directionMin: edDMin.value, directionMax: edDMax.value,
                seed: edSeed.value, percent: edPercent.value,
                centerMode: readRadioIndex(rgCenter),
                relative: cbRelative.value, keepHandles: cbKeepHandles.value
            };
            if (savePresetToDisk(name, data)) {
                app.alert('Preset "' + name.trim() + '" saved in:\n' + PRESETS_DIR, 'Randomize Anchor Points');
            }
        });

        presetLoadBtn.setOnClickHandler(() => {
            const path = app.chooseFile();
            if (!path) return;
            const data = loadPresetFromPath(path);
            if (!data) return;
            if (typeof data.jitterXMin === 'number') edJXMin.value = data.jitterXMin;
            if (typeof data.jitterXMax === 'number') edJXMax.value = data.jitterXMax;
            if (typeof data.jitterYMin === 'number') edJYMin.value = data.jitterYMin;
            if (typeof data.jitterYMax === 'number') edJYMax.value = data.jitterYMax;
            if (typeof data.radialMin === 'number') edRMin.value = data.radialMin;
            if (typeof data.radialMax === 'number') edRMax.value = data.radialMax;
            if (typeof data.angleDeg === 'number') edAngle.value = data.angleDeg;
            if (typeof data.directionMin === 'number') edDMin.value = data.directionMin;
            if (typeof data.directionMax === 'number') edDMax.value = data.directionMax;
            if (typeof data.seed === 'number') edSeed.value = data.seed;
            if (typeof data.percent === 'number') edPercent.value = data.percent;
            if (typeof data.centerMode === 'number') setRadioIndex(rgCenter, data.centerMode);
            if (typeof data.relative === 'boolean') cbRelative.value = data.relative;
            if (typeof data.keepHandles === 'boolean') cbKeepHandles.value = data.keepHandles;
            stLiveCount.setText(formatLiveCountText(edPercent.value));
            livePreview();
        });

        presetDeleteBtn.setOnClickHandler(() => {
            const path = app.chooseFile();
            if (!path) return;
            if (deletePresetAtPath(path)) {
                app.alert('Preset file deleted:\n' + path, 'Randomize Anchor Points');
            }
        });

        const gAction = col4.addGroup('Action (confirm with OK)');
        const actionBtns = gAction.addButtonSet('', ['Preview', 'Apply'], 0);

        dlg.setOnControlValueChangedHandler(() => { livePreview(); });

        const result = dlg.runModal();

        lastCenterMode = readRadioIndex(rgCenter);
        lastJX = [edJXMin.value, edJXMax.value];
        lastJY = [edJYMin.value, edJYMax.value];
        lastR = [edRMin.value, edRMax.value];
        lastD = [edDMin.value, edDMax.value];
        lastAngle = edAngle.value;
        lastRelative = !!cbRelative.value;
        lastKeepHandles = !!cbKeepHandles.value;
        lastPercent = edPercent.value;
        lastSeed = edSeed.value;

        if (!result || result.value !== DialogResult.Ok.value) {
            break;
        }

        const action = actionBtns.selectedIndex;
        const params = buildParams(lastJX, lastJY, lastR, lastD, lastAngle);

        if (action === 1) {
            // v12: always calculate with the displayed values and displayed seed
            // (deterministic -> identical to the preview); ONE history entry
            doc.clearPreviews();
            doc.executeCommand(makeJitterCommand(lastCenterMode, params, lastRelative, lastKeepHandles, lastSeed, lastPercent));
            applyResult = true;
            break;
        }

        // Preview: with an unchanged seed, roll a new one automatically
        let seedToUse = lastSeed;
        if (lastUsedSeed !== null && seedToUse === lastUsedSeed) {
            seedToUse = seedToUse + 1;
        }
        lastUsedSeed = seedToUse;
        lastSeed = seedToUse;

        showPreview(lastCenterMode, params, lastRelative, lastKeepHandles, seedToUse, lastPercent);
        hasPreview = true;
    }

    if (!applyResult) {
        // v12: discard the preview, only undo the script's own conversion
        doc.clearPreviews();
        undoConversion();
    }

    try {
        doc.executeCommand(DocumentCommand.createSetSelection(Selection.create(doc, applyResult ? targetInfos.map(t => t.node) : roots)));
    } catch (e) { }
})();
