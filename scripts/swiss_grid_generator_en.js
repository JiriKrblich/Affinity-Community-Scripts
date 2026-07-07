'use strict';

const { Document } = require('/document');
const { Dialog, DialogResult } = require('/dialog');
const { UnitType } = require('/units');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');

const VERSION = 'v1.2';

const RATIO_VALUES = [1.618, 1.414, 1.5, 1.333, 1.25, 2];

const doc = Document.current;
if (!doc) {
  console.log('[Swiss Grid] No document open.');
} else {

  const dpi    = doc.dpi;
  const W      = doc.widthPixels;
  const H      = doc.heightPixels;
  const conv   = doc.unitValueConverter;
  const mmToPx = conv.getConversionFactor(UnitType.Millimetre, UnitType.Pixel);
  const pxToMm = 1 / mmToPx;

  console.log('[Swiss Grid] Doc: ' + (W*pxToMm).toFixed(1) + 'x' + (H*pxToMm).toFixed(1) + ' mm @ ' + dpi + 'dpi');

  const PRESETS = [
    null,
    { cols: 8,  rows: 8,  marginR: 0.057, gutterR: 0.019 },
    { cols: 6,  rows: 6,  marginR: 0.048, gutterR: 0.024 },
    { cols: 3,  rows: 4,  marginR: 0.086, gutterR: 0.029 },
    { cols: 2,  rows: 3,  marginR: 0.119, gutterR: 0.038 },
    { cols: 12, rows: 1,  marginR: 0.067, gutterR: 0.022 },
    { cols: 4,  rows: 3,  marginR: 0.083, gutterR: 0.033 },
  ];

  const COL_OPTIONS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 24, 32];
  const ROW_OPTIONS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32];

  const dlg = Dialog.create('Swiss Grid Explorer ' + VERSION);
  dlg.initialWidth = 420;

  const col1 = dlg.addColumn();
  col1.widthProportion = 1.4;
  const col2 = dlg.addColumn();
  col2.widthProportion = 1;

  const grpGrid   = col1.addGroup('Grid');
  const colsCombo = grpGrid.addComboBox('Columns', COL_OPTIONS.map(String), COL_OPTIONS.indexOf(8));
  const rowsCombo = grpGrid.addComboBox('Rows',    ROW_OPTIONS.map(String), ROW_OPTIONS.indexOf(8));
  const margEdit  = grpGrid.addUnitValueEditor('Margins', UnitType.Pixel, UnitType.Millimetre, 12 * mmToPx, 0, null);
  margEdit.value = 12 * mmToPx; // workaround: Affinity SDK bug resets value to 0 when maxValue is null
  const guttEdit  = grpGrid.addUnitValueEditor('Gutter',  UnitType.Pixel, UnitType.Millimetre,  4 * mmToPx, 0, null);
  guttEdit.value = 4 * mmToPx; // workaround: same SDK bug

  const grpOpts  = col1.addGroup('Generate');
  const chkOuter = grpOpts.addCheckBox('Outer margins', true);
  const chkInner = grpOpts.addCheckBox('Inner guides',  true);
  const chkBase  = grpOpts.addCheckBox('Baseline grid', false);
  const baseEdit = grpOpts.addUnitValueEditor('Baseline spacing', UnitType.Pixel, UnitType.Millimetre, 5 * mmToPx, 0.5 * mmToPx, null);
  baseEdit.value = 5 * mmToPx; // workaround: same SDK bug
  baseEdit.isEnabled = false;

  const grpHarmonic  = col1.addGroup('Harmonic Mode');
  const chkHarmonic  = grpHarmonic.addCheckBox('Link margin/gutter to a ratio', false);
  const ratioCombo   = grpHarmonic.addComboBox('Ratio', [
    'Phi - Golden (1.618)',
    'sqrt(2) (1.414)',
    'Fifth - 3:2 (1.5)',
    'Fourth - 4:3 (1.333)',
    'Major third - 5:4 (1.25)',
    'Octave - 2:1 (2.0)',
  ], 0);
  ratioCombo.isEnabled = false;
  const harmBaseEdit = grpHarmonic.addUnitValueEditor('Base unit', UnitType.Pixel, UnitType.Millimetre, 8 * mmToPx, 0.5 * mmToPx, null);
  harmBaseEdit.value = 8 * mmToPx; // workaround: same SDK bug -- this was the root cause of Harmonic Mode "doing nothing"
  harmBaseEdit.isEnabled = false;

  const grpPresets  = col2.addGroup('Iconic Presets');
  const presetCombo = grpPresets.addComboBox('Preset', [
    '- none -',
    'Brockmann  8x8',
    'Gerstner   6x6',
    'Vignelli   3x4',
    'Tschichold 2x3',
    'Digital 12',
    'Slides 4x3',
  ], 0);

  const grpInfo   = col2.addGroup('Calculated module');
  const infoSize  = grpInfo.addStaticText('Size',  '-');
  const infoRatio = grpInfo.addStaticText('Ratio', '-');
  const infoCnt   = grpInfo.addStaticText('Total', '-');

  function getCols() { return COL_OPTIONS[colsCombo.selectedIndex]; }
  function getRows() { return ROW_OPTIONS[rowsCombo.selectedIndex]; }

  function updateInfo() {
    const cols = getCols(), rows = getRows();
    const m = margEdit.value, g = guttEdit.value;
    const modW = (W - 2*m - (cols - 1)*g) / cols;
    const modH = (H - 2*m - (rows - 1)*g) / rows;
    if (modW > 0 && modH > 0) {
      infoSize.text  = (modW * pxToMm).toFixed(2) + ' x ' + (modH * pxToMm).toFixed(2) + ' mm';
      infoRatio.text = (modW / modH).toFixed(3);
      infoCnt.text   = (cols * rows) + ' modules';
    } else {
      infoSize.text  = 'Margins too large';
      infoRatio.text = '-';
      infoCnt.text   = '-';
    }
  }

  function buildCmds() {
    const cols = getCols(), rows = getRows();
    const m = margEdit.value, g = guttEdit.value;
    const modW = (W - 2*m - (cols - 1)*g) / cols;
    const modH = (H - 2*m - (rows - 1)*g) / rows;
    if (modW <= 0 || modH <= 0) return null;

    const cmds = [];
    if (chkOuter.value) {
      cmds.push(DocumentCommand.createAddGuide(false, m));
      cmds.push(DocumentCommand.createAddGuide(false, W - m));
      cmds.push(DocumentCommand.createAddGuide(true,  m));
      cmds.push(DocumentCommand.createAddGuide(true,  H - m));
    }
    if (chkInner.value) {
      let x = m;
      for (let c = 0; c < cols - 1; c++) {
        x += modW; cmds.push(DocumentCommand.createAddGuide(false, x));
        x += g;    cmds.push(DocumentCommand.createAddGuide(false, x));
      }
      let y = m;
      for (let r = 0; r < rows - 1; r++) {
        y += modH; cmds.push(DocumentCommand.createAddGuide(true, y));
        y += g;    cmds.push(DocumentCommand.createAddGuide(true, y));
      }
    }
    if (chkBase.value && baseEdit.value > 0) {
      const step = baseEdit.value;
      let count = 0;
      for (let y = step; y < H && count < 300; y += step, count++) {
        cmds.push(DocumentCommand.createAddGuide(true, y));
      }
    }
    return cmds;
  }

  // Holds margin/gutter from just before harmonic mode was switched on, so
  // switching it back off can restore them instead of leaving the
  // harmonic-derived numbers in place permanently.
  let lastHarmonicOn = false;
  let preHarmonicSnapshot = null;

  // Derives margin, gutter and (optionally) baseline spacing from a single
  // base value and a master ratio, the same modular-scale logic used by the
  // web app's harmonic mode: gutter = base, margin = base x ratio, baseline
  // = base / ratio. Margin/gutter fields are locked (read-only) while this
  // is on, since their value is computed rather than entered by hand.
  function applyHarmonic() {
    const on = chkHarmonic.value;

    if (on && !lastHarmonicOn) {
      preHarmonicSnapshot = { margin: margEdit.value, gutter: guttEdit.value };
    } else if (!on && lastHarmonicOn) {
      // Just turned off. If an iconic preset caused this (it sets its own
      // deliberate margin/gutter), that value wins -- don't clobber it with
      // the older manual snapshot.
      if (preHarmonicSnapshot && !applyingPreset) {
        const halfMm = 0.5 * mmToPx;
        const cols = getCols(), rows = getRows();
        const fits = (m, g) => (W - 2*m - (cols-1)*g)/cols > 0 && (H - 2*m - (rows-1)*g)/rows > 0;
        let m = preHarmonicSnapshot.margin, g = preHarmonicSnapshot.gutter, attempts = 0;
        // Cols/rows/doc size may have changed while harmonic mode was on --
        // revalidate the restored values still produce a fitting grid.
        while (!fits(m, g) && attempts < 30) {
          m = Math.round(m * 0.8 / halfMm) * halfMm;
          g = Math.max(halfMm, Math.round(g * 0.8 / halfMm) * halfMm);
          attempts++;
        }
        margEdit.value = m;
        guttEdit.value = g;
      }
      preHarmonicSnapshot = null;
    }
    lastHarmonicOn = on;

    ratioCombo.isEnabled   = on;
    harmBaseEdit.isEnabled = on;
    margEdit.isEnabled = !on;
    guttEdit.isEnabled = !on;
    baseEdit.isEnabled = chkBase.value && !on;
    if (!on) return;

    const halfMm = 0.5 * mmToPx;
    const cols = getCols(), rows = getRows();
    const r = RATIO_VALUES[ratioCombo.selectedIndex];
    const fits = (m, g) => (W - 2*m - (cols-1)*g)/cols > 0 && (H - 2*m - (rows-1)*g)/rows > 0;

    let base = harmBaseEdit.value;
    let m = Math.round((base * r) / halfMm) * halfMm;
    let g = Math.max(halfMm, Math.round(base / halfMm) * halfMm);
    let attempts = 0;
    while (!fits(m, g) && attempts < 30) {
      base *= 0.85;
      m = Math.round((base * r) / halfMm) * halfMm;
      g = Math.max(halfMm, Math.round(base / halfMm) * halfMm);
      attempts++;
    }

    margEdit.value = m;
    guttEdit.value = g;
    if (chkBase.value) {
      baseEdit.value = Math.max(halfMm, Math.round((base / r) / halfMm) * halfMm);
    }
  }

  function runPreview() {
    applyHarmonic();
    doc.clearPreviews();
    const cmds = buildCmds();
    if (!cmds || cmds.length === 0) { updateInfo(); return; }
    const builder = CompoundCommandBuilder.create();
    for (const cmd of cmds) builder.addCommand(cmd);
    doc.executeCommand(builder.createCommand(), true);
    updateInfo();
  }

  function applyPreset(idx) {
    if (idx === 0) return;
    const p      = PRESETS[idx];
    const minDim = Math.min(W, H);
    const halfMm = 0.5 * mmToPx;
    let m = Math.round((minDim * p.marginR) / halfMm) * halfMm;
    let g = Math.max(halfMm, Math.round((minDim * p.gutterR) / halfMm) * halfMm);
    for (let i = 0; i < 20; i++) {
      if ((W - 2*m - (p.cols - 1)*g) / p.cols > 0 &&
          (H - 2*m - (p.rows - 1)*g) / p.rows > 0) break;
      m = Math.round(m * 0.8 / halfMm) * halfMm;
      g = Math.max(halfMm, Math.round(g * 0.8 / halfMm) * halfMm);
    }
    // An iconic preset is a deliberate manual choice of margin/gutter
    // character, so it takes precedence over harmonic mode for this run.
    chkHarmonic.value = false;
    const ci = COL_OPTIONS.indexOf(p.cols);
    const ri = ROW_OPTIONS.indexOf(p.rows);
    if (ci >= 0) colsCombo.selectedIndex = ci;
    if (ri >= 0) rowsCombo.selectedIndex = ri;
    margEdit.value = m;
    guttEdit.value = g;
  }

  let applyingPreset = false;

  chkBase.onValueChangedHandler = () => {
    baseEdit.isEnabled = chkBase.value && !chkHarmonic.value;
    runPreview();
  };

  presetCombo.onValueChangedHandler = () => {
    if (presetCombo.selectedIndex === 0) return;
    applyingPreset = true;
    applyPreset(presetCombo.selectedIndex);
    runPreview();
    applyingPreset = false;
  };

  dlg.onControlValueChangedHandler = () => {
    if (!applyingPreset) runPreview();
  };

  runPreview();

  if (dlg.runModal() === DialogResult.Ok) {
    doc.clearPreviews();
    const cmds = buildCmds();
    if (cmds && cmds.length > 0) {
      const builder = CompoundCommandBuilder.create();
      for (const cmd of cmds) builder.addCommand(cmd);
      doc.executeCommand(builder.createCommand());
      const cols = getCols(), rows = getRows();
      const m = margEdit.value, g = guttEdit.value;
      const modW = ((W - 2*m - (cols-1)*g) / cols * pxToMm).toFixed(2);
      const modH = ((H - 2*m - (rows-1)*g) / rows * pxToMm).toFixed(2);
      console.log('[Swiss Grid] OK ' + cmds.length + ' guides | ' + cols + 'x' + rows + ' | module ' + modW + 'x' + modH + ' mm');
    }
  } else {
    doc.clearPreviews();
    console.log('[Swiss Grid] Cancelled.');
  }

}
