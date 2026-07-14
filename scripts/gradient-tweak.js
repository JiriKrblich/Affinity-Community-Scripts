
'use strict';

// ── Gradient Tweak v16 (English) ──────────────────────────────
// New: power redistribution and jitter of colour stop spacing

const { Dialog, DialogResult } = require('/dialog');
const { Document }             = require('/document');
const { FillDescriptor }       = require('/fills');
const { Gradient, Colour }     = require('/colours');
const { DocumentCommand }      = require('/commands');

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

// ── Stop spacing redistribution ───────────────────────────────

function getFMIndices(stops) {
  return stops.map((s, i) => s.colHandle !== null ? i : -1).filter(i => i >= 0);
}

function getSegments(stops, fmIdxs) {
  const segs = [];
  for (let k = 0; k < fmIdxs.length - 1; k++) {
    const startIdx = fmIdxs[k], endIdx = fmIdxs[k + 1];
    const midIdxs = [];
    for (let i = startIdx + 1; i < endIdx; i++) midIdxs.push(i);
    segs.push({ startIdx, midIdxs, endIdx });
  }
  return segs;
}

// Power redistribution: exp>1 → denser at start, exp<1 → denser at end
function powerRedistribute(fmPositions, exp) {
  const n = fmPositions.length;
  if (n < 3) return fmPositions.slice();
  const p0 = fmPositions[0], p1 = fmPositions[n-1];
  const result = [p0];
  for (let i = 1; i < n - 1; i++)
    result.push(p0 + Math.pow(i / (n - 1), exp) * (p1 - p0));
  result.push(p1);
  return result;
}

// Jitter: random spacing change in percent
function jitterRedistribute(fmPositions, minPct, maxPct) {
  const n = fmPositions.length;
  if (n < 3) return fmPositions.slice();
  const gaps = [];
  for (let i = 0; i < n - 1; i++)
    gaps.push(fmPositions[i + 1] - fmPositions[i]);
  const newGaps = gaps.map(g => {
    const pct = minPct + Math.random() * (maxPct - minPct);
    return Math.max(0.0001, g * (1 + pct / 100));
  });
  const totalOrig = fmPositions[n-1] - fmPositions[0];
  const scale = totalOrig / newGaps.reduce((a, b) => a + b, 0);
  const scaled = newGaps.map(g => g * scale);
  const result = [fmPositions[0]];
  let pos = fmPositions[0];
  for (let i = 0; i < scaled.length - 1; i++) { pos += scaled[i]; result.push(pos); }
  result.push(fmPositions[n-1]);
  return result;
}

// Scale intermediate stops relative to new colour stop positions
function redistributeZM(stops, fmIdxs, newFMPositions) {
  const segs   = getSegments(stops, fmIdxs);
  const result = stops.map(s => ({ ...s }));
  for (let si = 0; si < segs.length; si++) {
    const seg      = segs[si];
    const oldStart = stops[seg.startIdx].position;
    const oldEnd   = stops[seg.endIdx].position;
    const newStart = newFMPositions[si];
    const newEnd   = newFMPositions[si + 1];
    const oldLen   = oldEnd - oldStart;
    result[seg.startIdx].position = newStart;
    result[seg.endIdx].position   = newEnd;
    if (oldLen > 0.00001) {
      for (const mi of seg.midIdxs) {
        const rel = (stops[mi].position - oldStart) / oldLen;
        result[mi].position = newStart + rel * (newEnd - newStart);
      }
    }
  }
  return result;
}

function applyRedistribution(stops, exp, jitMin, jitMax, useJitter) {
  const fmIdxs = getFMIndices(stops);
  if (fmIdxs.length < 2) return stops.slice();
  let fmPos = fmIdxs.map(i => stops[i].position);
  if (Math.abs(exp - 1.0) > 0.001)
    fmPos = powerRedistribute(fmPos, exp);
  if (useJitter && (jitMin !== 0 || jitMax !== 0))
    fmPos = jitterRedistribute(fmPos, jitMin, jitMax);
  let result = redistributeZM(stops, fmIdxs, fmPos);
  // Normalise to original range
  const origMin = stops[0].position, origMax = stops[stops.length-1].position;
  const curMin  = result[0].position, curMax = result[result.length-1].position;
  const span    = curMax - curMin;
  if (span > 0.00001)
    result = result.map(s => ({
      ...s, position: origMin + (s.position - curMin) / span * (origMax - origMin)
    }));
  return result;
}

// ── Build FillDescriptor ──────────────────────────────────────

function buildFD(newStops, origFd, origFill) {
  const gradInput = newStops.map(s => ({
    colour:   makeColour(s),
    position: s.position,
    midpoint: (s.midpoint != null) ? s.midpoint : 0.5
  }));
  const ng  = Gradient.create(gradInput);
  const ngf = origFill.cloneWithNewGradient(ng);
  return FillDescriptor.create(ngf, origFd.isScaleWithObject,
    origFd.transform, origFd.blendMode, origFd.isAnchoredToSpread);
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
  showMsg('Please select an object with a gradient fill first.');
} else {
  const node = sel.at(0).node;
  const fd   = node.brushFillDescriptor;
  if (!fd || fd.fill.fillType.value !== 3) {
    showMsg('The object has no gradient fill - no action.');
  } else {
    const origFill   = fd.fill;
    const rawStops   = readRawStops(origFill.gradient);
    const origFdSnap = fd;

    const dlg = Dialog.create('Gradient Tweak');
    dlg.initialWidth = 420;
    dlg.setIsResizable(true);
    const col1 = dlg.addColumn();

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
      const jitOn        = cbJit.value;
      jitMinEd.isEnabled = jitOn;
      jitMaxEd.isEnabled = jitOn;
    });

    let previewActive = false;

    while (true) {
      const result = dlg.runModal();
      if (!result || result.value !== DialogResult.Ok.value) {
        if (previewActive) node.brushFillDescriptor = origFdSnap;
        break;
      }
      const action   = btnSet.selectedIndex;
      const blendDir = rgBlend.selectedIndex === 1 ?  1
                     : rgBlend.selectedIndex === 2 ? -1 : 0;
      const dupMode  = rgDup.selectedIndex;
      const dupCount = dupMode === 0 ? 1 : Math.max(2, Math.round(dupEd.value));
      const doMirror = dupMode === 2;
      const expVal   = Math.max(0.1, expEd.value);
      const useJit   = cbJit.value;
      const jitMin   = jitMinEd.value;
      const jitMax   = Math.max(jitMin, jitMaxEd.value);

      let newStops = buildStops(rawStops, blendDir, dupCount, doMirror);
      newStops = applyRedistribution(newStops, expVal, jitMin, jitMax, useJit);
      const newFd = buildFD(newStops, origFdSnap, origFill);

      if (action === 0) {
        node.brushFillDescriptor = origFdSnap;
        node.brushFillDescriptor = newFd;
        previewActive = true;
      } else {
        if (previewActive) node.brushFillDescriptor = origFdSnap;
        doc.executeCommand(DocumentCommand.createSetBrushFill(doc.selection, newFd));
        break;
      }
    }
  }
}
