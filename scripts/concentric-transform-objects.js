/**
 * Concentric Transform Objects
 * version: 1.0
 * description: Progressively transforms the selected objects outward from a chosen centre, with a live preview that Cancel restores.
 */
'use strict';
const { Document } = require('/document');
const { Dialog, DialogResult } = require('/dialog');
const { UnitType } = require('/units');
const { Transform } = require('/geometry');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
const { Colour } = require('/colours');
const { Selection } = require('/selections');
const { setTimeout } = require('/timers');
// LineStyleMask.Weight is REQUIRED for createSetLineStyleDescriptor to write the
// weight at all: the command takes an options.lineStyleMask, and the documented
// way the host itself sets a weight (document.setLineWeight) always passes
// {lineStyleMask: LineStyleMask.Weight}. Without it the command is accepted and
// applied to nothing, which is exactly the "Stroke does nothing" symptom.
// The module is not present on every build, so it is optional - a missing mask
// is reported once rather than crashing the run.
let LINE_STYLE_MASK_WEIGHT = null;
try {
    const { LineStyleMask } = require('/linestyle');
    if (LineStyleMask && LineStyleMask.Weight !== undefined) LINE_STYLE_MASK_WEIGHT = LineStyleMask.Weight;
} catch (e) {}
const TITLE = 'Concentric Transform Objects';
// Continuous controls (Strength %, Gamma) are
// debounced: the rebuild commits only once the interaction settles, i.e. on slider
// release. Discrete controls (Origin, Progression, Invert effect, the channel
// switches) bypass the timer and apply instantly.
// Rationale and host quirks: agents.md section 4b.
const SLIDER_COMMIT_MS = 300;
const CURVE_LINEAR = 0, CURVE_GAMMA = 1, CURVE_SMOOTH = 2, CURVE_EASE_OUT = 3;
// Centre modes.
const CENTRE_SELECTION = 0, CENTRE_SPREAD = 1;
// Where each cell of the anchor widget puts the origin, as fractions of the
// selection bounding box (fx, fy), keyed by the name the host returns.
//
// The widget's grid sits DIAGONALLY MIRRORED against ours: the mapping is a
// transpose, fx = the widget's fy and fy = the widget's fx, which mirrors the
// whole grid across the top-left to bottom-right diagonal. That single rule was
// derived from, and reproduces, the host's real behaviour:
//     widget Top      (0.5, 0) -> our LEFT edge     (0,   0.5)
//     widget TopRight (1,   0) -> our BOTTOM LEFT  (0,   1)
//     widget Right    (1,   0.5) -> our BOTTOM edge (0.5, 1)
// The four corners and the centre fall out of the same rule, so they need no
// separate guesswork. `fx = fy = 0.5` is the box centre, which is exactly the
// plain "Selection bounds" origin.
const ANCHOR_ORIGIN = {
    TopLeft:     { fx: 0,   fy: 0   },
    Top:         { fx: 0,   fy: 0.5 },
    TopRight:    { fx: 0,   fy: 1   },
    Left:        { fx: 0.5, fy: 0   },
    Centre:      { fx: 0.5, fy: 0.5 },
    Center:      { fx: 0.5, fy: 0.5 },
    Middle:      { fx: 0.5, fy: 0.5 },
    None:        { fx: 0.5, fy: 0.5 },
    Right:       { fx: 0.5, fy: 1   },
    BottomLeft:  { fx: 1,   fy: 0   },
    Bottom:      { fx: 1,   fy: 0.5 },
    BottomRight: { fx: 1,   fy: 1   }
};
// Lower-cased lookup of the table above. The widget's spelling varies with the host
// ("TopLeft", "top left", "top-left"), so the key is normalised to lower case with
// the separators stripped — the table itself is written the way Affinity spells it,
// for readability.
const ANCHOR_ORIGIN_BY_KEY = (function () {
    const table = {};
    for (const name in ANCHOR_ORIGIN) table[name.toLowerCase().replace(/[^a-z]/g, '')] = ANCHOR_ORIGIN[name];
    return table;
})();
// The point an anchor name maps to, or null for an unknown name.
function anchorFraction(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') {
        return ANCHOR_ORIGIN_BY_KEY[value.toLowerCase().replace(/[^a-z]/g, '')] || null;
    }
    if (typeof value === 'number') {
        // Enum index, row-major 3x3 with None first: 0 None, 1 TopLeft, 2 Top,
        // 3 TopRight, 4 Left, 5 Center, 6 Right, 7 BottomLeft, 8 Bottom,
        // 9 BottomRight. Only used if a host returns numbers instead of names.
        const NAMES_BY_INDEX = [null, 'TopLeft', 'Top', 'TopRight', 'Left', 'Center', 'Right', 'BottomLeft', 'Bottom', 'BottomRight'];
        const name = NAMES_BY_INDEX[Math.round(value)];
        return name ? ANCHOR_ORIGIN[name] : null;
    }
    if (typeof value === 'object') {
        for (const field of ['name', 'label', 'anchor', 'value', 'type']) {
            if (value[field] !== undefined && value[field] !== value) {
                const inner = anchorFraction(value[field]);
                if (inner) return inner;
            }
        }
        const x = Number(value.x), y = Number(value.y);
        if (isFinite(x) && isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1) return { fx: x, fy: y };
    }
    return null;
}
// Transform channels. `peak` is what a 100 % Strength reaches on the outermost
// object — a fixed per-channel value, so the dialog only needs one Amount slider
// and a row of switches. A negative peak inverts the direction of that channel
// (saturation towards grey, the offset pulling objects inwards).
// Strength is allowed to go past 100 %: every channel keeps scaling linearly from
// its peak, so 200 % means "twice as strong as the table below".
const DEG = Math.PI / 180;
const STRENGTH_MAX = 300;
const CHANNELS = [
    { key: 'size',        label: 'Size',        peak: 100, def: true  },
    { key: 'rotation',    label: 'Rotation',    peak: 60,  def: false },
    { key: 'skew',        label: 'Skew',        peak: 35,  def: false },
    { key: 'offset',      label: 'Offset',      peak: 30,  def: false },
    { key: 'transparency',label: 'Transp.',     peak: 100, def: false },
    { key: 'saturation',  label: 'Saturation',  peak: -60, def: false },
    { key: 'hue',         label: 'Hue',         peak: 180, def: false },
    { key: 'stroke',      label: 'Stroke',      peak: 60,  def: false }
];
// Every channel's peak value, keyed for a single lookup in the transform maths.
const CHANNEL_PEAK = (function () {
    const table = {};
    for (const channel of CHANNELS) table[channel.key] = channel.peak;
    return table;
})();
function showError(message) { const dlg = Dialog.create(TITLE); dlg.addColumn().addGroup('').addStaticText('', message); dlg.runModal(); }
function resultValue(result) { return result !== null && typeof result === 'object' && 'value' in result ? result.value : result; }
function describeError(error) { return error && error.message ? String(error.message) : String(error); }
function clamp(value, min, max) { return value < min ? min : value > max ? max : value; }
function curveValue(t, curve, gamma) {
    t = clamp(t, 0, 1);
    if (curve === CURVE_GAMMA) return Math.pow(t, clamp(gamma, 0.1, 5));
    if (curve === CURVE_SMOOTH) return t * t * (3 - 2 * t);
    if (curve === CURVE_EASE_OUT) { const u = 1 - t; return 1 - u * u * u; }
    return t;
}
function getBounds(node) { try { return node.getSpreadBaseBox(false); } catch (e) { return null; } }
function getCentre(bounds) { return bounds ? { x: bounds.x + bounds.width * 0.5, y: bounds.y + bounds.height * 0.5 } : { x: 0, y: 0 }; }
// A refused command used to be reported with a blocking app.alert straight from
// commit(). The FIRST commit runs BEFORE runModal(), so a failure there raised a
// modal alert with no dialog behind it — which looks exactly like "the script does
// nothing". The message is therefore only recorded here and raised once the dialog
// is actually on screen (or after it closes).
let pendingError = '';
let errorShown = false;
// Set once the Stroke channel has explained that it cannot do anything, so the
// explanation is raised once per run instead of once per pixel of a drag.
let strokeAlertShown = false;
function noteError(what, error) {
    if (pendingError) return;
    pendingError = what + ': ' + (error && error.message ? String(error.message) : String(error));
}
function raisePendingError() {
    if (!pendingError || errorShown) return;
    errorShown = true;
    const text = pendingError;
    pendingError = '';
    try {
        const { app } = require('/application');
        if (app && typeof app.alert === 'function') app.alert(text, TITLE);
    } catch (e) {}
}
function buildDialog(state) {
    // 300 rather than 360: the dialog is a single narrow column of short labels
    // and switches, and at 360 it was wide enough for the Progression button set
    // to dominate the layout. This is the host's own minimum-ish comfortable width
    // for one column of this many controls - it can still be dragged wider by hand.
    const dlg = Dialog.create(TITLE); dlg.initialWidth = 300;
    const column = dlg.addColumn(); column.widthProportion = 1;
    // ── Centre ───────────────────────────────────────────────────────────────
    // First block of the column: no rule, it would just underline the title.
    const centreGroup = column.addGroup('Centre'); centreGroup.enableSeparator = false;
    const centre = centreGroup.addButtonSet('Origin', ['Selection bounds', 'Spread centre'], state.centre);
    // The rectangle widget IS the origin picker: click a cell and the effect radiates
    // from the point ANCHOR_ORIGIN maps it to. There are no buttons for it any more.
    let anchorCtl = null;
    try {
        // Only pass an initial value when we actually have one: the documented
        // default is SpatialAnchor.None, and handing the host an explicit null is
        // something it may reject outright.
        anchorCtl = (state.anchor === null || state.anchor === undefined)
            ? centreGroup.addSpatialAnchor('Anchor')
            : centreGroup.addSpatialAnchor('Anchor', state.anchor);
    } catch (e) { anchorCtl = null; }
    const readAnchor = function () {
        if (!anchorCtl) return null;
        try { return anchorCtl.value; } catch (e) { return null; }
    };
    const isCentreAnchor = function (value) {
        const p = anchorFraction(value);
        return !!p && p.fx === 0.5 && p.fy === 0.5;
    };
    // The widget opens on the host's own default, which shows as the top-left cell.
    // Aim it at the CENTRE instead. The enum's representation is undocumented, so no
    // single value is written blind: the plausible names are tried first, then the
    // indices, and each write is READ BACK and only accepted when it really points at
    // the centre. A host that stores names takes 'Centre' on the first try; one that
    // stores numbers is caught by the index sweep.
    const defaultAnchor = readAnchor();
    let anchorIsUsable = isCentreAnchor(defaultAnchor);
    if (anchorCtl && !anchorIsUsable) {
        const candidates = ['Centre', 'Center', 'Middle', 'None'];
        for (let i = 0; i < candidates.length; i++) {
            try { anchorCtl.value = candidates[i]; } catch (e) { continue; }
            if (isCentreAnchor(readAnchor())) { anchorIsUsable = true; break; }
        }
    }
    if (anchorCtl && !anchorIsUsable) {
        for (let i = 0; i <= 10; i++) {
            try { anchorCtl.value = i; } catch (e) { continue; }
            if (isCentreAnchor(readAnchor())) { anchorIsUsable = true; break; }
        }
    }
    // If the widget could not be moved onto the centre, its value is IGNORED unless the
    // user changes it: the effect then still radiates from the bounding-box centre, so
    // only the widget's drawn cell can be off, never the result.
    // Where the widget currently points, as fractions of the selection box.
    const readAnchorPoint = function () {
        if (!anchorCtl) return null;
        const raw = readAnchor();
        if (raw === defaultAnchor && !anchorIsUsable) return null;
        return anchorFraction(raw);
    };
    // ── Amount ───────────────────────────────────────────────────────────────
    // Strength and the progression curve form ONE block: together they decide HOW
    // strongly an object is changed, never WHICH property — that is the job of the
    // channel switches below. Deliberately free of any "size" wording: with Size
    // switched off, Strength drives rotation, skew and opacity just as well.
    // Strength goes to 300 % on purpose: 100 % reaches each channel's built-in peak
    // (see CHANNELS), and beyond that every channel just keeps going stronger.
    const amountGroup = column.addGroup('Amount');
    // Every block except the first carries the rule, so the dialog reads as three
    // clearly separated sections instead of one long stack. Centre is the first
    // block of the column, so a rule there would only draw a line under the title.
    amountGroup.enableSeparator = true;
    const strength = amountGroup.addUnitValueEditor('Strength %', UnitType.Percent, UnitType.Percent, state.strength, 0, STRENGTH_MAX);
    strength.precision = 1; strength.showPopupSlider = true;
    const curve = amountGroup.addButtonSet('Progression', ['Linear', 'Gamma', 'Smoothstep', 'Ease out'], state.curve);
    const gamma = amountGroup.addUnitValueEditor('Gamma', UnitType.Number, UnitType.Number, state.gamma, 0.1, 5);
    gamma.precision = 2; gamma.showPopupSlider = true;
    // Flips the falloff: the object AT the centre changes most and the outermost
    // one not at all, which turns the effect inside out.
    const invert = amountGroup.addSwitch('Invert effect', state.invert);
    // ── Channels ─────────────────────────────────────────────────────────────
    // One switch per channel, nothing else: the magnitude is the Strength above
    // times that channel's fixed peak, so no per-channel editor is needed.
    // The Transform block gets the host's separator rule. The DialogGroup API has
    // no spacing/padding knob at all (only enableSeparator), so the rule is the one
    // built-in way to open up the gap between the Amount block and the switches:
    // a separated group is laid out with padding above its label, an unseparated
    // one is butted straight against the previous control. Leaving it off is what
    // made "Transform" look glued to the Invert effect row above it.
    const channelGroup = column.addGroup('Transform'); channelGroup.enableSeparator = true;
    const switches = {};
    for (const channel of CHANNELS) {
        switches[channel.key] = channelGroup.addSwitch(channel.label, !!state.on[channel.key]);
    }
    // No info/status line anywhere in the dialog.
    return {
        dlg,
        controls: { centre, anchor: anchorCtl, strength, curve, gamma, invert, switches },
        getState() {
            const on = {};
            for (const channel of CHANNELS) on[channel.key] = !!switches[channel.key].value;
            return {
                centre: centre.selectedIndex,
                // The RESOLVED anchor fractions, not the raw value: the raw one may be
                // an unverified default that the script deliberately ignores, and
                // stateKey must not change while that default sits there.
                anchor: readAnchorPoint(),
                strength: strength.value, curve: curve.selectedIndex, gamma: gamma.value, invert: !!invert.value,
                on: on
            };
        }
    };
}
function anchorKey(value) { return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value); }
function stateKey(state) {
    const parts = [state.centre, anchorKey(state.anchor), state.strength, state.curve, state.gamma, state.invert ? 1 : 0];
    for (const channel of CHANNELS) parts.push(state.on[channel.key] ? 1 : 0);
    return parts.join('|');
}
(function () {
    try {
    const doc = Document.current;
    if (!doc) { showError('No document is open.'); return; }
    const nodes = []; for (const node of doc.selection.nodes) nodes.push(node);
    if (!nodes.length) { showError('Select at least one object first.'); return; }
    const records = nodes.map(node => ({ node: node, selection: Selection.create(doc, node), bounds: getBounds(node) })).filter(r => r.bounds && r.selection);
    if (!records.length) { showError('The selected objects do not expose editable bounds.'); return; }
    for (const record of records) record.centre = getCentre(record.bounds);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const record of records) { const b = record.bounds; minX = Math.min(minX, b.x); minY = Math.min(minY, b.y); maxX = Math.max(maxX, b.x + b.width); maxY = Math.max(maxY, b.y + b.height); }
    const origin = { x: (minX + maxX) * 0.5, y: (minY + maxY) * 0.5 };
    // Spread extents are read at most once per rebuild (agents.md section 4): a
    // per-node read here would hit the DOM up to N extra times for nothing.
    let extentsCache = null;
    function spreadExtents() {
        if (extentsCache) return extentsCache;
        try { const e = doc.currentSpread && doc.currentSpread.getSpreadExtents({ includeSpread: true }); if (e) extentsCache = e; } catch (e) {}
        return extentsCache;
    }
    // The origin is the point ANCHOR_ORIGIN maps the widget's current cell to,
    // computed straight from the selection extents with no intermediate box object.
    // An absent or unreadable widget falls back to the bounding-box centre.
    function targetOrigin(state) {
        if (state.centre === CENTRE_SPREAD) { const e = spreadExtents(); return e ? getCentre(e) : origin; }
        const point = state.anchor;
        if (!point) return origin;
        return { x: minX + (maxX - minX) * point.fx, y: minY + (maxY - minY) * point.fy };
    }
    const distanceCache = new Map();
    function maxDistanceFor(centre) {
        const key = `${centre.x}|${centre.y}`;
        if (distanceCache.has(key)) return distanceCache.get(key);
        let maxDistance = 1;
        for (const record of records) { const p = record.centre; maxDistance = Math.max(maxDistance, Math.hypot(p.x - centre.x, p.y - centre.y)); }
        distanceCache.set(key, maxDistance);
        return maxDistance;
    }
    // Appearance baselines are captured ONCE, before the first preview, and never
    // re-read: every later tick emits ABSOLUTE opacity / colour / stroke targets, so
    // the preview can be replayed any number of times without compounding
    // (agents.md section 2b). Re-reading a mutated value mid-session is exactly what
    // makes an additive property apply twice.
    // Reads the solid fill colour as HSL, trying the brush fill and then the pen
    // fill. `getHSLAf` is the direct route; when a build does not expose it the
    // colour is converted from `rgba8` instead. Both the method AND the alpha key
    // are duck-typed, because a missing alpha used to make createHSLAf throw and
    // the command was then silently dropped — that is why Saturation and Hue
    // appeared to do nothing at all.
    function readFillHSL(node) {
        const sources = [];
        try { if (node.hasBrushFill && node.brushFillDescriptor) sources.push(node.brushFillDescriptor.fill); } catch (e) {}
        try { if (node.hasPenFill && node.penFillDescriptor) sources.push(node.penFillDescriptor.fill); } catch (e) {}
        for (const fill of sources) {
            if (!fill) continue;
            try {
                const colour = fill.colour || fill;
                if (!colour) continue;
                if (typeof colour.getHSLAf === 'function') {
                    const hsl = colour.getHSLAf();
                    if (hsl && isFinite(hsl.h)) {
                        return {
                            h: ((hsl.h % 1) + 1) % 1,
                            s: isFinite(hsl.s) ? clamp(hsl.s, 0, 1) : 0,
                            l: isFinite(hsl.l) ? clamp(hsl.l, 0, 1) : 0.5,
                            alpha: (hsl.alpha === undefined ? (hsl.a === undefined ? 1 : hsl.a) : hsl.alpha)
                        };
                    }
                }
                // Fallback: 0-255 RGBA -> HSL. Hue is normalised to 0-1 to match
                // what createHSLAf expects.
                const rgba = colour.rgba8;
                if (rgba) {
                    const r = rgba.r / 255, g = rgba.g / 255, b = rgba.b / 255;
                    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
                    let h = 0;
                    if (d > 1e-9) {
                        if (max === r) h = ((g - b) / d) % 6;
                        else if (max === g) h = (b - r) / d + 2;
                        else h = (r - g) / d + 4;
                        h /= 6;
                        if (h < 0) h += 1;
                    }
                    const l = (max + min) / 2;
                    const s = d < 1e-9 ? 0 : d / (1 - Math.abs(2 * l - 1) || 1);
                    return { h: h, s: clamp(s, 0, 1), l: clamp(l, 0, 1), alpha: rgba.a === undefined ? 1 : (rgba.a > 1 ? rgba.a / 255 : rgba.a) };
                }
            } catch (e) {}
        }
        return null;
    }

    // True when the line style actually paints something. `LineType.None` is the
    // trap: the object "has" a stroke descriptor with a perfectly valid weight,
    // so every guard passes and the channel emits commands that change nothing
    // visible.
    //
    // The value is NOT a plain string or number. The host returns an
    // EnumerationResult, so the documented form is `type.value` (see
    // vectorNodeTests.js: `lineStyle.lineStyle.type.value === LineType.None.value`).
    // Stringifying the wrapper yields "[object Object]", which contains neither
    // "none" nor a digit - so a check on the raw value can NEVER detect the
    // disabled stroke, and the channel stays silent. Unwrap first, and accept
    // every plausible shape: a wrapper, a name, or a number.
    function strokeTypeIsVisible(lineStyle) {
        let t;
        try { t = lineStyle.type; } catch (e) { return true; }   // unreadable -> assume visible
        if (t && typeof t === 'object') t = (t.value !== undefined) ? t.value : (t.name !== undefined ? t.name : undefined);
        if (t === undefined || t === null) return true;           // absent -> assume visible
        if (typeof t === 'string') return t.toLowerCase().indexOf('none') === -1;
        if (typeof t === 'number') {
            // LineType.None is 0 on every documented build. A real stroke type is
            // non-zero, so 0 is the only number that can mean "no stroke".
            if (t === 0) return false;
            return true;
        }
        return true;
    }

    // Explains a Stroke channel that cannot do anything. Called at most once per
    // run: the user should not be told the same thing on every pixel of a drag.
    function reportInertStrokeChannel(records) {
        if (strokeAlertShown) return;
        const withWeight = records.filter(r => r.lineStyle && typeof r.weight === 'number');
        if (withWeight.some(r => r.strokeVisible)) return;      // at least one works
        strokeAlertShown = true;
        const message = withWeight.length
            ? 'every object has its outline switched off (line type None), so a stroke weight change cannot be seen'
            : 'none of the selected objects has a stroke - give them an outline first, a weight change needs something to draw';
        noteError('Stroke channel', new Error(message));
    }

    for (const record of records) {
        record.opacity = 1; record.hsl = null; record.weight = null; record.lineStyle = null;
        record.strokeVisible = false;
        record.hasBrush = false; record.hasPen = false;
        try { record.hasBrush = !!record.node.hasBrushFill; } catch (e) {}
        try { record.hasPen = !!record.node.hasPenFill; } catch (e) {}
        try { if (typeof record.node.globalOpacity === 'number') record.opacity = record.node.globalOpacity; } catch (e) {}
        record.hsl = readFillHSL(record.node);
        try {
            const d = record.node.lineStyleDescriptor;
            if (d && d.lineStyle) {
                record.weight = d.lineStyle.weight;
                // A stroke can be present but INVISIBLE: LineType.None means the
                // outline is switched off, and then a weight change changes nothing
                // on canvas. Remembering that is what lets the channel explain itself
                // instead of doing nothing in silence.
                record.strokeVisible = strokeTypeIsVisible(d.lineStyle);
                try { record.lineStyle = d.clone(); } catch (e) { record.lineStyle = d; }
            }
        } catch (e) {}
        // Applied geometry of the preview so far, and the last emitted appearance
        // values. `broken` records are skipped after a failed commit: their real
        // document state is unknown, and guessing compounds the error.
        record.net = null; record.last = null; record.broken = false;
    }
    const channelDefaults = {};
    for (const channel of CHANNELS) channelDefaults[channel.key] = channel.def;
    const state = {
        centre: CENTRE_SELECTION, anchor: null,
        strength: 50, curve: CURVE_LINEAR, gamma: 1.8, invert: false,
        on: channelDefaults
    };
    const ui = buildDialog(state); let lastKey = null;
    let debTimer = null, sliderGen = 0, updating = false;
    // Forward transform of ONE object at falloff f (0 at the centre, 1 at the
    // outermost object), expressed about that object's OWN centre. Every geometric
    // channel is composed into a single matrix, so an object still costs exactly ONE
    // transform command per tick no matter how many channels are on.
    // Order: the offset translation happens FIRST (leftmost), then scale, rotate,
    // shear — matching the sequential-command order the host applies.
    // `amount` is Strength/100 and may exceed 1, so every channel simply keeps
    // going past its 100 % peak instead of hitting a wall.
    function forwardTransform(record, f, st, amount, centre, maxDistance) {
        const c = record.centre;
        let acc = null;
        const push = function (m) { acc = acc ? m.multiply(acc) : m; };
        if (st.on.offset) {
            const reach = f * amount * (CHANNEL_PEAK.offset / 100) * 0.25 * maxDistance;
            if (Math.abs(reach) > 1e-9) {
                // Push along the outward radial direction, so "Offset" fans the
                // selection out from (or pulls it into) the chosen centre.
                const dx = c.x - centre.x, dy = c.y - centre.y;
                const len = Math.hypot(dx, dy);
                if (len > 1e-9) push(Transform.createTranslate(dx / len * reach, dy / len * reach));
            }
        }
        // The size floor is 0.01: at 100 % Strength the outermost object is already
        // reduced to nothing, and past that it stays there instead of inverting.
        if (st.on.size) { const s = clamp(1 - f * amount * (CHANNEL_PEAK.size / 100), 0.01, 1); push(Transform.createScale(s, s)); }
        if (st.on.rotation) push(Transform.createRotate(f * amount * CHANNEL_PEAK.rotation * DEG));
        if (st.on.skew) { const k = f * amount * (CHANNEL_PEAK.skew / 100); push(Transform.createShear(k, k)); }
        if (!acc) return null;
        // Wrap about the object's own centre: T(c)·acc·T(-c).
        return Transform.createTranslate(c.x, c.y).multiply(acc.multiply(Transform.createTranslate(-c.x, -c.y)));
    }
    // Absolute appearance targets computed from the once-captured baselines. A
    // channel that is switched off emits the baseline ONCE (restoring the object)
    // and is then silent, so the object never oscillates between two values.
    function appearanceCommands(record, f, st, amount) {
        const list = [];
        const last = record.last || (record.last = {});
        if (st.on.transparency) {
            const target = clamp(record.opacity * (1 - f * amount * (CHANNEL_PEAK.transparency / 100)), 0, 1);
            // Short-circuit while the target still equals the BASELINE and nothing
            // has been written yet: the object is already in that state, so a command
            // would be pure cost (one per object on the first pass).
            const changed = last.opacity === undefined
                ? Math.abs(target - record.opacity) > 1e-9
                : Math.abs(last.opacity - target) > 1e-9;
            if (changed) {
                list.push(DocumentCommand.createSetOpacity(record.selection, target)); last.opacity = target;
            }
        } else if (last.opacity !== undefined) {
            list.push(DocumentCommand.createSetOpacity(record.selection, record.opacity)); last.opacity = undefined;
        }
        const wantsColour = st.on.saturation || st.on.hue;
        // `target` is null when the channel is off, which means RESTORE: the
        // baseline colour is written back once. The previous code just cleared the
        // flag here, so switching Hue or Saturation off left the recoloured object
        // behind for the rest of the session.
        if (wantsColour || last.colour !== undefined) {
            if (!record.hsl) {
                last.colour = undefined;
            } else {
                const target = wantsColour
                    ? {
                        h: (st.on.hue ? ((record.hsl.h + f * amount * (CHANNEL_PEAK.hue / 360)) % 1 + 1) % 1 : record.hsl.h),
                        s: clamp(st.on.saturation ? record.hsl.s + f * amount * (CHANNEL_PEAK.saturation / 100) : record.hsl.s, 0, 1),
                        l: record.hsl.l,
                        alpha: record.hsl.alpha
                    }
                    : { h: record.hsl.h, s: record.hsl.s, l: record.hsl.l, alpha: record.hsl.alpha };
                const atBaseline = Math.abs(target.s - record.hsl.s) < 1e-9 && Math.abs(target.h - record.hsl.h) < 1e-9;
                const changed = last.colour === undefined
                    ? !atBaseline                                  // first pass: only if it differs
                    : (Math.abs(last.colour.h - target.h) > 1e-9 || Math.abs(last.colour.s - target.s) > 1e-9);
                if (changed) {
                    let colour = null;
                    try { colour = Colour.createHSLAf(target); } catch (e) { noteError('createHSLAf', e); }
                    if (colour) {
                        // A shape is usually brush-filled, but a line-only shape is
                        // pen-filled, so both are set: setting only the brush left
                        // "Hue does nothing" on exactly those objects.
                        if (record.hasBrush) {
                            try { list.push(DocumentCommand.createSetBrushFill(record.selection, colour)); } catch (e) { noteError('createSetBrushFill', e); }
                        }
                        if (record.hasPen) {
                            try { list.push(DocumentCommand.createSetPenFill(record.selection, colour)); } catch (e) { noteError('createSetPenFill', e); }
                        }
                    }
                    last.colour = target;
                }
            }
        }
        if (st.on.stroke) {
            if (record.lineStyle && typeof record.weight === 'number') {
                const target = Math.max(0.1, record.weight * (1 + f * amount * (CHANNEL_PEAK.stroke / 100)));
                const changed = last.stroke === undefined
                    ? Math.abs(target - record.weight) > 1e-9
                    : Math.abs(last.stroke - target) > 1e-9;
                if (changed) {
                    try {
                        const ls = record.lineStyle.lineStyle.clone();
                        ls.weight = target;
                        list.push(DocumentCommand.createSetLineStyleDescriptor(record.selection, record.lineStyle.cloneWithNewLineStyle(ls), { lineStyleMask: LINE_STYLE_MASK_WEIGHT }));
                    } catch (e) { noteError('createSetLineStyleDescriptor', e); }
                    last.stroke = target;
                }
            }
        } else if (last.stroke !== undefined) {
            try {
                const ls = record.lineStyle.lineStyle.clone();
                ls.weight = record.weight;
                list.push(DocumentCommand.createSetLineStyleDescriptor(record.selection, record.lineStyle.cloneWithNewLineStyle(ls), { lineStyleMask: LINE_STYLE_MASK_WEIGHT }));
            } catch (e) { noteError('createSetLineStyleDescriptor', e); }
            last.stroke = undefined;
        }
        return list;
    }
    // ONE preview pass around `centre`: every channel, absolute targets, one
    // compound command. The emitted geometry is newNet · oldNet⁻¹, so the document
    // jumps straight from the previous look to the new one with no intermediate
    // frame and no undo() churn (agents.md section 2b).
    function applyPass(centre, st) {
        // Before doing any work, say out loud if the Stroke channel has nothing it
        // could possibly draw on. A channel that silently no-ops reads as a broken
        // script, which is exactly what the user reported.
        if (st.on.stroke) reportInertStrokeChannel(records);
        const maxDistance = maxDistanceFor(centre);
        const amount = clamp(st.strength / 100, 0, STRENGTH_MAX / 100);
        const commands = [];
        for (const record of records) {
            if (record.broken) continue;
            const p = record.centre;
            const t = curveValue(Math.hypot(p.x - centre.x, p.y - centre.y) / maxDistance, st.curve, st.gamma);
            const falloff = st.invert ? 1 - t : t;
            const forward = forwardTransform(record, falloff, st, amount, centre, maxDistance);
            // Only the GEOMETRY is skipped when there is nothing to apply (and
            // nothing to undo). The appearance channels below must still run: with
            // every geometric switch off, "only Transparency" would otherwise do
            // nothing at all.
            if (forward || record.net) {
                try {
                    if (!forward) commands.push(DocumentCommand.createTransform(record.selection, record.net.inverted));
                    else if (!record.net) commands.push(DocumentCommand.createTransform(record.selection, forward));
                    else commands.push(DocumentCommand.createTransform(record.selection, forward.multiply(record.net.inverted)));
                    record.net = forward;
                } catch (e) { record.broken = true; continue; }
            }
            for (const command of appearanceCommands(record, falloff, st, amount)) commands.push(command);
        }
        if (!commands.length) return;
        const builder = CompoundCommandBuilder.create(); for (const command of commands) builder.addCommand(command);
        try { doc.executeCommand(builder.createCommand()); } catch (e) {
            // The applied state is now unknown for every object in this compound:
            // mark them broken so no later pass compounds on a wrong assumption.
            for (const record of records) record.broken = true;
            throw e;
        }
    }
    function rebuild(next) {
        Object.assign(state, next);
        applyPass(targetOrigin(state), state);
    }
    function commit(st) {
        cancelPendingSlider();
        updating = true;
        // A failed pass must never escape into the host's event handler: a throw
        // from onChanged would tear the dialog down before Cancel can run, leaving
        // the preview in the document with no way back.
        try { rebuild(st); } catch (e) { noteError('apply', e); } finally { updating = false; }
    }
    // Continuous controls are the ones with a popup slider or a typed number:
    // Strength and Gamma. A change in one of them means the user is mid-drag or
    // mid-typing, so it is deferred to release. Switches, button sets, the Origin
    // and the anchor widget are one-shot and commit instantly.
    function continuousKey(st) {
        // The anchor widget is dragged with the mouse, so it is continuous too: a
        // drag must not rebuild the document on every pixel.
        return [st.strength, st.gamma, anchorKey(st.anchor)].join('|');
    }
    let lastContinuous = null;
    // Gamma only means something on the Gamma curve, and the two origin controls
    // only apply to the selection bounds. These writes are programmatic, so they run
    // under the re-entrancy guard (agents.md section 3).
    function syncEnabled(st) {
        ui.controls.gamma.isEnabled = st.curve === CURVE_GAMMA;
        // The anchor widget may be a control that has no enable/disable state on this
        // build; writing to it must not be able to stop the dialog from opening.
        if (ui.controls.anchor) {
            try { ui.controls.anchor.isEnabled = st.centre === CENTRE_SELECTION; } catch (e) {}
        }
    }
    function scheduleSlider(st) {
        cancelPendingSlider();
        const gen = ++sliderGen;
        debTimer = setTimeout(SLIDER_COMMIT_MS, function (err) {
            // The host still invokes the callback after cancel() (with an
            // ABORTED error code), so a generation token decides whether this
            // fired callback is still the live one.
            if (gen !== sliderGen) return;
            debTimer = null;
            if (updating) return;
            commit(st);
            // A drag commits here, not in onChanged(), so a failure recorded during
            // this commit (an inert Stroke channel, a refused command) would
            // otherwise stay silent for the rest of the session.
            raisePendingError();
        });
    }
    function cancelPendingSlider() {
        if (!debTimer) return;
        sliderGen++;
        try { debTimer.cancel(); } catch (e) {}
        debTimer = null;
    }
    function onChanged() {
        if (updating) return;
        const next = ui.getState();
        updating = true;
        try { syncEnabled(next); } finally { updating = false; }
        const key = stateKey(next); if (key === lastKey) return;
        const continuous = continuousKey(next);
        if (continuous !== lastContinuous) { lastContinuous = continuous; scheduleSlider(next); return; }
        lastKey = key; commit(next);
        // Safe to surface a failure now: the dialog is on screen behind it.
        raisePendingError();
    }
    // The first commit happens before runModal(); a failure there must NOT block on
    // an alert with no dialog behind it, or the run looks dead. It is reported after
    // the dialog closes instead (see below).
    updating = true;
    try { syncEnabled(state); } finally { updating = false; }
    ui.dlg.onControlValueChangedHandler = onChanged;
    lastContinuous = continuousKey(state);
    commit(state); lastKey = stateKey(state);
    const result = resultValue(ui.dlg.runModal());
    // The dialog is gone again, so this is the only safe moment left to report a
    // failure that happened before or during it.
    raisePendingError();
    const isOk = result === DialogResult.Ok.value || result === DialogResult.Ok;
    if (isOk) {
        // Drop any in-flight slider commit; the flush below supersedes it.
        cancelPendingSlider();
        const final = ui.getState();
        if (stateKey(final) !== lastKey) commit(final);
    } else {
        // Cancel: drop any pending commit, then restore the pre-preview state.
        cancelPendingSlider();
        // Revert with ONE neutralising pass and NO history rewind. The seek was
        // tried first for a long time and it is the reason Cancel was slow: rolling
        // back N preview compounds re-renders the document N times, and each
        // compound holds up to four commands per object (transform + opacity +
        // colour + stroke). `agents.md` already flagged the seek's real-world cost
        // as unverified, and it turns out to be the dominant one.
        //
        // Switching every channel off makes applyPass emit exactly the inverses —
        // the geometry net is inverted and the appearance baselines are written back
        // — so the work is bounded by one pass instead of one pass per preview step.
        // The trade-off: the preview steps stay in the undo stack, so Ctrl+Z walks
        // back through them. That is visible only if the user presses it.
        const neutral = { centre: state.centre, anchor: state.anchor, strength: 0, curve: state.curve, gamma: state.gamma, invert: false, on: {} };
        for (const channel of CHANNELS) neutral.on[channel.key] = false;
        try {
            applyPass(targetOrigin(neutral), neutral);
        } catch (e) {
            // Do not silently leave a half-reverted document behind.
            showError(TITLE + ': the preview could not be reverted automatically.\n\n' +
                describeError(e) + '\n\nPress Ctrl+Z until the objects are back to how they were before the run.');
        }
    }
    } catch (err) {
        // Never fail silently: a throw before runModal() would otherwise look
        // exactly like "the script does nothing at all".
        showError(TITLE + ' stopped before finishing:\n\n' + describeError(err));
    }
})();
