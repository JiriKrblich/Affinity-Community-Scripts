'use strict';

// Radial Orbit Repeat Live v7.1
// Duplicates the current selection around one or more circular rows.
// Preview is rebuilt live from the original selection and committed only on OK.
// During preview the original is hidden; on OK it is removed so only the radial copies remain.
// With multiple selected objects, placements cycle through them: A, B, C, A, B, C...
// Row Template Mode can instead map selected objects per row, e.g. A.B.A.
// The committed copies are placed inside a container.

const { Document } = require('/document');
const { Dialog, DialogResult } = require('/dialog');
const { DocumentCommand, CompoundCommandBuilder, AddChildNodesCommandBuilder } = require('/commands');
const { Transform } = require('/geometry');
const { ContainerNodeDefinition } = require('/nodes');
const { UnitType } = require('/units');
const { NodeMoveType, NodeChildType } = require('affinity:dom');

const SCRIPT_TITLE = 'Radial Orbit Repeat Live v7.1';
const MAX_TOTAL_INSTANCES = 5000;
const PREVIEW_HIDE_OFFSET = 1000000;
const PREVIEW_HIDE_SCALE = 0.0001;

const doc = Document.current;

if (!doc) {
  showError('Open a document in Affinity.');
} else {
  const selectedNodes = getSelectedNodes(doc);

  if (!selectedNodes.length) {
    showError('Select at least one object.');
  } else {
    runRadialRepeat(doc, selectedNodes);
  }
}

function showError(message) {
  try {
    const d = Dialog.create(SCRIPT_TITLE);
    d.addColumn().addGroup('Error').addStaticText('', message);
    d.show();
  } catch (e) {
    alert(message);
  }
}

function pushUnique(nodes, node) {
  if (!node) return;

  for (const existing of nodes) {
    try {
      if (existing.isSameNode && existing.isSameNode(node)) return;
    } catch (e) {
      // Ignore stale node handles.
    }
  }

  nodes.push(node);
}

function getSelectedNodes(document) {
  const nodes = [];
  const selection = document.selection;

  try {
    if (selection && typeof selection.length === 'number') {
      for (let i = 0; i < selection.length; i++) {
        pushUnique(nodes, selection.at(i).node);
      }
    }
  } catch (e) {
    // Fall through to alternate selection APIs.
  }

  try {
    if (selection && selection.items) {
      for (const item of selection.items) {
        pushUnique(nodes, item.node);
      }
    }
  } catch (e) {
    // Fall through to nodes.toArray().
  }

  try {
    if (selection && selection.nodes) {
      for (const node of selection.nodes.toArray()) {
        pushUnique(nodes, node);
      }
    }
  } catch (e) {
    // No supported selection API returned nodes.
  }

  return nodes;
}

function readNodeBox(node) {
  try {
    const b = node.getSpreadBaseBox(false);

    if (b && b.width !== undefined && b.height !== undefined) {
      return {
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height
      };
    }

    if (b && b.x0 !== undefined && b.x1 !== undefined && b.y0 !== undefined && b.y1 !== undefined) {
      return {
        x: b.x0,
        y: b.y0,
        width: b.x1 - b.x0,
        height: b.y1 - b.y0
      };
    }
  } catch (e) {
    // Unsupported node type.
  }

  return null;
}

function buildSelectionGeometry(nodes) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let count = 0;

  for (const node of nodes) {
    const b = readNodeBox(node);
    if (!b) continue;

    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.width);
    y1 = Math.max(y1, b.y + b.height);
    count++;
  }

  if (!count) return null;

  return {
    center: {
      x: (x0 + x1) / 2,
      y: (y0 + y1) / 2
    },
    box: {
      x: x0,
      y: y0,
      width: x1 - x0,
      height: y1 - y0
    }
  };
}

function clamp(value, minValue, maxValue) {
  return Math.max(minValue, Math.min(maxValue, value));
}

function degToRad(value) {
  return value * Math.PI / 180;
}

function countTotalInstances(params) {
  let total = 0;

  for (let row = 0; row < params.rows; row++) {
    total += Math.max(1, params.instances + row * params.addedInstancesPerRow);
  }

  return total;
}

function buildPlacements(params, center) {
  const total = countTotalInstances(params);

  if (total > MAX_TOTAL_INSTANCES) {
    throw new Error('Too many instances (' + total + ')). Limit is ' + MAX_TOTAL_INSTANCES + '.');
  }

  const placements = [];

  for (let row = 0; row < params.rows; row++) {
    const count = Math.max(1, params.instances + row * params.addedInstancesPerRow);
    const radius = Math.max(0, params.radius + row * params.rowSpacing);
    const rowOffset = params.rowRotation * row;
    const rowScale = Math.pow(params.rowScaling, row);

    for (let i = 0; i < count; i++) {
      const circleT = i / count;
      const scaleT = count > 1 ? i / (count - 1) : 0;
      const angleDeg = rowOffset + circleT * 360;
      const angleRad = degToRad(angleDeg);
      const scale = (params.startScale + (params.endScale - params.startScale) * scaleT) * rowScale * (params.sizeScale || 1);
      const rotationDeg = params.customRotation ? params.customAngle : angleDeg;

      placements.push({
        row,
        x: center.x + Math.cos(angleRad) * radius,
        y: center.y + Math.sin(angleRad) * radius,
        scale: Math.max(0.001, scale),
        rotation: degToRad(rotationDeg)
      });
    }
  }

  return placements;
}

function buildPlacementTransform(sourceCenter, placement) {
  return Transform
    .createTranslate(placement.x, placement.y)
    .multiply(Transform.createRotate(placement.rotation))
    .multiply(Transform.createScale(placement.scale, placement.scale))
    .multiply(Transform.createTranslate(-sourceCenter.x, -sourceCenter.y));
}

function getNodeCenter(node, fallbackCenter) {
  const box = readNodeBox(node);

  if (!box) return fallbackCenter;

  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2
  };
}

function indexToTemplateLetter(index) {
  let n = index;
  let label = '';

  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);

  return label;
}

function buildObjectLabelText(count) {
  const labels = [];

  for (let i = 0; i < count; i++) {
    labels.push((i + 1) + '=' + indexToTemplateLetter(i));
  }

  return labels.join('  ');
}

function buildDefaultRowPattern(rowCount, templateCount) {
  const rows = Math.max(1, Math.round(rowCount));
  const templates = Math.max(1, templateCount);
  const pattern = [];

  for (let row = 0; row < rows; row++) {
    pattern.push(String((row % templates) + 1));
  }

  return pattern.join('.');
}

function parseTemplateToken(token, templateCount) {
  const clean = String(token || '').trim().toUpperCase();
  if (!clean) return null;

  const asNumber = parseInt(clean, 10);
  if (!isNaN(asNumber)) {
    return clamp(asNumber - 1, 0, templateCount - 1);
  }

  let value = 0;

  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    if (code < 65 || code > 90) return null;
    value = value * 26 + (code - 64);
  }

  return clamp(value - 1, 0, templateCount - 1);
}

function parseRowTemplatePattern(text, templateCount) {
  if (templateCount <= 1) return [0];

  const tokens = String(text || '')
    .split(/[^0-9A-Za-z]+/)
    .filter(token => token.length > 0);
  const result = [];

  for (const token of tokens) {
    const parsed = parseTemplateToken(token, templateCount);
    if (parsed !== null) result.push(parsed);
  }

  return result.length ? result : [0];
}

function getTemplateIndexForPlacement(placementIndex, placement, nodes, params) {
  if (nodes.length <= 1) return 0;

  if (params.rowTemplateMode) {
    const map = params.rowTemplateMap && params.rowTemplateMap.length ? params.rowTemplateMap : [0];
    return map[placement.row % map.length] % nodes.length;
  }

  return placementIndex % nodes.length;
}

function buildPreviewHideTransform(sourceCenter) {
  return Transform
    .createTranslate(sourceCenter.x + PREVIEW_HIDE_OFFSET, sourceCenter.y + PREVIEW_HIDE_OFFSET)
    .multiply(Transform.createScale(PREVIEW_HIDE_SCALE, PREVIEW_HIDE_SCALE))
    .multiply(Transform.createTranslate(-sourceCenter.x, -sourceCenter.y));
}

function createRadialRepeatCommand(nodes, geometry, params, hideOriginal) {
  const placements = buildPlacements(params, geometry.center);
  const sourceCenters = nodes.map(node => getNodeCenter(node, geometry.center));
  const cb = CompoundCommandBuilder.create();
  let commandCount = 0;

  for (let placementIndex = 0; placementIndex < placements.length; placementIndex++) {
    const templateIndex = getTemplateIndexForPlacement(placementIndex, placements[placementIndex], nodes, params);
    const node = nodes[templateIndex];
    const transform = buildPlacementTransform(sourceCenters[templateIndex], placements[placementIndex]);

    cb.addCommand(
      DocumentCommand.createTransform(node.selfSelection, transform, { duplicateNodes: true }),
      false
    );
    commandCount++;
  }

  if (hideOriginal) {
    const hideTransform = buildPreviewHideTransform(geometry.center);

    for (const node of nodes) {
      cb.addCommand(
        DocumentCommand.createTransform(node.selfSelection, hideTransform, { duplicateNodes: false }),
        false
      );
      commandCount++;
    }
  }

  return commandCount ? cb.createCommand() : null;
}

function clearPreviews(document) {
  try {
    document.executeCommand(DocumentCommand.createClearPreviews());
  } catch (e) {
    console.log(SCRIPT_TITLE + ' clear preview failed: ' + e);
  }
}

function deleteOriginalNodes(document, nodes) {
  for (const node of nodes) {
    try {
      document.deleteSelection(node.selfSelection);
    } catch (e) {
      console.log(SCRIPT_TITLE + ' delete original failed: ' + e);
    }
  }
}

function groupIntoContainer(document, nodes, name) {
  if (!nodes || !nodes.length) return null;

  try {
    const definition = ContainerNodeDefinition.create(name);
    const builder = AddChildNodesCommandBuilder.create();
    builder.setInsertionTargetSelection(nodes[0].selfSelection);
    builder.addContainerNode(definition);

    const addCommand = builder.createCommand();
    document.executeCommand(addCommand);

    const container = addCommand.newNodes && addCommand.newNodes[0];
    if (!container) return null;

    const moveBuilder = CompoundCommandBuilder.create();

    for (let i = nodes.length - 1; i >= 0; i--) {
      moveBuilder.addCommand(
        DocumentCommand.createMoveNodes(nodes[i].selfSelection, container, NodeMoveType.Inside, NodeChildType.Main),
        false
      );
    }

    document.executeCommand(moveBuilder.createCommand());
    return container;
  } catch (e) {
    console.log(SCRIPT_TITLE + ' group result failed: ' + e);
    return null;
  }
}

function runRadialRepeat(document, nodes) {
  const geometry = buildSelectionGeometry(nodes);

  if (!geometry) {
    showError('Cannot read bounds of the selected object.');
    return;
  }

  const dlg = Dialog.create('Radial Repeat');
  dlg.initialWidth = 620;

  const col = dlg.addColumn();

  const instancesGrp = col.addGroup('Instances & Rows');
  const instancesCtrl = instancesGrp.addUnitValueEditor('Instances', UnitType.Number, UnitType.Number, 6, 1, 500);
  instancesCtrl.precision = 0;
  const radiusCtrl = instancesGrp.addUnitValueEditor('Radius (px)', UnitType.Number, UnitType.Number, 250, 0, 100000);
  radiusCtrl.precision = 1;
  radiusCtrl.showPopupSlider = true;
  const sizeCtrl = instancesGrp.addUnitValueEditor('Size (%)', UnitType.Percentage, UnitType.Percentage, 100, 1, 1000);
  sizeCtrl.precision = 1;
  sizeCtrl.showPopupSlider = true;
  const rowsCtrl = instancesGrp.addUnitValueEditor('Rows', UnitType.Number, UnitType.Number, 1, 1, 100);
  rowsCtrl.precision = 0;
  const rowSpacingCtrl = instancesGrp.addUnitValueEditor('Row Spacing (px)', UnitType.Number, UnitType.Number, 50, 0, 100000);
  rowSpacingCtrl.precision = 1;
  rowSpacingCtrl.showPopupSlider = true;
  const addedCtrl = instancesGrp.addUnitValueEditor('Added Instances Per Row', UnitType.Number, UnitType.Number, 0, 0, 500);
  addedCtrl.precision = 0;
  const rowRotationCtrl = instancesGrp.addUnitValueEditor('Row Rotation', UnitType.Degree, UnitType.Degree, 0, -3600, 3600);
  rowRotationCtrl.precision = 1;

  const rotationGrp = col.addGroup('Rotation');
  const customRotationCtrl = rotationGrp.addSwitch('Enable Custom Rotation', false);
  const customAngleCtrl = rotationGrp.addUnitValueEditor('Angle (deg)', UnitType.Degree, UnitType.Degree, 0, -3600, 3600);
  customAngleCtrl.precision = 1;

  const scalingGrp = col.addGroup('Scaling');
  const startScaleCtrl = scalingGrp.addUnitValueEditor('Instances Start Scale (%)', UnitType.Percentage, UnitType.Percentage, 100, 1, 1000);
  startScaleCtrl.precision = 1;
  startScaleCtrl.showPopupSlider = true;
  const endScaleCtrl = scalingGrp.addUnitValueEditor('Instances End Scale (%)', UnitType.Percentage, UnitType.Percentage, 100, 1, 1000);
  endScaleCtrl.precision = 1;
  endScaleCtrl.showPopupSlider = true;
  const rowScaleCtrl = scalingGrp.addUnitValueEditor('Row Scaling (%)', UnitType.Percentage, UnitType.Percentage, 100, 1, 1000);
  rowScaleCtrl.precision = 1;
  rowScaleCtrl.showPopupSlider = true;

  const templateCol = dlg.addColumn();
  const templateGrp = templateCol.addGroup('Template Mode');
  const rowTemplateModeCtrl = templateGrp.addSwitch('Enable Row Template Mode', false);
  const objectLabelsCtrl = templateGrp.addStaticText('Selected Objects', buildObjectLabelText(nodes.length));
  const defaultPattern = buildDefaultRowPattern(rowsCtrl.value, nodes.length);
  const rowPatternCtrl = templateGrp.addTextBox('Row Object Pattern', defaultPattern);
  rowPatternCtrl.isFullWidth = true;
  rowPatternCtrl.isMultiLine = true;
  rowPatternCtrl.rowSpan = 2;
  const rowPatternHelpCtrl = templateGrp.addStaticText(
    'Pattern Help',
    'Use numbers or letters to choose the object for each row. Example: for 5 rows, 1.1.1.1.1 uses object 1 on every row; 1.2.1.2.1 alternates objects. To change color per row, select colored variants first, e.g. 1=red and 2=blue, then type the row order you want.'
  );
  rowPatternHelpCtrl.isFullWidth = true;
  const rowTemplateRequirementCtrl = templateGrp.addStaticText(
    '! Requirement',
    'Row Template Mode only works if you selected two or more objects before running this script.'
  );
  rowTemplateRequirementCtrl.isFullWidth = true;

  function updateTemplateControls() {
    objectLabelsCtrl.isEnabled = nodes.length > 1;
  }

  function readValues() {
    const rows = clamp(Math.round(rowsCtrl.value), 1, 100);

    return {
      instances: clamp(Math.round(instancesCtrl.value), 1, 500),
      radius: clamp(radiusCtrl.value, 0, 100000),
      sizeScale: clamp(sizeCtrl.value, 1, 1000) / 100,
      rows,
      rowSpacing: clamp(rowSpacingCtrl.value, 0, 100000),
      addedInstancesPerRow: clamp(Math.round(addedCtrl.value), 0, 500),
      rowRotation: clamp(rowRotationCtrl.value, -3600, 3600),
      customRotation: !!customRotationCtrl.value,
      customAngle: clamp(customAngleCtrl.value, -3600, 3600),
      startScale: clamp(startScaleCtrl.value, 1, 1000) / 100,
      endScale: clamp(endScaleCtrl.value, 1, 1000) / 100,
      rowScaling: clamp(rowScaleCtrl.value, 1, 1000) / 100,
      rowTemplateMode: rowTemplateModeCtrl.value && nodes.length > 1,
      rowTemplateMap: parseRowTemplatePattern(rowPatternCtrl.text, nodes.length)
    };
  }

  let inPreview = false;

  function applyPreview() {
    if (inPreview) return;
    inPreview = true;

    try {
      const params = readValues();
      clearPreviews(document);

      const cmd = createRadialRepeatCommand(nodes, geometry, params, true);
      if (cmd) document.executeCommand(cmd, true);
    } catch (e) {
      console.log(SCRIPT_TITLE + ' preview failed: ' + e);
      clearPreviews(document);
    } finally {
      inPreview = false;
    }
  }

  instancesCtrl.onValueChangedHandler = applyPreview;
  radiusCtrl.onValueChangedHandler = applyPreview;
  sizeCtrl.onValueChangedHandler = applyPreview;
  rowsCtrl.onValueChangedHandler = applyPreview;
  rowSpacingCtrl.onValueChangedHandler = applyPreview;
  addedCtrl.onValueChangedHandler = applyPreview;
  rowRotationCtrl.onValueChangedHandler = applyPreview;
  customRotationCtrl.onValueChangedHandler = applyPreview;
  customAngleCtrl.onValueChangedHandler = applyPreview;
  startScaleCtrl.onValueChangedHandler = applyPreview;
  endScaleCtrl.onValueChangedHandler = applyPreview;
  rowScaleCtrl.onValueChangedHandler = applyPreview;
  rowTemplateModeCtrl.onValueChangedHandler = function() {
    updateTemplateControls();
    applyPreview();
  };
  rowPatternCtrl.onValueChangedHandler = applyPreview;

  updateTemplateControls();
  applyPreview();
  const result = dlg.show();

  if (result.value === DialogResult.Ok.value) {
    const finalParams = readValues();
    clearPreviews(document);

    try {
      const cmd = createRadialRepeatCommand(nodes, geometry, finalParams, false);
      if (cmd) {
        document.executeCommand(cmd);
        groupIntoContainer(document, cmd.newNodes || [], 'Radial Repeat');
        deleteOriginalNodes(document, nodes);
      }
    } catch (e) {
      showError('Aplicarea a esuat:\n' + e.message);
    }
  } else {
    clearPreviews(document);
  }
}
