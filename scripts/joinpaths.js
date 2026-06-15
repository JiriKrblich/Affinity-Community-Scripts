Your javascript code
'use strict';

// Join paths: grows chains from each open path in order. Starting from the first
// path, finds the nearest extremity on another path within radius, joins, then
// continues from the merged path's two free ends only. Joined endpoints are never
// reused. Never connects two extremities on the same path.

const { app } = require('/application');
const { Dialog, DialogResult } = require('/dialog');
const { Document } = require('/document');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
const { CurveBuilder, PolyCurve } = require('/geometry');
const { Selection } = require('/selections');
const { UnitType } = require('affinity:common');

const APP_NAME = 'Join paths';
const EPS = 0.05;

const DEFAULTS = {
    radius: 10,
};

function formatStatsLine(stats) {
    return 'Open paths: ' + stats.openCount
        + '  ·  Joins: ' + stats.joinCount
        + '  ·  Remaining: ' + stats.remainingOpen;
}

function getResultValue(result) {
    return result && result.value != null ? result.value : result;
}

function parseNumber(value, fallback, min, max) {
    const parsed = Number(String(value == null ? '' : value).trim());
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    let result = parsed;
    if (min != null) {
        result = Math.max(min, result);
    }
    if (max != null) {
        result = Math.min(max, result);
    }
    return result;
}

function executeDocumentCommand(doc, command, preview) {
    doc.executeCommand(command, preview === true);
}

function copyPoint(point) {
    return { x: point.x, y: point.y };
}

function distanceBetween(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
}

function pointsAreClose(a, b, epsilon) {
    return distanceBetween(a, b) <= (epsilon == null ? EPS : epsilon);
}

function getTransformMatrix(transform) {
    if (!transform) {
        return null;
    }
    const text = String(transform);
    const match = text.match(/\[\[([^,\]]+),([^,\]]+),([^\]]+)\]\s*\[([^,\]]+),([^,\]]+),([^\]]+)\]\]/);
    if (!match) {
        return null;
    }
    const matrix = {
        a: Number(match[1]),
        b: Number(match[2]),
        c: Number(match[3]),
        d: Number(match[4]),
        e: Number(match[5]),
        f: Number(match[6]),
    };
    if (![matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].every(Number.isFinite)) {
        return null;
    }
    return matrix;
}

function invertAffineMatrix(matrix) {
    const det = matrix.a * matrix.e - matrix.b * matrix.d;
    if (Math.abs(det) < 0.0000001) {
        return null;
    }
    const a = matrix.a;
    const b = matrix.b;
    const c = matrix.c;
    const d = matrix.d;
    const e = matrix.e;
    const f = matrix.f;
    return {
        a: e / det,
        b: -b / det,
        c: (b * f - e * c) / det,
        d: -d / det,
        e: a / det,
        f: (d * c - a * f) / det,
    };
}

function transformPoint(point, matrix) {
    return {
        x: matrix.a * point.x + matrix.b * point.y + matrix.c,
        y: matrix.d * point.x + matrix.e * point.y + matrix.f,
    };
}

function listBeziers(curve) {
    const beziers = [];
    for (const bezier of curve.beziers) {
        beziers.push(bezier);
    }
    return beziers;
}

function getEndpoints(curve) {
    const beziers = listBeziers(curve);
    if (beziers.length === 0) {
        return null;
    }
    return {
        start: copyPoint(beziers[0].start),
        end: copyPoint(beziers[beziers.length - 1].end),
    };
}

function transformCurve(curve, matrix) {
    if (!matrix) {
        return curve.clone();
    }
    const beziers = listBeziers(curve);
    if (beziers.length === 0) {
        return curve.clone();
    }
    const builder = CurveBuilder.create();
    const first = beziers[0].start;
    const tFirst = transformPoint(first, matrix);
    builder.beginXY(tFirst.x, tFirst.y);
    for (const bez of beziers) {
        const c1 = transformPoint(bez.c1, matrix);
        const c2 = transformPoint(bez.c2, matrix);
        const end = transformPoint(bez.end, matrix);
        builder.addBezierXY(c1.x, c1.y, c2.x, c2.y, end.x, end.y);
    }
    return builder.createCurve();
}

function reverseCurve(curve) {
    const beziers = listBeziers(curve);
    if (beziers.length === 0) {
        return curve.clone();
    }
    const builder = CurveBuilder.create();
    const last = beziers[beziers.length - 1].end;
    builder.beginXY(last.x, last.y);
    for (let i = beziers.length - 1; i >= 0; i--) {
        const bez = beziers[i];
        builder.addBezierXY(bez.c2.x, bez.c2.y, bez.c1.x, bez.c1.y, bez.start.x, bez.start.y);
    }
    return builder.createCurve();
}

function appendCurveBeziers(builder, curve, beginPath) {
    const beziers = listBeziers(curve);
    if (beziers.length === 0) {
        return null;
    }
    if (beginPath) {
        builder.beginXY(beziers[0].start.x, beziers[0].start.y);
    }
    for (const bez of beziers) {
        builder.addBezierXY(bez.c1.x, bez.c1.y, bez.c2.x, bez.c2.y, bez.end.x, bez.end.y);
    }
    return getEndpoints(curve);
}

function mergeTwoPaths(pathA, endA, pathB, endB) {
    let curveA = pathA.curve.clone();
    let curveB = pathB.curve.clone();
    if (endA === 'start') {
        curveA = reverseCurve(curveA);
    }
    if (endB === 'end') {
        curveB = reverseCurve(curveB);
    }

    const endPtA = getEndpoints(curveA).end;
    const startPtB = getEndpoints(curveB).start;

    const builder = CurveBuilder.create();
    appendCurveBeziers(builder, curveA, true);
    if (!pointsAreClose(endPtA, startPtB)) {
        builder.lineToXY(startPtB.x, startPtB.y);
    }
    appendCurveBeziers(builder, curveB, false);

    const merged = builder.createCurve();
    const endpoints = getEndpoints(merged);
    return {
        id: pathA.id,
        node: pathA.node,
        curve: merged,
        start: endpoints.start,
        end: endpoints.end,
        active: true,
    };
}

function hasCurveGeometry(node) {
    if (!node || !node.curvesInterface) {
        return false;
    }
    try {
        if (node.curvesInterface.polyPolyCurves && node.curvesInterface.polyPolyCurves.hasCurves) {
            return true;
        }
    } catch (_) {}
    try {
        return node.curvesInterface.polyCurve && node.curvesInterface.polyCurve.curveCount > 0;
    } catch (_) {
        return false;
    }
}

function isVectorLikeNode(node) {
    if (!node) {
        return false;
    }
    if (node.isContainerNode) {
        return false;
    }
    return hasCurveGeometry(node) || node.isVectorNode || node.isShapeNode || node.isPolyCurveNode;
}

function getSelectedVectorNodes(doc) {
    const nodes = doc.selection.nodes.toArray
        ? doc.selection.nodes.toArray()
        : Array.from(doc.selection.nodes);
    return nodes.filter(isVectorLikeNode);
}

function getLocalCurves(node) {
    const ci = node.curvesInterface;
    const curves = [];
    try {
        const pc = ci.polyCurve;
        for (let i = 0; i < pc.curveCount; i++) {
            curves.push(pc.at(i).clone());
        }
        if (curves.length > 0) {
            return curves;
        }
    } catch (_) {}
    try {
        const ppc = ci.polyPolyCurves;
        for (let i = 0; i < ppc.polyCurveCount; i++) {
            const sub = ppc.getPolyCurve(i);
            for (let j = 0; j < sub.curveCount; j++) {
                curves.push(sub.at(j).clone());
            }
        }
    } catch (_) {}
    return curves;
}

function ensureCurves(doc, nodes) {
    const converted = [];
    for (const node of nodes) {
        if (hasCurveGeometry(node)) {
            converted.push(node);
            continue;
        }
        try {
            const selection = Selection.create(doc, node, true);
            const command = DocumentCommand.createConvertToCurves(selection);
            executeDocumentCommand(doc, command, false);
            const next = command.newNodes && command.newNodes.length > 0
                ? command.newNodes[0]
                : doc.selection.firstNode;
            if (next && hasCurveGeometry(next)) {
                converted.push(next);
            }
        } catch (_) {}
    }
    return converted;
}

function analyzeNodes(nodes) {
    const closedByNode = new Map();
    const openPaths = [];
    let nextId = 0;

    for (const node of nodes) {
        const ci = node.curvesInterface;
        const matrix = getTransformMatrix(ci.domainTransform);
        const localCurves = getLocalCurves(node);
        const closed = [];

        for (const localCurve of localCurves) {
            if (localCurve.isEmpty) {
                continue;
            }
            if (localCurve.isClosed) {
                closed.push(localCurve.clone());
                continue;
            }
            const spreadCurve = matrix ? transformCurve(localCurve, matrix) : localCurve.clone();
            const endpoints = getEndpoints(spreadCurve);
            if (!endpoints) {
                continue;
            }
            openPaths.push({
                id: nextId,
                node,
                matrix,
                curve: spreadCurve,
                start: endpoints.start,
                end: endpoints.end,
                active: true,
            });
            nextId += 1;
        }

        closedByNode.set(node, closed);
    }

    return { openPaths, closedByNode };
}

function findBestJoinForPath(seed, openPaths, radius) {
    let best = null;

    for (const other of openPaths) {
        if (!other.active || other.id === seed.id) {
            continue;
        }
        for (const seedKind of ['start', 'end']) {
            const seedPoint = seed[seedKind];
            for (const otherKind of ['start', 'end']) {
                const distance = distanceBetween(seedPoint, other[otherKind]);
                if (distance <= radius && (!best || distance < best.distance)) {
                    best = {
                        seedKind,
                        other,
                        otherKind,
                        distance,
                    };
                }
            }
        }
    }

    return best;
}

function joinOpenPaths(openPaths, radius) {
    let joinCount = 0;
    const seeds = openPaths.slice().sort((left, right) => left.id - right.id);

    for (const seed of seeds) {
        if (!seed.active) {
            continue;
        }

        while (true) {
            const match = findBestJoinForPath(seed, openPaths, radius);
            if (!match || !match.other.active) {
                break;
            }

            const merged = mergeTwoPaths(seed, match.seedKind, match.other, match.otherKind);
            seed.curve = merged.curve;
            seed.start = merged.start;
            seed.end = merged.end;
            seed.active = true;
            match.other.active = false;
            joinCount += 1;
        }
    }

    return joinCount;
}

function toLocalCurve(node, spreadCurve) {
    const matrix = getTransformMatrix(node.curvesInterface.domainTransform);
    const inverse = matrix ? invertAffineMatrix(matrix) : null;
    return inverse ? transformCurve(spreadCurve, inverse) : spreadCurve.clone();
}

function applyJoinResults(doc, nodes, closedByNode, openPaths) {
    const activeOpen = openPaths.filter(path => path.active);
    const openByNode = new Map();
    for (const node of nodes) {
        openByNode.set(node, []);
    }
    for (const path of activeOpen) {
        if (!openByNode.has(path.node)) {
            openByNode.set(path.node, []);
        }
        openByNode.get(path.node).push(path);
    }

    const compound = CompoundCommandBuilder.create();
    let commandCount = 0;
    const nodesToDelete = [];

    for (const node of nodes) {
        const closed = closedByNode.get(node) || [];
        const open = openByNode.get(node) || [];
        const localCurves = [];

        for (const curve of closed) {
            localCurves.push(curve.clone());
        }
        for (const path of open) {
            localCurves.push(toLocalCurve(node, path.curve));
        }

        if (localCurves.length === 0) {
            nodesToDelete.push(node);
            continue;
        }

        const polyCurve = new PolyCurve();
        for (const curve of localCurves) {
            polyCurve.addCurve(curve);
        }
        compound.addCommand(DocumentCommand.createSetCurves(node.curvesInterface, polyCurve));
        commandCount += 1;
    }

    for (const node of nodesToDelete) {
        compound.addCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, node, true), false));
        commandCount += 1;
    }

    if (commandCount === 0) {
        return nodes.filter(node => !nodesToDelete.includes(node));
    }

    executeDocumentCommand(doc, compound.createCommand(), false);
    return nodes.filter(node => !nodesToDelete.includes(node));
}

function captureJoinSnapshot(doc, nodes) {
    const dupes = duplicateNodes(doc, nodes);
    if (dupes.length === 0) {
        return { paths: [], openCount: 0, error: 'Could not read the selection geometry.' };
    }

    const working = ensureCurves(doc, dupes);
    const { openPaths } = analyzeNodes(working);
    deleteNodes(doc, dupes);

    if (openPaths.length === 0) {
        return { paths: [], openCount: 0, error: 'No open paths found in the selection.' };
    }

    return {
        paths: openPaths.map((path, index) => ({
            id: index,
            curve: path.curve.clone(),
            start: copyPoint(path.start),
            end: copyPoint(path.end),
        })),
        openCount: openPaths.length,
        error: null,
    };
}

function simulateJoinStats(snapshot, radius) {
    if (snapshot.error) {
        return {
            openCount: snapshot.openCount,
            joinCount: 0,
            remainingOpen: snapshot.openCount,
            error: snapshot.error,
        };
    }

    const paths = snapshot.paths.map((entry) => ({
        id: entry.id,
        curve: entry.curve.clone(),
        start: copyPoint(entry.start),
        end: copyPoint(entry.end),
        active: true,
        node: null,
    }));

    const joinCount = joinOpenPaths(paths, radius);
    return {
        openCount: snapshot.openCount,
        joinCount,
        remainingOpen: paths.filter(path => path.active).length,
        error: null,
    };
}

function runJoin(doc, nodes, radius) {
    const working = ensureCurves(doc, nodes.slice());
    const { openPaths, closedByNode } = analyzeNodes(working);

    if (openPaths.length === 0) {
        return {
            nodes: working,
            openCount: 0,
            joinCount: 0,
            remainingOpen: 0,
            error: 'No open paths found in the selection.',
        };
    }

    const initialOpen = openPaths.length;
    const joinCount = joinOpenPaths(openPaths, radius);
    const remainingOpen = openPaths.filter(path => path.active).length;
    const resultNodes = applyJoinResults(doc, working, closedByNode, openPaths);

    return {
        nodes: resultNodes,
        openCount: initialOpen,
        joinCount,
        remainingOpen,
        error: null,
    };
}

function duplicateNodes(doc, nodes) {
    if (nodes.length === 0) {
        return [];
    }
    const selection = Selection.create(doc, nodes, true);
    const command = DocumentCommand.createTransform(selection, null, { duplicateNodes: true });
    executeDocumentCommand(doc, command, false);
    return command.newNodes && command.newNodes.length > 0 ? command.newNodes.slice() : [];
}

function setNodesVisible(doc, nodes, visible) {
    for (const node of nodes) {
        try {
            executeDocumentCommand(
                doc,
                DocumentCommand.createSetVisibility(Selection.create(doc, node, true), visible),
                false
            );
        } catch (_) {}
    }
}

function deleteNodes(doc, nodes) {
    for (const node of nodes) {
        try {
            executeDocumentCommand(
                doc,
                DocumentCommand.createDeleteSelection(Selection.create(doc, node, true), false),
                false
            );
        } catch (_) {}
    }
}

function buildDialog(values, stats) {
    const dialog = Dialog.create(APP_NAME);
    dialog.initialWidth = 320;
    dialog.isResizable = true;

    const column = dialog.addColumn();
    const statsGroup = column.addGroup('Statistics');
    const statsText = statsGroup.addStaticText('', formatStatsLine(stats));
    statsText.isFullWidth = true;

    const group = column.addGroup('');
    const radiusCtrl = group.addUnitValueEditor(
        'Radius',
        UnitType.Pixel,
        UnitType.Pixel,
        values.radius,
        0,
        5000
    );
    radiusCtrl.showPopupSlider = true;
    radiusCtrl.precision = 1;
    radiusCtrl.isFullWidth = true;

    return { dialog, radiusCtrl, statsText };
}

function readValues(controls, previous) {
    return {
        radius: parseNumber(controls.radiusCtrl.value, previous.radius, 0, 5000),
    };
}

function main() {
    const doc = Document.current;
    if (!doc) {
        app.alert('Open a document before running Join paths.', APP_NAME);
        return;
    }

    const originalNodes = getSelectedVectorNodes(doc);
    if (originalNodes.length === 0) {
        app.alert('Select at least one vector shape.', APP_NAME);
        return;
    }

    const snapshot = captureJoinSnapshot(doc, originalNodes);
    if (snapshot.error) {
        app.alert(snapshot.error, APP_NAME);
        return;
    }

    let values = Object.assign({}, DEFAULTS);
    let previewNodes = [];
    let originalsHidden = false;

    function discardPreview() {
        if (previewNodes.length > 0) {
            deleteNodes(doc, previewNodes);
            previewNodes = [];
        }
        if (originalsHidden) {
            setNodesVisible(doc, originalNodes, true);
            originalsHidden = false;
        }
    }

    function rebuildPreview() {
        discardPreview();

        setNodesVisible(doc, originalNodes, false);
        originalsHidden = true;
        previewNodes = duplicateNodes(doc, originalNodes);
        if (previewNodes.length === 0) {
            setNodesVisible(doc, originalNodes, true);
            originalsHidden = false;
            return { error: 'Could not duplicate the selection for preview.' };
        }

        const result = runJoin(doc, previewNodes, values.radius);
        previewNodes = result.nodes;
        return result;
    }

    const initialPreview = rebuildPreview();
    if (initialPreview.error) {
        app.alert(initialPreview.error, APP_NAME);
        discardPreview();
        return;
    }

    const initialStats = simulateJoinStats(snapshot, values.radius);
    const controls = buildDialog(values, initialStats);

    controls.radiusCtrl.onValueChangedHandler = () => {
        values.radius = parseNumber(controls.radiusCtrl.value, values.radius, 0, 5000);
        const stats = simulateJoinStats(snapshot, values.radius);
        controls.statsText.text = formatStatsLine(stats);
        rebuildPreview();
    };

    if (getResultValue(controls.dialog.show()) !== DialogResult.Ok.value) {
        discardPreview();
        doc.executeCommand(DocumentCommand.createClearPreviews());
        return;
    }

    values = readValues(controls, values);
    doc.executeCommand(DocumentCommand.createClearPreviews());

    discardPreview();
    const joinedNodes = duplicateNodes(doc, originalNodes);
    if (joinedNodes.length === 0) {
        app.alert('Could not duplicate the selection.', APP_NAME);
        return;
    }
    const finalResult = runJoin(doc, joinedNodes, values.radius);
    if (finalResult.error) {
        deleteNodes(doc, joinedNodes);
        app.alert(finalResult.error, APP_NAME);
        return;
    }
    deleteNodes(doc, originalNodes);
}

try {
    main();
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    app.alert('Join paths failed: ' + message, APP_NAME);
}
