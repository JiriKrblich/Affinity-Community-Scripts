'use strict';

const { Document } = require('/document');

function isSimpleStraightLine(node) {
    if (!node || !node.isVectorNode) return false;
    let poly;
    try { poly = node.polyCurve; } catch (e) { return false; }
    if (!poly || poly.curveCount !== 1) return false;
    const curve = poly.at(0);
    if (curve.isEmpty || curve.isClosed || !curve.isStraightLine) return false;
    return curve.beziers.length === 1; // exactly two anchor points
}

function getLineVector(node) {
    const xf = node.baseToSpreadTransform;
    const curve = node.polyCurve.at(0);
    const p0 = xf.applyToPoint(curve.getPoint(curve.firstOnCurvePointIndex));
    const p1 = xf.applyToPoint(curve.getPoint(curve.lastOnCurvePointIndex));
    return { x: p1.x - p0.x, y: p1.y - p0.y };
}

function angleBetweenDegrees(v1, v2) {
    const mag1 = Math.hypot(v1.x, v1.y);
    const mag2 = Math.hypot(v2.x, v2.y);
    if (mag1 === 0 || mag2 === 0) return null;
    const dot = v1.x * v2.x + v1.y * v2.y;
    const cosA = Math.max(-1, Math.min(1, Math.abs(dot) / (mag1 * mag2)));
    return Math.acos(cosA) * 180 / Math.PI;
}

function main() {
    const doc = Document.current;
    if (!doc) {
        alert("Open a document first.");
        return;
    }

    const lines = doc.selection.nodes.filter(isSimpleStraightLine).toArray();
    if (lines.length !== 2) {
        alert("Select exactly two straight lines, then run this again.");
        return;
    }

    const angle = angleBetweenDegrees(getLineVector(lines[0]), getLineVector(lines[1]));
    if (angle === null) {
        alert("One of the selected lines has zero length.");
        return;
    }

    alert(`Angle between the two lines: ${angle.toFixed(2)}°`);
}

main();
