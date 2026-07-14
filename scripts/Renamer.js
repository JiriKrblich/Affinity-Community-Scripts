/**
 * name: Renamer
 * description: Rename selected elements with remove, append, replace, and prefix, suffix, or insert numbering operations.
 * version: 0.8.0
 * author: WaveF
*/
'use strict';

const { Document } = require('/document');
const { Dialog, DialogResult } = require('/dialog');
const { DocumentCommand } = require('/commands');
const { Selection } = require('/selections');
const { UnitType } = require('/units');
const { app } = require('/application');

const APP_NAME = 'Renamer';
const doc = Document.current;

if (!doc) {
  app.alert('No open document', APP_NAME);
  return;
}

const count = doc.selection.length;
if (count === 0) {
  app.alert('Please select at least one element first', APP_NAME);
  return;
}

const sourceNodes = doc.selection.nodes;
const sourceSelection = Selection.create(doc, sourceNodes);

function restoreSourceSelection() {
  try {
    doc.selection = sourceSelection;
  } catch (_) {}
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function getNodeName(node) {
  try {
    const current = node.description;
    return typeof current === 'string' ? current : '';
  } catch (_) {
    return '';
  }
}

function getNodeBox(node) {
  try {
    const box = node.getSpreadBaseBox(false);
    return {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      right: box.x + box.width,
      bottom: box.y + box.height,
      centerY: box.y + box.height * 0.5,
    };
  } catch (_) {
    return null;
  }
}

function padSignedNumber(value, digits) {
  const intValue = toInt(value, 0);
  const sign = intValue < 0 ? '-' : '';
  const absText = String(Math.abs(intValue));
  const safeDigits = clamp(toInt(digits, 0), 0, 12);
  if (safeDigits <= 0) return sign + absText;
  return sign + absText.padStart(safeDigits, '0');
}

function shouldJoinRow(row, itemBox) {
  const overlap = Math.min(row.bottom, itemBox.bottom) - Math.max(row.top, itemBox.y);
  const minHeight = Math.max(1, Math.min(row.avgHeight, itemBox.height));
  const overlapRatio = overlap / minHeight;
  const centerDelta = Math.abs(itemBox.centerY - row.centerY);
  const centerTolerance = Math.max(row.avgHeight, itemBox.height) * 0.35;
  return overlapRatio >= 0.3 || centerDelta <= centerTolerance;
}

function getOrderedSelectionItems(orderMode) {
  const items = [];
  for (let i = 0; i < count; i++) {
    const item = doc.selection.at(i);
    const node = item && item.node;
    if (!node) continue;
    items.push({
      sourceIndex: i,
      item,
      node,
      box: getNodeBox(node),
    });
  }

  if (orderMode !== 'position') {
    return items;
  }

  const sortable = items.slice().sort((a, b) => {
    if (!a.box && !b.box) return a.sourceIndex - b.sourceIndex;
    if (!a.box) return 1;
    if (!b.box) return -1;
    if (a.box.centerY !== b.box.centerY) return a.box.centerY - b.box.centerY;
    if (a.box.x !== b.box.x) return a.box.x - b.box.x;
    return a.sourceIndex - b.sourceIndex;
  });

  const rows = [];
  for (let i = 0; i < sortable.length; i++) {
    const entry = sortable[i];
    if (!entry.box) {
      rows.push({
        top: 0,
        bottom: 0,
        centerY: 0,
        avgHeight: 1,
        items: [entry],
      });
      continue;
    }

    let row = rows[rows.length - 1];
    if (!row || !shouldJoinRow(row, entry.box)) {
      row = {
        top: entry.box.y,
        bottom: entry.box.bottom,
        centerY: entry.box.centerY,
        avgHeight: entry.box.height,
        items: [],
      };
      rows.push(row);
    } else {
      const itemCount = row.items.length;
      row.top = Math.min(row.top, entry.box.y);
      row.bottom = Math.max(row.bottom, entry.box.bottom);
      row.centerY = ((row.centerY * itemCount) + entry.box.centerY) / (itemCount + 1);
      row.avgHeight = ((row.avgHeight * itemCount) + entry.box.height) / (itemCount + 1);
    }
    row.items.push(entry);
  }

  const flattened = [];
  for (let i = 0; i < rows.length; i++) {
    const rowItems = rows[i].items.slice().sort((a, b) => {
      if (!a.box && !b.box) return a.sourceIndex - b.sourceIndex;
      if (!a.box) return 1;
      if (!b.box) return -1;
      if (a.box.x !== b.box.x) return a.box.x - b.box.x;
      if (a.box.centerY !== b.box.centerY) return a.box.centerY - b.box.centerY;
      return a.sourceIndex - b.sourceIndex;
    });
    for (let j = 0; j < rowItems.length; j++) {
      flattened.push(rowItems[j]);
    }
  }

  return flattened;
}

function renameNode(node, name) {
  try {
    const nodeSelection = Selection.create(doc, [node], true);
    doc.executeCommand(DocumentCommand.createSetDescription(nodeSelection, name));
  } catch (_) {}
}

function buildRenamedText(baseName, index, totalCount, settings) {
  let nextName = baseName;

  if (settings.remove.enabled && settings.remove.length > 0 && nextName !== '') {
    const startIndex = clamp(toInt(settings.remove.start, 0), 0, nextName.length);
    const endIndex = clamp(startIndex + settings.remove.length, startIndex, nextName.length);
    nextName = nextName.slice(0, startIndex) + nextName.slice(endIndex);
  }

  if (settings.replace.enabled && settings.replace.find !== '') {
    nextName = nextName.split(settings.replace.find).join(settings.replace.with);
  }

  if (settings.append.enabled) {
    if (settings.append.forceName !== '') {
      nextName = settings.append.forceName;
    }
    nextName = settings.append.prefix + nextName + settings.append.suffix;
  }

  if (settings.number.enabled) {
    const numberIndex = settings.number.reverse ? (totalCount - 1 - index) : index;
    const value = settings.number.start + settings.number.increment * numberIndex;
    const numberText = padSignedNumber(value, settings.number.digits);
    if (nextName === '') {
      nextName = numberText;
    } else if (settings.number.mode === 'prefix') {
      nextName = numberText + settings.number.separator + nextName;
    } else if (settings.number.mode === 'insert') {
      const insertAt = clamp(toInt(settings.number.at, 0), 0, nextName.length);
      const before = nextName.slice(0, insertAt);
      const after = nextName.slice(insertAt);
      const sep = settings.number.separator;
      nextName = before + sep + numberText + sep + after;
    } else {
      nextName = nextName + settings.number.separator + numberText;
    }
  }

  return nextName;
}

function collectRenamePreview(settings) {
  const lines = [];
  const operations = [];

  const orderedItems = getOrderedSelectionItems(settings.order.mode);
  const totalCount = orderedItems.length;
  for (let i = 0; i < orderedItems.length; i++) {
    const entry = orderedItems[i];
    const node = entry && entry.node;
    if (!node) continue;

    const oldName = getNodeName(node);
    const newName = buildRenamedText(oldName, i, totalCount, settings);
    operations.push({ node, newName });
    lines.push(`${i + 1}. ${oldName} -> ${newName}`);
  }

  return { lines, operations };
}

function buildDialog() {
  const dlg = Dialog.create(`${APP_NAME} v0.8`);
  dlg.initialWidth = 380;
  dlg.isResizable = false;

  const col = dlg.addColumn();

  const orderModeGroup = col.addGroup('Order');
  dlg.orderMode = orderModeGroup.addComboBox('Mode', ['Selection', 'Position'], 0);
  dlg.orderMode.isFullWidth = true;

  const orderGroup = col.addGroup('');
  dlg.orderText = orderGroup.addStaticText('', 'Order: Remove -> Replace -> Append -> Number');
  dlg.orderText.isFullWidth = true;

  const removeGroup = col.addGroup('Remove');
  dlg.removeEnabled = removeGroup.addSwitch('Enabled', false);
  dlg.removeStart = removeGroup.addUnitValueEditor('Start', UnitType.Number, UnitType.Number, 0, 0, 999999);
  dlg.removeStart.precision = 0;
  dlg.removeStart.showPopupSlider = false;
  dlg.removeStart.setIsEnabledBy(dlg.removeEnabled);
  dlg.removeLength = removeGroup.addUnitValueEditor('Length', UnitType.Number, UnitType.Number, 1, 0, 999999);
  dlg.removeLength.precision = 0;
  dlg.removeLength.showPopupSlider = false;
  dlg.removeLength.setIsEnabledBy(dlg.removeEnabled);

  const appendGroup = col.addGroup('Append');
  dlg.appendEnabled = appendGroup.addSwitch('Enabled', false);
  dlg.appendPrefix = appendGroup.addTextBox('Prefix', '');
  dlg.appendPrefix.isFullWidth = true;
  dlg.appendPrefix.setIsEnabledBy(dlg.appendEnabled);
  dlg.appendSuffix = appendGroup.addTextBox('Suffix', '');
  dlg.appendSuffix.isFullWidth = true;
  dlg.appendSuffix.setIsEnabledBy(dlg.appendEnabled);
  dlg.appendForceName = appendGroup.addTextBox('Overwrite', '');
  dlg.appendForceName.isFullWidth = true;
  dlg.appendForceName.setIsEnabledBy(dlg.appendEnabled);

  const replaceGroup = col.addGroup('Replace');
  dlg.replaceEnabled = replaceGroup.addSwitch('Enabled', false);
  dlg.replaceFind = replaceGroup.addTextBox('Find', '');
  dlg.replaceFind.isFullWidth = true;
  dlg.replaceFind.setIsEnabledBy(dlg.replaceEnabled);
  dlg.replaceWith = replaceGroup.addTextBox('With', '');
  dlg.replaceWith.isFullWidth = true;
  dlg.replaceWith.setIsEnabledBy(dlg.replaceEnabled);

  const numberGroup = col.addGroup('Number');
  dlg.numberEnabled = numberGroup.addSwitch('Enabled', false);
  dlg.numberMode = numberGroup.addComboBox('', ['Suffix', 'Prefix', 'Insert'], 0);
  dlg.numberMode.isFullWidth = true;
  dlg.numberMode.setIsEnabledBy(dlg.numberEnabled);
  dlg.numberSeparator = numberGroup.addTextBox('Separator', '_');
  dlg.numberSeparator.isFullWidth = true;
  dlg.numberSeparator.setIsEnabledBy(dlg.numberEnabled);
  dlg.numberAt = numberGroup.addUnitValueEditor('Insert at', UnitType.Number, UnitType.Number, 0, 0, 999999);
  dlg.numberAt.precision = 0;
  dlg.numberAt.showPopupSlider = false;
  dlg.numberAt.setIsEnabledBy(dlg.numberEnabled);
  dlg.numberAt.setIsEnabledByControlIDWithSelectedIndex(dlg.numberMode.controlID, 2);
  dlg.numberStart = numberGroup.addUnitValueEditor('Start', UnitType.Number, UnitType.Number, 1, -999999, 999999);
  dlg.numberStart.precision = 0;
  dlg.numberStart.showPopupSlider = false;
  dlg.numberStart.setIsEnabledBy(dlg.numberEnabled);
  dlg.numberIncrement = numberGroup.addUnitValueEditor('Increment', UnitType.Number, UnitType.Number, 1, -999999, 999999);
  dlg.numberIncrement.precision = 0;
  dlg.numberIncrement.showPopupSlider = false;
  dlg.numberIncrement.setIsEnabledBy(dlg.numberEnabled);
  dlg.numberDigits = numberGroup.addUnitValueEditor('Pad', UnitType.Number, UnitType.Number, 1, 0, 12);
  dlg.numberDigits.precision = 0;
  dlg.numberDigits.showPopupSlider = false;
  dlg.numberDigits.setIsEnabledBy(dlg.numberEnabled);
  dlg.numberReverse = numberGroup.addSwitch('Reverse', false);
  dlg.numberReverse.setIsEnabledBy(dlg.numberEnabled);

  const footerGroup = col.addGroup('');
  dlg.statusText = footerGroup.addStaticText('', `Selected Elements: ${count}`);
  dlg.statusText.isFullWidth = true;

  return dlg;
}

const dlg = buildDialog();
const result = dlg.runModal();

if (result.value !== DialogResult.Ok.value) {
  return;
}

const settings = {
  order: {
    mode: dlg.orderMode.selectedIndex === 1 ? 'position' : 'selection',
  },
  remove: {
    enabled: dlg.removeEnabled.value,
    start: toInt(dlg.removeStart.value, 0),
    length: Math.max(0, toInt(dlg.removeLength.value, 1)),
  },
  append: {
    enabled: dlg.appendEnabled.value,
    prefix: dlg.appendPrefix.text || '',
    suffix: dlg.appendSuffix.text || '',
    forceName: dlg.appendForceName.text || '',
  },
  replace: {
    enabled: dlg.replaceEnabled.value,
    find: dlg.replaceFind.text || '',
    with: dlg.replaceWith.text || '',
  },
  number: {
    enabled: dlg.numberEnabled.value,
    mode: dlg.numberMode.selectedIndex === 1 ? 'prefix' : (dlg.numberMode.selectedIndex === 2 ? 'insert' : 'suffix'),
    reverse: dlg.numberReverse.value,
    separator: dlg.numberSeparator.text || '',
    at: toInt(dlg.numberAt.value, 0),
    start: toInt(dlg.numberStart.value, 1),
    increment: toInt(dlg.numberIncrement.value, 1),
    digits: clamp(toInt(dlg.numberDigits.value, 2), 0, 12),
  },
};

if (!settings.remove.enabled && !settings.append.enabled && !settings.replace.enabled && !settings.number.enabled) {
  app.alert('Please enable at least one rename operation', APP_NAME);
  return;
}

const collected = collectRenamePreview(settings);

if (collected.operations.length === 0) {
  app.alert('No renameable elements found in selection', APP_NAME);
  return;
}

for (let i = 0; i < collected.operations.length; i++) {
  const op = collected.operations[i];
  renameNode(op.node, op.newName);
}

restoreSourceSelection();
