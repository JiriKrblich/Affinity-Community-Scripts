// =====================================================================
// Farbuebertragung / Colour Transfer  — v12
// Transfers colour (HSL) and alpha from a source onto the selected vector/text objects
// (also inside groups) as a solid fill and/or stroke.
// v10: correct transform composition (own + parent chain), source is rendered
//      (object boundaries, gradients), source mode "Direct layer" / "Visible area".
// v12: tabs 2 and 3 merged: 3 tabs (Source & sampling / Channels, target & adjustments / Jitter).
// v11: GUI split into tabs (pages) like "Transform Objects v8": permanent left column with
//      tab selection, preview and presets; two columns per page on the right.
//      Preview/cancel via undo-history position (instead of writing the fills back manually),
//      so text, strokes and gradients are restored exactly on cancel.
//      Native OK = apply, Cancel/X/ESC = discard. Reproducible jitter via seed.
// =====================================================================
'use strict';
const LANG = 'en';   // 'de' | 'en'

const { Document } = require('/document');
const { DocumentCommand } = require('/commands');
const { Selection } = require('/selections');
const { Dialog, DialogResult } = require('/dialog');
const { UnitType } = require('/units');
const { app } = require('/application');
const { File, FileSystemApi } = require('/fs');
const { Colour, RasterFormat } = require('/colours');
const { FillDescriptor } = require('/fills');
const { StoryDelta } = require('/storydelta');
const { NodeRenderingEngine } = require('/rasterobject');
const { PixelReaderRGBA8 } = require('/pixelaccessor');

// ---------------------------------------------------------------- Texts
const TXT = {
  de: {
    title: 'Farbuebertragung',
    noDoc: 'Kein Dokument geöffnet.',
    noSel: 'Keine Objekte ausgewählt.\nBitte Vektorobjekte auswählen und das Skript erneut starten.',
    noVec: 'Keine Vektorobjekte in der Selektion gefunden.',
    noSrc: 'Keine Quell-Ebene gefunden.\nDie Quell-Ebene muss im Ebenenstapel direkt über den ausgewählten Objekten liegen.',
    grpNav: 'Register',
    pages: ['1  Quelle & Abtastung', '2  Kanäle, Ziel & Anpassung', '3  Jitter'],
    srcLabel: 'Quell-Ebene:', objLabel: 'Objekte:',
    objText: (n, t) => n + ' Objekt(e)' + (t > 0 ? ' (davon ' + t + ' Text)' : ''),
    grpSource: 'Quellmodus',
    sourceMode: 'Quelle',
    sourceModes: ['Direkte Ebene (Stapel)', 'Sichtbarer Bereich (Komposit)'],
    srcHint: ['Direkte Ebene: die Ebene direkt über', 'der Selektion im Ebenenstapel.', 'Sichtbarer Bereich: alles, was optisch',
              'unter den Zielobjekten liegt (Komposit', 'mehrerer Ebenen); die Ziele werden dafür', 'kurz ausgeblendet.'],
    grpSample: 'Abtastung',
    samplePct: 'Abtastbereich (% der Fläche)',
    sampleHint: ['1 % = Einzelpunkt · 100 % = gesamte BBox', 'Mittelpunkt: Centroid (Text: BBox-Mitte)', 'Raster: adaptiv 1×1 … 7×7',
                 'Die Quelle wird gerendert: Objektgrenzen', 'und Verläufe werden berücksichtigt.'],
    grpCh: 'Kanäle übertragen',
    chH: 'Farbton H', chS: 'Sättigung S', chL: 'Helligkeit L', chA: 'Alpha A',
    grpTgt: 'Ziel',
    applyFill: 'Füllung', applyStroke: 'Kontur',
    tgtHint: ['Text: Füllung/Kontur des ganzen', 'Textobjekts wird einheitlich gesetzt.'],
    grpAdj: 'Helligkeit & Sättigung',
    lightnessOff: 'Helligkeits-Offset (−100 … +100 %)',
    satMult: 'Sättigungs-Multiplikator (0 … 200 %)',
    grpAlpha: 'Transparenz',
    alphaThresh: 'Alpha-Schwellwert (0 … 100 %)',
    alphaHint: ['Unter dem Schwellwert → Alpha = 0.', 'Außerhalb der Quelle → Alpha = 0.'],
    grpJit: 'Jitter (±)',
    hueJitter: 'Farbton ± Grad (0 … 180)', satJitter: 'Sättigung ± % (0 … 100)', lumJitter: 'Helligkeit ± % (0 … 100)',
    grpSeed: 'Zufall',
    seed: 'Seed', newSeed: 'Neuer Seed',
    seedHint: ['Gleicher Seed = gleiches Ergebnis', '(Vorschau und Anwenden stimmen überein).'],
    grpPrev: 'Vorschau',
    live: 'Live-Vorschau',
    preview: 'Vorschau aktualisieren',
    prevHint: ['OK = Anwenden', 'Abbrechen = Vorschau verwerfen'],
    grpPreset: 'Presets',
    pSave: 'Speichern', pLoad: 'Laden', pDel: 'Löschen',
    pName: 'Presetname eingeben (Präfix CT_ wird ergänzt):',
    pSaveT: 'Preset speichern', pSaved: 'Preset gespeichert:\n', pDeleted: 'Preset gelöscht:\n',
    pErrS: 'Fehler beim Speichern:\n', pErrL: 'Fehler beim Laden:\n', pErrD: 'Fehler beim Löschen:\n',
    pOnlyJson: 'Nur .json-Presetdateien können gelöscht werden.', pUnread: 'Datei nicht lesbar.',
    errApply: 'Fehler beim Übertragen:\n'
  },
  en: {
    title: 'Colour Transfer',
    noDoc: 'No document open.',
    noSel: 'No objects selected.\nPlease select vector objects and restart the script.',
    noVec: 'No vector objects found in the selection.',
    noSrc: 'No source layer found.\nThe source layer must be positioned directly above the selected objects in the Layers panel.',
    grpNav: 'Tabs',
    pages: ['1  Source & sampling', '2  Channels, target & adjustments', '3  Jitter'],
    srcLabel: 'Source layer:', objLabel: 'Objects:',
    objText: (n, t) => n + ' object(s)' + (t > 0 ? ' (' + t + ' text)' : ''),
    grpSource: 'Source mode',
    sourceMode: 'Source',
    sourceModes: ['Direct layer (stack)', 'Visible area (composite)'],
    srcHint: ['Direct layer: the layer directly above', 'the selection in the stack.', 'Visible area: everything visually',
              'beneath the target objects (composite', 'of several layers); the targets are', 'briefly hidden for this.'],
    grpSample: 'Sampling',
    samplePct: 'Sample area (% of bounding box area)',
    sampleHint: ['1 % = single point · 100 % = full bbox', 'Centre point: centroid (text: bbox centre)', 'Grid: adaptive 1×1 … 7×7',
                 'The source is rendered: object boundaries', 'and gradients are taken into account.'],
    grpCh: 'Transfer channels',
    chH: 'Hue H', chS: 'Saturation S', chL: 'Lightness L', chA: 'Alpha A',
    grpTgt: 'Target',
    applyFill: 'Fill', applyStroke: 'Stroke',
    tgtHint: ['Text: fill/stroke is applied', 'uniformly to the whole text object.'],
    grpAdj: 'Lightness & saturation',
    lightnessOff: 'Lightness offset (−100 … +100 %)',
    satMult: 'Saturation multiplier (0 … 200 %)',
    grpAlpha: 'Transparency',
    alphaThresh: 'Alpha threshold (0 … 100 %)',
    alphaHint: ['Below the threshold → alpha = 0.', 'Outside the source → alpha = 0.'],
    grpJit: 'Jitter (±)',
    hueJitter: 'Hue ± degrees (0 … 180)', satJitter: 'Saturation ± % (0 … 100)', lumJitter: 'Lightness ± % (0 … 100)',
    grpSeed: 'Randomness',
    seed: 'Seed', newSeed: 'New seed',
    seedHint: ['Same seed = same result', '(preview and apply match).'],
    grpPrev: 'Preview',
    live: 'Live preview',
    preview: 'Update preview',
    prevHint: ['OK = apply', 'Cancel = discard preview'],
    grpPreset: 'Presets',
    pSave: 'Save', pLoad: 'Load', pDel: 'Delete',
    pName: 'Enter preset name (prefix CT_ is added):',
    pSaveT: 'Save preset', pSaved: 'Preset saved:\n', pDeleted: 'Preset deleted:\n',
    pErrS: 'Error while saving:\n', pErrL: 'Error while loading:\n', pErrD: 'Error while deleting:\n',
    pOnlyJson: 'Only .json preset files can be deleted.', pUnread: 'File not readable.',
    errApply: 'Error while transferring:\n'
  }
}[LANG];

// ---------------------------------------------------------------- Defaults
const DEF = {
  sourceMode: 0, samplePct: 20,
  applyFill: true, applyStroke: false,
  chH: true, chS: true, chL: true, chA: true,
  lightnessOff: 0, satMult: 100, alphaThresh: 0,
  hueJitter: 0, satJitter: 0, lumJitter: 0, seed: 1234,
  live: false
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

function tag(n) { try { return n[Symbol.toStringTag] || n.constructor.name || ''; } catch (e) { return ''; } }
function kids(n) { try { return n.children ? n.children.toArray() : []; } catch (e) { return []; } }
function isTextNode(n) { const t = tag(n); return t === 'ArtTextNode' || t === 'FrameTextNode'; }

// All vector and text objects of the selection, groups are resolved recursively
function collectVectorNodes(nodes) {
  const result = [];
  for (const n of nodes) {
    if (n.curvesInterface) result.push(n);
    else { const k = kids(n); if (k.length) result.push(...collectVectorNodes(k)); }
  }
  return result;
}

// ---------------------------------------------------------------- Maths
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2, d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      default: h = ((r - g) / d + 4) / 6;
    }
  }
  return { h, s, l };
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// node.localToSpreadTransform contains ONLY the parent chain, not the node's own transform.
// Local → spread: apply node.transform (own) first, then localToSpreadTransform (parent chain).
function localToSpreadPoint(node, p) {
  return node.localToSpreadTransform.applyToPoint(node.transform.applyToPoint(p));
}
// Centre point in the spread: centroid of the curve anchors (text and live shapes: bbox centre)
function getCentroid(node) {
  const sbb = node.getSpreadBaseBox(false);
  const mid = { x: sbb.x + sbb.width * 0.5, y: sbb.y + sbb.height * 0.5 };
  if (isTextNode(node)) return mid;
  try {
    const curves = node.curvesInterface.curves;
    if (!curves || curves.length === 0) return mid;
    let sx = 0, sy = 0, c = 0;
    for (const curve of curves) {
      const bz = curve.beziers;
      if (!bz) continue;
      for (const b of bz) if (b.start) { sx += b.start.x; sy += b.start.y; c++; }
    }
    return c ? localToSpreadPoint(node, { x: sx / c, y: sy / c }) : mid;
  } catch (e) { return mid; }
}

// ---------------------------------------------------------------- Source
function getAllLayers() { const a = []; for (const l of doc.layers.all) a.push(l); return a; }
function indexInAll(node, allArr) {
  for (let i = 0; i < allArr.length; i++) { try { if (allArr[i].isSameNode(node)) return i; } catch (e) {} }
  return -1;
}
// Mode 0: the layer directly above the topmost selected object in the layer stack
function findSourceNode(nodes) {
  const allArr = getAllLayers();
  let minIdx = Infinity;
  for (const n of nodes) { const i = indexInAll(n, allArr); if (i !== -1 && i < minIdx) minIdx = i; }
  if (minIdx === Infinity || minIdx === 0) return null;
  const src = allArr[minIdx - 1];
  if (!src) return null;
  let nm = ''; try { nm = (src.userDescription || src.defaultDescription || '') + ''; } catch (e) {}
  return { sourceNode: src, sourceName: nm || '(?)' };
}
// Mode 1: nearest ArtBoard (else spread) above the targets
function findRenderContainer(node) {
  let p = node.parent, spread = null;
  while (p) {
    if (p.artboardInterface || p.isArtboardEnabled) return p;
    if (tag(p) === 'SpreadNode') spread = p;
    p = p.parent;
  }
  return spread;
}
function hideNodes(nodes) { for (const n of nodes) { try { doc.hideSelection(n.selfSelection); } catch (e) {} } }
function showNodes(nodes) { for (const n of nodes) { try { doc.showSelection(n.selfSelection); } catch (e) {} } }

// Render the source non-destructively (raster/vector, any fill type); bitmap = spread bbox, 1 unit = 1 pixel,
// alpha = 0 outside the filled area.
function renderToCache(node) {
  try {
    const bmp = NodeRenderingEngine.createDefault(node, RasterFormat.RGBA8).createCompatibleBitmap(true);
    return { reader: PixelReaderRGBA8.create(bmp), sbb: node.getSpreadBaseBox(false), w: bmp.width, h: bmp.height };
  } catch (e) { return null; }
}
let _srcCache = null;
const _cacheByMode = {};   // mode → render (stays valid during the modal session)
function prepareSource(mode, vectorNodes, sourceInfo) {
  if (_cacheByMode[mode]) { _srcCache = _cacheByMode[mode]; return; }
  let c = null;
  if (mode === 1) {
    const container = findRenderContainer(vectorNodes[0]);
    if (container) {
      hideNodes(vectorNodes);
      try { c = renderToCache(container); } finally { showNodes(vectorNodes); restoreSelection(); }
    }
  }
  if (!c) c = renderToCache(sourceInfo.sourceNode);
  _cacheByMode[mode] = c; _srcCache = c;
}
function sampleSourceAtSpread(x, y) {
  const c = _srcCache;
  if (!c) return { r: 0, g: 0, b: 0, a: 0 };
  const px = Math.round(x - c.sbb.x), py = Math.round(y - c.sbb.y);
  if (px < 0 || py < 0 || px >= c.w || py >= c.h) return { r: 0, g: 0, b: 0, a: 0 };
  try { const q = c.reader.readPixel(px, py); return { r: q.r / 255, g: q.g / 255, b: q.b / 255, a: q.alpha / 255 }; }
  catch (e) { return { r: 0, g: 0, b: 0, a: 0 }; }
}
// Adaptive grid (1×1 … 7×7) around the centre point, area = samplePct % of the bbox
function sampleHSLA(targetNode, samplePct) {
  const sbb = targetNode.getSpreadBaseBox(false);
  const area = sbb.width * sbb.height;
  const steps = area < 50 ? 1 : area < 5000 ? 3 : area < 50000 ? 5 : 7;
  const sc = Math.sqrt(samplePct / 100);
  const cen = getCentroid(targetNode);
  if (steps === 1) { const q = sampleSourceAtSpread(cen.x, cen.y); return Object.assign(rgbToHsl(q.r, q.g, q.b), { a: q.a }); }
  const sw = sbb.width * sc, sh = sbb.height * sc;
  let r = 0, g = 0, b = 0, a = 0;
  for (let row = 0; row < steps; row++) for (let col = 0; col < steps; col++) {
    const q = sampleSourceAtSpread(cen.x - sw / 2 + (sw / (steps - 1)) * col, cen.y - sh / 2 + (sh / (steps - 1)) * row);
    r += q.r; g += q.g; b += q.b; a += q.a;
  }
  const n = steps * steps;
  return Object.assign(rgbToHsl(r / n, g / n, b / n), { a: a / n });
}

// ---------------------------------------------------------------- Existing colour (for locked channels)
function fdToHSLA(fd) {
  try {
    if (!fd || !fd.fill || !fd.fill.colour) return null;
    const h = fd.fill.colour.hslaf;
    return h ? { h: h.h, s: h.s, l: h.l, a: h.alpha } : null;
  } catch (e) { return null; }
}
// for text, node.brushFillDescriptor always returns NoFill → first glyph as reference
function readExistingHSLA(node) {
  if (isTextNode(node)) {
    try { const st = node.storyInterface.story; if (st.length > 0) { const v = fdToHSLA(st.getGlyphAtts(0).brushFill); if (v) return v; } } catch (e) {}
    return { h: 0, s: 0, l: 0, a: 1 };
  }
  try { return fdToHSLA(node.brushFillDescriptor) || { h: 0, s: 0, l: 0, a: 1 }; } catch (e) { return { h: 0, s: 0, l: 0, a: 1 }; }
}

// ---------------------------------------------------------------- Apply
function applyOne(node, hsla, existing, p, u) {
  let { h, s, l, a } = hsla;
  if (p.hueJitter > 0) h += (u[0] * 2 - 1) * (p.hueJitter / 360);
  if (p.satJitter > 0) s += (u[1] * 2 - 1) * (p.satJitter / 100);
  if (p.lumJitter > 0) l += (u[2] * 2 - 1) * (p.lumJitter / 100);
  l += p.lightnessOff / 100;
  s *= p.satMult / 100;
  h = ((h % 1) + 1) % 1; s = clamp(s, 0, 1); l = clamp(l, 0, 1); a = clamp(a, 0, 1);
  if (p.alphaThresh > 0 && a < p.alphaThresh / 100) a = 0;
  if (!p.chH) h = existing.h;
  if (!p.chS) s = existing.s;
  if (!p.chL) l = existing.l;
  if (!p.chA) a = existing.a;
  const fd = FillDescriptor.createSolid(Colour.createHSLAf({ h, s, l, alpha: a }));
  if (isTextNode(node)) {
    // Text: StoryDelta + formatText (applies uniformly to the whole text)
    try {
      if (p.applyFill)   doc.formatText(StoryDelta.createBrushFill(fd), node.selfSelection, false);
      if (p.applyStroke) doc.formatText(StoryDelta.createPenFill(fd),   node.selfSelection, false);
    } catch (e) {}
  } else {
    if (p.applyFill)   { try { node.brushFillDescriptor = fd; } catch (e) {} }
    if (p.applyStroke) { try { node.penFillDescriptor   = fd; } catch (e) {} }
  }
}
function transferColors(vectorNodes, sourceInfo, p) {
  prepareSource(p.sourceMode, vectorNodes, sourceInfo);
  const rng = mulberry32(p.seed | 0);
  for (const vn of vectorNodes) {
    const u = [rng(), rng(), rng()];                       // fixed number of random values per object
    applyOne(vn, sampleHSLA(vn, p.samplePct), readExistingHSLA(vn), p, u);
  }
  restoreSelection();
}

// ---------------------------------------------------------------- Preview via undo history
// All writes land in the undo history; resetting = setting the history position back.
// This restores fills, strokes, gradients and text (also multi-coloured) exactly.
let startPos = 0, previewOn = false, lastPreviewKey = null;
function rollback() {
  try { if (doc.history.position > startPos) doc.history.position = startPos; } catch (e) {}
  try { let g = 0; while (doc.history.position > startPos && g++ < 100000) doc.history.undo(); } catch (e) {}
}
function showPreview(vectorNodes, sourceInfo, p) {
  if (previewOn) rollback();
  previewOn = true;
  try { transferColors(vectorNodes, sourceInfo, p); lastPreviewKey = JSON.stringify(p); }
  catch (e) { lastPreviewKey = null; console.log('Preview error: ' + e); }
}

// ---------------------------------------------------------------- Start: objects & source
const vectorNodes = collectVectorNodes(selNodes);
if (vectorNodes.length === 0) { app.alert(TXT.noVec, TXT.title); throw new Error('no vector objects'); }
const sourceInfo = findSourceNode(selNodes);
if (!sourceInfo) { app.alert(TXT.noSrc, TXT.title); throw new Error('no source'); }
const textCount = vectorNodes.filter(isTextNode).length;

// ---------------------------------------------------------------- Dialog
// Layout: a narrow, permanently visible column on the left (tab selection, preview, presets);
// two content columns on the right. Each page consists of groups in these two columns;
// when switching, the groups of the active page are shown and all others hidden.
const dlg = Dialog.create(TXT.title);
dlg.initialWidth = 900;
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
function hints(grp, lines) { for (const t of lines) grp.addStaticText('', t); }
const PCT = UnitType.Percentage, DEG = UnitType.Degree, NUM = UnitType.Number;

// --- Tab management
const PAGES = [[], [], []];
function pageGroup(pageIdx, col, title) { const g = col.addGroup(title); PAGES[pageIdx].push(g); return g; }
let pagedOK = true;
function showPage(i) {
  if (!pagedOK) return;
  try {
    for (let k = 0; k < PAGES.length; k++) for (const g of PAGES[k]) g.isVisible = (k === i);
  } catch (e) {
    pagedOK = false;   // fallback: leave everything visible
    try { for (const pg of PAGES) for (const g of pg) g.isVisible = true; } catch (e2) {}
    console.log('Tabs not available: ' + e.message);
  }
}

// --- Left column: always visible
const gNav = cNav.addGroup(TXT.grpNav);
const rNav = gNav.addRadioGroup('', TXT.pages, 0);
const gInfo = cNav.addGroup('');
gInfo.addStaticText(TXT.srcLabel, sourceInfo.sourceName);
gInfo.addStaticText(TXT.objLabel, TXT.objText(vectorNodes.length, textCount));
const gPv = cNav.addGroup(TXT.grpPrev);
const cLive = gPv.addCheckBox(TXT.live, DEF.live);
const bPrev = gPv.addButton(TXT.preview);
hints(gPv, TXT.prevHint);
const gPs = cNav.addGroup(TXT.grpPreset);
const bPSave = gPs.addButton(TXT.pSave);
const bPLoad = gPs.addButton(TXT.pLoad);
const bPDel = gPs.addButton(TXT.pDel);

// --- Page 1: Source & sampling
const gSrc = pageGroup(0, cA, TXT.grpSource);
const cSourceMode = gSrc.addComboBox(TXT.sourceMode, TXT.sourceModes, DEF.sourceMode);
hints(gSrc, TXT.srcHint);
const gSmp = pageGroup(0, cB, TXT.grpSample);
const eSample = uve(gSmp, TXT.samplePct, PCT, DEF.samplePct, 1, 100);
hints(gSmp, TXT.sampleHint);

// --- Page 2: Channels, target & adjustments (left: channels + target, right: adjustments + transparency)
const gCh = pageGroup(1, cA, TXT.grpCh);
const cH = gCh.addCheckBox(TXT.chH, DEF.chH);
const cS = gCh.addCheckBox(TXT.chS, DEF.chS);
const cL = gCh.addCheckBox(TXT.chL, DEF.chL);
const cA_ = gCh.addCheckBox(TXT.chA, DEF.chA);
const gTg = pageGroup(1, cA, TXT.grpTgt);
const cFill = gTg.addCheckBox(TXT.applyFill, DEF.applyFill);
const cStroke = gTg.addCheckBox(TXT.applyStroke, DEF.applyStroke);
hints(gTg, TXT.tgtHint);
const gAd = pageGroup(1, cB, TXT.grpAdj);
const eLight = uve(gAd, TXT.lightnessOff, PCT, DEF.lightnessOff, -100, 100);
const eSat = uve(gAd, TXT.satMult, PCT, DEF.satMult, 0, 200);
const gAl = pageGroup(1, cB, TXT.grpAlpha);
const eAlpha = uve(gAl, TXT.alphaThresh, PCT, DEF.alphaThresh, 0, 100);
hints(gAl, TXT.alphaHint);

// --- Page 3: Jitter
const gJi = pageGroup(2, cA, TXT.grpJit);
const eJH = uve(gJi, TXT.hueJitter, DEG, DEF.hueJitter, 0, 180);
const eJS = uve(gJi, TXT.satJitter, PCT, DEF.satJitter, 0, 100);
const eJL = uve(gJi, TXT.lumJitter, PCT, DEF.lumJitter, 0, 100);
const gSd = pageGroup(2, cB, TXT.grpSeed);
const eSeed = uve(gSd, TXT.seed, NUM, DEF.seed, 0, 999999, 0);
const bSeed = gSd.addButton(TXT.newSeed);
hints(gSd, TXT.seedHint);

// Set start values explicitly
cSourceMode.selectedIndex = DEF.sourceMode;
rNav.selectedIndex = 0;
showPage(0);

const CTRL = {   // name → [control, kind]
  sourceMode: [cSourceMode, 'i'], samplePct: [eSample, 'v'],
  chH: [cH, 'b'], chS: [cS, 'b'], chL: [cL, 'b'], chA: [cA_, 'b'],
  applyFill: [cFill, 'b'], applyStroke: [cStroke, 'b'],
  lightnessOff: [eLight, 'v'], satMult: [eSat, 'v'], alphaThresh: [eAlpha, 'v'],
  hueJitter: [eJH, 'v'], satJitter: [eJS, 'v'], lumJitter: [eJL, 'v'], seed: [eSeed, 'v']
};
function readParams() {
  const p = {};
  for (const k in CTRL) {
    const [c, kind] = CTRL[k];
    if (kind === 'i') p[k] = c.selectedIndex;
    else if (kind === 'b') p[k] = !!c.value;
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
        else if (typeof v[k] === 'number' && isFinite(v[k])) c.value = v[k];
      } catch (e) {}
    }
  } finally { isUpdating = false; }
}
function runPreview() { showPreview(vectorNodes, sourceInfo, readParams()); }
function onChange() { if (!isUpdating && cLive.value) { try { runPreview(); } catch (e) { console.log(e); } } }
for (const k in CTRL) { try { CTRL[k][0].setOnValueChangedHandler(onChange); } catch (e) {} }
try { rNav.setOnValueChangedHandler(() => { if (!isUpdating) showPage(rNav.selectedIndex); }); } catch (e) {}
cLive.setOnValueChangedHandler(() => {
  if (isUpdating) return;
  if (cLive.value) { try { runPreview(); } catch (e) { console.log(e); } }
  else if (previewOn) { rollback(); previewOn = false; lastPreviewKey = null; restoreSelection(); }
});
bPrev.setOnClickHandler(() => { try { runPreview(); } catch (e) { console.log(e); } });
bSeed.setOnClickHandler(() => {
  isUpdating = true; eSeed.value = Math.floor(Math.random() * 999999); isUpdating = false;
  onChange();
});

// ---------------------------------------------------------------- Presets
const PRESET_PREFIX = 'CT_';
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
    const data = readParams(); data.script = 'Farbuebertragung'; data.version = 12;
    writeText(path, JSON.stringify(data, null, 2));
    app.alert(TXT.pSaved + path, TXT.title);
  } catch (e) { app.alert(TXT.pErrS + e.message, TXT.title); }
});
bPLoad.setOnClickHandler(() => {
  try {
    getPresetDir();
    const path = app.chooseFile(); if (!path) return;
    let buf; try { buf = File.readAll(path); } catch (e) { app.alert(TXT.pUnread, TXT.title); return; }
    applyParams(JSON.parse(buf.toString('utf8')));
    if (cLive.value) runPreview();
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

// ---------------------------------------------------------------- Run
startPos = doc.history.position;
const result = dlg.runModal();
const ok = result && result.value === DialogResult.Ok.value;
const finalParams = readParams();
if (ok) {
  try {
    // A preview with unchanged settings is simply kept, otherwise transfer afresh
    if (!(previewOn && JSON.stringify(finalParams) === lastPreviewKey)) {
      if (previewOn) rollback();
      previewOn = false;
      transferColors(vectorNodes, sourceInfo, finalParams);
    }
  } catch (e) { app.alert(TXT.errApply + e.message, TXT.title); }
} else if (previewOn) {
  rollback();
}
restoreSelection();
