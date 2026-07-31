'use strict';
// ============================================================
// Dimension Annotator v1
//
// Adds real world measurements to your selected objects, like
// the dimension lines on an architect's drawing.
//
// Select objects, run, enter your scale (e.g. 1:50) and click
// OK. Box mode measures width and height, Per edge mode
// measures every straight edge of the shape.
// ============================================================
const { Document } = require('/document');
const nodesMod = require('/nodes');
const { CurveBuilder, PolyCurve, Polygon, Transform } = require('/geometry');
const { FillDescriptor } = require('/fills');
const { LineStyle, LineStyleDescriptor, ArrowHead, ArrowHeadStyle, LineCap, LineJoin, StrokeAlignment } = require('/linestyle');
const { Colour } = require('/colours');
const { StoryBuilder } = require('/storybuilder');
const { Selection } = require('/selections');
const { DocumentCommand, CompoundCommandBuilder, AddChildNodesCommandBuilder, NodeMoveType } = require('/commands');
const { UnitType } = require('/units');
const { Dialog, DialogResult } = require('/dialog');

const TAG_SCALE = 'dimAnnotator.scale';

const doc = Document.current;
if (!doc) { console.log('No open document.'); } else {

const spread = doc.currentSpread;
const selNodes = [...doc.selection.nodes].filter(n => !(n.userDescription || '').startsWith('Dim '));

if (selNodes.length === 0) {
  const d = Dialog.create('Dimension Annotator');
  d.addColumn().addGroup('').addStaticText('', 'Select one or more objects first, then run the script.').setIsFullWidth(true);
  d.runModal();
  console.log('No selection - aborted.');
} else {

// ---- remembered scale (tag on a previous Dimensions layer) ----
function findRememberedScale(root, depth) {
  for (const c of root.children) {
    try { if (c.tagInterface && c.tagInterface.hasKey(TAG_SCALE)) return c.tagInterface.getValueForKey(TAG_SCALE); } catch (e) {}
    if (depth > 0) { try { const r = findRememberedScale(c, depth - 1); if (r) return r; } catch (e) {} }
  }
  return null;
}
const remembered = findRememberedScale(spread, 2);

// ---------------- Dialog ----------------
const dlg = Dialog.create('Dimension Annotator');
dlg.initialWidth = 380;
const col = dlg.addColumn();

const gScale = col.addGroup('Scale');
const cScale = gScale.addTextBox('Scale', remembered || '1:50');
gScale.addStaticText('', remembered ? 'Remembered from this document.' : 'e.g. 1:50 = 1 cm on page is 50 cm real').setIsFullWidth(true);
const cUnit = gScale.addComboBox('Show as', ['Auto (metric)', 'mm', 'cm', 'm', 'in', 'ft'], 0);
const cDp = gScale.addUnitValueEditor('Decimals', UnitType.Number, UnitType.Number, 2, 0, 4);

const gDims = col.addGroup('Dimensions');
const cMode = gDims.addComboBox('Mode', ['Box (width/height)', 'Per edge (straight edges)'], 0);
const cW = gDims.addCheckBox('Width', true);
const cWSide = gDims.addComboBox('Width side', ['Below', 'Above'], 0);
const cH = gDims.addCheckBox('Height', true);
const cHSide = gDims.addComboBox('Height side', ['Right', 'Left'], 0);
const cMinEdge = gDims.addUnitValueEditor('Min edge (px)', UnitType.Number, UnitType.Number, 20, 2, 500);
const cOff = gDims.addUnitValueEditor('Offset (px)', UnitType.Number, UnitType.Number, 40, 8, 300);
const cTxt = gDims.addUnitValueEditor('Text size', UnitType.Number, UnitType.Number, 14, 6, 72);
const cWit = gDims.addCheckBox('Witness lines', true);

const gStyle = col.addGroup('Style');
const cStroke = gStyle.addUnitValueEditor('Line width (pt)', UnitType.Number, UnitType.Number, 1.25, 0.25, 10);
const cCol = gStyle.addColourPicker('Colour', Colour.createRGBA8(0, 0, 0, 255));
cCol.value = Colour.createRGBA8(0, 0, 0, 255);   // picker mishandles non-grey initials, set explicitly
const cArrow = gStyle.addComboBox('Ends', ['Bar', 'Tick (oblique)', 'Triangle', 'None'], 0);

const gHelp = col.addGroup('How to use');
gHelp.addStaticText('', 'Select objects, set your scale (e.g. 1:50) and click OK.').setIsFullWidth(true);
gHelp.addStaticText('', 'Box mode measures width and height. Per edge measures every straight edge.').setIsFullWidth(true);
gHelp.addStaticText('', ' ').setIsFullWidth(true);

function syncMode() {
  const box = cMode.selectedIndex === 0;
  cW.isEnabled = box; cH.isEnabled = box;
  cWSide.isEnabled = box && cW.value; cHSide.isEnabled = box && cH.value;
  cMinEdge.isEnabled = !box;
}
cMode.setOnValueChangedHandler(syncMode);
cW.setOnValueChangedHandler(syncMode);
cH.setOnValueChangedHandler(syncMode);
syncMode();

if (dlg.runModal() !== DialogResult.Ok) {
  console.log('Cancelled.');
} else {

// ---------------- Read options ----------------
const m = String(cScale.text || '').match(/^\s*(\d+(?:\.\d+)?)\s*[:\/]\s*(\d+(?:\.\d+)?)\s*$/);
if (!m || Number(m[1]) <= 0) {
  const d = Dialog.create('Dimension Annotator');
  d.addColumn().addGroup('').addStaticText('', 'Could not read the scale. Use the form N:M, e.g. 1:50 or 2:1.').setIsFullWidth(true);
  d.runModal();
  console.log('Bad scale string: ' + cScale.text);
} else {
const opts = {
  scaleStr: m[1] + ':' + m[2],
  ratio: Number(m[2]) / Number(m[1]),
  unitMode: ['auto', 'mm', 'cm', 'm', 'in', 'ft'][cUnit.selectedIndex],
  dp: Math.round(cDp.value),
  perEdge: cMode.selectedIndex === 1,
  minEdge: cMinEdge.value,
  width: cW.value, widthSide: cWSide.selectedIndex === 0 ? 'below' : 'above',
  height: cH.value, heightSide: cHSide.selectedIndex === 0 ? 'right' : 'left',
  offset: cOff.value, textPt: cTxt.value,
  witness: cWit.value,
  stroke: cStroke.value,
  colour: cCol.value || Colour.createRGBA8(0, 0, 0, 255),
  arrowStyle: [ArrowHeadStyle.Bar.value, ArrowHeadStyle.Oblique.value, ArrowHeadStyle.Triangle.value, null][cArrow.selectedIndex]
};

// ---------------- maths ----------------
const I = [1,0,0,0,1,0];
const mul = (a,b) => [a[0]*b[0]+a[1]*b[3], a[0]*b[1]+a[1]*b[4], a[0]*b[2]+a[1]*b[5]+a[2],
                      a[3]*b[0]+a[4]*b[3], a[3]*b[1]+a[4]*b[4], a[3]*b[2]+a[4]*b[5]+a[5]];
const apply = (mx,p) => ({ x: mx[0]*p.x + mx[1]*p.y + mx[2], y: mx[3]*p.x + mx[4]*p.y + mx[5] });
const toArr = d => [d[0],d[1],d[2],d[3],d[4],d[5]];
const sub = (a,b)=>({x:a.x-b.x,y:a.y-b.y});
const add = (a,b)=>({x:a.x+b.x,y:a.y+b.y});
const scl = (a,s)=>({x:a.x*s,y:a.y*s});
const vlen = a=>Math.hypot(a.x,a.y);
const norm = a=>{const l=vlen(a);return l>1e-9?scl(a,1/l):{x:1,y:0};};
const dot = (a,b)=>a.x*b.x+a.y*b.y;
const perp = a=>({x:-a.y,y:a.x});

function composeWorld(node) {
  let M = I, cur = node;
  while (cur && !cur.isSpreadNode) {
    try { const ti = cur.transformInterface; if (ti) M = mul(toArr(ti.transform.data), M); } catch (e) {}
    cur = cur.parent;
  }
  return M;
}

function cornersOf(n) {
  try {
    const lb = n.artboardBaseBox;
    if (lb && lb.width != null && n.transformInterface) {
      const M = composeWorld(n);
      return [apply(M,{x:lb.x,y:lb.y}), apply(M,{x:lb.x+lb.width,y:lb.y}),
              apply(M,{x:lb.x+lb.width,y:lb.y+lb.height}), apply(M,{x:lb.x,y:lb.y+lb.height})];
    }
  } catch (e) {}
  try {
    const b = n.spreadVisibleBox;
    if (b && b.width != null)
      return [{x:b.x,y:b.y},{x:b.x+b.width,y:b.y},{x:b.x+b.width,y:b.y+b.height},{x:b.x,y:b.y+b.height}];
  } catch (e) {}
  return null;
}

// ---- per-edge extraction: greedy direction-coherent straight runs (world-space points) ----
function extractEdges(pts, closed, minEdge, straightTol) {
  const P = [];
  for (const p of pts) if (!P.length || Math.hypot(p.x-P[P.length-1].x, p.y-P[P.length-1].y) > 1e-6) P.push(p);
  if (closed && P.length > 1 && Math.hypot(P[0].x-P[P.length-1].x, P[0].y-P[P.length-1].y) < 1e-6) P.pop();
  const n = P.length;
  if (n < 2) return [];
  const idx = i => ((i % n) + n) % n;
  const segDir = i => { const d = sub(P[idx(i+1)], P[i]); const l = vlen(d); return l > 1e-9 ? {x:d.x/l, y:d.y/l} : {x:1,y:0}; };
  const ANG = Math.cos(5 * Math.PI/180);
  const segCount = closed ? n : n - 1;

  let start = 0;
  if (closed) {
    let found = false;
    for (let i = 0; i < n; i++) {
      const d0 = segDir(idx(i-1)), d1 = segDir(i);
      if (dot(d0, d1) < ANG) { start = i; found = true; break; }
    }
    if (!found) return [];
  }

  const edges = [];
  let s = 0;
  while (s < segCount) {
    const i0 = closed ? idx(start + s) : s;
    const dir0 = segDir(i0);
    let e = s;
    while (e + 1 < segCount) {
      const dn = segDir(closed ? idx(start + e + 1) : e + 1);
      if (dot(dn, dir0) < ANG) break;
      e++;
    }
    const A = P[i0], B = P[closed ? idx(start + e + 1) : e + 1];
    const chord = sub(B, A), L = vlen(chord);
    if (L >= minEdge) {
      const dir = {x: chord.x/L, y: chord.y/L};
      let maxDev = 0;
      for (let k = s + 1; k <= e; k++) {
        const v = sub(P[closed ? idx(start + k) : k], A);
        maxDev = Math.max(maxDev, Math.abs(v.x*(-dir.y) + v.y*dir.x));
      }
      if (maxDev <= straightTol) edges.push({ A, B });
    }
    s = e + 1;
  }
  return edges;
}

function contoursOf(node) {
  let ci = null;
  try { ci = node.curvesInterface; } catch (e) {}
  if (!ci) return null;
  let pcv = null;
  try { pcv = ci.polyCurve; } catch (e) {}
  if (!pcv || !pcv.curveCount) return null;
  const M = composeWorld(node);
  const out = [];
  for (let c = 0; c < pcv.curveCount; c++) {
    try {
      const poly = new Polygon(pcv.at(c).generatePolygon(1.0));
      if (!(poly.pointCount >= 2)) continue;
      const pts = [];
      for (let i = 0; i < poly.pointCount; i++) pts.push(apply(M, poly.getPoint(i)));
      out.push({ pts, closed: !!poly.isClosed });
    } catch (e) {}
  }
  return out.length ? out : null;
}

function findByNameDeep(root, name) {
  for (const c of root.children) {
    if ((c.userDescription || '') === name) return c;
    try { const r = findByNameDeep(c, name); if (r) return r; } catch (e) {}
  }
  return null;
}

// ---------------- formatting ----------------
const pxToMm = doc.unitValueConverter.getConversionFactor(UnitType.Pixel, UnitType.Millimetre);
const trimZeros = s => s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
function fmt(px) {
  const mm = px * pxToMm * opts.ratio;
  let val, unit;
  switch (opts.unitMode) {
    case 'mm': val = mm; unit = 'mm'; break;
    case 'cm': val = mm / 10; unit = 'cm'; break;
    case 'm':  val = mm / 1000; unit = 'm'; break;
    case 'in': val = mm / 25.4; unit = 'in'; break;
    case 'ft': val = mm / 304.8; unit = 'ft'; break;
    default:
      if (mm >= 1000) { val = mm / 1000; unit = 'm'; }
      else if (mm >= 10) { val = mm / 10; unit = 'cm'; }
      else { val = mm; unit = 'mm'; }
  }
  return trimZeros(val.toFixed(opts.dp)) + ' ' + unit;
}

// ---------------- node factories ----------------
function makeLine(pts) {
  const b = CurveBuilder.create();
  b.begin(pts[0]);
  for (let i = 1; i < pts.length; i++) b.lineToXY(pts[i].x, pts[i].y);
  const pc = PolyCurve.create(); pc.addCurve(b.createCurve()); return pc;
}
const strokeFill = () => FillDescriptor.createSolid(opts.colour);
const noBrush = () => FillDescriptor.createNone();
const noneT = () => FillDescriptor.createNone();

function dimLineDef(p0, p1) {
  const ls = LineStyle.createDefaultWithWeight(opts.stroke);
  ls.cap = LineCap.Butt; ls.join = LineJoin.Mitre;
  let lsd = LineStyleDescriptor.create(ls, { strokeAlignment: StrokeAlignment.Centre });
  if (opts.arrowStyle != null) {
    const as = Math.max(2.5, Math.min(5, opts.textPt / 3));   // ends sized relative to text (engine clamps scale at 5)
    const a = ArrowHead.create(opts.arrowStyle, { scaleX: as, scaleY: as });
    a.isSolidLine = true;   // line-type heads (Bar, Oblique) are invisible without this
    lsd = lsd.cloneWithNewArrowHeads(a, a);   // create()'s frontArrow/backArrow options are silently dropped - this is the only route that attaches
  }
  const def = nodesMod.PolyCurveNodeDefinition.create(makeLine([p0, p1]), noBrush(), lsd, strokeFill(), noneT());
  def.userDescription = 'Dim line';
  return def;
}
function extLineDef(p0, p1) {
  const def = nodesMod.PolyCurveNodeDefinition.create(makeLine([p0, p1]), noBrush(), LineStyleDescriptor.createDefault(Math.max(0.3, opts.stroke * 0.5)), strokeFill(), noneT());
  def.userDescription = 'Dim witness';
  return def;
}
function labelDef(text, pos) {
  const sb = StoryBuilder.create();
  sb.setToArtisticTextDefaultStyle(doc.dpi, doc.format);
  const ga = sb.glyphAtts;
  ga.height = opts.textPt;
  ga.brushFill = FillDescriptor.createSolid(opts.colour);
  sb.setGlyphAtts(ga);
  sb.addText(text);
  const def = nodesMod.ArtTextNodeDefinition.createFromStoryBuilder(pos, sb);
  def.userDescription = 'Dim ' + text;
  return def;
}

// ---------------- build ----------------
const runId = 'DIMRUN' + Date.now().toString(36) + Math.floor(Math.random() * 1e4);
doc.addNode(nodesMod.ContainerNodeDefinition.create(runId), null, undefined, false);
const container = findByNameDeep(spread, runId);

const builder = AddChildNodesCommandBuilder.create();
if (container) builder.setInsertionTarget(container);
const labels = [];
const objRanges = [];   // { name, from, to } indices into the flat created-node sequence
let createdCount = 0;
const gap = 5, over = 0, labelGap = 6;   // over=0: extension lines stop at the dimension line, no overshoot
let skipped = 0, boxFallback = 0;

function annotateEdge(A, B, C) {
  let dir = norm(sub(B, A));
  if (dir.x < -1e-6 || (Math.abs(dir.x) <= 1e-6 && dir.y > 0)) { const t = A; A = B; B = t; dir = scl(dir, -1); }
  const mid = scl(add(A, B), 0.5);
  let n = perp(dir);
  if (dot(n, sub(mid, C)) < 0) n = scl(n, -1);
  const L = vlen(sub(B, A));
  if (L < 1e-6) return;
  builder.addNode(dimLineDef(add(A, scl(n, opts.offset)), add(B, scl(n, opts.offset))));
  if (opts.witness) {
    builder.addNode(extLineDef(add(A, scl(n, gap)), add(A, scl(n, opts.offset + over))));
    builder.addNode(extLineDef(add(B, scl(n, gap)), add(B, scl(n, opts.offset + over))));
    createdCount += 2;
  }
  const lineMid = add(mid, scl(n, opts.offset));
  builder.addNode(labelDef(fmt(L), lineMid));
  createdCount += 2;
  labels.push({ lineMid, n, dir, rot: Math.atan2(dir.y, dir.x) });
}

function annotateBox(node) {
  const c = cornersOf(node);
  if (!c) { skipped++; return; }
  const C = scl(add(add(c[0], c[1]), add(c[2], c[3])), 0.25);
  if (opts.perEdge || opts.width)
    annotateEdge(opts.widthSide === 'below' ? c[3] : c[0], opts.widthSide === 'below' ? c[2] : c[1], C);
  if (opts.perEdge || opts.height)
    annotateEdge(opts.heightSide === 'right' ? c[1] : c[0], opts.heightSide === 'right' ? c[2] : c[3], C);
}

let objIndex = 0;
for (const node of selNodes) {
  objIndex++;
  const from = createdCount;
  if (opts.perEdge) {
    const contours = contoursOf(node);
    if (!contours) { boxFallback++; annotateBox(node); }
    else {
      let any = false;
      for (const ct of contours) {
        const edges = extractEdges(ct.pts, ct.closed, opts.minEdge, 1.5);
        if (!edges.length) continue;
        let cx = 0, cy = 0;
        for (const p of ct.pts) { cx += p.x; cy += p.y; }
        const C = { x: cx / ct.pts.length, y: cy / ct.pts.length };
        for (const e of edges) { annotateEdge(e.A, e.B, C); any = true; }
      }
      if (!any) skipped++;
    }
  } else {
    annotateBox(node);
  }
  if (createdCount > from) {
    const nm = (node.userDescription || '').trim();
    objRanges.push({ name: 'Dim - ' + (nm || ('Object ' + objIndex)), from, to: createdCount });
  }
}

if (labels.length === 0) {
  console.log('Nothing measurable in selection (' + skipped + ' skipped).');
  if (container) doc.executeCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, container)));
} else {
  doc.executeCommand(builder.createCommand(true, nodesMod.NodeChildType.Main));

  // ---- position/rotate labels with collision avoidance (positional capture) ----
  const pool = container ? [...container.children] : [...spread.children];
  const textNodes = pool.filter(nn => { try { return nn.isArtTextNode; } catch (e) { return false; } });
  const placed = [];
  const cb = CompoundCommandBuilder.create();
  for (let i = 0; i < labels.length && i < textNodes.length; i++) {
    const L = labels[i], nnode = textNodes[i];
    const b2 = nnode.artboardSpreadBaseBox;
    const w = b2.width, h = b2.height;
    const cx = b2.x + b2.width / 2, cy = b2.y + b2.height / 2;
    const cosA = Math.abs(Math.cos(L.rot)), sinA = Math.abs(Math.sin(L.rot));
    const hw = (w * cosA + h * sinA) / 2, hh = (w * sinA + h * cosA) / 2;
    const dIn = scl(L.n, -(labelGap + h / 2));
    const dOut = scl(L.n, labelGap + h / 2);
    const cands = [dIn, dOut];
    for (const base of [dIn, dOut])
      for (const slide of [0.75, -0.75, 1.5, -1.5])
        cands.push(add(base, scl(L.dir, w * slide)));
    let target = add(L.lineMid, dIn);
    for (const c of cands) {
      const t = add(L.lineMid, c);
      let clash = false;
      for (const r of placed)
        if (Math.abs(t.x - r.x) < hw + r.hw && Math.abs(t.y - r.y) < hh + r.hh) { clash = true; break; }
      if (!clash) { target = t; break; }
    }
    placed.push({ x: target.x, y: target.y, hw, hh });
    let xf = Transform.createTranslate(target.x - cx, target.y - cy);
    if (Math.abs(L.rot) > 1e-6) xf = xf.multiply(Transform.createRotate(L.rot).around(cx, cy));
    cb.addCommand(DocumentCommand.createTransform(Selection.create(doc, nnode), xf, { mergeable: false }));
  }
  doc.executeCommand(cb.createCommand());

  // ---- group per object: sub-container per source object inside the run layer ----
  const flat = container ? [...container.children] : [];
  if (container && objRanges.length) {
    const gb = AddChildNodesCommandBuilder.create();
    gb.setInsertionTarget(container);
    const temps = [];
    for (let g = 0; g < objRanges.length; g++) {
      const tn = runId + '_G' + g;
      temps.push(tn);
      gb.addContainerNode(nodesMod.ContainerNodeDefinition.create(tn));
    }
    doc.executeCommand(gb.createCommand(true, nodesMod.NodeChildType.Main));
    const rb = CompoundCommandBuilder.create();
    for (let g = 0; g < objRanges.length; g++) {
      const sc = findByNameDeep(container, temps[g]);
      if (!sc) continue;
      const members = flat.slice(objRanges[g].from, objRanges[g].to);
      if (members.length)
        doc.executeCommand(DocumentCommand.createMoveNodes(Selection.create(doc, members), sc, NodeMoveType.Inside, nodesMod.NodeChildType.Main));
      rb.addCommand(DocumentCommand.createSetDescription(Selection.create(doc, sc), objRanges[g].name));
    }
    rb.addCommand(DocumentCommand.createSetDescription(Selection.create(doc, container), 'Dimensions ' + opts.scaleStr));
    rb.addCommand(DocumentCommand.createSetTagValueForKey(Selection.create(doc, container), TAG_SCALE, opts.scaleStr));
    doc.executeCommand(rb.createCommand());
  } else if (container) {
    const rb = CompoundCommandBuilder.create();
    rb.addCommand(DocumentCommand.createSetDescription(Selection.create(doc, container), 'Dimensions ' + opts.scaleStr));
    rb.addCommand(DocumentCommand.createSetTagValueForKey(Selection.create(doc, container), TAG_SCALE, opts.scaleStr));
    doc.executeCommand(rb.createCommand());
  }

  console.log('Annotated ' + (selNodes.length - skipped) + ' object(s) in ' + objRanges.length + ' group(s), scale ' + opts.scaleStr + ', ' + labels.length + ' dimension(s)'
    + (skipped ? ', ' + skipped + ' skipped' : '') + (boxFallback ? ', ' + boxFallback + ' box fallback' : '') + '.');
}
}}}}
