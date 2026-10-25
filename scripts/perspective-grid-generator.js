'use strict';

const { Dialog, DialogResult } = require('/dialog.js');
const { Document } = require('/document.js');
const { AddChildNodesCommandBuilder } = require('/commands.js');
const {
    ContainerNodeDefinition,
    NodeChildType,
    PolyCurveNodeDefinition
} = require('/nodes.js');
const { CurveBuilder, PolyCurve, Rectangle } = require('/geometry.js');
const { FillDescriptor } = require('/fills.js');
const { LineStyleDescriptor } = require('/linestyle.js');
const { RGBA8 } = require('/colours.js');
const { UnitType } = require('/units.js');

const MAX_GRID_LINES = 2000;
const CIRCLE_SEGMENTS = 180;

const PRESETS = [
    null,
    { scale: 2, lines: 48, spacing: 8, distance: 30 },
    { scale: 2.5, lines: 96, spacing: 4, distance: 20 },
    { scale: 3, lines: 32, spacing: 12, distance: 60 },
    { scale: 2, lines: 40, spacing: 6, distance: 35 },
    { scale: 4, lines: 72, spacing: 5, distance: 15 }
];

function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}

function numberOr(v, fallback) {
    return Number.isFinite(v) ? v : fallback;
}

function getSpreadBox(doc, spread, fw, fh) {
    try {
        const b = spread.baseBox;
        if (b && b.width > 0 && b.height > 0) return b;
    } catch (err) {}

    try {
        const b = spread.spreadBaseBox;
        if (b && b.width > 0 && b.height > 0) return b;
    } catch (err) {}

    return new Rectangle(0, 0, fw, fh);
}

function createCurve(points, closed) {
    const builder = CurveBuilder.create();
    builder.begin(points[0]);

    for (let i = 1; i < points.length; i++) {
        builder.lineTo(points[i]);
    }

    if (closed) builder.close();

    const curve = PolyCurve.create();
    curve.addCurve(builder.createCurve());
    return curve;
}

function filledDefinition(curve, colour, name) {
    const def = PolyCurveNodeDefinition.create(
        curve,
        FillDescriptor.createSolid(colour),
        FillDescriptor.createNone(),
        LineStyleDescriptor.createDefault(0.1),
        FillDescriptor.createNone()
    );
    def.userDescription = name;
    return def;
}

function lineDefinition(curve, colour, weight, name) {
    const def = PolyCurveNodeDefinition.create(
        curve,
        FillDescriptor.createNone(),
        FillDescriptor.createSolid(colour),
        LineStyleDescriptor.createDefault(weight),
        FillDescriptor.createNone()
    );
    def.userDescription = name;
    return def;
}

function circlePoints(cx, cy, r) {
    const pts = [];

    for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
        const a = 2 * Math.PI * i / CIRCLE_SEGMENTS;
        pts.push({
            x: cx + Math.cos(a) * r,
            y: cy + Math.sin(a) * r
        });
    }

    return pts;
}

function addLine(defs, a, b, colour, weight, name) {
    defs.push(lineDefinition(
        createCurve([a, b], false),
        colour, weight, name
    ));
}

// Intersections of an infinite line with a circle.
// dx/dy must describe a unit direction vector.
function lineCircleHits(vx, vy, dx, dy, cx, cy, r) {
    const ox = vx - cx;
    const oy = vy - cy;

    const b = 2 * (ox * dx + oy * dy);
    const c = ox * ox + oy * oy - r * r;
    const disc = b * b - 4 * c;

    if (disc < 0) return [];

    const root = Math.sqrt(disc);

    const t1 = (-b - root) / 2;
    const t2 = (-b + root) / 2;

    return [t1, t2]
        .sort((a, b) => a - b)
        .map(t => ({
            x: vx + t * dx,
            y: vy + t * dy
        }));
}

function buildDialog(doc, initialSize) {
    const units = doc.units;
    const dlg = Dialog.create('Perspective Grid Generator');
    const col = dlg.addColumn();

    const size = col.addGroup('Grid size');

    dlg.diameterCtrl = size
        .addUnitValueEditor(
            'Base diameter', UnitType.Pixel, units,
            initialSize, 1, initialSize
        )
        .setNoMaxValue();

    dlg.scaleCtrl = size.addUnitValueEditor(
        'Oversize multiplier', UnitType.Number,
        UnitType.Number, 2, 1, 10
    ).setPrecision(2);

    const preset = col.addGroup('Preset');

    dlg.presetCtrl = preset.addUnitValueEditor(
        'Preset (0 Custom, 1-5 Presets)',
        UnitType.Number, UnitType.Number, 0, 0, 5
    );

    const perspective = col.addGroup('Perspective');

    dlg.modeCtrl = perspective.addUnitValueEditor(
        'Mode (1 Circular, 2 Two-point)',
        UnitType.Number, UnitType.Number, 1, 1, 2
    );

    dlg.vanishingXCtrl = perspective
        .addUnitValueEditor(
            'Vanishing pair midpoint X (%)',
            UnitType.Number, UnitType.Number, 50, 0, 100
        )
        .setPrecision(1);

    dlg.vanishingYCtrl = perspective
        .addUnitValueEditor(
            'Vanishing point Y (%)',
            UnitType.Number, UnitType.Number, 50, 0, 100
        )
        .setPrecision(1);

    dlg.distanceCtrl = perspective
        .addUnitValueEditor(
            'Point separation (% of diameter)',
            UnitType.Number, UnitType.Number, 30, 1, 100
        )
        .setPrecision(1);

    const density = col.addGroup('Grid density');

    dlg.linesCtrl = density.addUnitValueEditor(
        'Lines per vanishing point',
        UnitType.Number, UnitType.Number, 48, 3, 360
    );

    dlg.spacingCtrl = density
        .addUnitValueEditor(
            'Angular spread (%)',
            UnitType.Number, UnitType.Number, 8, 1, 100
        )
        .setPrecision(1);

    const style = col.addGroup('Appearance');

    dlg.bgColourCtrl = style.addColourPicker(
        'Background colour', RGBA8(248, 250, 252)
    );

    dlg.gridColourCtrl = style.addColourPicker(
        'Gridline colour', RGBA8(148, 163, 184)
    );

    dlg.weightCtrl = style
        .addUnitValueEditor(
            'Line weight', UnitType.Pixel, units, 1, 0.1, 1
        )
        .setNoMaxValue();

    return dlg;
}

function makeDefinitions(o) {
    const {
        x, y, diameter, mode, midpointXPercent,
        vanishingYPercent, distancePercent, lineCount,
        spreadPercent, backgroundColour, gridColour, lineWeight
    } = o;

    const r = diameter / 2;
    const cx = x + r;
    const cy = y + r;

    const vx = x + diameter * midpointXPercent / 100;
    const vy = y + diameter * vanishingYPercent / 100;

    const defs = [];

    // Circular background.
    defs.push(filledDefinition(
        createCurve(circlePoints(cx, cy, r), true),
        backgroundColour,
        'Perspective grid background'
    ));

    if (mode === 1) {
        // Single-point radial grid.
        // One ray per angle, from the vanishing point to the circle.
        for (let i = 0; i < lineCount; i++) {
            const a = 2 * Math.PI * i / lineCount;
            const dx = Math.cos(a);
            const dy = Math.sin(a);

            const hits = lineCircleHits(
                vx, vy, dx, dy, cx, cy, r
            );

            // Select the intersection in the ray's forward direction.
            const endpoint = hits.find(p =>
                (p.x - vx) * dx + (p.y - vy) * dy > 0.0001
            );

            if (endpoint) {
                addLine(
                    defs, { x: vx, y: vy }, endpoint,
                    gridColour, lineWeight, 'Radial gridline'
                );
            }
        }
    } else {
        // Two vanishing points, independently inside the circle.
        const separation = diameter * distancePercent / 100;

        const leftVP = {
            x: vx - separation / 2,
            y: vy
        };

        const rightVP = {
            x: vx + separation / 2,
            y: vy
        };

        // Keep both points within the circular bounds.
        const minX = x + 0.001;
        const maxX = x + diameter - 0.001;

        leftVP.x = clamp(leftVP.x, minX, maxX);
        rightVP.x = clamp(rightVP.x, minX, maxX);

        // A smaller angular spread creates a tighter fan.
        // Draw only perspective lines; no vertical construction lines.
        const maxAngle = Math.PI * 0.49 * spreadPercent / 100;

        for (const vp of [leftVP, rightVP]) {
            for (let i = 0; i <= lineCount; i++) {
                const angle = -maxAngle +
                    2 * maxAngle * i / lineCount;

                const dx = Math.cos(angle);
                const dy = Math.sin(angle);

                const hits = lineCircleHits(
                    vp.x, vp.y, dx, dy, cx, cy, r
                );

                if (hits.length >= 2) {
                    addLine(
                        defs, hits[0], hits[hits.length - 1],
                        gridColour, lineWeight,
                        'Two-point perspective line'
                    );
                }
            }
        }
    }

    // Circular boundary.
    defs.push(lineDefinition(
        createCurve(circlePoints(cx, cy, r), true),
        gridColour, lineWeight, 'Circular grid outline'
    ));

    if (defs.length > MAX_GRID_LINES) {
        throw new Error(
            'Too many grid lines. Reduce line count or spread.'
        );
    }

    return defs;
}

function addGridToDocument(doc, spread, options) {
    const name = options.mode === 1
        ? 'Perspective Grid Circular'
        : 'Perspective Grid Two-Point';

    const builder = AddChildNodesCommandBuilder.create();
    builder.addNode(ContainerNodeDefinition.create(name));
    builder.setInsertionTarget(spread);

    doc.executeCommand(
        builder.createCommand(false, NodeChildType.Main)
    );

    let container = null;

    for (const child of spread.children) {
        if (child.userDescription === name) container = child;
    }

    if (!container || !container.isContainerNode) {
        throw new Error('Could not create the perspective grid layer.');
    }

    const children = AddChildNodesCommandBuilder.create();

    for (const def of makeDefinitions(options)) {
        children.addNode(def);
    }

    children.setInsertionTarget(container);

    doc.executeCommand(
        children.createCommand(false, NodeChildType.Main)
    );

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
        alert('No spread was found.');
        return;
    }

    const box = getSpreadBox(
        doc, spread, doc.widthPixels || 1200, doc.heightPixels || 800
    );

    const initialSize = Math.max(
        1, Math.min(box.width || 1200, box.height || 800)
    );

    const dlg = buildDialog(doc, initialSize);

    if (dlg.runModal() !== DialogResult.Ok) return;

    const presetIndex = Math.round(clamp(
        numberOr(dlg.presetCtrl.value, 0), 0, 5
    ));

    const preset = PRESETS[presetIndex];

    // Custom mode uses the values entered in the dialog.
    // Preset modes use the corresponding preset settings.
    const baseDiameter = Math.max(
        1, numberOr(dlg.diameterCtrl.value, initialSize)
    );

    const scale = clamp(
        preset ? preset.scale : numberOr(dlg.scaleCtrl.value, 2),
        1, 10
    );

    const diameter = baseDiameter * scale;

    const mode = Math.round(clamp(
        numberOr(dlg.modeCtrl.value, 1), 1, 2
    ));

    const options = {
        x: box.x + (box.width - diameter) / 2,
        y: box.y + (box.height - diameter) / 2,
        diameter,
        mode,

        midpointXPercent: clamp(
            numberOr(dlg.vanishingXCtrl.value, 50), 0, 100
        ),

        vanishingYPercent: clamp(
            numberOr(dlg.vanishingYCtrl.value, 50), 0, 100
        ),

        distancePercent: clamp(
            preset ? preset.distance :
                numberOr(dlg.distanceCtrl.value, 30),
            1, 100
        ),

        lineCount: Math.round(clamp(
            preset ? preset.lines :
                numberOr(dlg.linesCtrl.value, 48),
            3, 360
        )),

        spreadPercent: clamp(
            preset ? preset.spacing :
                numberOr(dlg.spacingCtrl.value, 8),
            1, 100
        ),

        backgroundColour:
            dlg.bgColourCtrl.value || RGBA8(248, 250, 252),

        gridColour:
            dlg.gridColourCtrl.value || RGBA8(148, 163, 184),

        lineWeight: clamp(
            numberOr(dlg.weightCtrl.value, 1), 0.1, 1000
        )
    };

    try {
        addGridToDocument(doc, spread, options);
        console.log('Created perspective grid.');
    } catch (err) {
        alert(err.message || String(err));
    }
}

main();
