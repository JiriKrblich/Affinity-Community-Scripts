/**
name: Roughen Paths
version: 1.0.0
description: Rough up vector paths with controls over amplitute, frequency, noise etc.
author: Nic Kraneis
*/

'use strict';

const { Document } = require('/document');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
const { CurveBuilder, PolyCurve } = require('/geometry');
const { Dialog, DialogResult } = require('/dialog');
const { Selection } = require('/selections');

const doc = Document.current;

if (!doc) {
    alert('Open a document first.');
    return;
}

const rawNodes = doc.selection.nodes.toArray().filter(
    n => n.isPolyCurveNode || n.isShapeNode || (n.isVectorNode && n.polyCurve)
);

if (!rawNodes.length) {
    alert('Select one or more vector curves or shapes first.');
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

function tanNorm(b, t) {
    const u = 1 - t;
    const dx = 3 * (u * u * (b.c1.x - b.start.x) + 2 * u * t * (b.c2.x - b.c1.x) + t * t * (b.end.x - b.c2.x));
    const dy = 3 * (u * u * (b.c1.y - b.start.y) + 2 * u * t * (b.c2.y - b.c1.y) + t * t * (b.end.y - b.c2.y));
    const len = Math.hypot(dx, dy) || 1e-9;
    return { tx: dx / len, ty: dy / len, nx: -dy / len, ny: dx / len };
}

function buildArcTable(beziers) {
    const tbl = [];
    const anchorLengths = [0];
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
        anchorLengths.push(cum);
    }
    return { tbl, anchorLengths };
}

function sampleAt(tbl, beziers, c) {
    let lo = 0;
    let hi = tbl.length - 1;

    while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (tbl[mid].cum <= c) lo = mid;
        else hi = mid;
    }

    const a = tbl[lo];
    const b = tbl[hi];
    const span = b.cum - a.cum;
    const f = span < 1e-9 ? 0 : (c - a.cum) / span;
    const bi = f < 0.5 ? a.bi : b.bi;
    const t = a.t + (b.t - a.t) * f;

    return {
        p: evalBez(beziers[bi], t),
        g: tanNorm(beziers[bi], t)
    };
}

function create1DNoise(seed) {
    function hash(n) {
        let f = Math.sin(n * 12.9898 + seed) * 43758.5453;
        return f - Math.floor(f);
    }
    return function(x) {
        const i = Math.floor(x);
        const f = x - i;
        const u = f * f * (3.0 - 2.0 * f);
        const a = hash(i);
        const b = hash(i + 1);
        return a + u * (b - a);
    };
}

function getFractalNoise(noiseFunc, x, octaves) {
    if (octaves <= 1) return noiseFunc(x) * 2 - 1;
    let total = 0, frequency = 1, amplitude = 1, maxValue = 0;

    for (let i = 0; i < octaves; i++) {
        total += (noiseFunc(x * frequency) * 2 - 1) * amplitude;
        maxValue += amplitude;
        amplitude *= 0.5;
        frequency *= 2;
    }
    return total / maxValue;
}

function pseudoRandom(seed, index, octaves) {
    if (octaves <= 1) {
        let f = Math.sin(seed + index * 13.37) * 43758.5453;
        return (f - Math.floor(f)) * 2 - 1;
    }

    let total = 0, amp = 1, freq = 1, max = 0;
    for(let i = 0; i < octaves; i++) {
        let f = Math.sin(seed + (index * freq) * 13.37) * 43758.5453;
        total += ((f - Math.floor(f)) * 2 - 1) * amp;
        max += amp;
        amp *= 0.5;
        freq *= 1.5;
    }
    return total / max;
}

function getCornerAttenuation(currentDist, anchorLengths, safeZoneRadius) {
    let minD = Infinity;
    for (const ad of anchorLengths) {
        const d = Math.abs(currentDist - ad);
        if (d < minD) minD = d;
    }
    if (minD >= safeZoneRadius) return 1;
    const f = minD / safeZoneRadius;
    return f * f * (3 - 2 * f);
}

function applyRoughen(nodes, config) {
    const cmds = [];
    const randFact = config.randomness / 100;
    const noiseGen = create1DNoise(config.seed);

    const dirRad = config.angle * (Math.PI / 180);
    const dirNx = Math.cos(dirRad);
    const dirNy = Math.sin(dirRad);

    for (const n of nodes) {
        const out = PolyCurve.create();

        // Pass 1: Find the maximum length among all sub-curves to establish baseline density
        let maxSubLen = 0;
        const subcurvesData = [];

        for (const curve of n.polyCurve) {
            const beziers = [...curve.beziers];
            if (!beziers.length) continue;

            const { tbl, anchorLengths } = buildArcTable(beziers);
            const subLen = tbl[tbl.length - 1].cum;
            if (subLen > maxSubLen) maxSubLen = subLen;

            subcurvesData.push({ curve, beziers, tbl, anchorLengths, subLen });
        }

        if (maxSubLen === 0) continue;

        // Establish uniform density based on the LONGEST path
        const baseTargetPeaks = config.ridges * 2;
        const globalStep = maxSubLen / baseTargetPeaks;

        // Establish uniform amplitude globally based on the longest path
        const actualAmp = config.isRelativeAmp
            ? maxSubLen * (config.amp / 100)
            : config.amp;

        // Pass 2: Apply displacement proportionally
        for (const data of subcurvesData) {
            const { curve, beziers, tbl, anchorLengths, subLen } = data;
            const closed = curve.isClosed;

            // Distribute peaks proportionally using the global step
            let peaks = Math.max(2, Math.round(subLen / globalStep));

            // Force an even number of peaks for closed curves to prevent seams
            if (closed && peaks % 2 !== 0) {
                peaks += 1;
            }

            const step = subLen / peaks;
            const safeZoneRadius = step * 1.5;

            const pts = [];
            const count = closed ? peaks - 1 : peaks;

            for (let i = 0; i <= count; i++) {
                const currentDist = Math.min(i * step, subLen);
                const { p, g } = sampleAt(tbl, beziers, currentDist);

                let finalDisp = 0;
                const isEndpoint = !closed && (i === 0 || i === peaks);

                if (!isEndpoint) {
                    const sign = i % 2 === 0 ? 1 : -1;
                    const uniformDisp = actualAmp * sign;

                    let randVal;
                    if (config.usePerlin) {
                        randVal = getFractalNoise(noiseGen, i * 0.6, config.octaves);
                    } else {
                        randVal = pseudoRandom(config.seed, i, config.octaves);
                    }

                    const randomDisp = randVal * actualAmp;
                    finalDisp = uniformDisp * (1 - randFact) + randomDisp * randFact;

                    if (config.protectCorners) {
                        finalDisp *= getCornerAttenuation(currentDist, anchorLengths, safeZoneRadius);
                    }
                }

                const dispNx = config.useCustomDir ? dirNx : g.nx;
                const dispNy = config.useCustomDir ? dirNy : g.ny;

                const tx = config.useCustomDir ? -dirNy : g.tx;
                const ty = config.useCustomDir ? dirNx : g.ty;

                pts.push({
                    x: p.x + dispNx * finalDisp,
                    y: p.y + dispNy * finalDisp,
                    tx: tx,
                    ty: ty
                });
            }

            const builder = CurveBuilder.create();
            builder.beginXY(pts[0].x, pts[0].y);

            const loopCount = closed ? pts.length : pts.length - 1;

            if (config.smoothPath) {
                for (let i = 0; i < loopCount; i++) {
                    const p0 = pts[i];
                    const p1 = pts[(i + 1) % pts.length];
                    const h = Math.hypot(p1.x - p0.x, p1.y - p0.y) / 3;

                    builder.addBezierXY(
                        p0.x + p0.tx * h, p0.y + p0.ty * h,
                        p1.x - p1.tx * h, p1.y - p1.ty * h,
                        p1.x, p1.y
                    );
                }
            } else {
                for (let i = 1; i <= loopCount; i++) {
                    const pt = pts[i % pts.length];
                    builder.lineToXY(pt.x, pt.y);
                }
            }

            if (closed) builder.close();
            out.addCurve(builder.createCurve());
        }
        cmds.push(DocumentCommand.createSetCurves(n.curvesInterface, out));
    }

    const cb = CompoundCommandBuilder.create();
    for (const c of cmds) cb.addCommand(c);
    doc.executeCommand(cb.createCommand());
}

const nodes = ensureCurveNodes(rawNodes);

const dlg = Dialog.create('Roughen Edges Pro');
dlg.initialWidth = 420;
const col = dlg.addColumn();

const ampGrp = col.addGroup('Displacement');
const ampEd = ampGrp.addUnitValueEditor('Amplitude', '', '', 10, 0, 1000);
ampEd.precision = 1;
const relAmpCk = ampGrp.addSwitch('Amplitude as % of Path Length', false);
const frqEd = ampGrp.addUnitValueEditor('Frequency (Details)', '', '', 15, 1, 500);
frqEd.precision = 0;

const dirGrp = col.addGroup('Directional Lock');
const dirCk = dirGrp.addSwitch('Use Custom Direction', false);
const dirEd = dirGrp.addUnitValueEditor('Angle (°)', '°', '°', 0, -360, 360);
dirEd.precision = 1;

const noiseGrp = col.addGroup('Organic Variation');
const rndEd = noiseGrp.addUnitValueEditor('Randomness Blend (%)', '%', '%', 80, 0, 100);
rndEd.precision = 0;
const octEd = noiseGrp.addUnitValueEditor('Complexity (Octaves)', '', '', 1, 1, 5);
octEd.precision = 0;
const noiseTypeCk = noiseGrp.addSwitch('Smooth Noise (Perlin)', true);
const seedEd = noiseGrp.addUnitValueEditor('Seed (Variation ID)', '', '', 42, 1, 99999);
seedEd.precision = 0;

const geoGrp = col.addGroup('Geometry Protection');
const protectCk = geoGrp.addSwitch('Protect Original Corners (Anchors)', true);
const smCk = geoGrp.addSwitch('Smooth Output Curves', false);

const actGrp = col.addGroup('Status');
const statusTxt = actGrp.addStaticText('', '• Preview active - ready');
statusTxt.isFullWidth = true;

const btns = actGrp.addButtonSet('', ['↺ Preview', '✓ Apply'], 0);
btns.isFullWidth = true;

let previewActive = false;

function getConfig() {
    return {
        amp: Math.max(0, ampEd.value),
        isRelativeAmp: relAmpCk.value,
        ridges: Math.max(1, Math.round(frqEd.value)),
        useCustomDir: dirCk.value,
        angle: dirEd.value,
        randomness: Math.max(0, Math.min(100, Math.round(rndEd.value))),
        octaves: Math.max(1, Math.round(octEd.value)),
        usePerlin: noiseTypeCk.value,
        seed: Math.max(1, Math.round(seedEd.value)),
        protectCorners: protectCk.value,
        smoothPath: smCk.value
    };
}

try {
    applyRoughen(nodes, getConfig());
    previewActive = true;
} catch (e) {
    statusTxt.text = '✖ Error during initial render: ' + e.message;
}

let running = true;
while (running) {
    btns.selectedIndex = 0;
    const result = dlg.runModal();
    const mode = btns.selectedIndex;

    if (result.value !== DialogResult.Ok.value) {
        if (previewActive) doc.executeCommand(DocumentCommand.createUndo());
        running = false;
    } else if (mode === 1) {
        if (previewActive) doc.executeCommand(DocumentCommand.createUndo());
        try {
            applyRoughen(nodes, getConfig());
            running = false;
        } catch (e) {
            statusTxt.text = '✖ Error: ' + e.message;
        }
    } else {
        if (previewActive) doc.executeCommand(DocumentCommand.createUndo());
        try {
            applyRoughen(nodes, getConfig());
            previewActive = true;
            statusTxt.text = '• Preview updated - Confirm to apply';
        } catch (e) {
            statusTxt.text = '✖ Error: ' + e.message;
            previewActive = false;
        }
    }
}
