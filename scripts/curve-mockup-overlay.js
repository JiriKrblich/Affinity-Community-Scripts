/**
 * name: Curve Mockup Overlay
 * description: Draw presentation-style fake anchor points and Bezier handles over the selected curve.
 * version: 1.0.0
 * author: JiriKrblich / Codex
 */

'use strict';

const { Document } = require('/document');
const { Dialog, DialogResult } = require('/dialog');
const { UnitType } = require('/units');
const { DocumentCommand, AddChildNodesCommandBuilder, NodeChildType } = require('/commands');
const { Selection } = require('/selections');
const { Curve, PolyCurve, Rectangle } = require('/geometry');
const { PolyCurveNodeDefinition } = require('/nodes');
const { FillDescriptor } = require('/fills');
const { LineStyleDescriptor } = require('/linestyle');
const { Colour } = require('/colours');

const DEFAULTS = {
    colourHex: '#D71920',
    anchorSize: 8,
    handleSize: 7,
    strokeWidth: 2,
    distinguishPointTypes: true,
    includeHandles: true
};

let previewNodes = [];

function showMessage(title, message) {
    const dlg = Dialog.create(title);
    dlg.addColumn().addGroup('').addStaticText('', message).isFullWidth = true;
    dlg.show();
}

function clampByte(value) {
    return Math.max(0, Math.min(255, Math.round(value)));
}

function parseHexColour(text) {
    const raw = String(text || '').trim().replace(/^#/, '');
    const hex = raw.length === 3
        ? raw.split('').map(ch => ch + ch).join('')
        : raw;

    if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
        throw new Error('Color must be a HEX value like #D71920.');
    }

    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return Colour.createRGBAuf({
        r: clampByte(r) / 255,
        g: clampByte(g) / 255,
        b: clampByte(b) / 255,
        alpha: 1
    });
}

function samePoint(a, b, tolerance) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return (dx * dx + dy * dy) <= (tolerance * tolerance);
}

function pointKey(p) {
    return `${Math.round(p.x * 100) / 100},${Math.round(p.y * 100) / 100}`;
}

function addUniquePoint(list, seen, p) {
    const key = pointKey(p);
    if (seen[key]) return;
    seen[key] = true;
    list.push({ x: p.x, y: p.y });
}

function getAnchor(list, seen, p) {
    const key = pointKey(p);
    if (!seen[key]) {
        seen[key] = {
            x: p.x,
            y: p.y,
            inHandles: [],
            outHandles: []
        };
        list.push(seen[key]);
    }
    return seen[key];
}

function collectBeziers(curve) {
    const beziers = [];
    try {
        for (const bez of curve.beziers) {
            beziers.push(bez);
        }
    } catch (e) {
        return [];
    }
    return beziers;
}

function findInsertionTarget(sourceNode) {
    const doc = Document.current;
    let node = sourceNode;
    while (node && node[Symbol.toStringTag] !== 'SpreadNode') {
        try {
            const abi = node.artboardInterface;
            if (abi && abi.isArtboardEnabled) return abi.node || node;
        } catch (e) {}
        node = node.parent;
    }
    return doc.currentSpread;
}

function readSpreadPolyCurve(sourceNode) {
    const doc = Document.current;
    let readNode = sourceNode;
    let tempNode = null;

    if (!readNode.curvesInterface) {
        const dupCmd = DocumentCommand.createTransform(
            sourceNode.selfSelection,
            null,
            { duplicateNodes: true }
        );
        doc.executeCommand(dupCmd);

        if (!dupCmd.newNodes || dupCmd.newNodes.length === 0) {
            throw new Error('Duplicate failed. Select a curve, shape, or text outline.');
        }

        tempNode = dupCmd.newNodes[0];
        try {
            doc.executeCommand(DocumentCommand.createSetVisibility(tempNode.selfSelection, false));
        } catch (e) {}

        if (!tempNode.curvesInterface) {
            doc.executeCommand(DocumentCommand.createConvertToCurves(Selection.create(doc, tempNode)));
            tempNode = doc.selection.firstNode;
        }

        if (!tempNode || !tempNode.curvesInterface) {
            throw new Error('Could not convert the selected object to curves.');
        }

        readNode = tempNode;
    }

    const poly = readNode.curvesInterface.polyCurve.clone();
    poly.transform(readNode.baseToSpreadTransform);

    if (tempNode) {
        try {
            doc.executeCommand(DocumentCommand.createDeleteSelection(tempNode.selfSelection, false));
        } catch (e) {}
    }

    return poly;
}

function isSmoothAnchor(anchor) {
    const tolerance = 0.2;
    for (const inHandle of anchor.inHandles) {
        const vx1 = inHandle.x - anchor.x;
        const vy1 = inHandle.y - anchor.y;
        const len1 = Math.sqrt(vx1 * vx1 + vy1 * vy1);
        if (len1 <= tolerance) continue;

        for (const outHandle of anchor.outHandles) {
            const vx2 = outHandle.x - anchor.x;
            const vy2 = outHandle.y - anchor.y;
            const len2 = Math.sqrt(vx2 * vx2 + vy2 * vy2);
            if (len2 <= tolerance) continue;

            const cosine = (vx1 * vx2 + vy1 * vy2) / (len1 * len2);
            if (cosine <= -0.85) return true;
        }
    }

    return false;
}

function collectOverlayGeometry(polyCurve, includeHandles, distinguishPointTypes) {
    const anchors = [];
    const roundAnchors = [];
    const squareAnchors = [];
    const handles = [];
    const handleLines = [];
    const anchorSeen = {};
    const handleSeen = {};
    const handleTolerance = 0.2;

    for (let i = 0; i < polyCurve.curveCount; i++) {
        const curve = polyCurve.at(i);
        const beziers = collectBeziers(curve);

        for (const bez of beziers) {
            const startAnchor = getAnchor(anchors, anchorSeen, bez.start);
            const endAnchor = getAnchor(anchors, anchorSeen, bez.end);

            if (!samePoint(bez.start, bez.c1, handleTolerance)) {
                startAnchor.outHandles.push({ x: bez.c1.x, y: bez.c1.y });
            }

            if (!samePoint(bez.end, bez.c2, handleTolerance)) {
                endAnchor.inHandles.push({ x: bez.c2.x, y: bez.c2.y });
            }

            if (!includeHandles) continue;

            if (!samePoint(bez.start, bez.c1, handleTolerance)) {
                handleLines.push({ a: bez.start, b: bez.c1 });
                addUniquePoint(handles, handleSeen, bez.c1);
            }

            if (!samePoint(bez.end, bez.c2, handleTolerance)) {
                handleLines.push({ a: bez.end, b: bez.c2 });
                addUniquePoint(handles, handleSeen, bez.c2);
            }
        }
    }

    for (const anchor of anchors) {
        if (distinguishPointTypes && isSmoothAnchor(anchor)) {
            roundAnchors.push(anchor);
        } else {
            squareAnchors.push(anchor);
        }
    }

    return { anchors, roundAnchors, squareAnchors, handles, handleLines };
}

function createLinePolyCurve(lines) {
    const poly = new PolyCurve();
    for (const line of lines) {
        poly.addCurve(Curve.createLine(line.a, line.b));
    }
    return poly;
}

function createCirclePolyCurve(points, size) {
    const poly = new PolyCurve();
    const r = size / 2;
    for (const p of points) {
        poly.addCurve(Curve.createEllipse(new Rectangle(p.x - r, p.y - r, size, size)));
    }
    return poly;
}

function createSquarePolyCurve(points, size) {
    const poly = new PolyCurve();
    const r = size / 2;
    for (const p of points) {
        poly.addCurve(Curve.createRectangle(new Rectangle(p.x - r, p.y - r, size, size)));
    }
    return poly;
}

function addPolyNode(builder, label, poly, brushFill, lineFill, lineStyle) {
    if (!poly || poly.curveCount === 0) return;
    const def = PolyCurveNodeDefinition.create(
        poly,
        brushFill,
        lineStyle,
        lineFill,
        FillDescriptor.createNone()
    );
    def.userDescription = label;
    builder.addPolyCurveNode(def);
}

function deletePreview() {
    const doc = Document.current;
    for (const node of previewNodes) {
        try {
            doc.executeCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, node), false));
        } catch (e) {}
    }
    previewNodes = [];
}

function createOverlay(sourceNode, settings, basePolyCurve, insertionTarget) {
    const doc = Document.current;
    const colour = parseHexColour(settings.colourHex);
    const redFill = FillDescriptor.createSolid(colour);
    const noFill = FillDescriptor.createNone();
    const stroke = LineStyleDescriptor.createDefault(settings.strokeWidth);
    const inactiveStroke = LineStyleDescriptor.createDefault(1);

    const poly = basePolyCurve || readSpreadPolyCurve(sourceNode);
    const geom = collectOverlayGeometry(
        poly,
        settings.includeHandles,
        settings.distinguishPointTypes
    );

    if (geom.anchors.length === 0) {
        throw new Error('No curve points were found on the selected object.');
    }

    const builder = AddChildNodesCommandBuilder.create();
    builder.setInsertionTarget(insertionTarget || findInsertionTarget(sourceNode));

    addPolyNode(
        builder,
        'Mockup handle lines',
        createLinePolyCurve(geom.handleLines),
        noFill,
        redFill,
        stroke
    );

    addPolyNode(
        builder,
        'Mockup handle dots',
        createCirclePolyCurve(geom.handles, settings.handleSize),
        redFill,
        noFill,
        inactiveStroke
    );

    addPolyNode(
        builder,
        'Mockup smooth points',
        createCirclePolyCurve(geom.roundAnchors, settings.anchorSize),
        noFill,
        redFill,
        stroke
    );

    addPolyNode(
        builder,
        'Mockup corner points',
        createSquarePolyCurve(geom.squareAnchors, settings.anchorSize),
        noFill,
        redFill,
        stroke
    );

    const cmd = builder.createCommand(true, NodeChildType.Main);
    doc.executeCommand(cmd);
    previewNodes = cmd.newNodes || [];
    return geom;
}

function run() {
    const doc = Document.current;
    const sel = doc.selection;

    if (!sel || sel.length === 0) {
        showMessage('Curve Mockup Overlay', 'No object selected. Please select one curve or shape first.');
        return;
    }

    const sourceNode = sel.firstNode;
    let basePoly;
    let insertionTarget;
    try {
        basePoly = readSpreadPolyCurve(sourceNode);
        insertionTarget = findInsertionTarget(sourceNode);
    } catch (e) {
        showMessage('Curve Mockup Overlay - Error', e.message || String(e));
        return;
    }

    const dlg = Dialog.create('Curve Mockup Overlay');
    dlg.initialWidth = 360;
    const col = dlg.addColumn();

    const style = col.addGroup('Style');
    const colourCtrl = style.addTextBox('Color HEX', DEFAULTS.colourHex);
    const anchorCtrl = style.addUnitValueEditor('Point size', UnitType.Pixel, UnitType.Pixel, DEFAULTS.anchorSize, 1, 64);
    anchorCtrl.showPopupSlider = true;
    const handleCtrl = style.addUnitValueEditor('Handle dot size', UnitType.Pixel, UnitType.Pixel, DEFAULTS.handleSize, 1, 64);
    handleCtrl.showPopupSlider = true;
    const strokeCtrl = style.addUnitValueEditor('Line width', UnitType.Pixel, UnitType.Pixel, DEFAULTS.strokeWidth, 0.1, 20);
    strokeCtrl.showPopupSlider = true;

    const opts = col.addGroup('Options');
    const typeCtrl = opts.addSwitch('Differentiate smooth and corner points', DEFAULTS.distinguishPointTypes);
    const handlesCtrl = opts.addSwitch('Draw handles', DEFAULTS.includeHandles);
    const statusTxt = opts.addStaticText('', '');
    statusTxt.isFullWidth = true;

    function readSettings() {
        return {
            colourHex: colourCtrl.text,
            anchorSize: Math.max(1, anchorCtrl.value),
            handleSize: Math.max(1, handleCtrl.value),
            strokeWidth: Math.max(0.1, strokeCtrl.value),
            distinguishPointTypes: typeCtrl.value,
            includeHandles: handlesCtrl.value
        };
    }

    function updatePreview() {
        deletePreview();
        try {
            const geom = createOverlay(sourceNode, readSettings(), basePoly, insertionTarget);
            statusTxt.text = `Preview: ${geom.anchors.length} points, ${geom.handles.length} handles`;
            return true;
        } catch (e) {
            statusTxt.text = `Could not draw preview: ${e.message || e}`;
            return false;
        }
    }

    updatePreview();
    dlg.onControlValueChangedHandler = updatePreview;

    const result = dlg.show();
    if (result.value !== DialogResult.Ok.value) {
        deletePreview();
        return;
    }

    if (previewNodes.length === 0 && !updatePreview()) {
        showMessage('Curve Mockup Overlay - Error', statusTxt.text);
    }

    previewNodes = [];
}

run();
