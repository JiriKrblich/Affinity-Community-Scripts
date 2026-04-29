const { Document } = require("/document");
const { DocumentCommand } = require("/commands");
const { Selection } = require("/selections");
const { NodeMoveType, NodeChildType } = require("affinity:dom");

const doc = Document.current;
const sel = doc.selection;

if (sel.length === 0) {
  console.log("ERROR: No layer selected. Please select a layer first.");
} else {
  const node = sel.at(0).node;
  const layerName = node.userDescription || node.defaultDescription;
  console.log('Layer name: "' + layerName + '"');

  const originalSpread = doc.currentSpread;
  let count = 0;

  for (const spread of doc.spreads) {
    doc.executeCommand(DocumentCommand.createSetCurrentSpread(spread));

    for (const layer of spread.layers) {
      const name = layer.userDescription || layer.defaultDescription;
      if (name === layerName) {
        const topLayer = spread.children.last;
        if (!layer.isSameNode(topLayer)) {
          const layerSel = Selection.create(doc, layer);
          const cmd = DocumentCommand.createMoveNodes(
            layerSel,
            topLayer,
            NodeMoveType.After,
            NodeChildType.Main,
          );
          doc.executeCommand(cmd);
          console.log(
            'Moved "' +
              name +
              '" to top on spread page ' +
              spread.firstPageIndex,
          );
          count++;
        } else {
          console.log(
            '"' +
              name +
              '" already on top on spread page ' +
              spread.firstPageIndex,
          );
        }
      }
    }
  }

  doc.executeCommand(DocumentCommand.createSetCurrentSpread(originalSpread));
  console.log(
    "Done! Moved " + count + ' layer(s) named "' + layerName + '" to top.',
  );
}
