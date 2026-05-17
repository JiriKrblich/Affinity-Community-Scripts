'use strict';

const { Document } = require('/document');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
const { Dialog, DialogResult, HorizontalAlignment } = require('/dialog');
const { Colour } = require('/colours');
const { FillType, FillDescriptor } = require('/fills');
const { Selection } = require('/selections');
const { TransformBuilder } = require('/geometry');
const { app } = require('/application');
const { setTimeout } = require('/timers');

const APP_NAME = 'ReplaceColorFill';
const PAGE_SIZE = 9;

function collectAllNodes(node, out) {
  out.push(node);

  let childList = [];
  try { childList = [...node.children]; } catch (_) {}
  for (const child of childList) collectAllNodes(child, out);
}

function makeGradientTransform(node) {
  try {
    const bbox = node.baseBox;
    if (!bbox || bbox.width <= 0) return null;

    const tb = new TransformBuilder();
    tb.scale(bbox.width, bbox.width);
    tb.translate(bbox.x, bbox.y + bbox.height / 2);

    return tb.transform;
  } catch (_) {
    return null;
  }
}

function getBrushFillDescriptor(node) {
  try {
    if (node.brushFillDescriptor) return node.brushFillDescriptor;
  } catch (_) {}

  try {
    if (node.brushFillInterface) {
      return node.brushFillInterface.getCurrentDescriptor(false);
    }
  } catch (_) {}

  return null;
}

function safeFixed(value, places) {
  try { return Number(value).toFixed(places); } catch (_) { return '?'; }
}

function colourKey(colour) {
  try {
    const c = new Colour(colour).rgba8;
    return c.r + ',' + c.g + ',' + c.b + ',' + c.alpha;
  } catch (_) {
    return '?';
  }
}

function solidKey(fill) {
  const c = fill.colour.rgba8;
  return [
    c.r, c.g, c.b, c.alpha,
    safeFixed(fill.alpha, 6),
    safeFixed(fill.noise, 6),
    safeFixed(fill.tint, 6),
    safeFixed(fill.intensity, 6)
  ].join(',');
}

function gradientKey(fill) {
  const grad = fill.gradient;
  const stopKey = grad.stops.map(function(s) {
    return [
      colourKey(s.colour),
      safeFixed(s.position, 6),
      safeFixed(s.midpoint, 6),
      safeFixed(s.smoothness, 6)
    ].join('@');
  }).join('|');

  return [
    fill.gradientFillType && fill.gradientFillType.value,
    stopKey,
    safeFixed(grad.alpha, 6),
    safeFixed(grad.noise, 6),
    safeFixed(grad.tint, 6),
    safeFixed(grad.intensity, 6)
  ].join(';');
}

function fillKey(fill) {
  if (!fill || !fill.fillType) return null;

  if (fill.fillType.value === FillType.Solid.value) {
    return 's:' + solidKey(fill);
  }

  if (fill.fillType.value === FillType.Gradient.value) {
    return 'g:' + gradientKey(fill);
  }

  return null;
}

function getNodeFillInfo(node) {
  try {
    const fd = getBrushFillDescriptor(node);
    if (!fd) return null;

    const fill = fd.fill;
    if (!fill) return null;

    const key = fillKey(fill);
    if (!key) return null;

    if (fill.fillType.value === FillType.Solid.value) {
      return {
        type: 'solid',
        key,
        initFill: fill,
        origFd: fd
      };
    }

    if (fill.fillType.value === FillType.Gradient.value) {
      return {
        type: 'gradient',
        key,
        initFill: fill,
        origFd: fd
      };
    }

    return null;
  } catch (_) {
    return null;
  }
}

function cloneFill(rawFill) {
  try {
    if (rawFill && rawFill.clone) return rawFill.clone();
  } catch (_) {}
  return rawFill;
}

function makeFillDescriptorForNode(entry, rawFill, nodeEntry) {
  const ftv = rawFill.fillType ? rawFill.fillType.value : null;
  const ofd = nodeEntry.origFd;
  const applyFill = cloneFill(rawFill);
  let transform = ofd.transform;
  let scaleWithObject = ofd.isScaleWithObject;
  let anchoredToSpread = ofd.isAnchoredToSpread;

  if (ftv === FillType.Gradient.value) {
    if (entry.type !== 'gradient') {
      const gradTransform = makeGradientTransform(nodeEntry.node);
      if (gradTransform) {
        transform = gradTransform;
        scaleWithObject = true;
        anchoredToSpread = false;
      }
    }

    return FillDescriptor.create(
      applyFill,
      scaleWithObject,
      transform,
      ofd.blendMode,
      anchoredToSpread
    );
  }

  if (ftv === FillType.Solid.value) {
    return FillDescriptor.create(
      applyFill,
      scaleWithObject,
      transform,
      ofd.blendMode,
      anchoredToSpread
    );
  }

  throw new Error('Unknown fillType: ' + ftv);
}

function createReplaceCommand(doc, pageDialogs) {
  const cb = CompoundCommandBuilder.create();
  let count = 0;
  let firstErr = null;

  for (const pd of pageDialogs) {
    for (const picker of pd.pickers) {
      const { e, fe } = picker;
      let rawFill;
      try {
        rawFill = fe.fill;
      } catch (err) {
        firstErr = firstErr || ('fe.fill threw: ' + err.message);
        continue;
      }

      if (!rawFill) {
        firstErr = firstErr || 'fe.fill returned null';
        continue;
      }

      const currentKey = fillKey(rawFill);
      if (!currentKey) {
        firstErr = firstErr || 'Unsupported replacement fill';
        continue;
      }

      if (currentKey === picker.initialKey) {
        continue;
      }

      for (const nodeEntry of e.nodeEntries) {
        try {
          cb.addCommand(DocumentCommand.createSetBrushFill(
            Selection.create(doc, nodeEntry.node),
            makeFillDescriptorForNode(e, rawFill, nodeEntry)
          ));

          count++;
        } catch (err) {
          firstErr = firstErr || ('apply threw: ' + err.message);
        }
      }
    }
  }

  return { command: count > 0 ? cb.createCommand() : null, count, firstErr };
}

function restoreHistoryStart(doc, historyStart) {
  try {
    if (doc.history.position !== historyStart) {
      doc.history.position = historyStart;
    }
  } catch (_) {}
}

const selectionRestoreTimers = [];

function restoreSelection(doc, selectionNodes) {
  try {
    if (!selectionNodes || selectionNodes.length === 0) return;
    doc.selection = Selection.create(doc, selectionNodes);
  } catch (_) {}
}

function restoreSelectionDeferred(doc, selectionNodes) {
  restoreSelection(doc, selectionNodes);

  try {
    selectionRestoreTimers.push(setTimeout(0, function() {
      restoreSelection(doc, selectionNodes);
    }));
  } catch (_) {}

  try {
    selectionRestoreTimers.push(setTimeout(100, function() {
      restoreSelection(doc, selectionNodes);
    }));
  } catch (_) {}
}

const doc = Document.current;

if (!doc) {
  app.alert('No document open.', APP_NAME);
  return;
}

const selNodes = [];
for (const n of doc.selection.nodes) selNodes.push(n);

if (selNodes.length === 0) {
  app.alert('No objects selected.\nSelect at least one and run again.', APP_NAME);
  return;
}

const allNodes = [];
for (const n of selNodes) collectAllNodes(n, allNodes);

const colorMap = new Map();

for (const n of allNodes) {
  const info = getNodeFillInfo(n);
  if (!info) continue;

  if (!colorMap.has(info.key)) {
    colorMap.set(info.key, {
      type: info.type,
      initKey: info.key,
      initFill: info.initFill,
      nodeEntries: []
    });
  }

  colorMap.get(info.key).nodeEntries.push({
    node: n,
    origFd: info.origFd
  });
}

if (colorMap.size === 0) {
  app.alert('No solid or gradient fills found.', APP_NAME);
  return;
}

const historyStart = doc.history.position;
const entries = Array.from(colorMap.values());
const totalPages = Math.ceil(entries.length / PAGE_SIZE);
const pageDialogs = [];
let previewBusy = false;

function applyPreview() {
  if (previewBusy) return;
  previewBusy = true;

  try {
    doc.executeCommand(DocumentCommand.createClearPreviews());

    const built = createReplaceCommand(doc, pageDialogs);
    if (built.command) {
      doc.executeCommand(built.command, true);
    }
  } finally {
    previewBusy = false;
  }
}

for (let p = 0; p < totalPages; p++) {
  const hasPrev = p > 0;
  const hasNext = p < totalPages - 1;
  const pageEntries = entries.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);

  const title = totalPages > 1
    ? APP_NAME + ' (' + (p + 1) + ' / ' + totalPages + ')'
    : APP_NAME;

  const dlg = Dialog.create(title);
  dlg.initialWidth = 360;

  const colSrc = dlg.addColumn();
  colSrc.widthProportion = 1;

  const colDst = dlg.addColumn();
  colDst.widthProportion = 1;

  const hdrS = colSrc.addGroup('');
  hdrS.addStaticText('', 'Colour').isFullWidth = true;

  const hdrD = colDst.addGroup('');
  hdrD.addStaticText('', 'Replace with').isFullWidth = true;

  const pickers = [];

  for (let i = 0; i < pageEntries.length; i++) {
    const e = pageEntries[i];

    const gS = colSrc.addGroup('');
    if (i > 0) gS.enableSeparator = true;

    const gD = colDst.addGroup('');
    if (i > 0) gD.enableSeparator = true;

    const srcFe = gS.addFillEditor('', e.initFill);
    srcFe.isFullWidth = true;

    const fe = gD.addFillEditor('', e.initFill);
    fe.isFullWidth = true;
    fe.onValueChangedHandler = applyPreview;

    const picker = { e, fe, initialKey: e.initKey };
    try {
      picker.initialKey = fillKey(fe.fill) || e.initKey;
    } catch (_) {}
    pickers.push(picker);
  }

  const footS = colSrc.addGroup('');
  footS.enableSeparator = true;

  const footD = colDst.addGroup('');
  footD.enableSeparator = true;

  let prevCk = null;
  if (hasPrev) {
    prevCk = footS.addCheckBox('< Prev page', false);
    prevCk.isFullWidth = true;
  }

  let nextCk = null;
  if (hasNext) {
    nextCk = footS.addCheckBox('Next page >', false);
    nextCk.isFullWidth = true;
  }

  if (totalPages > 1) {
    const hint = footD.addStaticText('', 'Tick page + OK to navigate');
    hint.isFullWidth = true;
    hint.textHorizontalAlignment = HorizontalAlignment.Right;
  } else {
    const hint = footD.addStaticText('', 'Changes preview live');
    hint.isFullWidth = true;
    hint.textHorizontalAlignment = HorizontalAlignment.Right;
  }

  pageDialogs.push({ dlg, pickers, prevCk, nextCk });
}

let currentPage = 0;
let running = true;

while (running) {
  const pd = pageDialogs[currentPage];

  if (pd.prevCk) pd.prevCk.value = false;
  if (pd.nextCk) pd.nextCk.value = false;

  const r = pd.dlg.show();

  if (r.value !== DialogResult.Ok.value) {
    doc.executeCommand(DocumentCommand.createClearPreviews());
    restoreHistoryStart(doc, historyStart);
    restoreSelectionDeferred(doc, selNodes);
    break;
  }

  if (pd.prevCk && pd.prevCk.value) {
    currentPage--;
    continue;
  }

  if (pd.nextCk && pd.nextCk.value) {
    currentPage++;
    continue;
  }

  const built = createReplaceCommand(doc, pageDialogs);

  doc.executeCommand(DocumentCommand.createClearPreviews());
  restoreHistoryStart(doc, historyStart);

  if (built.command) {
    doc.executeCommand(built.command);
  }

  if (built.firstErr) {
    app.alert('Apply error (debug):\n' + built.firstErr, APP_NAME);
  }

  restoreSelectionDeferred(doc, selNodes);

  running = false;
}
