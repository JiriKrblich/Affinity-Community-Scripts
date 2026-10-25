// =====================================================================
// Objekte Transformieren / Transform Objects  — v8
// Transforms the objects of a group (or several selected objects) in sequence.
// Values run from the first to the last object (start → end) for width, height, size,
// rotation, offset X/Y, radial offset, opacity and HSL; plus jitter (uniform or Gaussian,
// increasing/decreasing along the sequence). Reference point: anchor per object or _PD.
// v3: order along a _PD path (guide), multiple _PD points as attractors,
//     alignment to the path tangent, own (local) rotation incl. jitter.
// v4: sequence pattern (process/skip with increase per round, e.g. 3+1,2+0) with pattern display;
//     offset and from/to also apply to the sequence pattern.
// v5: progression optionally runs over the sub-sequences (rounds) instead of the objects: all objects
//     of a sub-sequence receive the same transformation; optionally the same jitter per sub-sequence.
// v6: counting and progression direction decoupled (selection "Counting starts").
// v7: default again as in v5: with "Reverse" counting starts at the other end ("Counting starts":
//     Automatic / Always at the start / Always at the end); new: restart the selection in each
//     row/column/ring (the pattern starts anew in every row or column, even with rows of unequal length)
//     + display of the group sizes.
// v8: GUI organised into 6 tabs (pages): on the left a permanent column with tab selection, preview and
//     presets; on the right two columns per page. Functions unchanged from v7.
// =====================================================================
'use strict';
const LANG = 'en';   // 'de' | 'en'

const { Document } = require('/document');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
const { Selection } = require('/selections');
const { Transform } = require('/geometry');
const { Dialog, DialogResult } = require('/dialog');
const { UnitType } = require('/units');
const { SpatialAnchor, NodeMoveType } = require('affinity:dom');
const { app } = require('/application');
const { File, FileSystemApi } = require('/fs');
const { Colour } = require('/colours');
const { SolidFill } = require('/fills');
const { LineStyleMask } = require('/linestyle');

const MOVE_BEFORE = (NodeMoveType && NodeMoveType.Before !== undefined) ? NodeMoveType.Before : 0;
const MOVE_AFTER  = (NodeMoveType && NodeMoveType.After  !== undefined) ? NodeMoveType.After  : 1;

// ---------------------------------------------------------------- Texts
const TXT = {
  de: {
    title: 'Objekte Transformieren',
    noDoc: 'Kein Dokument geöffnet.',
    noSel: 'Bitte eine Gruppe oder mehrere Objekte auswählen.',
    tooFew: 'Es werden mindestens 2 Objekte benötigt (Gruppe mit Kindern oder Mehrfachauswahl).',
    grpOrder: 'Reihenfolge',
    order: 'Reihenfolge',
    orders: ['Ebenenreihenfolge (oben → unten)', 'Leserichtung (Zeilen)', 'Zickzack (Zeilen abwechselnd)',
             'Spaltenweise (oben → unten)', 'Links → Rechts', 'Oben → Unten',
             'Diagonale ↘ (oben links → unten rechts)', 'Diagonale ↗ (unten links → oben rechts)',
             'Explosion (Zentrum → außen)', 'Winkel-Umlauf (im Uhrzeigersinn)', 'Spirale (von innen)',
             'Größe (klein → groß)', 'Helligkeit (dunkel → hell)', 'Farbton (0° → 360°)', 'Zufall (Seed)',
             'Entlang _PD-Pfad (Leitlinie)', 'Attraktoren (Abstand zum nächsten _PD)'],
    reverse: 'Umkehren',
    startAngle: 'Startwinkel (Umlauf/Spirale)',
    windings: 'Windungen (Spirale)',
    distrib: 'Verteilung',
    distribs: ['Nach Rang (gleichmäßig)', 'Nach Position / Wert'],
    grpSubset: 'Auswahl in der Reihe',
    seqMode: 'Auswahlmodus',
    seqModes: ['Jedes n-te Objekt', 'Sequenzfolge (bearbeiten / auslassen)'],
    nth: 'Jedes n-te Objekt',
    seqRun: 'Folge: bearbeiten (Anzahl)',
    seqRunInc: 'Zuwachs je Runde (bearbeiten)',
    seqSkip: 'Folge: auslassen (Anzahl)',
    seqSkipInc: 'Zuwachs je Runde (auslassen)',
    seqProg: 'Verlauf läuft über',
    seqProgs: ['Alle bearbeiteten Objekte', 'Teilfolgen (ein Wert je Runde)'],
    seqJitRound: 'Jitter je Teilfolge gleich',
    seqNote: (pat, n) => 'Muster: ' + pat + '  ·  ' + n + ' Teilfolgen',
    countMode: 'Zählung beginnt',
    countModes: ['Automatisch (bei Umkehren am Ende)', 'Immer am Anfang der Reihe', 'Immer am Ende der Reihe'],
    seqPerGroup: 'Auswahl je Zeile/Spalte neu beginnen',
    grpNote: (sizes) => sizes.length > 1 ? 'Gruppen (Zeile/Spalte/Ring): ' + sizes.length + '  ·  Größen: ' + sizes.slice(0, 14).join(',') + (sizes.length > 14 ? ' …' : '') : 'Gruppen: keine (diese Reihenfolge hat keine Zeilen/Spalten)',
    nthOff: 'Versatz (Start der Auswahl)',
    from: 'Von Objekt Nr.',
    to: 'Bis Objekt Nr. (0 = Ende)',
    grpStruct: 'Struktur',
    flatten: 'Verschachtelte Gruppen auflösen',
    stack: 'Stapelreihenfolge',
    stacks: ['Unverändert', 'Neu stapeln: erstes Objekt oben', 'Neu stapeln: erstes Objekt unten'],
    grpCurve: 'Verlauf',
    shape: 'Verlaufsform',
    shapes: ['Anfang → Ende', 'Ping-Pong (Anfang → Ende → Anfang)', 'Welle (Sinus)'],
    freq: 'Wellen (Anzahl)',
    phase: 'Phase',
    ease: 'Easing',
    eases: ['Linear', 'Ease-In', 'Ease-Out', 'Ease-In-Out'],
    steps: 'Stufen (0 = stufenlos)',
    cycle: 'Zyklus alle n Objekte (0 = aus)',
    grpRef: 'Referenzpunkt',
    refMode: 'Bezug',
    refModes: ['Ankerpunkt je Objekt', '_PD-Punkt (nächster)'],
    anchor: 'Ankerpunkt',
    objAxes: 'Breite/Höhe entlang Objektachsen',
    grpTrans: 'Transformation  (Anfang → Ende)',
    wS: 'Breite Anfang', wE: 'Breite Ende',
    hS: 'Höhe Anfang', hE: 'Höhe Ende',
    sS: 'Größe Anfang', sE: 'Größe Ende',
    sizeMode: 'Größenbezug',
    sizeModes: ['Relativ (zur aktuellen Größe)', 'Absolut (zur Durchschnittsgröße)'],
    rS: 'Drehung Anfang', rE: 'Drehung Ende',
    rotMode: 'Drehbezug',
    rotModes: ['Relativ (zur aktuellen Drehung)', 'Absolut (0° = aufrecht)', 'Zum Zentrum ausrichten (Oberseite außen)',
               'Am _PD-Pfad ausrichten (Tangente)'],
    lrS: 'Eigendrehung Anfang', lrE: 'Eigendrehung Ende',
    grpMove: 'Versatz  (Anfang → Ende)',
    xS: 'Versatz X Anfang', xE: 'Versatz X Ende',
    yS: 'Versatz Y Anfang', yE: 'Versatz Y Ende',
    radS: 'Radial Anfang', radE: 'Radial Ende',
    stroke: 'Konturbreite',
    strokes: ['Objekteinstellung', 'Mitskalieren', 'Konstant halten'],
    grpCol: 'Deckkraft & Farbe  (Anfang → Ende)',
    oS: 'Deckkraft Anfang', oE: 'Deckkraft Ende',
    hueS: 'Farbton Anfang', hueE: 'Farbton Ende',
    satS: 'Sättigung Anfang', satE: 'Sättigung Ende',
    litS: 'Helligkeit Anfang', litE: 'Helligkeit Ende',
    colFill: 'HSL auf Füllung', colStroke: 'HSL auf Kontur',
    colNote: 'Deckkraft: Faktor (100 % = unverändert). HSL: Verschiebung.',
    grpJit: 'Jitter (±)',
    jW: 'Breite', jH: 'Höhe', jS: 'Größe', jR: 'Drehung', jLR: 'Eigendrehung', jX: 'Position X', jY: 'Position Y',
    jPosUnit: 'Position in',
    jPosUnits: ['Pixel', '% der Objektgröße'],
    jO: 'Deckkraft', jHue: 'Farbton', jSat: 'Sättigung', jLit: 'Helligkeit',
    jfS: 'Jitter-Stärke Anfang', jfE: 'Jitter-Stärke Ende',
    jDist: 'Jitter-Verteilung',
    jDists: ['Gleichverteilt', 'Gauß (normalverteilt)'],
    seed: 'Seed', newSeed: 'Neuer Seed',
    grpPrev: 'Vorschau',
    live: 'Live-Vorschau',
    preview: 'Vorschau aktualisieren',
    grpPreset: 'Presets',
    pSave: 'Speichern', pLoad: 'Laden', pDel: 'Löschen',
    grpNav: 'Register',
    pages: ['1  Reihenfolge', '2  Auswahl', '3  Verlauf & Bezug', '4  Transformation', '5  Deckkraft & Farbe', '6  Jitter'],
    grpSelect: 'Auswahl', grpSeqProg: 'Teilfolgen', grpCount: 'Zählung & Bereich',
    grpOpac: 'Deckkraft', grpHsl: 'HSL-Verschiebung',
    grpJitGeo: 'Jitter: Form & Position', grpJitCol: 'Jitter: Deckkraft, Farbe & Verlauf',
    info: (n, k, path) => n + ' Objekte  ·  _PD-Punkte: ' + k + '  ·  _PD-Pfad: ' + (path ? 'ja' : 'nein'),
    pName: 'Presetname eingeben (Präfix OT_ wird ergänzt):',
    pSaveT: 'Preset speichern', pSaved: 'Preset gespeichert:\n', pDeleted: 'Preset gelöscht:\n',
    pErrS: 'Fehler beim Speichern:\n', pErrL: 'Fehler beim Laden:\n', pErrD: 'Fehler beim Löschen:\n',
    pOnlyJson: 'Nur .json-Presetdateien können gelöscht werden.', pUnread: 'Datei nicht lesbar.',
    errApply: 'Fehler beim Transformieren:\n'
  },
  en: {
    title: 'Transform Objects',
    noDoc: 'No document open.',
    noSel: 'Please select a group or several objects.',
    tooFew: 'At least 2 objects are required (group with children or multi-selection).',
    grpOrder: 'Order',
    order: 'Order',
    orders: ['Layer order (top → bottom)', 'Reading direction (rows)', 'Zigzag (alternating rows)',
             'Column-wise (top → bottom)', 'Left → Right', 'Top → Bottom',
             'Diagonal ↘ (top left → bottom right)', 'Diagonal ↗ (bottom left → top right)',
             'Explosion (centre → outward)', 'Angular sweep (clockwise)', 'Spiral (from inside)',
             'Size (small → large)', 'Lightness (dark → light)', 'Hue (0° → 360°)', 'Random (seed)',
             'Along _PD path (guide)', 'Attractors (distance to nearest _PD)'],
    reverse: 'Reverse',
    startAngle: 'Start angle (sweep/spiral)',
    windings: 'Windings (spiral)',
    distrib: 'Distribution',
    distribs: ['By rank (even)', 'By position / value'],
    grpSubset: 'Selection within the sequence',
    seqMode: 'Selection mode',
    seqModes: ['Every n-th object', 'Sequence pattern (process / skip)'],
    nth: 'Every n-th object',
    seqRun: 'Pattern: process (count)',
    seqRunInc: 'Increase per round (process)',
    seqSkip: 'Pattern: skip (count)',
    seqSkipInc: 'Increase per round (skip)',
    seqProg: 'Progression runs over',
    seqProgs: ['All processed objects', 'Sub-sequences (one value per round)'],
    seqJitRound: 'Same jitter within a sub-sequence',
    seqNote: (pat, n) => 'Pattern: ' + pat + '  ·  ' + n + ' sub-sequences',
    countMode: 'Counting starts',
    countModes: ['Automatic (at the end when reversed)', 'Always at the start of the sequence', 'Always at the end of the sequence'],
    seqPerGroup: 'Restart selection in each row/column',
    grpNote: (sizes) => sizes.length > 1 ? 'Groups (row/column/ring): ' + sizes.length + '  ·  Sizes: ' + sizes.slice(0, 14).join(',') + (sizes.length > 14 ? ' …' : '') : 'Groups: none (this order has no rows/columns)',
    nthOff: 'Offset (start of selection)',
    from: 'From object no.',
    to: 'To object no. (0 = end)',
    grpStruct: 'Structure',
    flatten: 'Dissolve nested groups',
    stack: 'Stacking order',
    stacks: ['Unchanged', 'Restack: first object on top', 'Restack: first object at bottom'],
    grpCurve: 'Progression',
    shape: 'Shape',
    shapes: ['Start → End', 'Ping-pong (Start → End → Start)', 'Wave (sine)'],
    freq: 'Waves (count)',
    phase: 'Phase',
    ease: 'Easing',
    eases: ['Linear', 'Ease-In', 'Ease-Out', 'Ease-In-Out'],
    steps: 'Steps (0 = continuous)',
    cycle: 'Cycle every n objects (0 = off)',
    grpRef: 'Reference point',
    refMode: 'Reference',
    refModes: ['Anchor per object', '_PD point (nearest)'],
    anchor: 'Anchor',
    objAxes: 'Width/height along object axes',
    grpTrans: 'Transformation  (start → end)',
    wS: 'Width start', wE: 'Width end',
    hS: 'Height start', hE: 'Height end',
    sS: 'Size start', sE: 'Size end',
    sizeMode: 'Size reference',
    sizeModes: ['Relative (to current size)', 'Absolute (to average size)'],
    rS: 'Rotation start', rE: 'Rotation end',
    rotMode: 'Rotation reference',
    rotModes: ['Relative (to current rotation)', 'Absolute (0° = upright)', 'Align to centre (top faces outward)',
               'Align to _PD path (tangent)'],
    lrS: 'Own rotation start', lrE: 'Own rotation end',
    grpMove: 'Offset  (start → end)',
    xS: 'Offset X start', xE: 'Offset X end',
    yS: 'Offset Y start', yE: 'Offset Y end',
    radS: 'Radial start', radE: 'Radial end',
    stroke: 'Stroke width',
    strokes: ['Object setting', 'Scale with object', 'Keep constant'],
    grpCol: 'Opacity & colour  (start → end)',
    oS: 'Opacity start', oE: 'Opacity end',
    hueS: 'Hue start', hueE: 'Hue end',
    satS: 'Saturation start', satE: 'Saturation end',
    litS: 'Lightness start', litE: 'Lightness end',
    colFill: 'HSL on fill', colStroke: 'HSL on stroke',
    colNote: 'Opacity: factor (100 % = unchanged). HSL: shift.',
    grpJit: 'Jitter (±)',
    jW: 'Width', jH: 'Height', jS: 'Size', jR: 'Rotation', jLR: 'Own rotation', jX: 'Position X', jY: 'Position Y',
    jPosUnit: 'Position in',
    jPosUnits: ['Pixels', '% of object size'],
    jO: 'Opacity', jHue: 'Hue', jSat: 'Saturation', jLit: 'Lightness',
    jfS: 'Jitter strength start', jfE: 'Jitter strength end',
    jDist: 'Jitter distribution',
    jDists: ['Uniform', 'Gaussian (normal)'],
    seed: 'Seed', newSeed: 'New seed',
    grpPrev: 'Preview',
    live: 'Live preview',
    preview: 'Update preview',
    grpPreset: 'Presets',
    pSave: 'Save', pLoad: 'Load', pDel: 'Delete',
    grpNav: 'Tabs',
    pages: ['1  Order', '2  Selection', '3  Progression & reference', '4  Transformation', '5  Opacity & colour', '6  Jitter'],
    grpSelect: 'Selection', grpSeqProg: 'Sub-sequences', grpCount: 'Counting & range',
    grpOpac: 'Opacity', grpHsl: 'HSL shift',
    grpJitGeo: 'Jitter: shape & position', grpJitCol: 'Jitter: opacity, colour & progression',
    info: (n, k, path) => n + ' objects  ·  _PD points: ' + k + '  ·  _PD path: ' + (path ? 'yes' : 'no'),
    pName: 'Enter preset name (prefix OT_ is added):',
    pSaveT: 'Save preset', pSaved: 'Preset saved:\n', pDeleted: 'Preset deleted:\n',
    pErrS: 'Error while saving:\n', pErrL: 'Error while loading:\n', pErrD: 'Error while deleting:\n',
    pOnlyJson: 'Only .json preset files can be deleted.', pUnread: 'File not readable.',
    errApply: 'Error while transforming:\n'
  }
}[LANG];

// ---------------------------------------------------------------- Defaults
const DEF = {
  order: 0, reverse: false, startAngle: 0, windings: 3, distrib: 0,
  nth: 1, nthOff: 0, from: 1, to: 0,
  seqMode: 0, seqRun: 3, seqRunInc: 1, seqSkip: 2, seqSkipInc: 0, seqProg: 0, seqJitRound: false, countMode: 0, seqPerGroup: false,
  flatten: false, stack: 0,
  shape: 0, freq: 1, phase: 0, ease: 0, steps: 0, cycle: 0,
  refMode: 0, anchor: 5, objAxes: true,
  wS: 100, wE: 100, hS: 100, hE: 100, sS: 100, sE: 50, sizeMode: 0,
  rS: 0, rE: 90, rotMode: 0, lrS: 0, lrE: 0,
  xS: 0, xE: 0, yS: 0, yE: 0, radS: 0, radE: 0, stroke: 0,
  oS: 100, oE: 100, hueS: 0, hueE: 0, satS: 0, satE: 0, litS: 0, litE: 0, colFill: true, colStroke: false,
  jW: 0, jH: 0, jS: 0, jR: 0, jLR: 0, jX: 0, jY: 0, jPosUnit: 0, jO: 0, jHue: 0, jSat: 0, jLit: 0,
  jfS: 100, jfE: 100, jDist: 0,
  seed: 1234, live: true
};

// ---------------------------------------------------------------- Document / selection
const doc = Document.current;
if (!doc) { app.alert(TXT.noDoc, TXT.title); throw new Error('no doc'); }
const selNodes = doc.selection ? doc.selection.nodes.toArray() : [];
if (selNodes.length === 0) { app.alert(TXT.noSel, TXT.title); throw new Error('no selection'); }
const origSelNodes = selNodes.slice();
function restoreSelCmd() { return DocumentCommand.createSetSelection(Selection.create(doc, origSelNodes)); }
function selectionChanged() {
  try {
    const cur = doc.selection.nodes.toArray();
    if (cur.length !== origSelNodes.length) return true;
    for (let i = 0; i < cur.length; i++) if (!cur[i].isSameNode(origSelNodes[i])) return true;
    return false;
  } catch (e) { return true; }
}
function restoreSelection() {
  if (selectionChanged()) { try { doc.executeCommand(restoreSelCmd()); } catch (e) {} }
}

function nodeName(n) { try { return (n.userDescription || n.defaultDescription || '') + ''; } catch (e) { return ''; } }
function isPD(n) { return nodeName(n).trim().toLowerCase() === '_pd'; }
function kids(n) { try { return n.children ? n.children.toArray() : []; } catch (e) { return []; } }
function tag(n) { try { return n[Symbol.toStringTag] || n.constructor.name || ''; } catch (e) { return ''; } }
function isGroupLike(n) { const t = tag(n); return (t === 'GroupNode' || t === 'ContainerNode') && kids(n).length > 0; }
function isText(n) { const t = tag(n); return t === 'ArtTextNode' || t === 'FrameTextNode'; }
function leaves(n) {
  if (isGroupLike(n)) { const r = []; for (const c of kids(n)) r.push(...leaves(c)); return r; }
  return [n];
}

// ---------------------------------------------------------------- Geometry helpers
function isSpreadLike(n) { const t = tag(n); return t === 'SpreadNode' || t === 'DocumentNode'; }
function composedSpreadTF(node) {
  let M = node.transform.clone();
  let p = node.parent;
  while (p && !isSpreadLike(p)) {
    try { if (p.transform) M = p.transform.multiply(M); } catch (e) {}
    p = p.parent;
  }
  return M;
}
function spreadBox(n) { try { return n.getSpreadBaseBox(false); } catch (e) { return null; } }
const ANCHOR_REL = { 1: [0, 0], 2: [0, 0.5], 3: [0, 1], 4: [0.5, 0], 5: [0.5, 0.5], 6: [0.5, 1], 7: [1, 0], 8: [1, 0.5], 9: [1, 1] };

// ---------------------------------------------------------------- Colour helpers
function readBrushFD(n) {
  try { if (isText(n)) return n.storyInterface.story.getGlyphAtts(0).brushFill; } catch (e) { return null; }
  try { return n.hasBrushFill ? n.brushFillDescriptor : null; } catch (e) { return null; }
}
function readPenFD(n) {
  try { if (isText(n)) return n.storyInterface.story.getGlyphAtts(0).penFill; } catch (e) { return null; }
  try { return n.hasPenFill ? n.penFillDescriptor : null; } catch (e) { return null; }
}
function fdType(fd) { try { return fd.fillType.value; } catch (e) { return -1; } }   // 2 = Solid, 3 = Gradient
function fdColours(fd) {
  const t = fdType(fd), out = [];
  try {
    if (t === 2) out.push(fd.fill.colour);
    else if (t === 3) { const g = fd.fill.gradient; for (let i = 0; i < g.stopCount; i++) out.push(new Colour(g.getStop(i).colour)); }
  } catch (e) {}
  return out;
}
const clamp01 = v => Math.min(1, Math.max(0, v));
function shiftColour(c, dH, dS, dL) {
  const h = c.hslaf;
  let hh = (h.h + dH / 360) % 1; if (hh < 0) hh += 1;
  return Colour.createHSLAf({ h: hh, s: clamp01(h.s + dS / 100), l: clamp01(h.l + dL / 100), alpha: h.alpha });
}
function shiftFD(fd, dH, dS, dL) {
  const t = fdType(fd);
  try {
    if (t === 2) return fd.cloneWithNewFill(SolidFill.create(shiftColour(fd.fill.colour, dH, dS, dL)));
    if (t === 3) {
      const g = fd.fill.gradient, ns = [];
      for (let i = 0; i < g.stopCount; i++) {
        const s = g.getStop(i);
        ns.push({ colour: shiftColour(new Colour(s.colour), dH, dS, dL), position: s.position, midpoint: s.midpoint, smoothness: s.smoothness });
      }
      return fd.cloneWithNewFill(fd.fill.cloneWithNewGradient(g.constructor.create(ns)));
    }
  } catch (e) { console.log('HSL: ' + e); }
  return null;
}
// representative colour of an object (for sorting): {l, h, s}
function repColour(n) {
  for (const lf of leaves(n)) {
    const cols = fdColours(readBrushFD(lf));
    if (!cols.length) continue;
    let l = 0, sx = 0, sy = 0, s = 0;
    for (const c of cols) { const h = c.hslaf; l += h.l; s += h.s; sx += Math.cos(h.h * 2 * Math.PI) * h.s; sy += Math.sin(h.h * 2 * Math.PI) * h.s; }
    let hue = Math.atan2(sy, sx) / (2 * Math.PI); if (hue < 0) hue += 1;
    return { l: l / cols.length, h: hue, s: s / cols.length };
  }
  return { l: 0.5, h: 0, s: 0 };
}

// ---------------------------------------------------------------- Collect objects
let info = [], N = 0, pdNodes = [], pdPoints = [], pdPoint = null, pathData = null;
let gx0, gy0, gx1, gy1, GW, GH, groupCentre, refW = 1, refH = 1;

function addPD(n) { for (const q of pdNodes) if (q.isSameNode(n)) return; pdNodes.push(n); }
function collect(flatten) {
  pdNodes = [];
  let objs = [];
  for (const n of selNodes) { if (isPD(n)) addPD(n); else objs.push(n); }
  if (objs.length === 1 && isGroupLike(objs[0])) objs = kids(objs[0]);
  if (flatten) { const f = []; for (const n of objs) f.push(...(isPD(n) ? [n] : leaves(n))); objs = f; }
  const tmp = [];
  for (const n of objs) { if (isPD(n)) addPD(n); else tmp.push(n); }
  return tmp;
}

// _PD path: a drawn curve (PolyCurveNode) named _PD; all other _PD objects are points
function isPathNode(n) {
  if (tag(n) !== 'PolyCurveNode') return false;
  try { const pc = n.curvesInterface.polyCurve; let pts = 0; for (let i = 0; i < pc.curveCount; i++) pts += pc.at(i).nodeCount; return pts >= 2; } catch (e) { return false; }
}
// densely sample the path (spread coordinates) → segments with cumulative arc length
function samplePath(node) {
  const F = composedSpreadTF(node);
  const pc = node.curvesInterface.polyCurve;
  const curves = [];
  let total = 0;
  for (let ci = 0; ci < pc.curveCount; ci++) {
    let bz = []; try { const c = pc.at(ci); if (c.isEmpty || c.pointCount === 0) continue; bz = c.beziers.toArray(); } catch (e) { continue; }
    let L = 0; for (const b of bz) L += b.length;
    curves.push({ bz, L }); total += L;
  }
  if (total <= 0) return null;
  const pts = [];   // {x, y, s, brk}  brk = start of a new sub-curve
  let s = 0;
  for (const cv of curves) {
    let first = true;
    for (const b of cv.bz) {
      const nS = Math.max(4, Math.round(3000 * b.length / total));
      for (let i = (first ? 0 : 1); i <= nS; i++) {
        const lp = b.evaluate(i / nS), sp = F.applyToPoint(lp);
        if (pts.length && !first) s += Math.hypot(sp.x - pts[pts.length - 1].x, sp.y - pts[pts.length - 1].y);
        pts.push({ x: sp.x, y: sp.y, s, brk: first });
        first = false;
      }
    }
  }
  return { pts, len: Math.max(s, 1e-9) };
}
// project a point onto the path → {u: 0..1 arc length, d: distance, ang: tangent angle}
function projectOnPath(px, py) {
  const P = pathData.pts;
  let best = { d: Infinity, u: 0, ang: 0 };
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1], b = P[i];
    if (b.brk) continue;
    const vx = b.x - a.x, vy = b.y - a.y, L2 = vx * vx + vy * vy;
    let t = L2 > 0 ? ((px - a.x) * vx + (py - a.y) * vy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = a.x + vx * t, qy = a.y + vy * t, d = Math.hypot(px - qx, py - qy);
    if (d < best.d) best = { d, u: (a.s + (b.s - a.s) * t) / pathData.len, ang: Math.atan2(vy, vx) };
  }
  return best;
}
function nearestPD(x, y) {
  let best = null, bd = Infinity;
  for (const q of pdPoints) { const d = Math.hypot(x - q.x, y - q.y); if (d < bd) { bd = d; best = q; } }
  return best;
}

function buildInfo(flatten) {
  const objs = collect(flatten);
  info = objs.map((n, idx) => {
    const sb = spreadBox(n) || { x: 0, y: 0, width: 0, height: 0 };
    let F = null, lb = null, fp = null;
    try { F = composedSpreadTF(n); } catch (e) { F = null; }
    try { lb = n.baseBoxInterface ? n.baseBoxInterface.getBaseBox(false) : null; } catch (e) { lb = null; }
    try { const f = n.transformInterface.focalPoint; if (f && f.isValid && F) fp = F.applyToPoint(f.point); } catch (e) { fp = null; }
    let ax = 1, ay = 1, phi = 0;
    if (F) { const d = F.data; ax = Math.hypot(d[0], d[3]); ay = Math.hypot(d[1], d[4]); phi = Math.atan2(d[3], d[0]); }
    const wLoc = (lb && lb.width > 0) ? lb.width * ax : sb.width;
    const hLoc = (lb && lb.height > 0) ? lb.height * ay : sb.height;
    let opacity = 1; try { const o = n.globalOpacity; if (typeof o === 'number' && isFinite(o)) opacity = o; } catch (e) {}
    const lv = leaves(n).map(l => {
      let lsd = null; try { lsd = l.hasPenFill ? l.lineStyleDescriptor : null; } catch (e) { lsd = null; }
      return { node: l, text: isText(l), brush: readBrushFD(l), pen: readPenFD(l), lsd };
    });
    return { node: n, idx, sb, cx: sb.x + sb.width / 2, cy: sb.y + sb.height / 2, F, lb, fp, phi, wLoc, hLoc,
             opacity, leaves: lv, area: Math.abs(wLoc * hLoc), col: null };
  });
  N = info.length;
  gx0 = Infinity; gy0 = Infinity; gx1 = -Infinity; gy1 = -Infinity;
  for (const o of info) {
    gx0 = Math.min(gx0, o.sb.x); gy0 = Math.min(gy0, o.sb.y);
    gx1 = Math.max(gx1, o.sb.x + o.sb.width); gy1 = Math.max(gy1, o.sb.y + o.sb.height);
  }
  GW = Math.max(gx1 - gx0, 1e-6); GH = Math.max(gy1 - gy0, 1e-6);
  groupCentre = { x: (gx0 + gx1) / 2, y: (gy0 + gy1) / 2 };
  pdPoints = []; pathData = null;
  for (const n of pdNodes) {
    if (!pathData && isPathNode(n)) { try { pathData = samplePath(n); } catch (e) { pathData = null; } if (pathData) continue; }
    const b = spreadBox(n); if (b) pdPoints.push({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
  }
  pdPoint = pdPoints.length ? pdPoints[0] : null;
  for (const o of info) {
    o.near = nearestPD(o.cx, o.cy) || groupCentre;
    o.proj = pathData ? projectOnPath(o.cx, o.cy) : null;
  }
  refW = info.reduce((a, o) => a + o.wLoc, 0) / Math.max(N, 1);
  refH = info.reduce((a, o) => a + o.hLoc, 0) / Math.max(N, 1);
  for (const o of info) { try { o.stack = stackPath(o.node); } catch (e) { o.stack = [o.idx]; } }
}

function stackPath(n) {
  const path = [];
  let c = n, p = n.parent;
  while (p && !isSpreadLike(p)) {
    const sib = kids(p); let i = 0;
    for (; i < sib.length; i++) if (sib[i].isSameNode(c)) break;
    path.unshift(i);
    c = p; p = p.parent;
  }
  if (p) { const sib = kids(p); let i = 0; for (; i < sib.length; i++) if (sib[i].isSameNode(c)) break; path.unshift(i); }
  return path;
}
function cmpPath(a, b) {
  const L = Math.min(a.length, b.length);
  for (let i = 0; i < L; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

// ---------------------------------------------------------------- Random
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- Order
function median(arr) { const a = arr.slice().sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; }
const TAU = 2 * Math.PI;

function rankAll(p) {
  const nx = o => (o.cx - gx0) / GW, ny = o => (o.cy - gy0) / GH;
  const ctr = pdPoint || groupCentre;
  const medW = median(info.map(o => o.sb.width)), medH = median(info.map(o => o.sb.height));
  let ranked, key = null, groups = null;
  const byKey = (k, k2, tol) => {
    const s = info.slice().sort((a, b) => (k(a) - k(b)) || (a.idx - b.idx));
    const out = []; let grp = null, ref = 0;
    for (const o of s) { if (!grp || k(o) - ref > tol) { grp = []; out.push(grp); ref = k(o); } grp.push(o); }
    const res = [];
    for (const g of out) { g.sort((a, b) => (k2(a) - k2(b)) || (a.idx - b.idx)); res.push(...g); }
    groups = out;
    return res;
  };
  const rows = () => {
    const tol = Math.max(medH * 0.5, 1e-6);
    const s = info.slice().sort((a, b) => a.cy - b.cy);
    const rs = []; let row = null, ref = 0;
    for (const o of s) { if (!row || o.cy - ref > tol) { row = []; rs.push(row); ref = o.cy; } row.push(o); }
    for (const r of rs) r.sort((a, b) => a.cx - b.cx);
    return rs;
  };
  // clockwise angle from start angle (0° = 12 o'clock), normalised 0..1
  const ang01 = o => {
    let a = Math.atan2(o.cy - ctr.y, o.cx - ctr.x) + Math.PI / 2 - p.startAngle * Math.PI / 180;
    a = ((a % TAU) + TAU) % TAU;
    return a / TAU;
  };
  const dist = o => Math.hypot(o.cx - ctr.x, o.cy - ctr.y);

  switch (p.order) {
    case 0: ranked = info.slice().sort((a, b) => cmpPath(b.stack, a.stack)); break;
    case 1: { const rs = rows(); ranked = [].concat(...rs); groups = rs; break; }
    case 2: { const rs = rows().map((r, i) => (i % 2 ? r.slice().reverse() : r)); ranked = [].concat(...rs); groups = rs; break; }
    case 3: {
      const tol = Math.max(medW * 0.5, 1e-6);
      const s = info.slice().sort((a, b) => a.cx - b.cx);
      const cols = []; let col = null, ref = 0;
      for (const o of s) { if (!col || o.cx - ref > tol) { col = []; cols.push(col); ref = o.cx; } col.push(o); }
      ranked = [];
      for (const c of cols) { c.sort((a, b) => a.cy - b.cy); ranked.push(...c); }
      groups = cols;
      break;
    }
    case 4: key = nx; ranked = byKey(nx, ny, 0.5 * medW / GW); break;
    case 5: key = ny; ranked = byKey(ny, nx, 0.5 * medH / GH); break;
    case 6: key = o => (nx(o) + ny(o)) / 2; ranked = byKey(key, nx, 0.25 * (medW / GW + medH / GH)); break;
    case 7: key = o => (nx(o) + 1 - ny(o)) / 2; ranked = byKey(key, nx, 0.25 * (medW / GW + medH / GH)); break;
    case 8: key = dist; ranked = byKey(key, ang01, 0.25 * (medW + medH)); break;
    case 9: key = ang01; ranked = byKey(key, dist, 1e-4); break;
    case 10: {
      let rmax = 0; for (const o of info) rmax = Math.max(rmax, dist(o));
      const W = Math.max(p.windings, 0.01);
      key = o => { const a = ang01(o), r = rmax > 0 ? dist(o) / rmax : 0; const k = Math.round(r * W - a); return Math.max(k, 0) + a; };
      ranked = byKey(key, dist, 1e-6);
      break;
    }
    case 11: key = o => o.area; ranked = byKey(key, ny, 0); break;
    case 12: for (const o of info) if (!o.col) o.col = repColour(o.node);
             key = o => o.col.l; ranked = byKey(key, ny, 0); break;
    case 13: for (const o of info) if (!o.col) o.col = repColour(o.node);
             key = o => o.col.h; ranked = byKey(key, o => o.col.l, 0); break;
    case 15:
      if (pathData) { key = o => o.proj.u; ranked = byKey(key, o => o.proj.d, 1e-6); break; }
      key = nx; ranked = byKey(nx, ny, 0.5 * medW / GW); break;            // no path: left → right
    case 16: key = o => Math.hypot(o.cx - o.near.x, o.cy - o.near.y);
      ranked = byKey(key, ang01, 0.25 * (medW + medH)); break;
    case 14: default: {
      const rnd = mulberry32((p.seed | 0) ^ 0x9E3779B9);
      ranked = info.slice();
      for (let i = ranked.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = ranked[i]; ranked[i] = ranked[j]; ranked[j] = t; }
    }
  }
  // orders without meaningful rows/columns: no groups
  if (p.order === 0 || p.order === 9 || p.order === 10 || p.order === 11 || p.order === 12 || p.order === 13 || p.order === 14 || p.order === 15 || p.order > 16) groups = null;
  if (!groups || !groups.length) groups = [ranked];
  return { ranked, key, groups };   // always in forward direction; "Reverse" and counting direction are handled in computeSequence
}

// returns the ordered subset + t0 (0..1) per object
function computeSequence(p) {
  const { ranked: fwd, key, groups: fg } = rankAll(p);
  const n = fwd.length;
  // direction of the progression (and restacking): forward or, with "Reverse", backward
  const progOrder = p.reverse ? fwd.slice().reverse() : fwd;
  // direction of counting: 0 = automatic (at the end when reversed), 1 = always at the start, 2 = always at the end
  const cm = Math.round(p.countMode) | 0;
  const countEnd = cm === 2 || (cm === 0 && !!p.reverse);
  const baseGroups = countEnd ? fg.slice().reverse().map(g => g.slice().reverse()) : fg;
  const base = [].concat(...baseGroups);
  const from = Math.max(1, Math.round(p.from)) - 1;
  const to = (Math.round(p.to) > 0) ? Math.min(n, Math.round(p.to)) : n;
  const nth = Math.max(1, Math.round(p.nth)), off = Math.max(0, Math.round(p.nthOff));
  // segments in which counting restarts: per row/column/ring or the whole sequence
  const perGroup = !!p.seqPerGroup && baseGroups.length > 1;
  const segments = [];
  if (perGroup) {
    let pos = 0;
    for (const g of baseGroups) { const seg = []; for (const o of g) { if (pos >= from && pos < to) seg.push(o); pos++; } segments.push(seg); }
  } else segments.push(base.slice(from, Math.max(from, to)));
  const subset = [];
  const roundOf = new Map();   // object idx → number of its sub-sequence (sequence pattern only, continuous across all segments)
  let rounds = 0;
  for (const seg of segments) {
    if (!seg.length) continue;
    if (p.seqMode === 1) {
      // sequence pattern: round 1 = process `run`, skip `skip`; then run += dRun, skip += dSkip (restarting for each segment)
      let i = Math.min(off, seg.length);
      let run = Math.max(1, Math.round(p.seqRun)), skip = Math.max(0, Math.round(p.seqSkip));
      const dRun = Math.round(p.seqRunInc), dSkip = Math.round(p.seqSkipInc);
      while (i < seg.length) {
        for (let k = 0; k < run && i < seg.length; k++, i++) { subset.push(seg[i]); roundOf.set(seg[i].idx, rounds); }
        rounds++;
        i += skip;
        run = Math.max(1, run + dRun); skip = Math.max(0, skip + dSkip);
      }
    } else {
      for (let i = 0; i < seg.length; i++) if (i >= off && (i - off) % nth === 0) subset.push(seg[i]);
    }
  }
  // if counting runs against the progression direction, flip the subset and the sub-sequence numbers
  // so that t (and the cycle) are counted in progression direction
  if (countEnd !== !!p.reverse) {
    subset.reverse();
    if (rounds > 0) for (const [k, r] of Array.from(roundOf.entries())) roundOf.set(k, rounds - 1 - r);
  }
  const m = subset.length;
  const tMap = new Map();
  const cyc = Math.round(p.cycle);
  if (p.seqMode === 1 && p.seqProg === 1) {
    // progression over the sub-sequences: all objects of a sub-sequence receive the same value
    subset.forEach(o => {
      const r = roundOf.get(o.idx) || 0;
      tMap.set(o.idx, cyc >= 2 ? (r % cyc) / (cyc - 1) : (rounds > 1 ? r / (rounds - 1) : 0));
    });
  } else if (p.distrib === 1 && key && cyc < 2) {
    let kmin = Infinity, kmax = -Infinity;
    for (const o of subset) { const k = key(o); kmin = Math.min(kmin, k); kmax = Math.max(kmax, k); }
    const span = kmax - kmin;
    for (const o of subset) { let t = span > 1e-12 ? (key(o) - kmin) / span : 0; if (p.reverse) t = 1 - t; tMap.set(o.idx, t); }
  } else if (cyc >= 2) {
    subset.forEach((o, j) => tMap.set(o.idx, (j % cyc) / (cyc - 1)));
  } else {
    subset.forEach((o, j) => tMap.set(o.idx, m > 1 ? j / (m - 1) : 0));
  }
  return { ranked: progOrder, subset, tMap, roundOf, rounds, groupSizes: fg.map(g => g.length) };
}

function ease(t, mode) {
  switch (mode) {
    case 1: return t * t;
    case 2: return 1 - (1 - t) * (1 - t);
    case 3: return (1 - Math.cos(Math.PI * t)) / 2;
    default: return t;
  }
}
function shapeT(t0, p) {
  let t = t0;
  if (p.shape === 1) t = 1 - Math.abs(2 * t - 1);
  else if (p.shape === 2) t = (1 - Math.cos(TAU * Math.max(p.freq, 0) * t + p.phase * Math.PI / 180)) / 2;
  t = ease(clamp01(t), p.ease);
  const st = Math.round(p.steps);
  if (st >= 2) t = Math.min(st - 1, Math.floor(t * st)) / (st - 1);
  return t;
}
const lerp = (a, b, t) => a + (b - a) * t;
function safeScale(s) { if (!isFinite(s)) return 1; if (Math.abs(s) < 0.001) return s < 0 ? -0.001 : 0.001; return s; }
function linearPart(T) { const L = T.clone(); const d = L.data; d[2] = 0; d[5] = 0; return L; }

function pivotFor(o, p) {
  if (p.refMode === 1) return o.near;
  const a = p.anchor | 0;
  if (a === 10) return o.fp ? { x: o.fp.x, y: o.fp.y } : { x: o.cx, y: o.cy };
  const rel = ANCHOR_REL[a] || [0.5, 0.5];
  if ((p.objAxes || p.sizeMode === 1) && o.F && o.lb && o.lb.width > 0 && o.lb.height > 0) {
    const sp = o.F.applyToPoint({ x: o.lb.x + rel[0] * o.lb.width, y: o.lb.y + rel[1] * o.lb.height });
    return { x: sp.x, y: sp.y };
  }
  return { x: o.sb.x + rel[0] * o.sb.width, y: o.sb.y + rel[1] * o.sb.height };
}

// random values per sub-sequence (for "same jitter within a sub-sequence"): 20 values + 2 for own rotation
function roundRandoms(seed, r) {
  const g = mulberry32(((seed | 0) * 7919 + r * 104729 + 12345) | 0);
  for (let k = 0; k < 4; k++) g();
  const u = []; for (let k = 0; k < 20; k++) u.push(g());
  return { u, uL: [g(), g()] };
}

// pattern display of the sequence: "3+1,2+0  ●●●○○ ●●●●○○ …"
function seqPatternText(p) {
  const fmt = (a, d) => a + (d >= 0 ? '+' + d : '' + d);
  let run = Math.max(1, Math.round(p.seqRun)), skip = Math.max(0, Math.round(p.seqSkip));
  const dRun = Math.round(p.seqRunInc), dSkip = Math.round(p.seqSkipInc);
  const head = fmt(run, dRun) + ',' + fmt(skip, dSkip);
  let vis = '', rounds = 0;
  while (vis.length < 40 && rounds < 40) {
    vis += '●'.repeat(Math.min(run, 40)) + '○'.repeat(Math.min(skip, 40)) + ' ';
    run = Math.max(1, run + dRun); skip = Math.max(0, skip + dSkip); rounds++;
  }
  return head + '   ' + vis.trim() + ' …';
}

// ---------------------------------------------------------------- Build command
function buildCommand(p) {
  const { ranked, subset, tMap, roundOf } = computeSequence(p);
  const perRound = p.seqMode === 1 && !!p.seqJitRound;
  const roundCache = new Map();
  const rnd = mulberry32(p.seed | 0);
  const rndL = mulberry32((p.seed | 0) ^ 0x51ED27);      // separate stream: v2 results stay identical
  const bld = CompoundCommandBuilder.create();
  let count = 0;
  const inSub = new Set(subset.map(o => o.idx));
  const doColour = (Math.abs(p.hueS) + Math.abs(p.hueE) + Math.abs(p.satS) + Math.abs(p.satE) + Math.abs(p.litS) + Math.abs(p.litE)
                    + p.jHue + p.jSat + p.jLit) > 1e-9 && (p.colFill || p.colStroke);
  const doOpac = Math.abs(p.oS - 100) + Math.abs(p.oE - 100) + p.jO > 1e-9;

  for (const o of info) {
    // 20 random numbers per object in fixed object order (stable against sorting/filtering)
    let u = []; for (let k = 0; k < 20; k++) u.push(rnd());
    let uL = [rndL(), rndL()];
    if (!inSub.has(o.idx)) continue;
    if (perRound) {   // same jitter for all objects of the same sub-sequence
      const rr = roundOf.get(o.idx) || 0;
      let c = roundCache.get(rr);
      if (!c) { c = roundRandoms(p.seed, rr); roundCache.set(rr, c); }
      u = c.u; uL = c.uL;
    }
    const ctr = o.near;
    const r = [];
    for (let k = 0; k < 10; k++) {
      if (p.jDist === 1) {
        const g = Math.sqrt(-2 * Math.log(Math.max(u[2 * k], 1e-12))) * Math.cos(TAU * u[2 * k + 1]);
        r.push(Math.max(-1.5, Math.min(1.5, g / 2)));      // ±amount ≈ 2σ
      } else r.push(u[2 * k] * 2 - 1);
    }
    const t0 = tMap.get(o.idx) || 0;
    const t = shapeT(t0, p);
    const jf = lerp(p.jfS, p.jfE, t0) / 100;

    const wPct = lerp(p.wS, p.wE, t) + r[0] * p.jW * jf;
    const hPct = lerp(p.hS, p.hE, t) + r[1] * p.jH * jf;
    const sPct = lerp(p.sS, p.sE, t) + r[2] * p.jS * jf;
    const rot = lerp(p.rS, p.rE, t) + r[3] * p.jR * jf;           // counter-clockwise, degrees
    let rL;
    if (p.jDist === 1) { const g = Math.sqrt(-2 * Math.log(Math.max(uL[0], 1e-12))) * Math.cos(TAU * uL[1]); rL = Math.max(-1.5, Math.min(1.5, g / 2)); }
    else rL = uL[0] * 2 - 1;
    const lrot = lerp(p.lrS, p.lrE, t) + rL * p.jLR * jf;         // own rotation, degrees
    let jx = r[4] * p.jX * jf, jy = r[5] * p.jY * jf;
    if (p.jPosUnit === 1) { jx *= o.sb.width / 100; jy *= o.sb.height / 100; }

    // scaling
    let sx, sy;
    if (p.sizeMode === 1) {
      sx = safeScale((refW * wPct / 100 * sPct / 100) / Math.max(o.wLoc, 1e-9));
      sy = safeScale((refH * hPct / 100 * sPct / 100) / Math.max(o.hLoc, 1e-9));
    } else {
      sx = safeScale(wPct / 100 * sPct / 100);
      sy = safeScale(hPct / 100 * sPct / 100);
    }
    const noScale = Math.abs(sx - 1) < 1e-9 && Math.abs(sy - 1) < 1e-9;

    // rotation (screen radians, positive = clockwise)
    let theta = -rot * Math.PI / 180;
    if (p.rotMode === 1) theta += -o.phi;
    else if (p.rotMode === 2) {
      const dx = o.cx - ctr.x, dy = o.cy - ctr.y;
      if (Math.hypot(dx, dy) > 1e-6) theta += (Math.atan2(dy, dx) + Math.PI / 2) - o.phi;
    }
    else if (p.rotMode === 3 && o.proj) theta += o.proj.ang - o.phi;

    // offset
    let mx = lerp(p.xS, p.xE, t) + jx, my = lerp(p.yS, p.yE, t) + jy;
    const rad = lerp(p.radS, p.radE, t);
    if (Math.abs(rad) > 1e-9) {
      const dx = o.cx - ctr.x, dy = o.cy - ctr.y, L = Math.hypot(dx, dy);
      if (L > 1e-6) { mx += dx / L * rad; my += dy / L * rad; }
    }

    const sel = Selection.create(doc, o.node);
    if (!(noScale && Math.abs(theta) < 1e-9 && Math.abs(lrot) < 1e-9 && Math.abs(mx) < 1e-9 && Math.abs(my) < 1e-9)) {
      const P = pivotFor(o, p);
      let Lin = Transform.createScale(sx, sy);
      if ((p.objAxes || p.sizeMode === 1) && o.F && !noScale) {
        const FL = linearPart(o.F);
        try { Lin = FL.multiply(Transform.createScale(sx, sy)).multiply(FL.inverted); } catch (e) { Lin = Transform.createScale(sx, sy); }
      }
      let D = Transform.createTranslate(P.x + mx, P.y + my)
        .multiply(Transform.createRotate(theta)).multiply(Lin)
        .multiply(Transform.createTranslate(-P.x, -P.y));
      // own rotation: around the object's own anchor, after all other transformations,
      // sense of rotation in the local coordinate system (mirrored objects rotate correctly)
      if (Math.abs(lrot) > 1e-9) {
        const Q = D.applyToPoint(pivotFor(o, Object.assign({}, p, { refMode: 0 })));
        let det = 1;
        if (o.F) { const d = o.F.data; det = (d[0] * d[4] - d[1] * d[3]); }
        det *= sx * sy;
        const sgn = det < 0 ? 1 : -1;
        D = Transform.createTranslate(Q.x, Q.y).multiply(Transform.createRotate(sgn * lrot * Math.PI / 180))
              .multiply(Transform.createTranslate(-Q.x, -Q.y)).multiply(D);
      }
      bld.addCommand(DocumentCommand.createTransform(sel, D)); count++;
    }

    // stroke width
    if (p.stroke > 0 && !noScale) {
      const k = Math.sqrt(Math.abs(sx * sy));
      for (const lf of o.leaves) {
        if (!lf.lsd || lf.text) continue;
        let auto = 1; try { auto = lf.lsd.isScale ? k : 1; } catch (e) {}
        const want = p.stroke === 1 ? k : 1;
        const f = want / auto;
        if (Math.abs(f - 1) > 1e-6) {
          try { bld.addCommand(DocumentCommand.createSetLineStyleDescriptor(Selection.create(doc, lf.node), lf.lsd.cloneScaled(f), { lineStyleMask: LineStyleMask.Weight })); count++; } catch (e) {}
        }
      }
    }

    // opacity (factor on current opacity)
    if (doOpac) {
      const f = (lerp(p.oS, p.oE, t) + r[6] * p.jO * jf) / 100;
      const v = clamp01(o.opacity * f);
      if (Math.abs(v - o.opacity) > 1e-6) { try { bld.addCommand(DocumentCommand.createSetOpacity(sel, v)); count++; } catch (e) {} }
    }

    // HSL shift
    if (doColour) {
      const dH = lerp(p.hueS, p.hueE, t) + r[7] * p.jHue * jf;
      const dS = lerp(p.satS, p.satE, t) + r[8] * p.jSat * jf;
      const dL = lerp(p.litS, p.litE, t) + r[9] * p.jLit * jf;
      if (Math.abs(dH) + Math.abs(dS) + Math.abs(dL) > 1e-9) {
        for (const lf of o.leaves) {
          const ls = Selection.create(doc, lf.node);
          if (p.colFill && lf.brush) { const fd = shiftFD(lf.brush, dH, dS, dL); if (fd) { bld.addCommand(DocumentCommand.createSetBrushFill(ls, fd)); count++; } }
          if (p.colStroke && lf.pen) { const fd = shiftFD(lf.pen, dH, dS, dL); if (fd) { bld.addCommand(DocumentCommand.createSetPenFill(ls, fd)); count++; } }
        }
      }
    }
  }

  // restack (per parent; first object of the sequence on top or at bottom)
  if (p.stack > 0) {
    const byParent = new Map();
    for (const o of ranked) {
      let par = null; try { par = o.node.parent; } catch (e) {}
      if (!par) continue;
      let key = null;
      for (const k of byParent.keys()) if (k.isSameNode(par)) { key = k; break; }
      if (!key) { key = par; byParent.set(key, []); }
      byParent.get(key).push(o);
    }
    for (const [, list] of byParent) {
      if (list.length < 2) continue;
      // desired order bottom → top
      const bottomUp = p.stack === 1 ? list.slice().reverse() : list.slice();
      // anchor position: the currently lowest object of this list
      let lowest = list[0];
      for (const o of list) if (cmpPath(o.stack, lowest.stack) < 0) lowest = o;
      if (!bottomUp[0].node.isSameNode(lowest.node))
        bld.addCommand(DocumentCommand.createMoveNodes(Selection.create(doc, bottomUp[0].node), lowest.node, MOVE_BEFORE, 0));
      for (let i = 1; i < bottomUp.length; i++)
        bld.addCommand(DocumentCommand.createMoveNodes(Selection.create(doc, bottomUp[i].node), bottomUp[i - 1].node, MOVE_AFTER, 0));
      count++;
    }
  }

  if (!count) return null;
  bld.addCommand(restoreSelCmd());        // stroke/fill commands would otherwise move the selection
  return bld.createCommand();
}

// ---------------------------------------------------------------- Preview
let previewMode = 0, fallbackPos = null;
function clearPreview() {
  if (previewMode === 1) { try { doc.clearPreviews(); } catch (e) {} }
  else if (previewMode === 2) { try { while (doc.history.position > fallbackPos) doc.history.undo(); } catch (e) {} }
  previewMode = 0;
}
function showPreview(p) {
  clearPreview();
  const cmd = buildCommand(p);
  if (!cmd) { restoreSelection(); return; }
  try { doc.executeCommand(cmd, true); previewMode = 1; }
  catch (e) {
    try { fallbackPos = doc.history.position; doc.executeCommand(buildCommand(p)); previewMode = 2; }
    catch (e2) { console.log('Preview error: ' + e2); previewMode = 0; }
  }
}

buildInfo(DEF.flatten);
if (N < 2) { app.alert(TXT.tooFew, TXT.title); throw new Error('too few'); }

// ---------------------------------------------------------------- Dialog
// Layout: on the left a narrow, permanently visible column (tab selection, preview, presets);
// on the right two content columns. Each page (tab) consists of groups in these two columns;
// when switching, the groups of the active page are shown and all others are hidden.
const dlg = Dialog.create(TXT.title);
dlg.initialWidth = 1000;
try { dlg.isResizable = true; } catch (e) {}
const cNav = dlg.addColumn(); cNav.widthProportion = 0.8;
const cA = dlg.addColumn(); cA.widthProportion = 1;
const cB = dlg.addColumn(); cB.widthProportion = 1;

function uve(grp, label, unit, val, mn, mx, prec) {
  const e = grp.addUnitValueEditor(label, unit, unit, val, mn, mx);
  e.value = val;
  if (prec !== undefined) { try { e.precision = prec; } catch (x) {} }
  return e;
}
const PCT = UnitType.Percentage, DEG = UnitType.Degree, PX = UnitType.Pixel, NUM = UnitType.Number;

// --- Tab management
const PAGES = [[], [], [], [], [], []];           // the groups belonging to each page
function pageGroup(pageIdx, col, title) { const g = col.addGroup(title); PAGES[pageIdx].push(g); return g; }
let pagedOK = true;
function showPage(i) {
  if (!pagedOK) return;
  try {
    for (let k = 0; k < PAGES.length; k++) for (const g of PAGES[k]) g.isVisible = (k === i);
  } catch (e) {
    // fallback: hiding not possible -> keep everything visible (layout as in v7, just in two columns)
    pagedOK = false;
    try { for (const pg of PAGES) for (const g of pg) g.isVisible = true; } catch (e2) {}
    console.log('Tabs not available: ' + e.message);
  }
}

// --- Left column: always visible
const gNav = cNav.addGroup(TXT.grpNav);
const rNav = gNav.addRadioGroup('', TXT.pages, 0);
const tInfo = gNav.addStaticText('', TXT.info(N, pdPoints.length, !!pathData));
const gPv = cNav.addGroup(TXT.grpPrev);
const cLive = gPv.addCheckBox(TXT.live, DEF.live);
const bPrev = gPv.addButton(TXT.preview);
const gPs = cNav.addGroup(TXT.grpPreset);
const bPSave = gPs.addButton(TXT.pSave);
const bPLoad = gPs.addButton(TXT.pLoad);
const bPDel = gPs.addButton(TXT.pDel);

// --- Page 1: Order
const gOrd = pageGroup(0, cA, TXT.grpOrder);
const cOrder = gOrd.addComboBox(TXT.order, TXT.orders, DEF.order);
const cRev = gOrd.addCheckBox(TXT.reverse, DEF.reverse);
const eStartA = uve(gOrd, TXT.startAngle, DEG, DEF.startAngle, -360, 360);
const eWind = uve(gOrd, TXT.windings, NUM, DEF.windings, 0, 100, 1);
const cDist = gOrd.addComboBox(TXT.distrib, TXT.distribs, DEF.distrib);
const gStr = pageGroup(0, cB, TXT.grpStruct);
const cFlat = gStr.addCheckBox(TXT.flatten, DEF.flatten);
const cStack = gStr.addComboBox(TXT.stack, TXT.stacks, DEF.stack);

// --- Page 2: Selection
const gSel = pageGroup(1, cA, TXT.grpSelect);
const cSeqMode = gSel.addComboBox(TXT.seqMode, TXT.seqModes, DEF.seqMode);
const eNth = uve(gSel, TXT.nth, NUM, DEF.nth, 1, 10000, 0);
const eSeqRun = uve(gSel, TXT.seqRun, NUM, DEF.seqRun, 1, 10000, 0);
const eSeqRunInc = uve(gSel, TXT.seqRunInc, NUM, DEF.seqRunInc, -1000, 1000, 0);
const eSeqSkip = uve(gSel, TXT.seqSkip, NUM, DEF.seqSkip, 0, 10000, 0);
const eSeqSkipInc = uve(gSel, TXT.seqSkipInc, NUM, DEF.seqSkipInc, -1000, 1000, 0);
const tSeq = gSel.addStaticText('', TXT.seqNote(seqPatternText(DEF), 0));
const gTeil = pageGroup(1, cA, TXT.grpSeqProg);
const cSeqProg = gTeil.addComboBox(TXT.seqProg, TXT.seqProgs, DEF.seqProg);
const cSeqJit = gTeil.addCheckBox(TXT.seqJitRound, DEF.seqJitRound);
const gCnt = pageGroup(1, cB, TXT.grpCount);
const cCountMode = gCnt.addComboBox(TXT.countMode, TXT.countModes, DEF.countMode);
const cSeqGroup = gCnt.addCheckBox(TXT.seqPerGroup, DEF.seqPerGroup);
const tGrp = gCnt.addStaticText('', TXT.grpNote([]));
const eNthOff = uve(gCnt, TXT.nthOff, NUM, DEF.nthOff, 0, 10000, 0);
const eFrom = uve(gCnt, TXT.from, NUM, DEF.from, 1, 100000, 0);
const eTo = uve(gCnt, TXT.to, NUM, DEF.to, 0, 100000, 0);

// --- Page 3: Progression & reference
const gCurve = pageGroup(2, cA, TXT.grpCurve);
const cShape = gCurve.addComboBox(TXT.shape, TXT.shapes, DEF.shape);
const eFreq = uve(gCurve, TXT.freq, NUM, DEF.freq, 0, 100, 2);
const ePhase = uve(gCurve, TXT.phase, DEG, DEF.phase, -360, 360);
const cEase = gCurve.addComboBox(TXT.ease, TXT.eases, DEF.ease);
const eSteps = uve(gCurve, TXT.steps, NUM, DEF.steps, 0, 1000, 0);
const eCycle = uve(gCurve, TXT.cycle, NUM, DEF.cycle, 0, 10000, 0);
const gRef = pageGroup(2, cB, TXT.grpRef);
const cRef = gRef.addComboBox(TXT.refMode, TXT.refModes, DEF.refMode);
const cAnchor = gRef.addSpatialAnchor(TXT.anchor, SpatialAnchor.Centre);
const cAxes = gRef.addCheckBox(TXT.objAxes, DEF.objAxes);

// --- Page 4: Transformation
const gTr = pageGroup(3, cA, TXT.grpTrans);
const eWS = uve(gTr, TXT.wS, PCT, DEF.wS, -1000, 1000);
const eWE = uve(gTr, TXT.wE, PCT, DEF.wE, -1000, 1000);
const eHS = uve(gTr, TXT.hS, PCT, DEF.hS, -1000, 1000);
const eHE = uve(gTr, TXT.hE, PCT, DEF.hE, -1000, 1000);
const eSS = uve(gTr, TXT.sS, PCT, DEF.sS, -1000, 1000);
const eSE = uve(gTr, TXT.sE, PCT, DEF.sE, -1000, 1000);
const cSizeM = gTr.addComboBox(TXT.sizeMode, TXT.sizeModes, DEF.sizeMode);
const eRS = uve(gTr, TXT.rS, DEG, DEF.rS, -3600, 3600);
const eRE = uve(gTr, TXT.rE, DEG, DEF.rE, -3600, 3600);
const cRotM = gTr.addComboBox(TXT.rotMode, TXT.rotModes, DEF.rotMode);
const eLRS = uve(gTr, TXT.lrS, DEG, DEF.lrS, -3600, 3600);
const eLRE = uve(gTr, TXT.lrE, DEG, DEF.lrE, -3600, 3600);
const cStroke = gTr.addComboBox(TXT.stroke, TXT.strokes, DEF.stroke);
const gMv = pageGroup(3, cB, TXT.grpMove);
const eXS = uve(gMv, TXT.xS, PX, DEF.xS, -100000, 100000);
const eXE = uve(gMv, TXT.xE, PX, DEF.xE, -100000, 100000);
const eYS = uve(gMv, TXT.yS, PX, DEF.yS, -100000, 100000);
const eYE = uve(gMv, TXT.yE, PX, DEF.yE, -100000, 100000);
const eRadS = uve(gMv, TXT.radS, PX, DEF.radS, -100000, 100000);
const eRadE = uve(gMv, TXT.radE, PX, DEF.radE, -100000, 100000);

// --- Page 5: Opacity & colour
const gOp = pageGroup(4, cA, TXT.grpOpac);
const eOS = uve(gOp, TXT.oS, PCT, DEF.oS, 0, 1000);
const eOE = uve(gOp, TXT.oE, PCT, DEF.oE, 0, 1000);
gOp.addStaticText('', TXT.colNote);
const gHsl = pageGroup(4, cB, TXT.grpHsl);
const eHueS = uve(gHsl, TXT.hueS, DEG, DEF.hueS, -360, 360);
const eHueE = uve(gHsl, TXT.hueE, DEG, DEF.hueE, -360, 360);
const eSatS = uve(gHsl, TXT.satS, PCT, DEF.satS, -100, 100);
const eSatE = uve(gHsl, TXT.satE, PCT, DEF.satE, -100, 100);
const eLitS = uve(gHsl, TXT.litS, PCT, DEF.litS, -100, 100);
const eLitE = uve(gHsl, TXT.litE, PCT, DEF.litE, -100, 100);
const cColF = gHsl.addCheckBox(TXT.colFill, DEF.colFill);
const cColS = gHsl.addCheckBox(TXT.colStroke, DEF.colStroke);

// --- Page 6: Jitter
const gJg = pageGroup(5, cA, TXT.grpJitGeo);
const eJW = uve(gJg, TXT.jW, PCT, DEF.jW, 0, 1000);
const eJH = uve(gJg, TXT.jH, PCT, DEF.jH, 0, 1000);
const eJS = uve(gJg, TXT.jS, PCT, DEF.jS, 0, 1000);
const eJR = uve(gJg, TXT.jR, DEG, DEF.jR, 0, 360);
const eJLR = uve(gJg, TXT.jLR, DEG, DEF.jLR, 0, 360);
const eJX = uve(gJg, TXT.jX, NUM, DEF.jX, 0, 100000, 1);
const eJY = uve(gJg, TXT.jY, NUM, DEF.jY, 0, 100000, 1);
const cJPU = gJg.addComboBox(TXT.jPosUnit, TXT.jPosUnits, DEF.jPosUnit);
const gJc = pageGroup(5, cB, TXT.grpJitCol);
const eJO = uve(gJc, TXT.jO, PCT, DEF.jO, 0, 100);
const eJHue = uve(gJc, TXT.jHue, DEG, DEF.jHue, 0, 180);
const eJSat = uve(gJc, TXT.jSat, PCT, DEF.jSat, 0, 100);
const eJLit = uve(gJc, TXT.jLit, PCT, DEF.jLit, 0, 100);
const eJfS = uve(gJc, TXT.jfS, PCT, DEF.jfS, 0, 1000);
const eJfE = uve(gJc, TXT.jfE, PCT, DEF.jfE, 0, 1000);
const cJDist = gJc.addComboBox(TXT.jDist, TXT.jDists, DEF.jDist);
const eSeed = uve(gJc, TXT.seed, NUM, DEF.seed, 0, 999999, 0);
const bSeed = gJc.addButton(TXT.newSeed);

// set start values explicitly
cOrder.selectedIndex = DEF.order; cDist.selectedIndex = DEF.distrib; cStack.selectedIndex = DEF.stack; cSeqMode.selectedIndex = DEF.seqMode; cSeqProg.selectedIndex = DEF.seqProg; cCountMode.selectedIndex = DEF.countMode;
cShape.selectedIndex = DEF.shape; cEase.selectedIndex = DEF.ease; cSizeM.selectedIndex = DEF.sizeMode;
cRotM.selectedIndex = DEF.rotMode; cStroke.selectedIndex = DEF.stroke; cJPU.selectedIndex = DEF.jPosUnit;
cJDist.selectedIndex = DEF.jDist;
cRef.selectedIndex = pdPoints.length ? 1 : DEF.refMode;
if (pathData) cOrder.selectedIndex = 15;
cAnchor.value = SpatialAnchor.Centre;
rNav.selectedIndex = 0;
showPage(0);

const CTRL = {   // name → [control, kind]
  order: [cOrder, 'i'], reverse: [cRev, 'b'], startAngle: [eStartA, 'v'], windings: [eWind, 'v'], distrib: [cDist, 'i'],
  seqMode: [cSeqMode, 'i'], nth: [eNth, 'v'], seqRun: [eSeqRun, 'v'], seqRunInc: [eSeqRunInc, 'v'], seqSkip: [eSeqSkip, 'v'], seqSkipInc: [eSeqSkipInc, 'v'], seqProg: [cSeqProg, 'i'], seqJitRound: [cSeqJit, 'b'], countMode: [cCountMode, 'i'], seqPerGroup: [cSeqGroup, 'b'],
  nthOff: [eNthOff, 'v'], from: [eFrom, 'v'], to: [eTo, 'v'],
  flatten: [cFlat, 'b'], stack: [cStack, 'i'],
  shape: [cShape, 'i'], freq: [eFreq, 'v'], phase: [ePhase, 'v'], ease: [cEase, 'i'], steps: [eSteps, 'v'], cycle: [eCycle, 'v'],
  refMode: [cRef, 'i'], anchor: [cAnchor, 'a'], objAxes: [cAxes, 'b'],
  wS: [eWS, 'v'], wE: [eWE, 'v'], hS: [eHS, 'v'], hE: [eHE, 'v'], sS: [eSS, 'v'], sE: [eSE, 'v'], sizeMode: [cSizeM, 'i'],
  rS: [eRS, 'v'], rE: [eRE, 'v'], rotMode: [cRotM, 'i'], lrS: [eLRS, 'v'], lrE: [eLRE, 'v'], stroke: [cStroke, 'i'],
  xS: [eXS, 'v'], xE: [eXE, 'v'], yS: [eYS, 'v'], yE: [eYE, 'v'], radS: [eRadS, 'v'], radE: [eRadE, 'v'],
  oS: [eOS, 'v'], oE: [eOE, 'v'], hueS: [eHueS, 'v'], hueE: [eHueE, 'v'], satS: [eSatS, 'v'], satE: [eSatE, 'v'],
  litS: [eLitS, 'v'], litE: [eLitE, 'v'], colFill: [cColF, 'b'], colStroke: [cColS, 'b'],
  jW: [eJW, 'v'], jH: [eJH, 'v'], jS: [eJS, 'v'], jR: [eJR, 'v'], jLR: [eJLR, 'v'], jX: [eJX, 'v'], jY: [eJY, 'v'], jPosUnit: [cJPU, 'i'],
  jO: [eJO, 'v'], jHue: [eJHue, 'v'], jSat: [eJSat, 'v'], jLit: [eJLit, 'v'], jfS: [eJfS, 'v'], jfE: [eJfE, 'v'],
  jDist: [cJDist, 'i'], seed: [eSeed, 'v'], live: [cLive, 'b']
};

function readParams() {
  const p = {};
  for (const k in CTRL) {
    const [c, kind] = CTRL[k];
    if (kind === 'i') p[k] = c.selectedIndex;
    else if (kind === 'b') p[k] = !!c.value;
    else if (kind === 'a') p[k] = Number(c.value) || 5;
    else { const v = Number(c.value); p[k] = isFinite(v) ? v : DEF[k]; }
  }
  p.seed = Math.round(p.seed);
  return p;
}
let isUpdating = false;
function applyParams(v) {
  isUpdating = true;
  try {
    for (const k in CTRL) {
      if (v[k] === undefined || v[k] === null) continue;
      const [c, kind] = CTRL[k];
      try {
        if (kind === 'i') c.selectedIndex = v[k] | 0;
        else if (kind === 'b') c.value = !!v[k];
        else if (kind === 'a') { const a = v[k] | 0; if (SpatialAnchor.values[a]) c.value = SpatialAnchor.values[a]; }
        else if (typeof v[k] === 'number' && isFinite(v[k])) c.value = v[k];
      } catch (e) {}
    }
  } finally { isUpdating = false; }
}

let lastFlatten = DEF.flatten;
function refreshStructure(p) {
  if (p.flatten !== lastFlatten) {
    clearPreview();
    lastFlatten = p.flatten;
    buildInfo(p.flatten);
    try { tInfo.text = TXT.info(N, pdPoints.length, !!pathData); } catch (e) {}
  }
}
function updateSeqNote(p) {
  try {
    const r = computeSequence(Object.assign({}, p, { seqMode: 1 }));
    tSeq.text = TXT.seqNote(seqPatternText(p), r.rounds);
    tGrp.text = TXT.grpNote(r.groupSizes);
  } catch (e) {}
}
function runPreview() {
  const p = readParams();
  refreshStructure(p);
  updateSeqNote(p);
  if (N < 1) return;
  showPreview(p);
}
function onChange() {
  if (isUpdating) return;
  const p = readParams();
  refreshStructure(p);
  updateSeqNote(p);
  if (cLive.value) { try { showPreview(p); } catch (e) { console.log(e); } }
}
for (const k in CTRL) { if (k === 'live') continue; try { CTRL[k][0].setOnValueChangedHandler(onChange); } catch (e) {} }
try { rNav.setOnValueChangedHandler(() => { if (!isUpdating) showPage(rNav.selectedIndex); }); } catch (e) {}
cLive.setOnValueChangedHandler(() => {
  if (isUpdating) return;
  if (cLive.value) runPreview(); else { clearPreview(); restoreSelection(); }
});
bPrev.setOnClickHandler(() => { try { runPreview(); } catch (e) { console.log(e); } });
bSeed.setOnClickHandler(() => {
  isUpdating = true; eSeed.value = Math.floor(Math.random() * 999999); isUpdating = false;
  onChange();
});

// ---------------------------------------------------------------- Presets
const PRESET_PREFIX = 'OT_';
function getPresetDir() {
  const dir = app.userDesktopPath + '/AffinityScriptPresets';
  try { if (!FileSystemApi.exists(dir)) FileSystemApi.createDirectories(dir); }
  catch (e) { try { FileSystemApi.createDirectories(dir); } catch (e2) {} }
  return dir;
}
function writeText(path, text) {
  let f;
  try { f = File.create(path, 'wb'); } catch (e) { f = new File(path, 'wb'); }
  f.writeStringAsUtf8(text); f.close();
}
bPSave.setOnClickHandler(() => {
  try {
    const dir = getPresetDir();
    const nameIn = app.prompt(TXT.pName, TXT.pSaveT, '');
    if (!nameIn || !nameIn.trim()) return;
    let base = nameIn.trim().replace(/[\\/:*?"<>|]/g, '_');
    if (base.toUpperCase().startsWith(PRESET_PREFIX)) base = base.substring(PRESET_PREFIX.length);
    const path = dir + '/' + PRESET_PREFIX + base + '.json';
    const data = readParams(); data.script = TXT.title; data.version = 8;
    writeText(path, JSON.stringify(data, null, 2));
    app.alert(TXT.pSaved + path, TXT.title);
  } catch (e) { app.alert(TXT.pErrS + e.message, TXT.title); }
});
bPLoad.setOnClickHandler(() => {
  try {
    getPresetDir();
    const path = app.chooseFile(); if (!path) return;
    let buf; try { buf = File.readAll(path); } catch (e) { app.alert(TXT.pUnread, TXT.title); return; }
    const v = JSON.parse(buf.toString('utf8'));
    // v1 presets: map old order indices to v2+
    if (v.version === 1 && typeof v.order === 'number') v.order = [0, 1, 3, 4, 5, 6, 7, 8, 14][v.order]; if (v.order === undefined) v.order = 0;
    // v6 presets: checkbox "count from the end" -> selection "Counting starts" (always at the end / always at the start)
    if (v.version === 6 && v.countMode === undefined) v.countMode = v.countEnd ? 2 : 1;
    applyParams(v);
    const p = readParams(); refreshStructure(p); updateSeqNote(p);
    if (cLive.value) showPreview(p);
  } catch (e) { app.alert(TXT.pErrL + e.message, TXT.title); }
});
bPDel.setOnClickHandler(() => {
  try {
    getPresetDir();
    const path = app.chooseFile(); if (!path) return;
    if (!/\.json$/i.test(path)) { app.alert(TXT.pOnlyJson, TXT.title); return; }
    FileSystemApi.remove(path);
    app.alert(TXT.pDeleted + path, TXT.title);
  } catch (e) { app.alert(TXT.pErrD + e.message, TXT.title); }
});

// ---------------------------------------------------------------- Start
try { updateSeqNote(readParams()); } catch (e) {}
if (DEF.live) { try { showPreview(readParams()); } catch (e) { console.log(e); } }

const result = dlg.runModal();
const ok = result && result.value === DialogResult.Ok.value;
const finalParams = readParams();
clearPreview();
if (ok) {
  try {
    refreshStructure(finalParams);
    const cmd = buildCommand(finalParams);
    if (cmd) doc.executeCommand(cmd);
  } catch (e) { app.alert(TXT.errApply + e.message, TXT.title); }
}
restoreSelection();
