'use strict';
// color-boost.js
//
// Adds ONE Selective Colour adjustment layer ("Color Boost") that saturates all
// six colour ranges using classic CMY complement logic. Per range it does two
// things at once:
//   - removes the contaminating ink (the one that makes the colour muddy), and
//   - adds the primary inks (the ones the colour is made of).
// e.g. Reds are made of Magenta + Yellow and muddied by Cyan, so the Reds range
// gets −Cyan +Magenta +Yellow. Neutrals (whites/greys/blacks) are untouched
// because only the six colour ranges carry weights.
//
// Tune it with the two parameters below. Re-running replaces the previous
// layer, so you can iterate freely.

const STRENGTH = 1.0;   // ink weight per range, 0..1 (leave at 1.0, use opacity to taste)
const OPACITY  = 0.25;  // layer opacity = overall effect strength (0.25 is a gentle default)

const LAYER_NAME = 'Color Boost';

const { Document } = require('/document');
const { DocumentCommand, NodeChildType,
        AddChildNodesCommandBuilder } = require('/commands');
const { SelectiveColourAdjustmentRasterNodeDefinition,
        SelectiveColour } = require('/nodes');
const { NodeMoveType } = require('affinity:dom');
const { Selection } = require('/selections');

const doc = Document.current;
if (!doc) throw new Error('No document open — open an image and run again.');

// Idempotency: remove the layer a previous run created.
for (const l of doc.layers) {
  if ((l.userDescription ?? l.defaultDescription) === LAYER_NAME) {
    doc.executeCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, l), true));
    break;
  }
}

// Create the adjustment layer.
const builder = AddChildNodesCommandBuilder.create();
builder.addSelectiveColourAdjustmentRasterNode(
  SelectiveColourAdjustmentRasterNodeDefinition.createDefault());
const cmd = builder.createCommand();
const countBefore = doc.layers.toArray().length;
doc.executeCommand(cmd);
const layer = cmd.newNodes[0];

// If the top of the layer stack is a group, the builder parents the new layer
// INSIDE it — detect (root layer count unchanged) and move it out to the top.
const rootLayers = doc.layers.toArray();
if (rootLayers.length === countBefore) {
  doc.executeCommand(DocumentCommand.createMoveNodes(
    Selection.create(doc, layer),
    rootLayers[rootLayers.length - 1], NodeMoveType.After, NodeChildType.Main));
}
layer.userDescription = LAYER_NAME;

// Weights per colour range (Relative mode): negative removes an ink, positive
// adds it. Each range: + its primary inks, − its complement ink.
const s = STRENGTH;
const params = layer.parameters;
const w = params.weights;
w[SelectiveColour.Reds.value]     = { cyanWeight: -s, magentaWeight: +s, yellowWeight: +s, blackWeight: 0 };
w[SelectiveColour.Greens.value]   = { cyanWeight: +s, magentaWeight: -s, yellowWeight: +s, blackWeight: 0 };
w[SelectiveColour.Blues.value]    = { cyanWeight: +s, magentaWeight: +s, yellowWeight: -s, blackWeight: 0 };
w[SelectiveColour.Cyans.value]    = { cyanWeight: +s, magentaWeight: -s, yellowWeight: -s, blackWeight: 0 };
w[SelectiveColour.Magentas.value] = { cyanWeight: -s, magentaWeight: +s, yellowWeight: -s, blackWeight: 0 };
w[SelectiveColour.Yellows.value]  = { cyanWeight: -s, magentaWeight: -s, yellowWeight: +s, blackWeight: 0 };
params.weights = w;
params.isRelative = true;
doc.executeCommand(DocumentCommand.createSetSelectiveColourAdjustmentParameters(
  Selection.create(doc, layer), params));

// Layer opacity is the master "how much" control.
doc.selection = Selection.create(doc, layer);
doc.setOpacity(OPACITY);
doc.selection = null;

console.log('Color Boost added — strength ' + s + ', opacity ' + Math.round(OPACITY * 100) + '%');
