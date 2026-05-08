/**
 * Script Name: Artboard Fitter
 * Author: Heitor Hatherly
 * Description: Shows a dialog to choose which axis to resize (Height, Width,
 *              or Both), the padding unit (cm or mm), and the padding value
 *              per side. For each artboard in the current spread, groups all
 *              direct children into a single Container Node, resizes the
 *              selected axis/axes so the group fits with equal padding on
 *              each side, and centers the group on the resized axes.
 *              Content is never distorted. Works with any document DPI.
 * Version: 1.0
 */

'use strict';

const { Document } = require('/document');
const { DocumentCommand, AddChildNodesCommandBuilder, InsertionMode, NodeMoveType, NodeChildType } = require('/commands');
const { Selection } = require('/selections');
const { ContainerNodeDefinition } = require('/nodes');
const { Transform, TransformBuilder } = require('/geometry');
const { Dialog, DialogResult } = require('/dialog');
const { UnitType } = require('/units');

function main() {
    const doc = Document.current;
    if (!doc) throw new Error("No document open.");
    const spread = doc.spreads.first;
    if (!spread) throw new Error("No spread found.");

    const PX_PER_CM = doc.dpi / 2.54;
    const PX_PER_MM = doc.dpi / 25.4;

    // --- Dialog ---
    const dlg = Dialog.create("Artboard Fitter");
    const col = dlg.addColumn();

    const grpMode = col.addGroup("Resize Mode");
    const modeCtrl = grpMode.addRadioGroup("Fit to", ["Height", "Width", "Both"], 0);

    const grpUnit = col.addGroup("Padding Unit");
    const unitCtrl = grpUnit.addRadioGroup("Unit", ["cm", "mm"], 0);

    const grpVal = col.addGroup("Padding per Side");
    const paddingCtrl = grpVal.addUnitValueEditor("Value", UnitType.Centimetre, doc.units, 0.5, 0, null);

    const result = dlg.runModal();
    if (result.value !== DialogResult.Ok.value) {
        console.log("Cancelled.");
        return;
    }

    const unitIndex   = unitCtrl.selectedIndex; // 0=cm, 1=mm
    const PX_PER_UNIT = unitIndex === 0 ? PX_PER_CM : PX_PER_MM;
    const paddingPx   = paddingCtrl.value * PX_PER_UNIT; // padding por lado
    const mode = modeCtrl.selectedIndex; // 0=Height, 1=Width, 2=Both
    const fitH = mode === 0 || mode === 2;
    const fitW = mode === 1 || mode === 2;

    doc.executeCommand(DocumentCommand.createSetCurrentSpread(spread));

    for (const ab of spread.artboards) {
        const abNode = ab.node;
        if (!abNode) continue;

        const children = [];
        for (const child of abNode.children) children.push(child);
        if (children.length === 0) continue;

        // 1. Create group inside artboard
        const groupDef = ContainerNodeDefinition.create("Content");
        const acnBuilder = AddChildNodesCommandBuilder.create();
        acnBuilder.addContainerNode(groupDef);
        acnBuilder.setInsertionTarget(abNode);
        acnBuilder.setInsertionMode(InsertionMode.Inside_AtFront);
        doc.executeCommand(acnBuilder.createCommand(true, NodeChildType.Main));

        const groupNode = doc.selection.items.first?.node;
        if (!groupNode) continue;

        // 2. Move children into group
        for (const child of children) {
            const childSel = Selection.create(doc, child);
            doc.executeCommand(DocumentCommand.createMoveNodes(childSel, groupNode, NodeMoveType.Inside, NodeChildType.Main));
        }

        // 3. Measure — paddingPx * 2 = total padding (equal on each side)
        const groupBox = groupNode.getSpreadBaseBox(false);
        const abBox    = ab.spreadBaseBox;
        const scaleX   = fitW ? (groupBox.width  + paddingPx * 2) / abBox.width  : 1;
        const scaleY   = fitH ? (groupBox.height + paddingPx * 2) / abBox.height : 1;

        // 4. Resize artboard without distorting children
        const tb = new TransformBuilder();
        tb.translate(-abBox.x, -abBox.y);
        tb.scale(scaleX, scaleY);
        tb.translate(abBox.x, abBox.y);
        doc.executeCommand(DocumentCommand.createTransform(Selection.create(doc, abNode), tb.transform, { correctChildren: true }));

        // 5. Center group on resized axes
        const abBoxNew    = ab.spreadBaseBox;
        const groupBoxCur = groupNode.getSpreadBaseBox(false);
        const dx = fitW ? (abBoxNew.x + abBoxNew.width  / 2) - (groupBoxCur.x + groupBoxCur.width  / 2) : 0;
        const dy = fitH ? (abBoxNew.y + abBoxNew.height / 2) - (groupBoxCur.y + groupBoxCur.height / 2) : 0;

        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
            doc.executeCommand(DocumentCommand.createTransform(Selection.create(doc, groupNode), Transform.createTranslate(dx, dy)));
        }
    }
    console.log("Done.");
}

main();
