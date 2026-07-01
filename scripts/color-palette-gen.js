/**
 * name: Color Palette Generator
 * description: Extracts all fill, stroke, and gradient colors from selected nodes or entire spread. Displays swatches with RGB, CMYK, HSL, and HEX values, plus gradient stops. Groups outputs by fills, strokes, and gradients.
 * version: 9.1.1
 * author: nodeus
 */

"use strict";

const { Document } = require('/document');
const { DocumentCommand, AddChildNodesCommandBuilder, NodeChildType, NodeMoveType } = require('/commands');
const { ShapeNodeDefinition, FrameTextNodeDefinition, ContainerNodeDefinition } = require('/nodes');
const { Shape, ShapeType } = require('/shapes');
const { Rectangle, Transform } = require('/geometry');
const { Colour, ColourProfileSet } = require('/colours');
const { FillDescriptor, SolidFill, FillType, GradientFill, GradientFillType } = require('/fills');
const { StoryBuilder } = require('/storybuilder');
const { GlyphAtts } = require('/glyphatts');
const { Selection } = require('/selections');
const { BlendMode } = require('affinity:common');

const SWATCH = 40, GAP = 4, MARGIN = 50, LABEL_W = 160, LABEL_H = 80, HEADER_H = 24, SECTION_GAP = 40;
const CELL_W = Math.max(SWATCH, LABEL_W), CELL_H = SWATCH + GAP + LABEL_H;
const GRAD_SWATCH_W = 120, GRAD_SWATCH_H = 40, GRAD_LABEL_W = 200, GRAD_LABEL_H = 80;
const GRAD_CELL_W = Math.max(GRAD_SWATCH_W, GRAD_LABEL_W), GRAD_CELL_H = GRAD_SWATCH_H + GAP + GRAD_LABEL_H;

function hex2(n) { const h = (n & 0xFF).toString(16); return h.length === 1 ? "0" + h : h; }
function toHex(r, g, b) { return "#" + hex2(r) + hex2(g) + hex2(b); }
function rgbKey(r, g, b) { return r + "," + g + "," + b; }

function toCMYKString(colour) {
  try { const cps = ColourProfileSet.default; const k = colour.getCMYKA8(false, cps); return "C:" + Math.round(k.c * 100 / 255) + " M:" + Math.round(k.m * 100 / 255) + " Y:" + Math.round(k.y * 100 / 255) + " K:" + Math.round(k.k * 100 / 255); }
  catch (e) { return "C:? M:? Y:? K:?"; }
}
function toHSLString(colour) {
  try { const h = colour.hslaf; return "H:" + Math.round(h.h * 360) + "\u00B0 S:" + Math.round(h.s * 100) + "% L:" + Math.round(h.l * 100) + "%"; }
  catch (e) { return "H:? S:? L:?"; }
}
function toRGBString(r, g, b) { return "R:" + r + " G:" + g + " B:" + b; }

function gradientTypeName(gft) {
  const v = typeof gft === 'number' ? gft : (gft && gft.value !== undefined ? gft.value : -1);
  const types = { 0: "Linear", 1: "Elliptical", 2: "Radial", 3: "Conical" };
  return types[v] || "Unknown (" + v + ")";
}

function gradientKey(gradient, gft) {
  let k = gradientTypeName(gft) + "|";
  for (let i = 0; i < gradient.stopCount; i++) {
    const stop = gradient.getStop(i);
    const c = new Colour(stop.colour).rgba8;
    k += toHex(c.r, c.g, c.b) + "@" + stop.position.toFixed(2) + ",";
  }
  return k;
}

function makeGradientSwatchDesc(fillDesc, x, y, w, h, gft) {
  const t = new Transform();
  t.setIdentity();
  t.scale(w, h);
  const v = typeof gft === 'number' ? gft : (gft && gft.value !== undefined ? gft.value : 0);
  if (v === 0) {
    t.translate(x, y);
  } else {
    t.translate(x + w / 2, y + h / 2);
  }
  return fillDesc.cloneWithNewTransform(t);
}

function collectFromNode(node, fills, strokes, gradients) {
  try {
    if (node.hasBrushFill) {
      const d = node.brushFillDescriptor;
      if (d && d.fill) {
        if (d.fill.fillType.value === FillType.Solid.value) {
          const c = d.fill.colour.rgba8;
          const k = rgbKey(c.r, c.g, c.b);
          if (!fills[k]) fills[k] = { r: c.r, g: c.g, b: c.b, colour: d.fill.colour.clone(), hasAlpha: c.alpha < 255 };
          else if (c.alpha < 255) fills[k].hasAlpha = true;
        } else if (d.fill.fillType.value === FillType.Gradient.value) {
          const gf = d.fill;
          const gKey = "fill|" + gradientKey(gf.gradient, gf.gradientFillType);
          if (!gradients[gKey]) {
            gradients[gKey] = { gradient: gf.gradient, gradientFillType: gf.gradientFillType, fillDescriptor: d };
          }
        }
      }
    }
  } catch (_) {}
  try {
    if (node.hasPenFill) {
      const d = node.penFillDescriptor;
      if (d && d.fill) {
        if (d.fill.fillType.value === FillType.Solid.value) {
          const c = d.fill.colour.rgba8;
          const k = rgbKey(c.r, c.g, c.b);
          let strokeWeight = null;
          try { strokeWeight = node.lineWeightPts; } catch (_) {}
          if (!strokes[k]) strokes[k] = { r: c.r, g: c.g, b: c.b, colour: d.fill.colour.clone(), hasAlpha: c.alpha < 255, strokeWeight };
          else { if (c.alpha < 255) strokes[k].hasAlpha = true; }
        } else if (d.fill.fillType.value === FillType.Gradient.value) {
          const gf = d.fill;
          const gKey = "stroke|" + gradientKey(gf.gradient, gf.gradientFillType);
          if (!gradients[gKey]) {
            gradients[gKey] = { gradient: gf.gradient, gradientFillType: gf.gradientFillType, fillDescriptor: d, isStroke: true };
          }
        }
      }
    }
  } catch (_) {}
  try { if (node.children) { for (const ch of node.children) collectFromNode(ch, fills, strokes, gradients); } } catch (_) {}
}

function collectColors(nodes) {
  const fills = {}, strokes = {}, gradients = {};
  for (const n of nodes) collectFromNode(n, fills, strokes, gradients);
  return { fills, strokes, gradients };
}

function makeLabelStory(lines) {
  const sb = StoryBuilder.create();
  const ga = GlyphAtts.create();
  ga.height = 10 * (72 / 72);
  ga.brushFill = FillDescriptor.createSolid(SolidFill.create(Colour.createRGBA8({ r: 0x80, g: 0x80, b: 0x80, alpha: 255 })), BlendMode.Normal);
  sb.setGlyphAtts(ga);
  for (let j = 0; j < lines.length; j++) { if (j > 0) sb.addParagraphBreak(); sb.addText(lines[j]); }
  return sb;
}

function makeHeaderStory(text) {
  const sb = StoryBuilder.create();
  const ga = GlyphAtts.create();
  ga.height = 12 * (72 / 72);
  ga.brushFill = FillDescriptor.createSolid(SolidFill.create(Colour.createRGBA8({ r: 0x40, g: 0x40, b: 0x40, alpha: 255 })), BlendMode.Normal);
  sb.setGlyphAtts(ga);
  sb.addText(text);
  return sb;
}

function addItem(doc, item) {
  const builder = AddChildNodesCommandBuilder.create();
  if (item.type === 'swatch') {
    const s = Shape.create(ShapeType.Rectangle);
    const f = FillDescriptor.createSolid(SolidFill.create(Colour.createRGBA8({ r: item.r, g: item.g, b: item.b, alpha: 255 })), BlendMode.Normal);
    builder.addNode(ShapeNodeDefinition.create(s, new Rectangle(item.x, item.y, SWATCH, SWATCH), f, null, null, null));
  } else if (item.type === 'label') {
    let l1 = toRGBString(item.r, item.g, item.b); if (item.hasAlpha) l1 += " (\u03B1:transp)";
    builder.addNode(FrameTextNodeDefinition.createFromStoryBuilder(new Rectangle(item.x, item.y, LABEL_W, LABEL_H), makeLabelStory([l1, toCMYKString(item.colour), toHSLString(item.colour), toHex(item.r, item.g, item.b)])));
  } else if (item.type === 'stroke-label') {
    let l1 = toRGBString(item.r, item.g, item.b); if (item.hasAlpha) l1 += " (\u03B1:transp)";
    const wLine = item.strokeWeight != null ? "Width: " + item.strokeWeight.toFixed(1) + "pt" : "Width: N/A";
    builder.addNode(FrameTextNodeDefinition.createFromStoryBuilder(new Rectangle(item.x, item.y, LABEL_W, LABEL_H), makeLabelStory([l1, toCMYKString(item.colour), toHSLString(item.colour), toHex(item.r, item.g, item.b), wLine])));
  } else if (item.type === 'header') {
    builder.addNode(FrameTextNodeDefinition.createFromStoryBuilder(new Rectangle(item.x, item.y, 200, HEADER_H), makeHeaderStory(item.text)));
  } else if (item.type === 'gradient-swatch') {
    const desc = makeGradientSwatchDesc(item.fillDescriptor, item.x, item.y, GRAD_SWATCH_W, GRAD_SWATCH_H, item.gradientFillType);
    const s = Shape.create(ShapeType.Rectangle);
    builder.addNode(ShapeNodeDefinition.create(s, new Rectangle(item.x, item.y, GRAD_SWATCH_W, GRAD_SWATCH_H), desc, null, null, null));
  } else if (item.type === 'gradient-label') {
    const prefix = item.isStroke ? "Stroke \u00B7 " : "";
    const lines = [prefix + item.typeName + " \u00B7 " + item.stopCount + " stops"];
    for (const st of item.stops) { const c = new Colour(st.colour).rgba8; lines.push(st.position.toFixed(2) + " \u2192 " + toHex(c.r, c.g, c.b)); }
    builder.addNode(FrameTextNodeDefinition.createFromStoryBuilder(new Rectangle(item.x, item.y, GRAD_LABEL_W, GRAD_LABEL_H), makeLabelStory(lines)));
  }
  const cmd = builder.createCommand(true, NodeChildType.Main);
  doc.executeCommand(cmd);
  return [...cmd.newNodes][0];
}

function groupSection(doc, nodes, name) {
  if (nodes.length === 0) return;
  const groupDef = ContainerNodeDefinition.create(name);
  const gBuilder = AddChildNodesCommandBuilder.create();
  gBuilder.addNode(groupDef);
  gBuilder.setInsertionTargetSelection(doc.selection);
  const gCmd = gBuilder.createCommand(true, NodeChildType.Main);
  doc.executeCommand(gCmd);
  const groupNode = [...gCmd.newNodes][0];
  const sel = Selection.create(doc, nodes[0]);
  for (let i = 1; i < nodes.length; i++) sel.add(nodes[i]);
  doc.executeCommand(DocumentCommand.createMoveNodes(sel, groupNode, NodeMoveType.Inside));
}

const doc = Document.current;
if (!doc) { console.log("No document open"); return; }
const spread = doc.currentSpread;
const nodes = spread.children;
if (!nodes) { console.log("No objects on spread"); return; }
let nc = 0; for (const n of nodes) nc++;
if (nc === 0) { console.log("No objects on spread"); return; }

const { fills, strokes, gradients } = collectColors(nodes);
const fillList = Object.values(fills), strokeList = Object.values(strokes), gradientList = Object.values(gradients);
console.log("Fills: " + fillList.length + " Strokes: " + strokeList.length + " Gradients: " + gradientList.length);
if (fillList.length === 0 && strokeList.length === 0 && gradientList.length === 0) { console.log("No colors found"); return; }

const ext = spread.getSpreadExtents();
const palX = ext.x + ext.width + MARGIN;
let palY = ext.y;

const sFills = [], sStrokes = [], sGradients = [];

if (fillList.length > 0) {
  sFills.push(addItem(doc, { type: 'header', x: palX, y: palY, text: "FILLS (" + fillList.length + ")" }));
  palY += HEADER_H;
  const cols = Math.ceil(Math.sqrt(fillList.length));
  for (let i = 0; i < fillList.length; i++) {
    const c = fillList[i], col = i % cols, row = Math.floor(i / cols);
    const cx = palX + col * (CELL_W + GAP), cy = palY + row * (CELL_H + GAP);
    sFills.push(addItem(doc, { type: 'swatch', x: cx, y: cy, r: c.r, g: c.g, b: c.b }));
    sFills.push(addItem(doc, { type: 'label', x: cx, y: cy + SWATCH + GAP, r: c.r, g: c.g, b: c.b, colour: c.colour, hasAlpha: c.hasAlpha }));
  }
  palY += Math.ceil(fillList.length / cols) * (CELL_H + GAP) + SECTION_GAP;
}

if (strokeList.length > 0) {
  sStrokes.push(addItem(doc, { type: 'header', x: palX, y: palY, text: "STROKES (" + strokeList.length + ")" }));
  palY += HEADER_H;
  const cols = Math.ceil(Math.sqrt(strokeList.length));
  for (let i = 0; i < strokeList.length; i++) {
    const c = strokeList[i], col = i % cols, row = Math.floor(i / cols);
    const cx = palX + col * (CELL_W + GAP), cy = palY + row * (CELL_H + GAP);
    sStrokes.push(addItem(doc, { type: 'swatch', x: cx, y: cy, r: c.r, g: c.g, b: c.b }));
    sStrokes.push(addItem(doc, { type: 'stroke-label', x: cx, y: cy + SWATCH + GAP, r: c.r, g: c.g, b: c.b, colour: c.colour, hasAlpha: c.hasAlpha, strokeWeight: c.strokeWeight }));
  }
  palY += Math.ceil(strokeList.length / cols) * (CELL_H + GAP) + SECTION_GAP;
}

if (gradientList.length > 0) {
  sGradients.push(addItem(doc, { type: 'header', x: palX, y: palY, text: "GRADIENTS (" + gradientList.length + ")" }));
  palY += HEADER_H;
  const cols = Math.ceil(Math.sqrt(gradientList.length));
  for (let i = 0; i < gradientList.length; i++) {
    const g = gradientList[i], col = i % cols, row = Math.floor(i / cols);
    const cx = palX + col * (GRAD_CELL_W + GAP), cy = palY + row * (GRAD_CELL_H + GAP);
    sGradients.push(addItem(doc, { type: 'gradient-swatch', x: cx, y: cy, fillDescriptor: g.fillDescriptor, gradient: g.gradient, gradientFillType: g.gradientFillType }));
    sGradients.push(addItem(doc, { type: 'gradient-label', x: cx, y: cy + GRAD_SWATCH_H + GAP, typeName: gradientTypeName(g.gradientFillType), stopCount: g.gradient.stopCount, stops: g.gradient.stops, isStroke: g.isStroke }));
  }
}

groupSection(doc, sFills, "FILLS");
groupSection(doc, sStrokes, "STROKES");
groupSection(doc, sGradients, "GRADIENTS");

console.log("Palette: " + (sFills.length + sStrokes.length + sGradients.length) + " items in 3 groups at x=" + palX);
