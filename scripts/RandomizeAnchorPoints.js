// Randomize Anchor Points v9-EN
// Randomly moves anchor points.
//
// NEW in v9: interaction model switched to match "Blur Shadow":
// - The dialog stays OPEN on "Preview" (the main dialog's native OK/Cancel buttons
//   control closing; the dialog content additionally has a small button group
//   "Preview"/"Apply" that selects WHAT should happen when OK is pressed).
//   Advantage: the dialog can be moved aside during preview to inspect the result
//   in the document.
//   - Select "Preview" + OK -> preview is computed/updated, the dialog RE-OPENS
//     with the same values (still adjustable).
//   - Select "Apply" + OK -> the last preview result is kept (no re-rolling),
//     the dialog closes for good.
//   - Native "Cancel" button -> everything is undone, dialog closes.
// - Presets now live in the "AffinityScriptPresets" folder on the desktop
//   (created automatically if needed), with a script prefix in the filename
//   (RandomizeAnchorPoints_<Name>.json). Save asks for a name via a dialog box;
//   Load AND Delete both use the native "open file" dialog.
//
// (unchanged from v8: additive combination of Linear/Radial/Direction, Direction
// with its own distance field, percentage of affected points (%), live display,
// seed for reproducible randomness, values relative to object size (%), don't
// move handles, point sub-selection support, unentered groups are not expanded.)

(function () {
    const { app } = require('/application');
    const { Document } = require('/document');
    const { PolyCurve, CurveBuilder } = require('/geometry');
    const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
    const { Dialog, DialogResult, UnitType } = require('/dialog');
    const { SubSelectionType, Selection } = require('/selections');
    const { File, FileSystemApi } = require('/fs');

    const doc = Document.current;
    if (!doc) {
        return;
    }

    function mulberry32(seed) {
        let a = seed >>> 0;
        return function () {
            a |= 0; a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function bestTransform(node) {
        const l2s = node.localToSpreadTransform;
        const d = l2s.data;
        const isId = Math.abs(d[0] - 1) < 0.001 && Math.abs(d[1]) < 0.001 && Math.abs(d[2]) < 0.001 &&
                     Math.abs(d[3]) < 0.001 && Math.abs(d[4] - 1) < 0.001 && Math.abs(d[5]) < 0.001;
        return isId ? node.transform : l2s;
    }

    function getObjectCenterSpread(node) {
        const bb = node.getSpreadBaseBox(false);
        return { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
    }

    function getFocalPointSpread(node) {
        try {
            const fp = node.transformInterface.focalPoint;
            if (fp.isValid) {
                const tf = bestTransform(node);
                return tf.applyToPoint(fp.point);
            }
        } catch (e) { /* ignore, fall back below */ }
        return getObjectCenterSpread(node);
    }

    // Number of anchor points of a node (summed over all curves)
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

    // Number of eligible (selectable) anchor points for a targetInfo object
    function countEligibleAnchors(t) {
        if (t.anchors === null) return countNodeAnchors(t.node);
        let sum = 0;
        for (const s of t.anchors.values()) sum += s.size;
        return sum;
    }

    // Reads the anchor points sub-selected in the Node tool for a selection item.
    // Returns: null = no point sub-selection present (=> whole object),
    //          Map<curveID, Set<anchorIndex>> = concrete sub-selection (may be empty).
    function getSelectedAnchorMap(node, item) {
        let cns;
        try {
            cns = item.getSubSelectionOfType(SubSelectionType.CurveNode);
        } catch (e) {
            return null;
        }
        if (!cns || cns.isEmpty) return null;

        const curveIndexMaps = new Map(); // curveID -> Map(nodeID -> anchorIndex)
        function getCurveMap(curveID) {
            if (curveIndexMaps.has(curveID)) return curveIndexMaps.get(curveID);
            const curve = node.polyCurve.at(curveID);
            const m = new Map();
            const onCurveIds = [];
            for (let i = 0; i < curve.nodeCount; i++) {
                if (curve.getNode(i).type.value === 0) onCurveIds.push(i); // 0 = OnCurve
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
            if (!cMap.has(it.nodeID)) continue; // not a real anchor (a handle) -> skip
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

    // 1) capture selection (incl. point sub-selection) BEFORE opening the dialog
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
        if (node.polyCurve === undefined) continue; // groups / non-curve objects: no longer recursed into
        const anchorMap = getSelectedAnchorMap(node, item);
        if (anchorMap === null) {
            targetInfos.push({ node: node, anchors: null }); // whole object
        } else if (anchorMap.size > 0) {
            targetInfos.push({ node: node, anchors: anchorMap }); // sub-selection
        }
        // else: sub-selection present but empty (e.g. only handles selected) -> skip
    }

    if (targetInfos.length === 0) {
        app.alert('No usable anchor points found.\nEither select objects without a point selection (whole object), or mark individual anchor points in the Node tool.', 'Randomize Anchor Points');
        return;
    }

    // 2) convert non-mutable shape nodes to curves up front
    const needConversion = targetInfos.filter(t => !(t.node.curvesInterface && t.node.curvesInterface.isMutable));
    let conversionSteps = 0;
    if (needConversion.length > 0) {
        const posBefore0 = doc.history.position;
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
            doc.executeCommand(DocumentCommand.createConvertToCurves(info.target.node.selfSelection));
            const curveListAfter = buildCurveList();
            const fresh = curveListAfter[info.seqIdx];
            if (fresh) info.target.node = fresh;
        }
        conversionSteps = doc.history.position - posBefore0;
    }

    targetInfos = targetInfos.filter(t => t.node.curvesInterface && t.node.curvesInterface.isMutable);

    if (targetInfos.length === 0) {
        app.alert('The objects could not be converted to editable curves.', 'Randomize Anchor Points');
        if (conversionSteps > 0) {
            for (let i = 0; i < conversionSteps; i++) {
                if (doc.canUndo) doc.executeCommand(DocumentCommand.createUndo());
            }
        }
        return;
    }

    // 3) compute centers + object diagonals once from the original geometry
    //    (stays stable across previews)
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

    // For the live display: total number of eligible points, split into
    // "manually exactly selected" (unaffected by the percentage) and
    // "whole object" (affected by the percentage).
    const totalEligibleAnchors = targetInfos.reduce((acc, t) => acc + countEligibleAnchors(t), 0);
    const wholeObjectAnchorCount = targetInfos.filter(t => t.anchors === null).reduce((acc, t) => acc + countNodeAnchors(t.node), 0);
    const manualAnchorCount = totalEligibleAnchors - wholeObjectAnchorCount;

    // 4) core function: build a new, jittered PolyCurve for one node.
    //    Linear/Radial/Direction are combined ADDITIVELY.
    function buildJitteredCurve(node, params, center, anchorRestriction, rng, keepHandles, percent) {
        const tf = bestTransform(node);
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

    function applyJitter(centerModeIdx, params, relative, keepHandles, seed, percent) {
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
        doc.executeCommand(builder.createCommand());
    }

    function readRadioIndex(rg) {
        const raw = (rg.selectedIndex !== undefined && rg.selectedIndex !== null) ? rg.selectedIndex : rg.value;
        const n = Number(raw);
        return isNaN(n) ? 0 : n;
    }
    function setRadioIndex(rg, idx) {
        try { rg.selectedIndex = idx; } catch (e) { /* ignore */ }
        try { rg.value = idx; } catch (e) { /* ignore */ }
    }

    // ─── Presets: "AffinityScriptPresets" folder on the desktop (created
    //     automatically if needed), script prefix in the filename ────────
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
            const f = new File(presetPath(name), 'w');
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
            txt += '\nAt ' + percent + '% approx. ' + estimated + ' affected (' + manualAnchorCount + ' of which are exactly selected, unaffected by the percentage)';
        }
        return txt;
    }

    // ─── Preview state: unlike Blur Shadow (which creates new nodes), this
    //     script mutates existing curves -> preview is undone via undoing
    //     the associated CompoundCommand step, not via deleting nodes. ────
    const posBeforePreview = doc.history.position;
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

        const jxLabel = 'Jitter X Min' + (lastRelative ? ' (%)' : '');
        const gJXMin = col1.addGroup(jxLabel);
        const edJXMin = gJXMin.addUnitValueEditor(jxLabel, lastRelative ? UnitType.Percentage : UnitType.Pixel, lastRelative ? UnitType.Percentage : UnitType.Pixel, null, -100000, 100000);
        edJXMin.value = lastJX[0];

        const jxMaxLabel = 'Jitter X Max' + (lastRelative ? ' (%)' : '');
        const gJXMax = col1.addGroup(jxMaxLabel);
        const edJXMax = gJXMax.addUnitValueEditor(jxMaxLabel, lastRelative ? UnitType.Percentage : UnitType.Pixel, lastRelative ? UnitType.Percentage : UnitType.Pixel, null, -100000, 100000);
        edJXMax.value = lastJX[1];

        const jyLabel = 'Jitter Y Min' + (lastRelative ? ' (%)' : '');
        const gJYMin = col1.addGroup(jyLabel);
        const edJYMin = gJYMin.addUnitValueEditor(jyLabel, lastRelative ? UnitType.Percentage : UnitType.Pixel, lastRelative ? UnitType.Percentage : UnitType.Pixel, null, -100000, 100000);
        edJYMin.value = lastJY[0];

        const jyMaxLabel = 'Jitter Y Max' + (lastRelative ? ' (%)' : '');
        const gJYMax = col1.addGroup(jyMaxLabel);
        const edJYMax = gJYMax.addUnitValueEditor(jyMaxLabel, lastRelative ? UnitType.Percentage : UnitType.Pixel, lastRelative ? UnitType.Percentage : UnitType.Pixel, null, -100000, 100000);
        edJYMax.value = lastJY[1];

        const col2 = dlg.addColumn();

        const gAngle = col2.addGroup('Angle (Direction)');
        const edAngle = gAngle.addUnitValueEditor('Angle (Direction)', UnitType.Degree, UnitType.Degree, null, -100000, 100000);
        edAngle.value = lastAngle;

        const dLabel = 'Distance Min (Direction)' + (lastRelative ? ' (%)' : '');
        const gDMin = col2.addGroup(dLabel);
        const edDMin = gDMin.addUnitValueEditor(dLabel, lastRelative ? UnitType.Percentage : UnitType.Pixel, lastRelative ? UnitType.Percentage : UnitType.Pixel, null, -100000, 100000);
        edDMin.value = lastD[0];

        const dMaxLabel = 'Distance Max (Direction)' + (lastRelative ? ' (%)' : '');
        const gDMax = col2.addGroup(dMaxLabel);
        const edDMax = gDMax.addUnitValueEditor(dMaxLabel, lastRelative ? UnitType.Percentage : UnitType.Pixel, lastRelative ? UnitType.Percentage : UnitType.Pixel, null, -100000, 100000);
        edDMax.value = lastD[1];

        const rLabel = 'Radial Min' + (lastRelative ? ' (%)' : '');
        const gRMin = col2.addGroup(rLabel);
        const edRMin = gRMin.addUnitValueEditor(rLabel, lastRelative ? UnitType.Percentage : UnitType.Pixel, lastRelative ? UnitType.Percentage : UnitType.Pixel, null, -100000, 100000);
        edRMin.value = lastR[0];

        const rMaxLabel = 'Radial Max' + (lastRelative ? ' (%)' : '');
        const gRMax = col2.addGroup(rMaxLabel);
        const edRMax = gRMax.addUnitValueEditor(rMaxLabel, lastRelative ? UnitType.Percentage : UnitType.Pixel, lastRelative ? UnitType.Percentage : UnitType.Pixel, null, -100000, 100000);
        edRMax.value = lastR[1];

        const col3 = dlg.addColumn();

        const gCenter = col3.addGroup('Center (Radial only)');
        const rgCenter = gCenter.addRadioGroup('', ['Selection Center', 'Object Center', 'Focal Point']);
        setRadioIndex(rgCenter, lastCenterMode);

        const gSeed = col3.addGroup('Seed (Random)');
        const edSeed = gSeed.addUnitValueEditor('Seed (Random)', UnitType.Number, UnitType.Number, null, 0, 999999999);
        edSeed.value = lastSeed;

        const gPercent = col3.addGroup('Percentage of Affected Points (%)');
        const edPercent = gPercent.addUnitValueEditor('Percentage of Affected Points (%)', UnitType.Percentage, UnitType.Percentage, null, 0, 100);
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
        const cbKeepHandles = gKeepHandles.addCheckBox('Don\'t move handles (distort curve)', lastKeepHandles);
        cbKeepHandles.value = lastKeepHandles;

        // ─── Presets: Save / Load / Delete, fire immediately, dialog stays
        //     open (like Blur Shadow) ─────────────────────────────────────
        const gPreset = col4.addGroup('Presets');
        const presetSaveBtn = gPreset.addButton('Save preset...');
        const presetLoadBtn = gPreset.addButton('Load preset...');
        const presetDeleteBtn = gPreset.addButton('Delete preset...');

        presetSaveBtn.setOnClickHandler(() => {
            const name = app.prompt('Enter a preset name:', 'Randomize Anchor Points - Save Preset', '');
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
                app.alert('Preset "' + name.trim() + '" saved to:\n' + PRESETS_DIR, 'Randomize Anchor Points');
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
        });

        presetDeleteBtn.setOnClickHandler(() => {
            const path = app.chooseFile();
            if (!path) return;
            if (deletePresetAtPath(path)) {
                app.alert('Preset file deleted:\n' + path, 'Randomize Anchor Points');
            }
        });

        // ─── Action: 2-item button group selects what should happen when the
        //     main dialog's NATIVE OK button is pressed. Does NOT close the
        //     dialog itself. ────────────────────────────────────────────────
        const gAction = col4.addGroup('Action (confirm with OK)');
        const actionBtns = gAction.addButtonSet('', ['Preview', 'Apply'], 0);

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
            // Native "Cancel" (or window closed): undo everything
            break;
        }

        const action = actionBtns.selectedIndex; // 0 = Preview, 1 = Apply

        const params = {
            jitterXMin: Math.min(lastJX[0], lastJX[1]),
            jitterXMax: Math.max(lastJX[0], lastJX[1]),
            jitterYMin: Math.min(lastJY[0], lastJY[1]),
            jitterYMax: Math.max(lastJY[0], lastJY[1]),
            radialMin: Math.min(lastR[0], lastR[1]),
            radialMax: Math.max(lastR[0], lastR[1]),
            directionMin: Math.min(lastD[0], lastD[1]),
            directionMax: Math.max(lastD[0], lastD[1]),
            angleDeg: lastAngle
        };

        let seedToUse = lastSeed;
        if (lastUsedSeed !== null && seedToUse === lastUsedSeed) {
            seedToUse = seedToUse + 1;
        }
        lastUsedSeed = seedToUse;
        lastSeed = seedToUse;

        if (action === 1) { // Apply
            if (!hasPreview) {
                applyJitter(lastCenterMode, params, lastRelative, lastKeepHandles, seedToUse, lastPercent);
            }
            applyResult = true;
            break;
        }

        // action === 0 (Preview): undo the previous preview first, then re-roll
        if (hasPreview) {
            doc.executeCommand(DocumentCommand.createUndo());
        }
        applyJitter(lastCenterMode, params, lastRelative, lastKeepHandles, seedToUse, lastPercent);
        hasPreview = true;
        // re-open the dialog (loop continues)
    }

    if (!applyResult) {
        const stepsToUndo = (doc.history.position - posBeforePreview) + conversionSteps;
        for (let i = 0; i < stepsToUndo; i++) {
            if (doc.canUndo) doc.executeCommand(DocumentCommand.createUndo());
        }
    }

    // best-effort: reselect the objects that were worked on
    try {
        doc.executeCommand(DocumentCommand.createSetSelection(Selection.create(doc, applyResult ? targetInfos.map(t => t.node) : roots)));
    } catch (e) { /* not critical */ }
})();
