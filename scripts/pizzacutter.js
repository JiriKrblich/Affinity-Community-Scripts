/**
 * name: Pizza Cutter
 * description: Slice a selected object into a precise grid or pie pieces.
 * version: 1.0.0
 * author: hellsfaun
 */

"use strict";
const { Document } = require("/document");
const { Dialog, DialogResult } = require("/dialog");
const { UnitType } = require("/units");
const { DocumentCommand } = require("/commands");
const { NodeMoveType, NodeChildType } = require("/commands");
const { CurveBuilder } = require("/geometry");
const { Selection } = require("/selections");
const { Transform } = require("/geometry");

let currentPieces = [];
let groupToCleanup = null;

let config = {
  mode: 0, // 0 for Pie, 1 for Grid
  keepOriginal: false,
  // Grid settings
  rows: 3,
  cols: 3,
  gridAngle: 0,
  // Pie settings
  cuts: 3, // Number of intersecting lines (1 cut = 2 slices)
  startAngle: 0,
  offsetX: 0,
  offsetY: 0,
};

function spreadBox(node) {
  return node.getSpreadBaseBox(false);
}

function emancipatePieces(doc, pieces, group) {
  if (!group) return pieces;
  let finalPieces = [];
  try {
    const cmd = DocumentCommand.createMoveNodes(
      Selection.create(doc, pieces),
      group,
      NodeMoveType.After,
      NodeChildType.Main,
    );
    doc.executeCommand(cmd);
    if (cmd.newNodes && cmd.newNodes.length > 0) {
      for (const n of cmd.newNodes) finalPieces.push(n);
    } else {
      finalPieces = pieces.slice();
    }
  } catch (e) {
    for (const p of pieces) {
      try {
        const cmd = DocumentCommand.createMoveNodes(
          Selection.create(doc, p),
          group,
          NodeMoveType.After,
          NodeChildType.Main,
        );
        doc.executeCommand(cmd);
        if (cmd.newNodes && cmd.newNodes.length > 0) {
          finalPieces.push(cmd.newNodes[0]);
        } else {
          finalPieces.push(p);
        }
      } catch (_) {
        finalPieces.push(p);
      }
    }
  }
  return finalPieces;
}

function deletePieces() {
  const doc = Document.current;
  if (groupToCleanup && currentPieces.length > 0) {
    currentPieces = emancipatePieces(doc, currentPieces, groupToCleanup);
  }
  for (const p of currentPieces) {
    try {
      doc.executeCommand(
        DocumentCommand.createDeleteSelection(Selection.create(doc, p), false),
      );
    } catch (e) {}
  }
  currentPieces = [];
  if (groupToCleanup) {
    try {
      doc.executeCommand(
        DocumentCommand.createDeleteSelection(
          groupToCleanup.selfSelection,
          false,
        ),
      );
    } catch (e) {}
    groupToCleanup = null;
  }
}

function prepareNode(origNode) {
  const doc = Document.current;

  const dupCmd = DocumentCommand.createTransform(origNode.selfSelection, null, {
    duplicateNodes: true,
  });
  doc.executeCommand(dupCmd);

  if (!dupCmd.newNodes || dupCmd.newNodes.length === 0)
    throw new Error("Duplicate failed. Select a shape, image or text.");

  const dup = dupCmd.newNodes[0];
  doc.executeCommand(
    DocumentCommand.createSetVisibility(dup.selfSelection, true),
  );
  doc.executeCommand(
    DocumentCommand.createConvertToCurves(Selection.create(doc, dup)),
  );

  const selAfter = doc.selection.nodes;
  const converted = selAfter && selAfter.length > 0 ? selAfter.first : null;
  if (!converted) throw new Error("Convert to Curves produced no output.");

  if (converted.isGroupNode) {
    const glyphs = [];
    for (const child of converted.children) glyphs.push(child);
    if (glyphs.length === 0) throw new Error("Converted group is empty.");
    return { pieces: glyphs, group: converted };
  }

  return { pieces: [converted], group: null };
}

function generateSlices(origNode, origBox) {
  const doc = Document.current;
  const cx = origBox.x + origBox.width / 2;
  const cy = origBox.y + origBox.height / 2;

  const { pieces: initialPieces, group } = prepareNode(origNode);
  groupToCleanup = group;
  let pieces = initialPieces;
  const cutLines = [];

  const margin = Math.max(origBox.width, origBox.height) * 0.1;

  if (config.mode === 1) {
    // GRID MODE MATH
    const gridRad = (config.gridAngle * Math.PI) / 180;
    const cosA = Math.cos(gridRad);
    const sinA = Math.sin(gridRad);

    // Helper to rotate a point around the center (cx, cy)
    const rotPt = (x, y) => {
      const tx = x - cx;
      const ty = y - cy;
      return {
        x: cx + tx * cosA - ty * sinA,
        y: cy + tx * sinA + ty * cosA,
      };
    };

    // Guarantee lines are long enough even when rotated by using the diagonal distance
    const R_grid =
      Math.sqrt(
        origBox.width * origBox.width + origBox.height * origBox.height,
      ) + margin;

    if (config.rows > 1) {
      const rowHeight = origBox.height / config.rows;
      for (let i = 1; i < config.rows; i++) {
        const y = origBox.y + i * rowHeight;
        const p1 = rotPt(cx - R_grid, y);
        const p2 = rotPt(cx + R_grid, y);
        cutLines.push(
          new CurveBuilder()
            .beginXY(p1.x, p1.y)
            .lineToXY(p2.x, p2.y)
            .createCurve(),
        );
      }
    }
    if (config.cols > 1) {
      const colWidth = origBox.width / config.cols;
      for (let j = 1; j < config.cols; j++) {
        const x = origBox.x + j * colWidth;
        const p1 = rotPt(x, cy - R_grid);
        const p2 = rotPt(x, cy + R_grid);
        cutLines.push(
          new CurveBuilder()
            .beginXY(p1.x, p1.y)
            .lineToXY(p2.x, p2.y)
            .createCurve(),
        );
      }
    }
  } else {
    // PIE MODE MATH
    const centerOffsetX = cx + origBox.width * (config.offsetX / 100);
    const centerOffsetY = cy + origBox.height * (config.offsetY / 100);
    const R = Math.max(origBox.width, origBox.height) * 1.5;

    const numCuts = Math.max(1, config.cuts);
    const angleStep = Math.PI / numCuts;
    const startRad = (config.startAngle * Math.PI) / 180;

    for (let i = 0; i < numCuts; i++) {
      const angle = startRad + i * angleStep;
      cutLines.push(
        new CurveBuilder()
          .beginXY(
            centerOffsetX + Math.cos(angle) * R,
            centerOffsetY + Math.sin(angle) * R,
          )
          .lineToXY(
            centerOffsetX - Math.cos(angle) * R,
            centerOffsetY - Math.sin(angle) * R,
          )
          .createCurve(),
      );
    }
  }

  for (const cutLine of cutLines) {
    const next = [];
    for (const p of pieces) {
      try {
        const cmd = DocumentCommand.createKnifeCut(
          cutLine,
          Selection.create(doc, p),
        );
        doc.executeCommand(cmd);
        if (cmd.newNodes && cmd.newNodes.length > 0) {
          for (const n of cmd.newNodes) next.push(n);
        } else {
          next.push(p);
        }
      } catch (e) {
        next.push(p);
      }
    }
    pieces = next;
  }

  currentPieces = pieces;
}

function applySlicing(doc, origNode) {
  // Delete the original invisible node first to prevent selection interference (unless kept)
  if (!config.keepOriginal) {
    try {
      doc.executeCommand(
        DocumentCommand.createDeleteSelection(origNode.selfSelection, false),
      );
    } catch (e) {}
  }

  // Move the cut pieces out of the temporary group into the main document
  if (groupToCleanup && currentPieces.length > 0) {
    currentPieces = emancipatePieces(doc, currentPieces, groupToCleanup);
  }

  // Delete the now-empty temporary group
  if (groupToCleanup) {
    try {
      doc.executeCommand(
        DocumentCommand.createDeleteSelection(
          groupToCleanup.selfSelection,
          false,
        ),
      );
    } catch (e) {}
  }

  // Aggressively attempt to select the newly created pieces so they are hot for Cmd/Ctrl+G
  if (currentPieces && currentPieces.length > 0) {
    const finalSel = Selection.create(doc, currentPieces);

    // Try direct assignment
    try {
      doc.selection = finalSel;
    } catch (e) {}

    // Try various documented command patterns for selecting nodes safely
    const selectionCommands = [
      "createSelectNodes",
      "createSelectSelection",
      "createSetSelection",
      "createSelect",
    ];
    for (const cmdName of selectionCommands) {
      if (typeof DocumentCommand[cmdName] === "function") {
        try {
          doc.executeCommand(DocumentCommand[cmdName](finalSel));
        } catch (e) {}
        try {
          doc.executeCommand(DocumentCommand[cmdName](finalSel, true));
        } catch (e) {}
      }
    }

    // Try raw property mutation as a fallback
    for (const p of currentPieces) {
      try {
        p.selected = true;
      } catch (e) {}
    }
  }

  groupToCleanup = null;
  currentPieces = [];
}

function run() {
  const doc = Document.current;
  const sel = doc.selection;

  if (!sel || sel.length === 0) {
    const dlg = Dialog.create("Pizza Cutter");
    dlg
      .addColumn()
      .addGroup("")
      .addStaticText("", "No object selected.").isFullWidth = true;
    dlg.show();
    return;
  }

  const origNode = sel.nodes.first;
  let origBox;
  try {
    origBox = origNode.getSpreadBaseBox(false);
    if (!origBox || origBox.width <= 0 || origBox.height <= 0)
      throw new Error();
  } catch (e) {
    const dlg = Dialog.create("Pizza Cutter");
    dlg
      .addColumn()
      .addGroup("")
      .addStaticText(
        "",
        "Selected object has invalid dimensions.",
      ).isFullWidth = true;
    dlg.show();
    return;
  }

  doc.executeCommand(
    DocumentCommand.createSetVisibility(origNode.selfSelection, false),
  );

  const dialog = Dialog.create("Pizza Cutter");
  const col = dialog.addColumn();

  // Toggles between Pie (0) and Grid (1)
  const modeGrp = col.addGroup("Slicing Mode");
  let modeToggle;
  try {
    modeToggle = modeGrp.addDropDownList(
      "Method",
      ["Pie", "Grid"],
      config.mode,
    );
  } catch (e) {
    modeToggle = modeGrp.addComboBox("Method", ["Pie", "Grid"], config.mode);
  }
  const keepOriginalCtrl = modeGrp.addSwitch(
    "Keep original shape (hidden)",
    config.keepOriginal,
  );

  const pieGrp = col.addGroup("Pie Settings");
  const cutsCtrl = pieGrp.addUnitValueEditor(
    "Slices",
    UnitType.Number,
    UnitType.Number,
    config.cuts,
    1,
    32,
  );
  cutsCtrl.precision = 0;
  const startAngleCtrl = pieGrp.addUnitValueEditor(
    "Start Angle",
    UnitType.Number,
    UnitType.Number,
    config.startAngle,
    -180,
    180,
  );
  startAngleCtrl.precision = 0;
  startAngleCtrl.showPopupSlider = true;
  const offsetXCtrl = pieGrp.addUnitValueEditor(
    "Center X Offset (%)",
    UnitType.Number,
    UnitType.Number,
    config.offsetX,
    -100,
    100,
  );
  offsetXCtrl.showPopupSlider = true;
  const offsetYCtrl = pieGrp.addUnitValueEditor(
    "Center Y Offset (%)",
    UnitType.Number,
    UnitType.Number,
    config.offsetY,
    -100,
    100,
  );
  offsetYCtrl.showPopupSlider = true;

  const gridGrp = col.addGroup("Grid Settings");
  const rowsCtrl = gridGrp.addUnitValueEditor(
    "Rows",
    UnitType.Number,
    UnitType.Number,
    config.rows,
    1,
    50,
  );
  rowsCtrl.precision = 0;
  const colsCtrl = gridGrp.addUnitValueEditor(
    "Columns",
    UnitType.Number,
    UnitType.Number,
    config.cols,
    1,
    50,
  );
  colsCtrl.precision = 0;
  const gridAngleCtrl = gridGrp.addUnitValueEditor(
    "Angle",
    UnitType.Number,
    UnitType.Number,
    config.gridAngle,
    -180,
    180,
  );
  gridAngleCtrl.precision = 0;
  gridAngleCtrl.showPopupSlider = true;

  function readSettings() {
    let rawMode =
      modeToggle.selectedIndex !== undefined
        ? modeToggle.selectedIndex
        : modeToggle.value;
    if (typeof rawMode === "string") {
      config.mode = rawMode === "Pie" ? 0 : 1;
    } else {
      config.mode = rawMode;
    }

    config.rows = Math.max(1, Math.round(rowsCtrl.value));
    config.cols = Math.max(1, Math.round(colsCtrl.value));
    config.gridAngle = gridAngleCtrl.value;
    config.cuts = Math.max(1, Math.round(cutsCtrl.value));
    config.startAngle = startAngleCtrl.value;
    config.offsetX = offsetXCtrl.value;
    config.offsetY = offsetYCtrl.value;
    config.keepOriginal = keepOriginalCtrl.value;
  }

  function updatePreview() {
    deletePieces();
    readSettings();
    try {
      generateSlices(origNode, origBox);
      return true;
    } catch (e) {
      return false;
    }
  }

  // Bind real-time UI updates to instantly preview on slider change
  updatePreview();
  dialog.onControlValueChangedHandler = updatePreview;

  const result = dialog.show();

  if (result.value === DialogResult.Ok.value) {
    // "OK" clicked - apply final result
    applySlicing(doc, origNode);
  } else {
    // "Cancel" clicked / Window closed - revert everything safely
    deletePieces();
    try {
      doc.executeCommand(
        DocumentCommand.createSetVisibility(origNode.selfSelection, true),
      );
    } catch (e) {}
  }
}

run();
