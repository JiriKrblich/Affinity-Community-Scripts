/**
 * name: Progressive Transform
 * description: Ramps scale, rotation, fill color, and opacity across selected objects incrementally. Smooth linear progression based on selection count. Ascending/descending per property.
 * version: 1.0.0
 * author: WaveF
*/

'use strict';

const { Document } = require('/document');
const { Dialog, DialogResult } = require('/dialog');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
const { Transform } = require('/geometry');
const { Selection } = require('/selections');
const { Colour } = require('/colours');
const { app } = require('/application');

const doc = Document.current;

if (!doc) {
    app.alert("This script requires an open document", "Progressive Transform");
    return;
}

const count = doc.selection.length;
if (count === 0) {
    app.alert("Please select at least one object first", "Progressive Transform");
    return;
}

/**
 * Wraps a transform so it pivots around the object's bounding box center
 * instead of the document origin (0,0).
 * Based on Randomize Objects' fromCenterOrig implementation.
 */
function fromCenterOrig(bb, xf) {
    if (!bb) return xf;
    const cx = bb.x + bb.width * 0.5;
    const cy = bb.y + bb.height * 0.5;
    return Transform.createTranslate(cx, cy).multiply(
        xf.multiply(Transform.createTranslate(-cx, -cy)),
    );
}

function buildDialog(selectedCount) {
    const dlg = Dialog.create("Progressive Transform");
    dlg.initialWidth = 380;
    dlg.isResizable = false;

    const col = dlg.addColumn();

    const infoGroup = col.addGroup("Status");
    infoGroup.addStaticText("info",
        `${selectedCount} object(s) selected — progression will be evenly distributed`);

    const scaleGroup = col.addGroup("Scale");
    dlg.scaleEnabled = scaleGroup.addCheckBox("Enabled", false);
    dlg.scaleDirection = scaleGroup.addComboBox("Direction", ["Ascending 0→1", "Descending 1→0"]);

    const rotGroup = col.addGroup("Rotation");
    dlg.rotEnabled = rotGroup.addCheckBox("Enabled", false);
    dlg.rotDirection = rotGroup.addComboBox("Direction", ["Ascending 0°→360°", "Descending 360°→0°"]);

    const colorGroup = col.addGroup("Color");
    dlg.colorEnabled = colorGroup.addCheckBox("Enabled", false);
    dlg.colorDirection = colorGroup.addComboBox("Direction", ["Black→White", "White→Black"]);

    const opacityGroup = col.addGroup("Opacity");
    dlg.opacityEnabled = opacityGroup.addCheckBox("Enabled", false);
    dlg.opacityDirection = opacityGroup.addComboBox("Direction", ["Ascending 0→1", "Descending 1→0"]);

    return dlg;
}

function applyProgressiveTransforms(dlg, count) {
    const builder = CompoundCommandBuilder.create();
    let cmdCount = 0;

    for (let i = 0; i < count; i++) {
        const t = count > 1 ? i / (count - 1) : 0.5;
        const item = doc.selection.at(i);
        if (!item) continue;
        const node = item.node;
        if (!node) continue;

        const sel = Selection.create(doc, node);

        // Pre-compute bounding box for fromCenterOrig
        let bb = null;
        try {
            bb = node.getSpreadBaseBox(false);
        } catch (_) {}

        // Scale
        if (dlg.scaleEnabled.value) {
            const rawScale = dlg.scaleDirection.selectedIndex === 0 ? t : 1 - t;
            const scale = Math.max(rawScale, 0.001);
            builder.addCommand(
                DocumentCommand.createTransform(sel, fromCenterOrig(bb, Transform.createScale(scale, scale)))
            );
            cmdCount++;
        }

        // Rotation
        if (dlg.rotEnabled.value) {
            const angleDeg = dlg.rotDirection.selectedIndex === 0 ? t * 360 : (1 - t) * 360;
            const angleRad = angleDeg * (Math.PI / 180);
            builder.addCommand(
                DocumentCommand.createTransform(sel, fromCenterOrig(bb, Transform.createRotate(angleRad)))
            );
            cmdCount++;
        }

        // Color
        if (dlg.colorEnabled.value) {
            const b = dlg.colorDirection.selectedIndex === 0 ? t : 1 - t;
            builder.addCommand(
                DocumentCommand.createSetBrushFill(sel, Colour.createRGBAuf({ r: b, g: b, b: b, a: 1.0 }))
            );
            cmdCount++;
        }

        // Opacity
        if (dlg.opacityEnabled.value) {
            const opacity = dlg.opacityDirection.selectedIndex === 0 ? t : 1 - t;
            builder.addCommand(DocumentCommand.createSetOpacity(sel, opacity));
            cmdCount++;
        }
    }

    if (cmdCount > 0) {
        doc.executeCommand(builder.createCommand());
    }
}

const dlg = buildDialog(count);

while (dlg.runModal().value === DialogResult.Ok.value) {
    if (!dlg.scaleEnabled.value && !dlg.rotEnabled.value &&
        !dlg.colorEnabled.value && !dlg.opacityEnabled.value) {
        app.alert("Please enable at least one transform property", "Progressive Transform");
        continue;
    }
    applyProgressiveTransforms(dlg, count);
    break;
}
