/**
 * name: Separate Pixel Islands Pro (No Container)
 * description: Automatically detects isolated connected stroke/pixel components (islands) in a pixel or raster layer and separates each asset into its own neatly cropped layer directly on the canvas without creating a container group.
 * version: 1.2.0
 * author: Antigravity
 * website: https://minicg.com
 */
'use strict';

const { app } = require('/application');
const { Document } = require('/document');
const {
  DocumentCommand,
  AddChildNodesCommandBuilder,
  InsertionMode,
  NodeChildType
} = require('/commands');
const { ContainerNodeDefinition, ImageNodeDefinition } = require('/nodes');
const { Dialog, DialogResult } = require('/dialog');
const { Selection } = require('/selections');
const { Transform } = require('/geometry');
const { NodeRenderingEngine, PixelBuffer, RasterFormat } = require('/rasterobject');
const { UnitType } = require('/units');

const SCRIPT_NAME = 'Separate Pixel Islands (No Container)';
const CONTAINER_PREFIX = 'Separated Assets';

function getCurrentDocument() {
  try {
    if (app && app.documents) {
      if (app.documents.current) return app.documents.current;
      if (app.documents.all && app.documents.all.length > 0) {
        return app.documents.all[0];
      }
    }
  } catch (e) {}

  try {
    return Document.current || null;
  } catch (e) {
    return null;
  }
}

function nodeTag(node) {
  try {
    return node && node[Symbol.toStringTag] ? String(node[Symbol.toStringTag]) : '';
  } catch (e) {
    return '';
  }
}

function isRasterNode(node) {
  if (!node) return false;
  try {
    if (node.isRasterNode || node.isImageNode) return true;
  } catch (e) {}
  const tag = nodeTag(node).toLowerCase();
  return tag.includes('raster') || tag.includes('image');
}

function findRasterNode(node) {
  if (!node) return null;
  if (isRasterNode(node)) return node;
  if (node.children) {
    for (let i = 0; i < node.children.length; i++) {
      const found = findRasterNode(node.children.at(i));
      if (found) return found;
    }
  }
  return null;
}

function getSelectedRasterNode(doc) {
  const sel = doc && doc.selection;
  if (sel) {
    try {
      if (sel.nodes) {
        for (const n of sel.nodes) {
          const r = findRasterNode(n);
          if (r) return r;
        }
      }
    } catch (e) {}

    try {
      const len = sel.length || 0;
      for (let i = 0; i < len; i++) {
        const item = sel.at(i);
        const n = item && item.node ? item.node : item;
        const r = findRasterNode(n);
        if (r) return r;
      }
    } catch (e) {}
  }

  if (doc && doc.layers) {
    for (let i = 0; i < doc.layers.length; i++) {
      const r = findRasterNode(doc.layers.at(i));
      if (r) return r;
    }
  }

  return null;
}

function getNodeSpreadBox(node) {
  try {
    const exact = node.exactSpreadBaseBox;
    if (exact && isFinite(exact.x) && isFinite(exact.width)) return exact;
  } catch (e) {}
  try {
    const b = node.spreadBaseBox;
    if (b && isFinite(b.x) && isFinite(b.width)) return b;
  } catch (e) {}
  try {
    const b = node.baseBox;
    if (b && isFinite(b.x) && isFinite(b.width)) return b;
  } catch (e) {}
  return { x: 0, y: 0, width: 100, height: 100 };
}

function getNodeDescription(node) {
  try {
    if (node.userDescription) return node.userDescription;
    if (node.defaultDescription) return node.defaultDescription;
  } catch (e) {}
  const tag = nodeTag(node).replace('Node', '');
  return tag || 'Pixel Layer';
}

function getControlIndex(ctrl, fallback = 0) {
  if (!ctrl) return fallback;
  if (typeof ctrl.selectedIndex === 'number' && !isNaN(ctrl.selectedIndex)) {
    return ctrl.selectedIndex;
  }
  if (typeof ctrl.value === 'number' && !isNaN(ctrl.value)) {
    return ctrl.value;
  }
  return fallback;
}

function extractPixelData(node) {
  const engine = NodeRenderingEngine.createDefault(node, RasterFormat.RGBA8);
  const width = engine.width;
  const height = engine.height;
  const buf = engine.createCompatibleBuffer(true);
  const arr = new Uint8Array(buf.buffer);
  return { width, height, arr };
}

function guessBackgroundColor(arr, width, height) {
  const counts = new Map();
  function sample(idx) {
    const a = arr[idx + 3];
    if (a < 20) return;
    const r = (arr[idx] >> 3) << 3;
    const g = (arr[idx + 1] >> 3) << 3;
    const b = (arr[idx + 2] >> 3) << 3;
    const key = (r << 16) | (g << 8) | b;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  for (let x = 0; x < width; x++) {
    sample(x * 4);
    sample(((height - 1) * width + x) * 4);
  }
  for (let y = 0; y < height; y++) {
    sample((y * width) * 4);
    sample((y * width + (width - 1)) * 4);
  }

  let maxCount = 0;
  let bestKey = null;
  for (const [key, count] of counts.entries()) {
    if (count > maxCount) {
      maxCount = count;
      bestKey = key;
    }
  }

  if (bestKey === null) return { r: 255, g: 255, b: 255 };
  return {
    r: (bestKey >> 16) & 255,
    g: (bestKey >> 8) & 255,
    b: bestKey & 255
  };
}

function isColorClose(r1, g1, b1, r2, g2, b2, tolFrac) {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt(dr * dr + dg * dg + db * db) <= tolFrac * 441.67;
}

function runCCL(arr, w, h, mode, alphaThresh, tolPercent, bgColor, minPixelSize, hasTransparency) {
  const tolFrac = tolPercent / 100;
  const labels = new Int32Array(w * h);
  let nextLabel = 1;
  const parent = [0];

  function findRoot(i) {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    let curr = i;
    while (curr !== root) {
      const nxt = parent[curr];
      parent[curr] = root;
      curr = nxt;
    }
    return root;
  }

  function union(i, j) {
    const rootI = findRoot(i);
    const rootJ = findRoot(j);
    if (rootI !== rootJ) {
      if (rootI < rootJ) parent[rootJ] = rootI;
      else parent[rootI] = rootJ;
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const pIdx = idx * 4;
      const a = arr[pIdx + 3];

      let isFg = false;
      if (mode === 0) {
        isFg = a >= alphaThresh;
      } else if (mode === 1) {
        if (a < 10) {
          isFg = false;
        } else {
          const r = arr[pIdx];
          const g = arr[pIdx + 1];
          const b = arr[pIdx + 2];
          isFg = !isColorClose(r, g, b, bgColor.r, bgColor.g, bgColor.b, tolFrac);
        }
      } else {
        if (hasTransparency) {
          isFg = a >= alphaThresh;
        } else {
          const r = arr[pIdx];
          const g = arr[pIdx + 1];
          const b = arr[pIdx + 2];
          isFg = !isColorClose(r, g, b, bgColor.r, bgColor.g, bgColor.b, tolFrac);
        }
      }

      if (!isFg) continue;

      const nbrs = [];
      if (y > 0) {
        if (x > 0 && labels[(y - 1) * w + (x - 1)] > 0) nbrs.push(labels[(y - 1) * w + (x - 1)]);
        if (labels[(y - 1) * w + x] > 0) nbrs.push(labels[(y - 1) * w + x]);
        if (x + 1 < w && labels[(y - 1) * w + (x + 1)] > 0) nbrs.push(labels[(y - 1) * w + (x + 1)]);
      }
      if (x > 0 && labels[y * w + (x - 1)] > 0) nbrs.push(labels[y * w + (x - 1)]);

      if (nbrs.length === 0) {
        const lbl = nextLabel++;
        parent.push(lbl);
        labels[idx] = lbl;
      } else {
        const firstRoot = findRoot(nbrs[0]);
        labels[idx] = firstRoot;
        for (let k = 1; k < nbrs.length; k++) {
          union(firstRoot, nbrs[k]);
        }
      }
    }
  }

  const compMap = new Map();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const lbl = labels[idx];
      if (lbl > 0) {
        const root = findRoot(lbl);
        labels[idx] = root;
        let comp = compMap.get(root);
        if (!comp) {
          comp = {
            root: root,
            minX: x, maxX: x,
            minY: y, maxY: y,
            pixelCount: 0
          };
          compMap.set(root, comp);
        } else {
          if (x < comp.minX) comp.minX = x;
          if (x > comp.maxX) comp.maxX = x;
          if (y < comp.minY) comp.minY = y;
          if (y > comp.maxY) comp.maxY = y;
        }
        comp.pixelCount++;
      }
    }
  }

  const validComps = Array.from(compMap.values()).filter(c => c.pixelCount >= minPixelSize);
  return { labels, validComps };
}

function sortComponents(comps, sortMode) {
  const sorted = [...comps];
  if (sortMode === 0) {
    sorted.sort((a, b) => {
      if (Math.abs(a.minY - b.minY) > 20) return a.minY - b.minY;
      return a.minX - b.minX;
    });
  } else if (sortMode === 1) {
    sorted.sort((a, b) => a.minX - b.minX);
  } else if (sortMode === 2) {
    sorted.sort((a, b) => a.minY - b.minY);
  } else if (sortMode === 3) {
    sorted.sort((a, b) => b.pixelCount - a.pixelCount);
  } else if (sortMode === 4) {
    sorted.sort((a, b) => a.pixelCount - b.pixelCount);
  }
  return sorted;
}

function main() {
  const doc = getCurrentDocument();
  if (!doc) {
    app.alert('Please open a document in Affinity first.');
    return;
  }

  const rasterNode = getSelectedRasterNode(doc);
  if (!rasterNode) {
    app.alert(
      'No Pixel or Image layer found in selection or document.\n\n' +
      'Please select the Pixel/Raster layer containing your assets and run the script again.'
    );
    return;
  }

  let pixelData;
  try {
    pixelData = extractPixelData(rasterNode);
  } catch (e) {
    app.alert('Failed to read image pixel data: ' + e.message);
    return;
  }

  const { width: imgW, height: imgH, arr } = pixelData;
  if (imgW <= 0 || imgH <= 0) {
    app.alert('Invalid layer dimensions.');
    return;
  }

  const rBox = getNodeSpreadBox(rasterNode);
  const scaleX = rBox.width / imgW;
  const scaleY = rBox.height / imgH;
  const layerName = getNodeDescription(rasterNode);

  let transparentCount = 0;
  const totalPix = imgW * imgH;
  const checkStep = Math.max(1, Math.floor(totalPix / 5000));
  for (let i = 0; i < arr.length; i += 4 * checkStep) {
    if (arr[i + 3] < 20) transparentCount++;
  }
  const hasTransparency = transparentCount > (totalPix / checkStep) * 0.02;
  const detectedBg = guessBackgroundColor(arr, imgW, imgH);

  const defaultMode = hasTransparency ? 0 : 1;
  const initResult = runCCL(arr, imgW, imgH, defaultMode, 10, 15, detectedBg, 15, hasTransparency);

  const dlg = Dialog.create(SCRIPT_NAME);
  try { dlg.initialWidth = 380; } catch (e) {}
  const col = dlg.addColumn();

  const grpInfo = col.addGroup('Source Layer Info');
  grpInfo.addStaticText('', `Layer: ${layerName} (${imgW} × ${imgH} px)`).setIsFullWidth(true);
  grpInfo.addStaticText('', `Mode: Direct Loose Layers (No Container)`).setIsFullWidth(true);

  const grpMode = col.addGroup('Separation & Detection Mode');
  const modeCombo = grpMode.addComboBox('Detection Mode', [
    'Transparent Background (Alpha Channel)',
    'Solid Background Color (White / Custom)',
    'Auto-Detect (Alpha if present, else Color)'
  ], defaultMode);

  const grpSensitivity = col.addGroup('Sensitivity & Filters');
  const alphaSlider = grpSensitivity.addUnitValueEditor('Alpha Threshold', UnitType.Number, UnitType.Number, 10, 1, 254)
    .setShowPopupSlider(true)
    .setPrecision(0);
  const bgTolSlider = grpSensitivity.addUnitValueEditor('BG Color Tol %', UnitType.Number, UnitType.Number, 15, 1, 60)
    .setShowPopupSlider(true)
    .setPrecision(0);
  const minSizeSlider = grpSensitivity.addUnitValueEditor('Min Size (Dust Filter)', UnitType.Number, UnitType.Number, 15, 1, 500)
    .setShowPopupSlider(true)
    .setPrecision(0);
  const padSlider = grpSensitivity.addUnitValueEditor('Padding / Margin (px)', UnitType.Number, UnitType.Number, 2, 0, 10)
    .setShowPopupSlider(true)
    .setPrecision(0);

  const liveCountText = grpSensitivity.addStaticText('Detected:', `${initResult.validComps.length} isolated asset(s) found`)
    .setIsFullWidth(true);

  const grpSort = col.addGroup('Organization & Naming');
  const sortCombo = grpSort.addComboBox('Sort Order', [
    'Reading Order (Top to Bottom, Left to Right)',
    'Horizontal (Left to Right)',
    'Vertical (Top to Bottom)',
    'Size (Largest to Smallest)',
    'Size (Smallest to Largest)'
  ], 0);

  const prefixCombo = grpSort.addComboBox('Element Prefix', [
    'Element',
    'Asset',
    'Stroke',
    'Island',
    'Node'
  ], 0);

  const grpOutput = col.addGroup('Output Options');
  const containerModeBtnSet = grpOutput.addButtonSet('Container Mode', [
    'Group',
    'No Group'
  ]);
  // Default to No Group
  containerModeBtnSet.selectedIndex = 1;
  try { containerModeBtnSet.setIsFullWidth(true); } catch (e) {}

  const hideOriginalCheck = grpOutput.addCheckBox('Hide Original Pixel Layer after separating', true);

  function updateLiveCount() {
    const m = getControlIndex(modeCombo, defaultMode);
    const aThresh = Math.round(alphaSlider.value);
    const tol = bgTolSlider.value;
    const minSz = Math.round(minSizeSlider.value);
    const res = runCCL(arr, imgW, imgH, m, aThresh, tol, detectedBg, minSz, hasTransparency);
    liveCountText.text = `${res.validComps.length} isolated asset(s) ready to separate`;
  }

  dlg.onControlValueChangedHandler = () => {
    updateLiveCount();
  };

  const dlgRes = dlg.runModal();
  const isOk = dlgRes && (
    dlgRes === DialogResult.Ok ||
    dlgRes.value === DialogResult.Ok.value ||
    String(dlgRes) === 'Ok' ||
    dlgRes.value === 1
  );

  if (!isOk) {
    return;
  }

  const chosenMode = getControlIndex(modeCombo, defaultMode);
  const chosenAlpha = Math.round(alphaSlider.value);
  const chosenTol = bgTolSlider.value;
  const chosenMinSize = Math.round(minSizeSlider.value);
  const padding = Math.max(0, Math.round(padSlider.value));
  const sortMode = getControlIndex(sortCombo, 0);
  const prefixList = ['Element', 'Asset', 'Stroke', 'Island', 'Node'];
  const chosenPrefixIdx = getControlIndex(prefixCombo, 0);
  const elementPrefix = prefixList[chosenPrefixIdx] || 'Element';
  const useContainer = (getControlIndex(containerModeBtnSet, 1) === 0);
  const hideOriginal = hideOriginalCheck.value;

  const { labels, validComps } = runCCL(
    arr, imgW, imgH,
    chosenMode, chosenAlpha, chosenTol, detectedBg, chosenMinSize, hasTransparency
  );

  if (validComps.length === 0) {
    app.alert('No separate assets found with the chosen thresholds. Please adjust the sensitivity.');
    return;
  }

  const sortedComps = sortComponents(validComps, sortMode);

  let targetContainer = null;

  if (useContainer) {
    const gBuilder = AddChildNodesCommandBuilder.create();
    gBuilder.setInsertionTargetSelection(rasterNode.selfSelection);
    gBuilder.setInsertionMode(InsertionMode.Top);
    gBuilder.addContainerNode(ContainerNodeDefinition.create(`${CONTAINER_PREFIX} (${layerName})`));
    const cmdContainer = gBuilder.createCommand(false, NodeChildType.Main);
    doc.executeCommand(cmdContainer);

    targetContainer = cmdContainer.newNodes && cmdContainer.newNodes.length > 0 ? cmdContainer.newNodes[0] : null;
    if (!targetContainer) {
      app.alert('Failed to create container group.');
      return;
    }
  }

  const childBuilder = AddChildNodesCommandBuilder.create();
  if (useContainer && targetContainer) {
    childBuilder.setInsertionTargetSelection(targetContainer.selfSelection);
    childBuilder.setInsertionMode(InsertionMode.Inside_AtFront);
  } else {
    childBuilder.setInsertionTargetSelection(rasterNode.selfSelection);
    childBuilder.setInsertionMode(InsertionMode.Top);
  }

  for (let i = sortedComps.length - 1; i >= 0; i--) {
    const comp = sortedComps[i];
    const pMinX = Math.max(0, comp.minX - padding);
    const pMaxX = Math.min(imgW - 1, comp.maxX + padding);
    const pMinY = Math.max(0, comp.minY - padding);
    const pMaxY = Math.min(imgH - 1, comp.maxY + padding);
    const compW = pMaxX - pMinX + 1;
    const compH = pMaxY - pMinY + 1;

    const islandBuf = PixelBuffer.create(compW, compH, RasterFormat.RGBA8);
    const islandArr = new Uint8Array(islandBuf.buffer);

    for (let cy = pMinY; cy <= pMaxY; cy++) {
      for (let cx = pMinX; cx <= pMaxX; cx++) {
        const srcIdx = cy * imgW + cx;
        const dstIdx = ((cy - pMinY) * compW + (cx - pMinX)) * 4;

        if (labels[srcIdx] === comp.root) {
          islandArr[dstIdx] = arr[srcIdx * 4];
          islandArr[dstIdx + 1] = arr[srcIdx * 4 + 1];
          islandArr[dstIdx + 2] = arr[srcIdx * 4 + 2];
          islandArr[dstIdx + 3] = arr[srcIdx * 4 + 3];
        } else {
          islandArr[dstIdx + 3] = 0;
        }
      }
    }

    const bmp = islandBuf.createCompatibleBitmap(true);
    const imgDef = ImageNodeDefinition.create(RasterFormat.RGBA8);
    imgDef.bitmap = bmp;
    imgDef.userDescription = `${elementPrefix} ${i + 1}`;

    const canvasX = rBox.x + pMinX * scaleX;
    const canvasY = rBox.y + pMinY * scaleY;
    imgDef.transform = Transform.createTranslate(canvasX, canvasY).multiply(Transform.createScale(scaleX, scaleY));

    childBuilder.addImageNode(imgDef);
  }

  const cmdChildren = childBuilder.createCommand(false, NodeChildType.Main);
  doc.executeCommand(cmdChildren);

  if (hideOriginal) {
    try {
      doc.executeCommand(DocumentCommand.createHideSelection(rasterNode.selfSelection));
    } catch (e) {}
  }

  try {
    if (useContainer && targetContainer) {
      doc.selection = Selection.create(doc, targetContainer);
    } else if (cmdChildren.newNodes && cmdChildren.newNodes.length > 0) {
      doc.selection = Selection.create(doc, cmdChildren.newNodes);
    }
  } catch (e) {}
}

main();
