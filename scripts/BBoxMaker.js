/**
 * name: BBox Maker
 * version: 1.3.5
 * description: Creates bboxes using Bounding Box or Effective Pixel Area, with BBox or Layer parenting. Independent color and opacity controls default to green with 50% color alpha / 100% object opacity.
  * author: WaveF
 * email: wavef@live.com
 * website: https://minicg.com
*/
'use strict';
const { app } = require('/application');
const { Document } = require('/document');
const { DocumentCommand, AddChildNodesCommandBuilder, InsertionMode } = require('/commands');
const { ImageNodeDefinition, ContainerNodeDefinition, ShapeNodeDefinition } = require('/nodes');
const { Dialog, DialogResult } = require('/dialog');
const { ShapeRectangle } = require('/shapes');
const { Selection } = require('/selections');
const { NodeRenderingEngine, RasterFormat } = require('/rasterobject');
const { Transform, Rectangle } = require('/geometry');
const { FillDescriptor } = require('/fills');
const { UnitType } = require('/units');
const { Colour, RGBA8 } = require('/colours');
const { NodeMoveType, NodeChildType } = require('affinity:dom');

function createElementsBbox(doc, mode = 'bounds', parentMode = 'bbox', style = {}) {
    const fillColour = style.colour === undefined ? RGBA8(0, 255, 0, 128) : style.colour;
    const opacity = style.opacity === undefined ? 1 : style.opacity;
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new Error('Opacity must be between 0% and 100%.');
    if (!['bbox', 'layer'].includes(parentMode)) throw new Error('Unknown parent mode.');
    if (!['effective', 'bounds'].includes(mode)) throw new Error('Unknown bbox mode.');
    if (!doc) throw new Error('Please open a document first.');
    const originals = [];
    for (let i = 0; i < doc.selection.length; i++) {
        const n = doc.selection.at(i).node;
        if (n) originals.push(n);
    }
    if (!originals.length) throw new Error('Please select at least one element.');
    // Processing an ancestor and its descendant separately would capture a
    // bbox generated earlier in this same run. Reject this ambiguous selection.
    for (const n of originals) {
        let p = n.parent;
        while (p) {
            if (originals.some(s => s.isSameNode(p))) {
                throw new Error('Select either a group or its children, not both.');
            }
            p = p.parent;
        }
    }
    const groups = [];
    const failures = [];
    const select = n => Selection.create(doc, n);
    const move = (nodes, target, mode) => doc.executeCommand(
        DocumentCommand.createMoveNodes(select(nodes), target, mode, NodeChildType.Main));
    function addNode(definition, spread) {
        const builder = AddChildNodesCommandBuilder.create();
        builder.setInsertionTarget(spread);
        builder.setInsertionMode(InsertionMode.Inside_AtFront);
        builder.addNode(definition);
        const command = builder.createCommand(true, NodeChildType.Main);
        doc.executeCommand(command);
        const node = command.newNodes[0];
        if (!node) throw new Error('Could not create a node.');
        return node;
    }
    for (const original of originals) {
        const name = original.userDescription || original.defaultDescription || 'Element';
        const spread = original.spread;
        if (!spread.isSameNode(doc.currentSpread)) {
            doc.executeCommand(DocumentCommand.createSetCurrentSpread(spread));
        }
        const start = doc.history.position;
        try {
            if (!Array.from(original.parent.children).some(n => n.isSameNode(original))) {
                throw new Error('Masks and enclosures are not supported.');
            }
            let bbox;
            if (mode === 'bounds') {
                const box = original.getSpreadBaseBox();
                if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) {
                    throw new Error('The element has no valid bounding box.');
                }
                const definition = ShapeNodeDefinition.createDefault();
                definition.shape = ShapeRectangle.create();
                definition.setBoundingRectangle(new Rectangle(box.x, box.y, box.width, box.height));
                bbox = addNode(definition, spread);
            } else {
                const duplicateCommand = DocumentCommand.createTransform(select(original), null, { duplicateNodes: true });
                doc.executeCommand(duplicateCommand);
                const duplicate = duplicateCommand.newNodes[0];
                if (!duplicate) throw new Error('Could not duplicate the element.');
                doc.selection = [duplicate];
                // false: bake effects rather than retain them. false: do not clip
                // the raster to the spread, which could truncate an outer shadow.
                doc.executeCommand(DocumentCommand.createRasteriseObjects(select(duplicate), false, false));
                if (doc.selection.length !== 1) throw new Error('Rasterization did not return one element.');
                const raster = doc.selection.at(0).node;
                if (!raster.isRasterNode) throw new Error('Rasterization did not produce a pixel layer.');
                // Read bounds only AFTER baking effects. The raster's underlying
                // bitmap can span the whole document; render the node to crop it
                // to the actual raster extent before creating the image resource.
                const box = raster.getSpreadBaseBox();
                if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) {
                    throw new Error('The rasterized element is empty.');
                }
                const engine = NodeRenderingEngine.createDefault(raster, RasterFormat.RGBA8);
                const bitmap = engine.createCompatibleBitmap(true);
                if (!bitmap.width || !bitmap.height) throw new Error('The rendered image is empty.');
                const imageDefinition = ImageNodeDefinition.create(RasterFormat.RGBA8);
                imageDefinition.bitmap = bitmap;
                imageDefinition.transform = Transform.createTranslate(box.x, box.y).multiply(
                    Transform.createScale(box.width / bitmap.width, box.height / bitmap.height));
                const image = addNode(imageDefinition, spread);
                doc.executeCommand(DocumentCommand.createDeleteSelection(select(raster), true));
                doc.selection = [image];
                doc.executeCommand(DocumentCommand.createConvertToCurves(select(image)));
                if (doc.selection.length !== 1) throw new Error('Conversion did not return one bbox.');
                bbox = doc.selection.at(0).node;
                if (!bbox.isPolyCurveNode) throw new Error('Image-to-curves conversion failed.');
            }
            const asParent = parentMode === 'bbox';
            doc.executeCommand(DocumentCommand.createSetBrushFill(select(bbox), fillColour === null
                ? FillDescriptor.createNone() : FillDescriptor.createSolid(fillColour)));
            doc.executeCommand(DocumentCommand.createSetPenFill(select(bbox), FillDescriptor.createNone()));
            doc.executeCommand(DocumentCommand.createSetOpacity(select(bbox), opacity));
            bbox.userDescription = original.userDescription;
            if (asParent) {
                move(bbox, original, NodeMoveType.Before);
                move(original, bbox, NodeMoveType.Inside);
                if (!original.parent.isSameNode(bbox)) throw new Error('Could not move the element into its bbox.');
                groups.push(bbox);
            } else {
                const group = addNode(ContainerNodeDefinition.create(name + ' + Bbox'), spread);
                move(group, original, NodeMoveType.Before);
                move(original, group, NodeMoveType.Inside);
                // Native sibling order runs back-to-front: After is above.
                move(bbox, original, NodeMoveType.After);
                if (!bbox.parent.isSameNode(group) || !original.parent.isSameNode(group)) {
                    throw new Error('Could not pair the original and bbox.');
                }
                groups.push(group);
            }
        } catch (error) {
            if (doc.history.position !== start) doc.history.position = start;
            failures.push(name + ': ' + String(error.message || error));
        }
    }
    doc.selection = groups.length ? groups : originals;
    return { groups, failures };
}

function createBboxDialog() {
    const dialog = Dialog.create('BBox Maker');
    dialog.initialWidth = 440;
    const column = dialog.addColumn();
    const modeGroup = column.addGroup('Mode');
    const modeControl = modeGroup.addButtonSet('Based on', ['Bounding box', 'Effective Pixel Area'], 0);
    const parentGroup = column.addGroup('Parent');
    const parentControl = parentGroup.addButtonSet('Place in', ['BBox', 'Layer'], 0);
    modeControl.selectedIndex = 0;
    parentControl.selectedIndex = 0;
    const bboxGroup = column.addGroup('BBox');
    const colourControl = bboxGroup.addColourPicker('Style', RGBA8(0, 255, 0, 128));
    colourControl.allowPickNone = true;
    colourControl.allowNoise = false;
    const opacityControl = bboxGroup.addUnitValueEditor('Opacity (%)', UnitType.Number, UnitType.Number, 100, 0, 100);
    opacityControl.setPrecision(0);
    return { dialog, modeControl, parentControl, colourControl, opacityControl };
}

function chooseBboxSettings() {
    const { dialog, modeControl, parentControl, colourControl, opacityControl } = createBboxDialog();
    if (dialog.runModal().value !== DialogResult.Ok.value) return null;
    return {
        mode: modeControl.selectedIndex === 1 ? 'effective' : 'bounds',
        parent: parentControl.selectedIndex === 1 ? 'layer' : 'bbox',
        colour: colourControl.value,
        opacity: opacityControl.value / 100
    };
}

function main() {
    try {
        const doc = Document.current;
        if (!doc) throw new Error('Please open a document first.');
        if (!doc.selection.length) throw new Error('Please select at least one element.');
        const settings = chooseBboxSettings();
        if (settings === null) return;
        const result = createElementsBbox(doc, settings.mode, settings.parent, { colour: settings.colour, opacity: settings.opacity });
        console.log(JSON.stringify({ created: result.groups.length, failures: result.failures }));
        if (result.failures.length) app.alert(result.failures.join('\n'), 'BBox Maker');
    } catch (error) {
        app.alert(String(error.message || error), 'BBox Maker');
    }
}

main();
