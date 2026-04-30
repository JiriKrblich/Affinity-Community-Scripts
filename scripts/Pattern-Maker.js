
/**
name: Pattern Maker
version: 1.0.0
description: Create patterns from an object. Supports brick and drop patterns.
author: Nic Kraneis
*/

// Google Gemini was used in creation of this script.

"use strict";

const { Document } = require("/document");
const { Dialog, DialogResult } = require("/dialog");
const { AddChildNodesCommandBuilder, DocumentCommand, NodeChildType, NodeMoveType } = require("/commands");
const { ContainerNodeDefinition } = require("/nodes");
const { Selection } = require("/selections");
const { Transform } = require("/geometry");
const { UnitType } = require("/units");

function getNodeBox(node) {
    return (
        node.exactSpreadBaseBox ||
        (typeof node.getSpreadBaseBox === 'function' ? node.getSpreadBaseBox(true) : null) ||
        node.spreadVisibleBox
    );
}

function getSelectionBounds(selection) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let valid = false;

    for (let i = 0; i < selection.length; i++) {
        const node = selection.at(i).node;
        const bb = getNodeBox(node);
        if (bb) {
            valid = true;
            if (bb.x < minX) minX = bb.x;
            if (bb.y < minY) minY = bb.y;
            if (bb.x + bb.width > maxX) maxX = bb.x + bb.width;
            if (bb.y + bb.height > maxY) maxY = bb.y + bb.height;
        }
    }

    if (!valid) return { x: 0, y: 0, width: 0, height: 0 };

    return {
        x: minX,
        y: minY,
        width: Math.max(0, maxX - minX),
        height: Math.max(0, maxY - minY)
    };
}

function exec(doc, cmd) {
    doc.executeCommand(cmd);
}

function undoN(doc, n) {
    for (let i = 0; i < n; i++) exec(doc, DocumentCommand.createUndo());
}

function createGroupContainer(doc, groupName) {
    const builder = AddChildNodesCommandBuilder.create();
    builder.setInsertionTarget(doc.currentSpread);
    builder.addContainerNode(ContainerNodeDefinition.create(groupName));
    const command = builder.createCommand(false, NodeChildType.Main);
    doc.executeCommand(command);
    return command.newNodes[0];
}

function moveNodesIntoContainer(doc, nodes, container) {
    if (!nodes || nodes.length === 0) return;

    const validNodes = [];
    for (let i = 0; i < nodes.length; i++) {
        if (nodes[i] !== undefined && nodes[i] !== null) {
            validNodes.push(nodes[i]);
        }
    }

    if (validNodes.length === 0) return;

    const selection = Selection.create(doc, validNodes);
    const command = DocumentCommand.createMoveNodes(
        selection,
        container,
        NodeMoveType.Inside,
        NodeChildType.Main
    );
    doc.executeCommand(command);
}

function showError(msg) {
    const d = Dialog.create("Pattern Maker - Error");
    d.initialWidth = 450;
    const col = d.addColumn();
    const txt = col.addGroup("Diagnostics").addStaticText("", msg);
    txt.isFullWidth = true;
    d.runModal();
}

function main() {
    const doc = Document.current;
    if (!doc) {
        showError("No document open.");
        return;
    }

    const sel = doc.selection;
    if (!sel || sel.length === 0) {
        showError("Please select at least one layer to create a pattern.");
        return;
    }

    const origNodes = [];
    for (let i = 0; i < sel.length; i++) {
        origNodes.push(sel.at(i).node);
    }
    const bounds = getSelectionBounds(sel);

    const dlg = Dialog.create("Pattern Maker");
    dlg.initialWidth = 380;
    const col = dlg.addColumn();

    const gridGrp = col.addGroup("Grid");
    const colsCtrl = gridGrp.addUnitValueEditor("Columns (X)", UnitType.Number, UnitType.Number, 3, 1, 100);
    colsCtrl.precision = 0;
    const rowsCtrl = gridGrp.addUnitValueEditor("Rows (Y)", UnitType.Number, UnitType.Number, 3, 1, 100);
    rowsCtrl.precision = 0;

    const spacingGrp = col.addGroup("Spacing");
    const gapXCtrl = spacingGrp.addUnitValueEditor("Gap X", UnitType.Number, UnitType.Number, 0, -10000, 10000);
    gapXCtrl.precision = 1;
    const gapYCtrl = spacingGrp.addUnitValueEditor("Gap Y", UnitType.Number, UnitType.Number, 0, -10000, 10000);
    gapYCtrl.precision = 1;

    const staggerGrp = col.addGroup("Stagger");
    const staggerRowCtrl = staggerGrp.addSwitch("Stagger Rows (Brick)", false);
    const staggerColCtrl = staggerGrp.addSwitch("Stagger Columns (Drop)", false);
    const staggerAmtCtrl = staggerGrp.addUnitValueEditor("Stagger Amount (%)", UnitType.Number, UnitType.Number, 50, 0, 100);
    staggerAmtCtrl.precision = 1;

    const hintGrp = col.addGroup("Editing Tip");
    const hintTxt = hintGrp.addStaticText("", "Convert the object into a Symbol before running this script so all generated copies remain linked and can be edited together.");
    hintTxt.isFullWidth = true;

    const actGrp = col.addGroup("Status");
    const errorTxt = actGrp.addStaticText("", "• Preview active - Ready");
    errorTxt.isFullWidth = true;

    const btns = actGrp.addButtonSet("", ["↺ Preview", "✓ Apply"], 0);
    btns.isFullWidth = true;

    function doApply(cols, rows, gapX, gapY, staggerRow, staggerCol, staggerAmt, isFinal) {
        let cmds = 0;
        const unitW = (bounds.width || 0) + gapX;
        const unitH = (bounds.height || 0) + gapY;

        if (isFinal) {
            // ==========================================
            // FINAL MODE: Pure flat generation (Golden Ticket Logic)
            // ==========================================

            // 1. Erstelle den einen Hauptcontainer
            const patternGroup = createGroupContainer(doc, `Pattern (${cols}x${rows})`);
            cmds++;

            // 2. Verschiebe die Originale ZUERST in den Hauptcontainer
            moveNodesIntoContainer(doc, origNodes, patternGroup);
            cmds++;

            // 3. Matrix flach generieren. Weil die Originale im Container liegen,
            //    landen alle Duplikate automatisch auf derselben Ebene im selben Container.
            for (let r = 0; r < rows; r++) {
                let rowDx = (staggerRow && r % 2 !== 0) ? unitW * staggerAmt : 0;
                let rowDy = r * unitH;

                for (let c = 0; c < cols; c++) {
                    if (r === 0 && c === 0) continue; // Original überspringen

                    let colDx = c * unitW;
                    let colDy = (staggerCol && c % 2 !== 0) ? unitH * staggerAmt : 0;

                    let dx = rowDx + colDx;
                    let dy = rowDy + colDy;

                    for (const node of origNodes) {
                        try {
                            const dup = node.duplicate(Transform.createTranslate(dx, dy));
                            if (dup) cmds++;
                        } catch (e) {}
                    }
                }
            }

            return { cmds: cmds, group: patternGroup };

        } else {
            // ==========================================
            // PREVIEW MODE: Fast Matrix (Row-by-Row)
            // ==========================================
            const firstRowNodes = [...origNodes];

            for (let c = 1; c < cols; c++) {
                let dx = c * unitW;
                let dy = (staggerCol && c % 2 !== 0) ? unitH * staggerAmt : 0;
                for (const node of origNodes) {
                    try {
                        const dup = node.duplicate(Transform.createTranslate(dx, dy));
                        if (dup) {
                            firstRowNodes.push(dup);
                            cmds++;
                        }
                    } catch (e) {}
                }
            }

            const rowGroup = createGroupContainer(doc, `TempRow`);
            cmds++;
            moveNodesIntoContainer(doc, firstRowNodes, rowGroup);
            cmds++;

            const allRows = [rowGroup];

            for (let r = 1; r < rows; r++) {
                let dx = (staggerRow && r % 2 !== 0) ? unitW * staggerAmt : 0;
                let dy = r * unitH;
                try {
                    const rowDup = rowGroup.duplicate(Transform.createTranslate(dx, dy));
                    if (rowDup) {
                        allRows.push(rowDup);
                        cmds++;
                    }
                } catch (e) {}
            }

            const patternGroup = createGroupContainer(doc, `Preview (${cols}x${rows})`);
            cmds++;
            moveNodesIntoContainer(doc, allRows, patternGroup);
            cmds++;

            return { cmds: cmds, group: patternGroup };
        }
    }

    let cmdCount = 0;
    let previewActive = false;

    try {
        const res = doApply(3, 3, 0, 0, false, false, 0.5, false);
        cmdCount = res.cmds;
        previewActive = true;
    } catch (e) {
        errorTxt.text = "Error: " + e.message;
    }

    let running = true;
    while (running) {
        btns.selectedIndex = 0;
        const result = dlg.runModal();

        const cols = Math.max(1, Math.round(colsCtrl.value));
        const rows = Math.max(1, Math.round(rowsCtrl.value));
        const gapX = gapXCtrl.value;
        const gapY = gapYCtrl.value;
        const stRow = staggerRowCtrl.value;
        const stCol = staggerColCtrl.value;
        const stAmt = staggerAmtCtrl.value / 100;

        const mode = btns.selectedIndex;

        if (result.value !== DialogResult.Ok.value) {
            if (previewActive) {
                undoN(doc, cmdCount);
                previewActive = false;
            }
            running = false;
        } else if (mode === 1) {
            if (previewActive) {
                undoN(doc, cmdCount);
                previewActive = false;
            }
            try {
                const finalRes = doApply(cols, rows, gapX, gapY, stRow, stCol, stAmt, true);
                exec(doc, DocumentCommand.createSetSelection(finalRes.group.selfSelection));
                running = false;
            } catch (e) {
                errorTxt.text = "✖ " + e.message;
            }
        } else {
            if (previewActive) {
                undoN(doc, cmdCount);
                previewActive = false;
                cmdCount = 0;
            }
            try {
                const res = doApply(cols, rows, gapX, gapY, stRow, stCol, stAmt, false);
                cmdCount = res.cmds;
                previewActive = true;
                errorTxt.text = `• Preview: ${cols}x${rows} Grid - Click Apply to confirm`;
            } catch (e) {
                errorTxt.text = "✖ " + e.message;
            }
        }
    }
}

try {
    main();
} catch (error) {
    showError("Script Error:\n" + String(error));
}

´´´
