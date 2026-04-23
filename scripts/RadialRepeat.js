"use strict";

// ═══════════════════════════════════════════════════════════════════════
// RADIAL REPEAT v4 — Affinity Designer
//
// FIX v3→v4:
// 1. FLIP FIX: rot = +(istep) instead of -(istep)
// 2. POSITION FIX: circle centered at (cx, cy+radius)
// → copy i=0 stays at original source
// → ry = (cy + radius) + radius * sin(a)
// 3. Z-ORDER fix from v2 kept
// ═══════════════════════════════════════════════════════════════════════

const { Document } = require("/document");
const {
  DocumentCommand,
  AddChildNodesCommandBuilder,
  CompoundCommandBuilder,
  NodeChildType,
  NodeMoveType,
} = require("/commands");
const { TransformBuilder } = require("/geometry");
const { ContainerNodeDefinition } = require("/nodes");
const { Dialog, DialogResult } = require("/dialog");
const { Selection } = require("/selections");

const doc = Document.current;
if (!doc) {
  alert("Open a document first.");
} else {
  function undoN(n) {
    for (let i = 0; i < n; i++) doc.undo();
  }
  function validBB(b) {
    return b && b.width > 0 && b.height > 0 && isFinite(b.x) && isFinite(b.y);
  }

  const rawNodes = doc.selection.nodes.toArray().filter(Boolean);
  if (rawNodes.length === 0) {
    alert("Select one or more objects first.");
  } else {
    let origNodes;
    let initSteps = 0;

    if (rawNodes.length === 1) {
      origNodes = [rawNodes[0]];
    } else {
      const fp = rawNodes[0].parent;
      const groupEditMode =
        fp &&
        !fp.isSpreadNode &&
        !fp.isDocumentNode &&
        rawNodes.every((n) => n.parent && n.parent.isSameNode(fp));
      origNodes = groupEditMode ? [fp] : rawNodes;
    }

    const revealCb = CompoundCommandBuilder.create();
    let anyHidden = false;
    for (const n of origNodes) {
      const vi = n.visibilityInterface;
      if (vi && !vi.isVisibleInDomain) {
        revealCb.addCommand(
          DocumentCommand.createSetVisibility(Selection.create(doc, n), true),
        );
        anyHidden = true;
      }
    }
    if (anyHidden) {
      doc.executeCommand(revealCb.createCommand());
      initSteps++;
    }

    const validSrcs = origNodes.filter((n) =>
      validBB(n.getSpreadBaseBox(false)),
    );
    if (validSrcs.length === 0) {
      alert("No visible content to array.");
    } else {
      origNodes = validSrcs;

      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const n of origNodes) {
        const b = n.getSpreadBaseBox(false);
        minX = Math.min(minX, b.x);
        minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.width);
        maxY = Math.max(maxY, b.y + b.height);
      }
      const cx = (minX + maxX) / 2,
        cy = (minY + maxY) / 2;

      function buildXforms(
        instances,
        radius,
        rotEnabled,
        rotDeg,
        scaleStart,
        scaleEnd,
      ) {
        const step = (2 * Math.PI) / instances; // opraveno: 2*Math.PI
        const rotRad = (rotDeg * Math.PI) / 180; // opraveno: rotDeg*Math.PI
        const K = origNodes.length;

        return Array.from({ length: instances }, (_, i) => {
          const src = origNodes[i % K];
          const sBB = src.getSpreadBaseBox(false);
          const sox = sBB.x + sBB.width / 2;
          const soy = sBB.y + sBB.height / 2;

          const a = -Math.PI / 2 + i * step;

          const rx = cx + radius * Math.cos(a);
          const ry = cy + radius + radius * Math.sin(a);

          const rot = rotEnabled ? rotRad : i * step;

          const sc =
            scaleStart +
            (scaleEnd - scaleStart) * (instances > 1 ? i / (instances - 1) : 0);

          const tb = new TransformBuilder();
          if (Math.abs(sc - 1) > 0.0001 || Math.abs(rot) > 0.0001) {
            tb.translate(-sox, -soy);
            if (Math.abs(sc - 1) > 0.0001) tb.scale(sc, sc);
            if (Math.abs(rot) > 0.0001) tb.rotate(rot);
            tb.translate(sox, soy);
          }
          tb.translate(rx - sox, ry - soy);
          return { src, xf: tb.transform };
        });
      }

      function doPreview(
        instances,
        radius,
        rotEnabled,
        rotDeg,
        scaleStart,
        scaleEnd,
      ) {
        const xforms = buildXforms(
          instances,
          radius,
          rotEnabled,
          rotDeg,
          scaleStart,
          scaleEnd,
        );
        const dupCb = CompoundCommandBuilder.create();
        for (const { src, xf } of xforms) {
          dupCb.addCommand(
            DocumentCommand.createTransform(Selection.create(doc, src), xf, {
              duplicateNodes: true,
            }),
          );
        }
        doc.executeCommand(dupCb.createCommand());
        const hideCb = CompoundCommandBuilder.create();
        for (const src of origNodes) {
          hideCb.addCommand(
            DocumentCommand.createSetVisibility(
              Selection.create(doc, src),
              false,
            ),
          );
        }
        doc.executeCommand(hideCb.createCommand());
        return 2;
      }

      function doApply(
        instances,
        radius,
        rotEnabled,
        rotDeg,
        scaleStart,
        scaleEnd,
      ) {
        const xforms = buildXforms(
          instances,
          radius,
          rotEnabled,
          rotDeg,
          scaleStart,
          scaleEnd,
        );
        const cndB = AddChildNodesCommandBuilder.create();
        cndB.addContainerNode(ContainerNodeDefinition.createDefault());
        const cCmd = cndB.createCommand(false, NodeChildType.Main);
        doc.executeCommand(cCmd);
        const containerNode = cCmd.newNodes[0];
        const dupCb = CompoundCommandBuilder.create();
        for (const { src, xf } of xforms) {
          dupCb.addCommand(
            DocumentCommand.createTransform(Selection.create(doc, src), xf, {
              duplicateNodes: true,
            }),
          );
        }
        const dupCmd = dupCb.createCommand();
        doc.executeCommand(dupCmd);
        const dupNodes = dupCmd.newNodes;
        const moveCb = CompoundCommandBuilder.create();
        for (let i = dupNodes.length - 1; i >= 0; i--) {
          const n = dupNodes[i];
          moveCb.addCommand(
            DocumentCommand.createMoveNodes(
              Selection.create(doc, n),
              containerNode,
              NodeMoveType.Inside,
              NodeChildType.Main,
            ),
          );
          moveCb.addCommand(
            DocumentCommand.createSetVisibility(Selection.create(doc, n), true),
          );
        }
        doc.executeCommand(moveCb.createCommand());
        const delCb = CompoundCommandBuilder.create();
        for (const src of origNodes) {
          delCb.addCommand(
            DocumentCommand.createDeleteSelection(
              Selection.create(doc, src),
              false,
            ),
          );
        }
        doc.executeCommand(delCb.createCommand());
        return 4;
      }

      const srcLabel =
        origNodes.length > 1 ? ` — ${origNodes.length} alternating` : ""; // opraven kódovaný em‑dash
      const dlg = Dialog.create(`Radial Repeat${srcLabel}`); // doplněny zpětné uvozovky
      const col = dlg.addColumn();

      const grpDist = col.addGroup("Distribution");
      const instEd = grpDist.addUnitValueEditor(
        "Instances",
        "",
        "",
        12,
        2,
        500,
      );
      instEd.precision = 0;
      const radEd = grpDist.addUnitValueEditor(
        "Radius (px)",
        "px",
        "px",
        270,
        0.1,
        99999,
      );
      radEd.precision = 1;

      const grpRot = col.addGroup("Rotation");
      const rotSw = grpRot.addSwitch("Enable custom rotation", false);
      const rotEd = grpRot.addUnitValueEditor(
        "Angle (deg)",
        "deg",
        "deg",
        0,
        -3600,
        3600,
      );
      rotEd.precision = 1;

      const grpScl = col.addGroup("Scale variation (optional)");
      const scStEd = grpScl.addUnitValueEditor(
        "Scale start (%)",
        "%",
        "%",
        100,
        1,
        1000,
      );
      scStEd.precision = 1;
      const scEnEd = grpScl.addUnitValueEditor(
        "Scale end (%)",
        "%",
        "%",
        100,
        1,
        1000,
      );
      scEnEd.precision = 1;

      const sepGrp = col.addGroup("");
      sepGrp.enableSeparator = true;
      const btns = sepGrp.addButtonSet("", ["Preview", "Apply"], 0);

      let previewSteps = doPreview(12, 270, false, 0, 1.0, 1.0);

      let running = true;
      while (running) {
        btns.selectedIndex = 0;
        const r = dlg.show();
        const instances = Math.max(2, Math.round(instEd.value));
        const radius = Math.max(0.1, radEd.value);
        const rotEnabled = rotSw.value;
        const rotDeg = rotEd.value;
        const scaleStart = Math.max(0.01, scStEd.value / 100);
        const scaleEnd = Math.max(0.01, scEnEd.value / 100);
        const mode = btns.selectedIndex;

        if (r.value === DialogResult.Ok.value) {
          undoN(previewSteps);
          if (mode === 1) {
            doApply(
              instances,
              radius,
              rotEnabled,
              rotDeg,
              scaleStart,
              scaleEnd,
            );
            running = false;
          } else {
            previewSteps = doPreview(
              instances,
              radius,
              rotEnabled,
              rotDeg,
              scaleStart,
              scaleEnd,
            );
          }
        } else {
          undoN(previewSteps);
          undoN(initSteps);
          running = false;
        }
      }
    } // validSrcs
  } // rawNodes
} // doc
