
'use strict';

// ── Gradient Tweak v27 EN ─────────────────────────────────────
// Fixes vs v26:
// - High-marker-count warning: threshold lowered (100 instead of
//   150), now also triggers on "Preview" (not only "Apply")
// - Load preset: app.chooseFile() opens the native file picker
//   instead of typing a name by hand

const { Dialog, DialogResult } = require('/dialog');
const { Document }             = require('/document');
const { FillDescriptor }       = require('/fills');
const { Gradient, Colour }     = require('/colours');
const { DocumentCommand }      = require('/commands');
const { StoryDelta }           = require('/storydelta');
const { app }                  = require('/application');
const { File }                 = require('/fs');

const EPSILON = 0.0001;
const WARN_THRESHOLD = 100; // colour stop count above which a warning is shown

// ── Seeded PRNG ─────────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function clamp01(v) { return Math.max(0, Math.min(1, v)); }

// ── Read stops ────────────────────────────────────────────────

function readRawStops(gradient) {
  const stops = [];
  for (let i = 0; i < gradient.stopCount; i++) {
    const s   = gradient.getStop(i);
    const col = new Colour(s.colour);
    stops.push({
      position:   s.position,
      midpoint:   (s.midpoint   != null) ? s.midpoint   : 0.5,
      smoothness: (s.smoothness != null) ? s.smoothness : 0,
      noise:      col.noise,
      hslaf:      col.hslaf,
      colHandle:  s.colour
    });
  }
  stops.sort((a, b) => a.position - b.position);
  return stops;
}

function makeColour(s) {
  if (s.colHandle) return new Colour(s.colHandle);
  const col = Colour.createHSLAf(s.hslaf);
  col.noise = s.noise || 0;
  return col;
}

// ── HSL normalisation ─────────────────────────────────────────

function normalizeHSL(hsl) {
  if (hsl.l < 0.001 || hsl.l > 0.999)
    return { h: hsl.h, s: 0, l: hsl.l, alpha: hsl.alpha };
  return hsl;
}
function resolveHue(hsl, partnerHsl) {
  const n = normalizeHSL(hsl);
  return n.s < 0.001 ? { h: partnerHsl.h, s: n.s, l: n.l, alpha: n.alpha } : n;
}

// ── Colour wheel intermediate stops (max 6, min 6°) ──────────

function colorWheelStops(s1, s2, dir) {
  const MAX_PTS = 6, MIN_FRAC = 6 / 360;
  const h1 = resolveHue(normalizeHSL(s1.hslaf), s2.hslaf);
  const h2 = resolveHue(normalizeHSL(s2.hslaf), s1.hslaf);
  let arc = h2.h - h1.h;
  if (dir ===  1 && arc < 0) arc += 1.0;
  if (dir === -1 && arc > 0) arc -= 1.0;
  const n = Math.min(MAX_PTS, Math.floor(Math.abs(arc) / MIN_FRAC));
  if (n <= 0) return [];
  const result = [];
  for (let k = 1; k <= n; k++) {
    const t     = k / (n + 1);
    const h     = ((h1.h + arc * t) % 1.0 + 1.0) % 1.0;
    const s     = h1.s     + (h2.s     - h1.s)     * t;
    const l     = h1.l     + (h2.l     - h1.l)     * t;
    const alpha = h1.alpha + (h2.alpha - h1.alpha) * t;
    const noise = (s1.noise || 0) + ((s2.noise || 0) - (s1.noise || 0)) * t;
    const mp    = (k === n) ? s1.midpoint : 0.5;
    result.push({
      position: s1.position + (s2.position - s1.position) * t,
      midpoint: mp, smoothness: 0, noise,
      hslaf: { h, s, l, alpha }, colHandle: null
    });
  }
  return result;
}

function applyColorWheel(stops, dir) {
  if (dir === 0) return stops.map(s => ({ ...s }));
  const result = [];
  for (let i = 0; i < stops.length; i++) {
    result.push(stops[i]);
    if (i < stops.length - 1)
      for (const m of colorWheelStops(stops[i], stops[i+1], dir))
        result.push(m);
  }
  return result;
}

// ── Duplicate / Mirror (with optional alternating CW/CCW) ──────

function buildStops(rawStops, blendDir, dupCount, doMirror, altCW) {
  if (dupCount <= 1) return applyColorWheel(rawStops, blendDir);

  const scale = 1.0 / dupCount;
  const result = [];

  for (let rep = 0; rep < dupCount; rep++) {
    const offset   = rep * scale;
    const mirrored = doMirror && (rep % 2 === 1);

    let localStops;
    if (mirrored) {
      const nn = rawStops.length;
      localStops = [];
      for (let i = 0; i < nn; i++) {
        const oi = nn - 1 - i;
        const mp = oi > 0 ? (1 - rawStops[oi-1].midpoint) : 0.5;
        localStops.push({ ...rawStops[oi], position: 1.0 - rawStops[oi].position, midpoint: mp });
      }
    } else {
      localStops = rawStops.map(s => ({ ...s }));
    }

    let segDir = blendDir;
    if (altCW && mirrored && blendDir !== 0) segDir = -blendDir;

    const expanded = applyColorWheel(localStops, segDir);

    for (let i = 0; i < expanded.length; i++) {
      const isLast = i === expanded.length - 1;
      let pos = offset + expanded[i].position * scale;
      if (doMirror && rep > 0 && i === 0) {
        if (result.length > 0) result[result.length - 1].midpoint = expanded[0].midpoint;
        continue;
      }
      if (!doMirror && isLast && rep < dupCount - 1) pos -= EPSILON;
      result.push({ ...expanded[i], position: pos });
    }
  }
  return result;
}

// ── Colour stop spacing redistribution ─────────────────────────

function getFMIndices(stops) {
  return stops.map((s, i) => s.colHandle !== null ? i : -1).filter(i => i >= 0);
}
function getSegments(stops, fmIdxs) {
  const segs = [];
  for (let k = 0; k < fmIdxs.length - 1; k++) {
    const si = fmIdxs[k], ei = fmIdxs[k+1], midIdxs = [];
    for (let i = si+1; i < ei; i++) midIdxs.push(i);
    segs.push({ startIdx: si, midIdxs, endIdx: ei });
  }
  return segs;
}
function powerRedistribute(fp, exp) {
  const n = fp.length;
  if (n < 3) return fp.slice();
  const p0 = fp[0], p1 = fp[n-1], r = [p0];
  for (let i = 1; i < n-1; i++) r.push(p0 + Math.pow(i/(n-1), exp) * (p1-p0));
  r.push(p1); return r;
}
function jitterRedistribute(fp, mn, mx, rng) {
  const n = fp.length;
  if (n < 3) return fp.slice();
  const g = [];
  for (let i = 0; i < n-1; i++) g.push(fp[i+1]-fp[i]);
  const ng = g.map(x => Math.max(0.0001, x*(1+(mn+rng()*(mx-mn))/100)));
  const tot = fp[n-1]-fp[0], sc = tot/ng.reduce((a,b)=>a+b,0);
  const sc2 = ng.map(x=>x*sc);
  const r = [fp[0]]; let p = fp[0];
  for (let i = 0; i < sc2.length-1; i++) { p += sc2[i]; r.push(p); }
  r.push(fp[n-1]); return r;
}
function redistZM(stops, fmIdxs, nfp) {
  const segs = getSegments(stops, fmIdxs);
  const res  = stops.map(s => ({...s}));
  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si];
    const os = stops[seg.startIdx].position, oe = stops[seg.endIdx].position;
    const ns = nfp[si], ne = nfp[si+1], ol = oe-os;
    res[seg.startIdx].position = ns;
    res[seg.endIdx].position   = ne;
    if (ol > 0.00001)
      for (const mi of seg.midIdxs)
        res[mi].position = ns + (stops[mi].position - os)/ol * (ne-ns);
  }
  return res;
}
function applyRedistribution(stops, exp, jmn, jmx, uj, rng) {
  const idx = getFMIndices(stops);
  if (idx.length < 2) return stops.slice();
  let fp = idx.map(i => stops[i].position);
  if (Math.abs(exp-1) > 0.001) fp = powerRedistribute(fp, exp);
  if (uj && (jmn!==0||jmx!==0)) fp = jitterRedistribute(fp, jmn, jmx, rng);
  let res = redistZM(stops, idx, fp);
  const oMn = stops[0].position, oMx = stops[stops.length-1].position;
  const cMn = res[0].position,   cMx = res[res.length-1].position;
  const sp  = cMx - cMn;
  if (sp > 0.00001)
    res = res.map(s => ({...s, position: oMn+(s.position-cMn)/sp*(oMx-oMn)}));
  return res;
}

// ── Colour jitter (saturation/lightness/alpha per stop) ────────

function applyColourJitter(stops, satPct, lightPct, alphaPct, rng) {
  if (satPct === 0 && lightPct === 0 && alphaPct === 0) return stops;
  return stops.map(s => {
    const base = s.colHandle ? new Colour(s.colHandle).hslaf : s.hslaf;
    const sF = 1 + (rng()*2-1) * (satPct/100);
    const lF = 1 + (rng()*2-1) * (lightPct/100);
    const aF = 1 + (rng()*2-1) * (alphaPct/100);
    return {
      ...s,
      hslaf: {
        h: base.h,
        s: clamp01(base.s * sF),
        l: clamp01(base.l * lF),
        alpha: clamp01(base.alpha * aF)
      },
      colHandle: null
    };
  });
}

// ── Build FillDescriptor ────────────────────────────────────────

function buildFD(newStops, origFd, origFill) {
  const gi = newStops.map(s => ({
    colour:   makeColour(s),
    position: s.position,
    midpoint: s.midpoint != null ? s.midpoint : 0.5
  }));
  const ng  = Gradient.create(gi);
  const ngf = origFill.cloneWithNewGradient(ng);
  return FillDescriptor.create(ngf, origFd.isScaleWithObject,
    origFd.transform, origFd.blendMode, origFd.isAnchoredToSpread);
}

// ── Detect marked character range ──────────────────────────────

function getMarkedTextRange(doc) {
  if (doc.selection.length === 0) return null;
  const item = doc.selection.at(0);
  const node = item.node;
  if (!node.storyInterface) return null;

  let textSel = null;
  for (const s of item.subSelections) {
    if (s[Symbol.toStringTag] === 'TextSelection') { textSel = s; break; }
  }
  if (!textSel || textSel.rangeCount === 0) return null;

  const caret  = textSel.caret;
  const anchor = textSel.anchor;
  const startIdx = Math.min(caret, anchor);
  const endIdx   = Math.max(caret, anchor);
  if (endIdx <= startIdx) return null;

  return { node, startIdx, endIdx };
}

function isTextNode(node) {
  const tag = node[Symbol.toStringTag] || '';
  return tag === 'ArtTextNode' || tag === 'FrameTextNode';
}

function getReadFD(node, usePen, rangeInfo) {
  if (isTextNode(node)) {
    const story = node.storyInterface?.story;
    if (!story || story.length === 0) return null;
    const idx = rangeInfo ? rangeInfo.startIdx : 0;
    const a = story.getGlyphAtts(idx);
    return usePen ? a.penFill : a.brushFill;
  }
  return usePen ? node.penFillDescriptor : node.brushFillDescriptor;
}

function applyFD(doc, newFd, usePen, rangeInfo) {
  if (rangeInfo) {
    const delta = usePen ? StoryDelta.createPenFill(newFd) : StoryDelta.createBrushFill(newFd);
    doc.formatText(delta, doc.selection, false);
  } else if (usePen) {
    doc.executeCommand(DocumentCommand.createSetPenFill(doc.selection, newFd));
  } else {
    doc.executeCommand(DocumentCommand.createSetBrushFill(doc.selection, newFd));
  }
}

// ── Preset directory ────────────────────────────────────────────

function presetsDir() {
  return app.userDesktopPath + '/AffinityScriptPresets';
}
function ensurePresetsDir() {
  try {
    const dom = require('affinity:dom');
    if (dom.FileSystemApi?.createDirectories) dom.FileSystemApi.createDirectories(presetsDir());
  } catch (e) { /* directory probably already exists */ }
}
function baseName(path) {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1];
}

// ── Main ──────────────────────────────────────────────────────

const doc = Document.current;
const sel = doc.selection;

function showMsg(msg) {
  const d = Dialog.create('Gradient Tweak');
  d.initialWidth = 420;
  d.addColumn().addGroup('').addStaticText('', msg);
  d.runModal();
}

// Marker-count warning: true=proceed, false=cancel
function checkMarkerWarning(count) {
  if (count <= WARN_THRESHOLD) return true;
  return app.confirm(
    'The gradient contains ' + count + ' colour stops. ' +
    'This may affect performance. Continue anyway?',
    'Many colour stops');
}

if (sel.length === 0) {
  showMsg('Please select an object first.');
} else {
  const rangeInfo = getMarkedTextRange(doc);
  const node   = rangeInfo ? rangeInfo.node : sel.at(0).node;
  const isText = isTextNode(node);

  const label = {
    srcGrp:    rangeInfo ? 'Gradient source (marked range)'
             : isText     ? 'Gradient source (Text)'
             :              'Gradient source',
    fillOpt:   isText ? 'Text fill (default)' : 'Fill (default)',
    strokeOpt: isText ? 'Text stroke' : 'Stroke',
    noFill:    isText ? 'The text fill has no gradient.' : 'The fill has no gradient.',
    noStroke:  isText ? 'The text stroke has no gradient.' : 'The stroke has no gradient.',
  };

  const dlg = Dialog.create('Gradient Tweak');
  dlg.initialWidth = 820;
  dlg.setIsResizable(true);
  const col1 = dlg.addColumn();
  const col2 = dlg.addColumn();
  col1.widthProportion = 0.5;
  col2.widthProportion = 0.5;

  const grp0  = col1.addGroup(label.srcGrp);
  const rgSrc = grp0.addRadioGroup('', [label.fillOpt, label.strokeOpt], 0);

  const grp1    = col1.addGroup('Colour Blending');
  const rgBlend = grp1.addRadioGroup('',
    ['Linear', 'Colour wheel CW', 'Colour wheel CCW'], 0);
  const cbAltCW = grp1.addCheckBox('Alternate CW/CCW on mirror', false);

  const grp2  = col1.addGroup('Duplicates');
  const dupEd = grp2.addUnitValueEditor('Count', 'none', 'none', 2, 2, 32);
  dupEd.value = 2;
  const rgDup = grp2.addRadioGroup('',
    ['No duplicate', 'Duplicate', 'Duplicate and mirror'], 0);
  dupEd.isEnabled = false;

  const grp3  = col1.addGroup('Stop spacing - Power function');
  const expEd = grp3.addUnitValueEditor('Exponent', 'none', 'none', 1, 0.1, 10.0);
  expEd.value = 1.0;
  grp3.addStaticText('', 'Exp < 1: denser at end  |  Exp > 1: denser at start');

  const grp4     = col2.addGroup('Stop spacing - Jitter');
  const cbJit    = grp4.addCheckBox('Enable jitter', false);
  const jitMinEd = grp4.addUnitValueEditor('Min. jitter %', 'none', 'none', -30, -99, 0);
  jitMinEd.value = -30;
  const jitMaxEd = grp4.addUnitValueEditor('Max. jitter %', 'none', 'none',  50,   0, 500);
  jitMaxEd.value = 50;
  jitMinEd.isEnabled = false;
  jitMaxEd.isEnabled = false;

  const grp5      = col2.addGroup('Colour Stops - Colour Jitter');
  const cbColJit  = grp5.addCheckBox('Enable colour jitter', false);
  const satJitEd  = grp5.addUnitValueEditor('Saturation %', 'none', 'none', 0, -100, 100);
  satJitEd.value = 0;
  const lightJitEd = grp5.addUnitValueEditor('Lightness %', 'none', 'none', 0, -100, 100);
  lightJitEd.value = 0;
  const alphaJitEd = grp5.addUnitValueEditor('Alpha %', 'none', 'none', 0, -100, 100);
  alphaJitEd.value = 0;
  satJitEd.isEnabled = false; lightJitEd.isEnabled = false; alphaJitEd.isEnabled = false;

  const grp6   = col2.addGroup('Randomness');
  const seedEd = grp6.addUnitValueEditor('Seed', 'none', 'none', 1, 0, 999999);
  seedEd.value = 1;
  grp6.addStaticText('', 'Same seed = reproducible result');

  const grp7        = col2.addGroup('Status');
  const statusText  = grp7.addStaticText('', 'Ready.');

  const grpTools     = col2.addGroup('Tools');
  const btnReset      = grpTools.addButton('Reset (Original)');
  const btnPresetSave = grpTools.addButton('Save preset');
  const btnPresetLoad = grpTools.addButton('Load preset');

  const grpAct = col2.addGroup('');
  const btnSet = grpAct.addButtonSet('', ['Preview', 'Apply'], 0);

  dlg.setOnControlValueChangedHandler(() => {
    dupEd.isEnabled     = rgDup.selectedIndex > 0;
    jitMinEd.isEnabled  = cbJit.value;
    jitMaxEd.isEnabled  = cbJit.value;
    satJitEd.isEnabled  = cbColJit.value;
    lightJitEd.isEnabled = cbColJit.value;
    alphaJitEd.isEnabled = cbColJit.value;
  });

  let undoCount     = 0;
  let lastParamsKey = null;
  let lastStopCount = 0;

  function currentParamsKey() {
    return JSON.stringify([
      rgSrc.selectedIndex, rgBlend.selectedIndex, cbAltCW.value,
      rgDup.selectedIndex, dupEd.value,
      expEd.value,
      cbJit.value, jitMinEd.value, jitMaxEd.value,
      cbColJit.value, satJitEd.value, lightJitEd.value, alphaJitEd.value,
      seedEd.value
    ]);
  }

  function collectFields() {
    return {
      src: rgSrc.selectedIndex, blend: rgBlend.selectedIndex, altCW: cbAltCW.value,
      dupMode: rgDup.selectedIndex, dupCount: dupEd.value,
      exp: expEd.value,
      jitOn: cbJit.value, jitMin: jitMinEd.value, jitMax: jitMaxEd.value,
      colJitOn: cbColJit.value, satJit: satJitEd.value, lightJit: lightJitEd.value, alphaJit: alphaJitEd.value,
      seed: seedEd.value
    };
  }
  function applyFields(d) {
    if (d.src        != null) rgSrc.selectedIndex   = d.src;
    if (d.blend       != null) rgBlend.selectedIndex = d.blend;
    if (d.altCW       != null) cbAltCW.value         = d.altCW;
    if (d.dupMode     != null) rgDup.selectedIndex   = d.dupMode;
    if (d.dupCount    != null) dupEd.value           = d.dupCount;
    if (d.exp         != null) expEd.value           = d.exp;
    if (d.jitOn       != null) cbJit.value           = d.jitOn;
    if (d.jitMin      != null) jitMinEd.value        = d.jitMin;
    if (d.jitMax      != null) jitMaxEd.value        = d.jitMax;
    if (d.colJitOn    != null) cbColJit.value        = d.colJitOn;
    if (d.satJit      != null) satJitEd.value        = d.satJit;
    if (d.lightJit    != null) lightJitEd.value      = d.lightJit;
    if (d.alphaJit    != null) alphaJitEd.value       = d.alphaJit;
    if (d.seed        != null) seedEd.value           = d.seed;
    dupEd.isEnabled      = rgDup.selectedIndex > 0;
    jitMinEd.isEnabled   = cbJit.value;
    jitMaxEd.isEnabled   = cbJit.value;
    satJitEd.isEnabled   = cbColJit.value;
    lightJitEd.isEnabled = cbColJit.value;
    alphaJitEd.isEnabled = cbColJit.value;
  }

  // ── Tool buttons ─────────────────────────────────────────────

  btnReset.setOnClickHandler(() => {
    for (let i = 0; i < undoCount; i++) doc.undo();
    undoCount = 0;
    lastParamsKey = null;
    lastStopCount = 0;
    statusText.text = 'Reset to original.';
  });

  btnPresetSave.setOnClickHandler(() => {
    const name = app.prompt('Enter preset name:', 'Save preset', '');
    if (!name || !name.trim()) return;
    try {
      ensurePresetsDir();
      const path = presetsDir() + '/GradientTweak_' + name.trim() + '.json';
      const f = new File(path, 'wb');
      f.writeStringAsUtf8(JSON.stringify(collectFields(), null, 2));
      f.close();
      statusText.text = 'Preset saved: ' + name.trim();
    } catch (e) {
      statusText.text = 'Error saving: ' + e.message;
    }
  });

  // Load preset: native file picker instead of typing a name
  btnPresetLoad.setOnClickHandler(() => {
    const path = app.chooseFile();
    if (!path) return;
    try {
      const buf  = File.readAll(path);
      const data = JSON.parse(buf.toString());
      applyFields(data);
      statusText.text = 'Preset loaded: ' + baseName(path);
    } catch (e) {
      statusText.text = 'Error loading: ' + e.message;
    }
  });

  // ── Dialog loop ──────────────────────────────────────────────
  while (true) {
    const result = dlg.runModal();

    if (!result || result.value !== DialogResult.Ok.value) {
      for (let i = 0; i < undoCount; i++) doc.undo();
      break;
    }

    const action    = btnSet.selectedIndex;
    const usePen    = rgSrc.selectedIndex === 1;
    const nowKey    = currentParamsKey();
    const unchanged = (undoCount > 0 && lastParamsKey === nowKey);

    if (action === 1 && unchanged) {
      if (!checkMarkerWarning(lastStopCount)) continue;
      break;
    }

    const blendDir = rgBlend.selectedIndex === 1 ?  1
                   : rgBlend.selectedIndex === 2 ? -1 : 0;
    const dupMode  = rgDup.selectedIndex;
    const dupCount = dupMode === 0 ? 1 : Math.max(2, Math.round(dupEd.value));
    const doMirror = dupMode === 2;
    const altCW    = cbAltCW.value;
    const expVal   = Math.max(0.1, expEd.value);
    const useJit   = cbJit.value;
    const jitMin   = jitMinEd.value;
    const jitMax   = Math.max(jitMin, jitMaxEd.value);
    const useColJit  = cbColJit.value;
    const satJit     = satJitEd.value;
    const lightJit   = lightJitEd.value;
    const alphaJit   = alphaJitEd.value;
    const seedVal    = Math.round(seedEd.value) || 1;

    const fd = getReadFD(node, usePen, rangeInfo);
    if (!fd || fd.fill.fillType.value !== 3) {
      showMsg(usePen ? label.noStroke : label.noFill);
      continue;
    }

    for (let i = 0; i < undoCount; i++) doc.undo();
    undoCount = 0;

    const fdFresh  = getReadFD(node, usePen, rangeInfo);
    const origFill = fdFresh.fill;
    const rawStops = readRawStops(origFill.gradient);

    const rng = mulberry32(seedVal);
    let newStops = buildStops(rawStops, blendDir, dupCount, doMirror, altCW);
    newStops = applyRedistribution(newStops, expVal, jitMin, jitMax, useJit, rng);
    if (useColJit) newStops = applyColourJitter(newStops, satJit, lightJit, alphaJit, rng);

    // Marker-count warning (Preview AND Apply)
    if (!checkMarkerWarning(newStops.length)) continue;

    const newFd = buildFD(newStops, fdFresh, origFill);

    if (action === 0) {
      applyFD(doc, newFd, usePen, rangeInfo);
      undoCount     = 1;
      lastParamsKey = nowKey;
      lastStopCount = newStops.length;
      statusText.text = newStops.length + ' colour stops after processing.';
    } else {
      applyFD(doc, newFd, usePen, rangeInfo);
      break;
    }
  }
}
