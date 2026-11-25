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
 * name: Photo Palette
 * description: Pulls the main colours out of a photo and adds them as swatches with hex codes along its bottom edge.
 * version: 1.0.0
 * author: Senyi Labs
 */
'use strict';
// Free script by Senyi Labs (https://senyilabs.com). More Affinity scripts: Match Color, Content-Aware Scale.

// Main colours of a photo, free of Affinity so the tests can run it. k-means in Oklab (a colour space where distances
// match what we see), started with k-means++ from a fixed seed so the same photo always gives the same palette.
// Pixels with alpha below 128 are ignored.

function toLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function toSrgb8(x) {
  const c = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

function rgbToOklab(r, g, b) {
  const R = toLinear(r), G = toLinear(g), B = toLinear(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToRgb(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    toSrgb8(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toSrgb8(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toSrgb8(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

const hex = ([r, g, b]) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();

// Small fixed-seed generator (mulberry32), so palettes don't change between runs.
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Groups the pixels into `k` clusters by k-means: [{ lab, share }], most common first.
function clusters({ width, height, data }, count, { samples = 40000, rounds = 15 } = {}) {
  const step = Math.max(1, Math.floor((width * height) / samples));
  const points = [];
  for (let p = 0; p < width * height; p += step) {
    const i = p * 4;
    if (data[i + 3] < 128) continue;
    points.push(rgbToOklab(data[i], data[i + 1], data[i + 2]));
  }
  if (!points.length) return [];

  const dist = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
  const rnd = random(1);
  const centres = [points[Math.floor(rnd() * points.length)]];
  const nearest = points.map((p) => dist(p, centres[0]));
  while (centres.length < count) {
    const total = nearest.reduce((s, d) => s + d, 0);
    if (total < 1e-9) break; // every pixel is already on a centre
    let pick = rnd() * total, i = 0;
    while (pick > nearest[i] && i < points.length - 1) pick -= nearest[i++];
    centres.push(points[i]);
    for (let j = 0; j < points.length; j++) nearest[j] = Math.min(nearest[j], dist(points[j], points[i]));
  }

  const owner = new Int32Array(points.length);
  for (let round = 0; round < rounds; round++) {
    const sum = centres.map(() => [0, 0, 0, 0]);
    for (let j = 0; j < points.length; j++) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < centres.length; c++) {
        const d = dist(points[j], centres[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      owner[j] = best;
      const s = sum[best];
      s[0] += points[j][0]; s[1] += points[j][1]; s[2] += points[j][2]; s[3]++;
    }
    for (let c = 0; c < centres.length; c++) if (sum[c][3]) centres[c] = [sum[c][0] / sum[c][3], sum[c][1] / sum[c][3], sum[c][2] / sum[c][3]];
  }

  const counts = new Array(centres.length).fill(0);
  for (const o of owner) counts[o]++;
  return centres
    .map((lab, i) => ({ lab, share: counts[i] / points.length }))
    .filter((c) => c.share > 0)
    .sort((x, y) => y.share - x.share);
}

// Up to `count` colours: [{ rgb: [r, g, b], hex, share, lightness }], most common first. `share` is the part of the
// visible pixels (0–1) nearest to that colour. Plain k-means with `count` clusters averages small vivid areas (a
// sunset, a red coat) into mud, so the photo is split into three times as many clusters first, and `count` of them
// are picked one by one: the most common, then each time the one that is both common and far from those picked.
// "Far" counts colour three times as much as lightness, or a photo's light and dark greys crowd out its accents.
// Fewer colours come back if the photo has fewer distinct ones.
function palette(image, count = 6, options) {
  const all = clusters(image, Math.max(count * 3, 12), options);
  if (!all.length) return [];
  const dist = (p, q) => Math.sqrt((p[0] - q[0]) ** 2 + 9 * ((p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2));
  const picked = [all[0]];
  while (picked.length < Math.min(count, all.length)) {
    let best = null, bestScore = 0;
    for (const c of all) {
      if (picked.includes(c)) continue;
      const score = Math.sqrt(c.share) * Math.min(...picked.map((p) => dist(p.lab, c.lab)));
      if (score > bestScore) { best = c; bestScore = score; }
    }
    if (!best || bestScore < 1e-4) break; // what's left is a copy of a picked colour
    picked.push(best);
  }
  // Every cluster's pixels count towards the picked colour nearest to it.
  const share = picked.map(() => 0);
  for (const c of all) {
    let near = 0;
    picked.forEach((p, i) => { if (dist(p.lab, c.lab) < dist(picked[near].lab, c.lab)) near = i; });
    share[near] += c.share;
  }
  return picked
    .map((c, i) => ({ rgb: oklabToRgb(...c.lab), share: share[i], lightness: c.lab[0] }))
    .sort((x, y) => y.share - x.share)
    .map(({ rgb, share, lightness }) => ({ rgb, hex: hex(rgb), share, lightness }));
}

// The Affinity side of Photo Palette. tools/build.mjs puts src/palette.js in front of this file, so palette() is in
// scope. Draws the main colours of the selected photo as a strip of swatches (with hex codes) along its bottom edge,
// in a group of its own that can be moved, resized or deleted.

const { Document } = require('/document.js');
const { Dialog, DialogResult } = require('/dialog.js');
const { AddChildNodesCommandBuilder } = require('/commands.js');
const { Rectangle } = require('/geometry.js');
const { ShapeNodeDefinition, ContainerNodeDefinition, ArtTextNodeDefinition } = require('/nodes.js');
const { ShapeRectangle } = require('/shapes.js');
const { StoryBuilder } = require('/storybuilder.js');
const { GlyphAtts } = require('/glyphatts.js');
const { FillDescriptor, SolidFill } = require('/fills.js');
const { Colour } = require('/colours.js');
const { Selection } = require('/selections.js');
const { UnitType } = require('/units.js');

const TITLE = 'Photo Palette';

function pixelsOf(node) {
  const ri = node && node.rasterInterface;
  if (!ri) return null;
  const buffer = ri.createCompatibleBuffer(true);
  if (String(buffer.format) !== 'RGBA8') return null;
  return { width: ri.width, height: ri.height, data: new Uint8Array(buffer.buffer) };
}

const solid = ([r, g, b]) => FillDescriptor.createSolid(SolidFill.create(Colour.createRGBA8({ r, g, b, alpha: 255 })));

function label(doc, text, x, y, size, dark) {
  const sb = StoryBuilder.create();
  sb.setToArtisticTextDefaultStyle(doc.dpi, doc.rasterFormat);
  const atts = GlyphAtts.create();
  atts.height = size;
  atts.brushFill = solid(dark ? [20, 20, 20] : [250, 250, 250]);
  sb.setGlyphAtts(atts);
  sb.addText(text);
  return ArtTextNodeDefinition.createFromStoryBuilder({ x, y }, sb);
}

// The swatches as one command: a "Palette" group, then a rectangle (and hex code) per colour inside it.
function paletteCommand(doc, box, colours, { height, byShare, codes }) {
  const strip = box.height * height;
  const top = box.y + box.height - strip;
  const total = colours.reduce((s, c) => s + (byShare ? c.share : 1), 0);
  const group = AddChildNodesCommandBuilder.create();
  group.addNode(ContainerNodeDefinition.create('Palette'));
  const add = group.createCommand(false);
  return { add, fill(container) {
    const b = AddChildNodesCommandBuilder.create();
    b.setInsertionTarget(container);
    let x = box.x;
    for (const c of colours) {
      const w = (box.width * (byShare ? c.share : 1)) / total;
      const def = ShapeNodeDefinition.createDefault();
      def.shape = ShapeRectangle.create();
      def.setBoundingRectangle(new Rectangle(x, top, w, strip));
      def.addBrushFillDescriptor(solid(c.rgb));
      b.addNode(def);
      const size = Math.min(strip * 0.16, w * 0.14);
      if (codes && size >= 4) b.addNode(label(doc, c.hex, x + size * 0.6, top + strip - size * 0.7, size, c.lightness > 0.62));
      x += w;
    }
    return b.createCommand(false);
  } };
}

function main() {
  const doc = Document.current;
  if (!doc) return alert('Open a photo first.');
  const target = [...doc.selection.nodes][0];
  const image = pixelsOf(target);
  if (!image) return alert('Select the photo\'s pixel layer (for example the Background layer of a JPEG), then run the script again.');
  const box = target.getSpreadBaseBox();

  const dlg = Dialog.create(TITLE);
  const col = dlg.addColumn();
  const g = col.addGroup('Palette');
  const count = g.addUnitValueEditor('Colours', UnitType.Number, UnitType.Number, 6, 2, 12).setPrecision(0);
  const height = g.addUnitValueEditor('Strip height', UnitType.Percentage, UnitType.Percentage, 18, 5, 100).setPrecision(0);
  const byShare = g.addSwitch('Width shows how much of the photo each colour covers', false);
  const codes = g.addSwitch('Show hex codes', true);
  col.addGroup('Tip').addStaticText('', 'The swatches go in a group named Palette, so you can move, resize or delete them.');
  if (dlg.runModal() !== DialogResult.Ok) return;

  const started = Date.now();
  // Percentages come back whole (18 = 18%) in Affinity 3.3; a fraction would mean an older build.
  const h = height.value > 1 ? height.value / 100 : height.value;
  const colours = palette(image, Math.round(count.value));
  if (!colours.length) return alert('The layer has no visible pixels.');
  const cmd = paletteCommand(doc, box, colours, { height: h, byShare: byShare.value, codes: codes.value });
  doc.executeCommand(cmd.add);
  const container = cmd.add.newNodes[0];
  doc.executeCommand(cmd.fill(container));
  doc.selection = Selection.create(doc, container);
  console.log(`${TITLE}: ${colours.map((c) => c.hex).join(' ')} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

main();
