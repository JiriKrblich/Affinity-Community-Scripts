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
 * name: Contact Sheet
 * description: Puts every photo in a folder on a new A4 page in a grid, with file names: for proofs, picks and printing.
 * version: 1.0.0
 * author: Senyi Labs
 */
'use strict';
// Free script by Senyi Labs (https://senyilabs.com). More Affinity scripts: Match Color, Content-Aware Scale.

// Contact sheet layout and image shrinking, free of Affinity so the tests can run it. Sizes are in document pixels.

const IMAGE = /\.(jpe?g|png|tiff?|webp|heic|gif|bmp)$/i;

// Compares names the way a file browser orders them: numbers by value (IMG_2 before IMG_10), letters ignoring case.
// Written out because Affinity's JavaScript has no Intl, so localeCompare can't take options there.
function natural(a, b) {
  const pa = a.toLowerCase().match(/\d+|\D+/g) || [], pb = b.toLowerCase().match(/\d+|\D+/g) || [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i];
    if (x === y) continue;
    const nx = /^\d/.test(x), ny = /^\d/.test(y);
    if (nx && ny) return Number(x) - Number(y) || x.length - y.length;
    return x < y ? -1 : 1;
  }
  return pa.length - pb.length;
}

// The image files among `paths`, in the order a file browser shows them.
function imageFiles(paths) {
  const name = (p) => String(p).split(/[\\/]/).pop();
  return paths.filter((p) => IMAGE.test(p) && !name(p).startsWith('.')).sort((a, b) => natural(name(a), name(b)));
}

// `count` cells in `cols` columns filling `page` inside `margin`, with `gap` between cells and `caption` pixels under
// each picture for its file name. Cells are square-ish boxes for the picture: { x, y, width, height }.
function cells(count, page, { cols = 4, margin = 0, gap = 0, caption = 0 } = {}) {
  const rows = Math.max(1, Math.ceil(count / cols));
  const width = (page.width - 2 * margin - gap * (cols - 1)) / cols;
  const height = Math.min(width, (page.height - 2 * margin - gap * (rows - 1)) / rows - caption);
  const out = [];
  for (let i = 0; i < count; i++) {
    const r = Math.floor(i / cols), c = i % cols;
    out.push({ x: margin + c * (width + gap), y: margin + r * (height + caption + gap), width, height });
  }
  return out;
}

// The largest rectangle with the picture's shape that fits `cell`, centred across it and sitting on its bottom edge,
// so the file name underneath stays next to the picture.
function fit(w, h, cell) {
  const s = Math.min(cell.width / w, cell.height / h);
  return { x: cell.x + (cell.width - w * s) / 2, y: cell.y + cell.height - h * s, width: w * s, height: h * s };
}

// A smaller copy of an RGBA8 image whose long side is at most `maxSide`, by averaging blocks of pixels (box filter),
// so a sheet of 24-megapixel photos stays light. Images already small enough come back as they are.
function shrink(image, maxSide) {
  const { width, height, data } = image;
  const f = Math.ceil(Math.max(width, height) / maxSide);
  if (f <= 1) return image;
  const w = Math.floor(width / f), h = Math.floor(height / f);
  const out = new Uint8Array(w * h * 4);
  const n = f * f;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < f; dy++) {
        let i = ((y * f + dy) * width + x * f) * 4;
        for (let dx = 0; dx < f; dx++, i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; a += data[i + 3]; }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return { width: w, height: h, data: out };
}

// The Affinity side of Contact Sheet. tools/build.mjs puts src/contactsheet.js in front of this file, so
// imageFiles(), cells(), fit() and shrink() are in scope. You pick any photo in a folder; a new A4 document gets every
// photo in that folder in a grid, each with its file name underneath.

const { app } = require('/application.js');
const { Document, NewDocumentOptions } = require('/document.js');
const { Dialog, DialogResult } = require('/dialog.js');
const { AddChildNodesCommandBuilder, DocumentCommand } = require('/commands.js');
const { Transform } = require('/geometry.js');
const { ImageNodeDefinition, ArtTextNodeDefinition } = require('/nodes.js');
const { Bitmap, PixelBuffer, RasterFormat } = require('/rasterobject.js');
const { StoryBuilder } = require('/storybuilder.js');
const { GlyphAtts } = require('/glyphatts.js');
const { DirectoryIterator } = require('/fs.js');
const { Selection } = require('/selections.js');
const { UnitType } = require('/units.js');

const TITLE = 'Contact Sheet';
const MAX = 120; // more than this on one A4 page and the pictures are too small to see

const folderOf = (path) => String(path).replace(/[\\/][^\\/]*$/, '');
const fileName = (path) => String(path).split(/[\\/]/).pop();

function listFolder(folder) {
  const paths = [];
  for (const it = DirectoryIterator.at(folder); !it.done; it.next()) paths.push(it.path);
  return imageFiles(paths);
}

// The picture at `path`, shrunk to `maxSide` pixels, as an image node definition; null if it can't be read.
function picture(path, maxSide) {
  let bitmap;
  try {
    bitmap = Bitmap.loadFromFile(path, RasterFormat.RGBA8);
  } catch (e) {
    return null;
  }
  const full = PixelBuffer.create(bitmap.width, bitmap.height, RasterFormat.RGBA8);
  bitmap.copyTo(full, { x: 0, y: 0, width: bitmap.width, height: bitmap.height }, 0, 0);
  const small = shrink({ width: bitmap.width, height: bitmap.height, data: new Uint8Array(full.buffer) }, maxSide);
  const buffer = PixelBuffer.create(small.width, small.height, RasterFormat.RGBA8);
  new Uint8Array(buffer.buffer).set(small.data);
  const def = ImageNodeDefinition.create(RasterFormat.RGBA8);
  def.setBitmap(buffer.createCompatibleBitmap(true));
  return { def, width: small.width, height: small.height };
}

function caption(doc, text, size) {
  const sb = StoryBuilder.create();
  sb.setToArtisticTextDefaultStyle(doc.dpi, doc.rasterFormat);
  const atts = GlyphAtts.create();
  atts.height = size;
  sb.setGlyphAtts(atts);
  sb.addText(text);
  return ArtTextNodeDefinition.createFromStoryBuilder({ x: 0, y: 0 }, sb);
}

// Adds `def` and moves/scales it so its box becomes `rect` (keeping its shape when `rect` has the same shape).
function addInto(doc, def, rect, scale = true) {
  const b = AddChildNodesCommandBuilder.create();
  b.addNode(def);
  const cmd = b.createCommand(false);
  doc.executeCommand(cmd);
  const node = cmd.newNodes[0];
  const box = node.getSpreadBaseBox();
  const s = scale ? Math.min(rect.width / box.width, rect.height / box.height) : 1;
  const xf = Transform.createTranslate(rect.x, rect.y).multiply(Transform.createScale(s, s)).multiply(Transform.createTranslate(-box.x, -box.y));
  doc.executeCommand(DocumentCommand.createTransform(Selection.create(doc, node), xf));
  return node;
}

function main() {
  const dlg = Dialog.create(TITLE);
  const col = dlg.addColumn();
  const g = col.addGroup('Sheet');
  const cols = g.addUnitValueEditor('Columns', UnitType.Number, UnitType.Number, 4, 1, 12).setPrecision(0);
  const names = g.addSwitch('File names under the pictures', true);
  col.addGroup('Next').addStaticText('', 'Then pick any photo in the folder: every photo in that folder goes on the sheet.');
  if (dlg.runModal() !== DialogResult.Ok) return;
  const chosen = app.chooseFile();
  if (!chosen) return;

  const started = Date.now();
  const folder = folderOf(chosen);
  let files = listFolder(folder);
  if (!files.length) return alert(`No photos found in ${folder}.`);
  const skipped = Math.max(0, files.length - MAX);
  files = files.slice(0, MAX);

  const doc = Document.createFromOptions(NewDocumentOptions.createDefault());
  const page = { width: doc.widthPixels, height: doc.heightPixels };
  const margin = page.width * 0.05, gap = page.width * 0.02;
  const columns = Math.round(cols.value);
  const textSize = Math.max(8, page.width / columns / 18);
  const boxes = cells(files.length, page, { cols: columns, margin, gap, caption: names.value ? textSize * 1.8 : 0 });

  let unreadable = 0;
  files.forEach((path, i) => {
    const cell = boxes[i];
    const pic = picture(path, Math.ceil(Math.max(cell.width, cell.height) * 1.5));
    if (!pic) { unreadable++; return; }
    addInto(doc, pic.def, fit(pic.width, pic.height, cell));
    if (names.value) {
      const label = addInto(doc, caption(doc, fileName(path), textSize), { x: cell.x, y: cell.y + cell.height + textSize * 0.4, width: cell.width, height: textSize * 1.4 }, false);
      const box = label.getSpreadBaseBox();
      if (box.width > cell.width) { // a long name: shrink it to the cell's width
        const s = cell.width / box.width;
        doc.executeCommand(DocumentCommand.createTransform(Selection.create(doc, label),
          Transform.createTranslate(box.x, box.y).multiply(Transform.createScale(s, s)).multiply(Transform.createTranslate(-box.x, -box.y))));
      }
    }
  });
  const notes = [skipped && `${skipped} more photos didn't fit (the limit is ${MAX})`, unreadable && `${unreadable} files couldn't be opened`].filter(Boolean);
  if (notes.length) alert(notes.join('; ') + '.');
  console.log(`${TITLE}: ${files.length - unreadable} photos from ${folder} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

main();
