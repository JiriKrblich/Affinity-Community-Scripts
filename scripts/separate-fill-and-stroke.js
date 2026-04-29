
'use strict';
const { Document } = require('/document');
const { FillDescriptor } = require('/fills');

const doc = Document.current;
const selectedNodes = [...doc.selection.nodes];

if (selectedNodes.length === 0) {
  console.log('No nodes selected — please select at least one object.');
} else {
  let processed = 0, skipped = 0;

  for (const node of selectedNodes) {
    // Only process nodes that support both fill and stroke interfaces
    if (!node.brushFillInterface || !node.lineStyleInterface) {
      skipped++; continue;
    }

    const hasFill = node.hasBrushFill;
    const hasStroke = node.lineWeight > 0 && node.hasPenFill;

    if (!hasFill || !hasStroke) {
      console.log('Skipping (needs both fill AND stroke):', node.description);
      skipped++; continue;
    }

    const originalName = node.userDescription || node.defaultDescription || 'Object';

    // Duplicate the node — the duplicate lands ABOVE the original in the layer stack
    const strokeNode = node.duplicate();

    // Original (below) = Fill only: remove stroke
    node.lineWeight = 0;
    node.userDescription = originalName + ' – Fill';

    // Duplicate (above) = Stroke only: remove fill
    strokeNode.brushFillDescriptor = FillDescriptor.createNone();
    strokeNode.userDescription = originalName + ' – Stroke';

    processed++;
  }

  console.log(`Separate Fill and Stroke — done. Processed: ${processed}, Skipped: ${skipped}`);
}
