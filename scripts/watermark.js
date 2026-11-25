/*
MIT License

Copyright (c) 2026 Senyi Labs

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

/**
 * name: Watermark
 * description: Adds a text watermark (corner, centre or repeated across the photo) to this document or every open one.
 * version: 1.0.0
 * author: Senyi Labs
 */
'use strict';
// Free script by Senyi Labs (https://senyilabs.com). More Affinity scripts: Match Color, Content-Aware Scale.

// Where watermark text goes, free of Affinity so the tests can run it. Sizes are in document pixels; `anchor` is
// Affinity's SpatialAnchor number (1 top left, 2 centre left, 3 bottom left, 4 top centre … 9 bottom right).

// Top-left corner for a text box of size `text` at `anchor` on a `page`, `margin` pixels in from the edges.
function place(page, text, anchor, margin) {
  const col = Math.floor((anchor - 1) / 3), row = (anchor - 1) % 3;
  const x = [margin, (page.width - text.width) / 2, page.width - text.width - margin][col];
  const y = [margin, (page.height - text.height) / 2, page.height - text.height - margin][row];
  return { x, y };
}

// Centres for repeating the text across the whole page, in staggered rows (like a stock photo watermark), `gap`
// times the text size apart. Covers the corners too, since the copies are drawn at an angle.
function tiles(page, text, gap = 1.5) {
  const stepX = text.width * gap, stepY = text.height * gap * 3;
  const out = [];
  for (let row = 0, y = stepY / 2; y < page.height + stepY; row++, y += stepY) {
    for (let x = (row % 2 ? stepX / 2 : 0); x < page.width + stepX; x += stepX) out.push({ x, y });
  }
  return out;
}

// The Affinity side of Watermark. tools/build.mjs puts src/watermark.js in front of this file, so place() and tiles()
// are in scope. Adds the text, in a group named Watermark at the top of the layers, to this document or to every open
// one; the group can be moved, edited or deleted like any other.

const { Document, SpatialAnchor } = require('/document.js');
const { Dialog, DialogResult } = require('/dialog.js');
const { AddChildNodesCommandBuilder, CompoundCommandBuilder, DocumentCommand } = require('/commands.js');
const { Transform } = require('/geometry.js');
const { ContainerNodeDefinition, ArtTextNodeDefinition } = require('/nodes.js');
const { StoryBuilder } = require('/storybuilder.js');
const { GlyphAtts } = require('/glyphatts.js');
const { FillDescriptor, SolidFill } = require('/fills.js');
const { Colour } = require('/colours.js');
const { Selection } = require('/selections.js');
const { UnitType } = require('/units.js');

const TITLE = 'Watermark';
const pct = (v) => (v > 1 ? v / 100 : v); // whole percentages in Affinity 3.3; a fraction would mean an older build

function textDefinition(doc, text, size, colour, font) {
  const sb = StoryBuilder.create();
  sb.setToArtisticTextDefaultStyle(doc.dpi, doc.rasterFormat);
  const atts = GlyphAtts.create();
  atts.height = size;
  atts.brushFill = FillDescriptor.createSolid(SolidFill.create(colour));
  if (font) atts.font = font;
  sb.setGlyphAtts(atts);
  sb.addText(text);
  return ArtTextNodeDefinition.createFromStoryBuilder({ x: 0, y: 0 }, sb);
}

function watermark(doc, o) {
  const page = { width: doc.widthPixels, height: doc.heightPixels };
  const size = page.width * o.size;

  const add = AddChildNodesCommandBuilder.create();
  add.addNode(ContainerNodeDefinition.create(TITLE));
  const made = add.createCommand(false);
  doc.executeCommand(made);
  const group = made.newNodes[0];

  const inner = AddChildNodesCommandBuilder.create();
  inner.setInsertionTarget(group);
  inner.addNode(textDefinition(doc, o.text, size, o.colour, o.font));
  const typed = inner.createCommand(false);
  doc.executeCommand(typed);
  const node = typed.newNodes[0];
  const box = node.getSpreadBaseBox();

  if (!o.repeat) {
    const at = place(page, box, o.anchor, size * 0.8);
    doc.executeCommand(DocumentCommand.createTransform(Selection.create(doc, node), Transform.createTranslate(at.x - box.x, at.y - box.y)));
  } else {
    // Copies at an angle across the page; the first one is moved to the first spot instead of copied.
    const centre = Transform.createTranslate(-(box.x + box.width / 2), -(box.y + box.height / 2));
    const spots = tiles(page, box);
    const all = CompoundCommandBuilder.create();
    spots.forEach((c, i) => {
      const xf = Transform.createTranslate(c.x, c.y).multiply(Transform.createRotate(-Math.PI / 6)).multiply(centre);
      all.addCommand(DocumentCommand.createTransform(Selection.create(doc, node), xf, { duplicateNodes: i < spots.length - 1 }));
    });
    doc.executeCommand(all.createCommand());
  }
  doc.executeCommand(DocumentCommand.createSetOpacity(Selection.create(doc, group), o.opacity));
  return group;
}

function main() {
  const current = Document.current;
  if (!current) return alert('Open a photo first.');
  const others = [...Document.all].length - 1;

  const dlg = Dialog.create(TITLE);
  const col = dlg.addColumn();
  const g = col.addGroup('Text');
  const text = g.addTextBox('Text', '© Your Name');
  const font = g.addFontPicker('Font');
  const colour = g.addColourPicker('Colour', Colour.createRGBA8({ r: 255, g: 255, b: 255, alpha: 255 }));
  const size = g.addUnitValueEditor('Size (of the photo width)', UnitType.Percentage, UnitType.Percentage, 4, 1, 30).setPrecision(1);
  const opacity = g.addUnitValueEditor('Opacity', UnitType.Percentage, UnitType.Percentage, 60, 5, 100).setPrecision(0);
  const p = col.addGroup('Placement');
  const anchor = p.addSpatialAnchor('Position', SpatialAnchor.BottomRight);
  const repeat = p.addSwitch('Repeat across the whole photo', false);
  const scope = p.addComboBox('Add to', ['This document', `All open documents (${others + 1})`], 0);
  if (dlg.runModal() !== DialogResult.Ok) return;

  const words = String(text.text ?? '').trim();
  if (!words) return alert('Type the watermark text.');
  const options = {
    text: words, font: font.font, colour: colour.value, size: pct(size.value), opacity: pct(opacity.value),
    anchor: anchor.value?.value ?? anchor.value, repeat: repeat.value,
  };
  const docs = scope.selectedIndex === 1 ? [...Document.all] : [current];
  for (const doc of docs) watermark(doc, options);
  console.log(`${TITLE}: added to ${docs.length} document${docs.length === 1 ? '' : 's'}`);
}

main();
