// Optical Kerning
// Automatically kerns the selected text by the shapes of the letters – also for fonts
// with no kerning or with badly set sidebearings (LSB/RSB).
//
// Usage: select one or more text objects (or highlight part of a text) and run the script.
//
// How it works:
//  - the target spacing is derived from the font's SHAPES (counter and stem of H / n),
//    never from its sidebearings, so badly spaced fonts get fixed too
//  - for every pair the optical area of white space between the outlines is measured
//    (with limited depth into open shapes); diacritics and dots are left out
//  - overhangs (the bar of T over lowercase) count partially
//  - 2D collision check including diacritics
//  - parameters calibrated on hand-spaced professional fonts
//    (Helvetica, Avenir, Futura, Gill Sans, ABC Areal)
//  - the result replaces manual pair kerning; running it again gives the same result
//  - live preview in the document while you adjust the settings (one undo step on OK,
//    nothing changes on Cancel)

const { Document } = require('/document');
const { AddChildNodesCommandBuilder, CompoundCommandBuilder, DocumentCommand } = require('/commands');
const { Selection, TextSelection } = require('/selections');
const { StoryRange } = require('affinity:story');
const { StoryBuilder } = require('/storybuilder');
const { ArtTextNodeDefinition } = require('/nodes');
const { StoryDelta, GlyphAttDoubleType } = require('/storydelta');
const { Dialog, DialogResult } = require('/dialog');
const { UnitType } = require('affinity:common');

const OK = {};
OK.defaults = {
    strength: 1.0,      // how much of the correction is applied (0..1)
    tightness: 1.0,     // overall spacing (<1 tighter, >1 looser)
    depth: 0.08,        // em – how deep into open shapes white space is counted (calibrated)
    overhang: 0.3,      // how much overhangs count (bar of T over lowercase) (calibrated)
    maxAdjust: 0.25,    // em – maximum kerning of a single pair
    collision: 0.06,    // em – minimum 2D distance between outlines incl. diacritics
    scanlines: 60,
    includePunctuation: false,
};

// ---------- geometry ----------
OK.flatten = function (pc, steps) {
    const edges = [];
    for (const curve of pc.curves) {
        let prev = null;
        for (const bz of curve.beziers) {
            const s = bz.start, c1 = bz.c1, c2 = bz.c2, e = bz.end;
            const straight = (c1.x === s.x && c1.y === s.y && c2.x === e.x && c2.y === e.y);
            const n = straight ? 1 : steps;
            if (!prev) prev = [s.x, s.y];
            for (let k = 1; k <= n; k++) {
                const t = k / n, u = 1 - t;
                const x = u*u*u*s.x + 3*u*u*t*c1.x + 3*u*t*t*c2.x + t*t*t*e.x;
                const y = u*u*u*s.y + 3*u*u*t*c1.y + 3*u*t*t*c2.y + t*t*t*e.y;
                if (y !== prev[1]) edges.push(prev[0], prev[1], x, y);
                prev = [x, y];
            }
        }
    }
    return new Float64Array(edges);
};

OK.crossings = function (edges, y) {
    const xs = [];
    for (let i = 0; i < edges.length; i += 4) {
        const y0 = edges[i+1], y1 = edges[i+3];
        if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) xs.push(edges[i] + (y - y0) * (edges[i+2] - edges[i]) / (y1 - y0));
    }
    return xs.sort((a, b) => a - b);
};

OK.median = (a) => { const s = a.slice().sort((p, q) => p - q); return s[s.length >> 1]; };
OK.hasOutline = (ch) => { if (!ch || /\s/.test(ch)) return false; const c = ch.charCodeAt(0); return !((c >= 0x200B && c <= 0x200D) || c === 0xFEFF); };
OK.isLineBreak = (ch) => { const c = ch.charCodeAt(0); return c === 10 || c === 13 || c === 0x2028 || c === 0x2029; };
OK.isMeasurable = (ch, cfg) => cfg.includePunctuation ? OK.hasOutline(ch) : /[\p{L}\p{N}]/u.test(ch);
OK.base = (ch) => ch.normalize('NFD')[0];
OK.isTallClass = (ch) => /\p{Lu}|\p{N}/u.test(OK.base(ch));

OK.glyph = function (pc, ch, em) {
    const bb = pc.getExactBoundingBox();
    return { ch, em, edges: OK.flatten(pc, 10), x: bb.x, top: bb.y, bottom: bb.y + bb.height };
};

// vertical range used for optical measurement (diacritics, dots and descenders cut off)
OK.zoneOf = function (g, m) {
    const b = OK.base(g.ch);
    let limTop;
    if (/\p{Lu}|\p{N}/u.test(b)) limTop = m.baseline - m.capH * 1.04;
    else if (/[bdfhklt]/.test(b) || !/\p{Ll}/u.test(b)) limTop = m.baseline - m.capH * 1.12;
    else limTop = m.baseline - m.xH * 1.04;
    return [Math.max(g.top, limTop), Math.min(g.bottom, m.baseline + g.em * 0.03)];
};

// ---------- shape-based reference: counter + stem of H and n ----------
OK.reference = function (doc, atts, cache) {
    const key = atts.font.postscriptName + '@' + atts.height;
    if (cache[key]) return cache[key];
    const a = atts.clone();
    a.manualKerning = 0;
    a.characterSpacing = 0;
    const sb = StoryBuilder.create();
    sb.setToArtisticTextDefaultStyle(doc.dpi, doc.format);
    sb.setGlyphAtts(a);
    sb.addText('Hn');
    const b = AddChildNodesCommandBuilder.create();
    b.setInsertionTarget(doc.currentSpread);
    b.addNode(ArtTextNodeDefinition.createFromStoryBuilder({ x: -100000, y: -100000 }, sb));
    const cmd = b.createCommand();
    doc.executeCommand(cmd);
    let tmp = null;
    for (const nd of cmd.newNodes) { tmp = nd; break; }
    const ppc = tmp.curvesInterface.polyPolyCurves;
    const pcH = ppc.getTransformedPolyCurve(0), pcn = ppc.getTransformedPolyCurve(1);
    const H = OK.flatten(pcH, 10), Hbb = pcH.getExactBoundingBox();
    const n = OK.flatten(pcn, 10), nbb = pcn.getExactBoundingBox();
    doc.undo();
    const em = a.height, bl = -100000;
    const capH = bl - Hbb.y, xH = bl - nbb.y;
    const measure = (edges, h) => {
        const cs = [], ss = [];
        for (let f = 0.15; f <= 0.851; f += 0.05) {
            const xs = OK.crossings(edges, bl - h * f);
            if (xs.length >= 4) cs.push(xs[2] - xs[1]);
            if (f <= 0.6 && xs.length >= 2) ss.push(xs[1] - xs[0]);
        }
        return { counter: cs.length ? OK.median(cs) : NaN, stem: ss.length ? OK.median(ss) : NaN };
    };
    const mH = measure(H, capH), mn = measure(n, xH);
    // fitted on hand-spaced professional fonts
    let TH = 0.40 * mH.counter + 0.28 * mH.stem;
    let Tn = 0.50 * mn.counter + 0.21 * mn.stem;
    if (!(TH > 0)) TH = 0.17 * em;
    if (!(Tn > 0)) Tn = 0.14 * em;
    return cache[key] = { capH: capH > 0 ? capH : 0.7 * em, xH: xH > 0 ? xH : 0.5 * em, TH, Tn };
};

// ---------- pair measurement ----------
// whitespace between L and R over [y0, y1]; rows where a glyph has no ink use its extreme
OK.areaOver = function (L, R, zl, zr, y0, y1, n, d) {
    const rs = [], ls = [];
    let lMax = -Infinity, rMin = Infinity;
    for (let j = 0; j < n; j++) {
        const y = y0 + (j + 0.5) * (y1 - y0) / n;
        const a = (y >= zl[0] && y <= zl[1]) ? OK.crossings(L.edges, y) : [];
        const b = (y >= zr[0] && y <= zr[1]) ? OK.crossings(R.edges, y) : [];
        const ra = a.length ? a[a.length - 1] : NaN, lb = b.length ? b[0] : NaN;
        rs.push(ra); ls.push(lb);
        if (ra > lMax) lMax = ra;
        if (lb < rMin) rMin = lb;
    }
    if (lMax === -Infinity || rMin === Infinity) return null;
    let minG = Infinity;
    for (let j = 0; j < n; j++) {
        if (isNaN(rs[j])) rs[j] = lMax;
        if (isNaN(ls[j])) ls[j] = rMin;
        minG = Math.min(minG, ls[j] - rs[j]);
    }
    // average of two depth models: from the pair's closest point, and from each glyph's own extreme
    let s1 = 0, s2 = 0;
    for (let j = 0; j < n; j++) {
        s1 += Math.min(ls[j] - rs[j], minG + d);
        s2 += Math.min(ls[j], rMin + d) - Math.max(rs[j], lMax - d);
    }
    return (s1 + s2) / 2 / n;
};

OK.measure = function (L, R, m, cfg) {
    const em = L.em, n = cfg.scanlines, d = cfg.depth * em;
    const zl = OK.zoneOf(L, m), zr = OK.zoneOf(R, m);
    const bottom = Math.min(zl[1], zr[1]);
    const inter = Math.max(zl[0], zr[0]), union = Math.min(zl[0], zr[0]);
    if (bottom - inter < em * 0.05) return null;
    const aInter = OK.areaOver(L, R, zl, zr, inter, bottom, n, d);
    if (aInter === null) return null;
    let area = aInter;
    if (inter - union > em * 0.02) {
        const aUnion = OK.areaOver(L, R, zl, zr, union, bottom, n, d);
        if (aUnion !== null) area = aInter + cfg.overhang * (aUnion - aInter);
    }
    // 2D collision: smallest horizontal shift keeping `collision` em between the outlines
    const minDist = cfg.collision * em;
    const f0 = Math.min(L.top, R.top), f1 = Math.max(L.bottom, R.bottom);
    const steps = Math.max(40, Math.round((f1 - f0) / em * 200));
    const dy = (f1 - f0) / steps;
    const rsF = [], lsF = [];
    for (let j = 0; j <= steps; j++) {
        const y = f0 + dy * j;
        const a = OK.crossings(L.edges, y), b = OK.crossings(R.edges, y);
        rsF.push(a.length ? a[a.length - 1] : -Infinity);
        lsF.push(b.length ? b[0] : Infinity);
    }
    const win = Math.ceil(minDist / dy);
    let minShift = -Infinity;
    for (let j = 0; j <= steps; j++) {
        if (rsF[j] === -Infinity) continue;
        for (let k = Math.max(0, j - win); k <= Math.min(steps, j + win); k++) {
            if (lsF[k] === Infinity) continue;
            const vy = (k - j) * dy;
            const need = Math.sqrt(Math.max(0, minDist * minDist - vy * vy));
            minShift = Math.max(minShift, need - (lsF[k] - rsF[j]));
        }
    }
    return { area, minShift };
};

// ---------- analysis of one text node ----------
// Measures every adjacent glyph pair once (independent of dialog settings).
// `limit` optionally restricts to a StoryRange.
OK.measureNode = function (doc, node, cfg, cache, limit) {
    const si = node.storyInterface, story = si.story, range = si.storyRange;
    const text = story.getText(range.begin, range.end - range.begin);
    const ppc = node.curvesInterface.polyPolyCurves;
    const E = [];
    let oi = 0;
    for (let p = range.begin, k = 0; p < range.end && k < text.length; p++, k++) {
        const ch = text[k];
        E.push({ pos: p, ch, oi: OK.hasOutline(ch) ? oi++ : -1 });
    }
    if (oi < ppc.polyCurveCount) return { node, text, error: 'character and outline count mismatch (ligatures?)', pairs: [], kerned: [] };
    if (oi > ppc.polyCurveCount) {
        // overflowing text frame: the hidden tail has no outlines
        for (const e of E) if (e.oi >= ppc.polyCurveCount) e.oi = -1;
    }
    const kerned = [];
    for (const e of E) {
        const at = story.getGlyphAtts(e.pos);
        e.kern = at.manualKerning;
        if (e.kern !== 0 && (!limit || (e.pos >= limit.begin && e.pos < limit.end))) kerned.push({ pos: e.pos, oldKern: e.kern });
        if (e.oi < 0) continue;
        e.at = at; e.em = at.height; e.track = at.characterSpacing;
        e.style = at.font.postscriptName + '@' + at.height;
        e.g = OK.glyph(ppc.getTransformedPolyCurve(e.oi), e.ch, e.em);
    }
    // split into lines, estimate baseline per line
    const lines = [];
    let cur = [];
    for (const e of E) {
        if (!e.g) { if (OK.isLineBreak(e.ch) && cur.length) { lines.push(cur); cur = []; } continue; }
        const last = cur[cur.length - 1];
        if (last && e.g.x < last.g.x - 0.01) { lines.push(cur); cur = []; }
        cur.push(e);
    }
    if (cur.length) lines.push(cur);
    for (const ln of lines) {
        const f = ln.filter(e => /[A-Zabcdefhiklmnorstuvwxz0-9]/.test(e.ch)).map(e => e.g.bottom);
        const bl = OK.median(f.length ? f : ln.map(e => e.g.bottom));
        for (const e of ln) e.bl = bl;
    }
    const pairs = [];
    const all = Object.assign({}, cfg, { includePunctuation: true });
    for (let i = 0; i + 1 < E.length; i++) {
        const A = E[i], B = E[i + 1];
        if (!A.g || !B.g || A.bl !== B.bl || A.style !== B.style) continue;
        if (limit && (A.pos < limit.begin || B.pos >= limit.end)) continue;
        if (!OK.isMeasurable(A.ch, all) || !OK.isMeasurable(B.ch, all)) continue;
        const em = A.em;
        // measured relative to zero manual kerning; identical pairs are measured once
        const pkey = A.style + '|' + A.track + '|' + A.ch + B.ch;
        let base = cache.pairs[pkey];
        if (base === undefined) {
            const R = OK.reference(doc, A.at, cache.refs);
            const r = OK.measure(A.g, B.g, { baseline: A.bl, capH: R.capH, xH: R.xH }, cfg);
            if (r) {
                const tA = OK.isTallClass(A.ch), tB = OK.isTallClass(B.ch);
                const T = tA && tB ? R.TH : !tA && !tB ? R.Tn : (R.TH + R.Tn) / 2;
                base = { T, area: r.area - A.kern * em, minShift: r.minShift + A.kern * em };
            } else base = null;
            cache.pairs[pkey] = base;
        }
        if (!base) continue;
        pairs.push({ pos: A.pos, pair: A.ch + B.ch, oldKern: A.kern, em, track: A.track, base, letters: /[\p{L}\p{N}]/u.test(A.ch) && /[\p{L}\p{N}]/u.test(B.ch) });
    }
    return { node, text, pairs, kerned };
};

// kerning values for the given settings
OK.propose = function (measured, cfg) {
    const items = [];
    for (const p of measured.pairs) {
        if (!p.letters && !cfg.includePunctuation) continue;
        const b = p.base;
        let kU = (b.T * cfg.tightness + p.track * p.em - b.area) * cfg.strength;
        if (kU < 0 && kU < b.minShift) kU = Math.min(0, b.minShift);
        const k = Math.max(-cfg.maxAdjust, Math.min(cfg.maxAdjust, kU / p.em));
        items.push({ pos: p.pos, pair: p.pair, oldKern: p.oldKern, newKern: Math.round(k * 1000) / 1000 });
    }
    return items;
};

OK.addKernCommands = function (doc, builder, node, items) {
    let changed = 0;
    for (const p of items) {
        if (Math.abs(p.newKern - p.oldKern) < 0.0005) continue;
        const sel = Selection.create(doc, node);
        sel.addSubSelectionForNode(node, TextSelection.create([new StoryRange(p.pos, p.pos + 1)]));
        builder.addCommand(DocumentCommand.createFormatText(sel, StoryDelta.createGlyphDouble(GlyphAttDoubleType.ManualKerning, p.newKern)));
        changed++;
    }
    return changed;
};

// ---------- targets from selection ----------
OK.collectTargets = function (doc) {
    const targets = [];
    const walk = (node, limit) => {
        if (node.storyInterface && node.curvesInterface) {
            targets.push({ node, limit });
            return;
        }
        try { for (const c of node.children) walk(c, null); } catch (e) { /* leaf */ }
    };
    const sel = doc.selection;
    for (let i = 0; i < sel.length; i++) {
        const item = sel.at(i);
        let limit = null;
        try {
            for (let s = 0; s < item.subSelectionCount; s++) {
                const sub = item.getSubSelection(s);
                if (sub && sub.ranges) {
                    const rs = [...sub.ranges].filter(r => r.end > r.begin + 1);
                    if (rs.length) limit = { begin: Math.min(...rs.map(r => r.begin)), end: Math.max(...rs.map(r => r.end)) };
                }
            }
        } catch (e) { /* no text sub-selection */ }
        walk(item.node, limit);
    }
    return targets;
};

// ---------- session: settings -> document, with replaceable preview ----------
OK.createSession = function (doc, measured) {
    const s = { applied: null, lastKey: null, stats: null };

    const plan = (settings) => measured.map(m => ({
        node: m.node,
        items: settings.mode === 1 ? m.kerned.map(k => ({ pos: k.pos, oldKern: k.oldKern, newKern: 0 })) : OK.propose(m, settings.cfg),
    }));

    const statsOf = (work) => {
        const ks = [];
        let changed = 0;
        for (const w of work) for (const it of w.items) {
            if (Math.abs(it.newKern - it.oldKern) >= 0.0005) changed++;
            ks.push(Math.round(it.newKern * 1000));
        }
        const nz = ks.filter(k => k !== 0);
        return { pairs: ks.length, changed, min: nz.length ? Math.min(...nz) : 0, max: nz.length ? Math.max(...nz) : 0,
                 avg: nz.length ? Math.round(nz.reduce((a, b) => a + b, 0) / nz.length) : 0 };
    };

    // removes the current preview; undo when it is still on top of the stack, explicit restore otherwise
    s.revert = function () {
        if (!s.applied) return;
        const a = s.applied;
        s.applied = null;
        if (doc.canUndo && doc.undoDescription === a.description) {
            doc.undo();
            const probe = a.probe;
            if (!probe || Math.abs(probe.node.storyInterface.story.getGlyphAtts(probe.pos).manualKerning - probe.oldKern) < 0.0005) return;
        }
        const builder = CompoundCommandBuilder.create();
        let n = 0;
        for (const w of a.work) n += OK.addKernCommands(doc, builder, w.node, w.items.map(it => ({ pos: it.pos, oldKern: it.newKern, newKern: it.oldKern })));
        if (n) doc.executeCommand(builder.createCommand());
    };

    // shows the given settings in the document (or only computes stats when preview is off)
    s.update = function (settings, showInDocument) {
        const key = JSON.stringify(settings) + showInDocument;
        if (key === s.lastKey) return s.stats;
        s.revert();
        const work = plan(settings);
        s.stats = statsOf(work);
        if (showInDocument) {
            const builder = CompoundCommandBuilder.create();
            let n = 0;
            let probe = null;
            for (const w of work) {
                n += OK.addKernCommands(doc, builder, w.node, w.items);
                if (!probe) {
                    const it = w.items.find(i => Math.abs(i.newKern - i.oldKern) >= 0.0005);
                    if (it) probe = { node: w.node, pos: it.pos, oldKern: it.oldKern };
                }
            }
            if (n) {
                doc.executeCommand(builder.createCommand());
                s.applied = { work, probe, description: doc.undoDescription };
            }
        }
        s.lastKey = key;
        return s.stats;
    };
    return s;
};

// ---------- dialog ----------
OK.PRESETS = [90, 100, 112];   // Tight / Normal / Loose

OK.buildDialog = function (targets) {
    const dlg = Dialog.create('Optical Kerning');
    dlg.initialWidth = 360;
    const col = dlg.addColumn();

    const gMode = col.addGroup('');
    const mode = gMode.addButtonSet('', ['Optical kerning', 'Remove kerning'], 0);
    mode.isFullWidth = true;

    const gSpacing = col.addGroup('Spacing');
    const preset = gSpacing.addButtonSet('', ['Tight', 'Normal', 'Loose'], 1);
    preset.isFullWidth = true;
    const spacing = gSpacing.addUnitValueEditor('Spacing', UnitType.Percentage, UnitType.Percentage, 100, 60, 150);
    spacing.showPopupSlider = true;
    spacing.precision = 0;
    spacing.isFullWidth = true;
    const strength = gSpacing.addUnitValueEditor('Strength', UnitType.Percentage, UnitType.Percentage, 100, 0, 100);
    strength.showPopupSlider = true;
    strength.precision = 0;
    strength.isFullWidth = true;

    const gOptions = col.addGroup('Options');
    gOptions.enableSeparator = true;
    const punct = gOptions.addSwitch('Kern punctuation', false);
    const preview = gOptions.addSwitch('Live preview', true);

    const gInfo = col.addGroup('');
    gInfo.enableSeparator = true;
    const scope = targets.length === 1 ? (targets[0].limit ? 'Highlighted text' : '1 text object') : targets.length + ' text objects';
    const info = gInfo.addStaticText(scope, '');

    return { dlg, mode, preset, spacing, strength, punct, preview, info };
};

OK.readSettings = function (ui) {
    return {
        mode: ui.mode.selectedIndex,
        cfg: Object.assign({}, OK.defaults, {
            strength: Math.max(0, Math.min(1, ui.strength.value / 100)),
            tightness: Math.max(0.3, ui.spacing.value / 100),
            includePunctuation: ui.punct.value,
        }),
    };
};

OK.formatStats = function (settings, st) {
    const sign = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v);
    if (settings.mode === 1) return st.changed ? `Removes manual kerning from ${st.changed} ${st.changed === 1 ? 'character' : 'characters'}` : 'No manual kerning to remove';
    if (!st.pairs) return 'No letter pairs to kern';
    return `${st.pairs} pairs  ·  ${sign(st.min)} to ${sign(st.max)} ‰  ·  average ${sign(st.avg)} ‰`;
};

// ---------- main ----------
function main() {
    const doc = Document.current;
    if (!doc) { console.log('No document is open.'); return; }
    const targets = OK.collectTargets(doc);
    if (!targets.length) {
        const dlg = Dialog.create('Optical Kerning');
        dlg.addColumn().addGroup('').addStaticText('', 'Select a text object (or highlight part of a text) and run the script again.');
        try { dlg.runModal(); } catch (e) { /* closed */ }
        return;
    }

    // measure everything up front so the dialog only has to do cheap math
    const cache = { refs: {}, pairs: {} };
    const measured = targets.map(t => OK.measureNode(doc, t.node, OK.defaults, cache, t.limit));
    const errors = measured.filter(m => m.error).map(m => '"' + m.text.slice(0, 20) + '": ' + m.error);
    const session = OK.createSession(doc, measured);
    const ui = OK.buildDialog(targets);

    let updating = false;
    const refresh = () => {
        if (updating) return;
        updating = true;
        try {
            const settings = OK.readSettings(ui);
            const optical = settings.mode === 0;
            ui.preset.isEnabled = optical;
            ui.spacing.isEnabled = optical;
            ui.strength.isEnabled = optical;
            ui.punct.isEnabled = optical;
            const st = session.update(settings, ui.preview.value);
            ui.info.text = OK.formatStats(settings, st);
        } finally {
            updating = false;
        }
    };
    ui.preset.onValueChangedHandler = () => {
        if (updating) return;
        updating = true;
        try { ui.spacing.value = OK.PRESETS[ui.preset.selectedIndex]; } finally { updating = false; }
        refresh();
    };
    for (const c of [ui.mode, ui.spacing, ui.strength, ui.punct, ui.preview]) c.onValueChangedHandler = refresh;
    refresh();

    let ok = false;
    try { ok = ui.dlg.runModal().value === DialogResult.Ok.value; } catch (e) { ok = false; }

    if (ok) {
        // make sure the final settings are in the document even if preview was off
        session.update(OK.readSettings(ui), true);
        console.log('Optical kerning: ' + OK.formatStats(OK.readSettings(ui), session.stats) + (errors.length ? '. Skipped: ' + errors.join('; ') : ''));
    } else {
        session.revert();
    }
}

if (!globalThis.OK_NO_MAIN) main();
