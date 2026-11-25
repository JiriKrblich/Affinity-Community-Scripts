'use strict';

// ── Gradient Tweak v35 EN ─────────────────────────────────────
// v35: Saturation/lightness jitter: Min and Max each -100..+100 (e.g. +20..+50
//      possible). New option ABSOLUTE (percentage points added) or RELATIVE
//      (% of value, value*(1+r)). v33 presets (+/-x relative) load exactly as relative.
// v34: Saturation/lightness jitter with Min/Max in percentage points (absolute).
// v33: Colour jitter extended by the HUE (field "Hue +/- degrees", 0-180).
//      Hue random value only drawn when the field is > 0. Pure greys have
//      no hue: no visible effect there.
// v32: BUGFIX "Reset (original)": the original stays visible until a
//      parameter actually changes. OK while showing the original closes
//      without changes.
// v31: Native live preview (doc.executeCommand(cmd,true) or doc.formatText(...,true)),
//      OK applies as ONE compound command, Cancel discards. Warning for many
//      colour stops only on Apply.
// v30: toColour() for Affinity 3.3.3; preset saving with File.create().
// v28: undo the preview first, then read the original.

const { Dialog, DialogResult } = require('/dialog');
const { Document }             = require('/document');
const { FillDescriptor }       = require('/fills');
const { Gradient, Colour }     = require('/colours');
const { DocumentCommand,
        CompoundCommandBuilder } = require('/commands');
const { StoryDelta }           = require('/storydelta');
const { app }                  = require('/application');
const { File }                 = require('/fs');

const EPSILON = 0.0001;
const WARN_THRESHOLD = 100;

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

// v30: version-safe wrapping (3.3.3+: already a Colour)
function toColour(c) {
  return (c instanceof Colour) ? c : new Colour(c);
}

function readRawStops(gradient) {
  const stops = [];
  for (let i = 0; i < gradient.stopCount; i++) {
    const s   = gradient.getStop(i);
    const col = toColour(s.colour);
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
  if (s.colHandle) return toColour(s.colHandle);
  const col = Colour.createHSLAf(s.hslaf);
  col.noise = s.noise || 0;
  return col;
}
function normalizeHSL(hsl) {
  if (hsl.l < 0.001 || hsl.l > 0.999)
    return { h: hsl.h, s: 0, l: hsl.l, alpha: hsl.alpha };
  return hsl;
}
function resolveHue(hsl, partnerHsl) {
  const n = normalizeHSL(hsl);
  return n.s < 0.001 ? { h: partnerHsl.h, s: n.s, l: n.l, alpha: n.alpha } : n;
}
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

// v35: colour jitter. Saturation/lightness: random value uniform in [Min,Max] (-100..100 %).
// relative=false: ABSOLUTE, percentage points are added. relative=true: RELATIVE, value * (1 + r/100).
// Alpha: relative +/-%. hueDeg: +/- degrees (0 = off, hue random value only drawn when > 0).
function applyColourJitter(stops, satMin, satMax, lightMin, lightMax, relative, alphaPct, hueDeg, rng) {
  if (satMin === 0 && satMax === 0 && lightMin === 0 && lightMax === 0 && alphaPct === 0 && hueDeg === 0) return stops;
  return stops.map(s => {
    const base = s.colHandle ? toColour(s.colHandle).hslaf : s.hslaf;
    const sR = (satMin   + rng() * (satMax   - satMin))   / 100;
    const lR = (lightMin + rng() * (lightMax - lightMin)) / 100;
    const aF = 1 + (rng()*2-1) * (alphaPct/100);
    let h = base.h;
    if (hueDeg > 0) {
      const shift = (rng()*2-1) * (hueDeg/360);
      h = ((base.h + shift) % 1.0 + 1.0) % 1.0;
    }
    const sNew = relative ? base.s * (1 + sR) : base.s + sR;
    const lNew = relative ? base.l * (1 + lR) : base.l + lR;
    return {
      ...s,
      hslaf: { h, s: clamp01(sNew), l: clamp01(lNew), alpha: clamp01(base.alpha*aF) },
      colHandle: null
    };
  });
}
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

// v31: ONE command for all plans (preview or apply), executes nothing.
// Selected text range: FormatText via the current text selection.
function makeCommand(doc, plans, usePen) {
  if (plans.length === 1 && plans[0].rangeInfo) {
    const fd = plans[0].newFd;
    const delta = usePen ? StoryDelta.createPenFill(fd) : StoryDelta.createBrushFill(fd);
    return { delta };
  }
  const cb = CompoundCommandBuilder.create();
  for (const p of plans) {
    cb.addCommand(usePen
      ? DocumentCommand.createSetPenFill(p.node.selfSelection, p.newFd)
      : DocumentCommand.createSetBrushFill(p.node.selfSelection, p.newFd));
  }
  return { cmd: cb.createCommand() };
}
function runCommand(doc, c, preview) {
  if (c.delta) doc.formatText(c.delta, doc.selection, preview);
  else doc.executeCommand(c.cmd, preview);
}

function presetsDir() { return app.userDesktopPath + '/AffinityScriptPresets'; }
function ensurePresetsDir() {
  try {
    const dom = require('affinity:dom');
    if (dom.FileSystemApi?.createDirectories) dom.FileSystemApi.createDirectories(presetsDir());
  } catch (e) {}
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
function checkMarkerWarning(count) {
  if (count <= WARN_THRESHOLD) return true;
  return app.confirm(
    'The largest processed gradient contains ' + count + ' colour stops. ' +
    'This may affect performance. Continue anyway?',
    'Many colour stops');
}

if (sel.length === 0) {
  showMsg('Please select an object first.');
} else {
  const rangeInfo = getMarkedTextRange(doc);
  const targetNodes = rangeInfo ? [rangeInfo.node] : [];
  if (!rangeInfo) for (let i = 0; i < sel.length; i++) targetNodes.push(sel.at(i).node);

  const firstIsText = isTextNode(targetNodes[0]);
  const multi = !rangeInfo && targetNodes.length > 1;

  const label = {
    srcGrp:    rangeInfo ? 'Gradient source (selected range)'
             : multi      ? 'Gradient source (' + targetNodes.length + ' objects)'
             : firstIsText ? 'Gradient source (text)'
             :               'Gradient source',
    fillOpt:   firstIsText ? 'Text fill (default)' : 'Fill (default)',
    strokeOpt: firstIsText ? 'Text stroke' : 'Stroke',
    noFill:    'No selected object has a gradient fill.',
    noStroke:  'No selected object has a gradient stroke.',
  };

  const dlg = Dialog.create('Gradient Tweak v35');
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
  const cbAltCW = grp1.addCheckBox('Alternate CW/CCW when mirroring', false);

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

  const grp5      = col2.addGroup('Colour stops - Colour jitter');
  const cbColJit  = grp5.addCheckBox('Enable colour jitter', false);
  const hueJitEd  = grp5.addUnitValueEditor('Hue +/- degrees', 'none', 'none', 0, 0, 180);
  hueJitEd.value = 0;
  // v35: saturation/lightness: Min/Max each -100..+100 %, absolute/relative mode
  const satMinEd   = grp5.addUnitValueEditor('Saturation Min %', 'none', 'none', 0, -100, 100);
  satMinEd.value = 0;
  const satMaxEd   = grp5.addUnitValueEditor('Saturation Max %', 'none', 'none', 0, -100, 100);
  satMaxEd.value = 0;
  const lightMinEd = grp5.addUnitValueEditor('Lightness Min %', 'none', 'none', 0, -100, 100);
  lightMinEd.value = 0;
  const lightMaxEd = grp5.addUnitValueEditor('Lightness Max %', 'none', 'none', 0, -100, 100);
  lightMaxEd.value = 0;
  const rgJitMode  = grp5.addRadioGroup('', ['Absolute (percentage points)', 'Relative (% of value)'], 0);
  const alphaJitEd = grp5.addUnitValueEditor('Alpha %', 'none', 'none', 0, -100, 100);
  alphaJitEd.value = 0;
  hueJitEd.isEnabled = false; alphaJitEd.isEnabled = false; rgJitMode.isEnabled = false;
  satMinEd.isEnabled = false; satMaxEd.isEnabled = false;
  lightMinEd.isEnabled = false; lightMaxEd.isEnabled = false;

  const grp6   = col2.addGroup('Random');
  const seedEd = grp6.addUnitValueEditor('Seed', 'none', 'none', 1, 0, 999999);
  seedEd.value = 1;
  grp6.addStaticText('', multi
    ? 'Same seed per object = reproducible'
    : 'Same seed = reproducible result');

  const grp7        = col2.addGroup('Status');
  const statusText  = grp7.addStaticText('', 'Ready.');

  const grpTools     = col2.addGroup('Tools');
  const btnReset      = grpTools.addButton('Reset (original)');
  const btnPresetSave = grpTools.addButton('Save preset');
  const btnPresetLoad = grpTools.addButton('Load preset');

  function updateEnabled() {
    dupEd.isEnabled      = rgDup.selectedIndex > 0;
    jitMinEd.isEnabled   = cbJit.value;
    jitMaxEd.isEnabled   = cbJit.value;
    hueJitEd.isEnabled   = cbColJit.value;
    satMinEd.isEnabled   = cbColJit.value;
    satMaxEd.isEnabled   = cbColJit.value;
    lightMinEd.isEnabled = cbColJit.value;
    lightMaxEd.isEnabled = cbColJit.value;
    alphaJitEd.isEnabled = cbColJit.value;
    rgJitMode.isEnabled  = cbColJit.value;
  }

  function collectFields() {
    return {
      src: rgSrc.selectedIndex, blend: rgBlend.selectedIndex, altCW: cbAltCW.value,
      dupMode: rgDup.selectedIndex, dupCount: dupEd.value, exp: expEd.value,
      jitOn: cbJit.value, jitMin: jitMinEd.value, jitMax: jitMaxEd.value,
      colJitOn: cbColJit.value, hueJit: hueJitEd.value, satMin: satMinEd.value, satMax: satMaxEd.value,
      lightMin: lightMinEd.value, lightMax: lightMaxEd.value, alphaJit: alphaJitEd.value,
      jitMode: rgJitMode.selectedIndex,
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
    // v33: older presets (before v33) have no hueJit -> 0
    hueJitEd.value = (d.hueJit != null) ? d.hueJit : 0;
    // v34/v35: Min/Max; older presets (satJit/lightJit, relative +/-)
    // are loaded as -x..+x (and flagged "relative" below).
    if (d.satMin != null || d.satMax != null) {
      satMinEd.value = (d.satMin != null) ? d.satMin : 0;
      satMaxEd.value = (d.satMax != null) ? d.satMax : 0;
    } else {
      const x = Math.abs(d.satJit || 0);
      satMinEd.value = -x; satMaxEd.value = x;
    }
    if (d.lightMin != null || d.lightMax != null) {
      lightMinEd.value = (d.lightMin != null) ? d.lightMin : 0;
      lightMaxEd.value = (d.lightMax != null) ? d.lightMax : 0;
    } else {
      const x = Math.abs(d.lightJit || 0);
      lightMinEd.value = -x; lightMaxEd.value = x;
    }
    // v35: mode; presets without Min/Max (v33, satJit/lightJit relative +/-x) -> relative (exact)
    if (d.jitMode != null) rgJitMode.selectedIndex = d.jitMode;
    else rgJitMode.selectedIndex = (d.satMin == null && d.satMax == null && d.lightMin == null && d.lightMax == null
                                    && (d.satJit || d.lightJit)) ? 1 : 0;
    if (d.alphaJit    != null) alphaJitEd.value       = d.alphaJit;
    if (d.seed        != null) seedEd.value           = d.seed;
    updateEnabled();
  }

  // v31: plans from the current dialog values (read from the original, no change)
  function computePlans(f) {
    doc.clearPreviews();
    const usePen   = f.src === 1;
    const blendDir = f.blend === 1 ? 1 : f.blend === 2 ? -1 : 0;
    const dupCount = f.dupMode === 0 ? 1 : Math.max(2, Math.round(f.dupCount));
    const doMirror = f.dupMode === 2;
    const expVal   = Math.max(0.1, f.exp);
    const jitMin   = f.jitMin;
    const jitMax   = Math.max(jitMin, f.jitMax);
    const seedVal  = Math.round(f.seed) || 1;
    const hueJit   = Math.max(0, f.hueJit || 0);

    const plans = [];
    for (const tgt of targetNodes) {
      const rInfo = rangeInfo && tgt === rangeInfo.node ? rangeInfo : null;
      const fd = getReadFD(tgt, usePen, rInfo);
      if (!fd || fd.fill.fillType.value !== 3) continue;

      const origFill = fd.fill;
      const rawStops = readRawStops(origFill.gradient);
      const rng = mulberry32(seedVal);
      let newStops = buildStops(rawStops, blendDir, dupCount, doMirror, f.altCW);
      newStops = applyRedistribution(newStops, expVal, jitMin, jitMax, f.jitOn, rng);
      if (f.colJitOn) newStops = applyColourJitter(newStops, f.satMin, Math.max(f.satMin, f.satMax), f.lightMin, Math.max(f.lightMin, f.lightMax), f.jitMode === 1, f.alphaJit, hueJit, rng);

      const newFd = buildFD(newStops, fd, origFill);
      plans.push({ node: tgt, newFd, stopCount: newStops.length, rangeInfo: rInfo });
    }
    const maxStopCount = plans.length ? Math.max(...plans.map(p => p.stopCount)) : 0;
    return { plans, usePen, maxStopCount };
  }

  // v31: native live preview (no history entry)
  function updatePreview() {
    doc.clearPreviews();
    try {
      const r = computePlans(collectFields());
      if (!r.plans.length) {
        statusText.text = r.usePen ? label.noStroke : label.noFill;
        return;
      }
      runCommand(doc, makeCommand(doc, r.plans, r.usePen), true);
      statusText.text = 'Preview: ' + r.plans.length + ' of ' + targetNodes.length +
        ' object(s), max. ' + r.maxStopCount + ' colour stops' +
        (r.maxStopCount > WARN_THRESHOLD ? ' (many!)' : '') + '.';
    } catch (e) {
      doc.clearPreviews();
      statusText.text = 'Error: ' + (e && e.message ? e.message : String(e));
    }
  }

  // v32: original display after "Reset" (stays until a parameter changes)
  let showOriginal = false, resetKey = null;
  dlg.setOnControlValueChangedHandler(() => {
    updateEnabled();
    if (showOriginal && JSON.stringify(collectFields()) === resetKey) { doc.clearPreviews(); return; }
    showOriginal = false;
    updatePreview();
  });

  btnReset.setOnClickHandler(() => {
    showOriginal = true;
    resetKey = JSON.stringify(collectFields());
    doc.clearPreviews();
    statusText.text = 'Original shown (changing a parameter shows the preview again).';
  });
  btnPresetSave.setOnClickHandler(() => {
    const name = app.prompt('Enter preset name:', 'Save preset', '');
    if (!name || !name.trim()) return;
    try {
      ensurePresetsDir();
      const path = presetsDir() + '/VerlaufsTweek_' + name.trim() + '.json';
      const f = File.create(path, 'wb');
      f.writeStringAsUtf8(JSON.stringify(collectFields(), null, 2));
      f.close();
      statusText.text = 'Preset saved: ' + name.trim();
    } catch (e) { statusText.text = 'Error saving: ' + e.message; }
  });
  btnPresetLoad.setOnClickHandler(() => {
    const path = app.chooseFile();
    if (!path) return;
    try {
      const data = JSON.parse(File.readAll(path).toString());
      applyFields(data);
      showOriginal = false;
      updatePreview();
      statusText.text = 'Preset loaded: ' + baseName(path);
    } catch (e) { statusText.text = 'Error loading: ' + e.message; }
  });

  // ── Dialog: OK applies, Cancel discards ──────────────────────
  while (true) {
    if (!showOriginal) updatePreview();
    const result = dlg.runModal();
    doc.clearPreviews();

    if (!result || result.value !== DialogResult.Ok.value) break;
    // v32: original shown -> close without changes
    if (showOriginal) break;

    const r = computePlans(collectFields());
    if (r.plans.length === 0) {
      showMsg(r.usePen ? label.noStroke : label.noFill);
      continue;
    }
    if (!checkMarkerWarning(r.maxStopCount)) continue;

    runCommand(doc, makeCommand(doc, r.plans, r.usePen), false);
    break;
  }
}
