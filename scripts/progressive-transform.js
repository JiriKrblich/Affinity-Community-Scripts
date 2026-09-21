/**
 * name: Progressive Transform v2.21.1
 * description: Progressive transforms with Position, Layer Index or Selection ordering, unified values reporting and reversible live preview.
 * version: 2.21.1
 * author: WaveF
 * email: wavef@live.com
 * website: https://minicg.com
*/
'use strict';

const { Document } = require('/document');
const { Dialog, DialogResult } = require('/dialog');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
const { Transform } = require('/geometry');
const { Selection } = require('/selections');
const { FillDescriptor } = require('/fills');
const { RGBA8 } = require('/colours');
const { ColourOverlayLayerEffect } = require('/layereffects');
const { UnitType } = require('/units');
const { app } = require('/application');

const APP_NAME = 'Progressive Transform v2.21.1';
const doc = Document.current;

if (!doc) {
  app.alert('Step 1: No open document', APP_NAME);
  return;
}

const count = doc.selection.length;
if (count === 0) {
  app.alert('Step 1: Please select at least one object first', APP_NAME);
  return;
}

const sourceNodes = Array.from(doc.selection.nodes);
const sourceSelection = Selection.create(doc, sourceNodes);

function restoreSourceSelection() {
  try {
    doc.selection = sourceSelection;
  } catch (_) {}
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

function shouldJoinRow(row, itemBox) {
  const overlap = Math.min(row.bottom, itemBox.bottom) - Math.max(row.top, itemBox.y);
  const minHeight = Math.max(1, Math.min(row.avgHeight, itemBox.height));
  const overlapRatio = overlap / minHeight;
  const centerDelta = Math.abs(itemBox.centerY - row.centerY);
  const centerTolerance = Math.max(row.avgHeight, itemBox.height) * 0.35;
  return overlapRatio >= 0.3 || centerDelta <= centerTolerance;
}

function getOrderedSelectionItems(orderMode) {
  const items = sourceNodes.map((node, sourceIndex) => ({
    sourceIndex, node, box: getNodeBox(node)
  }));
  if (orderMode === 'layer') {
    const ranks = [];
    function visit(parent) {
      const children = Array.from(parent.children).reverse();
      for (const node of children) {
        ranks.push(node);
        visit(node);
      }
    }
    for (const spread of doc.spreads) visit(spread);
    function rank(node) {
      const index = ranks.findIndex(n => n.isSameNode(node));
      return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    }
    return items.sort((a, b) => rank(a.node) - rank(b.node) || a.sourceIndex - b.sourceIndex);
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

// Freeze the sequence before preview can move objects or affect selection.
const orderedNodes = {
  position: getOrderedSelectionItems('position').map(entry => entry.node),
  layer: getOrderedSelectionItems('layer').map(entry => entry.node),
  selection: sourceNodes.slice()
};

function fromCenterOrig(bb, xf) {
  if (!bb) return xf;
  const cx = bb.x + bb.width * 0.5;
  const cy = bb.y + bb.height * 0.5;
  return Transform.createTranslate(cx, cy).multiply(
    xf.multiply(Transform.createTranslate(-cx, -cy)),
  );
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function clampScale(v) {
  return clamp(v, 0.001, 999999);
}

function clampOpacity(v) {
  return clamp(v, 0, 1);
}

function clamp255(v) {
  return clamp(Math.round(v), 0, 255);
}

function normalizeRGBA(value) {
  if (!value) return null;
  const rgba = value.rgba8 ? value.rgba8 : value;
  if (!rgba) return null;
  return {
    r: rgba.r,
    g: rgba.g,
    b: rgba.b,
    a: rgba.a != null ? rgba.a : (rgba.alpha != null ? rgba.alpha : 255),
  };
}

function getNodeSolidRGBA(node) {
  try {
    const fd = node.brushFillDescriptor;
    const fill = fd && fd.fill;
    const colour = fill && fill.colour;
    const rgba = colour && colour.rgba8;
    if (!rgba) return null;
    return {
      r: rgba.r,
      g: rgba.g,
      b: rgba.b,
      a: rgba.a != null ? rgba.a : (rgba.alpha != null ? rgba.alpha : 255),
    };
  } catch (_) {
    return null;
  }
}

function getNodeTransformDecomp(node) {
  try {
    const transform = node.transformInterface && node.transformInterface.transform;
    if (!transform || typeof transform.decompose !== 'function') return null;
    return transform.decompose();
  } catch (_) {
    return null;
  }
}

function getNodeOpacity(node) {
  try {
    if (typeof node.globalOpacity === 'number') {
      return clampOpacity(node.globalOpacity);
    }
  } catch (_) {}
  return 1;
}

function getNodeVisibleRotationDegrees(node) {
  const decomp = getNodeTransformDecomp(node);
  const rotationRad = decomp && typeof decomp.rotation === 'number' ? decomp.rotation : 0;
  return -(rotationRad * 180 / Math.PI);
}

function visibleDeltaDegreesToCommandRadians(deltaVisibleDeg) {
  return -(deltaVisibleDeg * Math.PI / 180);
}

function safeScaleDenominator(v) {
  const abs = Math.abs(v);
  return abs > 0.000001 ? abs : 1;
}

function lerpColor(a, b, t) {
  return {
    r: clamp255(a.r + (b.r - a.r) * t),
    g: clamp255(a.g + (b.g - a.g) * t),
    b: clamp255(a.b + (b.b - a.b) * t),
    a: clamp255(a.a + (b.a - a.a) * t),
  };
}

function computeScaleAt(progressIndex, total, mode, stepValue) {
  if (mode === 'even') {
    return total > 1 ? progressIndex / (total - 1) : 0.5;
  }
  if (progressIndex === 0) return 1;
  return Math.abs(stepValue) * progressIndex;
}

function computeRotationEvenIncrement(total) {
  return total > 0 ? 360 / total : 360;
}

function computeRotationAt(progressIndex, total, mode, stepValue) {
  if (mode === 'even') {
    return computeRotationEvenIncrement(total) * progressIndex;
  }
  return Math.abs(stepValue) * progressIndex;
}

function computeOpacityEvenIncrement(total) {
  return total > 0 ? 1 / total : 1;
}

function computeOpacityAt(progressIndex, total) {
  return clampOpacity(computeOpacityEvenIncrement(total) * (progressIndex + 1));
}

function formatNumber(value, digits) {
  return Number(value).toFixed(digits);
}

function formatRGBA(c) {
  return c ? `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})` : 'null';
}

function getColourOverlayIndexes(node) {
  try {
    const effects = node && node.quickFX ? node.quickFX : [];
    const indexes = [];
    for (let i = 0; i < effects.length; i++) {
      const effect = effects[i];
      if (effect && effect.isColourOverlayLayerEffect) {
        indexes.push(i);
      }
    }
    return indexes;
  } catch (_) {
    return [];
  }
}

function getColorValueHeading(colorSettings) {
  if (colorSettings.layerEffects) return 'Color (Layer Effects):';
  return 'Color (Fill):';
}

function buildDialog() {
  const dlg = Dialog.create(APP_NAME);
  dlg.initialWidth = 380;
  dlg.isResizable = false;

  const col = dlg.addColumn();

  const orderGroup = col.addGroup('Order');
  dlg.orderMode = orderGroup.addButtonSet('Processing Order', ['Position', 'Layer Index', 'Selection'], 0);

  const scaleGroup = col.addGroup('Scale');
  dlg.scaleEnabled = scaleGroup.addSwitch('Enabled', false);
  dlg.scaleMode = scaleGroup.addButtonSet('', ['Even', 'Step'], 0);
  dlg.scaleMode.isFullWidth = true;
  dlg.scaleEvenInfo = scaleGroup.addStaticText('', 'Even Value: 0% -> 100%');
  dlg.scaleEvenInfo.isFullWidth = true;
  dlg.scaleStep = scaleGroup.addUnitValueEditor('Step Value', UnitType.Number, UnitType.Number, 0.25, -999999, 999999);
  dlg.scaleStep.precision = 3;
  dlg.scaleStep.showPopupSlider = false;
  dlg.scaleRelative = scaleGroup.addSwitch('Relative', false);
  dlg.scaleReverse = scaleGroup.addSwitch('Reverse', false);

  const rotGroup = col.addGroup('Rotation');
  dlg.rotEnabled = rotGroup.addSwitch('Enabled', false);
  dlg.rotMode = rotGroup.addButtonSet('', ['Even', 'Step'], 0);
  dlg.rotMode.isFullWidth = true;
  dlg.rotEvenInfo = rotGroup.addStaticText('', `Even Value: 360° / ${count} = ${formatNumber(computeRotationEvenIncrement(count), 1)}°`);
  dlg.rotEvenInfo.isFullWidth = true;
  dlg.rotStep = rotGroup.addUnitValueEditor('Step Value', UnitType.Number, UnitType.Number, 15, -999999, 999999);
  dlg.rotStep.precision = 3;
  dlg.rotStep.showPopupSlider = false;
  dlg.rotRelative = rotGroup.addSwitch('Relative', false);
  dlg.rotReverse = rotGroup.addSwitch('Reverse', false);

  const colorGroup = col.addGroup('Color');
  dlg.colorEnabled = colorGroup.addSwitch('Enabled', false);
  dlg.colorStart = colorGroup.addColourPicker('Start');
  dlg.colorEnd = colorGroup.addColourPicker('End');
  dlg.colorStart.allowPickNone = false;
  dlg.colorEnd.allowPickNone = false;
  dlg.colorLayerEffects = colorGroup.addSwitch('Layer Effects', false);
  dlg.colorReverse = colorGroup.addSwitch('Reverse', false);

  const opacityGroup = col.addGroup('Opacity');
  dlg.opacityEnabled = opacityGroup.addSwitch('Enabled', false);
  dlg.opacityEvenInfo = opacityGroup.addStaticText('', `Even Value: ${formatNumber(computeOpacityEvenIncrement(count) * 100, 1)}%`);
  dlg.opacityEvenInfo.isFullWidth = true;
  dlg.opacityRelative = opacityGroup.addSwitch('Relative', false);
  dlg.opacityReverse = opacityGroup.addSwitch('Reverse', false);

  const firstItem = doc.selection.at(0);
  const lastItem = doc.selection.at(count - 1);
  const firstColor = firstItem && firstItem.node ? getNodeSolidRGBA(firstItem.node) : null;
  const lastColor = lastItem && lastItem.node ? getNodeSolidRGBA(lastItem.node) : null;
  const startDefault = firstColor || { r: 0, g: 0, b: 0, a: 255 };
  const endDefault = lastColor || { r: 255, g: 255, b: 255, a: 255 };
  dlg.colorStart.value = RGBA8(startDefault.r, startDefault.g, startDefault.b, startDefault.a);
  dlg.colorEnd.value = RGBA8(endDefault.r, endDefault.g, endDefault.b, endDefault.a);

  const statusGroup = col.addGroup('Test');
  dlg.statusText = statusGroup.addStaticText('', `Selected Elements: ${count}`);
  dlg.statusText.isFullWidth = true;
  dlg.showValues = statusGroup.addSwitch('Show Values', false);
  dlg.preview = statusGroup.addSwitch('Preview', true);

  updateControlState(dlg);
  return dlg;
}

function updateControlState(dlg) {
  for (const key of ['scaleMode','scaleEvenInfo','scaleRelative','scaleReverse']) dlg[key].isEnabled = dlg.scaleEnabled.value;
  dlg.scaleStep.isEnabled = dlg.scaleEnabled.value && dlg.scaleMode.selectedIndex === 1;
  for (const key of ['rotMode','rotEvenInfo','rotRelative','rotReverse']) dlg[key].isEnabled = dlg.rotEnabled.value;
  dlg.rotStep.isEnabled = dlg.rotEnabled.value && dlg.rotMode.selectedIndex === 1;
  for (const key of ['colorStart','colorEnd','colorLayerEffects','colorReverse']) dlg[key].isEnabled = dlg.colorEnabled.value;
  for (const key of ['opacityEvenInfo','opacityRelative','opacityReverse']) dlg[key].isEnabled = dlg.opacityEnabled.value;
}

function analyzeValues(settings) {
  const builder = CompoundCommandBuilder.create();
  let nonOpacityCommandCount = 0;
  const valueSections = [];
  const scaleValues = [];
  const rotationValues = [];
  const colorValues = [];
  const opacityValues = [];
  const opacityOperations = [];

  for (let i = 0; i < count; i++) {
    const node = orderedNodes[settings.order][i];
    if (!node) continue;

    let bb = null;
    try {
      bb = node.getSpreadBaseBox(false);
    } catch (_) {}

    const decomp = getNodeTransformDecomp(node);
    const currentScaleX = safeScaleDenominator(decomp && decomp.scaleX != null ? decomp.scaleX : 1);
    const currentScaleY = safeScaleDenominator(decomp && decomp.scaleY != null ? decomp.scaleY : 1);
    const currentVisibleRotationDeg = getNodeVisibleRotationDegrees(node);
    const currentOpacity = getNodeOpacity(node);

    if (settings.scale.enabled) {
      const progressIndex = settings.scale.reverse ? (count - 1 - i) : i;
      const targetScale = clampScale(computeScaleAt(progressIndex, count, settings.scale.mode, settings.scale.stepValue));
      const scaleX = settings.scale.relative ? targetScale : clampScale(targetScale / currentScaleX);
      const scaleY = settings.scale.relative ? targetScale : clampScale(targetScale / currentScaleY);
      const finalScaleX = settings.scale.relative ? currentScaleX * targetScale : targetScale;
      const finalScaleY = settings.scale.relative ? currentScaleY * targetScale : targetScale;
      scaleValues.push(`[${formatNumber(finalScaleX, 3)}, ${formatNumber(finalScaleY, 3)}]`);
      builder.addCommand(
        DocumentCommand.createTransform(
          Selection.create(doc, node),
          fromCenterOrig(bb, Transform.createScale(scaleX, scaleY))
        )
      );
      nonOpacityCommandCount += 1;
    }

    if (settings.rotation.enabled) {
      const progressIndex = settings.rotation.reverse ? (count - 1 - i) : i;
      const baseAngleDeg = computeRotationAt(progressIndex, count, settings.rotation.mode, settings.rotation.stepValue);
      const finalAngleDeg = settings.rotation.relative
        ? currentVisibleRotationDeg + baseAngleDeg
        : baseAngleDeg;
      const deltaVisibleDeg = finalAngleDeg - currentVisibleRotationDeg;
      rotationValues.push(formatNumber(finalAngleDeg, 3));
      builder.addCommand(
        DocumentCommand.createTransform(
          Selection.create(doc, node),
          fromCenterOrig(bb, Transform.createRotate(visibleDeltaDegreesToCommandRadians(deltaVisibleDeg)))
        )
      );
      nonOpacityCommandCount += 1;
    }

    if (settings.color.enabled) {
      const progressIndex = settings.color.reverse ? (count - 1 - i) : i;
      const t = count > 1 ? progressIndex / (count - 1) : 0.5;
      const c = lerpColor(settings.color.start, settings.color.end, t);
      colorValues.push(formatRGBA(c));
      const nodeSelection = Selection.create(doc, node);
      if (settings.color.layerEffects) {
        const overlayIndexes = getColourOverlayIndexes(node);
        for (let j = overlayIndexes.length - 1; j >= 0; j--) {
          builder.addCommand(
            DocumentCommand.createRemoveColourOverlayLayerEffect(nodeSelection, overlayIndexes[j])
          );
        }
        const overlay = ColourOverlayLayerEffect.create();
        overlay.colour = RGBA8(c.r, c.g, c.b, c.a);
        overlay.opacity = 1.0;
        builder.addCommand(DocumentCommand.createSetColourOverlayLayerEffect(nodeSelection, overlay, 0));
      } else {
        const fd = FillDescriptor.createSolid(RGBA8(c.r, c.g, c.b, c.a));
        builder.addCommand(DocumentCommand.createSetBrushFill(nodeSelection, fd));
      }
      nonOpacityCommandCount += 1;
    }

    if (settings.opacity.enabled) {
      const progressIndex = settings.opacity.reverse ? (count - 1 - i) : i;
      const targetOpacity = computeOpacityAt(progressIndex, count);
      const finalOpacity = settings.opacity.relative
        ? clampOpacity(currentOpacity + targetOpacity)
        : targetOpacity;
      opacityValues.push(formatNumber(finalOpacity, 3));
      opacityOperations.push({ node, opacity: finalOpacity });
    }
  }

  if (settings.scale.enabled) {
    valueSections.push(`Scale:\n[${scaleValues.join(', ')}]`);
  }
  if (settings.rotation.enabled) {
    valueSections.push(`Rotation:\n[${rotationValues.join(', ')}]`);
  }
  if (settings.color.enabled) {
    valueSections.push(`${getColorValueHeading(settings.color)}\n[${colorValues.join(', ')}]`);
  }
  if (settings.opacity.enabled) {
    valueSections.push(`Opacity:\n[${opacityValues.join(', ')}]`);
  }

  // Opacity is applied per node with its selection made current, preserving
  // the v2.20 workaround while using one preview transaction for all properties.
  for (const op of opacityOperations) {
    const selection = Selection.create(doc, op.node);
    builder.addCommand(DocumentCommand.createSetSelection(selection));
    builder.addCommand(DocumentCommand.createSetOpacity(selection, op.opacity));
  }
  const hasCommands = nonOpacityCommandCount > 0 || opacityOperations.length > 0;
  if (hasCommands) builder.addCommand(DocumentCommand.createSetSelection(sourceSelection));
  return {
    command: hasCommands ? builder.createCommand() : null,
    opacityOperations,
    showValuesText: valueSections.join('\n\n'),
  };
}

function readSettings(dlg) {
return {
  order: ['position', 'layer', 'selection'][dlg.orderMode.selectedIndex],
  scale: {
    enabled: dlg.scaleEnabled.value,
    mode: dlg.scaleMode.selectedIndex === 0 ? 'even' : 'step',
    stepValue: Number(dlg.scaleStep.value),
    relative: dlg.scaleRelative.value,
    reverse: dlg.scaleReverse.value,
  },
  rotation: {
    enabled: dlg.rotEnabled.value,
    mode: dlg.rotMode.selectedIndex === 0 ? 'even' : 'step',
    stepValue: Number(dlg.rotStep.value),
    relative: dlg.rotRelative.value,
    reverse: dlg.rotReverse.value,
  },
  color: {
    enabled: dlg.colorEnabled.value,
    start: normalizeRGBA(dlg.colorStart.value) || { r: 0, g: 0, b: 0, a: 255 },
    end: normalizeRGBA(dlg.colorEnd.value) || { r: 255, g: 255, b: 255, a: 255 },
    layerEffects: dlg.colorLayerEffects.value,
    reverse: dlg.colorReverse.value,
  },
  opacity: {
    enabled: dlg.opacityEnabled.value,
    relative: dlg.opacityRelative.value,
    reverse: dlg.opacityReverse.value,
  },
};
}

function runDialog() {
  const dlg = buildDialog();
  let updating = false;
  let hasPreview = false;
  function clearPreview() {
    if (!hasPreview) return;
    doc.clearPreviews();
    hasPreview = false;
    restoreSourceSelection();
  }
  function updatePreview() {
    if (updating) return;
    updating = true;
    try {
      clearPreview();
      updateControlState(dlg);
      dlg.statusText.text = `Selected Elements: ${count}`;
      if (dlg.preview.value) {
        const analyzed = analyzeValues(readSettings(dlg));
        if (analyzed.command) {
          hasPreview = true;
          doc.executeCommand(analyzed.command, true);
        }
      }
    } catch (error) {
      clearPreview();
      updateControlState(dlg);
      dlg.statusText.text = `Preview error: ${String(error.message || error)}`;
    } finally {
      updating = false;
    }
  }
  dlg.onControlValueChangedHandler = updatePreview;
  try {
    const result = dlg.runModal();
    clearPreview();
    if (result.value !== DialogResult.Ok.value) return;
    const settings = readSettings(dlg);
    const analyzed = analyzeValues(settings);
    if (!analyzed.command) {
      app.alert('Please enable at least one property', APP_NAME);
      return;
    }
    if (dlg.showValues.value) {
      const names = orderedNodes[settings.order].map((n, i) =>
        `${i + 1}. ${n.userDescription || n.defaultDescription || 'Element'}`);
      app.alert(`Elements (${['Position', 'Layer Index', 'Selection'][dlg.orderMode.selectedIndex]}):\n${names.join('\n')}\n\n${analyzed.showValuesText}`, `${APP_NAME} - Values`);
    }
    doc.executeCommand(analyzed.command);
  } catch (error) {
    console.log(error.stack || String(error));
    app.alert(String(error.message || error), APP_NAME);
  } finally {
    clearPreview();
    restoreSourceSelection();
  }
}

runDialog();
