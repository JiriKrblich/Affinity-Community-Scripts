'use strict';
// ===== PODHOD Engraving =====
// Select an object -> run -> parameters dialog -> new layer on top of the selection.
// Settings are remembered in the document (node tag).
// =====
// Based on $Dollar Bill texture shader by Praveen Kumar
// https://www.figma.com/community/file/1686908159036705400/dollar-bill-texture-shader
const { app } = require('/application.js');
const { Document } = require('/document.js');
const { Dialog, DialogResult, UnitType } = require('/dialog.js');
const { ImageNodeDefinition } = require('/nodes.js');
const { PixelBuffer, NodeRenderingEngine, RasterFormat } = require('/rasterobject.js');
const { Transform } = require('/geometry.js');
const { DocumentCommand } = require('/commands.js');
const { Selection } = require('/selections.js');
const { Colour } = require('/colours.js');
const { File } = require('/fs.js');

const PREVIEW_MAX = 1200;     // longest side (px) of the preview render
const TAG_KEY = 'EngravingShaderSettings';
const SETTINGS_NAME = 'engraving_shader_settings.json';  // Desktop (best effort)

// ---------- DEFAULTS ----------
const DEFAULTS = {
  ink: { r: 0.075, g: 0.22, b: 0.34, a: 1 },
  paper: { r: 0.96, g: 0.935, b: 0.865, a: 1 },
  accent: { r: 0.7, g: 0.31, b: 0.12, a: 1 },
  preserveHue: true, hue: 25, tolerance: 24, feather: 12, minSaturation: 16,
  accentStrength: 100, shadowProtection: 65, accentMode: 0, maskPreview: false,
  spacing: 3.2, lineWeight: 100, angle: -7, flow: 65, crosshatch: 65,
  guilloche: 90, placement: 1, patternExtent: 40, patternScale: 125, curvature: 100,
  exposure: 0.35, contrast: 1.08, gamma: 0.85, detail: 0.7,
  grain: 20, wear: 12, stipple: 30, keepAlpha: true, amount: 100,
  scale: 100,
};

// [type, key, label, ...] ; num: min, max, precision ; select: options
const UI = [
  { groups: [
    { name: 'Ink & paper', items: [
      ['color', 'ink', 'Main ink'],
      ['color', 'paper', 'Paper colour'] ] },
    { name: 'Hue accent', items: [
      ['bool', 'preserveHue', 'Preserve selected hue'],
      ['num', 'hue', 'Selected hue (deg)', 0, 360, 0],
      ['num', 'tolerance', 'Hue tolerance (deg)', 1, 180, 0],
      ['num', 'feather', 'Hue feather (deg)', 1, 60, 0],
      ['num', 'minSaturation', 'Minimum saturation', 0, 90, 0],
      ['num', 'accentStrength', 'Accent strength', 0, 100, 0],
      ['num', 'shadowProtection', 'Keep shadows in main ink', 0, 100, 0],
      ['select', 'accentMode', 'Accent colour mode', ['Original hue - printed ink', 'Custom accent ink']],
      ['color', 'accent', 'Custom accent ink'],
      ['bool', 'maskPreview', 'Preview selected hue mask'] ] } ] },
  { groups: [
    { name: 'Engraving lines', items: [
      ['num', 'spacing', 'Engraving spacing', 0.8, 12, 1],
      ['num', 'lineWeight', 'Line weight', 40, 160, 0],
      ['num', 'angle', 'Engraving angle', -90, 90, 0],
      ['num', 'flow', 'Contour flow', 0, 160, 0],
      ['num', 'crosshatch', 'Shadow crosshatching', 0, 100, 0] ] },
    { name: 'Guilloche', items: [
      ['num', 'guilloche', 'Guilloche strength', 0, 100, 0],
      ['select', 'placement', 'Guilloche placement', ['All smooth regions', 'Upper smooth regions', 'Whole image']],
      ['num', 'patternExtent', 'Upper region reach', 0, 100, 0],
      ['num', 'patternScale', 'Guilloche scale', 40, 300, 0],
      ['num', 'curvature', 'Guilloche curvature', 0, 160, 0] ] } ] },
  { groups: [
    { name: 'Tone', items: [
      ['num', 'exposure', 'Exposure', -2, 2, 2],
      ['num', 'contrast', 'Contrast', 0.5, 2, 2],
      ['num', 'gamma', 'Tone curve', 0.4, 2, 2],
      ['num', 'detail', 'Architectural detail', 0, 2, 2] ] },
    { name: 'Finish', items: [
      ['num', 'grain', 'Paper grain', 0, 100, 0],
      ['num', 'wear', 'Ink wear', 0, 100, 0],
      ['num', 'stipple', 'Fine stippling', 0, 100, 0],
      ['bool', 'keepAlpha', 'Preserve image transparency'],
      ['num', 'amount', 'Effect amount', 0, 100, 0] ] },
    { name: 'Output', items: [
      ['num', 'scale', 'Output resolution (%)', 10, 100, 0] ] } ] },
];

// ---------- SETTINGS (document tag first, Desktop file as fallback) ----------
const clone = o => JSON.parse(JSON.stringify(o));
const settingsPath = () => app.userDesktopPath + '/' + SETTINGS_NAME;

function sanitize(saved) {
  const P = clone(DEFAULTS);
  if (saved && typeof saved === 'object')
    for (const k of Object.keys(DEFAULTS))
      if (k in saved && typeof saved[k] === typeof DEFAULTS[k]) P[k] = saved[k];
  return P;
}

function readTag(node) {
  try {
    const ti = node.tagInterface;
    if (ti && ti.hasKey(TAG_KEY)) return JSON.parse(ti.getValueForKey(TAG_KEY));
  } catch (e) { }
  return null;
}

function loadSettings(doc, selNode) {
  let saved = selNode ? readTag(selNode) : null, from = 'tag:selection';
  if (!saved) {   // newest layer (front-most) that carries settings
    const layers = doc.layers.toArray();
    for (let i = layers.length - 1; i >= 0 && !saved; i--) { saved = readTag(layers[i]); from = 'tag:document'; }
  }
  if (!saved) {
    try { saved = JSON.parse(File.readAll(settingsPath()).toString('utf-8')); from = 'desktop file'; } catch (e) { saved = null; }
  }
  if (!saved) from = 'defaults';
  console.log('Settings loaded from: ' + from);
  return sanitize(saved);
}

function saveSettings(doc, node, P) {
  const json = JSON.stringify(P);
  try {
    doc.executeCommand(DocumentCommand.createSetTagValueForKey(Selection.create(doc, node), TAG_KEY, json));
  } catch (e) { console.log('Could not store settings in the document: ' + e); }
  try {
    const f = File.create(settingsPath(), 'w');
    f.writeStringAsUtf8(JSON.stringify(P, null, 2));
    f.close();
  } catch (e) { /* Desktop not writable - fine */ }
}

// ---------- DIALOG ----------
const toColour = c => Colour.createRGBA8({ r: Math.round(c.r * 255), g: Math.round(c.g * 255), b: Math.round(c.b * 255), alpha: Math.round(c.a * 255) });
const fromColour = col => { const v = col.rgba8; return { r: v.r / 255, g: v.g / 255, b: v.b / 255, a: v.alpha / 255 }; };

function buildDialog(P, onPreview, onReset) {
  const dlg = Dialog.create('PODHOD Engraving');
  const ctrls = {};
  let lastCol = null;
  for (const col of UI) {
    const c = dlg.addColumn();
    lastCol = c;
    for (const g of col.groups) {
      const grp = c.addGroup(g.name);
      for (const it of g.items) {
        const [type, key, label] = it;
        if (type === 'num') {
          const v = Math.min(it[4], Math.max(it[3], P[key]));
          ctrls[key] = grp.addUnitValueEditor(label, UnitType.Number, UnitType.Number, v, it[3], it[4])
            .setShowPopupSlider(true).setPrecision(it[5]);
        } else if (type === 'bool') ctrls[key] = grp.addCheckBox(label, P[key]);
        else if (type === 'select') ctrls[key] = grp.addComboBox(label, it[3], P[key]);
        else if (type === 'color') ctrls[key] = grp.addColourPicker(label, toColour(P[key]));
      }
    }
  }
  // Preview / Reset: one row at the bottom of the last (right-most) column, just above the OK / Cancel row
  // (the Dialog API cannot add buttons to the OK / Cancel row itself)
  const stack = lastCol.addGroup('').addColumnStack();
  stack.addColumn().addGroup('').addButton('Preview').setIsFullWidth(true).setOnClickHandler(onPreview);
  stack.addColumn().addGroup('').addButton('Reset').setIsFullWidth(true).setOnClickHandler(onReset);
  return { dlg, ctrls };
}

function readDialog(ctrls) {
  const out = clone(DEFAULTS);
  for (const col of UI) for (const g of col.groups) for (const it of g.items) {
    const [type, key] = it, c = ctrls[key];
    if (type === 'num' || type === 'bool') out[key] = c.value;
    else if (type === 'select') out[key] = c.selectedIndex;
    else if (type === 'color') out[key] = fromColour(c.value);
  }
  return out;
}

function resetDialog(ctrls) {
  for (const col of UI) for (const g of col.groups) for (const it of g.items) {
    const [type, key] = it, c = ctrls[key];
    if (type === 'num' || type === 'bool') c.value = DEFAULTS[key];
    else if (type === 'select') c.selectedIndex = DEFAULTS[key];
    else if (type === 'color') c.value = toColour(DEFAULTS[key]);
  }
}

// ---------- SHADER (CPU port) ----------
const cl = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
const fr = x => x - Math.floor(x);
const ss = (e0, e1, x) => { let t = (x - e0) / (e1 - e0); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
function hash2(px, py) {
  let qx = fr(px * 0.1031), qy = fr(py * 0.1030), qz = fr(px * 0.0973);
  const d = qx * (qy + 33.33) + qy * (qz + 33.33) + qz * (qx + 33.33);
  qx += d; qy += d; qz += d;
  return fr((qx + qy) * qz);
}
function lineCoverage(phase, amount, fw) {
  const cov = cl(amount, 0, 1);
  const aa = Math.max(fw * 0.65, 0.0001);
  const d = Math.abs(fr(phase + 0.5) - 0.5);
  const resolved = 1 - ss(cov * 0.5 - aa, cov * 0.5 + aa, d);
  return mix(resolved, cov, ss(0.45, 1.25, fw));
}
const HOFF = [0, 2 / 3, 1 / 3];
function hsvRGB(h, s, v, out) {
  for (let i = 0; i < 3; i++) {
    const p = Math.abs(fr(h + HOFF[i]) * 6 - 3);
    out[i] = v * mix(1, cl(p - 1, 0, 1), s);
  }
}

// bilinear index table for a 1D axis: sample positions uv[i] (clamped 0..1) on N texels
function axis(uvs, N) {
  const n = uvs.length, i0 = new Int32Array(n), i1 = new Int32Array(n), f = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = cl(uvs[i], 0, 1) * N - 0.5;
    const b = Math.floor(t);
    f[i] = t - b; i0[i] = cl(b, 0, N - 1); i1[i] = cl(b + 1, 0, N - 1);
  }
  return { i0, i1, f };
}

// maxSide > 0 caps the longest output side (used for fast previews)
function process(node, P, maxSide) {
  const t0 = Date.now();
  const eng = NodeRenderingEngine.createDefault(node, RasterFormat.RGBA8);
  const SW = eng.width, SH = eng.height;
  const src = new Uint8Array(eng.createCompatibleBuffer(true).buffer);

  let sc = P.scale / 100;
  if (maxSide > 0) sc = Math.min(sc, maxSide / Math.max(SW, SH));
  sc = cl(sc, 0.02, 1);
  const w = Math.max(1, Math.round(SW * sc)), h = Math.max(1, Math.round(SH * sc));
  const short = Math.min(w, h);
  const zw = w / short * 1000, zh = h / short * 1000;   // size.zw
  const S = 1000 / short;                               // "p" units per output pixel

  // premultiplied luminance + alpha of the source (for blur moments)
  const L = new Float32Array(SW * SH), A = new Float32Array(SW * SH);
  for (let i = 0, j = 0; i < SW * SH; i++, j += 4) {
    const a = src[j + 3] / 255;
    A[i] = a; L[i] = (0.2126 * src[j] + 0.7152 * src[j + 1] + 0.0722 * src[j + 2]) / 255 * a;
  }

  // ---- blur field (max 1536px) ----
  const fsc = Math.min(1, 1536 / Math.max(w, h));
  const fw = Math.max(1, Math.round(w * fsc)), fh = Math.max(1, Math.round(h * fsc));
  const f0 = new Float32Array(fw * fh * 3), f1 = new Float32Array(fw * fh * 3);
  const rx = 6 / zw, ry = 6 / zh;
  const KW = new Float32Array(17); let KS = 0;
  for (let k = 0; k < 17; k++) { const f = (k - 8) / 4; KW[k] = Math.exp(-0.5 * f * f); KS += KW[k]; }

  // pass 1: horizontal, source -> (lum*a, lum^2*a, a)
  {
    const us = new Float32Array(fw); for (let i = 0; i < fw; i++) us[i] = (i + 0.5) / fw;
    const vs = new Float32Array(fh); for (let i = 0; i < fh; i++) vs[i] = (i + 0.5) / fh;
    const ay = axis(vs, SH);
    const XI0 = new Int32Array(fw * 17), XI1 = new Int32Array(fw * 17), XF = new Float32Array(fw * 17);
    for (let fx = 0; fx < fw; fx++) {
      const uvs = new Float32Array(17); for (let k = 0; k < 17; k++) uvs[k] = us[fx] + rx * (k - 8) / 4;
      const ax = axis(uvs, SW);
      XI0.set(ax.i0, fx * 17); XI1.set(ax.i1, fx * 17); XF.set(ax.f, fx * 17);
    }
    for (let fy = 0; fy < fh; fy++) {
      const r0 = ay.i0[fy] * SW, r1 = ay.i1[fy] * SW, yf = ay.f[fy], yg = 1 - yf;
      for (let fx = 0; fx < fw; fx++) {
        let m0 = 0, m1 = 0, m2 = 0; const b = fx * 17;
        for (let k = 0; k < 17; k++) {
          const x0 = XI0[b + k], x1 = XI1[b + k], xf = XF[b + k], xg = 1 - xf;
          const l = (L[r0 + x0] * xg + L[r0 + x1] * xf) * yg + (L[r1 + x0] * xg + L[r1 + x1] * xf) * yf;
          const a = (A[r0 + x0] * xg + A[r0 + x1] * xf) * yg + (A[r1 + x0] * xg + A[r1 + x1] * xf) * yf;
          const lum = l / Math.max(a, 0.00001), wt = KW[k];
          m0 += l * wt; m1 += lum * l * wt; m2 += a * wt;
        }
        const o = (fy * fw + fx) * 3;
        f0[o] = m0 / KS; f0[o + 1] = m1 / KS; f0[o + 2] = m2 / KS;
      }
    }
  }
  // pass 2: vertical on f0 -> f1
  for (let fy = 0; fy < fh; fy++) {
    const uvs = new Float32Array(17); for (let k = 0; k < 17; k++) uvs[k] = (fy + 0.5) / fh + ry * (k - 8) / 4;
    const ay = axis(uvs, fh);
    for (let fx = 0; fx < fw; fx++) {
      let m0 = 0, m1 = 0, m2 = 0;
      for (let k = 0; k < 17; k++) {
        const a = (ay.i0[k] * fw + fx) * 3, b = (ay.i1[k] * fw + fx) * 3, t = ay.f[k], wt = KW[k];
        m0 += (f0[a] + (f0[b] - f0[a]) * t) * wt;
        m1 += (f0[a + 1] + (f0[b + 1] - f0[a + 1]) * t) * wt;
        m2 += (f0[a + 2] + (f0[b + 2] - f0[a + 2]) * t) * wt;
      }
      const o = (fy * fw + fx) * 3;
      f1[o] = m0 / KS; f1[o + 1] = m1 / KS; f1[o + 2] = m2 / KS;
    }
  }
  const tBlur = Date.now();

  // ---- uniforms ----
  const U = {
    exposure: P.exposure, contrast: P.contrast, gamma: P.gamma, detail: P.detail,
    spacing: Math.max(0.8, P.spacing), lineWeight: P.lineWeight / 100, angle: P.angle * Math.PI / 180, flow: P.flow / 100,
    guilloche: P.guilloche / 100, period: Math.max(30, P.patternScale), curvature: P.curvature / 100, crosshatch: P.crosshatch / 100,
    grain: P.grain / 100, wear: P.wear / 100, stipple: P.stipple / 100, placement: P.placement,
    preserveHue: P.preserveHue ? 1 : 0, hue: P.hue / 360, tolerance: P.tolerance / 360, feather: P.feather / 360,
    minSat: P.minSaturation / 100, accentStrength: P.accentStrength / 100, accentMode: P.accentMode, maskPreview: P.maskPreview ? 1 : 0,
    amount: P.amount / 100, extent: P.patternExtent / 100, shadowProt: P.shadowProtection / 100, keepAlpha: P.keepAlpha ? 1 : 0,
  };
  const ink = P.ink, paper = P.paper, accent = P.accent;
  const sp = U.spacing, cA = Math.cos(U.angle), sA = Math.sin(U.angle);
  const grainVis = 1 - ss(1, 3, S * Math.SQRT2);
  const TWO_PI = Math.PI * 2;

  // ---- sampling tables ----
  const cu = new Float32Array(w), lu = new Float32Array(w), ru = new Float32Array(w);
  for (let x = 0; x < w; x++) { cu[x] = (x + 0.5) / w; lu[x] = cu[x] - 2 / zw; ru[x] = cu[x] + 2 / zw; }
  const cv = new Float32Array(h);
  for (let y = 0; y < h; y++) cv[y] = (y + 0.5) / h;
  const XC = axis(cu, fw), XL = axis(lu, fw), XR = axis(ru, fw);
  const YC = axis(cv, fh);
  const direct = (w === SW && h === SH);
  const SX = axis(cu, SW), SY = axis(cv, SH);

  const out = PixelBuffer.create(w, h, RasterFormat.RGBA8);
  const dst = new Uint8Array(out.buffer);
  const tmp = [0, 0, 0];
  const fwOf = (gx, gy) => S * (Math.abs(gx * cA + gy * sA) + Math.abs(-gx * sA + gy * cA));

  for (let y = 0; y < h; y++) {
    const yc0 = YC.i0[y], yc1 = YC.i1[y], ycf = YC.f[y];
    const py = (y + 0.5) * S, uvy = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      // --- source (premultiplied) ---
      let sr, sg, sb, sa;
      if (direct) {
        const i = (y * SW + x) * 4; sa = src[i + 3] / 255;
        const k = sa / 255; sr = src[i] * k; sg = src[i + 1] * k; sb = src[i + 2] * k;
      } else {
        const x0 = SX.i0[x], x1 = SX.i1[x], xf = SX.f[x], y0 = SY.i0[y], y1 = SY.i1[y], yf = SY.f[y];
        const i00 = (y0 * SW + x0) * 4, i10 = (y0 * SW + x1) * 4, i01 = (y1 * SW + x0) * 4, i11 = (y1 * SW + x1) * 4;
        const a00 = src[i00 + 3] / 65025, a10 = src[i10 + 3] / 65025, a01 = src[i01 + 3] / 65025, a11 = src[i11 + 3] / 65025;
        const bl = (c) => ((src[i00 + c] * a00 * (1 - xf) + src[i10 + c] * a10 * xf) * (1 - yf) + (src[i01 + c] * a01 * (1 - xf) + src[i11 + c] * a11 * xf) * yf);
        sr = bl(0); sg = bl(1); sb = bl(2);
        sa = ((src[i00 + 3] * (1 - xf) + src[i10 + 3] * xf) * (1 - yf) + (src[i01 + 3] * (1 - xf) + src[i11 + 3] * xf) * yf) / 255;
      }
      const ia = Math.max(sa, 0.00001);
      const rr = cl(sr / ia, 0, 1), gg = cl(sg / ia, 0, 1), bb = cl(sb / ia, 0, 1);

      // --- field moments ---
      const xc0 = XC.i0[x], xc1 = XC.i1[x], xcf = XC.f[x];
      const a00 = (yc0 * fw + xc0) * 3, a10 = (yc0 * fw + xc1) * 3, a01 = (yc1 * fw + xc0) * 3, a11 = (yc1 * fw + xc1) * 3;
      const m0 = (f1[a00] * (1 - xcf) + f1[a10] * xcf) * (1 - ycf) + (f1[a01] * (1 - xcf) + f1[a11] * xcf) * ycf;
      const m1 = (f1[a00 + 1] * (1 - xcf) + f1[a10 + 1] * xcf) * (1 - ycf) + (f1[a01 + 1] * (1 - xcf) + f1[a11 + 1] * xcf) * ycf;
      const m2 = (f1[a00 + 2] * (1 - xcf) + f1[a10 + 2] * xcf) * (1 - ycf) + (f1[a01 + 2] * (1 - xcf) + f1[a11 + 2] * xcf) * ycf;
      const mean = m0 / Math.max(m2, 0.00001);
      const variance = Math.sqrt(Math.max(m1 / Math.max(m2, 0.00001) - mean * mean, 0));

      const originalLum = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;

      // --- hue ---
      const hi = Math.max(rr, gg, bb), lo = Math.min(rr, gg, bb), dlt = hi - lo;
      let hh = 0;
      if (dlt > 0.00001) { if (hi === rr) hh = (gg - bb) / dlt; else if (hi === gg) hh = (bb - rr) / dlt + 2; else hh = (rr - gg) / dlt + 4; }
      const hueV = fr(hh / 6 + 1), satV = dlt / Math.max(hi, 0.00001);
      const dh = Math.abs(hueV - U.hue), hueDistance = Math.min(dh, 1 - dh);
      const hueMask = 1 - ss(U.tolerance, U.tolerance + Math.max(U.feather, 0.0028), hueDistance);
      const satMask = ss(U.minSat, U.minSat + 0.08, satV);
      const shadows = mix(1, ss(0.06, 0.42, originalLum), U.shadowProt);
      const accentMask = hueMask * satMask * U.preserveHue * U.accentStrength * shadows;

      // --- tone ---
      const detailed = cl(originalLum + (originalLum - mean) * U.detail, 0, 1);
      let lum = Math.pow(cl(detailed * Math.pow(2, U.exposure), 0, 1), U.gamma);
      lum = cl((lum - 0.5) * U.contrast + 0.5, 0, 1);
      const darkness = cl(1 - lum, 0, 1);

      // --- gradient of field.r (only x part is used by the shader) ---
      const lx0 = XL.i0[x], lx1 = XL.i1[x], lxf = XL.f[x], rx0 = XR.i0[x], rx1 = XR.i1[x], rxf = XR.f[x];
      const r0 = yc0 * fw, r1 = yc1 * fw;
      const lR = (f1[(r0 + lx0) * 3] * (1 - lxf) + f1[(r0 + lx1) * 3] * lxf) * (1 - ycf) + (f1[(r1 + lx0) * 3] * (1 - lxf) + f1[(r1 + lx1) * 3] * lxf) * ycf;
      const rR = (f1[(r0 + rx0) * 3] * (1 - rxf) + f1[(r0 + rx1) * 3] * rxf) * (1 - ycf) + (f1[(r1 + rx0) * 3] * (1 - rxf) + f1[(r1 + rx1) * 3] * rxf) * ycf;
      const gradX = rR - lR;

      // --- line phases ---
      const px = (x + 0.5) * S;
      const ptx = px * cA - py * sA, pty = px * sA + py * cA;
      const a1 = ptx * 0.022, a2 = ptx * 0.054 + pty * 0.017;
      const flowing = U.flow * (26 * mean + 4 * Math.sin(a1) + 1.8 * Math.sin(a2));
      const phase = (pty + flowing + U.flow * gradX * 22) / sp;
      const crossPhase = (ptx * 0.88 + pty * 0.47 - flowing * 0.4) / sp;
      // analytic fwidth (approx: ignores field variation)
      const fpx = U.flow * (4 * 0.022 * Math.cos(a1) + 1.8 * 0.054 * Math.cos(a2));
      const fpy = U.flow * 1.8 * 0.017 * Math.cos(a2);
      const fwPhase = fwOf(fpx / sp, (1 + fpy) / sp);
      const fwCross = fwOf((0.88 - 0.4 * fpx) / sp, (0.47 - 0.4 * fpy) / sp);

      const crossAmount = U.crosshatch * ss(0.12, 0.8, darkness);
      const primary = 1 - Math.pow(Math.max(0.00001, 1 - darkness), 1 - crossAmount * 0.55);
      const secondary = 1 - Math.pow(Math.max(0.00001, 1 - darkness), crossAmount * 0.55);
      const dens = U.lineWeight;
      const la = lineCoverage(phase, primary * dens, fwPhase);
      const ld = lineCoverage(crossPhase, secondary * dens, fwCross);
      let engraving = 1 - (1 - la) * (1 - ld);

      // --- guilloche ---
      const period = U.period, qx = ptx / period, qy = pty / period;
      const drift = 0.35 * Math.sin(qx * 2.2);
      const amp = U.curvature * period * 0.24;
      const argA = qy * TWO_PI + drift, argB = qy * TWO_PI - drift + 1.6;
      const waveA = amp * Math.sin(argA), waveB = amp * Math.sin(argB);
      const g1 = (ptx * 0.82 + pty * 0.55 + waveA) / (sp * 1.65);
      const g2 = (ptx * 0.82 - pty * 0.55 - waveB) / (sp * 1.65);
      const dd = 0.35 * Math.cos(qx * 2.2) * 2.2 / period;
      const dAx = amp * Math.cos(argA) * dd, dAy = amp * Math.cos(argA) * TWO_PI / period;
      const dBx = -amp * Math.cos(argB) * dd, dBy = amp * Math.cos(argB) * TWO_PI / period;
      const fw1 = fwOf((0.82 + dAx) / (sp * 1.65), (0.55 + dAy) / (sp * 1.65));
      const fw2 = fwOf((0.82 - dBx) / (sp * 1.65), (-0.55 - dBy) / (sp * 1.65));
      const ga = lineCoverage(g1, 0.10 * dens, fw1), gb = lineCoverage(g2, 0.10 * dens, fw2);
      const guilloche = 1 - (1 - ga) * (1 - gb);

      const smoothArea = (1 - ss(0.008, 0.065, variance)) * ss(0.12, 0.5, mean);
      const upperRegion = 1 - ss(U.extent, Math.min(1.01, U.extent + 0.12), uvy);
      let placement = smoothArea;
      if (U.placement > 0.5) placement *= upperRegion;
      if (U.placement > 1.5) placement = 1;
      placement *= 1 - accentMask;
      const ornamental = cl(guilloche * 0.7 + darkness * 0.15, 0, 1);
      engraving = mix(engraving, ornamental, placement * U.guilloche);

      // --- grain / stipple / wear ---
      const noise = hash2(Math.floor(px * 1.7), Math.floor(py * 1.7));
      const fineNoise = hash2(Math.floor(px * 3.9) + 17, Math.floor(py * 3.9) + 17);
      const stipple = ss(0.84, 1, fineNoise) * darkness * (1 - engraving) * U.stipple * grainVis;
      engraving = cl(engraving + stipple, 0, 1);
      engraving *= 1 - U.wear * ss(0.82, 1, noise) * 0.42 * grainVis;

      // --- colours ---
      let ar, ag, ab, aAlpha;
      if (U.accentMode > 0.5) { ar = accent.r; ag = accent.g; ab = accent.b; aAlpha = accent.a; }
      else { hsvRGB(hueV, cl(satV * 0.8 + 0.06, 0.20, 0.78), 0.60, tmp); ar = tmp[0]; ag = tmp[1]; ab = tmp[2]; aAlpha = 1; }
      const cr = mix(ink.r, ar, accentMask), cg = mix(ink.g, ag, accentMask), cb = mix(ink.b, ab, accentMask);
      const pk = 1 - U.grain * (noise - 0.3) * 0.075 * grainVis;
      const pr = cl(paper.r * pk, 0, 1), pg = cl(paper.g * pk, 0, 1), pb = cl(paper.b * pk, 0, 1);
      const inkA = mix(ink.a, aAlpha, accentMask);
      let or_ = mix(pr * paper.a, cr * inkA, engraving);
      let og = mix(pg * paper.a, cg * inkA, engraving);
      let ob = mix(pb * paper.a, cb * inkA, engraving);
      let oa = mix(paper.a, inkA, engraving);
      const ka = 1 - U.keepAlpha + U.keepAlpha * sa;
      or_ *= ka; og *= ka; ob *= ka; oa *= ka;
      or_ = mix(sr, or_, U.amount); og = mix(sg, og, U.amount); ob = mix(sb, ob, U.amount); oa = mix(sa, oa, U.amount);
      if (U.maskPreview > 0.5) { or_ = og = ob = accentMask * sa; oa = sa; }

      const o = (y * w + x) * 4;
      if (oa > 0.00001) {
        dst[o] = cl(or_ / oa, 0, 1) * 255 + 0.5; dst[o + 1] = cl(og / oa, 0, 1) * 255 + 0.5; dst[o + 2] = cl(ob / oa, 0, 1) * 255 + 0.5;
      } else { dst[o] = 0; dst[o + 1] = 0; dst[o + 2] = 0; }
      dst[o + 3] = cl(oa, 0, 1) * 255 + 0.5;
    }
  }
  console.log('Engraving: ' + SW + 'x' + SH + ' -> ' + w + 'x' + h + ', blur ' + (tBlur - t0) + ' ms, total ' + (Date.now() - t0) + ' ms');
  return { buf: out, w, h };
}

// ---------- MAIN ----------
function main() {
  const doc = Document.current;
  if (!doc) { console.log('No open document'); return; }
  const sel = doc.selection.nodes.toArray();   // BEFORE runModal: the dialog resets the selection
  if (!sel.length) {
    console.log('Select an object and run the script again');
    try { app.alert('Select an object and run the script again'); } catch (e) { }
    return;
  }
  const source = sel[0];
  const svb = source.getSpreadBaseBox(false);

  // new layer placed exactly over the source's bounds (transform is set before insertion, so previews line up too)
  function addResult(r, preview) {
    const def = ImageNodeDefinition.create(RasterFormat.RGBA8);
    def.userDescription = 'PODHOD Engraving';
    def.bitmap = r.buf.createCompatibleBitmap(true);
    def.transform = Transform.createTranslate(svb.x, svb.y).multiply(Transform.createScale(svb.width / r.w, svb.height / r.h));
    doc.addNode(def, null, undefined, preview);
    const added = doc.selection.nodes.toArray();
    return added.find(n => n.userDescription === 'PODHOD Engraving') || added[added.length - 1];
  }

  let P = loadSettings(doc, source);

  let ui;
  const onPreview = () => {
    try {
      const pr = process(source, readDialog(ui.ctrls), PREVIEW_MAX);
      doc.clearPreviews();
      addResult(pr, true);
    } catch (e) { console.log('Preview failed: ' + e); }
  };
  const onReset = () => { try { resetDialog(ui.ctrls); } catch (e) { console.log('Reset failed: ' + e); } };
  ui = buildDialog(P, onPreview, onReset);
  let res;
  try { res = ui.dlg.runModal(); }
  finally { try { doc.clearPreviews(); } catch (e) { } }
  if (res.value !== DialogResult.Ok.value) return;
  P = readDialog(ui.ctrls);

  const node = addResult(process(source, P, 0), false);
  if (!node) { console.log('New node not found'); return; }
  saveSettings(doc, node, P);
  console.log('OK');
}
main();
