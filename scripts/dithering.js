/**
 * name: Dithering
 * description: Error-diffusion and ordered dithering for selected layers.
 * version: 1.0.0
 * author: bitmancer
 */
"use strict";

// ═══════════════════════════════════════════════════════════════════════
// Imports
// ═══════════════════════════════════════════════════════════════════════

const { app } = require("/application");
const { Document } = require("/document");
const { Selection } = require("/selections");
const { DocumentCommand } = require("/commands");
const { RasterFormat } = require("/rasterobject");
const { Dialog, DialogResult } = require("/dialog");
const { UnitType } = require("/units");
const { Rectangle } = require("/geometry");
const { File } = require("/fs");
const { Buffer } = require("/buffer");

// ═══════════════════════════════════════════════════════════════════════
// Pixel format dispatch
// ═══════════════════════════════════════════════════════════════════════

const FORMATS = {
  [RasterFormat.RGBA8.value]: { Arr: Uint8Array, max: 255, layout: "rgba" },
  [RasterFormat.RGBA16.value]: { Arr: Uint16Array, max: 65535, layout: "rgba" },
  [RasterFormat.IA8.value]: { Arr: Uint8Array, max: 255, layout: "ia" },
  [RasterFormat.IA16.value]: { Arr: Uint16Array, max: 65535, layout: "ia" },
};

const REC709_R = 0.2126;
const REC709_G = 0.7152;
const REC709_B = 0.0722;

// ═══════════════════════════════════════════════════════════════════════
// Dither kernels
// ═══════════════════════════════════════════════════════════════════════

const ED_KERNELS = {
  "floyd-steinberg": {
    div: 16,
    k: [
      [1, 0, 7],
      [-1, 1, 3],
      [0, 1, 5],
      [1, 1, 1],
    ],
  },
  atkinson: {
    div: 8,
    k: [
      [1, 0, 1],
      [2, 0, 1],
      [-1, 1, 1],
      [0, 1, 1],
      [1, 1, 1],
      [0, 2, 1],
    ],
  },
  burkes: {
    div: 32,
    k: [
      [1, 0, 8],
      [2, 0, 4],
      [-2, 1, 2],
      [-1, 1, 4],
      [0, 1, 8],
      [1, 1, 4],
      [2, 1, 2],
    ],
  },
  sierra: {
    div: 32,
    k: [
      [1, 0, 5],
      [2, 0, 3],
      [-2, 1, 2],
      [-1, 1, 4],
      [0, 1, 5],
      [1, 1, 4],
      [2, 1, 2],
      [-1, 2, 2],
      [0, 2, 3],
      [1, 2, 2],
    ],
  },
  "sierra-2": {
    div: 16,
    k: [
      [1, 0, 4],
      [2, 0, 3],
      [-2, 1, 1],
      [-1, 1, 2],
      [0, 1, 3],
      [1, 1, 2],
      [2, 1, 1],
    ],
  },
  "sierra-lite": {
    div: 4,
    k: [
      [1, 0, 2],
      [-1, 1, 1],
      [0, 1, 1],
    ],
  },
  stucki: {
    div: 42,
    k: [
      [1, 0, 8],
      [2, 0, 4],
      [-2, 1, 2],
      [-1, 1, 4],
      [0, 1, 8],
      [1, 1, 4],
      [2, 1, 2],
      [-2, 2, 1],
      [-1, 2, 2],
      [0, 2, 4],
      [1, 2, 2],
      [2, 2, 1],
    ],
  },
  jarvis: {
    div: 48,
    k: [
      [1, 0, 7],
      [2, 0, 5],
      [-2, 1, 3],
      [-1, 1, 5],
      [0, 1, 7],
      [1, 1, 5],
      [2, 1, 3],
      [-2, 2, 1],
      [-1, 2, 3],
      [0, 2, 5],
      [1, 2, 3],
      [2, 2, 1],
    ],
  },
};

// Bayer matrices
const BAYER_2 = [
  [0, 2],
  [3, 1],
];
const BAYER_4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];
const BAYER_8 = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];

// ═══════════════════════════════════════════════════════════════════════
// Dither functions
// ═══════════════════════════════════════════════════════════════════════

function runErrorDiffusion(gray, W, H, kernel, strength) {
  const k = kernel.k;
  const inv = 1 / kernel.div;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const old = gray[i];
      const nv = old < 0.5 ? 0 : 1;
      gray[i] = nv;
      const err = (old - nv) * strength;
      if (err === 0) continue;
      for (let j = 0; j < k.length; j++) {
        const dx = k[j][0],
          dy = k[j][1],
          w = k[j][2];
        const nx = x + dx,
          ny = y + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        gray[ny * W + nx] += err * w * inv;
      }
    }
  }
}

function runBayer(gray, W, H, matrix, strength) {
  const n = matrix.length;
  const m2 = n * n;
  for (let y = 0; y < H; y++) {
    const row = matrix[y % n];
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const t = 0.5 + (row[x % n] / m2 - 0.5) * strength;
      gray[i] = gray[i] < t ? 0 : 1;
    }
  }
}

function runThreshold(gray, W, H) {
  const N = W * H;
  for (let i = 0; i < N; i++) gray[i] = gray[i] < 0.5 ? 0 : 1;
}

const ALGOS = {
  "Floyd-Steinberg": (g, W, H, s) =>
    runErrorDiffusion(g, W, H, ED_KERNELS["floyd-steinberg"], s),
  Atkinson: (g, W, H, s) =>
    runErrorDiffusion(g, W, H, ED_KERNELS["atkinson"], s),
  Burkes: (g, W, H, s) => runErrorDiffusion(g, W, H, ED_KERNELS["burkes"], s),
  Sierra: (g, W, H, s) => runErrorDiffusion(g, W, H, ED_KERNELS["sierra"], s),
  "Sierra-2": (g, W, H, s) =>
    runErrorDiffusion(g, W, H, ED_KERNELS["sierra-2"], s),
  "Sierra Lite": (g, W, H, s) =>
    runErrorDiffusion(g, W, H, ED_KERNELS["sierra-lite"], s),
  Stucki: (g, W, H, s) => runErrorDiffusion(g, W, H, ED_KERNELS["stucki"], s),
  Jarvis: (g, W, H, s) => runErrorDiffusion(g, W, H, ED_KERNELS["jarvis"], s),
  "Bayer 2×2": (g, W, H, s) => runBayer(g, W, H, BAYER_2, s),
  "Bayer 4×4": (g, W, H, s) => runBayer(g, W, H, BAYER_4, s),
  "Bayer 8×8": (g, W, H, s) => runBayer(g, W, H, BAYER_8, s),
  Threshold: (g, W, H, s) => runThreshold(g, W, H),
};

const ALGO_NAMES = Object.keys(ALGOS);

// ═══════════════════════════════════════════════════════════════════════
// Dither pipeline
// ═══════════════════════════════════════════════════════════════════════

function dither(doc, workingNode, params) {
  const pbuf = workingNode.rasterInterface.createCompatibleBuffer(true);
  const fmt = FORMATS[pbuf.format];
  if (!fmt) throw new Error("Unsupported raster format: " + pbuf.format);

  const W = pbuf.width,
    H = pbuf.height,
    N = W * H;
  const M = fmt.max;
  const arr = new fmt.Arr(pbuf.buffer);

  // 1. Grayscale extraction
  const gray = new Float32Array(N);
  const Minv = 1 / M;
  if (fmt.layout === "rgba") {
    for (let i = 0, j = 0; i < N; i++, j += 4) {
      gray[i] =
        (REC709_R * arr[j] + REC709_G * arr[j + 1] + REC709_B * arr[j + 2]) *
        Minv;
    }
  } else {
    for (let i = 0, j = 0; i < N; i++, j += 2) {
      gray[i] = arr[j] * Minv;
    }
  }

  // 2. Resolution downscale
  const r = Math.min(1, Math.max(0.01, params.resolution));
  const block = Math.max(1, Math.round(1 / r));
  const Wd = Math.max(1, Math.floor(W / block));
  const Hd = Math.max(1, Math.floor(H / block));

  let grid;
  if (block === 1) {
    grid = gray;
  } else {
    grid = new Float32Array(Wd * Hd);
    const blockArea = block * block;
    for (let by = 0; by < Hd; by++) {
      for (let bx = 0; bx < Wd; bx++) {
        let s = 0;
        const y0 = by * block,
          x0 = bx * block;
        for (let dy = 0; dy < block; dy++) {
          const row = (y0 + dy) * W;
          for (let dx = 0; dx < block; dx++) s += gray[row + x0 + dx];
        }
        grid[by * Wd + bx] = s / blockArea;
      }
    }
  }

  // 3. Apply Threshold bias
  const bias = 0.5 - params.threshold;
  if (bias !== 0) {
    const Ng = grid.length;
    for (let i = 0; i < Ng; i++) grid[i] += bias;
  }

  // 4. Dither
  const algo = ALGOS[params.algorithm];
  if (!algo) throw new Error("Unknown algorithm: " + params.algorithm);
  algo(grid, Wd, Hd, params.strength);

  // 5. Write back
  const transparent = !!params.transparent;
  if (fmt.layout === "rgba") {
    if (block === 1) {
      for (let i = 0, j = 0; i < N; i++, j += 4) {
        const bit = grid[i] >= 0.5 ? 1 : 0;
        const v = bit ? M : 0;
        arr[j] = v;
        arr[j + 1] = v;
        arr[j + 2] = v;
        if (transparent && bit) arr[j + 3] = 0;
      }
    } else {
      for (let y = 0; y < H; y++) {
        const gy = Math.min(Hd - 1, (y / block) | 0);
        const gyW = gy * Wd;
        for (let x = 0; x < W; x++) {
          const gx = Math.min(Wd - 1, (x / block) | 0);
          const bit = grid[gyW + gx] >= 0.5 ? 1 : 0;
          const j = (y * W + x) * 4;
          const v = bit ? M : 0;
          arr[j] = v;
          arr[j + 1] = v;
          arr[j + 2] = v;
          if (transparent && bit) arr[j + 3] = 0;
        }
      }
    }
  } else {
    // 'ia'
    if (block === 1) {
      for (let i = 0, j = 0; i < N; i++, j += 2) {
        const bit = grid[i] >= 0.5 ? 1 : 0;
        arr[j] = bit ? M : 0;
        if (transparent && bit) arr[j + 1] = 0;
      }
    } else {
      for (let y = 0; y < H; y++) {
        const gy = Math.min(Hd - 1, (y / block) | 0);
        const gyW = gy * Wd;
        for (let x = 0; x < W; x++) {
          const gx = Math.min(Wd - 1, (x / block) | 0);
          const bit = grid[gyW + gx] >= 0.5 ? 1 : 0;
          const j = (y * W + x) * 2;
          arr[j] = bit ? M : 0;
          if (transparent && bit) arr[j + 1] = 0;
        }
      }
    }
  }

  // 6. Commit
  const bmp = workingNode.rasterInterface.createCompatibleBitmap(false);
  const rect = new Rectangle(0, 0, W, H);
  pbuf.copyTo(bmp, rect, 0, 0);

  const sel = Selection.create(doc);
  sel.addNode(workingNode);
  doc.executeCommand(DocumentCommand.createReplaceBitmap(sel, bmp));
  return N;
}

// ═══════════════════════════════════════════════════════════════════════
// Settings persistence
// ═══════════════════════════════════════════════════════════════════════

function getSettingsCandidatePaths() {
  const desktop = app.getUserDesktopPath;
  if (!desktop || typeof desktop !== "string") return [];
  // Normalizace lomítek pro detekci OS
  const isWin = desktop.indexOf("\\") !== -1; // opravený escapování
  const sep = isWin ? "\\" : "/"; // opraveno
  const home = desktop.replace(/[/\\]Desktop[/\\]?$/, ""); // opravený regex
  const file = "dithering-settings.json";
  return [home + sep + "Documents" + sep + file, desktop + sep + file];
}

function loadSettings() {
  for (const path of getSettingsCandidatePaths()) {
    let f = null;
    try {
      f = new File(path); // opraveno – konstruktor bez parametru módu
      if (!f || !f.exists) continue; // zjednodušená kontrola existence
      f.open("r"); // otevření pro čtení
      const len = f.length;
      if (!len) {
        f.close();
        continue;
      }
      const buf = Buffer.create(len);
      f.read(buf, len);
      f.close();
      f = null;
      const raw = JSON.parse(buf.toString());
      return {
        algorithm: raw.algorithm,
        threshold: raw.threshold,
        strength: raw.strength,
        resolution: raw.resolution,
        transparent: !!raw.transparent,
      };
    } catch (e) {
      // pokračuj na další cestu
    } finally {
      if (f && f.isOpen) {
        try {
          f.close();
        } catch (e) {}
      }
    }
  }
  return null;
}

function saveSettings(params) {
  const json = JSON.stringify(
    {
      algorithm: params.algorithm,
      threshold: params.threshold,
      strength: params.strength,
      resolution: params.resolution,
      transparent: !!params.transparent,
    },
    null,
    2,
  );
  for (const path of getSettingsCandidatePaths()) {
    let f = null;
    try {
      f = new File(path); // opraveno
      f.open("w"); // otevření pro zápis
      if (!f.isOpen) continue;
      f.writeStringAsUtf8(json);
      f.close();
      return;
    } catch (e) {
      // další pokus
    } finally {
      if (f && f.isOpen) {
        try {
          f.close();
        } catch (e) {}
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Dialog
// ═══════════════════════════════════════════════════════════════════════

function buildDialog(defaults) {
  const dlg = Dialog.create("Dithering");
  const col = dlg.addColumn();

  const grp = col.addGroup("Controls");
  const algoIndex = Math.max(0, ALGO_NAMES.indexOf(defaults.algorithm));
  dlg.algo = grp.addComboBox("Algorithm", ALGO_NAMES, algoIndex);
  dlg.threshold = grp.addUnitValueEditor(
    "Threshold",
    UnitType.Percentage,
    UnitType.Percentage,
    defaults.threshold * 100,
    0,
    100,
  );
  dlg.strength = grp.addUnitValueEditor(
    "Dither Strength",
    UnitType.Percentage,
    UnitType.Percentage,
    defaults.strength * 100,
    0,
    100,
  );
  dlg.resolution = grp.addUnitValueEditor(
    "Resolution",
    UnitType.Percentage,
    UnitType.Percentage,
    defaults.resolution * 100,
    1,
    100,
  );
  dlg.threshold.showPopupSlider = true;
  dlg.strength.showPopupSlider = true;
  dlg.resolution.showPopupSlider = true;
  dlg.transparent = grp.addCheckBox("Transparent BG", !!defaults.transparent);

  dlg.initialWidth = 320;
  return dlg;
}

function readDialogValues(dlg) {
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  return {
    algorithm: ALGO_NAMES[dlg.algo.selectedIndex],
    threshold: clamp01(dlg.threshold.value / 100),
    strength: clamp01(dlg.strength.value / 100),
    resolution: clamp01(dlg.resolution.value / 100),
    transparent: !!dlg.transparent.value,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════

function main() {
  const doc = Document.current;
  if (!doc) {
    app.alert("Dithering needs an open document.");
    return;
  }

  if (Array.from(doc.selection.nodes).length === 0) {
    app.alert("Select a layer first.");
    return;
  }

  const defaults = {
    algorithm: "Atkinson",
    threshold: 0.5,
    strength: 0.75,
    resolution: 0.5,
    transparent: true,
  };
  const saved = loadSettings();
  const initial = saved ? { ...defaults, ...saved } : defaults;

  const dlg = buildDialog(initial);
  const result = dlg.runModal();
  if (!result.equals(DialogResult.Ok)) return;

  const params = readDialogValues(dlg);

  const rawNodes = Array.from(doc.selection.nodes);
  if (rawNodes.length > 0) {
    const rSel = Selection.create(doc); // opraveno
    rawNodes.forEach((n) => rSel.addNode(n)); // přidání uzlů do selekce
    doc.executeCommand(
      DocumentCommand.createRasteriseObjects(rSel, false, true),
    );
  }

  const freshNodes = Array.from(doc.selection.nodes).filter(
    (n) => n.isRasterNode,
  );
  if (freshNodes.length === 0) {
    app.alert(
      "Selection was cleared. Select a pixel layer and run the script again.",
    );
    return;
  }

  try {
    for (const workingNode of freshNodes) {
      dither(doc, workingNode, params);
    }
  } catch (e) {
    app.alert("Dithering failed: " + (e && e.message ? e.message : e));
    return;
  }
  saveSettings(params);
}

try {
  main();
} catch (e) {
  try {
    app.alert("Dithering failed: " + (e && e.message ? e.message : e));
  } catch (_) {}
}
