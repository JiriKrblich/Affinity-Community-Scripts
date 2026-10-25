/**
 * name: Convert to Gradient v9 (EN)
 * description: Converts the solid fill (and optionally solid stroke) of the selected
 * objects, including all child objects of selected groups, into a gradient (linear,
 * radial or elliptical). Supports text objects (artistic and frame text) with solid
 * fill/stroke: for text the bounding box is the measure (not curve nodes) - longest
 * axis = horizontal text direction, shortest axis = vertical text height. Text
 * geometry is computed in LOCAL (unrotated) coordinates and only then mapped to the
 * spread via the actual object transform. For a linear gradient with reference point
 * "Object centre" or "Focal point" the axis is mirrored at the reference point (middle
 * stop = base colour on the reference point). ANGLE JITTER for "Manual angle" (± amount,
 * optionally stepped via the jitter step, seedable). "Text processing": whole text or
 * individual characters. 2, 3 or 5 stops; the middle stop always carries exactly the
 * base colour. Start/end: lightness spread by a factor towards black/white, optionally
 * saturation towards 0/100 %, optionally opacity thinned. Optional random factor
 * variation per object. Presets in the AffinityScriptPresets folder (prefix identical
 * to the German version). Preview on click, text and vector changes in ONE undo step,
 * native OK recalculates with the final parameters, Cancel/ESC discards.
 *
 * NEW in v9: SEPARATE REVERSAL. Instead of a single "Reverse" option there are now
 * "Reverse colour (lightness)" and "Reverse saturation". The lightness spread
 * (dark → light) and the saturation spread (desaturated → saturated) can be reversed
 * independently, e.g. dark+saturated at the start and light+desaturated at the end.
 * The hue is the same across the whole gradient and the opacity thinning is the same
 * at both ends - neither needs a reversal. Older presets with the "reversed" field
 * still load (sets both options).
 * v8: robust rollback (falls back to step-by-step history.undo() at position 0),
 * File.create() for presets, null check for the dialog result.
 * version: 9.0.0
 * author: Claude
 */
"use strict";

const { Document } = require("/document.js");
const { Colour, Gradient } = require("/colours.js");
const { GradientFill, FillDescriptor, GradientFillType, FillType } = require("/fills.js");
const { Transform } = require("/geometry.js");
const { DocumentCommand, CompoundCommandBuilder } = require("/commands.js");
const { Selection, TextSelection } = require("/selections.js");
const { Story } = require("/story.js");
const { StoryDelta } = require("/storydelta.js");
const { Dialog, DialogResult } = require("/dialog.js");
const { UnitType } = require("/units.js");
const { app } = require("/application.js");
const { File, FileSystemApi } = require("/fs.js");

// ─── Initial checks ────────────────────────────────────────────────────
const doc = Document.current;
if (!doc) {
  console.log("ERROR: No document open.");
  app.alert("Please open a document first.", "Convert to Gradient");
  return;
}

const initialItems = [...doc.selection.nodes];
if (initialItems.length === 0) {
  console.log("ERROR: Please select at least one object first.");
  app.alert("Please select at least one object first.", "Convert to Gradient");
  return;
}
const initialSelection = Selection.create(doc, initialItems);

// ─── Robust history rollback (v8) ───────────────────────────────────────
function rollbackToPosition(pos) {
  try {
    if (doc.history.position !== pos) doc.history.position = pos;
  } catch (e) {
    console.log("History jump failed (" + e.message + ") - falling back to step-by-step undo.");
  }
  let guard = 0;
  while (doc.history.position > pos && doc.history.canUndo && guard < 10000) {
    try { doc.history.undo(); } catch (e) { console.log("Undo error: " + e.message); break; }
    guard++;
  }
  if (doc.history.position !== pos) {
    console.log("Warning: history rollback incomplete (position " + doc.history.position + " instead of " + pos + ").");
  }
}

// ─── Text node detection ─────────────────────────────────────────────────
function isTextNode(node) {
  const tag = node[Symbol.toStringTag] || "";
  return tag === "ArtTextNode" || tag === "FrameTextNode";
}

function getMarkingCharIndexes(story) {
  const idxs = [];
  for (let i = 0; i < story.length; i++) {
    try {
      if (story.getGlyph(i).isMarking) idxs.push(i);
    } catch (e) {
      idxs.push(i);
    }
  }
  return idxs;
}

// ─── Collect leaf objects ────────────────────────────────────────────────
const leaves = [];
function collectLeaves(node, out) {
  if (node.children && node.children.length > 0) {
    for (const ch of node.children) collectLeaves(ch, out);
  } else {
    out.push(node);
  }
}
for (const item of initialItems) collectLeaves(item, leaves);

const brushTargets = [];
const penTargets = [];
leaves.forEach((node, idx) => {
  if (isTextNode(node)) {
    try {
      const story = node.story;
      if (story && story.length > 0) {
        const atts = story.getGlyphAtts(0);
        if (atts.brushFill && atts.brushFill.fillType.value === FillType.Solid.value) {
          brushTargets.push({ node, idx, isText: true });
        }
        if (atts.penFill && atts.penFill.fillType.value === FillType.Solid.value) {
          penTargets.push({ node, idx, isText: true });
        }
      }
    } catch (e) {}
    return;
  }
  try {
    if (node.curvesInterface && node.brushFillDescriptor && node.brushFillDescriptor.fillType.value === FillType.Solid.value) {
      brushTargets.push({ node, idx, isText: false });
    }
  } catch (e) {}
  try {
    if (node.curvesInterface && node.hasPenFill && node.penFillDescriptor && node.penFillDescriptor.fillType.value === FillType.Solid.value) {
      penTargets.push({ node, idx, isText: false });
    }
  } catch (e) {}
});

const textTargetCount = brushTargets.filter((t) => t.isText).length + penTargets.filter((t) => t.isText).length;

if (brushTargets.length === 0 && penTargets.length === 0) {
  const msg = "No objects with a solid fill or stroke found in the selection (or the child objects of its groups).\n\nNote: objects that already have a gradient, hatch, bitmap fill or no fill are skipped - only solid colours can be converted.";
  console.log(msg);
  app.alert(msg, "Convert to Gradient");
  return;
}

// ─── Seedable PRNG (mulberry32) ──────────────────────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildRandomDeltas(seed, count) {
  const rng = mulberry32(seed);
  const arr = [];
  for (let i = 0; i < count; i++) arr.push(rng() * 2 - 1);
  return arr;
}

// ─── Angle jitter (only with extent = Manual angle) ──────────────────────
function jitterOffsetDeg(cfg, leafIndex, sub) {
  if (cfg.extentMode !== 2 || !(cfg.jitterAmount > 0)) return 0;
  const rng = mulberry32((Math.imul(cfg.seed | 0, 1000003) + Math.imul(leafIndex, 7919) + Math.imul(sub, 104729) + 12345) >>> 0);
  rng();
  const r = rng() * 2 - 1;
  const amount = cfg.jitterAmount, step = cfg.jitterStep;
  if (!(step > 0)) return r * amount;
  const n = Math.floor(amount / step + 1e-9);
  if (n === 0) return 0;
  const idx = Math.min(2 * n, Math.floor(((r + 1) / 2) * (2 * n + 1))) - n;
  return idx * step;
}

function cfgWithJitter(cfg, leafIndex, sub) {
  const off = jitterOffsetDeg(cfg, leafIndex, sub);
  return off === 0 ? cfg : Object.assign({}, cfg, { angleDeg: cfg.angleDeg + off });
}

// ─── Geometry helpers ────────────────────────────────────────────────────
const SAMPLES_PER_SEGMENT = 24;

function collectSamplePoints(node) {
  const pc = node.curvesInterface.polyCurve;
  const pts = [];
  for (let ci = 0; ci < pc.curveCount; ci++) {
    const curve = pc.at(ci);
    for (const bz of curve.beziers) {
      for (let s = 0; s <= SAMPLES_PER_SEGMENT; s++) pts.push(bz.evaluate(s / SAMPLES_PER_SEGMENT));
    }
  }
  return pts;
}

function collectAnchorPoints(node) {
  const pc = node.curvesInterface.polyCurve;
  const pts = [];
  for (let ci = 0; ci < pc.curveCount; ci++) {
    const curve = pc.at(ci);
    for (const bz of curve.beziers) pts.push(bz.start);
  }
  return pts;
}

function findExtreme(points, refPt, wantFarthest, minDistSq) {
  let best = null;
  let bestDSq = wantFarthest ? -1 : Infinity;
  for (const pt of points) {
    const dx = pt.x - refPt.x, dy = pt.y - refPt.y;
    const dSq = dx * dx + dy * dy;
    if (minDistSq != null && dSq < minDistSq) continue;
    if (wantFarthest ? dSq > bestDSq : dSq < bestDSq) {
      bestDSq = dSq;
      best = pt;
    }
  }
  return best ? { pt: best, distSq: bestDSq } : null;
}

function getBBoxCenter(node) {
  const bb = node.curvesInterface.polyCurve.getExactBoundingBox(null);
  if (!bb) return { x: 0, y: 0 };
  return { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
}

function getRefPoint(node, refMode) {
  if (refMode === 0) {
    const pc = node.curvesInterface.polyCurve;
    if (pc.curveCount === 0) return null;
    const firstBez = [...pc.at(0).beziers];
    if (firstBez.length === 0) return null;
    return firstBez[0].start;
  }
  if (refMode === 2) {
    try {
      const fp = node.transformInterface.focalPoint;
      if (fp.isValid) return { x: fp.point.x, y: fp.point.y };
    } catch (e) {}
  }
  return getBBoxCenter(node);
}

function symmetrizeAxisForCenteredLinear(axis, cfg) {
  if (cfg.gradType !== 0 || cfg.refMode === 0) return axis;
  const vx = axis.end.x - axis.start.x, vy = axis.end.y - axis.start.y;
  return { start: { x: axis.start.x - vx, y: axis.start.y - vy }, end: axis.end };
}

function computeAxis(node, cfg) {
  const refPt = getRefPoint(node, cfg.refMode);
  if (!refPt) return null;

  const bb = node.curvesInterface.polyCurve.getExactBoundingBox(null);
  const bboxDiag = bb ? Math.sqrt(bb.width * bb.width + bb.height * bb.height) : 1;

  let extentPt;
  if (cfg.extentMode === 2) {
    const points = collectSamplePoints(node);
    if (points.length === 0) return null;
    const far = findExtreme(points, refPt, true, null);
    const reach = far ? Math.sqrt(far.distSq) : bboxDiag;
    const rad = (cfg.angleDeg * Math.PI) / 180;
    extentPt = { x: refPt.x + Math.cos(rad) * reach, y: refPt.y + Math.sin(rad) * reach };
  } else if (cfg.extentMode === 1) {
    const anchors = collectAnchorPoints(node);
    if (anchors.length === 0) return null;
    const minThreshold = Math.pow(bboxDiag * 0.02, 2);
    let nearest = findExtreme(anchors, refPt, false, minThreshold);
    if (!nearest) nearest = findExtreme(anchors, refPt, true, null);
    extentPt = nearest ? nearest.pt : null;
  } else {
    const points = collectSamplePoints(node);
    if (points.length === 0) return null;
    const far = findExtreme(points, refPt, true, null);
    extentPt = far ? far.pt : null;
  }
  if (!extentPt) return null;

  const dx = extentPt.x - refPt.x, dy = extentPt.y - refPt.y;
  if (dx * dx + dy * dy <= 1e-6) return null;
  return symmetrizeAxisForCenteredLinear({ start: refPt, end: extentPt }, cfg);
}

function buildTransform(axis, gradType, bboxForRatio) {
  const axisX = axis.end.x - axis.start.x;
  const axisY = axis.end.y - axis.start.y;
  const tr = Transform.createIdentity();
  const d = tr.data;
  if (gradType === 2) {
    let ratio = 1;
    if (bboxForRatio && bboxForRatio.width > 0 && bboxForRatio.height > 0) {
      ratio = Math.min(bboxForRatio.width, bboxForRatio.height) / Math.max(bboxForRatio.width, bboxForRatio.height);
    }
    d[0] = axisX; d[3] = axisY;
    d[1] = -axisY * ratio; d[4] = axisX * ratio;
  } else {
    d[0] = axisX; d[3] = axisY;
    d[1] = -axisY; d[4] = axisX;
  }
  d[2] = axis.start.x; d[5] = axis.start.y;
  return tr;
}

function computeAxisForTextBB(bb, cfg) {
  if (!bb || bb.width <= 0 || bb.height <= 0) return null;

  const refPt = cfg.refMode === 0
    ? { x: bb.x, y: bb.y + bb.height / 2 }
    : { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };

  let extentPt;
  if (cfg.extentMode === 2) {
    const reach = Math.sqrt(bb.width * bb.width + bb.height * bb.height) / 2;
    const rad = (cfg.angleDeg * Math.PI) / 180;
    extentPt = { x: refPt.x + Math.cos(rad) * reach, y: refPt.y + Math.sin(rad) * reach };
  } else if (cfg.extentMode === 1) {
    extentPt = { x: refPt.x, y: bb.y + bb.height };
  } else {
    extentPt = { x: bb.x + bb.width, y: refPt.y };
  }
  const dx = extentPt.x - refPt.x, dy = extentPt.y - refPt.y;
  if (dx * dx + dy * dy <= 1e-6) return null;
  return symmetrizeAxisForCenteredLinear({ start: refPt, end: extentPt }, cfg);
}

// ─── Colour helpers ──────────────────────────────────────────────────────
function clamp01(v) { return Math.max(0, Math.min(1, v)); }

// stopMode: 0 = 2 stops, 1 = 3 stops, 2 = 5 stops
// v9: reverseL / reverseS reverse the lightness and saturation spread
// INDEPENDENTLY (start and end value are swapped per channel). The middle stop
// always stays the base colour.
function buildStops(baseHsl, facL, facS, facA, stopMode, reverseL, reverseS) {
  let lStart = clamp01(baseHsl.l + (0 - baseHsl.l) * facL);
  let lEnd   = clamp01(baseHsl.l + (1 - baseHsl.l) * facL);
  let sStart = clamp01(baseHsl.s + (0 - baseHsl.s) * facS);
  let sEnd   = clamp01(baseHsl.s + (1 - baseHsl.s) * facS);
  const aStart = clamp01(baseHsl.alpha * (1 - facA));
  const aEnd   = clamp01(baseHsl.alpha * (1 - facA));

  if (reverseL) { const t = lStart; lStart = lEnd; lEnd = t; }
  if (reverseS) { const t = sStart; sStart = sEnd; sEnd = t; }

  function mk(l, s, a) {
    return Colour.createHSLAf({ h: baseHsl.h, s: s, l: l, alpha: a });
  }

  const start = mk(lStart, sStart, aStart);
  const mid = mk(baseHsl.l, baseHsl.s, baseHsl.alpha);
  const end = mk(lEnd, sEnd, aEnd);

  if (stopMode === 0) {
    return [
      { colour: start, position: 0, midpoint: 0.5 },
      { colour: end, position: 1, midpoint: 0.5 },
    ];
  }
  if (stopMode === 1) {
    return [
      { colour: start, position: 0, midpoint: 0.5 },
      { colour: mid, position: 0.5, midpoint: 0.5 },
      { colour: end, position: 1, midpoint: 0.5 },
    ];
  }
  function lerp(a, b, t) { return a + (b - a) * t; }
  const lQ1 = lerp(lStart, baseHsl.l, 0.5), sQ1 = lerp(sStart, baseHsl.s, 0.5), aQ1 = lerp(aStart, baseHsl.alpha, 0.5);
  const lQ3 = lerp(baseHsl.l, lEnd, 0.5), sQ3 = lerp(baseHsl.s, sEnd, 0.5), aQ3 = lerp(baseHsl.alpha, aEnd, 0.5);
  return [
    { colour: start, position: 0, midpoint: 0.5 },
    { colour: mk(lQ1, sQ1, aQ1), position: 0.25, midpoint: 0.5 },
    { colour: mid, position: 0.5, midpoint: 0.5 },
    { colour: mk(lQ3, sQ3, aQ3), position: 0.75, midpoint: 0.5 },
    { colour: end, position: 1, midpoint: 0.5 },
  ];
}

// ─── FillDescriptor for a VECTOR object ──────────────────────────────────
function buildGradientFDFor(node, baseFD, cfg, leafIndex, randomDeltas) {
  const cfgJ = cfgWithJitter(cfg, leafIndex, 0);
  const axis = computeAxis(node, cfgJ);
  if (!axis) return null;

  let facL = cfg.facL, facS = cfg.facS;
  if (cfg.randomEnabled && randomDeltas) {
    const delta = randomDeltas[leafIndex] * (cfg.randomStrength / 100);
    facL = clamp01(facL + delta);
    facS = clamp01(facS + delta);
  }

  const baseHsl = baseFD.fill.colour.hslaf;
  const stops = buildStops(baseHsl, facL, facS, cfg.facA, cfg.stopMode, cfg.reverseL, cfg.reverseS);
  const grad = Gradient.create(stops);
  const gradFill = GradientFill.create(grad, [GradientFillType.Linear, GradientFillType.Radial, GradientFillType.Elliptical][cfg.gradType]);
  const bboxForRatio = node.curvesInterface.polyCurve.getExactBoundingBox(null);
  const tr = buildTransform(axis, cfg.gradType, bboxForRatio);

  return FillDescriptor.create(gradFill, false, tr, baseFD.blendMode, false);
}

// ─── FillDescriptor for TEXT (local BBox → spread, isAnchoredToSpread) ──
function buildGradientFDForText(baseFD, cfg, localBB, toSpreadTransform, facLOverride, facSOverride) {
  const localAxis = computeAxisForTextBB(localBB, cfg);
  if (!localAxis) return null;

  const spreadStart = toSpreadTransform.applyToPoint(localAxis.start);
  const spreadEnd = toSpreadTransform.applyToPoint(localAxis.end);
  const axis = { start: spreadStart, end: spreadEnd };

  const facL = facLOverride != null ? facLOverride : cfg.facL;
  const facS = facSOverride != null ? facSOverride : cfg.facS;

  const baseHsl = baseFD.fill.colour.hslaf;
  const stops = buildStops(baseHsl, facL, facS, cfg.facA, cfg.stopMode, cfg.reverseL, cfg.reverseS);
  const grad = Gradient.create(stops);
  const gradFill = GradientFill.create(grad, [GradientFillType.Linear, GradientFillType.Radial, GradientFillType.Elliptical][cfg.gradType]);
  const tr = buildTransform(axis, cfg.gradType, localBB);

  return FillDescriptor.create(gradFill, false, tr, baseFD.blendMode, true);
}

function effectiveFactors(cfg, leafIndex, randomDeltas) {
  if (!cfg.randomEnabled || !randomDeltas) return { facL: cfg.facL, facS: cfg.facS };
  const delta = randomDeltas[leafIndex] * (cfg.randomStrength / 100);
  return { facL: clamp01(cfg.facL + delta), facS: clamp01(cfg.facS + delta) };
}

function addTextFormatCommands(builder, node, baseFD, cfg, leafIndex, randomDeltas, usePen) {
  const { facL, facS } = effectiveFactors(cfg, leafIndex, randomDeltas);
  let added = 0;
  const toSpread = node.baseToSpreadTransform;

  if (cfg.textMode === 1) {
    const markIdxs = getMarkingCharIndexes(node.story);
    const n = markIdxs.length;
    if (n === 0) return 0;
    const bbFull = node.baseBox;
    for (let k = 0; k < n; k++) {
      const charBB = {
        x: bbFull.x + (k / n) * bbFull.width,
        y: bbFull.y,
        width: bbFull.width / n,
        height: bbFull.height,
      };
      const cfgJ = cfgWithJitter(cfg, leafIndex, k + 1);
      const fd = buildGradientFDForText(baseFD, cfgJ, charBB, toSpread, facL, facS);
      if (!fd) continue;
      const range = new Story.Range(markIdxs[k], markIdxs[k] + 1);
      const textSel = TextSelection.create([range]);
      const sel = Selection.createEmpty(doc);
      sel.addNode(node);
      sel.addSubSelectionForNode(node, textSel);
      const delta = usePen ? StoryDelta.createPenFill(fd) : StoryDelta.createBrushFill(fd);
      builder.addCommand(DocumentCommand.createFormatText(sel, delta));
      added++;
    }
  } else {
    const bb = node.baseBox;
    const cfgJ = cfgWithJitter(cfg, leafIndex, 0);
    const fd = buildGradientFDForText(baseFD, cfgJ, bb, toSpread, facL, facS);
    if (fd) {
      const delta = usePen ? StoryDelta.createPenFill(fd) : StoryDelta.createBrushFill(fd);
      builder.addCommand(DocumentCommand.createFormatText(node.selfSelection, delta));
      added = 1;
    }
  }
  return added;
}

function applyGradients(cfg) {
  const randomDeltas = cfg.randomEnabled ? buildRandomDeltas(cfg.seed, leaves.length) : null;
  const builder = CompoundCommandBuilder.create();
  let count = 0;

  for (const { node, idx, isText } of brushTargets) {
    if (isText) {
      const baseFD = node.story.getGlyphAtts(0).brushFill;
      count += addTextFormatCommands(builder, node, baseFD, cfg, idx, randomDeltas, false);
      continue;
    }
    const fd = buildGradientFDFor(node, node.brushFillDescriptor, cfg, idx, randomDeltas);
    if (!fd) continue;
    builder.addCommand(DocumentCommand.createSetBrushFill(Selection.create(doc, node), fd));
    count++;
  }

  if (cfg.includeStroke) {
    for (const { node, idx, isText } of penTargets) {
      if (isText) {
        const baseFD = node.story.getGlyphAtts(0).penFill;
        count += addTextFormatCommands(builder, node, baseFD, cfg, idx, randomDeltas, true);
        continue;
      }
      const fd = buildGradientFDFor(node, node.penFillDescriptor, cfg, idx, randomDeltas);
      if (!fd) continue;
      builder.addCommand(DocumentCommand.createSetPenFill(Selection.create(doc, node), fd));
      count++;
    }
  }

  if (count === 0) return 0;
  doc.executeCommand(builder.createCommand());
  return count;
}

// ─── Presets (prefix identical to the German version) ───────────────────
const PRESETS_DIR = app.userDesktopPath + "/AffinityScriptPresets";
const PRESET_PREFIX = "FarbverlaufWandeln_";

function sanitizePresetName(name) {
  return String(name || "").trim().replace(/[^a-zA-Z0-9 _-]/g, "_").slice(0, 80);
}
function presetPath(name) {
  return PRESETS_DIR + "/" + PRESET_PREFIX + sanitizePresetName(name) + ".json";
}
function savePresetToDisk(name, dataObj) {
  try {
    FileSystemApi.createDirectories(PRESETS_DIR);
    const f = File.create(presetPath(name), "w");
    f.writeStringAsUtf8(JSON.stringify(dataObj, null, 2));
    f.close();
    return true;
  } catch (e) {
    console.log("WARNING: preset could not be saved - " + e);
    return false;
  }
}
function loadPresetFromPath(path) {
  try {
    const buf = File.readAll(path);
    return JSON.parse(buf.toString("utf8"));
  } catch (e) {
    console.log("WARNING: preset could not be loaded - " + e);
    return null;
  }
}
function deletePresetAtPath(path) {
  try {
    FileSystemApi.remove(path);
    return true;
  } catch (e) {
    console.log("WARNING: preset could not be deleted - " + e);
    return false;
  }
}

// ─── Dialog defaults ────────────────────────────────────────────────────
let defGradType = 0;
let defRefMode = 0;
let defExtentMode = 0;
let defAngle = 0;
let defJitterAmount = 0;
let defJitterStep = 0;
let defReverseL = false;  // v9: reverse lightness
let defReverseS = false;  // v9: reverse saturation
let defFacL = 40;
let defFacS = 0;
let defFacA = 0;
let defStopMode = 1;
let defRandomEnabled = false;
let defRandomStrength = 10;
let defSeed = 1;
let defIncludeStroke = false;
let defTextMode = 0;

// ─── Preview ────────────────────────────────────────────────────────────
const posBeforePreview = doc.history.position;
let hasPreview = false;

function readCfg(ctrls) {
  return {
    gradType: ctrls.gradTypeCombo.selectedIndex,
    refMode: ctrls.refCombo.selectedIndex,
    extentMode: ctrls.extentCombo.selectedIndex,
    angleDeg: ctrls.angleEditor.value,
    jitterAmount: ctrls.jitterAmountEditor.value,
    jitterStep: ctrls.jitterStepEditor.value,
    reverseL: ctrls.reverseLCheck.value,
    reverseS: ctrls.reverseSCheck.value,
    facL: ctrls.facLEditor.value / 100,
    facS: ctrls.facSEditor.value / 100,
    facA: ctrls.facAEditor.value / 100,
    stopMode: ctrls.stopCombo.selectedIndex,
    randomEnabled: ctrls.randomCheck.value,
    randomStrength: ctrls.randomStrengthEditor.value,
    seed: Math.round(ctrls.seedEditor.value),
    includeStroke: ctrls.strokeCheck.value,
    textMode: ctrls.textModeCombo.selectedIndex,
  };
}

function updatePreview(ctrls) {
  if (hasPreview) rollbackToPosition(posBeforePreview);
  const cfg = readCfg(ctrls);
  const n = applyGradients(cfg);
  hasPreview = true;
  doc.executeCommand(DocumentCommand.createSetSelection(initialSelection));
  return n;
}

// ─── Dialog ──────────────────────────────────────────────────────────────
let applyResult = false;
let finalCfg = null;

while (true) {
  const dlg = Dialog.create("Convert to Gradient");
  dlg.initialWidth = 780;

  const colLeft = dlg.addColumn();
  const colRight = dlg.addColumn();
  colLeft.widthProportion = 1;
  colRight.widthProportion = 1;

  const grpInfo = colLeft.addGroup("");
  const infoText = grpInfo.addStaticText(
    "",
    brushTargets.length + " object(s) with solid fill, " + penTargets.length + " with solid stroke found" +
    (textTargetCount > 0 ? " (incl. " + textTargetCount + " text object(s))" : "") + ".",
  );

  const grpGeo = colLeft.addGroup("Gradient geometry");
  const gradTypeCombo = grpGeo.addComboBox("Gradient type", ["Linear", "Radial", "Elliptical"], defGradType);
  const refCombo = grpGeo.addComboBox("Reference point", ["Curve start / text start", "Object centre", "Focal point"], defRefMode);
  const extentCombo = grpGeo.addComboBox("Extent", ["Longest axis / text direction", "Shortest axis / text height", "Manual angle"], defExtentMode);
  const angleEditor = grpGeo.addUnitValueEditor("Angle (with manual extent)", UnitType.Degree, UnitType.Degree, defAngle, -180, 180);
  angleEditor.value = defAngle;
  const jitterAmountEditor = grpGeo.addUnitValueEditor("Angle jitter ± (added to the angle)", UnitType.Degree, UnitType.Degree, defJitterAmount, 0, 180);
  jitterAmountEditor.value = defJitterAmount;
  const jitterStepEditor = grpGeo.addUnitValueEditor("Jitter step (0 = continuous)", UnitType.Degree, UnitType.Degree, defJitterStep, 0, 180);
  jitterStepEditor.value = defJitterStep;

  const grpColour = colLeft.addGroup("Colour");
  const facLEditor = grpColour.addUnitValueEditor("Lightness factor (%)", UnitType.Percentage, UnitType.Percentage, defFacL, 0, 100);
  facLEditor.value = defFacL;
  const reverseLCheck = grpColour.addCheckBox("Reverse colour (lightness: light → dark)", defReverseL);
  const facSEditor = grpColour.addUnitValueEditor("Saturation factor (%)", UnitType.Percentage, UnitType.Percentage, defFacS, 0, 100);
  facSEditor.value = defFacS;
  const reverseSCheck = grpColour.addCheckBox("Reverse saturation (saturated → desaturated)", defReverseS);
  const facAEditor = grpColour.addUnitValueEditor("Opacity thinning (%)", UnitType.Percentage, UnitType.Percentage, defFacA, 0, 100);
  facAEditor.value = defFacA;
  const stopCombo = grpColour.addComboBox("Number of stops", ["2 (no middle stop)", "3 (default)", "5 (soft)"], defStopMode);

  const grpRandom = colRight.addGroup("Random variation");
  const randomCheck = grpRandom.addCheckBox("Enable", defRandomEnabled);
  const randomStrengthEditor = grpRandom.addUnitValueEditor("Strength (±%)", UnitType.Percentage, UnitType.Percentage, defRandomStrength, 0, 100);
  randomStrengthEditor.value = defRandomStrength;
  const seedEditor = grpRandom.addUnitValueEditor("Seed (variation + angle jitter)", UnitType.Number, UnitType.Number, defSeed, 0, 999999);
  seedEditor.value = defSeed;

  const grpStroke = colRight.addGroup("Stroke");
  const strokeCheck = grpStroke.addCheckBox("Include solid stroke (pen fill)", defIncludeStroke);

  const grpText = colRight.addGroup("Text processing");
  const textModeCombo = grpText.addComboBox("Processing", ["Whole text", "Individual characters"], defTextMode);

  const grpAction = colRight.addGroup("");
  const previewBtn = grpAction.addButton("▶ Update preview");

  const grpPresets = colRight.addGroup("Presets");
  const presetSaveBtn = grpPresets.addButton("💾 Save…");
  const presetLoadBtn = grpPresets.addButton("📂 Load…");
  const presetDeleteBtn = grpPresets.addButton("🗑 Delete…");

  const ctrls = {
    gradTypeCombo, refCombo, extentCombo, angleEditor, jitterAmountEditor, jitterStepEditor,
    reverseLCheck, reverseSCheck,
    facLEditor, facSEditor, facAEditor, stopCombo,
    randomCheck, randomStrengthEditor, seedEditor, strokeCheck, textModeCombo,
  };

  let isUpdatingUi = false;
  const updateEnabled = () => {
    if (isUpdatingUi) return;
    isUpdatingUi = true;
    try {
      const manual = extentCombo.selectedIndex === 2;
      const jitterOn = manual && jitterAmountEditor.value > 0;
      angleEditor.isEnabled = manual;
      jitterAmountEditor.isEnabled = manual;
      jitterStepEditor.isEnabled = jitterOn;
      randomStrengthEditor.isEnabled = randomCheck.value;
      seedEditor.isEnabled = randomCheck.value || jitterOn;
      strokeCheck.isEnabled = penTargets.length > 0;
      textModeCombo.isEnabled = textTargetCount > 0;
      // v9: reversal only makes sense if the respective factor is > 0
      reverseLCheck.isEnabled = facLEditor.value > 0;
      reverseSCheck.isEnabled = facSEditor.value > 0;
      infoText.setText(
        brushTargets.length + " object(s) with solid fill" +
        (strokeCheck.value ? ", " + penTargets.length + " with solid stroke (included)" : "") +
        (textTargetCount > 0 ? " (incl. " + textTargetCount + " text object(s))" : "") + ".",
      );
    } finally {
      isUpdatingUi = false;
    }
  };
  updateEnabled();
  extentCombo.setOnValueChangedHandler(updateEnabled);
  jitterAmountEditor.setOnValueChangedHandler(updateEnabled);
  randomCheck.setOnValueChangedHandler(updateEnabled);
  strokeCheck.setOnValueChangedHandler(updateEnabled);
  facLEditor.setOnValueChangedHandler(updateEnabled);
  facSEditor.setOnValueChangedHandler(updateEnabled);

  previewBtn.setOnClickHandler(() => {
    try {
      const n = updatePreview(ctrls);
      console.log("Preview updated (" + n + " object(s)).");
    } catch (e) {
      console.log("WARNING: preview update failed - " + e);
    }
  });

  presetSaveBtn.setOnClickHandler(() => {
    const name = app.prompt("Preset name:", "Save preset", "");
    if (!name || !name.trim()) { console.log("Save cancelled - no name entered."); return; }
    const data = readCfg(ctrls);
    data.facL = facLEditor.value;
    data.facS = facSEditor.value;
    data.facA = facAEditor.value;
    data.randomStrength = randomStrengthEditor.value;
    if (savePresetToDisk(name, data)) console.log('Preset "' + name.trim() + '" saved in ' + PRESETS_DIR + '.');
  });

  presetLoadBtn.setOnClickHandler(() => {
    const path = app.chooseFile();
    if (!path) { console.log("Load cancelled."); return; }
    const data = loadPresetFromPath(path);
    if (!data) return;
    if (typeof data.gradType === "number") gradTypeCombo.selectedIndex = data.gradType;
    if (typeof data.refMode === "number") refCombo.selectedIndex = data.refMode;
    if (typeof data.extentMode === "number") extentCombo.selectedIndex = data.extentMode;
    if (typeof data.angleDeg === "number") angleEditor.value = data.angleDeg;
    if (typeof data.jitterAmount === "number") jitterAmountEditor.value = data.jitterAmount;
    if (typeof data.jitterStep === "number") jitterStepEditor.value = data.jitterStep;
    // v9: older presets with a shared "reversed" set both reversals
    if (typeof data.reversed === "boolean") { reverseLCheck.value = data.reversed; reverseSCheck.value = data.reversed; }
    if (typeof data.reverseL === "boolean") reverseLCheck.value = data.reverseL;
    if (typeof data.reverseS === "boolean") reverseSCheck.value = data.reverseS;
    if (typeof data.facL === "number") facLEditor.value = data.facL;
    if (typeof data.facS === "number") facSEditor.value = data.facS;
    if (typeof data.facA === "number") facAEditor.value = data.facA;
    if (typeof data.stopMode === "number") stopCombo.selectedIndex = data.stopMode;
    if (typeof data.randomEnabled === "boolean") randomCheck.value = data.randomEnabled;
    if (typeof data.randomStrength === "number") randomStrengthEditor.value = data.randomStrength;
    if (typeof data.seed === "number") seedEditor.value = data.seed;
    if (typeof data.includeStroke === "boolean") strokeCheck.value = data.includeStroke;
    if (typeof data.textMode === "number") textModeCombo.selectedIndex = data.textMode;
    updateEnabled();
    const n = updatePreview(ctrls);
    console.log('Preset loaded from "' + path + '" (' + n + ' object(s) updated).');
  });

  presetDeleteBtn.setOnClickHandler(() => {
    const path = app.chooseFile();
    if (!path) { console.log("Delete cancelled."); return; }
    if (deletePresetAtPath(path)) console.log('Preset file "' + path + '" deleted.');
  });

  const result = dlg.runModal();

  defGradType = gradTypeCombo.selectedIndex;
  defRefMode = refCombo.selectedIndex;
  defExtentMode = extentCombo.selectedIndex;
  defAngle = angleEditor.value;
  defJitterAmount = jitterAmountEditor.value;
  defJitterStep = jitterStepEditor.value;
  defReverseL = reverseLCheck.value;
  defReverseS = reverseSCheck.value;
  defFacL = facLEditor.value;
  defFacS = facSEditor.value;
  defFacA = facAEditor.value;
  defStopMode = stopCombo.selectedIndex;
  defRandomEnabled = randomCheck.value;
  defRandomStrength = randomStrengthEditor.value;
  defSeed = Math.round(seedEditor.value);
  defIncludeStroke = strokeCheck.value;
  defTextMode = textModeCombo.selectedIndex;

  if (!result || result.value !== DialogResult.Ok.value) {
    if (hasPreview) rollbackToPosition(posBeforePreview);
    doc.executeCommand(DocumentCommand.createSetSelection(initialSelection));
    console.log("Cancelled.");
    return;
  }

  finalCfg = readCfg(ctrls);
  applyResult = true;
  break;
}

// ─── Commit: discard the preview, re-apply with the final configuration ─
if (!applyResult) return;

if (hasPreview) rollbackToPosition(posBeforePreview);
const finalCount = applyGradients(finalCfg);
doc.executeCommand(DocumentCommand.createSetSelection(initialSelection));

if (finalCount === 0) {
  console.log("No gradient was created (no suitable objects).");
} else {
  console.log("✓ " + finalCount + " fill(s)/stroke(s) converted to a gradient.");
}
