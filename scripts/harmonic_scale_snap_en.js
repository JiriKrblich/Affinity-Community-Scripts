'use strict';
/*
 * Harmonic Scale — Snap Font Size (v1.0, English)
 *
 * Select some text (or a text frame) and run this script. It reads the
 * current font size, finds the nearest size in a harmonic scale (a base
 * value times a ratio raised to a whole-number power -- the same math as
 * Swiss Grid Explorer's Harmonic Scale calculator and the grid generator's
 * Harmonic Mode), and snaps the selection to it.
 *
 * This does NOT create a named Text Style -- the Affinity SDK has no way to
 * register one (see the documented hint on this). It snaps the raw font
 * size directly, which is the closest equivalent achievable from a script.
 */

const { Document } = require('/document.js');
const { SubSelectionType } = require('/selections.js');
const { StoryDelta, GlyphAttDoubleType } = require('/storydelta.js');
const { Dialog, DialogResult } = require('/dialog.js');
const { UnitType } = require('/units.js');

const RATIO_VALUES = [1.618, 1.414, 1.5, 1.333, 1.25, 2];
const RATIO_LABELS = [
  'Phi - Golden (1.618)',
  'sqrt(2) (1.414)',
  'Fifth - 3:2 (1.5)',
  'Fourth - 4:3 (1.333)',
  'Major third - 5:4 (1.25)',
  'Octave - 2:1 (2.0)',
  'Custom',
];

// Reads a representative current font size from whatever is selected --
// works whether a whole text frame is selected as an object, or a specific
// text range is selected inside it.
function getCurrentHeight(doc) {
  for (const item of doc.selection.items) {
    const node = item.node;
    if (!node || !node.storyInterface) continue;
    const story = node.storyInterface.story;
    if (story.length === 0) continue;
    let pos = 0;
    const textSub = item.getSubSelectionOfType(SubSelectionType.Text);
    if (textSub && !textSub.isEmpty && textSub.rangeCount > 0) {
      const r = textSub.ranges[0];
      pos = Math.min(Math.min(r.begin, r.end), story.length - 1);
    }
    return story.getGlyphAtts(pos).height;
  }
  return null;
}

// Finds the nearest power of `ratio` from `base` to `current`, rounded to
// the nearest half point (the same rounding granularity used elsewhere in
// Swiss Grid Explorer).
function snappedSize(current, base, ratio) {
  if (current <= 0 || base <= 0 || ratio <= 1) return base;
  const step = Math.round(Math.log(current / base) / Math.log(ratio));
  return Math.round(base * Math.pow(ratio, step) * 2) / 2;
}

const doc = Document.current;
if (!doc) {
  console.log('[Harmonic Scale] No open document.');
} else {
  const current = getCurrentHeight(doc);
  if (current == null) {
    console.log('[Harmonic Scale] Select some text (or a text frame) first.');
  } else {
    const dlg = Dialog.create('Harmonic Scale \u2014 Snap Font Size');
    const col = dlg.addColumn();
    const grp = col.addGroup('Settings');

    const ratioCombo = grp.addComboBox('Ratio', RATIO_LABELS, 0);
    const customBox = grp.addTextBox('Custom ratio', '1.618');
    customBox.isEnabled = false;
    const baseEdit = grp.addUnitValueEditor('Base size', UnitType.Point, UnitType.Point, 12, 1, 500);
    const info = grp.addStaticText('', '');

    function currentRatio() {
      if (ratioCombo.selectedIndex === RATIO_VALUES.length) {
        const v = parseFloat(customBox.text);
        return (isNaN(v) || v <= 1) ? 1.618 : v;
      }
      return RATIO_VALUES[ratioCombo.selectedIndex];
    }

    function updateInfo() {
      const target = snappedSize(current, baseEdit.value, currentRatio());
      info.text = 'Current: ' + current.toFixed(1) + ' pt  ->  snap to: ' + target.toFixed(1) + ' pt';
    }

    ratioCombo.onValueChangedHandler = () => {
      customBox.isEnabled = (ratioCombo.selectedIndex === RATIO_VALUES.length);
      updateInfo();
    };
    customBox.onValueChangedHandler = updateInfo;
    baseEdit.onValueChangedHandler = updateInfo;
    updateInfo();

    if (dlg.runModal() === DialogResult.Ok) {
      const target = snappedSize(current, baseEdit.value, currentRatio());
      const delta = StoryDelta.createGlyphDouble(GlyphAttDoubleType.Height, target);
      doc.formatText(delta, doc.selection);
      console.log('[Harmonic Scale] Snapped ' + current.toFixed(1) + ' pt -> ' + target.toFixed(1) + ' pt');
    }
  }
}
