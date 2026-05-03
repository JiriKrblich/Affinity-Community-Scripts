"use strict";

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

      function buildXforms(p) {
        const K = origNodes.length;
        const xforms = [];

        if (p.keepOrigin) {
          for (let k = 0; k < K; k++) {
            const src = origNodes[k];
            const sBB = src.getSpreadBaseBox(false);
            const sox = sBB.x + sBB.width / 2;
            const soy = sBB.y + sBB.height / 2;

            const tb = new TransformBuilder();
            tb.translate(-sox, -soy);
            tb.translate(cx, cy);
            xforms.push({ src, xf: tb.transform });
          }
        }

        const rotRad = (p.rotDeg * Math.PI) / 180;
        const rowShiftRad = (p.radialShiftDeg * Math.PI) / 180;
        let count = 0;

        for (let r = 0; r < p.radialRows; r++) {
          const currentInstances = p.instances + r * p.instancesIncrement;
          if (currentInstances <= 0) break;

          const step = (2 * Math.PI) / currentInstances;
          const currentRadius = p.radius + r * p.radialSpacing;
          const currentShift = r * rowShiftRad;

          const ringStartScale = p.scaleStart * Math.pow(p.rowScale, r);
          const ringEndScale = p.scaleEnd * Math.pow(p.rowScale, r);

          for (let i = 0; i < currentInstances; i++) {
            const src = origNodes[count % K];
            const sBB = src.getSpreadBaseBox(false);
            const sox = sBB.x + sBB.width / 2;
            const soy = sBB.y + sBB.height / 2;

            const a = -Math.PI / 2 + i * step + currentShift;
            const rx = cx + currentRadius * Math.cos(a);
            const ry = cy + currentRadius * Math.sin(a);

            const rot = p.rotEnabled ? rotRad : i * step + currentShift;
            const sc =
              ringStartScale +
              (ringEndScale - ringStartScale) *
                (currentInstances > 1 ? i / (currentInstances - 1) : 0);

            const tb = new TransformBuilder();
            tb.translate(-sox, -soy);
            if (Math.abs(sc - 1) > 0.0001) tb.scale(sc, sc);
            if (Math.abs(rot) > 0.0001) tb.rotate(rot);
            tb.translate(rx, ry);
            xforms.push({ src, xf: tb.transform });

            count++;
          }
        }
        return xforms;
      }

      function doPreview(p) {
        const xforms = buildXforms(p);
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

      function doApply(p) {
        const xforms = buildXforms(p);
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
        origNodes.length > 1 ? ` — ${origNodes.length} Alternating` : "";
      const dlg = Dialog.create(`Radial Repeat${srcLabel}`);
      const col = dlg.addColumn();

      const grpOrigin = col.addGroup("Keep Origin");
      const keepOriginSw = grpOrigin.addSwitch("Keep Original Object", true);

      const grpDist = col.addGroup("Instances & Rows");
      const instEd = grpDist.addUnitValueEditor("Instances", "", "", 6, 1, 500);
      instEd.precision = 0;
      const radEd = grpDist.addUnitValueEditor(
        "Radius (px)",
        "px",
        "px",
        50,
        0.1,
        99999,
      );
      radEd.precision = 1;
      const radRowsEd = grpDist.addUnitValueEditor("Rows", "", "", 1, 1, 100);
      radRowsEd.precision = 0;
      const radSpcEd = grpDist.addUnitValueEditor(
        "Row Spacing (px)",
        "px",
        "px",
        50,
        0,
        99999,
      );
      radSpcEd.precision = 1;
      const instIncEd = grpDist.addUnitValueEditor(
        "Added Instances Per Row",
        "",
        "",
        0,
        -100,
        500,
      );
      instIncEd.precision = 0;
      const radShiftEd = grpDist.addUnitValueEditor(
        "Row Rotation",
        "deg",
        "deg",
        0,
        -360,
        360,
      );
      radShiftEd.precision = 1;

      const grpRot = col.addGroup("Rotation");
      const rotSw = grpRot.addSwitch("Enable Custom Rotation", false);
      const rotEd = grpRot.addUnitValueEditor(
        "Angle (deg)",
        "deg",
        "deg",
        0,
        -3600,
        3600,
      );
      rotEd.precision = 1;

      const grpScl = col.addGroup("Scaling");
      const scStEd = grpScl.addUnitValueEditor(
        "Instances Start Scale (%)",
        "%",
        "%",
        100,
        1,
        1000,
      );
      scStEd.precision = 1;
      const scEnEd = grpScl.addUnitValueEditor(
        "Instances End Scale (%)",
        "%",
        "%",
        100,
        1,
        1000,
      );
      scEnEd.precision = 1;
      const scRowEd = grpScl.addUnitValueEditor(
        "Row Scaling (%)",
        "%",
        "%",
        100,
        1,
        1000,
      );
      scRowEd.precision = 1;

      const sepGrp = col.addGroup("");
      sepGrp.enableSeparator = true;
      const btns = sepGrp.addButtonSet("", ["Preview", "Apply"], 0);

      let initialParams = {
        keepOrigin: true,
        instances: 6,
        instancesIncrement: 0,
        radius: 50,
        radialRows: 1,
        radialSpacing: 50,
        radialShiftDeg: 0,
        rotEnabled: false,
        rotDeg: 0,
        scaleStart: 1.0,
        scaleEnd: 1.0,
        rowScale: 1.0,
      };

      let previewSteps = doPreview(initialParams);

      let running = true;
      while (running) {
        btns.selectedIndex = 0;
        const r = dlg.show();

        const p = {
          keepOrigin: keepOriginSw.value,
          instances: Math.max(1, Math.round(instEd.value)),
          instancesIncrement: Math.round(instIncEd.value),
          radius: Math.max(0.1, radEd.value),
          radialRows: Math.max(1, Math.round(radRowsEd.value)),
          radialSpacing: Math.max(0, radSpcEd.value),
          radialShiftDeg: radShiftEd.value,
          rotEnabled: rotSw.value,
          rotDeg: rotEd.value,
          scaleStart: Math.max(0.01, scStEd.value / 100),
          scaleEnd: Math.max(0.01, scEnEd.value / 100),
          rowScale: Math.max(0.01, scRowEd.value / 100),
        };

        const mode = btns.selectedIndex;

        if (r.value === DialogResult.Ok.value) {
          undoN(previewSteps);
          if (mode === 1) {
            doApply(p);
            running = false;
          } else {
            previewSteps = doPreview(p);
          }
        } else {
          undoN(previewSteps);
          undoN(initSteps);
          running = false;
        }
      }
    }
  }
}
