/**
 * name: scale_with_text_1.0
 * description: Scales a selection to a target width or height about a 3x3 anchor, including Frame Text, which Affinity's Transform panel leaves unscaled.
 * version: 1.1.1
 * author: olliollio
 */

// Set true to run the built-in assertions instead of the script.
// The self-test never touches the document.
var SELFTEST = false;

// ---------------------------------------------------------------- harness

var _tests = { pass: 0, fail: 0 };

function assert(name, cond) {
  if (cond) { _tests.pass++; console.log('PASS  ' + name); }
  else { _tests.fail++; console.log('FAIL  ' + name); }
}

function assertClose(name, actual, expected, tol) {
  var t = (tol === undefined) ? 1e-6 : tol;
  var ok = Math.abs(actual - expected) <= t;
  if (ok) { _tests.pass++; console.log('PASS  ' + name); }
  else { _tests.fail++; console.log('FAIL  ' + name + '  expected ' + expected + ' got ' + actual); }
}

function assertEqual(name, actual, expected) {
  var ok = String(actual) === String(expected);
  if (ok) { _tests.pass++; console.log('PASS  ' + name); }
  else { _tests.fail++; console.log('FAIL  ' + name + '  expected "' + expected + '" got "' + actual + '"'); }
}

function reportTests() {
  console.log('');
  console.log('==== ' + _tests.pass + ' passed, ' + _tests.fail + ' failed ====');
}

// ---------------------------------------------------------------- geometry

// Axis-aligned union of {x,y,width,height} boxes. Null for an empty list.
function unionBox(boxes) {
  if (!boxes || !boxes.length) return null;
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (var i = 0; i < boxes.length; i++) {
    var b = boxes[i];
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.width > maxX) maxX = b.x + b.width;
    if (b.y + b.height > maxY) maxY = b.y + b.height;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// Row-major, mirroring Affinity's 3x3 anchor widget.
var ANCHORS = [
  { label: 'Top Left',      fx: 0,   fy: 0   },
  { label: 'Top Centre',    fx: 0.5, fy: 0   },
  { label: 'Top Right',     fx: 1,   fy: 0   },
  { label: 'Middle Left',   fx: 0,   fy: 0.5 },
  { label: 'Centre',        fx: 0.5, fy: 0.5 },
  { label: 'Middle Right',  fx: 1,   fy: 0.5 },
  { label: 'Bottom Left',   fx: 0,   fy: 1   },
  { label: 'Bottom Centre', fx: 0.5, fy: 1   },
  { label: 'Bottom Right',  fx: 1,   fy: 1   }
];

// The point that must stay fixed during the scale.
function anchorPoint(box, index) {
  var a = ANCHORS[index] || ANCHORS[0];
  return { x: box.x + a.fx * box.width, y: box.y + a.fy * box.height };
}

// With the ratio locked, width is authoritative and height follows.
function scaleFactors(box, targetW, targetH, lockRatio) {
  var kx = targetW / box.width;
  var ky = lockRatio ? kx : (targetH / box.height);
  return { kx: kx, ky: ky };
}

// Guard against committing an empty undo step.
function isNoOp(f) {
  return Math.abs(f.kx - 1) < 1e-6 && Math.abs(f.ky - 1) < 1e-6;
}

// Affinity's own stroke-scale factor: the RMS of the axis scales.
//
// Derived by measuring LineStyleDescriptor.effectiveWeight(localTransform):
//   (2,2) -> 2.0000   (2,1) -> 1.5811 = sqrt(2.5)   (2,4) -> 3.1623 = sqrt(10)
//   (1,2) -> 1.5811 (symmetric)        (0.5,0.5) -> 0.5000
// Not sqrt(kx*ky) and not a mean. Collapses to k when uniform.
function strokeFactor(kx, ky) {
  return Math.sqrt((kx * kx + ky * ky) / 2);
}

// Should this node's stroke be scaled by us?
//
// info: { weight, isScale, isLineStyleVisible, isNoFill } - plain values, so
// this is testable without a document.
function strokeNeedsScaling(info) {
  if (typeof info.weight !== 'number' || info.weight <= 0) return false;
  // isScale === true means Affinity scales this stroke at render time already.
  if (info.isScale) return false;
  // A shape with no stroke STILL reports a stored lineWeight - Affinity keeps
  // the weight (and dash pattern) when you remove the stroke colour. Writing a
  // line style descriptor to such a node makes that dormant stroke visible.
  // Weight alone is not evidence of a stroke; visibility is.
  if (info.isLineStyleVisible !== true) return false;
  if (info.isNoFill === true) return false;
  return true;
}

// Scale by (kx,ky) while holding the anchor point fixed: T(p) . S . T(-p)
//
// Transform.around() and .translated() produce the same matrix, but around()
// mutates its receiver and translated()'s multiply side is undocumented.
// This form is explicit and reads as the maths.
function buildAnchoredScale(box, kx, ky, anchorIndex) {
  var Transform = require('/geometry').Transform;
  var p = anchorPoint(box, anchorIndex);
  return Transform.createTranslate(p.x, p.y)
                  .multiply(Transform.createScale(kx, ky))
                  .multiply(Transform.createTranslate(-p.x, -p.y));
}

// ---------------------------------------------------------------- text rules

// Leading modes in which absoluteLeading is the field actually read.
// ParagraphLeadingType: RelativeToIdeal=0, RelativeToHeight=1,
// ExactlyAbsolute=2, AtLeastAbsolute=3, RelativeToIdealAbsolute=4
var ABSOLUTE_LEADING_TYPES = [2, 3, 4];

// `key` is the enum member name; `prop` is the property on the atts object.
// `axis` picks the factor: 'x' -> kx, 'y' -> ky.
//
// Deliberately absent, because they are RELATIVE and follow font size on their
// own - scaling them would double-apply:
//   glyph: characterSpacing, manualKerning (em-based)
//   para : relativeLeading, min/desired/max word + letter spacing (fractions)
var GLYPH_RULES = [
  { key: 'Height',          prop: 'height',          axis: 'y' },
  { key: 'BaselineAdvance', prop: 'baselineAdvance', axis: 'y' },
  { key: 'OffsetY',         prop: 'offsetY',         axis: 'y' },
  { key: 'OffsetX',         prop: 'offsetX',         axis: 'x' },
  { key: 'AbsoluteLeading', prop: 'absoluteLeading', axis: 'y', absoluteLeadingOnly: true }
];

var PARA_RULES = [
  { key: 'SpaceBefore',                 prop: 'spaceBefore',                 axis: 'y' },
  { key: 'SpaceAfter',                  prop: 'spaceAfter',                  axis: 'y' },
  { key: 'AbsoluteLeading',             prop: 'absoluteLeading',             axis: 'y', absoluteLeadingOnly: true },
  { key: 'LeftIndent',                  prop: 'leftIndent',                  axis: 'x' },
  { key: 'RightIndent',                 prop: 'rightIndent',                 axis: 'x' },
  { key: 'FirstLineIndent',             prop: 'firstLineIndent',             axis: 'x' },
  { key: 'LastLineOutdent',             prop: 'lastLineOutdent',             axis: 'x' },
  { key: 'DefaultTabStops',             prop: 'defaultTabStops',             axis: 'x' },
  { key: 'HyphenationZone',             prop: 'hyphenationZone',             axis: 'x' },
  { key: 'HyphenationZoneCapitals',     prop: 'hyphenationZoneCapitals',     axis: 'x' },
  { key: 'HyphenationZoneParagraphEnd', prop: 'hyphenationZoneParagraphEnd', axis: 'x' },
  { key: 'HyphenationZoneColumnEnd',    prop: 'hyphenationZoneColumnEnd',    axis: 'x' }
];

function usesAbsoluteLeading(paragraphAtts) {
  var lt = paragraphAtts && paragraphAtts.leadingType;
  var v = (lt && lt.value !== undefined) ? lt.value : lt;
  for (var i = 0; i < ABSOLUTE_LEADING_TYPES.length; i++)
    if (ABSOLUTE_LEADING_TYPES[i] === v) return true;
  return false;
}

function applyRules(rules, atts, paragraphAtts, kx, ky, scope, out) {
  var absLeading = usesAbsoluteLeading(paragraphAtts);
  for (var i = 0; i < rules.length; i++) {
    var r = rules[i];
    if (r.absoluteLeadingOnly && !absLeading) continue;
    var v = atts ? atts[r.prop] : undefined;
    if (typeof v !== 'number') continue;   // absent on this build
    if (v === 0) continue;                 // 0 * k = 0, no command worth issuing
    var k = (r.axis === 'x') ? kx : ky;
    out.push({ scope: scope, key: r.key, value: v * k });
  }
}

// Pure: describes what to write for one attribute run. No SDK objects, so this
// is testable against fabricated runs with no document open.
// Returns [{scope:'glyph'|'para', key:<enum member name>, value:<number>}]
function planRunDeltas(run, kx, ky) {
  var out = [];
  var g = run.glyphAtts, p = run.paragraphAtts;

  applyRules(GLYPH_RULES, g, p, kx, ky, 'glyph', out);
  applyRules(PARA_RULES, p, p, kx, ky, 'para', out);

  // Anamorphic type: height carries ky, ScaleX carries the remaining ratio.
  // Skipped when uniform - writing ScaleX = 1 is a no-op command.
  if (Math.abs(kx - ky) > 1e-6 && g && typeof g.scaleX === 'number') {
    out.push({ scope: 'glyph', key: 'ScaleX', value: g.scaleX * (kx / ky) });
  }
  return out;
}

// ---------------------------------------------------------------- document

// Resolve the selection into scale targets.
// Returns { nodes, frames, strokes, box } or null when unusable.
//
// `frames` holds only FRAME text nodes. Artistic text is deliberately excluded:
// createTransform already scales it, so compensating it would double-scale.
//
// `strokes` holds only nodes whose stroke Affinity will NOT scale, i.e.
// lineStyleDescriptor.isScale === false (the stroke panel's "Scale with object"
// unchecked). isScale === true strokes are scaled at render time from the node's
// transform, so touching them would double-scale.
function collectTargets(doc) {
  var nodesMod = require('/nodes');
  var sel = doc.selection;
  var nodes = [], boxes = [], frames = [], strokes = [];

  for (var n of sel.nodes) { nodes.push(n); }
  if (!nodes.length) return null;

  function considerText(node) {
    var isFrame = false;
    try { isFrame = !!node.isFrameTextNode; } catch (e) { return; }
    if (isFrame) frames.push(node);
  }

  function considerStroke(node) {
    var info = { weight: undefined, isScale: true, isLineStyleVisible: undefined, isNoFill: undefined };
    try { info.weight = node.lineWeight; } catch (e) { return; }
    try { info.isScale = !!node.lineStyleDescriptor.isScale; } catch (e) { return; }
    // Read via lineStyleInterface - node.isLineStyleVisible is undefined.
    try { info.isLineStyleVisible = node.lineStyleInterface.isLineStyleVisible; } catch (e) {}
    try { info.isNoFill = node.lineStyleInterface.isNoFill; } catch (e) {}
    if (strokeNeedsScaling(info)) strokes.push(node);
  }

  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    try { boxes.push(node.spreadBaseBox); } catch (e) {}
    considerText(node);
    considerStroke(node);
    try {
      var kids = nodesMod.getNodeChildrenRecursive(node.handle, nodesMod.NodeChildType.Main, false);
      for (var k of kids) { considerText(k); considerStroke(k); }
    } catch (e) {}
  }

  var box = unionBox(boxes);
  if (!box) return null;
  return { nodes: nodes, frames: frames, strokes: strokes, box: box };
}

// Scales one node's stroke to match the transform, for strokes Affinity skips.
//
// Limitation: lineStyleInterface exposes descriptorCount / getAllLineStyleDescriptors,
// so a node can in principle carry several strokes. This handles the current
// descriptor only - enough for every case observed so far (descriptorCount === 1).
function buildStrokeCommands(doc, node, factor) {
  var DocumentCommand = require('/commands').DocumentCommand;
  var Selection = require('/selections').Selection;

  // cloneScaled() returns a new descriptor and leaves the original alone.
  // It takes ONE factor - a second argument is ignored.
  var scaled = node.lineStyleDescriptor.cloneScaled(factor);
  return [DocumentCommand.createSetLineStyleDescriptor(Selection.create(doc, node), scaled)];
}

// Converts planRunDeltas() output into DocumentCommands for one frame.
function buildTextCommands(doc, frame, kx, ky) {
  var DocumentCommand = require('/commands').DocumentCommand;
  var sels = require('/selections');
  var StoryDelta = require('/storydelta').StoryDelta;
  var GlyphAttDoubleType = require('/glyphatts').GlyphAttDoubleType;
  var ParagraphAttDoubleType = require('/paragraphatts').ParagraphAttDoubleType;
  var StoryRange = require('affinity:story').StoryRange;

  var cmds = [];
  var story = frame.storyInterface.story;
  // getGlyphAttsRunEnd() returns 0 and cannot drive a walk - attRuns is the way.
  var runs = story.attRuns.toArray();

  for (var r = 0; r < runs.length; r++) {
    var run = runs[r];
    var plan = planRunDeltas(run, kx, ky);
    if (!plan.length) continue;

    for (var d = 0; d < plan.length; d++) {
      var item = plan[d];
      var delta;
      if (item.scope === 'glyph') {
        delta = StoryDelta.createGlyphDouble(GlyphAttDoubleType[item.key], item.value);
      } else {
        delta = StoryDelta.createParagraphDouble(ParagraphAttDoubleType[item.key], item.value);
      }
      // A fresh selection per delta - sub-selections are consumed by the command.
      var s = sels.Selection.create(doc, frame);
      s.addSubSelectionForNode(frame, sels.TextSelection.create(new StoryRange(run.begin, run.end)));
      cmds.push(DocumentCommand.createFormatText(s, delta));
    }
  }
  return cmds;
}

// ---------------------------------------------------------------- ui

// Returns { width, height, anchor } or null when cancelled.
function showDialog(doc, box) {
  var dialogMod = require('/dialog');
  var UnitType = require('/units').UnitType;

  // The editor's unit label is fixed at creation (units is read-only), so match
  // the document. Users can still type "2cm" and Affinity converts.
  var displayUnit = UnitType.Pixel;
  try {
    var u = String(doc.units).toLowerCase();
    if (u.indexOf('milli') === 0) displayUnit = UnitType.Millimetre;
    else if (u.indexOf('centi') === 0) displayUnit = UnitType.Centimetre;
    else if (u.indexOf('inch') === 0) displayUnit = UnitType.Inch;
  } catch (e) {}

  var dlg = dialogMod.Dialog.create('Scale With Text');
  dlg.initialWidth = 470;

  // Columns are the only horizontal unit, and they divide the dialog by
  // widthProportion (a ratio, not pixels). Tuning knob, measured over 470px:
  //   1:1:1:1   ~105px - grid sprawls
  //  12:1:1:1    ~32px - checkboxes clipped
  //   5:1:1:1    ~59px - boxes fine, "Anchor" title clipped
  //   4:1:1:1    ~67px - fits the title
  // A group title cannot render wider than its column, so the title clipping is
  // the readout for how narrow the column has become.
  var fieldsCol = dlg.addColumn();
  try { fieldsCol.widthProportion = 4; } catch (e) {}
  var grp = fieldsCol.addGroup('Target size');

  var wField = grp.addUnitValueEditor('Width', UnitType.Pixel, displayUnit, box.width, 0.01, 1000000);
  wField.value = box.width;      // SDK resets the value on creation otherwise
  var hField = grp.addUnitValueEditor('Height', UnitType.Pixel, displayUnit, box.height, 0.01, 1000000);
  hField.value = box.height;

  // Short label on purpose: "Lock aspect ratio" wraps to two lines at this
  // column width, and the group's height does not grow to fit the second line,
  // so it renders clipped.
  var lock = grp.addCheckBox('Lock ratio', true);

  // Off by default: on means overriding each object's own "Scale with object"
  // stroke setting.
  var scaleStrokes = grp.addCheckBox('Scale strokes', false);

  // 3x3 anchor grid: three columns of three checkboxes, added row by row so
  // the visual order is row-major and matches ANCHORS.
  var anchorGroups = [];
  for (var c = 0; c < 3; c++) {
    var col = dlg.addColumn();
    try { col.widthProportion = 1; } catch (e) {}
    anchorGroups.push(col.addGroup(c === 0 ? 'Anchor' : ' '));
  }
  var anchorBoxes = [];
  for (var r = 0; r < 3; r++) {
    for (var cc = 0; cc < 3; cc++) {
      anchorBoxes[r * 3 + cc] = anchorGroups[cc].addCheckBox('', r === 0 && cc === 0);
    }
  }

  // Checkboxes are not radio buttons - mutual exclusion is hand-rolled.
  var anchorIndex = 0;
  var anchorSyncing = false;   // programmatic writes fire handlers too

  function wireAnchor(idx) {
    anchorBoxes[idx].onValueChangedHandler = function () {
      if (anchorSyncing) return;
      anchorSyncing = true;
      if (anchorBoxes[idx].value) {
        anchorIndex = idx;
        for (var i = 0; i < 9; i++) if (i !== idx) anchorBoxes[i].value = false;
      } else {
        anchorBoxes[idx].value = true;   // refuse to leave nothing selected
      }
      anchorSyncing = false;
    };
  }
  for (var a = 0; a < 9; a++) wireAnchor(a);

  var ratio = box.height / box.width;
  var syncing = false;   // stops the two handlers ping-ponging each other

  wField.onValueChangedHandler = function () {
    if (syncing || !lock.value) return;
    syncing = true;
    hField.value = wField.value * ratio;
    syncing = false;
  };
  hField.onValueChangedHandler = function () {
    if (syncing || !lock.value) return;
    syncing = true;
    wField.value = hField.value / ratio;
    syncing = false;
  };

  var res = dlg.runModal();
  var Ok = dialogMod.DialogResult.Ok;
  var ok = (res === Ok) || (res && res.value !== undefined && Ok && res.value === Ok.value);
  if (!ok) return null;

  return {
    width: wField.value,
    height: hField.value,
    anchor: anchorIndex,
    scaleStrokes: !!scaleStrokes.value
  };
}

// ---------------------------------------------------------------- selftest

function runSelfTests() {
  console.log('#### scale_with_text selftest ####');

  console.log('-- unionBox --');
  var b1 = { x: 10, y: 20, width: 30, height: 40 };
  var b2 = { x: 50, y: 10, width: 10, height: 10 };

  var u1 = unionBox([b1]);
  assertClose('single box x', u1.x, 10);
  assertClose('single box width', u1.width, 30);

  var u2 = unionBox([b1, b2]);
  assertClose('union x', u2.x, 10);
  assertClose('union y', u2.y, 10);
  assertClose('union width', u2.width, 50);   // 10..60
  assertClose('union height', u2.height, 50); // 10..60

  assert('empty returns null', unionBox([]) === null);

  console.log('-- anchorPoint --');
  var box = { x: 100, y: 200, width: 40, height: 60 };

  assertEqual('anchor count', ANCHORS.length, 9);
  assertEqual('default label', ANCHORS[0].label, 'Top Left');

  var tl = anchorPoint(box, 0);
  assertClose('top-left x', tl.x, 100);
  assertClose('top-left y', tl.y, 200);

  var c = anchorPoint(box, 4);
  assertClose('centre x', c.x, 120);
  assertClose('centre y', c.y, 230);

  var br = anchorPoint(box, 8);
  assertClose('bottom-right x', br.x, 140);
  assertClose('bottom-right y', br.y, 260);

  console.log('-- scaleFactors --');
  var bx = { x: 0, y: 0, width: 200, height: 100 };

  var f1 = scaleFactors(bx, 400, 100, false);
  assertClose('unlocked kx', f1.kx, 2);
  assertClose('unlocked ky', f1.ky, 1);

  var f2 = scaleFactors(bx, 400, 100, true);
  assertClose('locked kx', f2.kx, 2);
  assertClose('locked ky follows width', f2.ky, 2);

  var f3 = scaleFactors(bx, 200, 100, false);
  assert('no-op detected', isNoOp(f3));

  var f4 = scaleFactors(bx, 100, 100, false);
  assert('real change not a no-op', !isNoOp(f4));

  console.log('-- strokeFactor --');
  // Expected values measured from LineStyleDescriptor.effectiveWeight().
  assertClose('uniform 2x', strokeFactor(2, 2), 2, 1e-4);
  assertClose('uniform 0.5x', strokeFactor(0.5, 0.5), 0.5, 1e-4);
  assertClose('2,1 -> sqrt(2.5)', strokeFactor(2, 1), 1.5811, 1e-4);
  assertClose('2,4 -> sqrt(10)', strokeFactor(2, 4), 3.1623, 1e-4);
  assertClose('symmetric in kx/ky', strokeFactor(1, 2), strokeFactor(2, 1), 1e-9);
  assertClose('identity stays 1', strokeFactor(1, 1), 1, 1e-9);
  // Must NOT be the geometric mean - that would give 1.4142 for (2,1).
  assert('not sqrt(kx*ky)', Math.abs(strokeFactor(2, 1) - Math.sqrt(2)) > 0.1);

  console.log('-- strokeNeedsScaling --');
  // Values taken from a real document via probes/probe_stroke_bug.js.

  // A genuinely stroked shape whose stroke Affinity will not scale.
  assert('visible stroke, isScale false -> scale it', strokeNeedsScaling(
    { weight: 5, isScale: false, isLineStyleVisible: true, isNoFill: false }) === true);

  // Affinity scales this one at render time already.
  assert('visible stroke, isScale true -> skip', strokeNeedsScaling(
    { weight: 2.98, isScale: true, isLineStyleVisible: true, isNoFill: false }) === false);

  // THE BUG: a shape with NO stroke still reports a stored lineWeight.
  // Writing a line style descriptor to it materialises a stroke out of nowhere,
  // dash pattern and all.
  assert('no stroke colour -> skip (isNoFill)', strokeNeedsScaling(
    { weight: 4.17, isScale: false, isLineStyleVisible: false, isNoFill: true }) === false);
  assert('no stroke colour -> skip (not visible)', strokeNeedsScaling(
    { weight: 4, isScale: false, isLineStyleVisible: false, isNoFill: true }) === false);

  assert('zero weight -> skip', strokeNeedsScaling(
    { weight: 0, isScale: false, isLineStyleVisible: false, isNoFill: true }) === false);
  assert('missing weight -> skip', strokeNeedsScaling(
    { weight: undefined, isScale: false, isLineStyleVisible: true, isNoFill: false }) === false);

  // Tolerate a node type that does not expose isNoFill: visible is enough.
  assert('undefined isNoFill tolerated', strokeNeedsScaling(
    { weight: 5, isScale: false, isLineStyleVisible: true, isNoFill: undefined }) === true);

  console.log('-- buildAnchoredScale --');
  // Transform.data is row-major 2x3 [a, b, tx, c, d, ty].
  // Non-uniform factors on purpose: with kx === ky an axis swap is invisible.
  var sbox = { x: 400, y: 170, width: 1000, height: 800 };
  var xf = buildAnchoredScale(sbox, 2, 3, 0);   // anchor top-left
  var d = xf.data;
  assertClose('matrix a (kx)', d[0], 2, 1e-4);
  assertClose('matrix b', d[1], 0, 1e-4);
  assertClose('matrix tx', d[2], 400 * (1 - 2), 1e-4);
  assertClose('matrix c', d[3], 0, 1e-4);
  assertClose('matrix d (ky)', d[4], 3, 1e-4);
  assertClose('matrix ty', d[5], 170 * (1 - 3), 1e-4);

  // The anchor must map to itself.
  var Point = require('/geometry').Point;
  var moved = xf.applyToPoint(new Point(400, 170));
  assertClose('anchor x fixed', moved.x, 400, 1e-4);
  assertClose('anchor y fixed', moved.y, 170, 1e-4);

  // Centre anchor: the centre must map to itself.
  var xf2 = buildAnchoredScale(sbox, 2, 2, 4);
  var ctr = xf2.applyToPoint(new Point(900, 570));
  assertClose('centre x fixed', ctr.x, 900, 1e-4);
  assertClose('centre y fixed', ctr.y, 570, 1e-4);

  console.log('-- planRunDeltas --');

  // Shaped like a real run, with values taken from probe_text_scale output.
  function fakeRun(glyphOverrides, paraOverrides) {
    var g = { height: 18, absoluteLeading: 0, characterSpacing: 0, manualKerning: 0,
              baselineAdvance: 0, offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };
    var p = { absoluteLeading: 0, relativeLeading: 1, spaceBefore: 0, spaceAfter: 12,
              firstLineIndent: 0, leftIndent: 0, rightIndent: 0, lastLineOutdent: 0,
              defaultTabStops: 36, hyphenationZone: 0,
              leadingType: { value: 0 } };
    var kk;
    for (kk in (glyphOverrides || {})) g[kk] = glyphOverrides[kk];
    for (kk in (paraOverrides || {})) p[kk] = paraOverrides[kk];
    return { begin: 0, end: 10, glyphAtts: g, paragraphAtts: p };
  }

  function findDelta(list, scope, key) {
    for (var i = 0; i < list.length; i++)
      if (list[i].scope === scope && list[i].key === key) return list[i];
    return null;
  }

  // Uniform 2x
  var plan = planRunDeltas(fakeRun(), 2, 2);
  assertClose('height doubled', findDelta(plan, 'glyph', 'Height').value, 36);
  assertClose('spaceAfter doubled', findDelta(plan, 'para', 'SpaceAfter').value, 24);
  assertClose('tab stops doubled', findDelta(plan, 'para', 'DefaultTabStops').value, 72);

  // Relative attributes must be left alone - they follow font size already.
  assert('relativeLeading untouched', findDelta(plan, 'para', 'RelativeLeading') === null);
  assert('characterSpacing untouched', findDelta(plan, 'glyph', 'CharacterSpacing') === null);
  assert('manualKerning untouched', findDelta(plan, 'glyph', 'ManualKerning') === null);

  // Zero-valued attributes produce no command.
  assert('zero spaceBefore skipped', findDelta(plan, 'para', 'SpaceBefore') === null);
  assert('zero offsetX skipped', findDelta(plan, 'glyph', 'OffsetX') === null);

  // absoluteLeading only when the paragraph is actually in an absolute mode.
  var relPlan = planRunDeltas(fakeRun({ absoluteLeading: 20 }, { leadingType: { value: 0 } }), 2, 2);
  assert('absLeading skipped in relative mode', findDelta(relPlan, 'glyph', 'AbsoluteLeading') === null);

  var absPlan = planRunDeltas(fakeRun({ absoluteLeading: 20 }, { leadingType: { value: 2 } }), 2, 2);
  assertClose('absLeading scaled in absolute mode',
              findDelta(absPlan, 'glyph', 'AbsoluteLeading').value, 40);

  // Uniform scaling must not write ScaleX.
  assert('no ScaleX when uniform', findDelta(plan, 'glyph', 'ScaleX') === null);

  // Non-uniform: height follows ky, ScaleX carries the difference.
  var aniso = planRunDeltas(fakeRun(), 2, 4);
  assertClose('aniso height uses ky', findDelta(aniso, 'glyph', 'Height').value, 72);
  assertClose('aniso ScaleX = kx/ky', findDelta(aniso, 'glyph', 'ScaleX').value, 0.5);

  // Horizontal attributes use kx, vertical use ky.
  var axes = planRunDeltas(fakeRun({ offsetX: 10, offsetY: 10 }), 2, 4);
  assertClose('offsetX uses kx', findDelta(axes, 'glyph', 'OffsetX').value, 20);
  assertClose('offsetY uses ky', findDelta(axes, 'glyph', 'OffsetY').value, 40);
}

// ---------------------------------------------------------------- entry

function main() {
  var app = require('/application').app;
  var doc = app.documents.current;
  if (!doc) { app.alert('No document open.', 'Scale With Text'); return; }

  var t = collectTargets(doc);
  if (!t) { app.alert('Select one or more objects.', 'Scale With Text'); return; }
  if (t.box.width <= 0 || t.box.height <= 0) {
    app.alert('Selection has no measurable size.', 'Scale With Text'); return;
  }

  var input = showDialog(doc, t.box);
  if (!input) return;                       // cancelled
  if (input.width <= 0 || input.height <= 0) {
    app.alert('Width and height must be greater than zero.', 'Scale With Text'); return;
  }

  // lockRatio=false: the dialog already reconciled the two fields, so both
  // values are authoritative here. Re-deriving height would discard a
  // deliberately unlocked entry.
  var f = scaleFactors(t.box, input.width, input.height, false);
  if (isNoOp(f)) { console.log('nothing to do'); return; }

  var cmdsMod = require('/commands');
  var Selection = require('/selections').Selection;
  var builder = cmdsMod.CompoundCommandBuilder.create();

  var sel = Selection.createEmpty(doc);
  for (var i = 0; i < t.nodes.length; i++) sel.add(t.nodes[i]);
  builder.addCommand(cmdsMod.DocumentCommand.createTransform(
    sel, buildAnchoredScale(t.box, f.kx, f.ky, input.anchor)));

  var skipped = 0, deltaCount = 0;
  for (var fr = 0; fr < t.frames.length; fr++) {
    try {
      var fc = buildTextCommands(doc, t.frames[fr], f.kx, f.ky);
      for (var c = 0; c < fc.length; c++) builder.addCommand(fc[c]);
      deltaCount += fc.length;
    } catch (e) {
      skipped++;
      console.log('skipped a text frame: ' + (e && e.message ? e.message : e));
    }
  }

  var strokeCount = 0;
  if (input.scaleStrokes) {
    var sf = strokeFactor(f.kx, f.ky);
    for (var st = 0; st < t.strokes.length; st++) {
      try {
        var sc = buildStrokeCommands(doc, t.strokes[st], sf);
        for (var q = 0; q < sc.length; q++) builder.addCommand(sc[q]);
        strokeCount += sc.length;
      } catch (e) {
        console.log('skipped a stroke: ' + (e && e.message ? e.message : e));
      }
    }
    console.log('stroke factor ' + sf.toFixed(4) + ' applied to ' + strokeCount + ' stroke(s)');
  }

  doc.executeCommand(builder.createCommand());

  console.log('scaled ' + t.nodes.length + ' object(s) by kx=' + f.kx.toFixed(4) +
              ' ky=' + f.ky.toFixed(4) + ' about "' + ANCHORS[input.anchor].label + '"');
  console.log('compensated ' + t.frames.length + ' frame(s), ' + deltaCount + ' delta(s)');
  if (skipped) {
    app.alert(skipped + ' text frame(s) could not be scaled. See the console.', 'Scale With Text');
  }
}

try {
  if (SELFTEST) { runSelfTests(); reportTests(); }
  else { main(); }
} catch (err) {
  console.log('ERROR: ' + (err && err.message ? err.message : err));
  console.log('stack: ' + (err && err.stack ? err.stack : '(none)'));
  try {
    require('/application').app.alert(String(err && err.message ? err.message : err), 'Scale With Text');
  } catch (e) {}
}
