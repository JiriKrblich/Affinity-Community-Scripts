// ─── BBTools Shadow 2 — Affinity Port (Live Preview) ───────────────────────
// Replicates BBTools Shadow 2 (Photoshop) for Affinity Designer / Photo / Publisher.
// Live preview updates the canvas on every slider move. Cancel restores the
// original state; OK commits the last previewed shadow.
//
// Controls (mirrors BBTools Shadow 2):
//   Angle °   — shadow direction (0–359°)
//   Scale     — shadow length as % of object size (1–100)
//   Blur px   — edge softness in pixels (1–100)
//   Opacity % — shadow transparency (1–100)
//   Color     — shadow colour (default dark navy)

'use strict';

const { Document } = require('/document');
const { Colour } = require('/colours');
const { Dialog, DialogResult } = require('/dialog');
const { GaussianBlurLayerEffect, ColourOverlayLayerEffect } = require('/layereffects');
const { TransformBuilder } = require('/geometry');
const { BlendMode } = require('affinity:common');
const { UnitType } = require('/units');
const { DocumentCommand } = require('/commands');
const { NodeMoveType, NodeChildType } = require('affinity:dom');

const doc = Document.current;
if (!doc) {
    console.log('ERROR: No document open.');
} else {
    const subjectNode = doc.selection ? doc.selection.firstNode : null;
    if (!subjectNode) {
        const info = Dialog.create('BBTools Shadow 2');
        info.addColumn().addGroup('').addStaticText('', 'Please select a layer, then run again.');
        info.runModal();
    } else {
        const defaultColour = Colour.createRGBA8({ r: 16, g: 16, b: 30, alpha: 255 });

        // Pre-calculate bounding box once — it never changes during the dialog
        const bbox   = subjectNode.getSpreadBaseBox(false);
        const bw     = bbox ? bbox.width  : 200;
        const bh     = bbox ? bbox.height : 200;
        const cx     = bbox ? bbox.x + bw / 2 : 0;   // bottom-centre anchor X
        const cy_bot = bbox ? bbox.y + bh      : 0;   // bottom-centre anchor Y

        // ── Core shadow-application helper ────────────────────────────────
        // Called once for the initial preview and again after every rewind.
        function applyShadow(angleDeg, scale, blur, opacityPc, colour) {
            const angleRad = (angleDeg * Math.PI) / 180;
            const scaleLen = (scale / 100) * Math.max(bw, bh);

            const dx = Math.sin(angleRad) * scaleLen;        // horizontal tip offset
            const dy = -Math.cos(angleRad) * scaleLen;       // vertical  tip offset

            const shearX = -dx / bh;                         // shear factor
            const scaleY = Math.max(0.05, 1 - dy / bh);     // Y scale (clamped)

            const shadowNode = subjectNode.duplicate();
            if (!shadowNode) return;

            const shadowSel = shadowNode.selfSelection;

            doc.setLayerDescription('BB Shadow', shadowSel);

            // Colour overlay — makes the duplicate solid shadow colour
            const overlay   = ColourOverlayLayerEffect.create();
            overlay.enabled = true;
            overlay.opacity = 1.0;
            overlay.colour  = colour;
            doc.setColourOverlayLayerEffect(shadowSel, overlay, 0);

            // Gaussian blur for soft edges
            const blurFx    = GaussianBlurLayerEffect.create();
            blurFx.enabled  = true;
            blurFx.radius   = blur;
            doc.setGaussianBlurLayerEffect(shadowSel, blurFx);

            doc.setBlendMode(BlendMode.Multiply, false, shadowSel);
            doc.setOpacity(opacityPc / 100, shadowSel);

            // Standing-shadow transform anchored at base:
            //   translate to bottom-centre → shear X → scale Y → translate back
            const tb = new TransformBuilder();
            tb.translateXY(-cx, -cy_bot)
              .shearXY(shearX, 0)
              .scaleXY(1, scaleY)
              .translateXY(cx, cy_bot);
            doc.applyTransform(tb.transform, shadowSel);

            // Place shadow behind the subject
            doc.executeCommand(
                DocumentCommand.createMoveNodes(
                    shadowNode.selfSelection, subjectNode,
                    NodeMoveType.After, NodeChildType.Main
                )
            );
        }

        // ── Build the dialog ───────────────────────────────────────────────
        const dlg = Dialog.create('BBTools Shadow 2');
        dlg.initialWidth = 340;
        const col = dlg.addColumn();
        const grp = col.addGroup('Shadow');

        const angleEd = grp.addUnitValueEditor('Angle °', UnitType.Degree, UnitType.Degree, 225, 0, 359);
        angleEd.precision = 0;
        angleEd.showPopupSlider = true;

        const scaleEd = grp.addUnitValueEditor('Scale', UnitType.Number, UnitType.Number, 50, 1, 100);
        scaleEd.precision = 0;
        scaleEd.showPopupSlider = true;

        const blurEd = grp.addUnitValueEditor('Blur px', UnitType.Number, UnitType.Number, 15, 1, 100);
        blurEd.precision = 0;
        blurEd.showPopupSlider = true;

        const opacityEd = grp.addUnitValueEditor('Opacity %', UnitType.Percentage, UnitType.Percentage, 60, 1, 100);
        opacityEd.precision = 0;
        opacityEd.showPopupSlider = true;

        const colourPicker = grp.addColourPicker('Color', defaultColour);

        // ── Live preview ───────────────────────────────────────────────────
        // Snapshot the undo position BEFORE any shadow is added.
        // The change handler rewinds to this point then re-applies from scratch,
        // so each slider drag produces one clean shadow (no accumulation).
        const previewStart = doc.history.position;

        // Show the initial shadow with default values so the canvas isn't blank
        applyShadow(225, 50, 15, 60, defaultColour);

        dlg.onControlValueChangedHandler = () => {
            // Rewind to the pre-shadow state, erasing the previous preview
            doc.history.position = previewStart;

            // Re-apply with whatever the controls currently show
            const angleDeg  = Math.min(359, Math.max(0,   angleEd.value   || 225));
            const scale     = Math.min(100, Math.max(1,   scaleEd.value   || 50));
            const blur      = Math.min(100, Math.max(1,   blurEd.value    || 15));
            const opacityPc = Math.min(100, Math.max(1,   opacityEd.value || 60));
            const colour    = colourPicker.value || defaultColour;
            applyShadow(angleDeg, scale, blur, opacityPc, colour);
        };

        // ── Run the modal ──────────────────────────────────────────────────
        const result = dlg.runModal();

        if (result.value !== DialogResult.Ok.value) {
            // Cancelled — rewind the preview so no shadow remains
            doc.history.position = previewStart;
            console.log('BBTools Shadow 2 — cancelled, preview removed.');
        } else {
            // OK — the last live-preview shadow IS the committed result; nothing to do
            const angleDeg  = Math.min(359, Math.max(0,   angleEd.value   || 225));
            const scale     = Math.min(100, Math.max(1,   scaleEd.value   || 50));
            const blur      = Math.min(100, Math.max(1,   blurEd.value    || 15));
            const opacityPc = Math.min(100, Math.max(1,   opacityEd.value || 60));
            console.log('BBTools Shadow 2 applied!');
            console.log('Angle: ' + angleDeg + '°  Scale: ' + scale + '  Blur: ' + blur + 'px  Opacity: ' + opacityPc + '%');
        }
    }
}
