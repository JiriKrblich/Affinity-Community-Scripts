'use strict';
/**
 * name: Find & Replace Color
 * description: Illustrator-style find & replace colour. Finds a colour in
 *              fills, strokes, text (per character run) and gradient stops,
 *              with a tolerance (ΔE), in the selection, the current spread or
 *              the whole document. Selects the matches or replaces them in a
 *              single undoable step. Batch mode applies several
 *              "colour → colour" pairs at once (swaps are safe).
 * version: 1.3.1
 * author: Victor Crespo (3dvic.com · github.com/vicc3d)
 * license: MIT
 *
 * Victor Crespo -- 3dvic.com -- github.com/vicc3d/affinity-find-replace-color
 *
 * UI language: set LANG to 'en' or 'es'. `node build.js` generates one
 * ready-to-use script per language in dist/.
 */

const { app } = require('/application.js');
const { Document } = require('/document.js');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands.js');
const { Selection, TextSelection } = require('/selections.js');
const { Colour, Gradient } = require('/colours.js');
const { StoryRange } = require('/story.js');
const { StoryDelta } = require('/storydelta.js');
const { Dialog, DialogResult, UnitType } = require('/dialog.js');

const LANG = 'en';
const MAX_DOC_COLOURS = 40;
const MAX_ROWS = 10;

// ---------------------------------------------------------------------------
// UI strings
// ---------------------------------------------------------------------------

const STRINGS = {
    en: {
        title: 'Find & Replace Color',
        noDocument: 'No document is open.',

        modeLabel: 'Mode',
        modes: ['Single color', 'Batch'],

        findGroup: 'Find',
        findColour: 'Color',
        fromDocument: 'From document',
        docColoursHeader: '— Document colors —',
        docColoursHelp: 'Solid colors and gradient stops found in the whole document, most used first.',

        batchGroup: 'Color pairs',
        batchHelp: 'Only rows whose replacement color you changed are applied. ' +
            'If a color matches several rows, the first one wins. A→B and B→A swap correctly.',
        rowFind: n => n + '. Find',
        removeRowHelp: 'Remove this row',
        keepOneRow: 'At least one row must remain',
        addRow: '+ Add row',
        loadColours: 'Load document colors',
        loadColoursHelp: 'Fills the rows with the most used colors. Each replacement starts equal to the original: change only the ones you want.',
        maxRows: n => 'Maximum ' + n + ' rows',
        noSolidColours: 'The document has no solid colors',
        loaded: (n, total) => 'Loaded ' + n + ' of ' + total + ' colors. Change the replacement (→) of the ones you want.',

        tolerance: 'Tolerance (ΔE)',
        toleranceHelp: '0 = exact color (RGB and CMYK). 1–2 = imperceptible differences. 5–10 = very similar shades. In CMYK, each ink may differ by at most this same %.',

        whereGroup: 'Where',
        scope: 'Scope',
        scopes: ['Selection', 'Current spread', 'Whole document'],
        fill: 'Fill',
        stroke: 'Stroke',
        text: 'Text',
        gradients: 'Gradients',
        includeHidden: 'Include hidden and locked',

        actionGroup: 'Action',
        actionLabel: 'Action',
        actions: ['Select', 'Replace'],
        replaceWith: 'Replace with',
        keepAlpha: 'Keep original opacity',
        countMatches: 'Count matches',

        needEditedRow: 'Change the replacement color of at least one row',
        pickFindColour: 'Pick a color to find',
        nothingSelected: 'Nothing is selected',
        pairsPrefix: n => n + ' pair' + (n === 1 ? '' : 's') + ' → ',
        noMatches: 'No matches',
        objects: n => n + ' object' + (n === 1 ? '' : 's'),
        fills: n => n + ' fill' + (n === 1 ? '' : 's'),
        strokes: n => n + ' stroke' + (n === 1 ? '' : 's'),
        textRuns: n => n + ' text run' + (n === 1 ? '' : 's'),
        gradientStops: n => n + ' gradient stop' + (n === 1 ? '' : 's'),
        error: 'Error: ',

        noEditedRowMsg: 'No row has a different replacement color: change the color (→) of at least one.',
        noFindColourMsg: 'No color to find was chosen.',
        noTargetsMsg: 'Tick at least Fill, Stroke or Text.',
        scopeNoSelectionMsg: 'Scope is "Selection" but nothing is selected.',
        batchTarget: n => n + ' color' + (n === 1 ? '' : 's'),
        notFound: target => target + ' was not found.',
        selected: (n, target) => 'Selected ' + n + ' object' + (n === 1 ? '' : 's') + ' with ' + target + '.',
        elsewhere: n => n + ' more match' + (n === 1 ? '' : 'es') + ' on other spreads (only the current spread can be selected).',
        nothingToReplace: 'Nothing to replace.',
        batchHeader: tol => 'Batch replace' + tol + ':',
        ruleLine: (from, to, n) => from + ' → ' + to + ':  ' + (n ? n + ' change' + (n === 1 ? '' : 's') : 'no matches'),
        replacedHeader: (target, to) => 'Replaced ' + target + ' → ' + to + ':',
        errors: (n, msg) => n + ' error' + (n === 1 ? '' : 's') + ': ' + msg,
        undoHint: 'Ctrl+Z undoes the whole change at once.'
    },

    es: {
        title: 'Buscar y reemplazar color',
        noDocument: 'No hay ningún documento abierto.',

        modeLabel: 'Modo',
        modes: ['Un color', 'Lote'],

        findGroup: 'Buscar',
        findColour: 'Color',
        fromDocument: 'Del documento',
        docColoursHeader: '— Colores del documento —',
        docColoursHelp: 'Colores sólidos y paradas de degradado encontrados en todo el documento, ordenados por uso.',

        batchGroup: 'Pares de color',
        batchHelp: 'Solo se aplican las filas cuyo color de reemplazo hayas cambiado. ' +
            'Si un color coincide con varias filas, gana la primera. A→B y B→A se intercambian bien.',
        rowFind: n => n + '. Buscar',
        removeRowHelp: 'Quitar esta fila',
        keepOneRow: 'Debe quedar al menos una fila',
        addRow: '+ Añadir fila',
        loadColours: 'Cargar colores del documento',
        loadColoursHelp: 'Rellena las filas con los colores más usados. El reemplazo empieza igual al original: cambia solo los que quieras.',
        maxRows: n => 'Máximo ' + n + ' filas',
        noSolidColours: 'El documento no tiene colores sólidos',
        loaded: (n, total) => 'Cargados ' + n + ' de ' + total + ' colores. Cambia el reemplazo (→) de los que quieras.',

        tolerance: 'Tolerancia (ΔE)',
        toleranceHelp: '0 = color exacto (RGB y CMYK). 1–2 = diferencias imperceptibles. 5–10 = tonos muy parecidos. En CMYK, cada tinta puede variar como máximo este mismo %.',

        whereGroup: 'Dónde',
        scope: 'Alcance',
        scopes: ['Selección', 'Pliego actual', 'Todo el documento'],
        fill: 'Relleno',
        stroke: 'Trazo',
        text: 'Texto',
        gradients: 'Degradados',
        includeHidden: 'Incluir ocultos y bloqueados',

        actionGroup: 'Acción',
        actionLabel: 'Acción',
        actions: ['Seleccionar', 'Reemplazar'],
        replaceWith: 'Reemplazar con',
        keepAlpha: 'Conservar opacidad original',
        countMatches: 'Contar coincidencias',

        needEditedRow: 'Cambia el color de reemplazo de al menos una fila',
        pickFindColour: 'Elige un color a buscar',
        nothingSelected: 'No hay nada seleccionado',
        pairsPrefix: n => n + ' par' + (n === 1 ? '' : 'es') + ' → ',
        noMatches: 'Sin coincidencias',
        objects: n => n + ' objeto' + (n === 1 ? '' : 's'),
        fills: n => n + ' relleno' + (n === 1 ? '' : 's'),
        strokes: n => n + ' trazo' + (n === 1 ? '' : 's'),
        textRuns: n => n + ' tramo' + (n === 1 ? '' : 's') + ' de texto',
        gradientStops: n => n + ' parada' + (n === 1 ? '' : 's') + ' de degradado',
        error: 'Error: ',

        noEditedRowMsg: 'Ninguna fila tiene un color de reemplazo distinto: cambia el color (→) de al menos una.',
        noFindColourMsg: 'No se eligió ningún color a buscar.',
        noTargetsMsg: 'Marca al menos Relleno, Trazo o Texto.',
        scopeNoSelectionMsg: 'El alcance es "Selección" pero no hay nada seleccionado.',
        batchTarget: n => n + ' color' + (n === 1 ? '' : 'es'),
        notFound: target => 'No se encontró ' + target + '.',
        selected: (n, target) => 'Seleccionados ' + n + ' objeto' + (n === 1 ? '' : 's') + ' con ' + target + '.',
        elsewhere: n => n + ' coincidencia' + (n === 1 ? '' : 's') + ' más en otros pliegos (solo se puede seleccionar en el pliego actual).',
        nothingToReplace: 'Nada que reemplazar.',
        batchHeader: tol => 'Reemplazo en lote' + tol + ':',
        ruleLine: (from, to, n) => from + ' → ' + to + ':  ' + (n ? n + ' cambio' + (n === 1 ? '' : 's') : 'sin coincidencias'),
        replacedHeader: (target, to) => 'Reemplazado ' + target + ' → ' + to + ':',
        errors: (n, msg) => n + ' error' + (n === 1 ? '' : 'es') + ': ' + msg,
        undoHint: 'Ctrl+Z deshace todo el cambio de una vez.'
    }
};

const T = STRINGS[LANG] || STRINGS.en;

// ---------------------------------------------------------------------------
// Colour maths: sRGB (8 bit) -> CIE Lab (D65) and ΔE76 distance
// ---------------------------------------------------------------------------

function srgbToLinear(v) {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function labF(t) {
    return t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116);
}

function rgbToLab(c) {
    const r = srgbToLinear(c.r), g = srgbToLinear(c.g), b = srgbToLinear(c.b);
    const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
    const y = (r * 0.2126 + g * 0.7152 + b * 0.0722);
    const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
    const fx = labF(x), fy = labF(y), fz = labF(z);
    return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

function deltaE(labA, labB) {
    const dL = labA.L - labB.L, da = labA.a - labB.a, db = labA.b - labB.b;
    return Math.sqrt(dL * dL + da * da + db * db);
}

function hex2(n) {
    return (n < 16 ? '0' : '') + n.toString(16).toUpperCase();
}

function colourHex(colour) {
    const c = colour.rgba8;
    return '#' + hex2(c.r) + hex2(c.g) + hex2(c.b);
}

// Largest per-ink difference between two colours, in percent (0-100).
function cmykDiff(a, b) {
    return 100 * Math.max(Math.abs(a.c - b.c), Math.abs(a.m - b.m), Math.abs(a.y - b.y), Math.abs(a.k - b.k));
}

// Builds a predicate that tells whether a Colour matches the search colour.
// RGB alone is not enough: Affinity's RGB view of CMYK colours clips, so K100
// and rich black 60/40/40/100 both read as 0,0,0. A colour must therefore also
// match in CMYK (exactly at tolerance 0, within `tolerance` % per ink otherwise).
function makeMatcher(target, tolerance) {
    const t = target.rgba8;
    const tk = target.cmykaf;
    const targetLab = rgbToLab(t);
    return function (colour) {
        if (!colour) return false;
        let c, k;
        try { c = colour.rgba8; k = colour.cmykaf; } catch (_) { return false; }
        if (tolerance <= 0) {
            return c.r === t.r && c.g === t.g && c.b === t.b && cmykDiff(k, tk) < 0.5;
        }
        return deltaE(rgbToLab(c), targetLab) <= tolerance + 1e-6 && cmykDiff(k, tk) <= tolerance + 1e-6;
    };
}

// Replacement colour; optionally keeps the alpha of the colour it replaces.
// The picked Colour is cloned, not rebuilt, so spot (Pantone) and global
// swatch identity travel with it.
function makeReplacement(newColour, oldColour, keepAlpha) {
    const c = newColour.clone();
    if (keepAlpha && oldColour) {
        try { c.alpha = oldColour.alpha; } catch (_) {}
    }
    return c;
}

// ---------------------------------------------------------------------------
// Rules: each one is "colour → colour". Single mode is just one rule.
// ---------------------------------------------------------------------------

function makeRules(pairs, tolerance) {
    return pairs.map(p => ({
        match: makeMatcher(p.find, tolerance),
        find: p.find,
        colour: p.replace,
        count: 0
    }));
}

function anyRuleMatches(rules) {
    return colour => rules.some(r => r.match(colour));
}

// First matching rule wins. Callers always pass the ORIGINAL colour, so swaps
// (A → B together with B → A) never chain into each other.
function resolveColour(rules, old, keepAlpha) {
    for (let i = 0; i < rules.length; i++) {
        const r = rules[i];
        if (r.match(old)) {
            r.count++;
            return { colour: makeReplacement(r.colour, old, keepAlpha), rule: i };
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Fill inspection
// ---------------------------------------------------------------------------

function fillTag(fill) {
    try { return fill ? fill[Symbol.toStringTag] : null; } catch (_) { return null; }
}

function safeBrushFd(node) {
    try { return node.brushFillDescriptor || null; } catch (_) { return null; }
}

// Pen fill, only when the stroke is actually visible (weight > 0).
function safePenFd(node) {
    try {
        const ls = node.lineStyleInterface;
        if (!ls || ls.isNoFill) return null;
        if (!(ls.lineWeight > 0)) return null;
        return ls.penFillDescriptor || null;
    } catch (_) {
        return null;
    }
}

function safeStory(node) {
    try {
        const si = node.storyInterface;
        const story = si && si.story;
        return story && story.length > 0 ? story : null;
    } catch (_) {
        return null;
    }
}

function gradientStopColours(fill) {
    try {
        return fill.gradient.stops.map(s => new Colour(s.colour));
    } catch (_) {
        return [];
    }
}

// Returns { fd, key } with the matching colour(s) replaced, or null if nothing
// in this descriptor matches. `key` identifies the result, so text runs that
// end up identical can share one command.
function replaceInDescriptor(fd, rules, opts, stats, statKey) {
    const fill = fd.fill;
    const tag = fillTag(fill);

    if (tag === 'SolidFill') {
        const old = fill.colour;
        const res = resolveColour(rules, old, opts.keepAlpha);
        if (!res) return null;
        const newFill = fill.clone();
        newFill.colour = res.colour;
        stats[statKey]++;
        let alpha = '';
        try { alpha = res.colour.alpha; } catch (_) {}
        return { fd: fd.cloneWithNewFill(newFill), key: 's' + res.rule + '/' + alpha };
    }

    if (tag === 'GradientFill' && opts.gradients) {
        const stops = fill.gradient.stops;
        let changed = 0;
        const newStops = stops.map(s => {
            const res = resolveColour(rules, new Colour(s.colour), opts.keepAlpha);
            if (!res) return s;
            changed++;
            return {
                colour: res.colour,
                position: s.position,
                midpoint: s.midpoint,
                smoothness: s.smoothness
            };
        });
        if (!changed) return null;
        const oldGrad = fill.gradient;
        const newGrad = Gradient.create(newStops);
        try { newGrad.alpha = oldGrad.alpha; } catch (_) {}
        try { newGrad.noise = oldGrad.noise; } catch (_) {}
        stats.gradientStops += changed;
        return { fd: fd.cloneWithNewFill(fill.cloneWithNewGradient(newGrad)), key: null };
    }

    return null;
}

function descriptorMatches(fd, matches, opts) {
    if (!fd) return false;
    const fill = fd.fill;
    const tag = fillTag(fill);
    if (tag === 'SolidFill') return matches(fill.colour);
    if (tag === 'GradientFill' && opts.gradients) return gradientStopColours(fill).some(matches);
    return false;
}

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

function isUsable(node, includeHidden) {
    if (includeHidden) return true;
    try { if (node.isVisible === false) return false; } catch (_) {}
    try { if (node.isEditable === false) return false; } catch (_) {}
    return true;
}

function walk(node, includeHidden, out) {
    if (!isUsable(node, includeHidden)) return;
    out.push(node);
    let kids = [];
    try { kids = [...node.children]; } catch (_) {}
    for (const k of kids) walk(k, includeHidden, out);
}

function spreadIndexOf(doc, spread) {
    try { return spread.firstPageIndex; } catch (_) { return -1; }
}

// Returns [{ node, spreadKey }] for the chosen scope.
function collectNodes(doc, scope, includeHidden, selNodes) {
    const result = [];
    const push = (nodes, key) => { for (const n of nodes) result.push({ node: n, spreadKey: key }); };

    let currentKey = -1;
    try { currentKey = spreadIndexOf(doc, doc.currentSpread); } catch (_) {}

    if (scope === 0) {
        const seen = new Set();
        for (const n of selNodes) {
            const list = [];
            walk(n, true, list); // explicit selection: include everything inside
            push(list.filter(x => {
                const id = x.handle;
                if (seen.has(id)) return false;
                seen.add(id);
                return true;
            }), currentKey);
        }
        return { entries: result, currentKey };
    }

    if (scope === 1) {
        const list = [];
        for (const child of doc.currentSpread.children) walk(child, includeHidden, list);
        push(list, currentKey);
        return { entries: result, currentKey };
    }

    for (const spread of doc.spreads) {
        const list = [];
        for (const child of spread.children) walk(child, includeHidden, list);
        push(list, spreadIndexOf(doc, spread));
    }
    return { entries: result, currentKey };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

// Finds every match. Each hit: { node, spreadKey, fill, stroke, textFill:[runs], textStroke:[runs] }
function findMatches(entries, matches, opts) {
    const hits = [];
    for (const { node, spreadKey } of entries) {
        const hit = { node, spreadKey, fill: false, stroke: false, textFill: [], textStroke: [] };
        const story = opts.text ? safeStory(node) : null;

        if (story) {
            for (const run of story.glyphAttRuns) {
                const atts = run.glyphAtts;
                let bf = null;
                try { bf = atts.brushFill; } catch (_) {}
                if (bf && descriptorMatches(bf, matches, opts)) hit.textFill.push(run);
                if (opts.stroke) {
                    let pf = null;
                    try { pf = atts.penFill; } catch (_) {}
                    if (pf && descriptorMatches(pf, matches, opts)) hit.textStroke.push(run);
                }
            }
        }

        if (opts.fill && !story) hit.fill = descriptorMatches(safeBrushFd(node), matches, opts);
        if (opts.stroke && !story) hit.stroke = descriptorMatches(safePenFd(node), matches, opts);

        if (hit.fill || hit.stroke || hit.textFill.length || hit.textStroke.length) hits.push(hit);
    }
    return hits;
}

function summarise(hits) {
    const s = { objects: hits.length, fills: 0, strokes: 0, textRuns: 0 };
    for (const h of hits) {
        if (h.fill) s.fills++;
        if (h.stroke) s.strokes++;
        s.textRuns += h.textFill.length + h.textStroke.length;
    }
    return s;
}

function describeSummary(s) {
    if (!s.objects) return T.noMatches;
    const parts = [];
    if (s.fills) parts.push(T.fills(s.fills));
    if (s.strokes) parts.push(T.strokes(s.strokes));
    if (s.textRuns) parts.push(T.textRuns(s.textRuns));
    return T.objects(s.objects) + ': ' + parts.join(', ');
}

// ---------------------------------------------------------------------------
// Replace
// ---------------------------------------------------------------------------

// Groups text runs by their replacement, so each distinct result becomes one
// FormatText command covering all its ranges.
function textRangeCommands(doc, node, runs, which, rules, opts, stats) {
    const groups = new Map();
    for (const run of runs) {
        const fd = which === 'pen' ? run.glyphAtts.penFill : run.glyphAtts.brushFill;
        const res = replaceInDescriptor(fd, rules, opts, stats, 'textRuns');
        if (!res) continue;
        const key = res.key || ('run' + run.begin); // gradients: keep each run separate
        if (!groups.has(key)) groups.set(key, { fd: res.fd, ranges: [] });
        groups.get(key).ranges.push(new StoryRange(run.begin, run.end));
    }

    const cmds = [];
    for (const { fd, ranges } of groups.values()) {
        const sel = Selection.create(doc, node);
        sel.addSubSelectionForNode(node, TextSelection.create(ranges));
        const delta = which === 'pen' ? StoryDelta.createPenFill(fd) : StoryDelta.createBrushFill(fd);
        cmds.push(DocumentCommand.createFormatText(sel, delta));
    }
    return cmds;
}

function buildReplaceCommand(doc, hits, rules, opts) {
    const stats = { fills: 0, strokes: 0, textRuns: 0, gradientStops: 0, errors: 0, firstError: null };
    const cb = CompoundCommandBuilder.create();
    let count = 0;

    const add = (cmd) => { cb.addCommand(cmd); count++; };
    const fail = (e) => { stats.errors++; stats.firstError = stats.firstError || String(e && e.message || e); };

    for (const h of hits) {
        const node = h.node;
        if (h.fill) {
            try {
                const res = replaceInDescriptor(safeBrushFd(node), rules, opts, stats, 'fills');
                if (res) add(DocumentCommand.createSetBrushFill(Selection.create(doc, node), res.fd));
            } catch (e) { fail(e); }
        }
        if (h.stroke) {
            try {
                const res = replaceInDescriptor(safePenFd(node), rules, opts, stats, 'strokes');
                if (res) add(DocumentCommand.createSetPenFill(Selection.create(doc, node), res.fd));
            } catch (e) { fail(e); }
        }
        if (h.textFill.length) {
            try { textRangeCommands(doc, node, h.textFill, 'brush', rules, opts, stats).forEach(add); }
            catch (e) { fail(e); }
        }
        if (h.textStroke.length) {
            try { textRangeCommands(doc, node, h.textStroke, 'pen', rules, opts, stats).forEach(add); }
            catch (e) { fail(e); }
        }
    }

    return { command: count ? cb.createCommand() : null, stats };
}

// ---------------------------------------------------------------------------
// Document colour inventory (for "From document" and "Load document colours")
// ---------------------------------------------------------------------------

function inventoryColours(entries) {
    const map = new Map();
    const note = (colour) => {
        if (!colour) return;
        let key;
        try {
            const k = colour.cmykaf;
            // hex + CMYK so K100 and rich black stay separate entries
            key = colourHex(colour) + '|' + [k.c, k.m, k.y, k.k].map(v => Math.round(v * 100)).join('/');
        } catch (_) { return; }
        const e = map.get(key);
        if (e) e.count++;
        else map.set(key, { key: key, hex: colourHex(colour), colour: colour, count: 1 });
    };
    const noteFd = (fd) => {
        if (!fd) return;
        const fill = fd.fill;
        const tag = fillTag(fill);
        if (tag === 'SolidFill') note(fill.colour);
        else if (tag === 'GradientFill') gradientStopColours(fill).forEach(note);
    };

    for (const { node } of entries) {
        const story = safeStory(node);
        if (story) {
            for (const run of story.glyphAttRuns) {
                try { noteFd(run.glyphAtts.brushFill); } catch (_) {}
                try { noteFd(run.glyphAtts.penFill); } catch (_) {}
            }
            continue;
        }
        if (isArtboard(node)) continue; // artboard backgrounds are rarely what you want
        noteFd(safeBrushFd(node));
        noteFd(safePenFd(node));
    }

    return [...map.values()].sort((a, b) => b.count - a.count).slice(0, MAX_DOC_COLOURS);
}

function colourLabel(entry) {
    let label = entry.hex;
    try {
        const k = entry.colour.cmykaf;
        label += '  C' + Math.round(k.c * 100) + ' M' + Math.round(k.m * 100) +
                 ' Y' + Math.round(k.y * 100) + ' K' + Math.round(k.k * 100);
    } catch (_) {}
    return label + '   (' + entry.count + ')';
}

function isArtboard(node) {
    try { return !!node.artboardInterface.isArtboardEnabled; } catch (_) { return false; }
}

// Initial search colour: the first selected object's fill, then stroke, then text.
function pickInitialColour(selNodes) {
    for (const n of selNodes) {
        const story = safeStory(n);
        if (story) {
            try {
                const f = story.getGlyphAtts(0).brushFill.fill;
                if (fillTag(f) === 'SolidFill') return f.colour;
            } catch (_) {}
        }
        const bf = safeBrushFd(n);
        if (bf && fillTag(bf.fill) === 'SolidFill') return bf.fill.colour;
        const pf = safePenFd(n);
        if (pf && fillTag(pf.fill) === 'SolidFill') return pf.fill.colour;
    }
    return null;
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function runModalSafe(dlg) {
    const t0 = Date.now();
    try {
        const r = dlg.runModal();
        return r === DialogResult.Ok || r === DialogResult.Ok.value || (r && r.value === DialogResult.Ok.value);
    } catch (e) {
        if (Date.now() - t0 < 500) throw e;
        return false; // window closed with the title-bar X
    }
}

function showDialog(doc, selNodes, allEntries) {
    const docColours = inventoryColours(allEntries);
    const initial = pickInitialColour(selNodes) || (docColours[0] && docColours[0].colour) || null;

    const dlg = Dialog.create(T.title);
    dlg.initialWidth = 460;
    const col = dlg.addColumn();

    // --- Mode
    const gMode = col.addGroup('');
    const modeSet = gMode.addButtonSet(T.modeLabel, T.modes, 0).setIsFullWidth();

    // --- Find (single colour)
    const gFind = col.addGroup(T.findGroup);
    const findPicker = gFind.addColourPicker(T.findColour, initial);
    if (docColours.length) {
        const items = [T.docColoursHeader].concat(docColours.map(colourLabel));
        const docCombo = gFind.addComboBox(T.fromDocument, items, 0);
        docCombo.setDescription(T.docColoursHelp);
        docCombo.onValueChangedHandler = () => {
            const i = docCombo.selectedIndex;
            if (i > 0) {
                findPicker.value = docColours[i - 1].colour;
                refreshCount();
            }
        };
    }

    // --- Batch: "find → replace" rows
    const gBatchHelp = col.addGroup(T.batchGroup);
    gBatchHelp.addStaticText('', T.batchHelp).setIsFullWidth();

    let loading = false;
    const rows = [];
    let rowCount = 1;

    // Removes row `index`: the rows below move up one place, keeping their
    // colours and whether they were edited. The last row can't be removed.
    function removeRow(index) {
        if (index >= rowCount) return;
        if (rowCount <= 1) {
            rows[0].dirty = false;
            status.text = T.keepOneRow;
            return;
        }
        loading = true;
        try {
            for (let j = index; j < rowCount - 1; j++) {
                rows[j].find.value = rows[j + 1].find.value;
                rows[j].repl.value = rows[j + 1].repl.value;
                rows[j].dirty = rows[j + 1].dirty;
            }
        } finally {
            loading = false;
        }
        rowCount--;
        rows[rowCount].dirty = false;
        syncVisibility();
    }

    for (let i = 0; i < MAX_ROWS; i++) {
        const g = col.addGroup('');
        const stack = g.addColumnStack();
        const cFind = stack.addColumn();
        const cRepl = stack.addColumn();
        const cDel = stack.addColumn();
        cFind.widthProportion = 1;
        cRepl.widthProportion = 1;
        cDel.widthProportion = 0.18;
        const find = cFind.addGroup('').addColourPicker(T.rowFind(i + 1), initial);
        const repl = cRepl.addGroup('').addColourPicker('→', initial);
        // En-space padding makes the compact button look square next to a colour row.
        const del = cDel.addGroup('').addButton(' ✕ ');
        del.setDescription(T.removeRowHelp);
        const row = { group: g, find, repl, dirty: false };
        repl.onValueChangedHandler = () => { if (!loading) row.dirty = true; };
        del.onClickHandler = () => removeRow(i);
        rows.push(row);
    }

    const gBatchBtns = col.addGroup('');
    const btnStack = gBatchBtns.addColumnStack();
    const addBtn = btnStack.addColumn().addGroup('').addButton(T.addRow).setIsFullWidth();
    const loadBtn = btnStack.addColumn().addGroup('').addButton(T.loadColours).setIsFullWidth();
    loadBtn.setDescription(T.loadColoursHelp);

    // --- Tolerance (shared)
    const gTol = col.addGroup('');
    const tolEditor = gTol.addUnitValueEditor(T.tolerance, UnitType.Number, UnitType.Number, 0, 0, 50);
    tolEditor.setPrecision(1);
    tolEditor.setShowPopupSlider(true);
    tolEditor.setDescription(T.toleranceHelp);

    // --- Where
    const gWhere = col.addGroup(T.whereGroup);
    gWhere.enableSeparator = true;
    const defaultScope = selNodes.length >= 2 ? 0 : 1;
    const scopeCombo = gWhere.addComboBox(T.scope, T.scopes, defaultScope);
    const stack = gWhere.addColumnStack();
    const c1 = stack.addColumn().addGroup('');
    const c2 = stack.addColumn().addGroup('');
    const chkFill = c1.addCheckBox(T.fill, true).setIsFullWidth();
    const chkStroke = c1.addCheckBox(T.stroke, true).setIsFullWidth();
    const chkText = c2.addCheckBox(T.text, true).setIsFullWidth();
    const chkGrad = c2.addCheckBox(T.gradients, true).setIsFullWidth();
    const chkHidden = gWhere.addCheckBox(T.includeHidden, false).setIsFullWidth();

    // --- Action
    const gAct = col.addGroup(T.actionGroup);
    gAct.enableSeparator = true;
    const actionSet = gAct.addButtonSet(T.actionLabel, T.actions, 1).setIsFullWidth();
    const gRepl = col.addGroup('');
    const replPicker = gRepl.addColourPicker(T.replaceWith, initial);
    const gAlpha = col.addGroup('');
    const chkAlpha = gAlpha.addCheckBox(T.keepAlpha, true).setIsFullWidth();

    const gInfo = col.addGroup('');
    gInfo.enableSeparator = true;
    const countBtn = gInfo.addButton(T.countMatches).setIsFullWidth();
    const status = gInfo.addStaticText('', '').setIsFullWidth();

    const isBatch = () => modeSet.selectedIndex === 1;

    function syncVisibility() {
        const batch = isBatch();
        const replace = actionSet.selectedIndex === 1;
        gFind.isVisible = !batch;
        gBatchHelp.isVisible = batch;
        gBatchBtns.isVisible = batch;
        rows.forEach((r, i) => { r.group.isVisible = batch && i < rowCount; });
        gRepl.isVisible = !batch && replace;
        gAlpha.isVisible = replace;
    }

    // Pairs to search for. `forReplace` keeps only rows the user actually edited.
    function currentPairs(forReplace) {
        if (!isBatch()) {
            const find = findPicker.value, replace = replPicker.value;
            if (!find || (forReplace && !replace)) return [];
            return [{ find, replace }];
        }
        const pairs = [];
        for (let i = 0; i < rowCount; i++) {
            const r = rows[i];
            if (forReplace && !r.dirty) continue;
            const find = r.find.value, replace = r.repl.value;
            if (find && replace) pairs.push({ find, replace });
        }
        return pairs;
    }

    function readOptions() {
        const action = actionSet.selectedIndex; // 0 select, 1 replace
        return {
            batch: isBatch(),
            pairs: currentPairs(action === 1),
            tolerance: Math.max(0, Number(tolEditor.value) || 0),
            scope: scopeCombo.selectedIndex,
            fill: chkFill.value,
            stroke: chkStroke.value,
            text: chkText.value,
            gradients: chkGrad.value,
            includeHidden: chkHidden.value,
            action: action,
            keepAlpha: chkAlpha.value
        };
    }

    function refreshCount() {
        try {
            const o = readOptions();
            if (!o.pairs.length) {
                status.text = o.batch && o.action === 1 ? T.needEditedRow : T.pickFindColour;
                return;
            }
            if (o.scope === 0 && !selNodes.length) { status.text = T.nothingSelected; return; }
            const { entries } = collectNodes(doc, o.scope, o.includeHidden, selNodes);
            const rules = makeRules(o.pairs, o.tolerance);
            const hits = findMatches(entries, anyRuleMatches(rules), o);
            const prefix = o.batch ? T.pairsPrefix(o.pairs.length) : '';
            status.text = prefix + describeSummary(summarise(hits));
        } catch (e) {
            status.text = T.error + e.message;
        }
    }

    addBtn.onClickHandler = () => {
        if (rowCount >= MAX_ROWS) { status.text = T.maxRows(MAX_ROWS); return; }
        const r = rows[rowCount];
        loading = true;
        try {
            if (initial) { r.find.value = initial; r.repl.value = initial; }
        } finally {
            loading = false;
        }
        r.dirty = false;
        rowCount++;
        syncVisibility();
    };
    loadBtn.onClickHandler = () => {
        if (!docColours.length) { status.text = T.noSolidColours; return; }
        const n = Math.min(MAX_ROWS, docColours.length);
        loading = true;
        try {
            for (let i = 0; i < n; i++) {
                rows[i].find.value = docColours[i].colour;
                rows[i].repl.value = docColours[i].colour;
                rows[i].dirty = false;
            }
        } finally {
            loading = false;
        }
        rowCount = n;
        syncVisibility();
        status.text = T.loaded(n, docColours.length);
    };

    modeSet.onValueChangedHandler = () => { syncVisibility(); refreshCount(); };
    actionSet.onValueChangedHandler = syncVisibility;
    countBtn.onClickHandler = refreshCount;
    syncVisibility();
    refreshCount();

    if (!runModalSafe(dlg)) return null;
    return readOptions();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function execute(doc, selNodes, o) {
    if (!o.pairs.length) {
        return o.batch && o.action === 1 ? T.noEditedRowMsg : T.noFindColourMsg;
    }
    if (!o.fill && !o.stroke && !o.text) return T.noTargetsMsg;
    if (o.scope === 0 && !selNodes.length) return T.scopeNoSelectionMsg;

    const rules = makeRules(o.pairs, o.tolerance);
    const { entries, currentKey } = collectNodes(doc, o.scope, o.includeHidden, selNodes);
    const hits = findMatches(entries, anyRuleMatches(rules), o);
    const tol = o.tolerance > 0 ? ' (±' + o.tolerance + ' ΔE)' : '';
    const target = o.batch
        ? T.batchTarget(o.pairs.length) + tol
        : colourHex(o.pairs[0].find) + tol;

    if (!hits.length) return T.notFound(target);

    if (o.action === 0) {
        const here = hits.filter(h => h.spreadKey === currentKey).map(h => h.node);
        const elsewhere = hits.length - here.length;
        if (here.length) doc.selection = Selection.create(doc, here);
        let msg = T.selected(here.length, target);
        if (elsewhere) msg += '\n' + T.elsewhere(elsewhere);
        return msg;
    }

    const { command, stats } = buildReplaceCommand(doc, hits, rules, o);
    if (!command) return T.nothingToReplace + (stats.firstError ? '\n' + stats.firstError : '');
    doc.executeCommand(command);

    const lines = [];
    if (o.batch) {
        lines.push(T.batchHeader(tol));
        for (const r of rules) {
            lines.push('  ' + T.ruleLine(colourHex(r.find), colourHex(r.colour), r.count));
        }
        lines.push('');
    } else {
        lines.push(T.replacedHeader(target, colourHex(o.pairs[0].replace)));
    }
    if (stats.fills) lines.push('  • ' + T.fills(stats.fills));
    if (stats.strokes) lines.push('  • ' + T.strokes(stats.strokes));
    if (stats.textRuns) lines.push('  • ' + T.textRuns(stats.textRuns));
    if (stats.gradientStops) lines.push('  • ' + T.gradientStops(stats.gradientStops));
    if (stats.errors) lines.push('  ⚠ ' + T.errors(stats.errors, stats.firstError));
    lines.push('\n' + T.undoHint);
    return lines.join('\n');
}

function main() {
    const doc = Document.current;
    if (!doc) { app.alert(T.noDocument, T.title); return; }

    const selNodes = [...doc.selection.nodes];
    const allEntries = collectNodes(doc, 2, false, selNodes).entries;

    const opts = showDialog(doc, selNodes, allEntries);
    if (!opts) return;

    const msg = execute(doc, selNodes, opts);
    if (msg) app.alert(msg, T.title);
}

main();
