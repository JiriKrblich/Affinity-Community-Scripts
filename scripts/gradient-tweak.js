
'use strict';

// ── Gradient Tweak v24 EN ─────────────────────────────────────
// NEW: If a character range is marked with the Text tool (not the
// whole object), ONLY that range is edited — each character can
// have its own fill/stroke.
//
// Technique: doc.selection carries a TextSelection as a sub-
// selection when a character range is marked. StoryDelta.
// createBrushFill/createPenFill + doc.formatText(delta,
// doc.selection, preview) writes specifically to the marked range
// only (verified: neighbouring characters remain unchanged).
//
// Without a marked character range (whole object selected):
// behaves like v23 — writing cascades to the whole text.

const { Dialog, DialogResult } = require('/dialog');
const { Document }             = require('/document');
const { FillDescriptor }       = require('/fills');
const { Gradient, Colour }     = require('/colours');
const { DocumentCommand }      = require('/commands');
const { StoryDelta }           = require('/storydelta');

const EPSILON = 0.0001;

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

// ── Colour wheel intermediate stops ────────────────────────────

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

// ── Duplicate / Mirror ────────────────────────────────────────

function buildStops(rawStops, blendDir, dupCount, doMirror) {
  let stops = rawStops.slice();
  if (blendDir !== 0) {
    const result = [];
    for (let i = 0; i < stops.length; i++) {
      result.push(stops[i]);
      if (i < stops.length - 1)
        for (const m of colorWheelStops(stops[i], stops[i+1], blendDir))
          result.push(m);
    }
    stops = result;
  }
  if (dupCount > 1) {
    const scale = 1.0 / dupCount;
    const result = [];
    for (let rep = 0; rep < dupCount; rep++) {
      const offset   = rep * scale;
      const mirrored = doMirror && (rep % 2 === 1);
      const segStops = [];
      if (mirrored) {
        const nn = stops.length;
        for (let i = 0; i < nn; i++) {
          const oi = nn - 1 - i;
          const mp = oi > 0 ? (1 - stops[oi-1].midpoint) : 0.5;
          segStops.push({ ...stops[oi], segPos: 1.0 - stops[oi].position, midpoint: mp });
        }
      } else {
        for (let i = 0; i < stops.length; i++)
          segStops.push({ ...stops[i], segPos: stops[i].position });
      }
      for (let i = 0; i < segStops.length; i++) {
        const isLast = i === segStops.length - 1;
        let pos = offset + segStops[i].segPos * scale;
        if (doMirror && rep > 0 && i === 0) {
          if (result.length > 0)
            result[result.length - 1].midpoint = segStops[0].midpoint;
          continue;
        }
        if (!doMirror && isLast && rep < dupCount - 1) pos -= EPSILON;
        result.push({ ...segStops[i], position: pos });
      }
    }
    stops = result;
  }
  return stops;
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
function jitterRedistribute(fp, mn, mx) {
  const n = fp.length;
  if (n < 3) return fp.slice();
  const g = [];
  for (let i = 0; i < n-1; i++) g.push(fp[i+1]-fp[i]);
  const ng = g.map(x => Math.max(0.0001, x*(1+(mn+Math.random()*(mx-mn))/100)));
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
function applyRedistribution(stops, exp, jmn, jmx, uj) {
  const idx = getFMIndices(stops);
  if (idx.length < 2) return stops.slice();
  let fp = idx.map(i => stops[i].position);
  if (Math.abs(exp-1) > 0.001) fp = powerRedistribute(fp, exp);
  if (uj && (jmn!==0||jmx!==0)) fp = jitterRedistribute(fp, jmn, jmx);
  let res = redistZM(stops, idx, fp);
  const oMn = stops[0].position, oMx = stops[stops.length-1].position;
  const cMn = res[0].position,   cMx = res[res.length-1].position;
  const sp  = cMx - cMn;
  if (sp > 0.00001)
    res = res.map(s => ({...s, position: oMn+(s.position-cMn)/sp*(oMx-oMn)}));
  return res;
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
// Checks whether doc.selection contains a real (non-empty)
// TextSelection sub-selection. Returns {node, startIdx, endIdx}
// or null if no character range is marked.

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

  // caret/anchor give the actual selection; sort them
  const caret  = textSel.caret;
  const anchor = textSel.anchor;
  const startIdx = Math.min(caret, anchor);
  const endIdx   = Math.max(caret, anchor);
  if (endIdx <= startIdx) return null; // just a caret, no range

  return { node, startIdx, endIdx };
}

// ── isText detection ────────────────────────────────────────────

function isTextNode(node) {
  const tag = node[Symbol.toStringTag] || '';
  return tag === 'ArtTextNode' || tag === 'FrameTextNode';
}

// Reads FD for the range or character 0 (whole-object fallback)
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

// ── Write ────────────────────────────────────────────────────
// With a marked character range: StoryDelta + doc.formatText
// (only that range). Otherwise: node level (cascades to whole text).

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

// ── Main ──────────────────────────────────────────────────────

const doc = Document.current;
const sel = doc.selection;

function showMsg(msg) {
  const d = Dialog.create('Gradient Tweak');
  d.initialWidth = 420;
  d.addColumn().addGroup('').addStaticText('', msg);
  d.runModal();
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
  dlg.initialWidth = 420;
  dlg.setIsResizable(true);
  const col1 = dlg.addColumn();

  const grp0  = col1.addGroup(label.srcGrp);
  const rgSrc = grp0.addRadioGroup('', [label.fillOpt, label.strokeOpt], 0);

  const grp1    = col1.addGroup('Colour Blending');
  const rgBlend = grp1.addRadioGroup('',
    ['Linear', 'Colour wheel CW', 'Colour wheel CCW'], 0);

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

  const grp4     = col1.addGroup('Stop spacing - Jitter');
  const cbJit    = grp4.addCheckBox('Enable jitter', false);
  const jitMinEd = grp4.addUnitValueEditor('Min. jitter %', 'none', 'none', -30, -99, 0);
  jitMinEd.value = -30;
  const jitMaxEd = grp4.addUnitValueEditor('Max. jitter %', 'none', 'none',  50,   0, 500);
  jitMaxEd.value = 50;
  jitMinEd.isEnabled = false;
  jitMaxEd.isEnabled = false;

  const grp5   = col1.addGroup('');
  const btnSet = grp5.addButtonSet('', ['Preview', 'Apply'], 0);

  dlg.setOnControlValueChangedHandler(() => {
    dupEd.isEnabled    = rgDup.selectedIndex > 0;
    jitMinEd.isEnabled = cbJit.value;
    jitMaxEd.isEnabled = cbJit.value;
  });

  let undoCount = 0;

  while (true) {
    const result = dlg.runModal();

    if (!result || result.value !== DialogResult.Ok.value) {
      for (let i = 0; i < undoCount; i++) doc.undo();
      break;
    }

    const action   = btnSet.selectedIndex;
    const usePen   = rgSrc.selectedIndex === 1;
    const blendDir = rgBlend.selectedIndex === 1 ?  1
                   : rgBlend.selectedIndex === 2 ? -1 : 0;
    const dupMode  = rgDup.selectedIndex;
    const dupCount = dupMode === 0 ? 1 : Math.max(2, Math.round(dupEd.value));
    const doMirror = dupMode === 2;
    const expVal   = Math.max(0.1, expEd.value);
    const useJit   = cbJit.value;
    const jitMin   = jitMinEd.value;
    const jitMax   = Math.max(jitMin, jitMaxEd.value);

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

    let newStops = buildStops(rawStops, blendDir, dupCount, doMirror);
    newStops = applyRedistribution(newStops, expVal, jitMin, jitMax, useJit);
    const newFd = buildFD(newStops, fdFresh, origFill);

    if (action === 0) {
      applyFD(doc, newFd, usePen, rangeInfo);
      undoCount = 1;
    } else {
      applyFD(doc, newFd, usePen, rangeInfo);
      break;
    }
  }
}
