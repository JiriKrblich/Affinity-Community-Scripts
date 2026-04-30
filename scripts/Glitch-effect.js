/**
name: Glitch Effect
version: 1.0.0
description: Create a glitch effect on a vector object.
author: Nic Kraneis
*/

// Google Gemini was used in creation of this script.


'use strict';

const { Document } = require('/document');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
const { CurveBuilder, PolyCurve } = require('/geometry');
const { Dialog, DialogResult } = require('/dialog');
const { Selection } = require('/selections');

function showError(msg) {
    try {
        const d = Dialog.create("Script Error");
        d.initialWidth = 450;
        const col = d.addColumn();
        const txt = col.addGroup("Diagnostics").addStaticText("", msg);
        txt.isFullWidth = true;
        d.runModal();
    } catch (e) {}
}

function main() {
    const doc = Document.current;

    if (!doc) {
        showError('Please open a document first.');
        return;
    }

    const rawNodes = doc.selection.nodes.toArray().filter(
        n => n.isPolyCurveNode || n.isShapeNode || (n.isVectorNode && n.polyCurve)
    );

    if (!rawNodes.length) {
        showError('Please select one or more vector curves or shapes.');
        return;
    }

    function ensureCurveNodes(raw) {
        const poly = raw.filter(n => n.isPolyCurveNode);
        const shapes = raw.filter(n => !n.isPolyCurveNode);

        for (const s of shapes) {
            doc.executeCommand(DocumentCommand.createConvertToCurves(Selection.create(doc, s)));
        }
        const converted = shapes.length ? doc.selection.nodes.toArray().filter(n => n.isPolyCurveNode) : [];
        return [...poly, ...converted];
    }

    function evalBez(b, t) {
        const u = 1 - t;
        return {
            x: u * u * u * b.start.x + 3 * u * u * t * b.c1.x + 3 * u * t * t * b.c2.x + t * t * t * b.end.x,
            y: u * u * u * b.start.y + 3 * u * u * t * b.c1.y + 3 * u * t * t * b.c2.y + t * t * t * b.end.y
        };
    }

    function buildArcTable(beziers) {
        const tbl = [];
        let cum = 0;
        for (let bi = 0; bi < beziers.length; bi++) {
            const b = beziers[bi];
            let prev = evalBez(b, 0);
            if (bi === 0) tbl.push({ bi, t: 0, cum: 0 });
            for (let s = 1; s <= 300; s++) {
                const t = s / 300;
                const pt = evalBez(b, t);
                cum += Math.hypot(pt.x - prev.x, pt.y - prev.y);
                tbl.push({ bi, t, cum });
                prev = pt;
            }
        }
        return tbl;
    }

    function sampleAt(tbl, beziers, c) {
        let lo = 0; let hi = tbl.length - 1;
        while (lo < hi - 1) {
            const mid = (lo + hi) >> 1;
            if (tbl[mid].cum <= c) lo = mid; else hi = mid;
        }
        const a = tbl[lo], b = tbl[hi];
        const span = b.cum - a.cum;
        const f = span < 1e-9 ? 0 : (c - a.cum) / span;
        const bi = f < 0.5 ? a.bi : b.bi;
        const t = a.t + (b.t - a.t) * f;
        return evalBez(beziers[bi], t);
    }

    function createPRNG(seed) {
        let value = seed;
        return function() {
            value = (value * 9301 + 49297) % 233280;
            return value / 233280;
        };
    }

    function applyGlitch(nodes, config) {
        const cmdsList = [];
        const prng = createPRNG(config.seed);

        const angleRad = config.angle * (Math.PI / 180);
        const shiftXDir = Math.cos(angleRad);
        const shiftYDir = Math.sin(angleRad);
        const sliceXDir = -Math.sin(angleRad);
        const sliceYDir = Math.cos(angleRad);

        for (const n of nodes) {
            const outBase = PolyCurve.create();

            for (const curve of n.polyCurve) {
                const beziers = [...curve.beziers];
                if (!beziers.length) continue;

                const tbl = buildArcTable(beziers);
                const totalLen = tbl[tbl.length - 1].cum;

                const segments = Math.min(4000, Math.max(50, Math.floor(totalLen / 1.5)));
                const step = totalLen / segments;
                const closed = curve.isClosed;

                const basePts = [];
                const count = closed ? segments - 1 : segments;

                let minProj = Infinity, maxProj = -Infinity;
                for (let i = 0; i <= count; i++) {
                    const pt = sampleAt(tbl, beziers, Math.min(i * step, totalLen));
                    basePts.push(pt);

                    let proj = pt.x * sliceXDir + pt.y * sliceYDir;
                    if (proj < minProj) minProj = proj;
                    if (proj > maxProj) maxProj = proj;
                }

                const projRange = Math.max(1, maxProj - minProj);
                const numSlices = Math.max(1, config.slices);
                const sliceHeight = projRange / numSlices;
                const sliceMap = [];

                for (let i = 0; i < numSlices; i++) {
                    const isGlitched = prng() < (config.chaos / 100);
                    let blockShift = 0;

                    if (isGlitched) {
                        blockShift = (prng() * 2 - 1) * config.intensity;
                        if (config.jitter > 0) {
                            blockShift += (prng() * 2 - 1) * config.jitter;
                        }
                    }
                    sliceMap.push({ shiftBase: blockShift });
                }

                const finalPtsBase = [];

                for (let i = 0; i < basePts.length; i++) {
                    let pt = basePts[i];
                    let proj = pt.x * sliceXDir + pt.y * sliceYDir;
                    let sliceIdx = Math.floor((proj - minProj) / sliceHeight);

                    if (sliceIdx < 0) sliceIdx = 0;
                    if (sliceIdx >= numSlices) sliceIdx = numSlices - 1;

                    let totalShiftBase = sliceMap[sliceIdx].shiftBase;

                    finalPtsBase.push({
                        x: pt.x + totalShiftBase * shiftXDir,
                        y: pt.y + totalShiftBase * shiftYDir
                    });
                }

                const builder = CurveBuilder.create();
                builder.beginXY(finalPtsBase[0].x, finalPtsBase[0].y);
                const loopCount = closed ? finalPtsBase.length : finalPtsBase.length - 1;
                for (let i = 1; i <= loopCount; i++) {
                    const p = finalPtsBase[i % finalPtsBase.length];
                    builder.lineToXY(p.x, p.y);
                }
                if (closed) builder.close();
                outBase.addCurve(builder.createCurve());
            }
            cmdsList.push(DocumentCommand.createSetCurves(n.curvesInterface, outBase));
        }

        const cb = CompoundCommandBuilder.create();
        for (const c of cmdsList) cb.addCommand(c);
        doc.executeCommand(cb.createCommand());
    }

    const nodes = ensureCurveNodes(rawNodes);

    const dlg = Dialog.create('True Vector Glitch');
    dlg.initialWidth = 380;
    const col = dlg.addColumn();

    const paramGrp = col.addGroup('Distortion Map');
    const sliceEd = paramGrp.addUnitValueEditor('Slices (Block Density)', '', '', 25, 5, 200);
    sliceEd.precision = 0;
    const chaosEd = paramGrp.addUnitValueEditor('Chaos (Glitch Probability %)', '%', '%', 35, 0, 100);
    chaosEd.precision = 0;
    const dirEd = paramGrp.addUnitValueEditor('Direction Angle (°)', '°', '°', 0, -360, 360);
    dirEd.precision = 1;

    const dmgGrp = col.addGroup('Damage Settings');
    const intEd = dmgGrp.addUnitValueEditor('Block Shift (px)', 'px', 'px', 40, 0, 1000);
    intEd.precision = 0;
    const jitEd = dmgGrp.addUnitValueEditor('Signal Jitter (px)', 'px', 'px', 5, 0, 100);
    jitEd.precision = 1;

    const seedEd = paramGrp.addUnitValueEditor('Seed (Random ID)', '', '', 1337, 1, 99999);
    seedEd.precision = 0;

    const actGrp = col.addGroup('Action');
    const statusTxt = actGrp.addStaticText('', 'Preview ready');
    statusTxt.isFullWidth = true;

    const btns = actGrp.addButtonSet('', ['↺ Preview', '✓ Apply'], 0);
    btns.isFullWidth = true;

    let previewActive = false;

    function getConfig() {
        return {
            slices: Math.max(1, Math.round(sliceEd.value)),
            chaos: Math.max(0, Math.min(100, chaosEd.value)),
            angle: dirEd.value,
            intensity: intEd.value,
            jitter: jitEd.value,
            seed: Math.max(1, Math.round(seedEd.value))
        };
    }

    try {
        applyGlitch(nodes, getConfig());
        previewActive = true;
        statusTxt.text = 'Preview active';
    } catch(e) {}

    let running = true;
    while (running) {
        btns.selectedIndex = 0;
        const result = dlg.runModal();
        const action = btns.selectedIndex;

        if (result.value !== DialogResult.Ok.value) {
            if (previewActive) doc.executeCommand(DocumentCommand.createUndo());
            running = false;
        } else if (action === 1) {
            if (previewActive) doc.executeCommand(DocumentCommand.createUndo());
            applyGlitch(nodes, getConfig());
            running = false;
        } else {
            if (previewActive) doc.executeCommand(DocumentCommand.createUndo());
            try {
                applyGlitch(nodes, getConfig());
                previewActive = true;
                statusTxt.text = 'Preview active - Seed: ' + Math.round(seedEd.value);
            } catch(e) {
                statusTxt.text = 'Error: ' + e.message;
                previewActive = false;
            }
        }
    }
}

try {
    main();
} catch (error) {
    showError("A critical error occurred.");
}
´´´
