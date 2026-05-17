'use strict';
// Replace All with Key Object v22.5 SDK fix
// Compatibility update for Affinity SDK changes:
// - Document.current -> app.documents.current fallback
// - robust spread bbox/localToSpreadTransform based helpers
// - stable duplicate translation is applied inside duplicate(transform)
// - optional target fill/stroke colour and stroke value adoption
// - style adoption is applied directly to replacement duplicates after base move/delete
// - live preview uses managed temporary duplicates and preview visibility only
// - option values are captured by dialog change handlers, previewed live, then applied once on OK
// - single-shape preview and final apply now share the same in-place compound command
// - final cleanup restores history before deleting any surviving temporary preview duplicates
// - adopt target stroke value now applies stroke weight through LineStyleMask.Weight
// - library-safe main export plus explicit main() call

const { app } = require('/application');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
const { NodeMoveType, NodeChildType } = require('affinity:dom');
const { Dialog, DialogResult } = require('/dialog');
const { Transform } = require('/geometry');
const { FillDescriptor } = require('/fills');
const { LineStyle, LineStyleDescriptor, LineStyleMask } = require('/linestyle');
const { Selection } = require('/selections');

const APP_NAME = 'Replace All with Key Object';
const EPS = 1e-9;

function getCurrentDocument() {
    try {
        if (app && app.documents) {
            if (app.documents.current) return app.documents.current;
            if (app.documents.all) {
                for (const d of app.documents.all) return d;
            }
        }
    } catch (e) {}

    try {
        const { Document } = require('/document');
        return Document.current || null;
    } catch (e) {
        return null;
    }
}

function nodeTag(node) {
    try {
        return node && node[Symbol.toStringTag] ? String(node[Symbol.toStringTag]) : '';
    } catch (e) {
        return '';
    }
}

function isSameNode(a, b) {
    if (!a || !b) return false;
    try {
        return a.isSameNode(b);
    } catch (e) {
        return a === b;
    }
}

function addUnique(nodes, node) {
    if (!node) return;
    if (!nodes.some(n => isSameNode(n, node))) nodes.push(node);
}

function getSelectionNodes(doc) {
    const nodes = [];
    const sel = doc && doc.selection;
    if (!sel) return nodes;

    try {
        if (sel.nodes) {
            for (const n of sel.nodes) addUnique(nodes, n);
            return nodes;
        }
    } catch (e) {}

    try {
        const len = sel.length || 0;
        for (let i = 0; i < len; i++) {
            const item = sel.at(i);
            addUnique(nodes, item && item.node ? item.node : item);
        }
    } catch (e) {}

    return nodes;
}

function getTopLevelNodes(nodes) {
    return nodes.filter(n => {
        let p = n.parent;
        while (p) {
            if (nodes.some(s => isSameNode(s, p))) return false;
            p = p.parent;
        }
        return true;
    });
}

function isFiniteBox(box) {
    return !!box &&
        Number.isFinite(box.x) &&
        Number.isFinite(box.y) &&
        Number.isFinite(box.width) &&
        Number.isFinite(box.height);
}

function getSpreadBox(node) {
    try {
        const exact = node.exactSpreadBaseBox;
        if (isFiniteBox(exact)) return exact;
    } catch (e) {}

    try {
        const box = node.getSpreadBaseBox(false);
        if (isFiniteBox(box)) return box;
    } catch (e) {}

    throw new Error('Cannot read object bounds.');
}

function getWorldTransform(node) {
    try {
        const localToSpread = node.localToSpreadTransform;
        const own = node.transformInterface && node.transformInterface.transform;
        if (localToSpread && own && typeof localToSpread.multiply === 'function') {
            return localToSpread.multiply(own);
        }
    } catch (e) {}

    try {
        if (node.baseToSpreadTransform) return node.baseToSpreadTransform;
    } catch (e) {}

    try {
        return node.transformInterface && node.transformInterface.transform;
    } catch (e) {
        return null;
    }
}

function decomposeWorld(node) {
    try {
        const t = getWorldTransform(node);
        if (t && typeof t.decompose === 'function') return t.decompose();
    } catch (e) {}
    return { rotation: 0, scaleX: 1, scaleY: 1 };
}

function firstChildForVisuals(node) {
    if (nodeTag(node) !== 'GroupNode') return node;
    try {
        for (const child of node.children) return child;
    } catch (e) {}
    return node;
}

function collectNodeTree(node) {
    const nodes = [];

    function visit(n) {
        if (!n) return;
        nodes.push(n);

        try {
            for (const child of n.children) visit(child);
            return;
        } catch (e) {}

        try {
            let child = n.firstChild;
            while (child) {
                visit(child);
                child = child.nextSibling;
            }
        } catch (e) {}
    }

    visit(node);
    return nodes;
}

function getVisualRotation(node) {
    const source = firstChildForVisuals(node);
    return decomposeWorld(source).rotation || 0;
}

function getIntrinsicSize(node) {
    const source = firstChildForVisuals(node);
    const d = decomposeWorld(source);
    const bb = source.baseBox || getSpreadBox(source);
    const sx = Math.abs(d.scaleX || 1);
    const sy = Math.abs(d.scaleY || 1);
    return {
        w: Math.max(EPS, sx * Math.abs(bb.width || 0)),
        h: Math.max(EPS, sy * Math.abs(bb.height || 0))
    };
}

function cloneFill(rawFill) {
    try {
        if (rawFill && rawFill.clone) return rawFill.clone();
    } catch (e) {}
    return rawFill;
}

function cloneFillDescriptor(fd) {
    if (!fd) return null;

    try {
        if (!fd.fill) return FillDescriptor.createNone();

        return FillDescriptor.create(
            cloneFill(fd.fill),
            fd.isScaleWithObject,
            fd.transform,
            fd.blendMode,
            fd.isAnchoredToSpread
        );
    } catch (e) {
        return null;
    }
}

function getBrushFillDescriptor(node) {
    try {
        if (node.brushFillDescriptor) return node.brushFillDescriptor;
    } catch (e) {}

    try {
        if (node.brushFillInterface) {
            return node.brushFillInterface.getCurrentDescriptor(false);
        }
    } catch (e) {}

    return null;
}

function getPenFillDescriptor(node) {
    try {
        if (node.penFillDescriptor) return node.penFillDescriptor;
    } catch (e) {}

    try {
        if (node.penFillInterface) {
            return node.penFillInterface.getCurrentDescriptor(false);
        }
    } catch (e) {}

    return null;
}

function findBrushFillDescriptor(node) {
    const nodes = collectNodeTree(node);
    for (const n of nodes) {
        try {
            if (n.hasBrushFill === false) continue;
        } catch (e) {}

        const fd = getBrushFillDescriptor(n);
        if (fd && fd.fill) return fd;
    }
    return null;
}

function findPenFillDescriptor(node) {
    const nodes = collectNodeTree(node);
    for (const n of nodes) {
        try {
            if (n.hasPenFill === false) continue;
        } catch (e) {}

        try {
            if (Number.isFinite(n.lineWeight) && n.lineWeight <= 0) continue;
        } catch (e) {}

        const fd = getPenFillDescriptor(n);
        if (fd && fd.fill) return fd;
    }
    return null;
}

function getLineStyleDescriptor(node) {
    try {
        const lsi = node.lineStyleInterface;
        if (lsi) return lsi.getCurrentLineStyleDescriptor();
    } catch (e) {}

    try {
        if (node.lineStyleDescriptor) return node.lineStyleDescriptor;
    } catch (e) {}

    return null;
}

function findLineStyleDescriptor(node) {
    const nodes = collectNodeTree(node);
    for (const n of nodes) {
        try {
            if (n.hasPenFill === false) continue;
        } catch (e) {}

        const lsd = getLineStyleDescriptor(n);
        if (lsd) return lsd;
    }
    return null;
}

function cloneLineStyleDescriptor(lsd) {
    try {
        if (lsd && lsd.clone) return lsd.clone();
    } catch (e) {}
    return lsd || null;
}

function createLineStyleDescriptorWithWeightPts(sourceLsd, weightPts, doc) {
    let lsd = cloneLineStyleDescriptor(sourceLsd);
    const pixels = weightPts * doc.dpi / 72;

    if (!lsd) {
        try {
            return LineStyleDescriptor.createDefault(pixels);
        } catch (e) {
            return null;
        }
    }

    try {
        if (lsd.lineStyle) lsd.lineStyle.weight = pixels;
    } catch (e) {}

    return lsd;
}

function createSetStrokeWeightCommand(selection, weightPts, doc) {
    if (!Number.isFinite(weightPts) || weightPts <= 0) return null;

    const lineStyle = LineStyle.createDefault();
    lineStyle.weight = weightPts * doc.dpi / 72;

    return DocumentCommand.createSetLineStyle(selection, lineStyle, {
        lineStyleMask: LineStyleMask.Weight
    });
}

function readLineWeightPts(node) {
    try {
        const lsi = node.lineStyleInterface;
        if (lsi && Number.isFinite(lsi.lineWeightPts)) return lsi.lineWeightPts;
    } catch (e) {}

    try {
        if (Number.isFinite(node.lineWeightPts)) return node.lineWeightPts;
    } catch (e) {}

    try {
        if (Number.isFinite(node.lineWeight)) return node.lineWeight;
    } catch (e) {}

    return null;
}

function findStrokeWeightPts(node) {
    const nodes = collectNodeTree(node);
    for (const n of nodes) {
        try {
            if (n.hasPenFill === false) continue;
        } catch (e) {}

        const weight = readLineWeightPts(n);
        if (Number.isFinite(weight) && weight > 0) return weight;
    }
    return null;
}

function setNodeLineWeightPts(node, weight) {
    try {
        const lsi = node.lineStyleInterface;
        if (lsi) {
            lsi.lineWeightPts = weight;
            return true;
        }
    } catch (e) {}

    try {
        node.lineWeightPts = weight;
        return true;
    } catch (e) {}

    try {
        node.lineWeight = weight;
        return true;
    } catch (e) {}

    return false;
}

function applyStrokeWeightToDuplicate(dup, weight) {
    if (!Number.isFinite(weight) || weight <= 0) return 0;

    let count = 0;
    for (const n of collectNodeTree(dup)) {
        if (setNodeLineWeightPts(n, weight)) count++;
    }
    return count;
}

function setNodeBrushFillDescriptor(node, fd) {
    try {
        node.brushFillDescriptor = fd;
        return true;
    } catch (e) {}

    try {
        if (node.brushFillInterface) {
            node.brushFillInterface.currentDescriptor = fd;
            return true;
        }
    } catch (e) {}

    return false;
}

function setNodePenFillDescriptor(node, fd) {
    try {
        node.penFillDescriptor = fd;
        return true;
    } catch (e) {}

    try {
        if (node.penFillInterface) {
            node.penFillInterface.currentDescriptor = fd;
            return true;
        }
    } catch (e) {}

    return false;
}

function applyAdoptFillToDuplicate(dup, target) {
    const sourceFd = findBrushFillDescriptor(target);
    if (!sourceFd) return 0;
    return applyBrushDescriptorToDuplicate(dup, sourceFd);
}

function applyBrushDescriptorToDuplicate(dup, sourceFd) {
    if (!sourceFd) return 0;

    let count = 0;
    for (const n of collectNodeTree(dup)) {
        try {
            const fd = cloneFillDescriptor(sourceFd);
            if (!fd) continue;
            if (setNodeBrushFillDescriptor(n, fd)) count++;
        } catch (e) {}
    }
    return count;
}

function applyAdoptStrokeToDuplicate(dup, target) {
    const sourceFd = findPenFillDescriptor(target);
    if (!sourceFd) return 0;
    return applyPenDescriptorToDuplicate(dup, sourceFd);
}

function applyPenDescriptorToDuplicate(dup, sourceFd) {
    if (!sourceFd) return 0;

    let count = 0;
    for (const n of collectNodeTree(dup)) {
        try {
            const fd = cloneFillDescriptor(sourceFd);
            if (!fd) continue;
            if (setNodePenFillDescriptor(n, fd)) count++;
        } catch (e) {}
    }
    return count;
}

function makeScaleAbout(cx, cy, sx, sy) {
    return Transform.createTranslate(cx, cy)
        .multiply(Transform.createScale(sx, sy))
        .multiply(Transform.createTranslate(-cx, -cy));
}

function makeRotateAbout(cx, cy, rotation) {
    return Transform.createTranslate(cx, cy)
        .multiply(Transform.createRotate(rotation))
        .multiply(Transform.createTranslate(-cx, -cy));
}

function makeSelection(doc, nodes) {
    const usable = [];
    for (const node of nodes) {
        try {
            if (node && node.document) usable.push(node);
        } catch (e) {}
    }

    return usable.length ? Selection.create(doc, usable, true) : null;
}

function deleteNodes(doc, nodes) {
    const sel = makeSelection(doc, nodes);
    if (!sel) return;

    try {
        doc.executeCommand(DocumentCommand.createDeleteSelection(sel, true));
    } catch (e) {}
}

function isShapeNode(node) {
    return nodeTag(node) === 'ShapeNode';
}

function cloneNodeShape(node) {
    try {
        const shape = node.shape || (node.shapeInterface && node.shapeInterface.shape);
        if (shape && shape.clone) return shape.clone();
        return shape || null;
    } catch (e) {
        return null;
    }
}

function canReplaceInPlace(keyNode, targets) {
    if (!isShapeNode(keyNode) || !cloneNodeShape(keyNode)) return false;
    for (const target of targets) {
        if (!isShapeNode(target) || !cloneNodeShape(target)) return false;
    }
    return true;
}

function createReplaceInPlaceCommand(doc, keyNode, targets, ignoreSize, adoptFill, adoptStroke, adoptStrokeValue) {
    const eligible = targets.filter(t => {
        try {
            return t.isEditable;
        } catch (e) {
            return true;
        }
    });

    if (eligible.length === 0 || !canReplaceInPlace(keyNode, eligible)) {
        return { command: null, count: 0 };
    }

    const kSize = getIntrinsicSize(keyNode);
    const keyBrushFd = findBrushFillDescriptor(keyNode);
    const keyPenFd = findPenFillDescriptor(keyNode);
    const keyLineStyle = findLineStyleDescriptor(keyNode);

    const cb = CompoundCommandBuilder.create();
    let changed = 0;

    for (const target of eligible) {
        const targetSelection = target.selfSelection;
        const targetShape = cloneNodeShape(keyNode);
        if (!targetShape) return { command: null, count: 0 };

        cb.addCommand(DocumentCommand.createSetShape(
            targetSelection,
            targetShape,
            { allowReplaceLikeShapes: true }
        ));

        if (ignoreSize) {
            const tBB = getSpreadBox(target);
            const tSize = getIntrinsicSize(target);
            const tCx = tBB.x + tBB.width / 2;
            const tCy = tBB.y + tBB.height / 2;
            const sx = kSize.w / tSize.w;
            const sy = kSize.h / tSize.h;

            if (Number.isFinite(sx) && Number.isFinite(sy) &&
                (Math.abs(sx - 1) > 0.01 || Math.abs(sy - 1) > 0.01)) {
                cb.addCommand(DocumentCommand.createTransform(
                    targetSelection,
                    makeScaleAbout(tCx, tCy, sx, sy)
                ));
            }
        }

        const brushFd = adoptFill ? findBrushFillDescriptor(target) : keyBrushFd;
        if (brushFd) {
            cb.addCommand(DocumentCommand.createSetBrushFill(
                targetSelection,
                cloneFillDescriptor(brushFd)
            ));
        }

        const penFd = adoptStroke ? findPenFillDescriptor(target) : keyPenFd;
        if (penFd) {
            cb.addCommand(DocumentCommand.createSetPenFill(
                targetSelection,
                cloneFillDescriptor(penFd)
            ));
        }

        let lineStyle = cloneLineStyleDescriptor(keyLineStyle);
        let strokeWeight = null;
        if (adoptStrokeValue) {
            strokeWeight = findStrokeWeightPts(target);
            if (Number.isFinite(strokeWeight) && strokeWeight > 0) {
                lineStyle = createLineStyleDescriptorWithWeightPts(lineStyle || keyLineStyle, strokeWeight, doc);
            }
        }

        if (lineStyle) {
            cb.addCommand(DocumentCommand.createSetLineStyleDescriptor(targetSelection, lineStyle));
        }

        if (Number.isFinite(strokeWeight) && strokeWeight > 0) {
            const weightCmd = createSetStrokeWeightCommand(targetSelection, strokeWeight, doc);
            if (weightCmd) cb.addCommand(weightCmd);
        }

        changed++;
    }

    if (changed === 0) return { command: null, count: 0 };
    return { command: cb.createCommand(), count: changed + 1 };
}

function doReplaceInPlaceOneUndo(doc, keyNode, targets, ignoreSize, adoptFill, adoptStroke, adoptStrokeValue) {
    const replacement = createReplaceInPlaceCommand(doc, keyNode, targets, ignoreSize, adoptFill, adoptStroke, adoptStrokeValue);
    if (!replacement.command) return 0;
    doc.executeCommand(replacement.command);
    return replacement.count;
}

function replaceWithKey(doc, keyNode, targets, ignoreSize, adoptFill, adoptStroke, adoptStrokeValue, deleteTargets) {
    const eligible = targets.filter(t => {
        try {
            return t.isEditable;
        } catch (e) {
            return true;
        }
    });
    if (eligible.length === 0) return { count: 0, duplicates: [] };

    const kBB = getSpreadBox(keyNode);
    const kCx = kBB.x + kBB.width / 2;
    const kCy = kBB.y + kBB.height / 2;
    const kRot = getVisualRotation(keyNode);
    const kSize = getIntrinsicSize(keyNode);

    const baseCb = CompoundCommandBuilder.create();
    let replaced = 0;
    const pendingStyles = [];
    const duplicates = [];

    for (const target of eligible) {
        const tBB = getSpreadBox(target);
        const tCx = tBB.x + tBB.width / 2;
        const tCy = tBB.y + tBB.height / 2;
        const tRot = getVisualRotation(target);
        const tSize = getIntrinsicSize(target);
        const deltaRot = tRot - kRot;
        const sx = ignoreSize ? 1 : tSize.w / kSize.w;
        const sy = ignoreSize ? 1 : tSize.h / kSize.h;
        const strokeWeight = adoptStrokeValue ? findStrokeWeightPts(target) : null;

        const dup = keyNode.duplicate(Transform.createTranslate(tCx - kCx, tCy - kCy));
        if (!dup) continue;
        replaced++;
        duplicates.push(dup);
        pendingStyles.push({
            dup,
            target,
            adoptFill,
            adoptStroke,
            strokeWeight
        });

        if (!ignoreSize && (Math.abs(sx - 1) > 0.01 || Math.abs(sy - 1) > 0.01)) {
            baseCb.addCommand(DocumentCommand.createTransform(
                dup.selfSelection,
                makeScaleAbout(tCx, tCy, sx, sy)
            ));
        }

        if (Math.abs(deltaRot) > 0.001) {
            baseCb.addCommand(DocumentCommand.createTransform(
                dup.selfSelection,
                makeRotateAbout(tCx, tCy, deltaRot)
            ));
        }

        baseCb.addCommand(DocumentCommand.createMoveNodes(
            dup.selfSelection, target, NodeMoveType.After, NodeChildType.Main
        ));

        if (deleteTargets) {
            baseCb.addCommand(DocumentCommand.createDeleteSelection(target.selfSelection, true));
        }
    }

    if (replaced === 0) {
        return { count: 0, duplicates };
    }

    try {
        doc.executeCommand(baseCb.createCommand());
    } catch (e) {
        for (let i = 0; i < replaced; i++) {
            try {
                doc.executeCommand(DocumentCommand.createUndo());
            } catch (undoErr) {}
        }
        throw e;
    }

    for (const pending of pendingStyles) {
        if (pending.adoptFill) {
            applyAdoptFillToDuplicate(pending.dup, pending.target);
        }

        if (pending.adoptStroke) {
            applyAdoptStrokeToDuplicate(pending.dup, pending.target);
        }

        if (Number.isFinite(pending.strokeWeight) && pending.strokeWeight > 0) {
            applyStrokeWeightToDuplicate(pending.dup, pending.strokeWeight);
        }
    }

    return { count: replaced, duplicates };
}

function doReplace(doc, keyNode, targets, ignoreSize, adoptFill, adoptStroke, adoptStrokeValue, forceDuplicate) {
    if (!forceDuplicate) {
        try {
            const oneUndoCount = doReplaceInPlaceOneUndo(doc, keyNode, targets, ignoreSize, adoptFill, adoptStroke, adoptStrokeValue);
            if (oneUndoCount > 0) return oneUndoCount;
        } catch (e) {
            console.log('One-step shape replace failed, using duplicate fallback: ' + e.message);
        }
    }

    const result = replaceWithKey(doc, keyNode, targets, ignoreSize, adoptFill, adoptStroke, adoptStrokeValue, true);
    if (result.count === 0) return 0;
    return result.count + 1;
}

function createPreviewReplacements(doc, keyNode, targets, ignoreSize, adoptFill, adoptStroke, adoptStrokeValue) {
    try {
        const replacement = createReplaceInPlaceCommand(doc, keyNode, targets, ignoreSize, adoptFill, adoptStroke, adoptStrokeValue);
        if (replacement.command) {
            doc.executeCommand(replacement.command, true);
            return { duplicates: [], hideTargets: false, mode: 'inPlace' };
        }
    } catch (e) {
        console.log('In-place live preview failed, using duplicate preview: ' + e.message);
    }

    return {
        duplicates: replaceWithKey(doc, keyNode, targets, ignoreSize, adoptFill, adoptStroke, adoptStrokeValue, false).duplicates,
        hideTargets: true,
        mode: 'duplicate'
    };
}

function showMessage(title, message) {
    try {
        const dlg = Dialog.create(title);
        dlg.addColumn().addGroup('').addStaticText('', message).isFullWidth = true;
        dlg.show();
    } catch (e) {
        console.log(title + ': ' + message);
    }
}

function main() {
    const doc = getCurrentDocument();
    if (!doc) {
        showMessage(APP_NAME, 'No document open.');
        return;
    }

    function captureTopLevelNodes() {
        return getTopLevelNodes(getSelectionNodes(doc));
    }

    let topLevel = captureTopLevelNodes();

    if (topLevel.length < 2) {
        showMessage(APP_NAME, 'Select at least 2 objects (key + targets) and run again.');
        return;
    }

    const historyStart = doc.history.position;
    let previewNodes = [];
    let previewCleanupNodes = [];
    let capturedPreviewMode = 'inPlace';
    let inPreview = false;

    function clearDocumentPreviews() {
        try {
            doc.executeCommand(DocumentCommand.createClearPreviews());
        } catch (e) {}
    }

    function clearTemporaryPreview() {
        clearDocumentPreviews();

        if (previewNodes.length) {
            const oldPreviewNodes = previewNodes;
            previewNodes = [];
            deleteNodes(doc, oldPreviewNodes);
        }
    }

    function restoreHistoryStart() {
        clearDocumentPreviews();

        try {
            if (doc.history.position !== historyStart) {
                doc.history.position = historyStart;
            }
        } catch (e) {}
    }

    function rememberPreviewNodes(nodes) {
        for (const node of nodes) addUnique(previewCleanupNodes, node);
    }

    function discardAllPreviewState() {
        const cleanupNodes = previewCleanupNodes;
        previewNodes = [];
        previewCleanupNodes = [];

        restoreHistoryStart();
        deleteNodes(doc, cleanupNodes);
        clearDocumentPreviews();
    }

    function applyTargetHidePreview(targets) {
        const sel = makeSelection(doc, targets);
        if (!sel) return;

        try {
            doc.executeCommand(DocumentCommand.createSetVisibility(sel, false), true);
        } catch (e) {}
    }

    const labels = topLevel.map((n, i) => {
        const b = getSpreadBox(n);
        const desc = n.userDescription || n.defaultDescription || nodeTag(n).replace('Node', '') || 'Object';
        const tag = nodeTag(n).replace('Node', '') || 'Node';
        return `[${i + 1}]  ${desc}   ${b.width.toFixed(0)} x ${b.height.toFixed(0)}  (${tag})`;
    });

    const dlg = Dialog.create(APP_NAME);
    dlg.initialWidth = 420;
    const col = dlg.addColumn();

    const grpKey = col.addGroup('Key Object');
    grpKey.addStaticText('', 'Template object - replaces all other selected objects:');
    const keyCombo = grpKey.addComboBox('', labels, 0);
    keyCombo.isFullWidth = true;

    const grpOpts = col.addGroup('Options');
    const matchSizeCk = grpOpts.addCheckBox('Adopt target dimensions (override key size)', false);
    matchSizeCk.isFullWidth = true;
    const adoptFillCk = grpOpts.addCheckBox('Adopt target fill color', false);
    adoptFillCk.isFullWidth = true;
    const adoptStrokeCk = grpOpts.addCheckBox('Adopt target stroke color', false);
    adoptStrokeCk.isFullWidth = true;
    const adoptStrokeValueCk = grpOpts.addCheckBox('Adopt target stroke value', false);
    adoptStrokeValueCk.isFullWidth = true;

    const grpInfo = col.addGroup('');
    grpInfo.enableSeparator = true;
    grpInfo.addStaticText('', `${topLevel.length} objects - 1 key - ${topLevel.length - 1} target(s)`).isFullWidth = true;
    grpInfo.addStaticText('', 'Live preview updates when the key or options change.').isFullWidth = true;
    grpInfo.addStaticText('', 'OK - applies once. Cancel - clears the preview.').isFullWidth = true;

    const grpSpacer = col.addGroup('');
    grpSpacer.addStaticText('', '').isFullWidth = true;
    grpSpacer.addStaticText('', '').isFullWidth = true;

    function readControlValues() {
        const keyIdx = keyCombo.selectedIndex;
        return {
            keyIdx,
            ignoreSize: !matchSizeCk.value,
            adoptFill: adoptFillCk.value,
            adoptStroke: adoptStrokeCk.value,
            adoptStrokeValue: adoptStrokeValueCk.value
        };
    }

    let capturedControls = readControlValues();

    function captureControlValues() {
        capturedControls = readControlValues();
    }

    function buildValues(controlValues) {
        if (topLevel.length < 2) {
            throw new Error('Selection could not be restored for preview.');
        }

        const keyIdx = Math.min(Math.max(controlValues.keyIdx, 0), topLevel.length - 1);
        return {
            keyIdx,
            keyNode: topLevel[keyIdx],
            targets: topLevel.filter((_, i) => i !== keyIdx),
            ignoreSize: controlValues.ignoreSize,
            adoptFill: controlValues.adoptFill,
            adoptStroke: controlValues.adoptStroke,
            adoptStrokeValue: controlValues.adoptStrokeValue
        };
    }

    function applyPreview() {
        if (inPreview) return;
        inPreview = true;

        try {
            captureControlValues();
            clearTemporaryPreview();

            const values = buildValues(capturedControls);
            const preview = createPreviewReplacements(
                doc,
                values.keyNode,
                values.targets,
                values.ignoreSize,
                values.adoptFill,
                values.adoptStroke,
                values.adoptStrokeValue
            );
            previewNodes = preview.duplicates;
            capturedPreviewMode = preview.mode;
            rememberPreviewNodes(previewNodes);
            if (preview.hideTargets) applyTargetHidePreview(values.targets);
            console.log(`Live preview: ${values.targets.length} object(s) replaced.`);
        } catch (e) {
            console.log('Live preview failed: ' + e.message);
            clearTemporaryPreview();
        } finally {
            inPreview = false;
        }
    }

    keyCombo.onValueChangedHandler = applyPreview;
    matchSizeCk.onValueChangedHandler = applyPreview;
    adoptFillCk.onValueChangedHandler = applyPreview;
    adoptStrokeCk.onValueChangedHandler = applyPreview;
    adoptStrokeValueCk.onValueChangedHandler = applyPreview;

    applyPreview();

    const result = dlg.show();
    const finalControls = capturedControls;

    discardAllPreviewState();

    const finalTopLevel = captureTopLevelNodes();
    if (finalTopLevel.length === topLevel.length) {
        topLevel = finalTopLevel;
    }

    if (result.value === DialogResult.Ok.value) {
        const finalValues = buildValues(finalControls);
        doReplace(
            doc,
            finalValues.keyNode,
            finalValues.targets,
            finalValues.ignoreSize,
            finalValues.adoptFill,
            finalValues.adoptStroke,
            finalValues.adoptStrokeValue,
            capturedPreviewMode === 'duplicate'
        );
        console.log(`Applied: ${finalValues.targets.length} object(s) replaced.`);
    } else {
        console.log('Cancelled - preview cleared.');
    }
}

module.exports.main = main;
main();