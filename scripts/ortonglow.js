
// ============================================================================
// Orton Glow for Affinity Photo 3.3
// ============================================================================
//
// Author / Developer:
// Jan Roger Ekedal
//
// Description:
// Creates a fully non-destructive Orton Glow effect using Affinity Photo's
// JavaScript scripting API.
//
// Layer structure:
//
//   Orton Glow
//   ├── Sharpen
//   │   └── High Pass filter using Linear Light blend mode
//   └── Glow
//       ├── Gaussian Blur using Screen blend mode
//       └── Levels adjustment
//
// The Sharpen layer and Glow group use a linear Source Layer Range from
// 0% black to 100% white.
//
// A simple settings dialog allows the user to control the overall Orton
// strength. The Strength value directly controls the opacity of the Glow group.
//
// Default settings:
//
//   High Pass radius:      3 px
//   Gaussian Blur radius: 100 px
//   Glow opacity:         30%
//   Blur blend mode:      Screen
//   Blur opacity:         100%
//   Levels black point:   20%
//   Levels white point:   65%
//
// Developed by Jan Roger Ekedal for Affinity Photo 3.3.
//
// Version: 1.1
// Date: 2026
//
// Requirements:
//   Affinity Photo 3.3 or later with JavaScript scripting support.
//
// License:
//   MIT License
//
//   Copyright (c) 2026 Jan Roger Ekedal
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to deal
//   in the Software without restriction, including without limitation the rights
//   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in
//   all copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
//   THE SOFTWARE.
//
// ============================================================================

const { app } = require('/application');
const N = require('/nodes');
const C = require('/commands');
const D = require('/dialog');

function main() {

    const doc = app.documents.current;

    if (!doc) {
        throw new Error("No active document.");
    }


    // ========================================================================
    // DEFAULT SETTINGS
    // ========================================================================

    const HIGH_PASS_UI_RADIUS = 3;
    const BLUR_UI_RADIUS = 100;

    const DEFAULT_STRENGTH = 20;

    const LEVELS_BLACK_PERCENT = 20;
    const LEVELS_WHITE_PERCENT = 65;

    const RADIUS_FACTOR =
        0.9344221105527639;

    const BLACK_FACTOR =
        0.19132652878761292 / 19;

    const WHITE_FACTOR =
        0.45408162474632263 / 65;


    // ========================================================================
    // HELPERS
    // ========================================================================

    function clamp(value, min, max) {
        return Math.max(
            min,
            Math.min(max, value)
        );
    }


    function pxToInternalRadius(px) {
        return px * RADIUS_FACTOR;
    }


    function blackPercentToInternal(percent) {
        return clamp(
            percent * BLACK_FACTOR,
            0,
            1
        );
    }


    function whitePercentToInternal(percent) {
        return clamp(
            percent * WHITE_FACTOR,
            0,
            1
        );
    }


    function findNodeByDescription(root, description) {

        let result = null;

        function walk(node) {

            if (result) {
                return;
            }

            try {
                if (
                    node.description === description ||
                    node.userDescription === description
                ) {
                    result = node;
                    return;
                }
            } catch (e) {
            }

            let child = null;

            try {
                child = node.firstChild;
            } catch (e) {
            }

            while (child) {

                walk(child);

                if (result) {
                    return;
                }

                try {
                    child = child.nextSibling;
                } catch (e) {
                    child = null;
                }
            }
        }

        walk(root);

        return result;
    }


    function nodeExists(name) {

        return !!findNodeByDescription(
            doc.rootNode,
            name
        );
    }


    function makeUniqueName(baseName) {

        if (!nodeExists(baseName)) {
            return baseName;
        }

        let index = 2;

        while (
            nodeExists(
                baseName + " " + index
            )
        ) {
            index++;
        }

        return baseName + " " + index;
    }


    function findNodeWithin(root, description) {

        let result = null;

        function walk(node) {

            if (result) {
                return;
            }

            try {
                if (
                    node.description === description ||
                    node.userDescription === description
                ) {
                    result = node;
                    return;
                }
            } catch (e) {
            }

            let child = null;

            try {
                child = node.firstChild;
            } catch (e) {
            }

            while (child) {

                walk(child);

                if (result) {
                    return;
                }

                try {
                    child = child.nextSibling;
                } catch (e) {
                    child = null;
                }
            }
        }

        walk(root);

        return result;
    }


    function addAndFind(
        definition,
        targetNode,
        name,
        searchRoot
    ) {

        doc.addNode(
            definition,
            targetNode
        );

        const rootToSearch =
            searchRoot || doc.rootNode;

        const node =
            findNodeWithin(
                rootToSearch,
                name
            );

        if (!node) {
            throw new Error(
                "Could not locate newly created node: " +
                name
            );
        }

        return node;
    }


    // ========================================================================
    // SOURCE LAYER RANGE
    // ========================================================================
    //
    // Sets a node's Source Layer Range to:
    //
    //   Black = 0%
    //   White = 100%
    //   Linear
    //
    // Underlying Composition Range is left untouched.
    //
    // ========================================================================

    function setLinearSourceLayerRange(node) {

        const blendOptions =
            node.blendOptions;

        const sourceSpline =
            blendOptions
                .masterSourceLayerRanges
                .clone();

        const firstPoint =
            sourceSpline.getPoint(0);

        const lastPoint =
            sourceSpline.getPoint(-1);

        sourceSpline.clear();

        sourceSpline.insertPointXY(
            firstPoint.x,
            firstPoint.x
        );

        sourceSpline.insertPointXY(
            lastPoint.x,
            lastPoint.x
        );

        sourceSpline.isLinear = true;

        blendOptions.masterSourceLayerRanges =
            sourceSpline;

        const command =
            C.DocumentCommand.createSetBlendRanges(
                node.selfSelection,
                blendOptions
            );

        doc.executeCommand(
            command
        );
    }


    // ========================================================================
    // STRENGTH DIALOG
    // ========================================================================

    const dialog =
        D.Dialog.create(
            "Orton Glow"
        );

    dialog.initialWidth = 320;
    dialog.isResizable = false;


    const column =
        dialog.addColumn();

    const group =
        column.addGroup(
            "Settings"
        );


    const strengthEditor =
        group.addUnitValueEditor(
            "Strength",
            D.UnitType.Percentage,
            D.UnitType.Percentage,
            DEFAULT_STRENGTH,
            0,
            100
        );


    strengthEditor.precision = 0;
    strengthEditor.showPopupSlider = true;


    const result =
        dialog.runModal();


    if (
        !result.equals(
            D.DialogResult.Ok
        )
    ) {

        console.log(
            "Orton Glow cancelled."
        );

        return;
    }


    const strengthPercent =
        clamp(
            Number(strengthEditor.value),
            0,
            100
        );


    const GLOW_OPACITY =
        strengthPercent / 100;


    // ========================================================================
    // FIXED EFFECT VALUES
    // ========================================================================

    const HIGH_PASS_RADIUS =
        pxToInternalRadius(
            HIGH_PASS_UI_RADIUS
        );


    const BLUR_RADIUS =
        pxToInternalRadius(
            BLUR_UI_RADIUS
        );


    const LEVELS_BLACK =
        blackPercentToInternal(
            LEVELS_BLACK_PERCENT
        );


    const LEVELS_WHITE =
        whitePercentToInternal(
            LEVELS_WHITE_PERCENT
        );


    // ========================================================================
    // UNIQUE GROUP NAME
    // ========================================================================

    const ortonName =
        makeUniqueName(
            "Orton Glow"
        );


    // ========================================================================
    // 1. CREATE ORTON GLOW GROUP
    // ========================================================================
    //
    // No custom Blend Options are applied to the main group.
    //
    // ========================================================================

    const ortonDef =
        N.ContainerNodeDefinition.create(
            ortonName
        );


    const orton =
        addAndFind(
            ortonDef,
            null,
            ortonName,
            doc.rootNode
        );


    // ========================================================================
    // 2. CREATE GLOW GROUP
    // ========================================================================

    const glowDef =
        N.ContainerNodeDefinition.create(
            "Glow"
        );


    const glow =
        addAndFind(
            glowDef,
            orton,
            "Glow",
            orton
        );


    // Glow opacity = Strength selected by user

    doc.setOpacity(
        GLOW_OPACITY,
        glow.selfSelection
    );


    // Glow Source Layer Range:
    // Black 0% -> White 100%

    setLinearSourceLayerRange(
        glow
    );


    // ========================================================================
    // 3. LEVELS / CONTRAST
    // ========================================================================

    const levelsParams =
        N.LevelsAdjustmentParameters.create();


    levelsParams.masterParameters = {

        outputWhiteLevel: 1,

        outputBlackLevel: 0,

        gamma: 1,

        whiteLevel:
            LEVELS_WHITE,

        blackLevel:
            LEVELS_BLACK
    };


    const levelsDef =
        N.LevelsAdjustmentRasterNodeDefinition.createDefault(
            doc
        );


    levelsDef.parameters =
        levelsParams;


    levelsDef.userDescription =
        "Contrast";


    const contrast =
        addAndFind(
            levelsDef,
            glow,
            "Contrast",
            glow
        );


    // ========================================================================
    // 4. GAUSSIAN BLUR
    // ========================================================================

    const blurParams =
        N.GaussianBlurFilterParameters.create();


    blurParams.radius =
        BLUR_RADIUS;


    const blurDef =
        N.GaussianBlurFilterRasterNodeDefinition.create(
            blurParams
        );


    blurDef.userDescription =
        "Blur";


    blurDef.preserveAlpha =
        true;


    const blur =
        addAndFind(
            blurDef,
            glow,
            "Blur",
            glow
        );


    // Blur blend mode = Screen

    doc.setBlendMode(
        C.BlendMode.Screen,
        false,
        blur.selfSelection
    );


    // Blur opacity = 100%

    doc.setOpacity(
        1.0,
        blur.selfSelection
    );


    // ========================================================================
    // 5. HIGH PASS / SHARPEN
    // ========================================================================

    const highPassParams =
        N.HighPassFilterParameters.create();


    highPassParams.radius =
        HIGH_PASS_RADIUS;


    highPassParams.isMonochrome =
        false;


    const highPassDef =
        N.HighPassFilterRasterNodeDefinition.create(
            highPassParams
        );


    highPassDef.userDescription =
        "Sharpen";


    const sharpen =
        addAndFind(
            highPassDef,
            orton,
            "Sharpen",
            orton
        );


    // High Pass blend mode = Linear Light

    doc.setBlendMode(
        C.BlendMode.LinearLight,
        false,
        sharpen.selfSelection
    );


    // Sharpen Source Layer Range:
    // Black 0% -> White 100%

    setLinearSourceLayerRange(
        sharpen
    );


    // ========================================================================
    // FINISHED
    // ========================================================================

    console.log(
        "Orton Glow v1.1 created successfully."
    );

    console.log(
        "Group:",
        ortonName
    );

    console.log(
        "Strength:",
        strengthPercent,
        "%"
    );

    console.log(
        "Glow opacity:",
        strengthPercent,
        "%"
    );

    console.log(
        "Blur opacity: 100%"
    );
}

main();
