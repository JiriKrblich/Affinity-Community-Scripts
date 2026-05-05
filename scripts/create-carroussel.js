
'use strict';

const { Document, NewDocumentOptions } = require('/document');
const { Dialog, DialogResult } = require('/dialog');
const { UnitType } = require('/units');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');

const dlg = Dialog.create('Create Carroussel');
dlg.initialWidth = 340;

const col = dlg.addColumn();
const grpPanel = col.addGroup('Panel dimensions');
const widthCtrl  = grpPanel.addUnitValueEditor('Width (px)',  UnitType.Pixel, UnitType.Pixel, 1080, 1, 10000);
const heightCtrl = grpPanel.addUnitValueEditor('Height (px)', UnitType.Pixel, UnitType.Pixel, 1350, 1, 10000);

const grpCarr = col.addGroup('Carroussel settings');
const numPanelsCtrl = grpCarr.addComboBox('Number of panels', ['2','3','4','5','6','7','8'], 2);

const result = dlg.runModal();
if (!result.equals(DialogResult.Ok)) {
  console.log('Cancelled.');
} else {
  const panelW   = Math.round(widthCtrl.value);
  const panelH   = Math.round(heightCtrl.value);
  const numPanels = parseInt(['2','3','4','5','6','7','8'][numPanelsCtrl.selectedIndex]);
  const docW     = panelW * numPanels;

  const opts = NewDocumentOptions.createDefault();
  opts.units          = UnitType.Pixel;
  opts.width          = docW;
  opts.height         = panelH;
  opts.dpi            = 72;
  opts.isLandscape    = docW > panelH;
  opts.createArtboard = false;
  opts.marginsEnabled = false;

  const doc = Document.create(opts);
  if (!doc) {
    alert('Failed to create document.');
  } else {
    const builder = CompoundCommandBuilder.create();
    for (let i = 1; i < numPanels; i++) {
      builder.addCommand(DocumentCommand.createAddGuide(false, panelW * i));
    }
    doc.executeCommand(builder.createCommand());

    console.log('Document created: ' + doc.widthPixels + 'x' + doc.heightPixels + 'px @ ' + doc.dpi + 'dpi');
    console.log('Vertical guides added: ' + (numPanels - 1));

    alert('✅ Carroussel document created!\n\n' +
          'Document: ' + docW + ' x ' + panelH + ' px  |  72 dpi  |  RGB\n' +
          'Panels: ' + numPanels + ' × ' + panelW + ' x ' + panelH + ' px\n' +
          'Guides: ' + (numPanels - 1) + ' vertical guide(s) added\n\n' +
          '📌 NOTE: Guide colour (#0DCAF2) cannot be set via script\n' +
          'in this version of Affinity. Set it manually if desired\n' +
          'under View > Margins and Guides.');
  }
}
