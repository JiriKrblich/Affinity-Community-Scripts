const { Document } = require("/document");
const { DocumentCommand } = require("/commands");

const doc = Document.current;
if (!doc) {
  console.log("ERROR: No document open.");
} else {
  const sel = doc.selection;

  if (sel.length === 0) {
    console.log("ERROR: No layer selected. Please select a layer first.");
  } else {
    const node = sel.at(0).node;

    if (!node) {
      console.log("ERROR: Could not read selected node.");
    } else {
      const layerName = node.userDescription || node.defaultDescription;
      const newVisibility = !node.isVisibleInDomain;

      console.log(
        'Layer: "' +
          layerName +
          '" | ' +
          (!newVisibility ? "visible → hiding" : "hidden → showing"),
      );

      const originalSpread = doc.currentSpread;
      let count = 0;

      for (const spread of doc.spreads) {
        doc.executeCommand(DocumentCommand.createSetCurrentSpread(spread));
        for (const layer of spread.layers) {
          const name = layer.userDescription || layer.defaultDescription;
          if (name === layerName) {
            doc.setVisible(newVisibility, layer);
            count++;
          }
        }
      }

      doc.executeCommand(
        DocumentCommand.createSetCurrentSpread(originalSpread),
      );
      console.log(
        "Done! Set " +
          count +
          ' layer(s) named "' +
          layerName +
          '" to ' +
          (newVisibility ? "visible" : "hidden") +
          ".",
      );
    }
  }
}
