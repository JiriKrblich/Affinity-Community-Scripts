"use strict";

const { Document } = require("/document.js");
const { Dialog, DialogResult } = require("/dialog.js");
const { Selection } = require("/selections.js");
const { DocumentCommand } = require("/commands.js");
const { Transform } = require("/geometry.js");

const doc = Document.current;

function main() {
  if (!doc) {
    console.log("No document open");
    return;
  }

  const sel = doc.selection;
  let nodeData = [];

  // If single group selected, use its children instead
  if (sel.length === 1) {
    const node = sel.at(0).node;
    if (node.isGroupNode) {
      const children = node.children;
      for (let i = 0; i < children.length; i++) {
        const child = children.at(i);
        const bb = child.getSpreadBaseBox(false);
        nodeData.push({ node: child, bb });
      }
      console.log("Using " + nodeData.length + " children from group");
    }
  }

  // Otherwise use selected nodes directly
  if (nodeData.length === 0) {
    for (let i = 0; i < sel.length; i++) {
      const node = sel.at(i).node;
      if (!node) continue;
      const bb = node.getSpreadBaseBox(false);
      nodeData.push({ node, bb });
    }
  }

  if (nodeData.length < 2) {
    console.log("Select at least 2 layers or a group");
    return;
  }

  const dlg = Dialog.create("Scatter Layers");
  const col = dlg.addColumn();

  const scatterGrp = col.addGroup("Scatter Options");
  const radiusEditor = scatterGrp.addUnitValueEditor(
    "Radius (px)",
    "px",
    "px",
    300,
    10,
    5000,
  );
  radiusEditor.precision = 0;
  const seedEditor = scatterGrp.addUnitValueEditor(
    "Seed",
    "px",
    "px",
    42,
    0,
    9999,
  );
  seedEditor.precision = 0;

  if (dlg.runModal() != DialogResult.Ok.value) return;

  const radius = radiusEditor.value;
  let s = Math.round(seedEditor.value);
  function rand() {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const { bb } of nodeData) {
    minX = Math.min(minX, bb.x);
    minY = Math.min(minY, bb.y);
    maxX = Math.max(maxX, bb.x + bb.width);
    maxY = Math.max(maxY, bb.y + bb.height);
  }
  const centreX = (minX + maxX) / 2;
  const centreY = (minY + maxY) / 2;

  for (const { node, bb } of nodeData) {
    const angle = rand() * 2 * Math.PI;
    const r = Math.sqrt(rand()) * radius;
    const dx = centreX + Math.cos(angle) * r - (bb.x + bb.width / 2);
    const dy = centreY + Math.sin(angle) * r - (bb.y + bb.height / 2);
    const nodeSel = Selection.create(doc, node);
    doc.executeCommand(
      DocumentCommand.createTransform(
        nodeSel,
        Transform.createTranslate(dx, dy),
        {},
      ),
    );
  }
  console.log(
    "Scattered " + nodeData.length + " layers, radius=" + radius + "px",
  );
}

main();
