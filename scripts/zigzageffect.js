'use strict';

const { Document } = require('/document');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
const { CurveBuilder, PolyCurve } = require('/geometry');
const { Dialog } = require('/dialog');
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

// ── Shape → PolyCurve conversion ─────────────────────────────

function ensureCurveNodes(raw) {
    const poly = raw.filter(n => n.isPolyCurveNode);
    const shapes = raw.filter(n => !n.isPolyCurveNode);

    for (const s of shapes) {
        doc.executeCommand(
            DocumentCommand.createConvertToCurves(Selection.create(doc, s))
        );
    }

    const converted = shapes.length
        ? doc.selection.nodes.toArray().filter(n => n.isPolyCurveNode)
        : [];

    return [...poly, ...converted];
}

// ── Arc-length parameterization ─────────────────────────────

function evalBez(b, t) {
    const u = 1 - t;
    return {
        x:
            u * u * u * b.start.x +
            3 * u * u * t * b.c1.x +
            3 * u * t * t * b.c2.x +
            t * t * t * b.end.x,
        y:
            u * u * u * b.start.y +
            3 * u * u * t * b.c1.y +
            3 * u * t * t * b.c2.y +
            t * t * t * b.end.y
    };
}

function tanNorm(b, t) {
    const u = 1 - t;

    const dx =
        3 *
        (u * u * (b.c1.x - b.start.x) +
            2 * u * t * (b.c2.x - b.c1.x) +
            t * t * (b.end.x - b.c2.x));

    const dy =
        3 *
        (u * u * (b.c1.y - b.start.y) +
            2 * u * t * (b.c2.y - b.c1.y) +
            t * t * (b.end.y - b.c2.y));

    const len = Math.hypot(dx, dy) || 1e-9;

    return {
        tx: dx / len,
        ty: dy / len,
        nx: -dy / len,
        ny: dx / len
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

// ── Core zig-zag algorithm ─────────────────────────────

function applyZZ(nodes, amp, ridges, smooth) {
    const cmds = [];

    for (const n of nodes) {
        const out = PolyCurve.create();

        for (const curve of n.polyCurve) {
            const beziers = [...curve.beziers];
            if (!beziers.length) continue;

            const tbl = buildArcTable(beziers);
            const totalLen = tbl[tbl.length - 1].cum;

            const peaks = ridges * 2;
            const step = totalLen / peaks;
            const closed = curve.isClosed;

            const pts = [];

            if (closed) {
                for (let i = 0; i < peaks; i++) {
                    const { p, g } = sampleAt(tbl, beziers, i * step);
                    const sign = i % 2 === 0 ? 1 : -1;

                    pts.push({
                        x: p.x + g.nx * amp * sign,
                        y: p.y + g.ny * amp * sign,
                        tx: g.tx,
                        ty: g.ty
                    });
                }
            } else {
                for (let i = 0; i <= peaks; i++) {
                    const { p, g } = sampleAt(
                        tbl,
                        beziers,
                        Math.min(i * step, totalLen)
                    );

                    const sign =
                        i === 0 || i === peaks
                            ? 0
                            : i % 2 === 1
                            ? 1
                            : -1;

                    pts.push({
                        x: p.x + g.nx * amp * sign,
                        y: p.y + g.ny * amp * sign,
                        tx: g.tx,
                        ty: g.ty
                    });
                }
            }

            const builder = CurveBuilder.create();
            builder.beginXY(pts[0].x, pts[0].y);

            const count = closed ? peaks : pts.length - 1;

            if (smooth) {
                for (let i = 0; i < count; i++) {
                    const p0 = pts[i];
                    const p1 = pts[(i + 1) % pts.length];

                    const h =
                        Math.hypot(p1.x - p0.x, p1.y - p0.y) / 3;

                    builder.addBezierXY(
                        p0.x + p0.tx * h,
                        p0.y + p0.ty * h,
                        p1.x - p1.tx * h,
                        p1.y - p1.ty * h,
                        p1.x,
                        p1.y
                    );
                }
            } else {
                for (let i = 1; i <= count; i++) {
                    const pt = pts[i % pts.length];
                    builder.lineToXY(pt.x, pt.y);
                }
            }

            if (closed) builder.close();

            out.addCurve(builder.createCurve());
        }

        cmds.push(
            DocumentCommand.createSetCurves(n.curvesInterface, out)
        );
    }

    const cb = CompoundCommandBuilder.create();
    for (const c of cmds) cb.addCommand(c);

    doc.executeCommand(cb.createCommand());
}

// ── Prepare nodes ─────────────────────────────

const nodes = ensureCurveNodes(rawNodes);

// ── Dialog ─────────────────────────────

const dlg = Dialog.create('Zig Zag Effect');
const col = dlg.addColumn();
const grp = col.addGroup('Parameters');

const ampEd = grp.addUnitValueEditor('Amplitude (px)', 'px', 'px', 10, 1, 500);
ampEd.precision = 0;

const frqEd = grp.addUnitValueEditor('Ridges', 'px', 'px', 8, 1, 100);
frqEd.precision = 0;

const smCk = grp.addCheckBox('Smooth wave mode', false);

const btns = grp.addButtonSet('', ['Apply', 'Cancel'], 0);

// Default preview
applyZZ(nodes, 10, 8, false);

// Show dialog
const r = dlg.show();

const amp = Math.max(1, Math.round(ampEd.value));
const ridges = Math.max(1, Math.round(frqEd.value));
const smooth = smCk.value;

const btnIdx = btns.selectedIndex;

if (r.value === 0 || btnIdx === 1) {
    doc.executeCommand(DocumentCommand.createUndo());
} else {
    doc.executeCommand(DocumentCommand.createUndo());
    applyZZ(nodes, amp, ridges, smooth);
}