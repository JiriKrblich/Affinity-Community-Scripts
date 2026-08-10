/**
 * name: Blob Generator
 * description: Generates an organic blob shape, centered on your selection.
 * version: 1.0.0
 * author: hellsfaun
 */

const { Document } = require('/document');
const { CurveBuilder, PolyCurve } = require('/geometry');
const { PolyCurveNodeDefinition } = require('/nodes');
const { FillDescriptor } = require('/fills');
const { LineStyleDescriptor } = require('/linestyle');
const { SVG11 } = require('/colours');
const { Dialog, DialogResult } = require('/dialog');
const { UnitType } = require('/units');
const { AddChildNodesCommandBuilder, DocumentCommand, NodeChildType } = require('/commands');

const MAX_COMPLEXITY = 30;
const MAX_SEED = 999999;

// Deterministic PRNG so a given seed always reproduces the same blob.
function mulberry32(seed) {
    let s = seed | 0;
    return function () {
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function generateHarmonicPool(maxCount, seed) {
    const rng = mulberry32(seed);
    const harmonics = [];
    for (let h = 2; h < 2 + maxCount; h++) {
        harmonics.push({ freq: h, amp: 1 / h, phase: rng() * Math.PI * 2 });
    }
    return harmonics;
}

function generateBlobPoints(cx, cy, baseRadius, complexity, contrast, harmonicPool) {
    const numHarmonics = Math.max(1, Math.min(harmonicPool.length, Math.floor(complexity)));
    const harmonics = harmonicPool.slice(0, numHarmonics);
    const ampSum = harmonics.reduce((a, h) => a + h.amp, 0);

    const sampleCount = Math.max(36, numHarmonics * 6);
    const points = [];
    for (let i = 0; i < sampleCount; i++) {
        const angle = (i / sampleCount) * Math.PI * 2;
        let variance = 1;
        for (const h of harmonics) {
            variance += contrast * (h.amp / ampSum) * Math.sin(h.freq * angle + h.phase);
        }
        variance = Math.max(0.15, variance);
        const r = baseRadius * variance;
        points.push({ x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
    }
    return points;
}

function buildSmoothClosedCurve(points) {
    const n = points.length;
    const cb = CurveBuilder.create();
    cb.beginXY(points[0].x, points[0].y);
    for (let i = 0; i < n; i++) {
        const p0 = points[(i - 1 + n) % n];
        const p1 = points[i];
        const p2 = points[(i + 1) % n];
        const p3 = points[(i + 2) % n];
        const c0x = p1.x + (p2.x - p0.x) / 6;
        const c0y = p1.y + (p2.y - p0.y) / 6;
        const c1x = p2.x - (p3.x - p1.x) / 6;
        const c1y = p2.y - (p3.y - p1.y) / 6;
        cb.addBezierXY(c0x, c0y, c1x, c1y, p2.x, p2.y);
    }
    const curve = cb.createCurve();
    curve.makeClosed();
    return curve;
}

function buildBlobPolyCurve(cx, cy, baseRadius, complexity, contrast, harmonicPool) {
    const points = generateBlobPoints(cx, cy, baseRadius, complexity, contrast, harmonicPool);
    const curve = buildSmoothClosedCurve(points);
    const polyCurve = PolyCurve.create();
    polyCurve.addCurve(curve);
    return polyCurve;
}

// Combines two spread-relative boxes into their union (smallest box containing both).
function unionBox(a, b) {
    if (!a) return b;
    if (!b) return a;
    const x0 = Math.min(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const x1 = Math.max(a.x + a.width, b.x + b.width);
    const y1 = Math.max(a.y + a.height, b.y + b.height);
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// Walks up from a node to find the artboard that actually contains it in the
// node tree (artboards are real parent containers here, not just geometric
// regions - node.artboardInterface only tells you about the node ITSELF).
function findContainingArtboardNode(node) {
    let n = node;
    while (n) {
        try {
            if (n.artboardInterface && n.artboardInterface.isArtboardEnabled) {
                return n;
            }
        } catch (e) {
            // Not every node type exposes artboardInterface - just keep walking up.
        }
        n = n.parent;
    }
    return null;
}

// Works out the spread-relative box to center the blob in:
//   1. The bounding box of the current selection, if anything is selected
//      (the union of all selected nodes' boxes, for multi-selections).
//   2. Otherwise the last artboard on the spread (best available proxy for
//      "last active", since the SDK has no explicit current-artboard concept).
//   3. Otherwise the whole spread, if the document has no artboards at all.
function getTargetBox(doc, spread) {
    const selection = doc.selection;
    if (selection && selection.length > 0) {
        let box = null;
        for (const node of selection.nodes) {
            try {
                if (node) {
                    box = unionBox(box, node.exactSpreadBaseBox);
                }
            } catch (e) {
                // This node type doesn't expose a spread bounding box - skip it.
            }
        }
        if (box) {
            return box;
        }
    }

    if (spread.artboardCount > 0) {
        const artboards = spread.artboards;
        if (artboards.length > 0) {
            return artboards[artboards.length - 1].spreadBaseBox;
        }
    }

    return spread.baseBox;
}

// Works out which node the new blob should be added as a child of, so it
// actually nests inside the right artboard in the Layers panel rather than
// just visually overlapping it:
//   1. The artboard containing the current selection, if any.
//   2. Otherwise the last artboard on the spread.
//   3. Otherwise the spread itself, if the document has no artboards.
function getInsertionTarget(doc, spread) {
    const selection = doc.selection;
    if (selection && selection.length > 0) {
        for (const node of selection.nodes) {
            const artboardNode = findContainingArtboardNode(node);
            if (artboardNode) {
                return artboardNode;
            }
        }
    }

    if (spread.artboardCount > 0) {
        const artboards = spread.artboards;
        if (artboards.length > 0) {
            return artboards[artboards.length - 1].node;
        }
    }

    return spread;
}

const doc = Document.current;
if (!doc) {
    throw new Error("No document is currently open.");
}

const spread = doc.currentSpread;
const targetBox = getTargetBox(doc, spread);
const insertionTarget = getInsertionTarget(doc, spread);
const cx = targetBox.x + targetBox.width / 2;
const cy = targetBox.y + targetBox.height / 2;

let complexity = 10;
let contrast = 45;
let size = 600;
let seed = Math.floor(Math.random() * MAX_SEED);
let harmonicPool = generateHarmonicPool(MAX_COMPLEXITY, seed);

const initialPolyCurve = buildBlobPolyCurve(cx, cy, size / 2, complexity, contrast / 100, harmonicPool);

const brushFill = FillDescriptor.createSolid(SVG11.black);
const lineFill = FillDescriptor.createNone();
const lineStyle = LineStyleDescriptor.createDefault();
const transparencyFill = FillDescriptor.createNone();

const initialNodeDef = PolyCurveNodeDefinition.create(initialPolyCurve, brushFill, lineStyle, lineFill, transparencyFill);
initialNodeDef.userDescription = "Blob";

const addBuilder = AddChildNodesCommandBuilder.create();
addBuilder.setInsertionTarget(insertionTarget);
addBuilder.addPolyCurveNode(initialNodeDef);
const addCmd = addBuilder.createCommand(true, NodeChildType.Main);
doc.executeCommand(addCmd);

const blobNode = addCmd.newNodes[0];

// Regenerates the curve from current state and pushes it to the live node.
// preview=true updates the canvas without adding an undo step.
function updatePreview(preview) {
    const polyCurve = buildBlobPolyCurve(cx, cy, size / 2, complexity, contrast / 100, harmonicPool);
    const setCurvesCmd = DocumentCommand.createSetCurves(blobNode.curvesInterface, polyCurve);
    doc.executeCommand(setCurvesCmd, preview);
}

const dialog = Dialog.create("Blob Generator");
dialog.initialWidth = 320;
const column = dialog.addColumn();
const group = column.addGroup("Blob Settings");

const complexityEditor = group.addUnitValueEditor("Complexity", UnitType.Number, UnitType.Number, complexity, 1, MAX_COMPLEXITY);
complexityEditor.precision = 0;
complexityEditor.showPopupSlider = true;
complexityEditor.description = "How many bumps the outline has.";

const contrastEditor = group.addUnitValueEditor("Contrast", UnitType.Number, UnitType.Number, contrast, 0, 100);
contrastEditor.precision = 0;
contrastEditor.showPopupSlider = true;
contrastEditor.description = "How irregular the outline is.";

const sizeEditor = group.addUnitValueEditor("Size", UnitType.Pixel, UnitType.Pixel, size, 10, 5000);
sizeEditor.precision = 0;
sizeEditor.showPopupSlider = true;
sizeEditor.description = "Diameter of the blob.";

const seedEditor = group.addUnitValueEditor("Seed", UnitType.Number, UnitType.Number, seed, 0, MAX_SEED);
seedEditor.precision = 0;
seedEditor.showPopupSlider = true;
seedEditor.description = "Controls the blob's random shape.";

const regenerateButton = group.addButton("Regenerate");
regenerateButton.setIsFullWidth(true);
regenerateButton.description = "Try a new random shape.";

function onComplexityChanged() {
    complexity = complexityEditor.value;
    updatePreview(true);
}

function onContrastChanged() {
    contrast = contrastEditor.value;
    updatePreview(true);
}

function onSizeChanged() {
    size = sizeEditor.value;
    updatePreview(true);
}

function onSeedChanged() {
    seed = seedEditor.value;
    harmonicPool = generateHarmonicPool(MAX_COMPLEXITY, seed);
    updatePreview(true);
}

function onRegenerateClicked() {
    seed = Math.floor(Math.random() * MAX_SEED);
    seedEditor.value = seed;
    harmonicPool = generateHarmonicPool(MAX_COMPLEXITY, seed);
    updatePreview(true);
}

complexityEditor.setOnValueChangedHandler(onComplexityChanged);
contrastEditor.setOnValueChangedHandler(onContrastChanged);
sizeEditor.setOnValueChangedHandler(onSizeChanged);
seedEditor.setOnValueChangedHandler(onSeedChanged);
regenerateButton.setOnClickHandler(onRegenerateClicked);

const result = dialog.runModal();

if (result === DialogResult.Ok) {
    updatePreview(false);
    console.log("Blob created. complexity=" + complexity + " contrast=" + contrast + " size=" + size + " seed=" + seed);
}
else {
    doc.clearPreviews();
    blobNode.delete();
    console.log("Cancelled - no blob created.");
}
