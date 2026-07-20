'use strict';
// ============================================================================
// Artboard Resizer
// ----------------------------------------------------------------------------
// Select one or more artboards, then run this script.
//
// Small window at any size: only PER_PAGE artboards are shown at once, arranged
// in a grid of side-by-side columns.
//
// NAVIGATION (back AND forward to any page):
//   Affinity dialogs can only return OK or Cancel, so navigation is done with
//   two dropdowns in the "Navigate" box rather than Next/Prev buttons:
//     * "Go to page"  - choose any page (earlier or later).
//     * "On OK"       - either "Go to selected page" or "Apply changes now".
//   Click OK to act on those choices; your edits on the current page are always
//   remembered first. Click Cancel to exit without applying anything.
//
// NOTHING is applied to the document until you choose "Apply changes now" (or
// reach it via OK). All changes then apply as ONE undo step. So you can roam
// pages freely, review and tweak, and commit only when ready.
//
// Controls (left column):
//   - Navigate: Go to page / On OK.
//   - Anchor:   which point stays fixed while resizing (remembered).
//   - Set all on page: type W/H, click "Apply to page".
// Right of that: a grid of W/H fields, one cell per artboard on the page.
// ============================================================================

// ------------------------------- SETTINGS -----------------------------------
const PER_PAGE     = 6;   // artboards per page
const PAGE_COLUMNS = 3;   // columns the page's artboards are spread across
const DIALOG_WIDTH = 0;   // 0 = auto, or a pixel width e.g. 900
// ----------------------------------------------------------------------------

const { Document } = require('/document.js');
const { Dialog, DialogResult, UnitType } = require('/dialog.js');
const { CompoundCommandBuilder, DocumentCommand } = require('/commands.js');
const { SpatialAnchor } = require('affinity:dom');

function collectArtboards(doc) {
  const list = [];
  for (const node of doc.selection.nodes) {
    let ai = null;
    try { ai = node.artboardInterface; } catch (e) {}
    if (ai) {
      const s = ai.spreadBaseBox; // effective (UI) size; NOT baseBox
      list.push({ ai, name: ai.description, w: s.width, h: s.height });
    }
  }
  return list;
}

function anchorFromKey(key) {
  return SpatialAnchor[key] != null ? SpatialAnchor[key] : SpatialAnchor.TopLeft;
}

// Show one page. Reads current-page edits into pending[], then returns the
// user's intent: { result:'apply'|'goto'|'cancel', gotoPage, anchorKey }.
function showPage(artboards, pageIndex, pageCount, anchorKey, pending) {
  const per = Math.max(1, PER_PAGE);
  const startIdx = pageIndex * per;
  const endIdx = Math.min(startIdx + per, artboards.length);

  const dlg = Dialog.create('Artboard Resizer');
  dlg.isResizable = true;
  if (DIALOG_WIDTH > 0) { try { dlg.initialWidth = DIALOG_WIDTH; } catch (e) {} }

  // ---- Left column: navigate + options + bulk ----
  const ctrlCol = dlg.addColumn();

  const info = ctrlCol.addGroup('');
  info.addStaticText(
    '',
    'Page ' + (pageIndex + 1) + ' of ' + pageCount +
    '   (' + (startIdx + 1) + '\u2013' + endIdx + ' of ' + artboards.length + ')'
  );

  const nav = ctrlCol.addGroup('Navigate');
  const pageLabels = [];
  for (let i = 0; i < pageCount; i++) {
    const s = i * per + 1;
    const e = Math.min(i * per + per, artboards.length);
    pageLabels.push('Page ' + (i + 1) + '  (' + s + '\u2013' + e + ')');
  }
  const gotoCtrl = nav.addComboBox('Go to page', pageLabels, pageIndex);
  const actionCtrl = nav.addComboBox('On OK', ['Go to selected page', 'Apply changes now'], 0);

  const anchorKeys = SpatialAnchor.keys.filter(k => k !== 'None' && k !== 'FocalPoint');
  const opts = ctrlCol.addGroup('Options');
  const anchorCtrl = opts.addComboBox('Anchor', anchorKeys, Math.max(0, anchorKeys.indexOf(anchorKey)));

  const bulk = ctrlCol.addGroup('Set all on page');
  const bulkW = bulk.addUnitValueEditor('Width', UnitType.Pixel, UnitType.Pixel, 0, 0, null);
  const bulkH = bulk.addUnitValueEditor('Height', UnitType.Pixel, UnitType.Pixel, 0, 0, null);
  const applyPageBtn = bulk.addButton('Apply to page');

  // ---- Grid columns for this page's artboards ----
  const nameCounts = {};
  artboards.forEach(a => { nameCounts[a.name] = (nameCounts[a.name] || 0) + 1; });
  const labelFor = (ab, i) =>
    nameCounts[ab.name] > 1 ? (ab.name + ' #' + (i + 1)) : ab.name;

  const pageIdxs = [];
  for (let i = startIdx; i < endIdx; i++) pageIdxs.push(i);

  const cols = Math.max(1, PAGE_COLUMNS);
  const rowsPerCol = Math.ceil(pageIdxs.length / cols);

  const rows = [];
  for (let c = 0; c < cols; c++) {
    const col = dlg.addColumn();
    for (let r = 0; r < rowsPerCol; r++) {
      const pos = c * rowsPerCol + r;
      if (pos >= pageIdxs.length) break;
      const i = pageIdxs[pos];
      const ab = artboards[i];
      const curW = pending[i] ? pending[i].w : ab.w;
      const curH = pending[i] ? pending[i].h : ab.h;
      const g = col.addGroup(labelFor(ab, i));
      const wCtrl = g.addUnitValueEditor('W', UnitType.Pixel, UnitType.Pixel, curW, 1, null);
      const hCtrl = g.addUnitValueEditor('H', UnitType.Pixel, UnitType.Pixel, curH, 1, null);
      rows.push({ i, wCtrl, hCtrl });
    }
  }

  applyPageBtn.onClickHandler = () => {
    const w = bulkW.value, h = bulkH.value;
    for (const r of rows) {
      if (w > 0) r.wCtrl.value = w;
      if (h > 0) r.hCtrl.value = h;
    }
  };

  const modal = dlg.runModal();
  const chosenAnchor = anchorKeys[anchorCtrl.selectedIndex];

  if (!(modal === DialogResult.Ok || modal === true)) {
    return { result: 'cancel', anchorKey: chosenAnchor };
  }

  // Remember this page's edits regardless of where we go next.
  for (const r of rows) {
    pending[r.i] = { w: Math.round(r.wCtrl.value), h: Math.round(r.hCtrl.value) };
  }

  const wantApply = actionCtrl.selectedIndex === 1;
  return {
    result: wantApply ? 'apply' : 'goto',
    gotoPage: gotoCtrl.selectedIndex,
    anchorKey: chosenAnchor,
  };
}

function commit(doc, artboards, pending, anchorKey) {
  const anchor = anchorFromKey(anchorKey);
  const builder = CompoundCommandBuilder.create();
  let changes = 0;
  for (let i = 0; i < artboards.length; i++) {
    const pnd = pending[i];
    if (!pnd) continue;
    const ab = artboards[i];
    if (pnd.w >= 1 && pnd.h >= 1 && (pnd.w !== Math.round(ab.w) || pnd.h !== Math.round(ab.h))) {
      builder.addCommand(DocumentCommand.createSetArtboardSizeWithAnchor(ab.ai, pnd.w, pnd.h, anchor));
      changes++;
    }
  }
  if (changes > 0) doc.executeCommand(builder.createCommand());
  return changes;
}

function main() {
  const doc = Document.current;
  if (!doc) { console.log('No open document.'); return; }

  const artboards = collectArtboards(doc);
  if (artboards.length === 0) {
    console.log('No artboards selected. Select one or more artboards and run again.');
    return;
  }

  const per = Math.max(1, PER_PAGE);
  const pageCount = Math.ceil(artboards.length / per);
  const pending = [];
  let anchorKey = 'TopLeft';
  let page = 0;
  const GUARD_MAX = 10000; // safety against any accidental loop
  let guard = 0;

  while (guard++ < GUARD_MAX) {
    let res;
    try {
      res = showPage(artboards, page, pageCount, anchorKey, pending);
    } catch (e) {
      console.log('Interactive dialog unavailable (' + e.message + ').');
      console.log('This build of Affinity cannot open script dialogs in the current context.');
      return;
    }
    anchorKey = res.anchorKey;

    if (res.result === 'cancel') {
      console.log('Cancelled - no changes applied.');
      return;
    }
    if (res.result === 'apply') {
      const n = commit(doc, artboards, pending, anchorKey);
      console.log(n > 0 ? ('Resized ' + n + ' artboard(s).') : 'No changes made.');
      return;
    }
    // 'goto'
    page = Math.max(0, Math.min(pageCount - 1, res.gotoPage));
  }
  console.log('Stopped (navigation guard reached).');
}

main();
