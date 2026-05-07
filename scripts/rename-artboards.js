/**
 * name: Rename Artboards
 * description: Batch rename all artboards in a document with sequential numbering.
 * version: 1.0.0
 * author: Heitor Hatherly
 */

const { Document } = require('/document.js');
const { Dialog, DialogResult } = require('/dialog.js');

const doc = Document.current;
if (!doc) { console.log('Erro: nenhum documento aberto.'); }

const artboards = [];
for (const spread of doc.spreads) {
  for (const layer of spread.layers) {
    if (layer.artboardInterface && layer.artboardInterface.isArtboardEnabled) {
      artboards.push(layer);
    }
  }
}

if (artboards.length === 0) {
  console.log('Nenhum artboard encontrado.');
} else {
  const dialog = Dialog.create('Renomear Artboards');
  const col = dialog.addColumn();
  const grp = col.addGroup('');
  const textBox = grp.addTextBox('Nome base:', '');
  textBox.isFullWidth = true;

  const result = dialog.runModal();

  if (result.value === DialogResult.Ok.value) {
    const baseName = textBox.text.trim();
    if (!baseName) {
      console.log('Nome vazio, operação cancelada.');
    } else {
      const total = artboards.length;
      const digits = total > 99 ? 3 : 2;

      artboards.forEach((ab, i) => {
        const num = String(i + 1).padStart(digits, '0');
        const newName = total === 1 ? baseName : `${baseName} ${num}`;
        doc.setLayerDescription(newName, ab);
        console.log('Renomeado: ' + newName);
      });

      console.log('Concluído! ' + total + ' artboard(s) renomeado(s).');
    }
  } else {
    console.log('Cancelado.');
  }
}