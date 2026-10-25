'use strict';
// Bleed Path (3 mm)
// Creates a single outline path offset outwards by BLEED_MM from the selected objects.
// The originals are left untouched. The result is a new, unfilled path with a thin stroke.
//
// How it works: the SDK has no path-offset command, so the offset is built geometrically.
// Each selected object is duplicated and converted to curves, flattened to a polygon, and a
// rectangle (each segment thickened by the bleed distance) is laid along the outline. The
// joins between segments are filled with either a mitre wedge (square corners) or a disc
// (round corners). Unioning the shape with all of these gives the offset outline.

const { Document } = require('/document.js');
const { Transform, Polygon, Curve, CurveBuilder, PolyCurve, Rectangle } = require('/geometry.js');
const { AddChildNodesCommandBuilder } = require('/commands.js');
const { PolyCurveNodeDefinition } = require('/nodes.js');
const { Selection } = require('/selections.js');
const { FillDescriptor } = require('/fills.js');
const { LineStyleDescriptor } = require('/linestyle.js');
const { SVG11 } = require('/colours.js');

// ---- settings -------------------------------------------------------------------------
const BLEED_MM = 3;           // bleed distance in millimetres
const CORNER_STYLE = 'square';// 'square' (mitred corners) or 'round'
const MITRE_LIMIT = 4;        // square style: sharper angles than this are bevelled, not spiked
const TOLERANCE_MM = 0.05;    // curve flattening accuracy (smaller = smoother but slower)
const STROKE_PT = 0.5;        // stroke weight of the resulting path, in points
const PATH_NAME = 'Bleed path';
// ---------------------------------------------------------------------------------------

const EPS = 1e-6;

function toSpreadPoints(node, polygon) {
    // The cornered polycurve is in the node's own (base) space; baseToSpreadTransform carries
    // rotation/scale/position (localToSpreadTransform is identity for rotated nodes).
    const xf = node.baseToSpreadTransform;
    const pts = [];
    for (let i = 0; i < polygon.pointCount; i++) {
        const p = xf.applyToPoint(polygon.getPoint(i));
        pts.push({ x: p.x, y: p.y });
    }
    return pts;
}

// remove consecutive duplicate points (and a repeated closing point)
function cleanPoints(pts, closed) {
    const out = [];
    for (const p of pts) {
        const q = out[out.length - 1];
        if (!q || Math.abs(p.x - q.x) > EPS || Math.abs(p.y - q.y) > EPS) out.push(p);
    }
    if (closed && out.length > 1) {
        const a = out[0], b = out[out.length - 1];
        if (Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS) out.pop();
    }
    return out;
}

function unit(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    return { x: dx / len, y: dy / len };
}

function main() {
    const doc = Document.current;
    if (!doc) { console.log('No open document.'); return; }
    const original = doc.selection;
    if (original.nodes.toArray().length === 0) {
        console.log('Select one or more objects first.');
        return;
    }

    const square = CORNER_STYLE !== 'round';
    const pxPerMm = doc.dpi / 25.4;
    const radius = BLEED_MM * pxPerMm;
    const tolerance = TOLERANCE_MM * pxPerMm;

    let steps = 0;                        // commands executed, so a failure can be rolled back
    const run = (fn) => { fn(); steps++; };

    try {
        // 1. Work on duplicates so the originals are never modified.
        run(() => doc.applyTransform(new Transform(), original, { duplicateNodes: true }));
        run(() => doc.convertToCurves(doc.selection));

        // 2. Collect outlines from every duplicate (spread coordinates).
        const dupes = doc.selection.nodes.toArray();
        const rings = [];                 // { pts: [{x,y}], closed: bool }
        const keep = [];                  // duplicates that take part in the union
        const fallbackBoxes = [];         // non-vector nodes (images, etc.) -> use bounding box
        const discard = [];

        for (const node of dupes) {
            let polyCurve = null;
            try { polyCurve = node.curvesInterface.corneredPolyCurve; } catch (e) { polyCurve = null; }

            if (polyCurve && polyCurve.curveCount > 0) {
                keep.push(node);
                for (let i = 0; i < polyCurve.curveCount; i++) {
                    const curve = polyCurve.at(i);
                    if (curve.pointCount < 2) continue;
                    const poly = new Polygon(curve.generatePolygon(tolerance));
                    if (poly.pointCount >= 2) {
                        rings.push({ pts: toSpreadPoints(node, poly), closed: curve.isClosed });
                    }
                }
            } else {
                fallbackBoxes.push(node.getSpreadVisibleBox());
                discard.push(node);
            }
        }

        if (discard.length > 0) run(() => doc.deleteSelection(Selection.create(doc, discard)));
        if (rings.length === 0 && fallbackBoxes.length === 0) {
            throw new Error('Nothing in the selection could be outlined.');
        }
        if (keep.length > 0) run(() => { doc.selection = Selection.create(doc, keep); });

        // 3. Build the offset geometry.
        const noFill = FillDescriptor.createNone();
        const solid = FillDescriptor.createSolid(SVG11.black);
        const hairline = LineStyleDescriptor.createDefault(1);
        const builder = AddChildNodesCommandBuilder.create();
        builder.clearCurrentSelection = keep.length === 0;
        builder.appendCurrentSelection = keep.length > 0;

        const addCurve = (curve) => {
            const pc = PolyCurve.create();
            pc.addCurve(curve);
            builder.addNode(PolyCurveNodeDefinition.create(pc, solid, noFill, hairline, noFill));
        };
        const addPolygon = (points) => {
            const cb = CurveBuilder.create().beginXY(points[0].x, points[0].y);
            for (let i = 1; i < points.length; i++) cb.lineToXY(points[i].x, points[i].y);
            addCurve(cb.close().createCurve());
        };

        // body: the segment thickened by `radius` on each side
        const addBody = (a, b) => {
            const d = unit(a, b);
            const nx = -d.y * radius, ny = d.x * radius;
            addPolygon([
                { x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny },
                { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny }
            ]);
        };
        const addDisc = (p) => {
            addCurve(Curve.createEllipse(new Rectangle(p.x - radius, p.y - radius, radius * 2, radius * 2)));
        };
        // mitre wedge on the outer side of the turn at p (bevel if the angle is too sharp)
        const addMitre = (prev, p, next) => {
            const d1 = unit(prev, p), d2 = unit(p, next);
            const cross = d1.x * d2.y - d1.y * d2.x;
            const dot = d1.x * d2.x + d1.y * d2.y;
            if (Math.abs(cross) < 1e-9) return;            // straight on (or a full reversal)
            const s = cross > 0 ? -1 : 1;                  // outer side of the turn
            const n1 = { x: -d1.y * s * radius, y: d1.x * s * radius };
            const n2 = { x: -d2.y * s * radius, y: d2.x * s * radius };
            const p1 = { x: p.x + n1.x, y: p.y + n1.y };
            const p2 = { x: p.x + n2.x, y: p.y + n2.y };
            const ratio = 1 / Math.sqrt((1 + dot) / 2);    // mitre length / bleed distance
            if (ratio > MITRE_LIMIT) {
                addPolygon([p, p1, p2]);                   // bevel
            } else {
                const k = 1 / (1 + dot);
                addPolygon([p, p1, { x: p.x + (n1.x + n2.x) * k, y: p.y + (n1.y + n2.y) * k }, p2]);
            }
        };

        let segments = 0;
        const addRing = (rawPts, closed) => {
            const pts = cleanPoints(rawPts, closed);
            const n = pts.length;
            if (n < 2) return;
            if (!closed && square) {                       // square end caps on open paths
                const d0 = unit(pts[1], pts[0]), dn = unit(pts[n - 2], pts[n - 1]);
                pts[0] = { x: pts[0].x + d0.x * radius, y: pts[0].y + d0.y * radius };
                pts[n - 1] = { x: pts[n - 1].x + dn.x * radius, y: pts[n - 1].y + dn.y * radius };
            }
            const segCount = closed ? n : n - 1;
            for (let i = 0; i < segCount; i++) { addBody(pts[i], pts[(i + 1) % n]); segments++; }

            const first = closed ? 0 : 1, last = closed ? n - 1 : n - 2;
            for (let i = first; i <= last; i++) {
                const p = pts[i], prev = pts[(i - 1 + n) % n], next = pts[(i + 1) % n];
                if (square) addMitre(prev, p, next); else addDisc(p);
            }
            if (!closed && !square) { addDisc(pts[0]); addDisc(pts[n - 1]); }
        };

        for (const r of rings) addRing(r.pts, r.closed);
        for (const box of fallbackBoxes) {
            addCurve(Curve.createRectangle(new Rectangle(box.x, box.y, box.width, box.height)));
            addRing([
                { x: box.x, y: box.y }, { x: box.x + box.width, y: box.y },
                { x: box.x + box.width, y: box.y + box.height }, { x: box.x, y: box.y + box.height }
            ], true);
        }
        run(() => doc.executeCommand(builder.createCommand(true)));

        // 4. Union everything into a single path.
        const total = doc.selection.nodes.toArray().length;
        if (total > 1) run(() => doc.boolOpUnion(doc.selection));

        // 5. Style it as an unfilled outline and name it.
        const result = doc.selection;
        run(() => doc.setBrushFillDescriptor(FillDescriptor.createNone(), result));
        run(() => doc.setPenFillDescriptor(FillDescriptor.createSolid(SVG11.magenta), doc.selection));
        run(() => doc.setLineWeightPts(STROKE_PT, doc.selection));
        run(() => doc.setLayerDescription(`${PATH_NAME} ${BLEED_MM}mm`, doc.selection));

        console.log(`Bleed path created: ${BLEED_MM} mm, ${CORNER_STYLE} corners, ${segments} segments from ${keep.length + fallbackBoxes.length} object(s).`);
    } catch (err) {
        console.log('Bleed path failed: ' + (err && err.message ? err.message : err));
        for (let i = 0; i < steps; i++) doc.undo();   // roll back anything we did
        try { doc.selection = original; } catch (e) { /* selection may no longer be valid */ }
    }
}

main();
