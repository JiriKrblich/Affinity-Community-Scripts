'use strict';

const { Dialog, DialogResult } = require('/dialog');
const { Document } = require('/document');
const { AddChildNodesCommandBuilder } = require('/commands');
const { ContainerNodeDefinition, NodeChildType, PolyCurveNodeDefinition } = require('/nodes');
const { CurveBuilder, PolyCurve, Rectangle } = require('/geometry');
const { FillDescriptor } = require('/fills');
const { LineStyleDescriptor } = require('/linestyle');
const { RGBA8 } = require('/colours');
const { UnitType } = require('/units');

const MAX_GRID_LINES = 2000;

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function cleanNumber(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}

function getSpreadBox(doc, spread, fallbackWidth, fallbackHeight) {
    try {
        const box = spread.baseBox;
        if (box && box.width > 0 && box.height > 0) {
            return box;
        }
    } catch (err) {
        // Some document types may not expose a useful spread base box.
    }

    try {
        const box = spread.spreadBaseBox;
        if (box && box.width > 0 && box.height > 0) {
            return box;
        }
    } catch (err) {
        // Fall through to a document-sized default.
    }

    return new Rectangle(0, 0, fallbackWidth, fallbackHeight);
}

function rotatePoint(point, center, radians) {
    if (radians === 0) {
        return point;
    }

    const dx = point.x - center.x;
    const dy = point.y - center.y;
    const c = Math.cos(radians);
    const s = Math.sin(radians);

    return {
        x: center.x + dx * c - dy * s,
        y: center.y + dx * s + dy * c
    };
}

function createPolyCurve(points, closeCurve) {
    const builder = CurveBuilder.create();
    builder.begin(points[0]);
    for (let i = 1; i < points.length; i += 1) {
        builder.lineTo(points[i]);
    }

    if (closeCurve) {
        builder.close();
    }

    const polyCurve = PolyCurve.create();
    polyCurve.addCurve(builder.createCurve());
    return polyCurve;
}

function createFilledPolyCurveDefinition(polyCurve, fillColour, name) {
    const fill = FillDescriptor.createSolid(fillColour);
    const noFill = FillDescriptor.createNone();
    const noLine = LineStyleDescriptor.createDefault(0.1);
    const def = PolyCurveNodeDefinition.create(polyCurve, fill, noLine, noFill, noFill);
    def.userDescription = name;
    return def;
}

function createStrokedPolyCurveDefinition(polyCurve, strokeColour, lineWeight, name) {
    const noFill = FillDescriptor.createNone();
    const lineFill = FillDescriptor.createSolid(strokeColour);
    const lineStyle = LineStyleDescriptor.createDefault(lineWeight);
    const def = PolyCurveNodeDefinition.create(polyCurve, noFill, lineStyle, lineFill, noFill);
    def.userDescription = name;
    return def;
}

function createPositions(start, end, gap) {
    const positions = [];
    for (let value = start; value <= end + 0.0001; value += gap) {
        positions.push(value);
    }

    if (positions.length === 0 || Math.abs(positions[positions.length - 1] - end) > 0.0001) {
        positions.push(end);
    }

    return positions;
}

function buildDialog(doc, initialWidth, initialHeight) {
    const units = doc.units;
    const dlg = Dialog.create('Create Grid Background');
    const col = dlg.addColumn();

    const sizeGroup = col.addGroup('Background');
    dlg.widthCtrl = sizeGroup
        .addUnitValueEditor('Width', UnitType.Pixel, units, initialWidth, 1, initialWidth)
        .setNoMaxValue();
    dlg.heightCtrl = sizeGroup
        .addUnitValueEditor('Height', UnitType.Pixel, units, initialHeight, 1, initialHeight)
        .setNoMaxValue();
    dlg.backgroundColourCtrl = sizeGroup.addColourPicker('Background colour', RGBA8(248, 250, 252));

    const gridGroup = col.addGroup('Grid');
    dlg.gridColourCtrl = gridGroup.addColourPicker('Gridline colour', RGBA8(148, 163, 184));
    dlg.gapCtrl = gridGroup
        .addUnitValueEditor('Gap', UnitType.Pixel, units, 40, 1, 40)
        .setNoMaxValue();
    dlg.rotationCtrl = gridGroup
        .addUnitValueEditor('Rotation degrees', UnitType.Number, UnitType.Number, 0, -360, 360)
        .setPrecision(2);
    dlg.lineWeightCtrl = gridGroup
        .addUnitValueEditor('Line weight', UnitType.Pixel, units, 1, 0.1, 1)
        .setNoMaxValue();

    return dlg;
}

function makeGridDefinitions(options) {
    const {
        x,
        y,
        width,
        height,
        gap,
        rotationRadians,
        backgroundColour,
        gridColour,
        lineWeight
    } = options;

    const center = {
        x: x + width / 2,
        y: y + height / 2
    };

    const left = x;
    const right = x + width;
    const top = y;
    const bottom = y + height;

    const definitions = [];
    const backgroundPoints = [
        rotatePoint({ x: left, y: top }, center, rotationRadians),
        rotatePoint({ x: right, y: top }, center, rotationRadians),
        rotatePoint({ x: right, y: bottom }, center, rotationRadians),
        rotatePoint({ x: left, y: bottom }, center, rotationRadians)
    ];
    definitions.push(createFilledPolyCurveDefinition(
        createPolyCurve(backgroundPoints, true),
        backgroundColour,
        'Grid background fill'
    ));

    const verticals = createPositions(left, right, gap);
    const horizontals = createPositions(top, bottom, gap);

    if (verticals.length + horizontals.length > MAX_GRID_LINES) {
        throw new Error(`This grid would create ${verticals.length + horizontals.length} lines. Increase the gap or reduce the size.`);
    }

    for (const vx of verticals) {
        const p1 = rotatePoint({ x: vx, y: top }, center, rotationRadians);
        const p2 = rotatePoint({ x: vx, y: bottom }, center, rotationRadians);
        definitions.push(createStrokedPolyCurveDefinition(
            createPolyCurve([p1, p2], false),
            gridColour,
            lineWeight,
            'Vertical gridline'
        ));
    }

    for (const hy of horizontals) {
        const p1 = rotatePoint({ x: left, y: hy }, center, rotationRadians);
        const p2 = rotatePoint({ x: right, y: hy }, center, rotationRadians);
        definitions.push(createStrokedPolyCurveDefinition(
            createPolyCurve([p1, p2], false),
            gridColour,
            lineWeight,
            'Horizontal gridline'
        ));
    }

    return definitions;
}

function findContainer(spread, expectedName) {
    for (const child of spread.children) {
        if (child.userDescription === expectedName) {
            return child;
        }
    }

    return spread.children.first;
}

function addGridToDocument(doc, spread, options) {
    const containerName = `Grid Background ${Math.round(options.width)}x${Math.round(options.height)} gap ${Math.round(options.gap)}`;
    const containerDef = ContainerNodeDefinition.create(containerName);

    const containerBuilder = AddChildNodesCommandBuilder.create();
    containerBuilder.addNode(containerDef);
    containerBuilder.setInsertionTarget(spread);
    doc.executeCommand(containerBuilder.createCommand(false, NodeChildType.Main));

    const container = findContainer(spread, containerName);
    if (!container || !container.isContainerNode) {
        throw new Error('Could not create the grid container layer.');
    }

    const childBuilder = AddChildNodesCommandBuilder.create();
    for (const definition of makeGridDefinitions(options)) {
        childBuilder.addNode(definition);
    }

    childBuilder.setInsertionTarget(container);
    doc.executeCommand(childBuilder.createCommand(false, NodeChildType.Main));
    doc.selection = [container];
}

function main() {
    const doc = Document.current;
    if (!doc) {
        alert('Open a document before running this script.');
        return;
    }

    const spread = doc.currentSpread || doc.spreads.first;
    if (!spread) {
        alert('No spread was found in the current document.');
        return;
    }

    const spreadBox = getSpreadBox(doc, spread, doc.widthPixels || 1200, doc.heightPixels || 800);
    const initialWidth = Math.max(1, spreadBox.width || 1200);
    const initialHeight = Math.max(1, spreadBox.height || 800);
    const dlg = buildDialog(doc, initialWidth, initialHeight);

    if (dlg.runModal() !== DialogResult.Ok) {
        return;
    }

    const width = Math.max(1, cleanNumber(dlg.widthCtrl.value, initialWidth));
    const height = Math.max(1, cleanNumber(dlg.heightCtrl.value, initialHeight));
    const gap = Math.max(1, cleanNumber(dlg.gapCtrl.value, 40));
    const lineWeight = clamp(cleanNumber(dlg.lineWeightCtrl.value, 1), 0.1, 1000);
    const rotationDegrees = cleanNumber(dlg.rotationCtrl.value, 0);

    const options = {
        x: spreadBox.x + (spreadBox.width - width) / 2,
        y: spreadBox.y + (spreadBox.height - height) / 2,
        width,
        height,
        gap,
        rotationRadians: rotationDegrees * Math.PI / 180,
        backgroundColour: dlg.backgroundColourCtrl.value || RGBA8(248, 250, 252),
        gridColour: dlg.gridColourCtrl.value || RGBA8(148, 163, 184),
        lineWeight
    };

    try {
        addGridToDocument(doc, spread, options);
    } catch (err) {
        alert(err.message || String(err));
    }
}

main();
