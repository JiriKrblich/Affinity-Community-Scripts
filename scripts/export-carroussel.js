/**
 * name: Export Carroussel
 * description: Export a single document as individual panels of a specified size.
 * version: 1.2.1
 * author: rbonelli
 * contributors: jirikrblich
 *
 * 1.2.1 - Use installed export presets, handle dialog cancellation, and
 * remove temporary export rectangles even when an export fails.
 */

'use strict';
const { Document, FileExportOptions, FileExportArea } = require('/document');
const { Dialog, DialogResult } = require('/dialog');
const { UnitType } = require('/units');
const { app } = require('/application');
const { AddChildNodesCommandBuilder, DocumentCommand } = require('/commands');
const { ShapeNodeDefinition } = require('/nodes');
const { ShapeRectangle } = require('/shapes');
const { Colour } = require('/colours');
const { FillDescriptor } = require('/fills');
const { Selection } = require('/selections');

function getFolder(filePath) {
  const sep = filePath.includes('\\') ? '\\' : '/';
  return filePath.split(sep).slice(0, -1).join(sep);
}

const doc = Document.current;
if (!doc) { alert('No document is open.'); }
else {

const docW = doc.widthPixels;
const docH = doc.heightPixels;
const desktopPath = app.userDesktopPath;
const docFolder = doc.path ? getFolder(doc.path) : null;

const dlg = Dialog.create('Export Carroussel');
dlg.initialWidth = 380;
const col = dlg.addColumn();

col.addGroup('Current document').addStaticText('Dimensions', docW + ' × ' + docH + ' px');

const grpPanel = col.addGroup('Panel dimensions');
const widthCtrl  = grpPanel.addUnitValueEditor('Width (px)',  UnitType.Pixel, UnitType.Pixel, 1080, 1, docW);
const heightCtrl = grpPanel.addUnitValueEditor('Height (px)', UnitType.Pixel, UnitType.Pixel, docH, 1, docH);

const grpExp = col.addGroup('Export settings');
const panelOptions = ['2','3','4','5','6','7','8','9','10','11','12','13','14','15','16','17','18','19','20'];
const numPanelsCtrl = grpExp.addComboBox('Number of panels', panelOptions, 2); // index 2 = 4 panels (default)
const formats = Array.from(FileExportOptions.allPresetNames)
  .filter(name => /^(?:PNG$|JPEG\s*\(|WebP\s*\()/i.test(name));
if (!formats.length) {
  app.alert('No PNG, JPEG or WebP export presets are available.', 'Export Carroussel');
  return;
}
const formatCtrl = grpExp.addComboBox('Format', formats, Math.max(0, formats.indexOf('PNG')));
const prefixCtrl    = grpExp.addTextBox('File prefix', 'panel');

const destOptions = ['Desktop'];
if (docFolder) destOptions.push('Document folder');
const grpDest = col.addGroup('Destination');
const destCtrl = grpDest.addComboBox('Save to', destOptions, 0);

let result;
try { result = dlg.runModal(); }
catch (error) {
  if (!/ABORTED/i.test(String(error && (error.code || error.message) || error))) throw error;
}
if ((result?.value ?? result) !== DialogResult.Ok.value) { console.log('Cancelled.'); }
else {
  const panelW    = Math.round(widthCtrl.value);
  const panelH    = Math.round(heightCtrl.value);
  const numPanels = parseInt(panelOptions[numPanelsCtrl.selectedIndex]);
  const format    = formats[formatCtrl.selectedIndex];
  const ext       = /^PNG/i.test(format) ? 'png' : /^JPEG/i.test(format) ? 'jpg' : 'webp';
  const prefix    = prefixCtrl.text.trim() || 'panel';
  const dest      = destOptions[destCtrl.selectedIndex];

  const outputFolder = dest === 'Document folder' ? docFolder : desktopPath;
  const sep = outputFolder.includes('\\') ? '\\' : '/';
  const exportOptions = FileExportOptions.createWithPresetName(format);
  let errors = 0;
  const exported = [];
  const originalSelection = doc.selection;

  try {
  for (let i = 0; i < numPanels; i++) {
    const rect = { x: panelW * i, y: 0, width: panelW, height: panelH };
    const def = ShapeNodeDefinition.create(ShapeRectangle.create(), rect,
      FillDescriptor.createSolid(Colour.createRGBA8({ r: 255, g: 0, b: 0, alpha: 10 })), null, null, null);
    def.userDescription = '__slice_tmp__';

    const builder = AddChildNodesCommandBuilder.create();
    builder.setInsertionTarget(doc.currentSpread);
    builder.addShapeNode(def);
    const command = builder.createCommand(true);
    doc.executeCommand(command);

    const helperNode = command.newNodes[0];
    if (!helperNode) { errors++; continue; }

    try {
    const exportArea = FileExportArea.createForSelectionArea(helperNode.selfSelection);
    doc.executeCommand(DocumentCommand.createSetVisibility(helperNode.selfSelection, false));

    const fileName = prefix + '_' + (i + 1) + '.' + ext;
    const records  = doc.export(outputFolder + sep + fileName, exportOptions, exportArea);

    for (const r of records.all) {
      if (r.isSuccess) { exported.push(fileName); console.log('OK: ' + fileName); }
      else             { errors++;                 console.log('ERROR: ' + r.errorMessage); }
    }
    } catch (error) {
      errors++;
      console.log('ERROR: panel ' + (i + 1) + ': ' + (error.message || error));
    } finally {
      doc.deleteSelection(Selection.create(doc, [helperNode]));
    }
  }
  } finally {
    doc.selection = originalSelection;
  }

  alert(errors === 0
    ? '✅ ' + exported.length + ' file(s) exported successfully!\n\nDestination:\n' + outputFolder + '\n\nFiles:\n' + exported.join('\n')
    : '⚠️ Completed with ' + errors + ' error(s).\n\nExported:\n' + exported.join('\n'));
}
}
