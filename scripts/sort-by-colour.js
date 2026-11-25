// =====================================================================
// Sort by Colour  — v13 (EN)
// Sorts the objects of one or more groups (or a multi-selection) by fill or stroke colour into
// new colour groups (HSL overall, H, S, L or H+S+L separate, with tolerance).
// v13: dialog
//   • The dialog stays open (ONE runModal). v12 reopened it after every preview and every
//     preset button.
//   • Native OK = group, native Cancel = discard. The own action bar (Preview / Group / Cancel)
//     with the duplicate Cancel has been removed.
//   • The analysis is shown continuously in the dialog (instead of a message box).
//   • Live preview in the document (switch): on every change the grouping is really executed and
//     the previous one discarded. Discarding: undo until the created colour groups are no longer
//     in the document - independent of the history position, also with a full history.
//     OK with unchanged settings keeps the preview without recomputing.
//   • Presets as individual buttons (work on every click); tolerance fields enabled per mode.
//     Undo on error also without the history position.
// v12: 2 history steps, order and hue fixes, running averages.
// v11: text support (fill/stroke of the first character), selectable colour source.
// =====================================================================
'use strict';

const { Document } = require('/document');
const { Selection } = require('/selections');
const { Dialog, DialogResult } = require('/dialog');
const { app } = require('/application');
const { DocumentCommand, CompoundCommandBuilder, AddChildNodesCommandBuilder, NodeMoveType, NodeChildType } = require('/commands');
const { ContainerNodeDefinition } = require('/nodes');
const { Colour } = require('/colours');

const T = {
  title: 'Sort by Colour',
  noDoc: 'No active document.', noSel: 'Please select at least 1 object.', noObj: 'No objects found.', tooFew: 'At least 2 objects required.',
  black: 'Black', white: 'White', grey: 'Grey', red: 'Red', orange: 'Orange', yellow: 'Yellow', green: 'Green', cyan: 'Cyan', blue: 'Blue', violet: 'Violet', magenta: 'Magenta',
  noSolid: 'No solid colour', colGroup: 'Colour group ', greyGroup: 'Grey/Neutral',
  grpInfo: 'Selection', srcCount: (s, n) => s + ' source(s), ' + n + ' objects', textCount: t => ' (' + t + ' text objects)',
  group: 'Group ', direct: 'Direct selection', objShort: ' obj.',
  grpSource: 'Colour source', colourFrom: 'Colour from', sources: ['Fill', 'Stroke'],
  srcNoteText: 'For text objects: fill/stroke of the first character.', srcNote: 'Determines whether fill colour or stroke colour is used for sorting.',
  grpMode: 'Colour sort mode', mode: 'Mode', modes: ['HSL overall (visual)', 'Hue H', 'Saturation S', 'Lightness L', 'H+S+L separate'],
  tol: 'Tolerance', tolH: 'Tolerance Hue H', tolS: 'Tolerance Saturation S', tolL: 'Tolerance Lightness L',
  grpPreset: 'Tolerance presets', presetNote: 'Sets tolerance for active mode:', presets: ['Tight (5)', 'Medium (15)', 'Wide (35)', 'Auto'],
  grpFilter: 'Filter', minArea: 'Min. area (pt)', greySep: 'Separate grey tones', greyThr: 'Grey S% <',
  grpOpt: 'Options', sizeSort: 'Size order', sizeSorts: ['Small to Large', 'Large to Small'],
  posSort: 'Position sort', posSorts: ['None', 'Left to Right', 'Top to Bottom'], byName: 'Name groups by colour',
  live: 'Live preview in the document', okNote: 'OK = group, Cancel = discard everything.', histSteps: 'history steps',
  modeNames: ['HSL overall', 'Hue H', 'Saturation S', 'Lightness L', 'H+S+L separate'],
  small2large: 'Small→Large', large2small: 'Large→Small', srcLabel: ['Fill', 'Stroke'],
  pvSource: 'Colour source: ', pvMode: 'Mode: ', pvTol: 'Tolerance: ', pvMinArea: 'Min. area: ', pvGrey: ' | Grey <S',
  pvObjects: ' objects → ', pvGroups: ' groups', pvSkipped: ' skipped', pvDist: 'Distribution:',
  pvSingle: '  Single objects:  ', pv25: '  2-5 obj.:       ', pv620: '  6-20 obj.:      ', pv21: '  21-100 obj.:    ', pv100: '  >100 obj.:      ',
  pvPerSrc: 'Per source:', pvTitle: 'Preview',
  done: (g, s) => g + ' colour group(s) created in ' + s + ' source(s).', err: 'Error while grouping (undone):\n'
};

// ── Colour helpers ────────────────────────────────────────────────────────────
// Text: real colour in story.getGlyphAtts(0).brushFill/.penFill (brushFillDescriptor = NoFill).
function toColour(colOrHandle) {
  return (colOrHandle && colOrHandle.hslaf !== undefined) ? colOrHandle : new Colour(colOrHandle);
}
function isTextNode(node) { return !!node.story; }
function getFillDescriptor(node, usePen) {
  if (isTextNode(node)) {
    try { const atts = node.story.getGlyphAtts(0); return usePen ? atts.penFill : atts.brushFill; } catch (e) { return null; }
  }
  try { return usePen ? node.penFillDescriptor : node.brushFillDescriptor; } catch (e) { return null; }
}
function getColorHsl(node, usePen) {
  try {
    const fd = getFillDescriptor(node, usePen);
    const fill = fd && fd.fill;
    if (!fill || fill[Symbol.toStringTag] !== 'SolidFill') return null;
    const h = toColour(fill.colour).hslaf;
    return { h: h.h * 360, s: h.s * 100, l: h.l * 100 };
  } catch (e) { return null; }
}
function hslToHex(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  let r, g, b;
  if (s === 0) { r = g = b = l; } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const hue2rgb = (pp, qq, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return pp + (qq - pp) * 6 * t; if (t < 1 / 2) return qq; if (t < 2 / 3) return pp + (qq - pp) * (2 / 3 - t) * 6; return pp; };
    r = hue2rgb(p, q, h + 1 / 3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1 / 3);
  }
  const toHex = x => Math.round(x * 255).toString(16).padStart(2, '0');
  return '#' + toHex(r) + toHex(g) + toHex(b);
}
function hslToName(h, s, l) {
  if (s < 8) { if (l < 20) return T.black; if (l > 80) return T.white; return T.grey; }
  if (h < 15 || h >= 345) return T.red;
  if (h < 40) return T.orange;
  if (h < 70) return T.yellow;
  if (h < 150) return T.green;
  if (h < 190) return T.cyan;
  if (h < 260) return T.blue;
  if (h < 290) return T.violet;
  return T.magenta;
}
function groupLabel(gi, c, useName) {
  if (!c) return T.noSolid;
  const hex = hslToHex(c.h, c.s, c.l);
  return useName ? hslToName(c.h, c.s, c.l) + ' ' + hex : T.colGroup + (gi + 1) + ' ' + hex;
}
function isGroup(node) { return node.isGroupNode === true || node[Symbol.toStringTag] === 'ContainerNode'; }

// ── Colour distance ───────────────────────────────────────────────────────────────
function colorDist(c1, c2, mode, tolH, tolS, tolL) {
  if (mode === 0) {
    const dh = Math.min(Math.abs(c1.h - c2.h), 360 - Math.abs(c1.h - c2.h)) / 180;
    const ds = Math.abs(c1.s - c2.s) / 100, dl = Math.abs(c1.l - c2.l) / 100;
    return Math.sqrt(dh * dh * 2 + ds * ds * 0.8 + dl * dl * 0.6) * 100;
  }
  if (mode === 1) return Math.min(Math.abs(c1.h - c2.h), 360 - Math.abs(c1.h - c2.h));
  if (mode === 2) return Math.abs(c1.s - c2.s);
  if (mode === 3) return Math.abs(c1.l - c2.l);
  const dh = Math.min(Math.abs(c1.h - c2.h), 360 - Math.abs(c1.h - c2.h));
  const ds = Math.abs(c1.s - c2.s), dl = Math.abs(c1.l - c2.l);
  return (dh <= tolH && ds <= tolS && dl <= tolL) ? 0 : 1e9;
}

// ── Auto tolerance ─────────────────────────────────────────────────────────────
function suggestTolerance(items) {
  const colored = items.filter(x => x.hsl);
  if (colored.length < 2) return 15;
  const sample = colored.slice(0, 100);
  const dists = [];
  for (let i = 0; i < sample.length; i++)
    for (let j = i + 1; j < Math.min(i + 6, sample.length); j++)
      dists.push(colorDist(sample[i].hsl, sample[j].hsl, 0, 30, 30, 30));
  dists.sort((a, b) => a - b);
  return Math.min(100, Math.max(1, Math.round(dists[Math.floor(dists.length * 0.20)] || 15)));
}

// ── Clustering ────────────────────────────────────────────────────────────────
// v12: running averages (sums); hue as circular mean (0°/360° handled correctly).
function addToCentroid(g, hsl) {
  const r = hsl.h * Math.PI / 180;
  g.n++; g.sc += Math.cos(r); g.sn += Math.sin(r); g.ss += hsl.s; g.sl += hsl.l;
  let h = hsl.h;   // single colour: take it exactly (no rounding error from sin/cos)
  if (g.n > 1) { h = Math.atan2(g.sn, g.sc) * 180 / Math.PI; if (h < 0) h += 360; if (h >= 360) h -= 360; }
  g.c = { h, s: g.ss / g.n, l: g.sl / g.n };
}
function calcGroups(items, mode, tol, tolH, tolS, tolL, sortAsc, minArea, grayThresh, useGrayGroup) {
  const groups = [];
  const grayGroup = useGrayGroup ? { c: null, isGray: true, totalArea: 0, items: [] } : null;
  let noColorGroup = null;
  const threshold = mode === 4 ? 0.5 : tol;

  for (const item of items) {
    if (item.area < minArea) continue;
    if (useGrayGroup && item.hsl && item.hsl.s < grayThresh) { grayGroup.items.push(item); grayGroup.totalArea += item.area; continue; }
    if (!item.hsl) {
      if (!noColorGroup) { noColorGroup = { c: null, noColor: true, totalArea: 0, items: [] }; groups.push(noColorGroup); }
      noColorGroup.items.push(item); noColorGroup.totalArea += item.area; continue;
    }
    let best = null, bestD = 1e9;
    for (const g of groups) {
      if (!g.c || g.noColor) continue;
      const d = colorDist(item.hsl, g.c, mode, tolH, tolS, tolL);
      if (d < bestD) { bestD = d; best = g; }
    }
    if (best && bestD <= threshold) {
      best.items.push(item); best.totalArea += item.area; addToCentroid(best, item.hsl);
    } else {
      const g = { c: null, noColor: false, totalArea: item.area, items: [item], n: 0, sc: 0, sn: 0, ss: 0, sl: 0 };
      addToCentroid(g, item.hsl); groups.push(g);
    }
  }

  const result = groups.filter(g => g.items.length > 0);
  if (grayGroup && grayGroup.items.length > 0) result.unshift(grayGroup);
  if (sortAsc) { result.forEach(g => g.items.sort((a, b) => a.area - b.area)); result.sort((a, b) => a.totalArea - b.totalArea); }
  else { result.forEach(g => g.items.sort((a, b) => b.area - a.area)); result.sort((a, b) => b.totalArea - a.totalArea); }
  return result;
}

// ── Undo helpers ──────────────────────────────────────────────────────────
function isAlive(n) {
  try { let p = n ? n.parent : null; for (let i = 0; p && i < 64; i++) { if ((p[Symbol.toStringTag] || '') === 'SpreadNode') return true; p = p.parent; } } catch (e) {}
  return false;
}
// v13: undo until no created colour group is left in the document (no history position).
function undoOwn(doc, rec) {
  let k = 0;
  while (rec.created.some(isAlive) && k < rec.steps + 2) { try { doc.history.undo(); } catch (e) { break; } k++; }
  // safety net: delete only created, still EMPTY colour groups - never the user's objects
  for (const n of rec.created) { try { if (isAlive(n) && n.children.length === 0) n.delete(); } catch (e) {} }
}

// ── Group (v12): 2 history steps ─────────────────────────────────────────────
// Step 1: all colour groups in ONE compound (one builder per source, groups directly in place).
//   The builder stacks upwards in the order of adding and returns newNodes reversed - so the
//   groups are added backwards: newNodes then comes in sort order and the first group is on top.
// Step 2: every object is sorted in INDIVIDUALLY (moving several at once keeps the old stacking);
//   backwards, so that the first object ends up on top.
function applyGroups(doc, allResults, useName, rec) {
  const created = rec.created;
  const cbA = CompoundCommandBuilder.create();
  const plan = [];
  for (const r of allResults) {
    if (!r.groups.length) continue;
    const target = r.sourceGroup || r.groups[0].items[0].node.parent;
    const names = r.groups.map((g, gi) => {
      const name = g.isGray ? T.greyGroup : (g.noColor ? T.noSolid : groupLabel(gi, g.c, useName));
      return r.sourceGroup && r.sourceGroup.userDescription ? r.sourceGroup.userDescription + ' – ' + name : name;
    });
    const b = AddChildNodesCommandBuilder.create();
    for (let gi = names.length - 1; gi >= 0; gi--) b.addContainerNode(ContainerNodeDefinition.create(names[gi]));
    b.setInsertionTarget(target); b.setInsertionMode(1);
    cbA.addCommand(b.createCommand(false));
    plan.push({ groups: r.groups, names });
  }
  if (!plan.length) return 0;
  const cA = cbA.createCommand(false);
  doc.executeCommand(cA); rec.steps++;
  const nn = Array.from(cA.newNodes);
  for (const n of nn) created.push(n);
  let k = 0;
  for (const pl of plan) {
    pl.nodes = nn.slice(k, k + pl.names.length); k += pl.names.length;
    // verify the assignment via the names (in case the engine changes the order)
    const ok = pl.nodes.length === pl.names.length && pl.nodes.every((n, i) => n.userDescription === pl.names[i]);
    if (!ok) {
      const rev = pl.nodes.slice().reverse();
      if (rev.length === pl.names.length && rev.every((n, i) => n.userDescription === pl.names[i])) pl.nodes = rev;
      else throw new Error('group assignment');
    }
  }
  const cbB = CompoundCommandBuilder.create();
  let moves = 0, total = 0;
  for (const pl of plan) {
    total += pl.groups.length;
    pl.groups.forEach((g, gi) => {
      for (let i = g.items.length - 1; i >= 0; i--) {
        cbB.addCommand(DocumentCommand.createMoveNodes(Selection.create(doc, [g.items[i].node]), pl.nodes[gi], NodeMoveType.Inside, NodeChildType.Main));
        moves++;
      }
    });
  }
  if (moves) { doc.executeCommand(cbB.createCommand(false)); rec.steps++; }
  return total;
}
//@@CORE_END

// ── Selection ────────────────────────────────────────────────────────
const doc = Document.current;
if (!doc) { app.alert(T.noDoc, T.title); throw new Error(); }
const sel = doc.selection;
if (!sel || sel.length < 1) { app.alert(T.noSel, T.title); throw new Error(); }

const sourceGroupsRaw = [];
const directNodesRaw = [];
let textNodeCount = 0;
for (let i = 0; i < sel.length; i++) {
  const n = sel.at(i).node;
  if (!n) continue;
  if (isGroup(n)) {
    const children = [];
    for (const ch of n.children) { children.push(ch); if (isTextNode(ch)) textNodeCount++; }
    if (children.length > 0) sourceGroupsRaw.push({ sourceGroup: n, nodes: children });
  } else {
    directNodesRaw.push(n);
    if (isTextNode(n)) textNodeCount++;
  }
}
if (directNodesRaw.length > 0) sourceGroupsRaw.unshift({ sourceGroup: null, nodes: directNodesRaw });
if (sourceGroupsRaw.length === 0) { app.alert(T.noObj, T.title); throw new Error(); }
const totalItems = sourceGroupsRaw.reduce((s, g) => s + g.nodes.length, 0);
if (totalItems < 2) { app.alert(T.tooFew, T.title); throw new Error(); }

// v12: read area and position of each object only once
for (const sg of sourceGroupsRaw) {
  sg.geo = sg.nodes.map(n => { let bb = null; try { bb = n.spreadVisibleBox; } catch (e) {} return { area: bb ? bb.width * bb.height : 0, x: bb ? bb.x : 0, y: bb ? bb.y : 0, ok: !!bb }; });
}

// ── Dialog (v13): ONE runModal, native OK = group, Cancel = discard ─────────────
const dlg = Dialog.create(T.title);
dlg.setIsResizable(true);
dlg.initialWidth = 820;
const col = dlg.addColumn(); col.widthProportion = 1;
const col2 = dlg.addColumn(); col2.widthProportion = 1;

const grpInfo = col.addGroup(T.grpInfo);
const infoLines = [T.srcCount(sourceGroupsRaw.length, totalItems) + (textNodeCount > 0 ? T.textCount(textNodeCount) : '')];
sourceGroupsRaw.forEach((sg, i) => {
  const name = sg.sourceGroup ? (sg.sourceGroup.userDescription || T.group + (i + 1)) : T.direct;
  infoLines.push('  ' + name + ': ' + sg.nodes.length + T.objShort);
});
grpInfo.addStaticText('', infoLines.join('\n'));

const grpSource = col.addGroup(T.grpSource);
const cmbSource = grpSource.addComboBox(T.colourFrom, T.sources, 0);
grpSource.addStaticText('', textNodeCount > 0 ? T.srcNoteText : T.srcNote);

const grpMode = col.addGroup(T.grpMode);
const cmb = grpMode.addComboBox(T.mode, T.modes, 0);
const edT = grpMode.addUnitValueEditor(T.tol, 'none', 'none', null, 0, 100); edT.value = 15; edT.showPopupSlider = true;
const edTH = grpMode.addUnitValueEditor(T.tolH, 'none', 'none', null, 0, 180); edTH.value = 20; edTH.showPopupSlider = true;
const edTS = grpMode.addUnitValueEditor(T.tolS, 'none', 'none', null, 0, 100); edTS.value = 20; edTS.showPopupSlider = true;
const edTL = grpMode.addUnitValueEditor(T.tolL, 'none', 'none', null, 0, 100); edTL.value = 20; edTL.showPopupSlider = true;

// v13: presets as individual buttons (work on every click, also twice in a row)
const grpPreset = col.addGroup(T.grpPreset);
grpPreset.addStaticText('', T.presetNote);
const presetBtns = T.presets.map(p => grpPreset.addButton(p));

const grpFilter = col2.addGroup(T.grpFilter);
const edMinArea = grpFilter.addUnitValueEditor(T.minArea, 'none', 'none', null, 0, 10000); edMinArea.value = 0; edMinArea.showPopupSlider = true;
const chkGray = grpFilter.addCheckBox(T.greySep, false);
const edGray = grpFilter.addUnitValueEditor(T.greyThr, 'none', 'none', null, 0, 50); edGray.value = 8; edGray.showPopupSlider = true;

const grpOpt = col2.addGroup(T.grpOpt);
const cmbSort = grpOpt.addComboBox(T.sizeSort, T.sizeSorts, 0);
const cmbPos = grpOpt.addComboBox(T.posSort, T.posSorts, 0);
const chkName = grpOpt.addCheckBox(T.byName, true);

const grpPv = col2.addGroup(T.pvTitle);
const chkLive = grpPv.addCheckBox(T.live, false);
grpPv.addStaticText('', T.okNote);
const txAnalysis = grpPv.addStaticText('', '');

try { cmbSource.selectedIndex = 0; cmb.selectedIndex = 0; cmbSort.selectedIndex = 0; cmbPos.selectedIndex = 0; } catch (e) {}

// ── Data ──────────────────────────────────────────────────────────────────────
let lastSourceIdx = -1;
let sourceGroups = null;
function rebuildItems(usePen) {
  return sourceGroupsRaw.map(sg => ({
    sourceGroup: sg.sourceGroup,
    items: sg.nodes.map((n, i) => ({ node: n, hsl: getColorHsl(n, usePen), area: sg.geo[i].area, x: sg.geo[i].x, y: sg.geo[i].y, ok: sg.geo[i].ok }))
  }));
}
// Colours are read once per colour source (the preview does not change them).
function ensureItems(sourceIdx) {
  if (sourceIdx !== lastSourceIdx || !sourceGroups) { lastSourceIdx = sourceIdx; sourceGroups = rebuildItems(sourceIdx === 1); }
  return sourceGroups;
}
function readParams() {
  return {
    sourceIdx: cmbSource.selectedIndex, mode: cmb.selectedIndex,
    tol: edT.value, tolH: edTH.value, tolS: edTS.value, tolL: edTL.value,
    sortAsc: cmbSort.selectedIndex === 0, posMode: cmbPos.selectedIndex,
    minArea: edMinArea.value, useGray: chkGray.value, grayThr: edGray.value, useName: chkName.value
  };
}
function computeResults(p) {
  const sgs = ensureItems(p.sourceIdx);
  const allResults = sgs.map(sg => ({
    sourceGroup: sg.sourceGroup,
    groups: calcGroups(sg.items, p.mode, p.tol, p.tolH, p.tolS, p.tolL, p.sortAsc, p.minArea, p.grayThr, p.useGray)
  }));
  if (p.posMode > 0) {
    for (const r of allResults)
      for (const grp of r.groups)
        grp.items.sort((a, b) => (!a.ok || !b.ok) ? 0 : (p.posMode === 1 ? a.x - b.x : a.y - b.y));
  }
  return allResults;
}
function analysisText(p, allResults) {
  const totalGroups = allResults.reduce((s, r) => s + r.groups.length, 0);
  const totalUsed = allResults.reduce((s, r) => r.groups.reduce((ss, g) => ss + g.items.length, 0) + s, 0);
  const skipped = totalItems - totalUsed;
  const hist = [0, 0, 0, 0, 0];
  for (const r of allResults) for (const g of r.groups) {
    const n = g.items.length;
    hist[n === 1 ? 0 : n <= 5 ? 1 : n <= 20 ? 2 : n <= 100 ? 3 : 4]++;
  }
  let txt = T.pvSource + T.srcLabel[p.sourceIdx] + '\n';
  txt += T.pvMode + T.modeNames[p.mode] + '  (' + (p.sortAsc ? T.small2large : T.large2small) + ')\n';
  txt += (p.mode === 4 ? 'Tol H:' + p.tolH + ' S:' + p.tolS + ' L:' + p.tolL : T.pvTol + p.tol) + '\n';
  txt += T.pvMinArea + p.minArea + (p.useGray ? T.pvGrey + p.grayThr + '%' : '') + '\n\n';
  txt += totalItems + T.pvObjects + totalGroups + T.pvGroups;
  if (skipped > 0) txt += ' (' + skipped + T.pvSkipped + ')';
  txt += '\n\n' + T.pvDist + '\n' + T.pvSingle + hist[0] + '\n' + T.pv25 + hist[1] + '\n' + T.pv620 + hist[2] + '\n' + T.pv21 + hist[3] + '\n' + T.pv100 + hist[4];
  if (allResults.length > 1) {
    txt += '\n\n' + T.pvPerSrc;
    allResults.forEach((r, i) => {
      const nm = r.sourceGroup ? (r.sourceGroup.userDescription || T.group + (i + 1)) : T.direct;
      txt += '\n  ' + nm + ': ' + sourceGroups[i].items.length + ' → ' + r.groups.length;
    });
  }
  return txt;
}
function setText(ctrl, s) { try { ctrl.setText(s); } catch (e) { try { ctrl.text = s; } catch (e2) {} } }

// ── Preview in the document (v13) ───────────────────────────────────────────────
// The preview is a real grouping (2 history steps: create colour groups, sort objects in - the
// second needs the nodes of the first, so a native preview is not possible). Discarding: undo until
// none of the created colour groups is left in the document (creating them is the first own entry)
// - independent of the history position, also with a full history; then a safety net (delete only
// own empty groups).
let pv = null;   // { created, steps, key }
function discardPreview() {
  if (!pv) return;
  const rec = pv; pv = null;
  undoOwn(doc, rec);
}
function applyNow(p) {
  const rec = { created: [], steps: 0, key: JSON.stringify(p) };
  try {
    rec.count = applyGroups(doc, computeResults(p), p.useName, rec);
    return rec;
  } catch (e) {
    undoOwn(doc, rec);
    throw e;
  }
}
let busy = false;
function refresh() {
  if (busy) return;
  busy = true;
  try {
    const p = readParams();
    try { edT.isEnabled = p.mode !== 4; edTH.isEnabled = edTS.isEnabled = edTL.isEnabled = p.mode === 4; } catch (e) {}
    discardPreview();
    setText(txAnalysis, analysisText(p, computeResults(p)));
    if (chkLive.value) {
      try { pv = applyNow(p); }
      catch (e) { setText(txAnalysis, T.err + e.message); }
    }
  } finally { busy = false; }
}
function onChange(ctrl) {
  try { ctrl.setOnValueChangedHandler(refresh); }
  catch (e) { try { ctrl.onValueChangedHandler = refresh; } catch (e2) {} }
}
[cmbSource, cmb, edT, edTH, edTS, edTL, edMinArea, chkGray, edGray, cmbSort, cmbPos, chkName, chkLive].forEach(onChange);
presetBtns.forEach((btn, idx) => btn.setOnClickHandler(() => {
  const p = readParams();
  const v = [5, 15, 35, suggestTolerance([].concat(...ensureItems(p.sourceIdx).map(g => g.items)))][idx];
  busy = true;
  try { if (p.mode === 4) { edTH.value = v; edTS.value = v; edTL.value = v; } else edT.value = v; }
  finally { busy = false; }
  refresh();
}));
refresh();

const res = dlg.runModal();
const ok = res && res.value === DialogResult.Ok.value;
if (!ok) {
  discardPreview();
} else {
  const p = readParams();
  let rec = null;
  if (pv && pv.key === JSON.stringify(p)) { rec = pv; pv = null; }   // keep the unchanged preview
  else {
    discardPreview();
    try { rec = applyNow(p); }
    catch (e) { app.alert(T.err + e.message, T.title); }
  }
  if (rec) console.log(T.done(rec.count, sourceGroupsRaw.length) + ' (' + rec.steps + ' ' + T.histSteps + ')');
}
