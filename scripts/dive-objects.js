'use strict';
// =====================================================================
//  Dive Objects V4
//  Makes the topmost N objects of an object row (group/layer or
//  multi-selection) "dive" beneath the bottommost M objects they
//  overlap. Each diving object is placed inside an invisible clip mask
//  (large rectangle minus the outline of the lower objects), so the
//  lower objects become visible there – the row has no visible start.
//  Non-destructive: the original object stays unchanged.
//  Running again removes existing masks first; "Remove diving" undoes
//  everything. Recognises masks of the German version too.
//  V2: resizable dialog; OK keeps an unchanged preview without
//      recalculating.
//  V3: masks correct for transformed rows/layers (curve in spread
//      coordinates); exact strokes: the stroke is separated from the fill
//      as its own band (following the line join) and united with it –
//      outer contours grow, inner holes shrink, inside/centre/outside
//      alignment respected; stroke option off by default.
//  V4: correct stroke width for non-proportionally distorted objects/rows
//      with "scale with object": visible width = effectiveWeight of the
//      full transform (differs per object, e.g. with rotation).
// =====================================================================

const { Document } = require('/document.js');
const { app } = require('/application.js');
const { DocumentCommand, AddChildNodesCommandBuilder, InsertionMode } = require('/commands.js');
const { PolyCurveNodeDefinition } = require('/nodes.js');
const { FillDescriptor } = require('/fills.js');
const { LineStyleDescriptor, StrokeAlignment } = require('/linestyle.js');
const { PolyCurve, Curve, CurveBuilder, Polygon, Transform } = require('/geometry.js');
const { RGBA8 } = require('/colours.js');
const { BlendMode } = require('affinity:common');
const { Selection } = require('/selections.js');
const { Dialog, DialogResult, UnitType } = require('/dialog.js');
const { NodeMoveType, NodeChildType } = require('affinity:dom');

const TITEL = 'Dive Objects V4';
const MASKEN_NAME = 'Dive Mask';
const MASKEN_NAMEN_ALLE = ['Dive Mask', 'Abtauch-Maske'];

const doc = Document.current;

function meldung(text) {
    try { app.alert(text, TITEL); } catch (e) { console.log(text); }
}

// ---------------------------------------------------------------------
//  Helpers: nodes, transforms
// ---------------------------------------------------------------------
function kinder(n) {
    try { return n.children ? n.children.toArray() : []; } catch (e) { return []; }
}
function name(n) {
    try { return n.userDescription || ''; } catch (e) { return ''; }
}
function istMaske(n) {
    const t = name(n);
    return MASKEN_NAMEN_ALLE.some(p => t.indexOf(p) === 0);
}
// local -> spread (own transform + full parent chain)
function spreadTF(n) {
    let m = Transform.multiply(Transform.createIdentity(), n.transform);
    let p = n.parent;
    while (p && !p.isSpreadNode) {
        if (p.transform) m = Transform.multiply(p.transform, m);
        p = p.parent;
    }
    return m;
}
// coordinate space of a node's children -> spread
function kinderRaumTF(parent) {
    if (!parent || parent.isSpreadNode || !parent.transform) return Transform.createIdentity();
    return spreadTF(parent);
}

// ---------------------------------------------------------------------
//  Determine the object row (group/layer or multi-selection)
// ---------------------------------------------------------------------
function ermittleReihe(auswahl) {
    if (auswahl.length === 1 && kinder(auswahl[0]).length >= 2 && !auswahl[0].polyCurve) {
        return { parent: auswahl[0], gruppe: auswahl[0] };
    }
    if (auswahl.length >= 2) {
        const p = auswahl[0].parent;
        for (const n of auswahl) if (!n.parent || !n.parent.isSameNode(p)) return { fehler: 'The selected objects must be in the same group/layer.' };
        return { parent: p, auswahl: auswahl };
    }
    return { fehler: 'Please select a group/layer containing the object row, or several objects of the same layer.' };
}
function reihenObjekte(reihe) {
    if (reihe.gruppe) return kinder(reihe.gruppe);
    const k = kinder(reihe.parent);
    return k.filter(c => reihe.auswahl.some(s => s.isSameNode(c)));
}
// content of a (nested) dive mask
function maskenInhalt(w) {
    let cur = w;
    for (;;) {
        const k = kinder(cur);
        if (k.length === 1 && istMaske(k[0])) { cur = k[0]; continue; }
        return { innen: cur, inhalt: k };
    }
}

// ---------------------------------------------------------------------
//  Geometry
// ---------------------------------------------------------------------
function enumGleich(a, b) {
    return a === b || (a && b && a.value !== undefined && a.value === b.value);
}
// stroke info of a node: { aussen, join, miter, cap } (aussen = width outside the fill edge)
function konturInfo(n) {
    const leer = { aussen: 0 };
    try {
        const ls = n.lineStyleInterface;
        if (!ls || ls.isNoFill || ls.isLineStyleVisible === false) return leer;
        // Visible stroke width: with "scale with object" Affinity converts the width
        // using the FULL transform (own + parent chain) – even with non-proportional
        // distortion the stroke stays even, just thinner/thicker. Verified live:
        // effectiveWeight(spreadTF, identity) equals the visible width of each object.
        let w = ls.lineWeight || 0;
        try {
            const lsd = ls.lineStyleDescriptor;
            if (lsd && lsd.isScale) {
                const we = lsd.effectiveWeight(spreadTF(n), Transform.createIdentity());
                if (we > 0) w = we;
            }
        } catch (e) { /* use lineWeight */ }
        if (w <= 0) return leer;
        const a = ls.strokeAlignment;
        const aussen = enumGleich(a, StrokeAlignment.Inside) ? 0 : enumGleich(a, StrokeAlignment.Outside) ? w : w / 2;
        let miter = 1.5;
        try { miter = ls.lineStyle.miterLimit || miter; } catch (e) { }
        const joinTxt = String(ls.lineJoin || '');
        const capTxt = String(ls.lineCap || '');
        return { aussen, miter, join: /round/i.test(joinTxt) ? 'round' : /bevel/i.test(joinTxt) ? 'bevel' : 'miter',
                 cap: /round/i.test(capTxt) ? 'round' : /square/i.test(capTxt) ? 'square' : 'butt' };
    } catch (e) { return leer; }
}
function boxVon(punkte) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of punkte) { if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y; if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y; }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
function rechteckPoly(r) {
    return [{ x: r.x, y: r.y }, { x: r.x + r.width, y: r.y }, { x: r.x + r.width, y: r.y + r.height }, { x: r.x, y: r.y + r.height }];
}
// curves -> polygons [{pts, closed}] (duplicate points removed)
function kurvenPolygone(pc, tol) {
    const res = [];
    for (const c of pc) {
        try {
            if (c.isEmpty || c.pointCount === 0) continue;
            const pg = new Polygon(c.generatePolygon(tol || 0.25));
            const n = pg.pointCount, pts = [];
            for (let i = 0; i < n; i++) {
                const p = pg.getPoint(i);
                const l = pts[pts.length - 1];
                if (!l || Math.abs(l.x - p.x) > 1e-6 || Math.abs(l.y - p.y) > 1e-6) pts.push({ x: p.x, y: p.y });
            }
            const closed = c.isClosed;
            if (closed && pts.length > 2) {
                const a = pts[0], b = pts[pts.length - 1];
                if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) pts.pop();
            }
            if (pts.length >= 2) res.push({ pts, closed });
        } catch (e) { /* ignore */ }
    }
    return res;
}
function polyZuKurve(pts) {
    const cb = CurveBuilder.create().beginXY(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) cb.lineToXY(pts[i].x, pts[i].y);
    cb.close();
    return cb.createCurve();
}
function form(curves, polyObjs) {
    const polys = polyObjs.map(p => p.pts).filter(p => p.length >= 3);
    return { curves, polys, box: boxVon(polyObjs.map(p => p.pts).flat()) };
}
function kreisPoly(c, r) {
    const n = Math.max(12, Math.min(48, Math.ceil(2 * Math.PI * r / 1.5)));
    const res = [];
    for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n; res.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) }); }
    return res;
}
// "Separate the stroke": stroke band of width 2d along all sub-paths as simple
// convex pieces (edge quads + corner joins following the stroke's line join).
// United with the fill shape this gives exactly the outward-expanded shape
// (outer contours grow, inner holes shrink).
function konturBand(polyObjs, d, info) {
    const st = [];
    for (const po of polyObjs) {
        const P = po.pts, n = P.length, zu = po.closed;
        if (n < 2) continue;
        const kanten = zu ? n : n - 1;
        for (let i = 0; i < kanten; i++) {
            const a = P[i], b = P[(i + 1) % n];
            const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
            if (L < 1e-9) continue;
            const nx = -dy / L * d, ny = dx / L * d;
            st.push([{ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny }, { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny }]);
        }
        const start = zu ? 0 : 1, ende = zu ? n : n - 1;
        for (let i = start; i < ende; i++) {
            const p = P[(i - 1 + n) % n], v = P[i], q = P[(i + 1) % n];
            let e1x = v.x - p.x, e1y = v.y - p.y, e2x = q.x - v.x, e2y = q.y - v.y;
            const l1 = Math.hypot(e1x, e1y), l2 = Math.hypot(e2x, e2y);
            if (l1 < 1e-9 || l2 < 1e-9) continue;
            e1x /= l1; e1y /= l1; e2x /= l2; e2y /= l2;
            const kreuz = e1x * e2y - e1y * e2x, dot = e1x * e2x + e1y * e2y;
            if (Math.abs(kreuz) < 1e-6 && dot > 0) continue;
            if (info.join === 'round') { st.push(kreisPoly(v, d)); continue; }
            const s = kreuz > 0 ? -1 : 1;              // outer side of the corner
            const n1 = { x: -e1y * s * d, y: e1x * s * d }, n2 = { x: -e2y * s * d, y: e2x * s * d };
            const A = { x: v.x + n1.x, y: v.y + n1.y }, B = { x: v.x + n2.x, y: v.y + n2.y };
            if (info.join === 'miter') {
                const theta = Math.acos(Math.max(-1, Math.min(1, -dot)));   // interior angle
                const verh = 1 / Math.max(1e-9, Math.sin(theta / 2));
                if (verh <= info.miter) {
                    let bx = n1.x + n2.x, by = n1.y + n2.y; const bl = Math.hypot(bx, by);
                    if (bl > 1e-9) {
                        bx /= bl; by /= bl;
                        st.push([v, A, { x: v.x + bx * d * verh, y: v.y + by * d * verh }, B]);
                        continue;
                    }
                }
            }
            st.push([v, A, B]);                       // bevel
        }
        if (!zu) {                                    // line ends of open curves
            for (const [e, nb] of [[P[0], P[1]], [P[n - 1], P[n - 2]]]) {
                if (info.cap === 'round') st.push(kreisPoly(e, d));
                else if (info.cap === 'square') {
                    let dx = e.x - nb.x, dy = e.y - nb.y; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
                    const nx = -dy * d, ny = dx * d;
                    st.push([{ x: e.x + nx, y: e.y + ny }, { x: e.x + nx + dx * d, y: e.y + ny + dy * d },
                             { x: e.x - nx + dx * d, y: e.y - ny + dy * d }, { x: e.x - nx, y: e.y - ny }]);
                }
            }
        }
    }
    return st;
}
// unites pieces (spread coordinates) via Affinity Boolean; returns PolyCurve in spread coordinates
function vereinigen(referenz, polyCurves) {
    const fuell = FillDescriptor.createSolid(RGBA8(0, 0, 0, 255), BlendMode.Normal);
    const bld = AddChildNodesCommandBuilder.create();
    bld.setInsertionTarget(referenz);
    bld.setInsertionMode(InsertionMode.Behind);
    for (const pc of polyCurves) {
        bld.addPolyCurveNode(PolyCurveNodeDefinition.create(pc, fuell, FillDescriptor.createNone(),
            LineStyleDescriptor.createDefault(0), FillDescriptor.createNone()));
    }
    const cmd = bld.createCommand(false, NodeChildType.Main);
    doc.executeCommand(cmd);
    const neu = [];
    const nn = cmd.newNodes;
    const anz = nn.length !== undefined ? nn.length : polyCurves.length;
    for (let i = 0; i < anz; i++) if (nn[i]) neu.push(nn[i]);
    doc.executeCommand(DocumentCommand.createBoolOpUnion(Selection.create(doc, neu)));
    const erg = doc.selection.nodes.toArray();
    const res = PolyCurve.create();
    for (const e of erg) {
        try {
            const pc = e.polyCurve.clone(); pc.transform(spreadTF(e));
            for (const c of pc) res.addCurve(c.clone());
        } catch (err) { /* ignore */ }
    }
    doc.executeCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, erg), true));
    return res;
}
// leaf nodes with fill geometry, recursive for groups
function blattKnoten(node) {
    const res = [];
    const sammle = (n) => {
        let pc = null;
        try { pc = n.polyCurve; } catch (e) { pc = null; }
        if (pc && pc.curveCount > 0) { res.push({ n, pc }); return; }
        const k = kinder(n);
        if (k.length) { for (const c of k) sammle(c); return; }
        res.push({ n, pc: null });
    };
    sammle(node);
    return res;
}
// shapes for the overlap test (fill) + outer stroke width
function materialFormen(node) {
    const res = [];
    for (const { n, pc } of blattKnoten(node)) {
        const ki = konturInfo(n);
        if (pc) {
            const spc = pc.clone(); spc.transform(spreadTF(n));
            const po = kurvenPolygone(spc, 0.5);
            if (!po.length) continue;
            const f = form([], po); f.aussen = ki.aussen;
            if (!f.polys.length) f.polys = po.map(p => p.pts);
            res.push(f);
        } else {
            const b = n.getSpreadBaseBox(false);
            if (!b || !(b.width > 0)) continue;
            const f = form([], [{ pts: rechteckPoly(b), closed: true }]); f.aussen = ki.aussen;
            res.push(f);
        }
    }
    return res;
}
// hole shapes of a bottom object: fill ∪ stroke band (if wanted) ∪ additional gap
function lochFormen(node, mitKontur, zugabe) {
    const res = [];
    for (const { n, pc } of blattKnoten(node)) {
        const ki = konturInfo(n);
        const d = (mitKontur ? ki.aussen : 0) + Math.max(0, zugabe);
        if (!pc) {
            const b = n.getSpreadBaseBox(false);
            if (!b || !(b.width > 0)) continue;
            const r = { x: b.x - d, y: b.y - d, width: b.width + 2 * d, height: b.height + 2 * d };
            res.push(form([Curve.createRectangle(r)], [{ pts: rechteckPoly(r), closed: true }]));
            continue;
        }
        const spc = pc.clone(); spc.transform(spreadTF(n));
        const po = kurvenPolygone(spc, 0.25);
        if (!po.length) continue;
        if (d <= 0.01) {
            const curves = []; for (const c of spc) curves.push(c.clone());
            res.push(form(curves, po));
            continue;
        }
        // fill and separated stroke as separate objects -> unite
        const stuecke = konturBand(po, d, ki.aussen > 0 ? ki : { join: 'round', cap: 'round', miter: 1.5 });
        const pcs = [spc.clone()];
        for (const s of stuecke) { const p = PolyCurve.create(); p.addCurve(polyZuKurve(s)); pcs.push(p); }
        const ver = vereinigen(n, pcs);
        const curves = []; for (const c of ver) curves.push(c.clone());
        const vpo = kurvenPolygone(ver, 0.25);
        if (curves.length && vpo.length) res.push(form(curves, vpo));
    }
    return res;
}
function boxenUeberlappen(a, b, rand) {
    const m = rand || 0;
    return a.x - m < b.x + b.w && b.x - m < a.x + a.w && a.y - m < b.y + b.h && b.y - m < a.y + a.h;
}
function punktInPolys(pt, polys) {
    let inside = false;
    for (const poly of polys) {
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const a = poly[i], b = poly[j];
            if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
        }
    }
    return inside;
}
function segSchnitt(p1, p2, p3, p4) {
    const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
    if (Math.abs(d) < 1e-12) return false;
    const u = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
    const v = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
    return u >= 0 && u <= 1 && v >= 0 && v <= 1;
}
function punktSegAbstand(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
function polysNaeher(pa, pb, d) {
    for (const A of pa) for (const p of A) for (const B of pb) for (let j = 0; j < B.length; j++) {
        if (punktSegAbstand(p, B[j], B[(j + 1) % B.length]) <= d) return true;
    }
    return false;
}
// rand: additional distance (e.g. outer stroke of the top object)
function formenSchneiden(fa, fb, rand) {
    const m = rand || 0;
    if (!boxenUeberlappen(fa.box, fb.box, m)) return false;
    for (const pa of fa.polys) if (pa.length && punktInPolys(pa[0], fb.polys)) return true;
    for (const pb of fb.polys) if (pb.length && punktInPolys(pb[0], fa.polys)) return true;
    for (const pa of fa.polys) for (let i = 0; i < pa.length; i++) {
        const a1 = pa[i], a2 = pa[(i + 1) % pa.length];
        const sb = { x: Math.min(a1.x, a2.x), y: Math.min(a1.y, a2.y), w: Math.abs(a2.x - a1.x) + 1e-9, h: Math.abs(a2.y - a1.y) + 1e-9 };
        if (!boxenUeberlappen(sb, fb.box, m)) continue;
        for (const pb of fb.polys) for (let j = 0; j < pb.length; j++) {
            if (segSchnitt(a1, a2, pb[j], pb[(j + 1) % pb.length])) return true;
        }
    }
    if (m > 0) return polysNaeher(fa.polys, fb.polys, m) || polysNaeher(fb.polys, fa.polys, m);
    return false;
}

// ---------------------------------------------------------------------
//  Create / remove masks
// ---------------------------------------------------------------------
// Note: AddChildNodes expects the curve in SPREAD coordinates and applies the
// counter-transform itself when the parent layer is transformed.
function erzeugeClip(davor, loecher, tBox) {
    const rand = Math.max(tBox.w, tBox.h) * 3 + 500;
    const pc = PolyCurve.create();
    pc.addCurve(Curve.createRectangle({ x: tBox.x - rand, y: tBox.y - rand, width: tBox.w + 2 * rand, height: tBox.h + 2 * rand }));
    for (const f of loecher) for (const c of f.curves) pc.addCurve(c.clone());
    const def = PolyCurveNodeDefinition.create(pc, FillDescriptor.createNone(), FillDescriptor.createNone(),
        LineStyleDescriptor.createDefault(0), FillDescriptor.createNone());
    const bld = AddChildNodesCommandBuilder.create();
    bld.setInsertionTarget(davor);
    bld.setInsertionMode(InsertionMode.Behind);
    bld.addPolyCurveNode(def);
    const cmd = bld.createCommand(false, NodeChildType.Main);
    doc.executeCommand(cmd);
    const clip = cmd.newNodes[0];
    doc.executeCommand(DocumentCommand.createMoveNodes(davor.selfSelection, clip, NodeMoveType.Inside, NodeChildType.Main));
    return clip;
}
function setzeName(node, text) {
    try { doc.executeCommand(DocumentCommand.createSetDescription(node.selfSelection, text)); }
    catch (e) { try { node.userDescription = text; } catch (e2) { } }
}
// removes all dive masks in the row, returns count
function masken_aufheben(reihe) {
    let anzahl = 0;
    const liste = reihe.gruppe ? kinder(reihe.gruppe) : reihenObjekte(reihe);
    for (const w of liste) {
        if (!istMaske(w)) continue;
        const { inhalt } = maskenInhalt(w);
        for (const c of inhalt) {
            doc.executeCommand(DocumentCommand.createMoveNodes(c.selfSelection, w, NodeMoveType.Before, NodeChildType.Main));
            if (reihe.auswahl) reihe.auswahl.push(c);
        }
        if (reihe.auswahl) reihe.auswahl = reihe.auswahl.filter(s => !s.isSameNode(w));
        doc.executeCommand(DocumentCommand.createDeleteSelection(w.selfSelection, true));
        anzahl++;
    }
    return anzahl;
}

function abtauchen(reihe, p) {
    masken_aufheben(reihe);
    const obj = reihenObjekte(reihe);
    const anz = obj.length;
    const nOben = Math.max(0, Math.min(p.oben, anz - 1));
    const nUnten = Math.max(0, Math.min(p.unten, anz - nOben));
    if (nOben < 1 || nUnten < 1) return { masken: 0, objekte: 0 };
    const untere = obj.slice(0, nUnten);
    const obere = obj.slice(anz - nOben);
    // capture top shapes BEFORE creating helper objects
    const obereFormen = obere.map(t => ({ t, formen: materialFormen(t) }));
    // hole shapes of the bottom objects (in stacking order)
    const loecherAlle = [];
    for (const b of untere) for (const f of lochFormen(b, p.mitKontur, p.zugabe)) loecherAlle.push(f);
    let maskenZahl = 0, objektZahl = 0;
    for (const { t, formen } of obereFormen) {
        if (!formen.length) continue;
        const tb = t.getSpreadBaseBox(false);
        const tBox = { x: tb.x, y: tb.y, w: tb.width, h: tb.height };
        const treffer = loecherAlle.filter(h => formen.some(tf => formenSchneiden(tf, h, tf.aussen)));
        if (!treffer.length) continue;
        // distribute mutually overlapping holes onto separate nesting levels
        const ebenen = [];
        for (const h of treffer) {
            let ziel = null;
            for (const e of ebenen) { if (!e.some(o => formenSchneiden(o, h, 0))) { ziel = e; break; } }
            if (ziel) ziel.push(h); else ebenen.push([h]);
        }
        const tName = name(t) || t.defaultDescription || 'Object';
        let aktuell = t;
        for (let i = 0; i < ebenen.length; i++) {
            aktuell = erzeugeClip(aktuell, ebenen[i], tBox);
            setzeName(aktuell, MASKEN_NAME + (i === ebenen.length - 1 ? ' – ' + tName : ''));
            maskenZahl++;
        }
        objektZahl++;
    }
    return { masken: maskenZahl, objekte: objektZahl };
}

function auswahlWiederherstellen(nodes) {
    try {
        const lebend = nodes.filter(n => { try { return !!n.parent; } catch (e) { return false; } });
        if (lebend.length) doc.selection = Selection.create(doc, lebend);
    } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------
//  Main program with dialog
// ---------------------------------------------------------------------
function main() {
    if (!doc) { meldung('No document open.'); return; }
    const startAuswahl = doc.selection.nodes.toArray();
    if (!startAuswahl.length) { meldung('Please select a group/layer containing the object row, or several objects.'); return; }
    const reiheStart = ermittleReihe(startAuswahl);
    if (reiheStart.fehler) { meldung(reiheStart.fehler); return; }

    const vorher = reihenObjekte(reiheStart);
    let hatMasken = vorher.some(istMaske);
    const anzahl = vorher.length;
    if (anzahl < 2) { meldung('The row contains fewer than 2 objects.'); return; }
    const vorschlag = Math.max(1, Math.min(anzahl - 1, Math.round(anzahl / 12) || 1));

    const startPos = doc.history.position;
    const neueReihe = () => {
        // always rebuild references after a reset
        if (reiheStart.gruppe) return { parent: reiheStart.gruppe, gruppe: reiheStart.gruppe };
        return { parent: reiheStart.parent, auswahl: startAuswahl.slice() };
    };
    const zuruecksetzen = () => { if (doc.history.position !== startPos) doc.history.position = startPos; };

    const dlg = Dialog.create(TITEL);
    dlg.initialWidth = 460;
    dlg.isResizable = true;
    const col = dlg.addColumn();

    const gObj = col.addGroup('Object row');
    gObj.addStaticText('', anzahl + ' objects in the row (bottom = start, top = end)' + (hatMasken ? '\nExisting dive masks will be removed first.' : ''));
    const edOben = gObj.addUnitValueEditor('Diving top objects', UnitType.Number, UnitType.Number, vorschlag, 1, anzahl - 1);
    edOben.value = vorschlag; edOben.precision = 0;
    const edUnten = gObj.addUnitValueEditor('Bottom objects (dive beneath)', UnitType.Number, UnitType.Number, vorschlag, 1, anzahl - 1);
    edUnten.value = vorschlag; edUnten.precision = 0;

    const gMaske = col.addGroup('Mask');
    const cbKontur = gMaske.addCheckBox('Include stroke of bottom objects', false);
    cbKontur.value = true;
    const edZugabe = gMaske.addUnitValueEditor('Additional gap', UnitType.Pixel, UnitType.Pixel, 0, 0, 200);
    edZugabe.value = 0; edZugabe.precision = 1;

    const gAktion = col.addGroup('Action');
    const rbAktion = gAktion.addRadioGroup('', ['Apply diving', 'Remove diving'], 0);
    rbAktion.selectedIndex = 0;
    const btVorschau = gAktion.addButton('Preview');
    const stStatus = gAktion.addStaticText('', 'Preview: –');

    const params = () => ({
        oben: Math.round(edOben.value),
        unten: Math.round(edUnten.value),
        mitKontur: cbKontur.value,
        zugabe: edZugabe.value
    });
    // remember the last preview result (kept on OK if settings unchanged)
    let vorschau = null;   // { schluessel, pos, ergebnis }
    const schluessel = () => JSON.stringify([params(), rbAktion.selectedIndex]);
    const ausfuehren = () => {
        zuruecksetzen();
        const r = neueReihe();
        if (rbAktion.selectedIndex === 1) {
            const n = masken_aufheben(r);
            return { text: n + ' dive masks removed', r };
        }
        const e = abtauchen(r, params());
        return { text: e.objekte + ' objects dived, ' + e.masken + ' masks', r };
    };

    btVorschau.setOnClickHandler(() => {
        try {
            vorschau = null;
            const k = schluessel();
            const e = ausfuehren();
            vorschau = { schluessel: k, pos: doc.history.position, ergebnis: e };
            stStatus.text = 'Preview: ' + e.text;
        }
        catch (err) { vorschau = null; stStatus.text = 'Error: ' + err.message; zuruecksetzen(); }
    });

    const ergebnis = dlg.runModal();
    if (ergebnis.value !== DialogResult.Ok.value && ergebnis !== DialogResult.Ok) {
        zuruecksetzen();
        auswahlWiederherstellen(startAuswahl);
        return;
    }
    try {
        // keep an unchanged preview directly (no recalculation)
        const uebernehmen = vorschau && vorschau.schluessel === schluessel() && doc.history.position === vorschau.pos;
        const e = uebernehmen ? vorschau.ergebnis : ausfuehren();
        if (reiheStart.gruppe) auswahlWiederherstellen([reiheStart.gruppe]);
        else auswahlWiederherstellen(reihenObjekte(e.r));
        console.log(TITEL + ': ' + e.text);
    } catch (err) {
        zuruecksetzen();
        meldung('Error: ' + err.message);
    }
}

main();