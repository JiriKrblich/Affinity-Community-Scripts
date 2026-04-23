/**
name: Randomize Objects
version: 1.0.1
description: Randomization of size, position, rotation, skew, opacity, color, and stroke of selected objects.
*/

"use strict";

const { Document } = require("/document");
const { Dialog, DialogResult } = require("/dialog");
const { UnitType } = require("/units");
const { Transform } = require("/geometry");
const { DocumentCommand, CompoundCommandBuilder } = require("/commands");
const { Selection } = require("/selections");
const { Colour } = require("/colours");
const { TagInterfaceApi } = require("affinity:dom");

// --------------------------------------------------
// Settings
// --------------------------------------------------

const TAG_KEY = "rnd_v5_settings";

const DEFAULTS = {
  str: 50,
  dist: 0,
  dir: 1,

  doSize: true,
  doPos: true,

  doRot: false,
  doSkew: false,

  doOpac: false,
  doColor: false,
  doStroke: false,

  live: false,
};

function findStorageNode(doc) {
  if (!doc.spreads.length) return null;

  const spread = doc.spreads[0];

  if (!spread.layers.length) return null;

  return spread.layers[0];
}

function loadSettings(doc) {
  try {
    const n = findStorageNode(doc);

    if (!n) return Object.assign({}, DEFAULTS);

    const ti = TagInterfaceApi.fromNode(n.handle);

    if (TagInterfaceApi.hasKey(ti, TAG_KEY)) {
      return Object.assign(
        {},
        DEFAULTS,
        JSON.parse(TagInterfaceApi.getValueForKey(ti, TAG_KEY)),
      );
    }
  } catch (e) {}

  return Object.assign({}, DEFAULTS);
}

function saveSettings(doc, s) {
  try {
    const n = findStorageNode(doc);

    if (!n) return;

    const sel = n.selfSelection;

    doc.executeCommand(
      DocumentCommand.createSetTagValueForKey(
        sel,
        TAG_KEY,
        JSON.stringify({
          str: s.str,
          dist: s.dist,
          dir: s.dir,

          doSize: s.doSize,
          doPos: s.doPos,
          doRot: s.doRot,
          doSkew: s.doSkew,

          doOpac: s.doOpac,
          doColor: s.doColor,
          doStroke: s.doStroke,

          live: s.live,
        }),
      ),
    );
  } catch (e) {}
}

// --------------------------------------------------
// Noise
// --------------------------------------------------

function hash(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;

  return x - Math.floor(x);
}

function perlin1D(x) {
  const xi = Math.floor(x);

  const xf = x - xi;

  const u = xf * xf * (3 - 2 * xf);

  return hash(xi) + u * (hash(xi + 1) - hash(xi));
}

function gaussian(s) {
  const u1 = Math.max(1e-10, hash(s));

  const u2 = hash(s + 17.31);

  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function rawNoise(seed, type) {
  if (type === 0) return hash(seed) * 2 - 1;

  if (type === 1) return perlin1D(seed * 0.07) * 2 - 1;

  return Math.max(-1, Math.min(1, gaussian(seed) / 3));
}

function applyDir(v, dir) {
  if (dir === 0) return -Math.abs(v);

  if (dir === 2) return Math.abs(v);

  return v;
}

function getPerlinOffset(ni, origBoxes, spread) {
  if (!spread) return { ox: 0, oy: 0 };

  const sb = spread.getSpreadExtents({ includeSpread: true });

  const bb = origBoxes[ni];

  if (!sb || !bb) return { ox: 0, oy: 0 };

  const ox = sb.x + sb.width * 0.5;

  const oy = sb.y + sb.height * 0.5;

  return {
    ox: (bb.x + bb.width * 0.5 - ox) * 0.002,

    oy: (bb.y + bb.height * 0.5 - oy) * 0.002,
  };
}

function noiseVal(seed, type, i, ni, origBoxes, spread) {
  if (type === 1) {
    const { ox, oy } = getPerlinOffset(ni, origBoxes, spread);

    return perlin1D((seed + ox + oy + i * 0.37) * 0.07) * 2 - 1;
  }

  return rawNoise(seed + i * 17, type);
}

function fromCenterOrig(bb, xf) {
  if (!bb) return xf;

  const cx = bb.x + bb.width * 0.5;

  const cy = bb.y + bb.height * 0.5;

  return Transform.createTranslate(cx, cy).multiply(
    xf.multiply(Transform.createTranslate(-cx, -cy)),
  );
}

function randomSeed() {
  return Math.floor(Math.random() * 99999);
}

// --------------------------------------------------
// Commands
// --------------------------------------------------

function buildCmds(doc, nodes, origBoxes, s) {
  const cmds = [];

  function r(i, o) {
    return applyDir(
      noiseVal(s.seed + o * 3, s.dist, i, i, origBoxes, s.spread),

      s.dir,
    );
  }

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];

    if (node.isEditable === false) continue;

    const bb = origBoxes[i];

    const sel = Selection.create(doc, node);

    if (s.doPos) {
      cmds.push(
        DocumentCommand.createTransform(
          sel,

          Transform.createTranslate(
            ((r(i, 1) * s.str) / 100) * 300,

            ((r(i, 2) * s.str) / 100) * 300,
          ),
        ),
      );
    }

    if (s.doSize) {
      const sc = Math.max(
        0.05,

        1 + ((r(i, 3) * s.str) / 100) * 2,
      );

      cmds.push(
        DocumentCommand.createTransform(
          sel,

          fromCenterOrig(
            bb,

            Transform.createScale(sc, sc),
          ),
        ),
      );
    }

    if (s.doRot) {
      cmds.push(
        DocumentCommand.createTransform(
          sel,

          fromCenterOrig(
            bb,

            Transform.createRotate(((r(i, 4) * s.str) / 100) * Math.PI * 2),
          ),
        ),
      );
    }

    if (s.doSkew) {
      cmds.push(
        DocumentCommand.createTransform(
          sel,

          fromCenterOrig(
            bb,

            Transform.createShear(
              ((r(i, 5) * s.str) / 100) * 0.5,

              ((r(i, 6) * s.str) / 100) * 0.5,
            ),
          ),
        ),
      );
    }

    if (s.doOpac) {
      const cur = node.globalOpacity !== undefined ? node.globalOpacity : 1;

      cmds.push(
        DocumentCommand.createSetOpacity(
          sel,

          Math.max(
            0,

            Math.min(
              1,

              cur + (r(i, 9) * s.str) / 100,
            ),
          ),
        ),
      );
    }

    if (s.doColor && node.hasBrushFill === true) {
      try {
        const fill = node.brushFillDescriptor.fill;

        if (fill && fill.colour) {
          const h = fill.colour.getHSLAf();

          cmds.push(
            DocumentCommand.createSetBrushFill(
              sel,

              Colour.createHSLAf({
                h: (((h.h + ((r(i, 7) * s.str) / 100) * 0.5) % 1) + 1) % 1,

                s: Math.max(
                  0,
                  Math.min(1, h.s + ((r(i, 10) * s.str) / 100) * 0.3),
                ),

                l: Math.max(
                  0.05,
                  Math.min(0.95, h.l + ((r(i, 11) * s.str) / 100) * 0.2),
                ),

                alpha: h.alpha,
              }),
            ),
          );
        }
      } catch (e) {}
    }

    if (s.doStroke) {
      try {
        const ld = node.lineStyleDescriptor;

        if (ld) {
          const ls = ld.lineStyle.clone();

          ls.weight = Math.max(
            0.1,

            ls.weight + ((r(i, 8) * s.str) / 100) * 10,
          );

          cmds.push(
            DocumentCommand.createSetLineStyleDescriptor(
              sel,
              ld.cloneWithNewLineStyle(ls),
            ),
          );
        }
      } catch (e) {}
    }
  }

  return cmds;
}

function execCmds(doc, cmds, preview) {
  if (!cmds.length) return false;

  if (cmds.length === 1) {
    doc.executeCommand(cmds[0], preview);

    return true;
  }

  const b = CompoundCommandBuilder.create();

  for (const c of cmds) b.addCommand(c);

  doc.executeCommand(b.createCommand(), preview);

  return true;
}

// --------------------------------------------------
// Dialog
// --------------------------------------------------

function buildDialog(sv) {
  const dlg = Dialog.create("Randomize Objects");

  dlg.initialWidth = 250;

  const col = dlg.addColumn();

  const grpStr = col.addGroup("");
  grpStr.enableSeparator = false;

  const strCtrl = grpStr.addUnitValueEditor(
    "Strength %",
    UnitType.Percent,
    UnitType.Percent,
    sv.str,
    0,
    100,
  );

  const grpDist = col.addGroup("");
  const distBtn = grpDist.addButtonSet(
    "Distribution",
    ["Random", "Perlin", "Gaussian"],
    sv.dist,
  );

  const grpDir = col.addGroup("");
  const dirBtn = grpDir.addButtonSet("Direction", ["−", "±", "+"], sv.dir);

  const chkGrp = col.addGroup("");

  const chkSize = chkGrp.addCheckBox("Size", sv.doSize);

  const chkPos = chkGrp.addCheckBox("Position", sv.doPos);

  const chkRot = chkGrp.addCheckBox("Rotation", sv.doRot);

  const chkOpac = chkGrp.addCheckBox("Opacity", sv.doOpac);

  const chkSkew = chkGrp.addCheckBox("Skew", sv.doSkew);

  const chkColor = chkGrp.addCheckBox("Color", sv.doColor);

  const chkStroke = chkGrp.addCheckBox("Stroke", sv.doStroke);

  const previewGrp = col.addGroup("");

  const liveSwitch = previewGrp.addSwitch("Live Preview", sv.live);

  function getState() {
    return {
      str: strCtrl.value,
      dist: distBtn.selectedIndex,
      dir: dirBtn.selectedIndex,

      doSize: chkSize.value,
      doPos: chkPos.value,
      doRot: chkRot.value,
      doOpac: chkOpac.value,
      doSkew: chkSkew.value,
      doColor: chkColor.value,
      doStroke: chkStroke.value,

      live: liveSwitch.value,
    };
  }

  return {
    dlg,
    getState,
  };
}

// --------------------------------------------------
// Main
// --------------------------------------------------

const doc = Document.current;

if (!doc) {
  const d = Dialog.create("Randomize Objects");

  d.addColumn().addGroup("").addStaticText("", "No document open.");

  d.runModal();
} else {
  const nodes = [];

  for (const n of doc.selection.nodes) {
    nodes.push(n);
  }

  if (!nodes.length) {
    const d = Dialog.create("Randomize Objects");

    d.addColumn()
      .addGroup("")
      .addStaticText("", "Select at least one object first.");

    d.runModal();
  } else {
    const spread = doc.currentSpread;

    const origBoxes = nodes.map((n) => {
      try {
        return n.getSpreadBaseBox(false);
      } catch (e) {
        return null;
      }
    });

    let sv = Object.assign({}, loadSettings(doc), { spread });

    let previewActive = false;
    let lastPreviewSeed = null;

    let running = true;

    while (running) {
      const { dlg, getState } = buildDialog(sv);

      const result = dlg.runModal();

      const state = Object.assign(getState(), { spread });

      if (result.value !== DialogResult.Ok.value) {
        if (previewActive) doc.clearPreviews();

        saveSettings(
          doc,
          Object.assign({}, sv, {
            live: state.live,
          }),
        );

        break;
      }

      if (state.live) {
        const seed = randomSeed();

        lastPreviewSeed = seed;

        if (previewActive) doc.clearPreviews();

        const cmds = buildCmds(
          doc,
          nodes,
          origBoxes,
          Object.assign({}, state, { seed }),
        );

        previewActive = execCmds(doc, cmds, true);

        sv = Object.assign({}, state);
      } else {
        if (previewActive) doc.clearPreviews();

        const seed = lastPreviewSeed !== null ? lastPreviewSeed : randomSeed();

        const cmds = buildCmds(
          doc,
          nodes,
          origBoxes,
          Object.assign({}, state, { seed }),
        );

        execCmds(doc, cmds, false);

        saveSettings(doc, state);

        running = false;
      }
    }
  }
}
