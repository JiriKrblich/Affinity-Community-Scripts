'use strict';

/**
 * name: select_same_1.0
 * description: Select Same — multi-attribute selection. Selects every object
 *              that shares the checked attribute(s) with the current selection:
 *              font family, family & style, font size, text fill/stroke colour,
 *              opacity, blend mode, shape type, corner radius, rotation.
 *              Combine with Match-all for Illustrator's "Family, Style & Size"
 *              etc. Closes the gap to the Select > Same submenu.
 * version: 1.5.0
 * author: olliollio - analog digitalagentur
 */


const { app } = require('/application');
const { Document } = require('/document');
const { Selection, SubSelectionType } = require('/selections');
const { NodeChildType, getNodeChildrenRecursive } = require('/nodes');
const { Dialog, DialogResult } = require('/dialog');

const VERSION = 'v1.5';
const TITLE = 'Select Same';

// Glyph sizes are canonicalised to 2 decimals, giving a ~0.01 pt match bucket
// so floating-point noise (11.9997 vs 12.0001) still counts as the same size.
function sizeKey(h) { return h.toFixed(2); }

// Very long stories are sampled rather than scanned char-by-char, so a single
// huge text frame can't stall the whole pass.
const MAX_SCAN = 5000;

function scanGlyphs(node, range, onAtts) {
  let story;
  try { story = node && node.storyInterface && node.storyInterface.story; }
  catch (e) { return; }
  if (!story) return;

  let len;
  try { len = story.length; } catch (e) { return; }
  if (!len || len <= 0) return;

  let begin = 0, end = len;
  if (range) {
    begin = Math.max(0, Math.min(range.begin, range.end));
    end   = Math.min(len, Math.max(range.begin, range.end));
    if (end <= begin) end = begin + 1; // a caret (zero-length) still reads 1 glyph
  }

  const count = end - begin;
  const step  = count > MAX_SCAN ? Math.ceil(count / MAX_SCAN) : 1;
  for (let p = begin; p < end; p += step) {
    let atts;
    try { atts = story.getGlyphAtts(Math.min(p, len - 1)); }
    catch (e) { continue; }
    if (atts && onAtts(atts)) return;
  }
}

// Every distinct key an extractor pulls from a node's glyph runs (nulls
// skipped). Used to gather the reference's target keys.
function collectKeys(node, range, extract) {
  const set = new Set();
  scanGlyphs(node, range, (a) => {
    let k; try { k = extract(a); } catch (e) { k = null; }
    if (k != null) set.add(k);
    return false;
  });
  return set;
}

// Candidate test: does any glyph run yield a key in the target set? Early-exits.
function anyKeyIn(node, targetSet, extract) {
  let hit = false;
  scanGlyphs(node, null, (a) => {
    let k; try { k = extract(a); } catch (e) { k = null; }
    if (k != null && targetSet.has(k)) { hit = true; return true; }
    return false;
  });
  return hit;
}

// -- Extractor + describe helpers -------------------------------------------
// Font size, bucketed to 0.01 pt so float noise still counts as the same size.
function sizeKey(a) {
  const h = a.height;
  return (typeof h === 'number' && isFinite(h)) ? h.toFixed(2) : null;
}

// A text run's fill/stroke lives on a FillDescriptor (atts.brushFill = fill,
// atts.penFill = stroke); its `.fill` is the actual Fill object. Only a
// SolidFill compares reliably -> canonical "r,g,b,alpha". Gradients / none /
// patterns yield null so they never match a solid colour.
function rgbaKey(colour) {
  if (!colour) return null;
  try { const c = colour.rgba8; return c.r + ',' + c.g + ',' + c.b + ',' + c.alpha; }
  catch (e) { return null; }
}
function descriptorColourKey(desc) {
  if (!desc) return null;
  let fill; try { fill = desc.fill; } catch (e) { return null; }
  if (!fill) return null;
  try { if (fill[Symbol.toStringTag] === 'SolidFill') return rgbaKey(fill.colour); }
  catch (e) {}
  return null;
}

// The exact typeface. Prefer the PostScript name (uniquely identifies family +
// style); fall back to familyName + styleName when it isn't available.
function faceKey(a) {
  const f = a.font;
  if (!f) return null;
  try { if (f.postscriptName) return 'ps:' + f.postscriptName; } catch (e) {}
  let fam = ''; try { fam = f.familyName ? String(f.familyName) : ''; } catch (e) {}
  if (!fam) return null;
  let st = ''; try { st = a.styleName != null ? String(a.styleName) : ''; } catch (e) {}
  return 'fs:' + fam + '|' + st;
}

function describeSizes(set) {
  return 'font size ' + [...set].map(Number).sort((a, b) => a - b)
    .map((v) => String(Math.round(v * 100) / 100)).join(', ') + ' pt';
}
function describeFamilies(set) {
  return 'font family ' + [...set].sort().join(', ');
}
function describeFaces(set) {
  const names = [...set].map((k) => {
    if (k.slice(0, 3) === 'ps:') return k.slice(3);
    if (k.slice(0, 3) === 'fs:') { const p = k.slice(3).split('|'); return (p[0] + ' ' + (p[1] || '')).trim(); }
    return k;
  }).sort();
  return 'font family & style ' + names.join(', ');
}
function hexOf(key) {
  const p = key.split(',');
  const to2 = (n) => ('0' + (parseInt(n, 10) || 0).toString(16)).slice(-2);
  let hex = '#' + to2(p[0]) + to2(p[1]) + to2(p[2]);
  if (Number(p[3]) < 255) hex += ' (a' + p[3] + ')';
  return hex;
}
function describeColours(label, set) {
  return label + ' ' + [...set].map(hexOf).sort().join(', ');
}

// -- Object-level extractors (read straight from the node, not glyph runs). --
// Opacity is node.globalOpacity (0..1); bucket to 0.001 so slider rounding
// noise still counts as equal.
function opacityKey(node) {
  const o = node.globalOpacity;
  return (typeof o === 'number' && isFinite(o)) ? o.toFixed(3) : null;
}
// blendMode is an enum object exposing a numeric .value (Normal, Multiply, ...).
function blendKey(node) {
  const b = node.blendMode;
  if (b == null) return null;
  let v; try { v = (b.value !== undefined) ? b.value : b; } catch (e) { v = b; }
  return (v == null) ? null : String(v);
}
function describeOpacity(set) {
  return 'opacity ' + [...set].map((v) => Math.round(Number(v) * 100) + '%')
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10)).join(', ');
}
function describeBlend(set) {
  return 'blend mode #' + [...set].sort().join(', #');
}

// Affinity enum objects carry a numeric .value (e.g. BlendMode, ShapeType,
// ShapeCornerType); this reads it uniformly.
function enumVal(e) {
  if (e == null) return null;
  try { if (e.value !== undefined) return e.value; } catch (er) {}
  return e;
}

// Shape kind lives on a LIVE shape node: node.shape.shapeType (0 = rectangle,
// etc.). Converted curves (PolyCurveNode) have no .shape -> null (N/A).
function shapeTypeKey(node) {
  let shp; try { shp = node.shape; } catch (e) { return null; }
  if (!shp) return null;
  let st; try { st = shp.shapeType; } catch (e) { return null; }
  const v = enumVal(st);
  return (v == null) ? null : 'shape:' + v;
}

// Corner radius: the four ShapeRectangleCornerProxy radii + their corner type,
// tagged with absoluteSizes (false => the radius is a 0..1 fraction of the
// shape; true => absolute px). Only corner-bearing shapes (rectangles) yield a
// key; anything else returns null (N/A).
function cornerRadiusKey(node) {
  let shp; try { shp = node.shape; } catch (e) { return null; }
  if (!shp) return null;
  let abs; try { abs = shp.absoluteSizes; } catch (e) { abs = null; }
  const parts = [];
  for (const ck of ['topLeft', 'topRight', 'bottomRight', 'bottomLeft']) {
    let cp; try { cp = shp[ck]; } catch (e) { cp = null; }
    if (!cp) return null;
    let r; try { r = cp.radius; } catch (e) { r = null; }
    if (typeof r !== 'number' || !isFinite(r)) return null;
    let ct; try { ct = enumVal(cp.cornerType); } catch (e) { ct = null; }
    parts.push((ct == null ? '?' : ct) + ':' + r.toFixed(4));
  }
  return 'abs' + (abs ? '1' : '0') + '|' + parts.join('|');
}

function describeShape(set) {
  return 'shape type ' + [...set].map((k) => k.replace('shape:', '#')).sort().join(', ');
}
function describeCorners(set) {
  return 'corner radius ' + [...set].map((k) => {
    const segs = k.split('|');
    const abs = segs[0] === 'abs1';
    const radii = segs.slice(1).map((s) => parseFloat(s.split(':')[1]));
    const uniform = radii.every((r) => r === radii[0]);
    if (abs) return (uniform ? String(radii[0]) : radii.join('/')) + 'px';
    return uniform ? Math.round(radii[0] * 100) + '%' : radii.map((r) => Math.round(r * 100) + '%').join('/');
  }).sort().join(', ');
}

// Rotation lives in node.transform. The x basis vector (transform.xAxis) is the
// transformed (1,0) direction, so angle = atan2(xAxis.y, xAxis.x) recovers the
// rotation independent of scale and of the raw matrix's storage order. Sign /
// convention is irrelevant for matching as long as it is deterministic; we
// normalise to [0,360) and bucket to 0.1 deg.
function angleFromXY(x, y) {
  if (typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) return null;
  if (x === 0 && y === 0) return null;
  let deg = Math.atan2(y, x) * 180 / Math.PI;
  return ((deg % 360) + 360) % 360;
}
function rotationKey(node) {
  let t; try { t = node.transform; } catch (e) { return null; }
  if (!t) return null;
  // Preferred: the x basis vector.
  let ax; try { ax = t.xAxis; } catch (e) { ax = null; }
  if (ax) {
    let x, y;
    try { x = (ax.x !== undefined) ? ax.x : ax[0]; } catch (e) {}
    try { y = (ax.y !== undefined) ? ax.y : ax[1]; } catch (e) {}
    const a = angleFromXY(x, y);
    if (a != null) return a.toFixed(1);
  }
  // Fallback: raw affine matrix data [a, b, ...].
  let d; try { d = t.data; } catch (e) { d = null; }
  if (d) {
    let a0, a1; try { a0 = d[0]; a1 = d[1]; } catch (e) {}
    const a = angleFromXY(a0, a1);
    if (a != null) return a.toFixed(1);
  }
  return null;
}
function describeRotation(set) {
  return 'rotation ' + [...set].map((v) => {
    let d = Number(v);
    if (d > 180) d -= 360;             // show as -180..180 for readability
    return (Math.round(d * 10) / 10) + '°';
  }).sort((a, b) => parseFloat(a) - parseFloat(b)).join(', ');
}

// ---------------------------------------------------------------------------
// Criteria registry. Each entry is one "Select Same X" matcher and generates
// its own checkbox. Two flavours share the same collect/match plumbing:
//   glyphCriterion -> reads text glyph runs   (font family/face, size, fills)
//   nodeCriterion  -> reads the node itself    (opacity, blend mode, ...)
// Illustrator's combined items (Family & Style, Family Style & Size, Fill &
// Stroke) come from checking several boxes with "Match all (AND)". Adding a
// matcher is a single line here; nothing else changes.
//   refKeys(node, range) -> Set  target keys for the reference gathering
//   test(node, targetSet) -> bool does a candidate share any target key
//   describe(Set) -> string       human summary for the result dialog
// ---------------------------------------------------------------------------
function glyphCriterion(id, label, def, extract, describe) {
  return {
    id: id, label: label, default: def, describe: describe,
    refKeys: (node, range) => collectKeys(node, range, extract),
    test: (node, set) => anyKeyIn(node, set, extract),
  };
}
function nodeCriterion(id, label, def, extract, describe) {
  return {
    id: id, label: label, default: def, describe: describe,
    refKeys: (node) => {
      const s = new Set();
      let k; try { k = extract(node); } catch (e) { k = null; }
      if (k != null) s.add(k);
      return s;
    },
    test: (node, set) => {
      let k; try { k = extract(node); } catch (e) { k = null; }
      return k != null && set.has(k);
    },
  };
}

const CRITERIA = [
  glyphCriterion('fontFamily', 'Font family', false,
    (a) => { const f = a.font; return (f && f.familyName) ? String(f.familyName) : null; },
    describeFamilies),
  glyphCriterion('fontFace', 'Font family & style', false, faceKey, describeFaces),
  glyphCriterion('fontSize', 'Font size', false, sizeKey, describeSizes),
  glyphCriterion('textFill', 'Text fill colour', false,
    (a) => descriptorColourKey(a.brushFill),
    (set) => describeColours('text fill colour', set)),
  glyphCriterion('textStroke', 'Text stroke colour', false,
    (a) => descriptorColourKey(a.penFill),
    (set) => describeColours('text stroke colour', set)),

  nodeCriterion('opacity', 'Opacity', false, opacityKey, describeOpacity),
  nodeCriterion('blendMode', 'Blend mode', false, blendKey, describeBlend),
  nodeCriterion('shape', 'Shape (type)', false, shapeTypeKey, describeShape),
  nodeCriterion('cornerRadius', 'Corner radius', false, cornerRadiusKey, describeCorners),
  nodeCriterion('rotation', 'Rotation', false, rotationKey, describeRotation),
];

// Gather the target key set for one criterion across the whole reference
// selection. A text sub-range (if the user selected specific characters) narrows
// the read to exactly those glyphs; otherwise the whole object is read.
function readReferenceKeys(doc, criterion) {
  const keys = new Set();
  const sel = doc.selection;
  const items = (sel && sel.items && sel.items.length) ? sel.items : [];
  for (const item of items) {
    const node = item.node;
    if (!node) continue;
    let range = null;
    try {
      const sub = item.getSubSelectionOfType(SubSelectionType.Text);
      if (sub && !sub.isEmpty && sub.rangeCount > 0) {
        const r = sub.ranges[0];
        range = { begin: r.begin, end: r.end };
      }
    } catch (e) { /* item carries no text sub-selection */ }
    criterion.refKeys(node, range).forEach((k) => keys.add(k));
  }
  return keys;
}

// The reference's containing artboard, found by walking up the parent chain
// until a node reports itself as an enabled artboard. There is no direct
// "active artboard" accessor in this build, so we locate the one the selection
// actually sits inside. Returns null if the selection is not on any artboard.
function getArtboardAncestor(node) {
  let n = node;
  while (n) {
    try {
      const ai = n.artboardInterface;
      if (ai && ai.isArtboardEnabled) return n;
    } catch (e) { /* node exposes no artboardInterface */ }
    n = n.parent;
  }
  return null;
}

const SCOPE_SPREAD    = 0;
const SCOPE_ARTBOARD  = 1;
const SCOPE_LAYER     = 2;

// The container whose descendants we search:
//   Whole spread -> doc.currentSpread
//   This artboard -> the artboard the selection sits in (null if none)
//   Same layer   -> the reference's direct parent (the group/layer shown in the
//                   Layers panel)
function getScopeParent(doc, scopeIdx) {
  const sel = doc.selection;
  const first = (sel && sel.firstNode) ||
                (sel && sel.nodes && sel.nodes.first) || null;
  if (scopeIdx === SCOPE_ARTBOARD) return getArtboardAncestor(first); // may be null
  if (scopeIdx === SCOPE_LAYER && first && first.parent) return first.parent;
  return doc.currentSpread;
}

// AND: node must match every active criterion. OR: any one is enough.
function nodeMatches(node, active, refKeys, combineAll) {
  for (const c of active) {
    const ok = c.test(node, refKeys.get(c.id));
    if (combineAll && !ok) return false;
    if (!combineAll && ok) return true;
  }
  return combineAll;
}

function main() {
  const doc = Document.current;
  if (!doc) {
    app.alert('Open a document first.', TITLE);
    return;
  }
  if (!doc.selection || doc.selection.length === 0) {
    app.alert('Select at least one object to use as the reference.', TITLE);
    return;
  }

  // -- Dialog: one checkbox per registered criterion, plus scope + combine. ---
  const dlg = Dialog.create(TITLE + ' ' + VERSION);
  dlg.initialWidth = 360;
  const col = dlg.addColumn();

  const grpCrit = col.addGroup('Match attributes');
  const checks = CRITERIA.map((c) => grpCrit.addCheckBox(c.label, c.default));

  const grpScope     = col.addGroup('Scope');
  const scopeCombo   = grpScope.addComboBox('Search in', ['Whole spread', 'This artboard', 'Same layer as selection'], 0);
  const combineCombo = grpScope.addComboBox('When multiple checked', ['Match all (AND)', 'Match any (OR)'], 0);

  if (dlg.runModal() !== DialogResult.Ok) return;

  const chosen = CRITERIA.filter((c, i) => checks[i].value);
  if (chosen.length === 0) {
    app.alert('Check at least one attribute to match.', TITLE);
    return;
  }

  // Read reference keys BEFORE we touch the selection. Drop any criterion the
  // reference can't supply (e.g. Font size checked but no text is selected).
  const refKeys = new Map();
  const applicable = [];
  const skipped = [];
  for (const c of chosen) {
    const keys = readReferenceKeys(doc, c);
    if (keys.size > 0) { refKeys.set(c.id, keys); applicable.push(c); }
    else skipped.push(c.label);
  }
  if (applicable.length === 0) {
    app.alert('The selection has no ' + chosen.map((c) => c.label.toLowerCase()).join(' / ') +
      ' to match.\n(Text attributes need a text object; opacity / blend mode work on any object.)', TITLE);
    return;
  }

  const combineAll = combineCombo.selectedIndex === 0;
  const scopeIdx   = scopeCombo.selectedIndex;
  const parent = getScopeParent(doc, scopeIdx);
  if (!parent || !parent.handle) {
    if (scopeIdx === SCOPE_ARTBOARD) {
      app.alert('The selection is not inside an artboard, so "This artboard" has ' +
        'nothing to search. Pick a different scope or select an object on an artboard.', TITLE);
    } else {
      app.alert('Could not determine a scope to search.', TITLE);
    }
    return;
  }

  // -- Scan the scope and collect matching nodes. ----------------------------
  const matches = [];
  let scanned = 0;
  for (const child of getNodeChildrenRecursive(parent.handle, NodeChildType.Main, false)) {
    scanned++;
    if (nodeMatches(child, applicable, refKeys, combineAll)) matches.push(child);
  }

  const desc = applicable.map((c) => c.describe(refKeys.get(c.id)))
    .join(combineAll ? '  AND  ' : '  OR  ');
  const scopeName = scopeIdx === SCOPE_ARTBOARD ? 'this artboard'
    : scopeIdx === SCOPE_LAYER ? 'the selection’s layer'
    : 'the spread';
  const skipNote  = skipped.length ? '\nIgnored (not present in selection): ' + skipped.join(', ') : '';

  if (matches.length === 0) {
    app.alert('No objects match ' + desc + '.\nSelection left unchanged.' + skipNote, TITLE);
    return;
  }

  // -- Commit the computed node list as the live selection. ------------------
  const newSel = Selection.createEmpty(doc);
  for (const n of matches) newSel.add(n);
  doc.selection = newSel;

  app.alert('Selected ' + matches.length + ' object' + (matches.length === 1 ? '' : 's') +
    ' matching ' + desc + '.\nScanned ' + scanned + ' nodes in ' + scopeName + '.' + skipNote, TITLE);
}

main();
