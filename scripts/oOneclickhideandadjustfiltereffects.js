/**
 * name: One click hide and adjust filter effects
 * description: Split multi-line text into single lines, split spaced single-line text into segments, and split unspaced single-line text into individual characters.
 * version: 0.1.0
 * author: OpenAI Codex
 */
'use strict';

const { app } = require('/application');
const { Selection } = require('/selections');

// Hide every adjustment/filter raster node and disable every layer effect in
// the current document, including nodes nested inside groups and layers.
function hideAllEffectsAndAdjustments() {
    const document = app.documents.current;
    if (!document) {
        app.alert('没有打开的文档。', '隐藏特效与调整图层');
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
        for (const effect of effects.effects) {
            if (effect.enabled) {
                effect.enabled = false;
                effectCount += 1;
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
        document.setVisible(false, selection);
    }

    app.alert(
        `已隐藏 ${adjustmentNodes.length} 个调整图层和 ${filterNodes.length} 个滤镜图层，并关闭 ${effectCount} 个特效。`,
        '隐藏特效与调整图层'
    );
}

hideAllEffectsAndAdjustments();
