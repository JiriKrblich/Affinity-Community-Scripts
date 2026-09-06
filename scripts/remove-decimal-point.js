/**
 * name: Remove decimal point
 * description: By default, all decimal points of layer position dimensions will be eliminated. If a layer is selected, only the selected layer will be eliminated.
 * version: 1.1.0
 * author: OpenAI Codex
 */
'use strict';

const { app } = require('/application');
const { Document } = require('/document');
const { Dialog, DialogResult } = require('/dialog');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
const { Selection } = require('/selections');
const { Transform } = require('/geometry');
const { UnitType } = require('/units');

const EPSILON = 0.000001;
const MAX_DEPTH = 30;

function fail(message) {
    throw new Error(message);
}

function getCurrentDocument() {
    const document = Document.current;
    if (!document) fail('请先打开一个文档。');
    return document;
}

function getSelectedNodes(document) {
    return document.selection.nodes.toArray();
}

/**
 * 无选区时：收集当前文档所有 spread 下的全部节点（含子图层）。
 * 返回 levels 数组，levels[i] 为嵌套深度为 i 的节点列表（i=1 为顶层图层）。
 */
function collectAllNodesByLevel(document) {
    const levels = [];

    function walk(node, depth) {
        if (!node || depth > MAX_DEPTH) return;
        if (depth > 0) {
            if (!levels[depth]) levels[depth] = [];
            levels[depth].push(node);
        }
        let children = null;
        try { children = node.children; } catch (e) { children = null; }
        if (children) {
            for (const child of children) walk(child, depth + 1);
        }
    }

    for (const spread of document.spreads) {
        walk(spread, 0);
    }
    return levels.filter(Boolean);
}

function chooseOptions(processAll) {
    const dialog = Dialog.create('消除位置与尺寸小数');
    dialog.initialWidth = 340;
    const group = dialog.addColumn().addGroup(
        processAll ? '处理项目（全文档所有图层）' : '处理项目（仅选中对象）'
    );
    const roundPosition = group.addCheckBox('位置（X、Y）', true).setIsFullWidth();
    const roundSize = group.addCheckBox('尺寸（宽、高）', false).setIsFullWidth();

    const result = dialog.runModal();
    if (!result.equals(DialogResult.Ok)) return null;
    if (!roundPosition.value && !roundSize.value) {
        fail('请至少勾选“位置”或“尺寸”。');
    }
    return {
        roundPosition: roundPosition.value,
        roundSize: roundSize.value
    };
}

function getPixelsPerDocumentUnit(document) {
    const factor = document.unitValueConverter.getConversionFactor(
        document.units,
        UnitType.Pixel
    );
    if (!Number.isFinite(factor) || factor <= 0) {
        fail('无法读取当前文档的单位换算比例。');
    }
    return factor;
}

function roundToDocumentUnit(value, pixelsPerUnit) {
    return Math.round(value / pixelsPerUnit) * pixelsPerUnit;
}

function isFiniteBox(box) {
    return box &&
        Number.isFinite(box.x) && Number.isFinite(box.y) &&
        Number.isFinite(box.width) && Number.isFinite(box.height) &&
        box.width >= 0 && box.height >= 0;
}

/**
 * strict=true（选中模式）：无法处理时直接抛错。
 * strict=false（全文档模式）：无法处理时返回 null，由调用方跳过并计数。
 */
function prepareTransform(node, options, pixelsPerUnit, strict) {
    const box = node.getSpreadBaseBox(false);
    if (!isFiniteBox(box)) {
        if (strict) fail(`无法读取对象“${node.name || '未命名'}”的位置与尺寸。`);
        return null;
    }

    const targetX = options.roundPosition
        ? roundToDocumentUnit(box.x, pixelsPerUnit)
        : box.x;
    const targetY = options.roundPosition
        ? roundToDocumentUnit(box.y, pixelsPerUnit)
        : box.y;

    let scaleX = 1;
    let scaleY = 1;
    if (options.roundSize) {
        const targetWidth = roundToDocumentUnit(box.width, pixelsPerUnit);
        const targetHeight = roundToDocumentUnit(box.height, pixelsPerUnit);

        if (box.width > EPSILON && targetWidth <= EPSILON) {
            if (strict) fail(`对象“${node.name || '未命名'}”的宽度小于半个文档单位，无法安全取整。`);
            return null;
        }
        if (box.height > EPSILON && targetHeight <= EPSILON) {
            if (strict) fail(`对象“${node.name || '未命名'}”的高度小于半个文档单位，无法安全取整。`);
            return null;
        }

        if (box.width > EPSILON) scaleX = targetWidth / box.width;
        if (box.height > EPSILON) scaleY = targetHeight / box.height;
    }

    const dx = targetX - box.x;
    const dy = targetY - box.y;
    const sizeChanged = Math.abs(scaleX - 1) > EPSILON || Math.abs(scaleY - 1) > EPSILON;
    const positionChanged = Math.abs(dx) > EPSILON || Math.abs(dy) > EPSILON;
    if (!sizeChanged && !positionChanged) return null;

    let transform = Transform.createIdentity();
    if (sizeChanged) {
        transform = Transform.createScale(scaleX, scaleY).around(box.x, box.y);
    }
    if (positionChanged) {
        transform = Transform.createTranslate(dx, dy).multiply(transform);
    }
    return transform;
}

function executeCommands(document, commands) {
    if (!commands.length) return;
    if (commands.length === 1) {
        document.executeCommand(commands[0]);
    } else {
        const builder = CompoundCommandBuilder.create();
        for (const command of commands) builder.addCommand(command);
        document.executeCommand(builder.createCommand());
    }
}

function executeTransforms(document, nodes, options, pixelsPerUnit) {
    const commands = [];
    for (const node of nodes) {
        const transform = prepareTransform(node, options, pixelsPerUnit, true);
        if (!transform) continue;
        commands.push(
            DocumentCommand.createTransform(
                Selection.create(document, node),
                transform
            )
        );
    }

    executeCommands(document, commands);
    return commands.length;
}

/**
 * 全文档模式：按嵌套层级从浅到深分批执行。
 * 父对象先取整，子对象的位移基于取整后的最新坐标计算，
 * 避免父级移动与子级自身位移叠加造成二次偏移。
 * 锁定、隐藏或无法安全取整的对象自动跳过并计数。
 */
function executeTransformsByLevel(document, levels, options, pixelsPerUnit) {
    let changedCount = 0;
    let skippedCount = 0;

    for (const nodes of levels) {
        const commands = [];
        for (const node of nodes) {
            if (!node.isEditable) {
                skippedCount++;
                continue;
            }
            const transform = prepareTransform(node, options, pixelsPerUnit, false);
            if (!transform) {
                skippedCount++;
                continue;
            }
            commands.push(
                DocumentCommand.createTransform(
                    Selection.create(document, node),
                    transform
                )
            );
        }
        executeCommands(document, commands);
        changedCount += commands.length;
    }
    return { changedCount, skippedCount };
}

function main() {
    const document = getCurrentDocument();
    const selectedNodes = getSelectedNodes(document);
    const processAll = selectedNodes.length === 0;

    if (processAll) {
        const levels = collectAllNodesByLevel(document);
        const totalCount = levels.reduce((sum, list) => sum + list.length, 0);
        if (!totalCount) fail('当前文档中没有任何图层。');

        const options = chooseOptions(true);
        if (!options) return;

        const pixelsPerUnit = getPixelsPerDocumentUnit(document);
        const { changedCount, skippedCount } = executeTransformsByLevel(
            document, levels, options, pixelsPerUnit
        );

        if (!changedCount) {
            app.alert(
                `文档共 ${totalCount} 个图层，相应数值均已是整数${skippedCount ? `（${skippedCount} 个对象被跳过）` : ''}。`,
                '消除位置与尺寸小数'
            );
            return;
        }

        const itemNames = [];
        if (options.roundPosition) itemNames.push('位置');
        if (options.roundSize) itemNames.push('尺寸');
        console.log(
            `[全文档模式] 共处理 ${changedCount}/${totalCount} 个图层的${itemNames.join('和')}` +
            (skippedCount ? `，跳过 ${skippedCount} 个锁定或无法取整的对象` : '') +
            `（按嵌套层级分批执行，撤销记录为 ${levels.length} 条）。`
        );
    } else {
        const lockedCount = selectedNodes.filter((node) => !node.isEditable).length;
        if (lockedCount) {
            fail(`选区中有 ${lockedCount} 个锁定或不可编辑的对象，请先解锁。`);
        }

        const options = chooseOptions(false);
        if (!options) return;

        const pixelsPerUnit = getPixelsPerDocumentUnit(document);
        const changedCount = executeTransforms(
            document, selectedNodes, options, pixelsPerUnit
        );
        if (!changedCount) {
            app.alert('所选对象的相应数值已经是整数。', '消除位置与尺寸小数');
            return;
        }

        const itemNames = [];
        if (options.roundPosition) itemNames.push('位置');
        if (options.roundSize) itemNames.push('尺寸');
        console.log(`已处理 ${changedCount} 个对象的${itemNames.join('和')}。`);
    }
}

try {
    main();
} catch (error) {
    app.alert(error && error.message ? error.message : String(error), '消除位置与尺寸小数');
}
