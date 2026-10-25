/**
 * name: Freeze
 * version: 0.2.1
 * description: Toggle between a live element and a static image snapshot. Freezing a selected element renders it to pixels (baking layer effects, live filters and everything else), places the result as an Image layer named "<name> ❄" exactly over the element, then hides the original and nests it under the snapshot. Hidden layers are not rendered, so heavy effects stop costing anything while the design looks exactly the same. Because the snapshot is an Image layer, Affinity shows how much it has been scaled and can reset it to its original size. Running the script on a "❄" snapshot (or on the hidden original nested under it) thaws it: the original is moved back into place, made visible again and the snapshot is deleted. Pixel-layer snapshots made by v0.1.0 can still be thawed. Mixed selections are handled per element; already-hidden elements and elements that cannot be rasterised are skipped. Runs without a dialog. Freeze costs two history steps per element; thaw is a single step.
 * author: WaveF
 * email: wavef@live.com
 * website: https://minicg.com
 */
'use strict';

const { app } = require('/application');
const { Document } = require('/document');
const { DocumentCommand, AddChildNodesCommandBuilder, InsertionMode, createCompoundCommand } = require('/commands');
const { ImageNodeDefinition } = require('/nodes');
const { Selection } = require('/selections');
const { Transform, Rectangle } = require('/geometry');
const { Bitmap, PixelBuffer } = require('/rasterobject');
const { BlendMode } = require('affinity:common');
const { NodeMoveType, NodeChildType } = require('affinity:dom');

const SCRIPT_NAME = 'Freeze';
const VERSION = '0.2.1';
const SCRIPT_TITLE = SCRIPT_NAME + ' v' + VERSION;

const FROZEN_SUFFIX = ' ❄';

// ---------------------------------------------------------------------------
// Selection helpers
// ---------------------------------------------------------------------------

function selectedNodes(doc) {
    const raw = [];
    const current = doc.selection;
    for (let i = 0; i < current.length; i++) {
        const node = current.at(i).node;
        if (node) raw.push(node);
    }
    // Drop elements nested inside other selected elements.
    const selection = Selection.create(doc, raw, true);
    const nodes = [];
    for (let i = 0; i < selection.length; i++) {
        const node = selection.at(i).node;
        if (node) nodes.push(node);
    }
    return nodes;
}

function sel(doc, nodes) {
    return Selection.create(doc, nodes);
}

function childrenOf(node) {
    const out = [];
    node.children.forEach(c => out.push(c));
    return out;
}

// A frozen snapshot is an image layer (v0.2.0) or pixel layer (v0.1.0) named "<name> ❄"
// with exactly one hidden child (the original).
function isFrozenSnapshot(node) {
    if (!node || !(node.isImageNode || node.isRasterNode)) return false;
    const name = node.description || '';
    if (!name.endsWith(FROZEN_SUFFIX)) return false;
    const kids = childrenOf(node);
    return kids.length === 1 && !kids[0].isVisible;
}

// ---------------------------------------------------------------------------
// Freeze / thaw
// ---------------------------------------------------------------------------

/**
 * Render a node to pixels without touching the document history.
 * Rasterises the node as a preview, copies the used pixel area out of the temporary pixel layer and
 * clears the preview again. Returns { bitmap, format, transform, blendMode, opacity } or null.
 * transform maps the bitmap's pixel space to spread coordinates.
 */
function renderSnapshot(doc, node) {
    doc.executeCommand(DocumentCommand.createRasteriseObjects(sel(doc, [node]), false, false), true);
    try {
        const raster = doc.selection.length === 1 ? doc.selection.at(0).node : null;
        if (!raster || !raster.isRasterNode) return null;
        // The pixel layer covers the whole spread; baseBox is the used area in its pixel grid.
        const box = raster.baseBox;
        if (!(box.width >= 1 && box.height >= 1)) return null;
        const format = raster.rasterFormat;
        const bitmap = cropToBitmap(raster, box, format);
        return {
            bitmap,
            format,
            transform: raster.baseToSpreadTransform.multiply(Transform.createTranslate(box.x, box.y)),
            // Rasterising keeps some layer properties on the pixel layer instead of baking them.
            blendMode: raster.blendMode,
            opacity: raster.globalOpacity,
        };
    } finally {
        doc.clearPreviews();
    }
}

/**
 * Copy the box area of a pixel layer into a new Bitmap.
 * RasterInterface.copyTo ignores its source offsets, so the rows are copied by hand.
 */
function cropToBitmap(raster, box, format) {
    const pixelSize = raster.pixelSize;
    const srcStride = raster.rasterWidth * pixelSize;
    const rowBytes = box.width * pixelSize;
    const src = new Uint8Array(raster.createCompatibleBuffer(true).buffer);
    const crop = PixelBuffer.create(box.width, box.height, format);
    const dst = new Uint8Array(crop.buffer);
    for (let y = 0; y < box.height; y++) {
        const from = (box.y + y) * srcStride + box.x * pixelSize;
        dst.set(src.subarray(from, from + rowBytes), y * rowBytes);
    }
    const bitmap = Bitmap.create(box.width, box.height, format);
    crop.copyTo(bitmap, new Rectangle(0, 0, box.width, box.height), 0, 0);
    return bitmap;
}

/**
 * Returns the spread transform that moves a node from its current baseToSpreadTransform to target,
 * or null if it is already there.
 */
function placementCorrection(current, target) {
    const a = current.data, b = target.data;
    let off = false;
    for (let i = 0; i < 6; i++) {
        const eps = (i === 2 || i === 5) ? 1e-3 : 1e-6;
        if (Math.abs(a[i] - b[i]) > eps) { off = true; break; }
    }
    return off ? target.multiply(current.inverted) : null;
}

/**
 * Freeze one live node. Returns the snapshot node, or null if the node was skipped.
 */
function freezeNode(doc, node) {
    const name = node.description || '';
    const parent = node.parent;
    if (!parent) return null;

    const shot = renderSnapshot(doc, node);
    if (!shot) return null;

    // Image layer at native pixel size (100%), placed exactly over the element.
    const def = ImageNodeDefinition.create(shot.format);
    def.bitmap = shot.bitmap;
    // The definition transform is read in spread coordinates. Do not convert it to parent space:
    // a moved artboard or a rotated/scaled layer has a transform of its own that its children's
    // baseToSpreadTransform does not include, so parent-relative maths misplaces the snapshot.
    def.transform = shot.transform;
    def.userDescription = name + FROZEN_SUFFIX;
    // Insert into the parent (inserting relative to a top-level layer is rejected); the compound
    // command below moves it right next to the original.
    const builder = AddChildNodesCommandBuilder.create();
    builder.setInsertionTarget(parent);
    builder.setInsertionMode(InsertionMode.Inside_AtFront);
    builder.addImageNode(def);
    const add = builder.createCommand(true, NodeChildType.Main);
    doc.executeCommand(add);
    const snap = add.newNodes.length === 1 ? add.newNodes[0] : null;
    if (!snap) return null;

    // Take the original's place in the stack, carry over layer properties,
    // hide the original and tuck it under the snapshot.
    const steps = [];
    // Safety net: if the image did not land exactly where the pixels were rendered, put it there.
    const fix = placementCorrection(snap.baseToSpreadTransform, shot.transform);
    if (fix) steps.push(DocumentCommand.createTransform(sel(doc, [snap]), fix));
    steps.push(DocumentCommand.createMoveNodes(sel(doc, [snap]), node, NodeMoveType.Before, NodeChildType.Main));
    if (shot.blendMode && shot.blendMode.value !== BlendMode.Normal.value) {
        steps.push(DocumentCommand.createSetBlendMode(sel(doc, [snap]), shot.blendMode));
    }
    if (typeof shot.opacity === 'number' && shot.opacity < 1) {
        steps.push(DocumentCommand.createSetOpacity(sel(doc, [snap]), shot.opacity));
    }
    steps.push(DocumentCommand.createSetVisibility(sel(doc, [node]), false, null));
    steps.push(DocumentCommand.createMoveNodes(sel(doc, [node]), snap, NodeMoveType.Inside, NodeChildType.Main));
    doc.executeCommand(createCompoundCommand(steps));
    return snap;
}

/**
 * Thaw one snapshot. Returns the restored original node.
 */
function thawNode(doc, snap) {
    const original = childrenOf(snap)[0];
    doc.executeCommand(createCompoundCommand([
        DocumentCommand.createMoveNodes(sel(doc, [original]), snap, NodeMoveType.After, NodeChildType.Main),
        DocumentCommand.createSetVisibility(sel(doc, [original]), true, null),
        DocumentCommand.createDeleteSelection(sel(doc, [snap]), false),
    ]));
    return original;
}

/**
 * Classify the selection and run the matching action on each element.
 * Returns { frozen, thawed, skipped, result } where result holds the nodes to select afterwards.
 */
function toggleFreeze(doc, nodes) {
    const toThaw = [];
    const toFreeze = [];
    let skipped = 0;

    const addToThaw = (snap) => {
        if (!toThaw.some(s => s.isSameNode(snap))) toThaw.push(snap);
    };

    for (const node of nodes) {
        if (isFrozenSnapshot(node)) {
            addToThaw(node);
        } else if (node.parent && isFrozenSnapshot(node.parent)) {
            addToThaw(node.parent); // the hidden original was selected: thaw its snapshot
        } else if (!node.isVisible) {
            skipped++; // nothing to snapshot
        } else {
            toFreeze.push(node);
        }
    }

    const result = [];
    let thawed = 0;
    for (const snap of toThaw) {
        result.push(thawNode(doc, snap));
        thawed++;
    }

    let frozen = 0;
    for (const node of toFreeze) {
        const snap = freezeNode(doc, node);
        if (snap) {
            result.push(snap);
            frozen++;
        } else {
            skipped++;
        }
    }

    return { frozen, thawed, skipped, result };
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function main() {
    try {
        const doc = Document.current;
        if (!doc) {
            app.alert('Open a document first.', SCRIPT_TITLE);
            return;
        }
        const nodes = selectedNodes(doc);
        if (nodes.length === 0) {
            app.alert('Select one or more elements to freeze, or "❄" snapshots to thaw.', SCRIPT_TITLE);
            return;
        }

        const { frozen, thawed, skipped, result } = toggleFreeze(doc, nodes);

        if (result.length > 0) {
            doc.selection = Selection.create(doc, result);
        }
        if (frozen === 0 && thawed === 0) {
            app.alert('Nothing to do: the selected elements are hidden or cannot be rasterised.', SCRIPT_TITLE);
        } else if (skipped > 0) {
            app.alert(
                (frozen ? 'Frozen ' + frozen + '. ' : '') +
                (thawed ? 'Thawed ' + thawed + '. ' : '') +
                'Skipped ' + skipped + ' (hidden or cannot be rasterised).',
                SCRIPT_TITLE
            );
        }
    } catch (error) {
        app.alert(String(error && error.message || error), SCRIPT_TITLE);
    }
}

main();
