/**
 * name: PODHOD Random Color
 * description: Colors the fills/strokes of selected objects with random colors or color variations within a specified HSL range
 * version: 2026.08.11
 * author: Vladimir Solovev
 */

'use strict';

const { Document } = require('/document');
const { HSLAf } = require('/colours');
const { FillDescriptor, FillType } = require('/fills');
const { Dialog, DialogResult } = require('/dialog');
const { Selection } = require('/selections');

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function frac(v) { return v - Math.floor(v); }

function getNodeFillColour(node) {
  try {
    const fd = node.brushFillDescriptor;
    if (fd && fd.fillType.value === FillType.Solid.value) return fd.fill.colour;
  } catch (e) {}
  return null;
}

function getNodeStrokeColour(node) {
  try {
    const pf = node.penFillDescriptor;
    if (pf && pf.fillType.value === FillType.Solid.value) return pf.fill.colour;
  } catch (e) {}
  return null;
}

function colourToHSL(colour) {
  return colour ? colour.hslaf : null;
}

function randomColour(baseHSL, dH, dS, dL) {
  let h, s, l;
  if (baseHSL) {
    h = frac(baseHSL.h + (Math.random() * 2 - 1) * dH);
    s = clamp(baseHSL.s + (Math.random() * 2 - 1) * dS, 0, 1);
    l = clamp(baseHSL.l + (Math.random() * 2 - 1) * dL, 0, 1);
  } else {
    h = Math.random();
    s = clamp(0.7 + (Math.random() * 2 - 1) * dS, 0, 1);
    l = clamp(0.5 + (Math.random() * 2 - 1) * dL, 0, 1);
  }
  return HSLAf(h, s, l, 1.0);
}

function getBase1And2FromNode(node) {
  const fill = getNodeFillColour(node);
  const stroke = getNodeStrokeColour(node);
  const c1 = fill || stroke || HSLAf(0.0, 0.7, 0.5, 1.0);
  let c2;
  if (fill && stroke) {
    c2 = stroke;
  } else {
    const hsl = colourToHSL(c1);
    c2 = HSLAf(frac(hsl.h + 0.5), hsl.s, hsl.l, 1.0);
  }
  return [c1, c2];
}

// ─── Initialization ─────────────────────────────────────────────────────────

const doc = Document.current;
if (!doc) return;

const savedNodes = doc.selection.nodes.toArray();
const nodeCount = savedNodes.length;
const savedSelection = Selection.create(doc, savedNodes);

// Store HSL of each object ONCE at startup (for mode 1)
const originalHSLPerNode = savedNodes.map(n => {
  return colourToHSL(getNodeFillColour(n) || getNodeStrokeColour(n))
      || { h: Math.random(), s: 0.7, l: 0.5 };
});

// Base colors of the first object (for mode 2)
const firstNode = savedNodes[0] || null;
let [baseColour1, baseColour2] = firstNode
  ? getBase1And2FromNode(firstNode)
  : [HSLAf(0.0, 0.7, 0.5, 1.0), HSLAf(0.5, 0.7, 0.5, 1.0)];

// ─── Dialog ──────────────────────────────────────────────────────────────────

const dlg = Dialog.create('Random Color');
dlg.initialWidth = 360;
const col = dlg.addColumn();

// Apply to
const grpTarget = col.addGroup('Apply to');
const btnTarget = grpTarget.addButtonSet('', ['Fill', 'Stroke', 'Fill and Stroke'], 0);
btnTarget.setIsFullWidth(true);

// Color Source
const grpSource = col.addGroup('Color Source');
const comboSource = grpSource.addComboBox('', [
  'Completely random colors',
  'Variations based on each object\'s colors',
  'Variations based on colors from the first object'
], 0);
comboSource.setIsFullWidth(true);

// Base colors (only for mode 2) — hidden in other modes
const grpBase = col.addGroup('First Object Base');
const picker1 = grpBase.addColourPicker('Primary Color', baseColour1);
const picker2 = grpBase.addColourPicker('Secondary Color', baseColour2);
const swUpdate = grpBase.addSwitch('Update from current selection', false);

// Bind all three to mode 2 — enabled only when comboSource = 2
picker1.setIsEnabledByControlIDWithSelectedIndex(comboSource.controlID, 2);
picker2.setIsEnabledByControlIDWithSelectedIndex(comboSource.controlID, 2);
swUpdate.setIsEnabledByControlIDWithSelectedIndex(comboSource.controlID, 2);

// Variation
const grpDev = col.addGroup('Variation');
const edH = grpDev.addUnitValueEditor('Hue H', null, null, 0.15, 0.0, 1.0);
edH.precision = 2; edH.showPopupSlider = true;
const edS = grpDev.addUnitValueEditor('Saturation S', null, null, 0.2, 0.0, 1.0);
edS.precision = 2; edS.showPopupSlider = true;
const edL = grpDev.addUnitValueEditor('Lightness L', null, null, 0.2, 0.0, 1.0);
edL.precision = 2; edL.showPopupSlider = true;

// Variation active only for modes 1 and 2
edH.setIsDisabledByControlIDWithSelectedIndex(comboSource.controlID, 0);
edS.setIsDisabledByControlIDWithSelectedIndex(comboSource.controlID, 0);
edL.setIsDisabledByControlIDWithSelectedIndex(comboSource.controlID, 0);

// Counter
const grpCount = col.addGroup('');
grpCount.addStaticText('Selected objects', String(nodeCount));

// ─── Loop: Ok = Apply, Cancel = Close ────────────────────────────────────────

while (true) {
  const result = dlg.runModal();
  if (result.value !== DialogResult.Ok.value) break;

  const targetMode = btnTarget.selectedIndex;
  const sourceMode = comboSource.selectedIndex;
  const dH = edH.value != null ? edH.value : 0.15;
  const dS = edS.value != null ? edS.value : 0.2;
  const dL = edL.value != null ? edL.value : 0.2;

  // Update base from selection if switch is enabled
  if (swUpdate.value && firstNode) {
    const [nc1, nc2] = getBase1And2FromNode(firstNode);
    baseColour1 = nc1;
    baseColour2 = nc2;
    picker1.value = baseColour1;
    picker2.value = baseColour2;
    swUpdate.value = false;
  } else {
    if (picker1.value) baseColour1 = picker1.value;
    if (picker2.value) baseColour2 = picker2.value;
  }

  if (nodeCount === 0) continue;

  doc.selection = savedSelection;

  for (let i = 0; i < savedNodes.length; i++) {
    const node = savedNodes[i];
    let baseHSL = null;

    if (sourceMode === 1) {
      // Original color of specific object — captured at launch
      baseHSL = originalHSLPerNode[i];
    } else if (sourceMode === 2) {
      // Interpolation between two pickers
      const t = Math.random();
      const hsl1 = colourToHSL(baseColour1);
      const hsl2 = colourToHSL(baseColour2);
      if (hsl1 && hsl2) {
        baseHSL = {
          h: frac(hsl1.h + t * (hsl2.h - hsl1.h)),
          s: clamp(hsl1.s + t * (hsl2.s - hsl1.s), 0, 1),
          l: clamp(hsl1.l + t * (hsl2.l - hsl1.l), 0, 1)
        };
      } else {
        baseHSL = hsl1 || hsl2;
      }
    }
    // sourceMode === 0: baseHSL = null → completely random

    const nodeSel = node.selfSelection;
    if (targetMode === 0 || targetMode === 2) {
      doc.setBrushFillDescriptor(FillDescriptor.createSolid(randomColour(baseHSL, dH, dS, dL)), nodeSel);
    }
    if (targetMode === 1 || targetMode === 2) {
      doc.setPenFillDescriptor(FillDescriptor.createSolid(randomColour(baseHSL, dH, dS, dL)), nodeSel);
    }
  }
}
