/**
 * name: Progressive Transform v2.20.1
 * description: Progressive scale, rotation, color, and opacity with single-column settings layout, tab-style even/step switching, inline value labels, relative mode, corrected rotation semantics, fixed per-node opacity application, and a single color layer effects overwrite mode.
 * version: 2.20.1
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

const APP_NAME = 'Progressive Transform v2.20.1';
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

const sourceNodes = doc.selection.nodes;
const sourceSelection = Selection.create(doc, sourceNodes);

function restoreSourceSelection() {
  try {
    doc.selection = sourceSelection;
  } catch (_) {}
}

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

function applyOpacityOperations(operations) {
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    if (!op || !op.node) continue;
    try {
      const nodeSelection = Selection.create(doc, op.node);
      doc.selection = nodeSelection;
      doc.executeCommand(DocumentCommand.createSetOpacity(nodeSelection, op.opacity));
    } catch (_) {}
  }
}

function buildDialog() {
  const dlg = Dialog.create(APP_NAME);
  dlg.initialWidth = 380;
  dlg.isResizable = false;

  const col = dlg.addColumn();

  const scaleGroup = col.addGroup('Scale');
  dlg.scaleEnabled = scaleGroup.addSwitch('Enabled', false);
  dlg.scaleMode = scaleGroup.addButtonSet('', ['Even', 'Step'], 0);
  dlg.scaleMode.isFullWidth = true;
  dlg.scaleMode.setIsEnabledBy(dlg.scaleEnabled);
  dlg.scaleEvenInfo = scaleGroup.addStaticText('', 'Even Value: 0% -> 100%');
  dlg.scaleEvenInfo.isFullWidth = true;
  dlg.scaleEvenInfo.setIsEnabledBy(dlg.scaleEnabled);
  dlg.scaleStep = scaleGroup.addUnitValueEditor('Step Value', UnitType.Number, UnitType.Number, 0.25, -999999, 999999);
  dlg.scaleStep.precision = 3;
  dlg.scaleStep.showPopupSlider = false;
  dlg.scaleStep.setIsEnabledBy(dlg.scaleEnabled);
  dlg.scaleStep.setIsEnabledByControlIDWithSelectedIndex(dlg.scaleMode.controlID, 1);
  dlg.scaleRelative = scaleGroup.addSwitch('Relative', false);
  dlg.scaleRelative.setIsEnabledBy(dlg.scaleEnabled);
  dlg.scaleReverse = scaleGroup.addSwitch('Reverse', false);
  dlg.scaleReverse.setIsEnabledBy(dlg.scaleEnabled);
  dlg.scaleShowValues = scaleGroup.addSwitch('Show Values', false);
  dlg.scaleShowValues.setIsEnabledBy(dlg.scaleEnabled);

  const rotGroup = col.addGroup('Rotation');
  dlg.rotEnabled = rotGroup.addSwitch('Enabled', false);
  dlg.rotMode = rotGroup.addButtonSet('', ['Even', 'Step'], 0);
  dlg.rotMode.isFullWidth = true;
  dlg.rotMode.setIsEnabledBy(dlg.rotEnabled);
  dlg.rotEvenInfo = rotGroup.addStaticText('', `Even Value: 360° / ${count} = ${formatNumber(computeRotationEvenIncrement(count), 1)}°`);
  dlg.rotEvenInfo.isFullWidth = true;
  dlg.rotEvenInfo.setIsEnabledBy(dlg.rotEnabled);
  dlg.rotStep = rotGroup.addUnitValueEditor('Step Value', UnitType.Number, UnitType.Number, 15, -999999, 999999);
  dlg.rotStep.precision = 3;
  dlg.rotStep.showPopupSlider = false;
  dlg.rotStep.setIsEnabledBy(dlg.rotEnabled);
  dlg.rotStep.setIsEnabledByControlIDWithSelectedIndex(dlg.rotMode.controlID, 1);
  dlg.rotRelative = rotGroup.addSwitch('Relative', false);
  dlg.rotRelative.setIsEnabledBy(dlg.rotEnabled);
  dlg.rotReverse = rotGroup.addSwitch('Reverse', false);
  dlg.rotReverse.setIsEnabledBy(dlg.rotEnabled);
  dlg.rotShowValues = rotGroup.addSwitch('Show Values', false);
  dlg.rotShowValues.setIsEnabledBy(dlg.rotEnabled);

  const colorGroup = col.addGroup('Color');
  dlg.colorEnabled = colorGroup.addSwitch('Enabled', false);
  dlg.colorStart = colorGroup.addColourPicker('Start');
  dlg.colorEnd = colorGroup.addColourPicker('End');
  dlg.colorStart.allowPickNone = false;
  dlg.colorEnd.allowPickNone = false;
  dlg.colorStart.setIsEnabledBy(dlg.colorEnabled);
  dlg.colorEnd.setIsEnabledBy(dlg.colorEnabled);
  dlg.colorLayerEffects = colorGroup.addSwitch('Layer Effects', false);
  dlg.colorLayerEffects.setIsEnabledBy(dlg.colorEnabled);
  dlg.colorReverse = colorGroup.addSwitch('Reverse', false);
  dlg.colorReverse.setIsEnabledBy(dlg.colorEnabled);
  dlg.colorShowValues = colorGroup.addSwitch('Show Values', false);
  dlg.colorShowValues.setIsEnabledBy(dlg.colorEnabled);

  const opacityGroup = col.addGroup('Opacity');
  dlg.opacityEnabled = opacityGroup.addSwitch('Enabled', false);
  dlg.opacityEvenInfo = opacityGroup.addStaticText('', `Even Value: ${formatNumber(computeOpacityEvenIncrement(count) * 100, 1)}%`);
  dlg.opacityEvenInfo.isFullWidth = true;
  dlg.opacityEvenInfo.setIsEnabledBy(dlg.opacityEnabled);
  dlg.opacityRelative = opacityGroup.addSwitch('Relative', false);
  dlg.opacityRelative.setIsEnabledBy(dlg.opacityEnabled);
  dlg.opacityReverse = opacityGroup.addSwitch('Reverse', false);
  dlg.opacityReverse.setIsEnabledBy(dlg.opacityEnabled);
  dlg.opacityShowValues = opacityGroup.addSwitch('Show Values', false);
  dlg.opacityShowValues.setIsEnabledBy(dlg.opacityEnabled);

  const firstItem = doc.selection.at(0);
  const lastItem = doc.selection.at(count - 1);
  const firstColor = firstItem && firstItem.node ? getNodeSolidRGBA(firstItem.node) : null;
  const lastColor = lastItem && lastItem.node ? getNodeSolidRGBA(lastItem.node) : null;
  const startDefault = firstColor || { r: 0, g: 0, b: 0, a: 255 };
  const endDefault = lastColor || { r: 255, g: 255, b: 255, a: 255 };
  dlg.colorStart.value = RGBA8(startDefault.r, startDefault.g, startDefault.b, startDefault.a);
  dlg.colorEnd.value = RGBA8(endDefault.r, endDefault.g, endDefault.b, endDefault.a);

  const statusGroup = col.addGroup('');
  dlg.statusText = statusGroup.addStaticText('', `Selected Elements: ${count}`);
  dlg.statusText.isFullWidth = true;

  return dlg;
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
    const item = doc.selection.at(i);
    const node = item && item.node;
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

  if (settings.scale.enabled && settings.scale.showValues) {
    valueSections.push(`Scale:\n[${scaleValues.join(', ')}]`);
  }
  if (settings.rotation.enabled && settings.rotation.showValues) {
    valueSections.push(`Rotation:\n[${rotationValues.join(', ')}]`);
  }
  if (settings.color.enabled && settings.color.showValues) {
    valueSections.push(`${getColorValueHeading(settings.color)}\n[${colorValues.join(', ')}]`);
  }
  if (settings.opacity.enabled && settings.opacity.showValues) {
    valueSections.push(`Opacity:\n[${opacityValues.join(', ')}]`);
  }

  return {
    command: nonOpacityCommandCount > 0 ? builder.createCommand() : null,
    opacityOperations,
    showValuesText: valueSections.join('\n\n'),
  };
}

const dlg = buildDialog();
const result = dlg.runModal();

if (result.value !== DialogResult.Ok.value) {
  return;
}

const settings = {
  scale: {
    enabled: dlg.scaleEnabled.value,
    mode: dlg.scaleMode.selectedIndex === 0 ? 'even' : 'step',
    stepValue: Number(dlg.scaleStep.value),
    relative: dlg.scaleRelative.value,
    reverse: dlg.scaleReverse.value,
    showValues: dlg.scaleShowValues.value,
  },
  rotation: {
    enabled: dlg.rotEnabled.value,
    mode: dlg.rotMode.selectedIndex === 0 ? 'even' : 'step',
    stepValue: Number(dlg.rotStep.value),
    relative: dlg.rotRelative.value,
    reverse: dlg.rotReverse.value,
    showValues: dlg.rotShowValues.value,
  },
  color: {
    enabled: dlg.colorEnabled.value,
    start: normalizeRGBA(dlg.colorStart.value) || { r: 0, g: 0, b: 0, a: 255 },
    end: normalizeRGBA(dlg.colorEnd.value) || { r: 255, g: 255, b: 255, a: 255 },
    layerEffects: dlg.colorLayerEffects.value,
    reverse: dlg.colorReverse.value,
    showValues: dlg.colorShowValues.value,
  },
  opacity: {
    enabled: dlg.opacityEnabled.value,
    relative: dlg.opacityRelative.value,
    reverse: dlg.opacityReverse.value,
    showValues: dlg.opacityShowValues.value,
  },
};

if (!settings.scale.enabled && !settings.rotation.enabled && !settings.color.enabled && !settings.opacity.enabled) {
  app.alert('Step 2: Please enable at least one property', APP_NAME);
  return;
}

const analyzed = analyzeValues(settings);

if (analyzed.showValuesText) {
  app.alert(analyzed.showValuesText, `${APP_NAME} - Values`);
}

if (analyzed.command) {
  doc.executeCommand(analyzed.command);
}
if (analyzed.opacityOperations.length > 0) {
  applyOpacityOperations(analyzed.opacityOperations);
}
restoreSourceSelection();
