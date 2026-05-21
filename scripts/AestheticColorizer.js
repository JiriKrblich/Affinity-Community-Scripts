'use strict';

const { Document }                               = require('/document');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
const { Dialog, DialogResult }                   = require('/dialog');
const { RGBA8 }                                  = require('/colours');
const { FillDescriptor, SolidFill }              = require('/fills');
const { Selection }                              = require('/selections');
const { UnitType }                               = require('/units');
const { app }                                    = require('/application');
const { setTimeout }                             = require('/timers');

const APP_NAME = 'Aesthetic Colorizer';

// ─── colour math ──────────────────────────────────────────────────────────────

function mixRGB(base, target, w) {
  return {
    r: Math.round(base.r * (1 - w) + target.r * w),
    g: Math.round(base.g * (1 - w) + target.g * w),
    b: Math.round(base.b * (1 - w) + target.b * w),
  };
}

function generatePalette(baseRGB, tintSteps, shadeSteps) {
  const WHITE = { r: 255, g: 255, b: 255 };
  const BLACK = { r: 0,   g: 0,   b: 0   };
  const pal   = [];

  for (let i = tintSteps; i >= 1; i--) {
    const c = mixRGB(baseRGB, WHITE, i / (tintSteps + 1));
    pal.push(RGBA8(c.r, c.g, c.b));
  }
  pal.push(RGBA8(baseRGB.r, baseRGB.g, baseRGB.b));
  for (let i = 1; i <= shadeSteps; i++) {
    const c = mixRGB(baseRGB, BLACK, i / (shadeSteps + 1));
    pal.push(RGBA8(c.r, c.g, c.b));
  }

  return pal;
}

// ─── seeded shuffle (xorshift32 + Fisher-Yates) ───────────────────────────────

function shufflePalette(palette, seed) {
  if (seed <= 0) return palette.slice();
  const arr = palette.slice();
  let s = (seed ^ 0xdeadbeef) >>> 0;
  for (let i = arr.length - 1; i > 0; i--) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s = s >>> 0;
    const j = s % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ─── node helpers ─────────────────────────────────────────────────────────────

function collectLeaves(node, out) {
  let kids = [];
  try { kids = [...node.children]; } catch (_) {}
  if (kids.length === 0) { out.push(node); return; }
  for (const k of kids) collectLeaves(k, out);
}

// ─── apply ────────────────────────────────────────────────────────────────────

function buildCommand(doc, leaves, palette, seed) {
  const pal = shufflePalette(palette, seed);
  const cb  = CompoundCommandBuilder.create();
  let n = 0;

  leaves.forEach((node, i) => {
    try {
      const colour = pal[i % pal.length];
      const fd     = FillDescriptor.createSolid(SolidFill.create(colour));
      cb.addCommand(DocumentCommand.createSetBrushFill(
        Selection.create(doc, node), fd
      ));
      n++;
    } catch (_) {}
  });

  return n > 0 ? cb.createCommand() : null;
}

function restoreHistory(doc, pos) {
  try { if (doc.history.position !== pos) doc.history.position = pos; } catch (_) {}
}

function restoreSelection(doc, nodes) {
  try { doc.selection = Selection.create(doc, nodes); } catch (_) {}
}

// ─── main ─────────────────────────────────────────────────────────────────────

const doc = Document.current;
if (!doc) { app.alert('No document open.', APP_NAME); return; }

const selNodes = [];
for (const n of doc.selection.nodes) selNodes.push(n);

if (selNodes.length === 0) {
  app.alert('Select at least one object.', APP_NAME);
  return;
}

const leaves = [];
for (const n of selNodes) collectLeaves(n, leaves);

if (leaves.length === 0) {
  app.alert('No colourable objects found.', APP_NAME);
  return;
}

// ─── dialog ───────────────────────────────────────────────────────────────────

const dlg = Dialog.create(APP_NAME);
dlg.initialWidth = 280;

const col = dlg.addColumn();

const grpCol = col.addGroup('Base Colour');
const picker = grpCol.addColourPicker('', RGBA8(59, 130, 246));
picker.isFullWidth = true;

const grpSteps = col.addGroup('Steps');
grpSteps.enableSeparator = true;

const tintEd = grpSteps.addUnitValueEditor('Tints',  UnitType.Number, UnitType.Number, 5, 0, null);
tintEd.precision    = 0;
tintEd.isFullWidth  = true;

const shadeEd = grpSteps.addUnitValueEditor('Shades', UnitType.Number, UnitType.Number, 5, 0, null);
shadeEd.precision   = 0;
shadeEd.isFullWidth = true;

const grpSeed = col.addGroup('Randomize');
grpSeed.enableSeparator = true;

const seedEd = grpSeed.addUnitValueEditor('Seed  (0 = sequential)', UnitType.Number, UnitType.Number, 0, 0, null);
seedEd.precision   = 0;
seedEd.isFullWidth = true;

const grpInfo = col.addGroup('');
grpInfo.enableSeparator = true;
const infoTxt = grpInfo.addStaticText('', '');
infoTxt.isFullWidth = true;

function getParams() {
  const t    = Math.max(0, Math.round(tintEd.value));
  const s    = Math.max(0, Math.round(shadeEd.value));
  const seed = Math.max(0, Math.round(seedEd.value));
  return { t, s, seed };
}

function refreshInfo() {
  const { t, s } = getParams();
  const total = t + 1 + s;
  infoTxt.text = total + ' colours → ' + leaves.length + ' object' + (leaves.length !== 1 ? 's' : '') + ' (cyclic)';
}
refreshInfo();

// ─── preview ──────────────────────────────────────────────────────────────────

const historyStart = doc.history.position;
let busy = false;

function applyPreview() {
  if (busy) return;
  busy = true;
  try {
    const colour = picker.value;
    if (!colour) return;

    const { t, s, seed } = getParams();
    refreshInfo();

    const palette = generatePalette(colour.rgba8, t, s);

    doc.executeCommand(DocumentCommand.createClearPreviews());
    const cmd = buildCommand(doc, leaves, palette, seed);
    if (cmd) doc.executeCommand(cmd, true);
  } catch (_) {
  } finally {
    busy = false;
  }
}

picker.onValueChangedHandler  = applyPreview;
tintEd.onValueChangedHandler  = applyPreview;
shadeEd.onValueChangedHandler = applyPreview;
seedEd.onValueChangedHandler  = applyPreview;

// ─── show ─────────────────────────────────────────────────────────────────────

const result = dlg.show();

doc.executeCommand(DocumentCommand.createClearPreviews());

if (result.value === DialogResult.Ok.value) {
  const colour = picker.value;
  if (colour) {
    const { t, s, seed } = getParams();
    const palette = generatePalette(colour.rgba8, t, s);
    const cmd     = buildCommand(doc, leaves, palette, seed);
    if (cmd) doc.executeCommand(cmd);
  }
} else {
  restoreHistory(doc, historyStart);
}

restoreSelection(doc, selNodes);
setTimeout(0,   () => restoreSelection(doc, selNodes));
setTimeout(100, () => restoreSelection(doc, selNodes));
