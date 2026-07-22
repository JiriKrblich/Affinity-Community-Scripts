/**
 * name: Glypher: Artboards for Glyphs.
 * description: Creates a new artboard with all important measurements for glyph design. For easy export to FontForge, disable the "Font Metrics" layer.
 * version: 1.0.0
 * author: Nic Kraneis
 */

'use strict';

function main() {
    const { Document } = require('/document.js');
    const { Dialog, DialogResult, UnitType, SpatialAnchor } = require('/dialog.js');
    const {
        ContainerNodeDefinition,
        PolyCurveNodeDefinition,
        ArtTextNodeDefinition,
        ShapeNodeDefinition,
        NodeChildType
    } = require('/nodes.js');
    const { AddChildNodesCommandBuilder, DocumentCommand } = require('/commands.js');
    const { Curve, PolyCurve, Rectangle } = require('/geometry.js');
    const { LineStyle, LineStyleDescriptor } = require('/linestyle.js');
    const { FillDescriptor } = require('/fills.js');
    const { RGB8 } = require('/colours.js');
    const { StoryBuilder } = require('/storybuilder.js');
    const { GlyphAtts } = require('/glyphatts.js');
    const { Font } = require('/fonts.js');
    const { Selection } = require('/selections.js');
    const { ShapeRectangle } = require('/shapes.js');

    const ARTBOARD_SIZE = 1000;
    const ARTBOARD_GAP = 100;
    const ARTBOARD_NAME = 'New Glyph';
    const LAYER_NAME = 'Font Metrics';

    const doc = Document.current;
    if (!doc) {
        console.log('Error: No document open.');
        return;
    }

    // --- 1. Always create a brand new artboard, placed after any existing ones ---
    const spread = doc.spreads.first;
    let newX = 0;
    if (spread) {
        for (let i = 0; i < spread.artboardCount; i++) {
            try {
                const box = spread.artboards[i].node.artboardInterface.spreadBaseBox;
                newX = Math.max(newX, box.x + box.width);
            } catch (e) { /* not an artboard */ }
        }
    }
    if (newX > 0) {
        newX += ARTBOARD_GAP;
    }

    const abDef = ShapeNodeDefinition.createDefault();
    abDef.shape = ShapeRectangle.create();
    abDef.setBoundingRectangle(new Rectangle(newX, 0, ARTBOARD_SIZE, ARTBOARD_SIZE));
    const addArtboardCmd = DocumentCommand.createAddArtboard(abDef);
    doc.executeCommand(addArtboardCmd);
    const artboardNode = addArtboardCmd.newNodes[0];
    doc.executeCommand(DocumentCommand.createSetDescription(Selection.create(doc, artboardNode), ARTBOARD_NAME));

    // --- 2. Dialog for metric values ---
    const dlg = Dialog.create('Font Metrics Setup');
    dlg.isResizable = true;
    const col = dlg.addColumn();

    const info = col.addGroup('Info');
    info.addStaticText('', 'Artboard: 1000 x 1000 px. Values in px, relative to the baseline (0).');

    const mainGroup = col.addGroup('Main Metrics (1000 UPM)');
    const ascCtrl = mainGroup.addUnitValueEditor('Ascender', UnitType.Pixel, UnitType.Pixel, 750, -5000, 5000);
    const capCtrl = mainGroup.addUnitValueEditor('Cap Height', UnitType.Pixel, UnitType.Pixel, 700, -5000, 5000);
    const xCtrl = mainGroup.addUnitValueEditor('x-Height', UnitType.Pixel, UnitType.Pixel, 500, -5000, 5000);
    const descCtrl = mainGroup.addUnitValueEditor('Descender', UnitType.Pixel, UnitType.Pixel, -250, -5000, 5000);

    const overshootGroup = col.addGroup('Overshoot (optical compensation for curves)');
    const voTopCtrl = overshootGroup.addUnitValueEditor('Cap Overshoot Top', UnitType.Pixel, UnitType.Pixel, 15, 0, 100);
    const voBottomCtrl = overshootGroup.addUnitValueEditor('Cap Overshoot Bottom', UnitType.Pixel, UnitType.Pixel, 15, 0, 100);
    const xoTopCtrl = overshootGroup.addUnitValueEditor('x-Height Overshoot Top', UnitType.Pixel, UnitType.Pixel, 15, 0, 100);
    const xoBottomCtrl = overshootGroup.addUnitValueEditor('x-Height Overshoot Bottom', UnitType.Pixel, UnitType.Pixel, 15, 0, 100);

    const modalResult = dlg.runModal();
    if (!(modalResult === DialogResult.Ok || modalResult === true)) {
        console.log('Cancelled.');
        return;
    }

    const ascender = ascCtrl.value;
    const capHeight = capCtrl.value;
    const xHeight = xCtrl.value;
    const baseline = 0;
    const descender = descCtrl.value;

    const voTop = voTopCtrl.value;
    const voBottom = voBottomCtrl.value;
    const xoTop = xoTopCtrl.value;
    const xoBottom = xoBottomCtrl.value;

    // --- 3. Prepare metrics ---
    // "light: true" = overshoot line (drawn lighter)
    const metrics = [
        { name: 'Ascender', value: ascender, light: false },
        { name: 'Cap Overshoot (Top)', value: capHeight + voTop, light: true },
        { name: 'Cap Height', value: capHeight, light: false },
        { name: 'x-Height Overshoot (Top)', value: xHeight + xoTop, light: true },
        { name: 'x-Height', value: xHeight, light: false },
        { name: 'Baseline', value: baseline, light: false },
        { name: 'x-Height Overshoot (Bottom)', value: baseline - xoBottom, light: true },
        { name: 'Cap Overshoot (Bottom)', value: baseline - voBottom, light: true },
        { name: 'Descender', value: descender, light: false }
    ];

    const dpi = doc.dpi || 72;
    const scale = dpi / 72;
    const lineWeight = 2 * scale;
    const fontSize = 9 * scale;
    const labelGapY = 4 * scale;
    const labelPadX = 4 * scale;
    const mainGray = RGB8(179, 179, 179);
    const lightGray = RGB8(217, 217, 217); // overshoot: a bit lighter than the main lines

    // Merge metrics that share the exact same value (e.g. two overshoot values that
    // happen to match) into a single line with a combined label, instead of drawing
    // two overlapping lines/labels.
    const grouped = [];
    for (const m of metrics) {
        const existing = grouped.find(g => g.value === m.value);
        if (existing) {
            existing.names.push(m.name);
            existing.light = existing.light && m.light;
        } else {
            grouped.push({ value: m.value, names: [m.name], light: m.light });
        }
    }

    const ai = artboardNode.artboardInterface;
    const box = ai.spreadBaseBox;

    // Vertical layout: highest value at the top, lowest at the bottom, centred
    // symmetrically within the artboard.
    const values = metrics.map(m => m.value);
    const topValue = Math.max(...values);
    const bottomValue = Math.min(...values);
    const totalSpan = topValue - bottomValue;
    const topMargin = (box.height - totalSpan) / 2;

    function yFor(value) {
        return box.y + topMargin + (topValue - value);
    }

    // --- 4. Create the locked layer (container) ---
    const containerBuilder = AddChildNodesCommandBuilder.create();
    containerBuilder.setInsertionTarget(artboardNode);
    containerBuilder.addContainerNode(ContainerNodeDefinition.create(LAYER_NAME));
    const containerCmd = containerBuilder.createCommand(true, NodeChildType.Main);
    doc.executeCommand(containerCmd);
    const containerNode = containerCmd.newNodes[0];

    // --- 5. Build lines + labels ---
    const noFill = FillDescriptor.createNone();
    const mainLineFillDesc = FillDescriptor.createSolid(mainGray);
    const lightLineFillDesc = FillDescriptor.createSolid(lightGray);
    const lineStyleDesc = LineStyleDescriptor.create(LineStyle.createDefaultWithWeight(lineWeight));
    const defaultFont = Font.createDefault();

    const x1 = box.x;
    const x2 = box.x + box.width;

    const nodeBuilder = AddChildNodesCommandBuilder.create();
    nodeBuilder.setInsertionTarget(containerNode);

    for (const g of grouped) {
        const y = yFor(g.value);
        const colour = g.light ? lightGray : mainGray;
        const lineFillDesc = g.light ? lightLineFillDesc : mainLineFillDesc;
        const label = g.names.join(' / ');

        // Line
        const pc = PolyCurve.create();
        pc.addCurve(Curve.createLineXY(x1, y, x2, y));
        const lineDef = PolyCurveNodeDefinition.create(pc, noFill, lineStyleDesc, lineFillDesc, noFill);
        lineDef.userDescription = label + ' Line';
        nodeBuilder.addPolyCurveNode(lineDef);

        // Label
        const sb = StoryBuilder.create();
        sb.setToArtisticTextDefaultStyle(doc.dpi, doc.format);
        const atts = GlyphAtts.create();
        atts.font = defaultFont;
        atts.height = fontSize;
        atts.brushFill = FillDescriptor.createSolid(colour);
        sb.setGlyphAtts(atts);
        sb.addText(label + ' (' + Math.round(g.value) + ')');
        // Label normally sits ABOVE the line; if that would push it past the
        // artboard edge (e.g. for a line right at the top), it is placed below instead.
        let labelY = y - labelGapY;
        if (labelY - fontSize < box.y) {
            labelY = y + fontSize + labelGapY;
        }
        const textDef = ArtTextNodeDefinition.createFromStoryBuilder({ x: x1 + labelPadX, y: labelY }, sb);
        nodeBuilder.addNode(textDef);
    }

    const nodesCmd = nodeBuilder.createCommand(true, NodeChildType.Main);
    doc.executeCommand(nodesCmd);

    // --- 6. Lock the layer ---
    const containerSelection = Selection.create(doc, containerNode);
    doc.lockSelection(containerSelection);

    console.log('Done: new 1000x1000 artboard + locked layer "' + LAYER_NAME + '" with ' + grouped.length + ' guide lines (incl. overshoot, merged) created.');
}

main();
