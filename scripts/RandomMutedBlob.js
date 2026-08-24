'use strict';

const { Document } = require('/document');
const { CurveBuilder, PolyCurve } = require('/geometry');
const { PolyCurveNodeDefinition, NodeChildType } = require('/nodes');
const { AddChildNodesCommandBuilder } = require('/commands');
const { FillDescriptor } = require('/fills');
const { LineStyleDescriptor } = require('/linestyle');
const { RGBA8 } = require('/colours');
const { BlendMode } = require('affinity:common');

const BLOB_COUNT = 1;
const MIN_POINTS = 7;
const MAX_POINTS = 10;

function randomBetween(min, max) {
    return min + Math.random() * (max - min);
}

function hslToRgb(h, s, l) {
    const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };

    let r;
    let g;
    let b;
    if (s === 0) {
        r = g = b = l;
    } else {
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = hue2rgb(p, q, h + 1 / 3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1 / 3);
    }

    return RGBA8(
        Math.round(r * 255),
        Math.round(g * 255),
        Math.round(b * 255),
        255
    );
}

function randomMutedColour() {
    return hslToRgb(
        Math.random(),
        randomBetween(0.22, 0.46),
        randomBetween(0.48, 0.72)
    );
}

function makeBlob(cx, cy, radiusX, radiusY) {
    const count = Math.floor(randomBetween(MIN_POINTS, MAX_POINTS + 1));
    const points = [];
    const rotation = randomBetween(0, Math.PI * 2);

    for (let i = 0; i < count; i++) {
        const angle = rotation + (i / count) * Math.PI * 2;
        const radialVariation = randomBetween(0.72, 1.18);
        points.push({
            x: cx + Math.cos(angle) * radiusX * radialVariation,
            y: cy + Math.sin(angle) * radiusY * radialVariation
        });
    }

    const curveBuilder = CurveBuilder.create();
    curveBuilder.beginXY(points[0].x, points[0].y);

    for (let i = 0; i < count; i++) {
        const p0 = points[(i - 1 + count) % count];
        const p1 = points[i];
        const p2 = points[(i + 1) % count];
        const p3 = points[(i + 2) % count];
        const smoothness = randomBetween(0.14, 0.20);

        curveBuilder.addBezierXY(
            p1.x + (p2.x - p0.x) * smoothness,
            p1.y + (p2.y - p0.y) * smoothness,
            p2.x - (p3.x - p1.x) * smoothness,
            p2.y - (p3.y - p1.y) * smoothness,
            p2.x,
            p2.y
        );
    }

    curveBuilder.close();
    const polyCurve = PolyCurve.create();
    polyCurve.addCurve(curveBuilder.createCurve());
    return polyCurve;
}

const doc = Document.current;

if (!doc) {
    alert('Open a document before running Random Muted Blob.');
} else {
    const spread = doc.currentSpread;
    const extents = spread.getSpreadExtents({
        includeSpread: true,
        includeBleed: false,
        includeChildren: false
    });

    const x = extents && extents.width > 0 ? extents.x : 0;
    const y = extents && extents.height > 0 ? extents.y : 0;
    const width = extents && extents.width > 0 ? extents.width : 2000;
    const height = extents && extents.height > 0 ? extents.height : 1400;

    const columns = Math.ceil(Math.sqrt(BLOB_COUNT * width / height));
    const rows = Math.ceil(BLOB_COUNT / columns);
    const cellWidth = width / columns;
    const cellHeight = height / rows;

    const commandBuilder = AddChildNodesCommandBuilder.create();
    commandBuilder.setInsertionTarget(spread);

    const noFill = FillDescriptor.createNone();
    const lineStyle = LineStyleDescriptor.createDefault(1);

    for (let i = 0; i < BLOB_COUNT; i++) {
        const column = i % columns;
        const row = Math.floor(i / columns);
        const cx = x + (column + randomBetween(0.42, 0.58)) * cellWidth;
        const cy = y + (row + randomBetween(0.42, 0.58)) * cellHeight;
        const radiusX = cellWidth * randomBetween(0.25, 0.36);
        const radiusY = cellHeight * randomBetween(0.25, 0.36);

        const fill = FillDescriptor.createSolid(
            randomMutedColour(),
            BlendMode.Normal
        );

        const nodeDefinition = PolyCurveNodeDefinition.create(
            makeBlob(cx, cy, radiusX, radiusY),
            fill,
            lineStyle,
            noFill,
            noFill
        );

        nodeDefinition.userDescription = 'Muted Blob ' + (i + 1);
        commandBuilder.addNode(nodeDefinition);
    }

    const command = commandBuilder.createCommand(false, NodeChildType.Main);
    doc.executeCommand(command);
    console.log('Created one random muted vector blob.');
}
