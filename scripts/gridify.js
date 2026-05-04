// Google Gemini was used in creation of this script.

"use strict";

const { Document } = require("/document");
const { DocumentCommand, CompoundCommandBuilder } = require("/commands");
const { TransformBuilder } = require("/geometry");
const { Dialog, DialogResult } = require("/dialog");
const { Selection } = require("/selections");
const { UnitType } = require("/units");

const doc = Document.current;

if (!doc) {
  // No document open
} else {
  function undoN(n) {
    for (let i = 0; i < n; i++) doc.undo();
  }

  function validBB(b) {
    return b && b.width > 0 && b.height > 0 && isFinite(b.x) && isFinite(b.y);
  }

  const rawNodes = doc.selection.nodes.toArray().filter(Boolean);

  if (rawNodes.length > 0) {
    const validSrcs = rawNodes.filter((n) =>
      validBB(n.getSpreadBaseBox(false)),
    );

    if (validSrcs.length > 0) {
      const origNodes = validSrcs;

      let minX = Infinity,
        minY = Infinity;
      const baseItemData = [];

      for (const n of origNodes) {
        const b = n.getSpreadBaseBox(false);
        minX = Math.min(minX, b.x);
        minY = Math.min(minY, b.y);
        baseItemData.push({ src: n, b: b });
      }

      let hasGenerated = false;
      let config = {
        cols: 3,
        spacingX: 20,
        spacingY: 20,
        brickLayout: false,
        alignment: 1,
        sortMode: 0,
        forceScale: false,
        scaleMode: 1,
        targetSize: 100,
        scaleStrokes: true,
        jPos: 0,
        jRot: 0,
        jScl: 0,
        pRot: 0,
        pScl: 0,
      };

      function applyGrid(p) {
        const cmdB = CompoundCommandBuilder.create();
        const K = origNodes.length;

        let maxWidth = 0;
        const itemData = [];

        for (let k = 0; k < K; k++) {
          const data = baseItemData[k];
          let scaleF = 1.0;
          let effW = data.b.width;
          let effH = data.b.height;

          if (p.forceScale) {
            let refSize = Math.max(data.b.width, data.b.height);
            if (p.scaleMode === 1) refSize = data.b.height;
            if (p.scaleMode === 2) refSize = data.b.width;

            if (refSize > 0) {
              scaleF = p.targetSize / refSize;
            }
            effW = data.b.width * scaleF;
            effH = data.b.height * scaleF;
          }

          maxWidth = Math.max(maxWidth, effW);
          itemData.push({ src: data.src, b: data.b, scaleF, effW, effH });
        }

        if (p.sortMode === 1) {
          itemData.sort((a, b) => a.b.x - b.b.x);
        } else if (p.sortMode === 2) {
          itemData.sort((a, b) => a.b.y - b.b.y);
        } else if (p.sortMode === 3) {
          itemData.sort((a, b) => {
            const distA = Math.pow(a.b.x - minX, 2) + Math.pow(a.b.y - minY, 2);
            const distB = Math.pow(b.b.x - minX, 2) + Math.pow(b.b.y - minY, 2);
            return distA - distB;
          });
        } else if (p.sortMode === 4) {
          itemData.sort(() => Math.random() - 0.5);
        }

        const rows = Math.ceil(K / p.cols);
        const itemsInLastRow = K % p.cols === 0 ? p.cols : K % p.cols;

        const rowHeights = new Array(rows).fill(0);
        for (let k = 0; k < K; k++) {
          const r = Math.floor(k / p.cols);
          rowHeights[r] = Math.max(rowHeights[r], itemData[k].effH);
        }

        const rowY = [];
        let currY = minY;
        for (let r = 0; r < rows; r++) {
          rowY.push(currY);
          currY += rowHeights[r] + p.spacingY;
        }

        for (let k = 0; k < K; k++) {
          const data = itemData[k];
          const row = Math.floor(k / p.cols);
          const col = k % p.cols;

          let offsetX = 0;

          if (p.brickLayout && row % 2 !== 0) {
            offsetX += (maxWidth + p.spacingX) / 2;
          }

          if (row === rows - 1 && itemsInLastRow < p.cols) {
            const emptySpace = p.cols - itemsInLastRow;
            const emptyWidth = emptySpace * (maxWidth + p.spacingX);
            if (p.alignment === 1) offsetX += emptyWidth / 2;
            if (p.alignment === 2) offsetX += emptyWidth;
          }

          const jX = (Math.random() - 0.5) * 2 * p.jPos;
          const jY = (Math.random() - 0.5) * 2 * p.jPos;
          const jRot = (Math.random() - 0.5) * 2 * p.jRot;
          const jScl = 1.0 + (Math.random() - 0.5) * 2 * (p.jScl / 100);

          const progRot = k * p.pRot;
          const progScl = 1.0 + k * (p.pScl / 100);

          const finalScale = data.scaleF * jScl * progScl;
          const finalRotDeg = jRot + progRot;

          const targetX = minX + col * (maxWidth + p.spacingX) + offsetX + jX;
          const targetY = rowY[row] + jY;

          const cellCenterX = targetX + maxWidth / 2;
          const cellCenterY = targetY + rowHeights[row] / 2;

          const objCenterX = data.b.x + data.b.width / 2;
          const objCenterY = data.b.y + data.b.height / 2;

          const tb = new TransformBuilder();
          tb.translate(-objCenterX, -objCenterY);

          if (finalScale !== 1.0 && finalScale > 0.01) {
            tb.scale(finalScale, finalScale);
          }
          if (finalRotDeg !== 0.0) {
            tb.rotate((finalRotDeg * Math.PI) / 180.0);
          }

          tb.translate(cellCenterX, cellCenterY);

          cmdB.addCommand(
            DocumentCommand.createTransform(
              Selection.create(doc, data.src),
              tb.transform,
              {
                duplicateNodes: false,
                scaleStrokes: p.scaleStrokes,
                scaleEffects: p.scaleStrokes,
              },
            ),
          );
        }

        doc.executeCommand(cmdB.createCommand());
        return 1;
      }

      function showDialog(initialSteps = 0) {
        const dlg = Dialog.create("Gridify");
        const col = dlg.addColumn();

        // 1. Gruppe: Layout & Order
        const grpGrid = col.addGroup("Layout & Sorting");
        const colEd = grpGrid.addUnitValueEditor(
          "Columns",
          UnitType.None,
          UnitType.None,
          config.cols,
          1,
          100,
        );
        colEd.precision = 0;
        const spcXEd = grpGrid.addUnitValueEditor(
          "Spacing X",
          UnitType.Pixel,
          UnitType.Pixel,
          config.spacingX,
          -9999,
          9999,
        );
        spcXEd.precision = 0;
        const spcYEd = grpGrid.addUnitValueEditor(
          "Spacing Y",
          UnitType.Pixel,
          UnitType.Pixel,
          config.spacingY,
          -9999,
          9999,
        );
        spcYEd.precision = 0;
        const brickLayoutSw = grpGrid.addSwitch(
          "Brick Layout",
          config.brickLayout,
        );
        const alignEd = grpGrid.addUnitValueEditor(
          "Last Row Align (0=L, 1=C, 2=R)",
          UnitType.None,
          UnitType.None,
          config.alignment,
          0,
          2,
        );
        alignEd.showPopupSlider = true;
        alignEd.precision = 0;
        const sortEd = grpGrid.addUnitValueEditor(
          "Sort (0=Layer, 1=X, 2=Y, 3=Dist, 4=Rand)",
          UnitType.None,
          UnitType.None,
          config.sortMode,
          0,
          4,
        );
        sortEd.showPopupSlider = true;
        sortEd.precision = 0;

        // 2. Gruppe: Skalierung
        const grpScale = col.addGroup("Scaling");
        const forceScaleSw = grpScale.addSwitch(
          "Force Uniform Scaling",
          config.forceScale,
        );
        const scaleModeEd = grpScale.addUnitValueEditor(
          "Scale Base (0=Max, 1=H, 2=W)",
          UnitType.None,
          UnitType.None,
          config.scaleMode,
          0,
          2,
        );
        scaleModeEd.showPopupSlider = true;
        scaleModeEd.precision = 0;
        const targetSizeEd = grpScale.addUnitValueEditor(
          "Target Size",
          UnitType.Pixel,
          UnitType.Pixel,
          config.targetSize,
          1,
          9999,
        );
        targetSizeEd.precision = 0;
        const scaleStrokesSw = grpScale.addSwitch(
          "Scale Strokes & Effects",
          config.scaleStrokes,
        );

        // 3. Gruppe: Jitter & Progressive
        const grpJitter = col.addGroup("Jitter & Progressive");
        const jPosEd = grpJitter.addUnitValueEditor(
          "Random Position",
          UnitType.Pixel,
          UnitType.Pixel,
          config.jPos,
          0,
          9999,
        );
        jPosEd.precision = 0;
        const jRotEd = grpJitter.addUnitValueEditor(
          "Random Rotation (+/- °)",
          UnitType.None,
          UnitType.None,
          config.jRot,
          0,
          180,
        );
        jRotEd.precision = 0;
        const jSclEd = grpJitter.addUnitValueEditor(
          "Random Scale (+/- %)",
          UnitType.None,
          UnitType.None,
          config.jScl,
          0,
          99,
        );
        jSclEd.precision = 0;
        const pRotEd = grpJitter.addUnitValueEditor(
          "Rotation per Item (°)",
          UnitType.None,
          UnitType.None,
          config.pRot,
          -360,
          360,
        );
        pRotEd.precision = 0;
        const pSclEd = grpJitter.addUnitValueEditor(
          "Scale per Item (%)",
          UnitType.None,
          UnitType.None,
          config.pScl,
          -100,
          500,
        );
        pSclEd.precision = 0;

        const btns = grpJitter.addButtonSet("", ["Preview", "Apply"], 0);

        let previewSteps = initialSteps;
        let running = true;

        while (running) {
          btns.selectedIndex = 0;
          const r = dlg.show();

          const p = {
            cols: Math.max(1, Math.round(colEd.value)),
            spacingX: Math.round(spcXEd.value),
            spacingY: Math.round(spcYEd.value),
            brickLayout: brickLayoutSw.value,
            alignment: Math.max(0, Math.min(2, Math.round(alignEd.value))),
            sortMode: Math.max(0, Math.min(4, Math.round(sortEd.value))),
            forceScale: forceScaleSw.value,
            scaleMode: Math.max(0, Math.min(2, Math.round(scaleModeEd.value))),
            targetSize: Math.max(1, Math.round(targetSizeEd.value)),
            scaleStrokes: scaleStrokesSw.value,
            jPos: Math.round(jPosEd.value),
            jRot: Math.round(jRotEd.value),
            jScl: Math.round(jSclEd.value),
            pRot: Math.round(pRotEd.value),
            pScl: Math.round(pSclEd.value),
          };

          Object.assign(config, p);

          const mode = btns.selectedIndex;

          if (r.value === DialogResult.Ok.value) {
            undoN(previewSteps);

            if (mode === 1) {
              applyGrid(p);
              running = false;
            } else {
              previewSteps = applyGrid(p);
            }
          } else {
            undoN(previewSteps);
            running = false;
          }
        }
      }

      let firstPreviewSteps = applyGrid(config);
      showDialog(firstPreviewSteps);
    }
  }
}
