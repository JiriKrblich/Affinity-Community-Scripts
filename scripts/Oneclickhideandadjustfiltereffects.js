/**
 * name: One click hide and adjust filter effects
 * description: Split multi-line text into single lines, split spaced single-line text into segments, and split unspaced single-line text into individual characters.
 * version: 0.2.1
 * author: OpenAI Codex
 */
'use strict';

const { app } = require('/application');
const { Selection } = require('/selections');
const { Dialog, DialogResult } = require('/dialog');

const TITLE = 'One click hide and adjust filter effects';

function getIndexedEffectIndex(effect, indexes) {
    if (effect.isOutlineLayerEffect) {
        return indexes.outline++;
    }
    if (effect.isInnerShadowLayerEffect) {
        return indexes.innerShadow++;
    }
    if (effect.isColourOverlayLayerEffect) {
        return indexes.colourOverlay++;
    }
    if (effect.isGradientOverlayLayerEffect) {
        return indexes.gradientOverlay++;
    }
    if (effect.isOuterShadowLayerEffect) {
        return indexes.outerShadow++;
    }
    return null;
}

function setLayerEffectEnabled(document, selection, effect, enabled, effectIndex) {
    if (effect.isBevelEmbossLayerEffect) {
        document.setBevelEmbossLayerEffectEnabled(selection, enabled);
        return true;
    }
    if (effect.isOutlineLayerEffect) {
        document.setOutlineLayerEffectEnabled(selection, effectIndex, enabled);
        return true;
    }
    if (effect.isPhongBevelLayerEffect) {
        document.setPhongBevelLayerEffectEnabled(selection, enabled);
        return true;
    }
    if (effect.isInnerShadowLayerEffect) {
        document.setInnerShadowLayerEffectEnabled(selection, effectIndex, enabled);
        return true;
    }
    if (effect.isInnerGlowLayerEffect) {
        document.setInnerGlowLayerEffectEnabled(selection, enabled);
        return true;
    }
    if (effect.isColourOverlayLayerEffect) {
        document.setColourOverlayLayerEffectEnabled(selection, effectIndex, enabled);
        return true;
    }
    if (effect.isGradientOverlayLayerEffect) {
        document.setGradientOverlayLayerEffectEnabled(selection, effectIndex, enabled);
        return true;
    }
    if (effect.isOuterGlowLayerEffect) {
        document.setOuterGlowLayerEffectEnabled(selection, enabled);
        return true;
    }
    if (effect.isOuterShadowLayerEffect) {
        document.setOuterShadowLayerEffectEnabled(selection, effectIndex, enabled);
        return true;
    }
    if (effect.isGaussianBlurLayerEffect) {
        document.setGaussianBlurLayerEffectEnabled(selection, enabled);
        return true;
    }
    return false;
}

function chooseMode() {
    const dialog = Dialog.create(TITLE);
    const group = dialog.addColumn().addGroup('操作');
    const action = group.addRadioGroup('选择操作', ['全部隐藏', '全部开启'], 0);

    if (dialog.runModal().value != DialogResult.Ok) {
        return null;
    }

    return action.selectedIndex === 0 ? 'hide' : 'show';
}

// Hide every adjustment/filter raster node and disable every layer effect in
// the current document, including nodes nested inside groups and layers.
function oneClickHideAndAdjustFilterEffects() {
    const document = app.documents.current;
    if (!document) {
        app.alert('没有打开的文档。', TITLE);
        return;
    }

    const mode = chooseMode();
    if (!mode) {
        return;
    }

    const adjustmentNodes = [];
    const filterNodes = [];
    let effectCount = 0;
    const visited = new Set();

    function visit(node) {
        if (!node || visited.has(node)) {
            return;
        }
        visited.add(node);

        const effects = node.layerEffectsInterface;
        const selection = effects.effectCount > 0
            ? Selection.create(document, node)
            : null;
        const indexes = {
            outline: 0,
            innerShadow: 0,
            colourOverlay: 0,
            gradientOverlay: 0,
            outerShadow: 0
        };
        for (const effect of effects.effects) {
            const enabled = mode === 'show';
            const effectIndex = getIndexedEffectIndex(effect, indexes);
            if (effect.enabled !== enabled) {
                if (setLayerEffectEnabled(document, selection, effect, enabled, effectIndex)) {
                    effectCount += 1;
                }
            }
        }

        if (node.isAdjustmentRasterNode) {
            adjustmentNodes.push(node);
        }
        if (node.isFilterRasterNode) {
            filterNodes.push(node);
        }

        // Any layer may contain nested nodes. Groups normally expose them
        // through children; adjustment and mask nodes may use enclosures.
        for (const child of node.children) {
            visit(child);
        }

        for (const enclosure of node.enclosures) {
            visit(enclosure);
        }
    }

    for (const node of document.layers) {
        visit(node);
    }

    // Hide nodes one at a time so nested adjustment/filter layers are handled
    // independently.
    for (const adjustmentNode of [...adjustmentNodes, ...filterNodes]) {
        const selection = Selection.create(document, adjustmentNode);
        document.setVisible(mode === 'show', selection);
    }

    app.alert(
        mode === 'hide'
            ? `已隐藏 ${adjustmentNodes.length} 个调整图层和 ${filterNodes.length} 个滤镜图层，并关闭 ${effectCount} 个特效。`
            : `已开启 ${adjustmentNodes.length} 个调整图层和 ${filterNodes.length} 个滤镜图层，并开启 ${effectCount} 个特效。`,
        TITLE
    );
}

oneClickHideAndAdjustFilterEffects();


