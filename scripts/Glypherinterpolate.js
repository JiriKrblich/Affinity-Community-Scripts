/**
 * name: Glypher: Interpolate Glyphs
 * description: Choose two paths to interpolate or extrapolate at set percentages. Both paths must consist of the same number of nodes. Works best with "Glypher: Artboards for Glyphs"
 * version: 1.0.0
 * author: Nic Kraneis
 */


'use strict';

function main() {
    const { Document } = require('/document.js');
    const { Dialog, DialogResult, UnitType } = require('/dialog.js');
    const {
        ContainerNodeDefinition,
        PolyCurveNodeDefinition,
        ArtTextNodeDefinition,
        ShapeNodeDefinition,
        NodeChildType
    } = require('/nodes.js');
    const { AddChildNodesCommandBuilder, DocumentCommand } = require('/commands.js');
    const { PolyCurve, CurveBuilder, Curve, Rectangle } = require('/geometry.js');
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

    const doc = Document.current;
    if (!doc) {
        console.log('Error: No document open.');
        return;
    }

    // --- 1. Validate selection: exactly 2 objects, start first, end second ---
    const selNodes = doc.selection.nodes;
    if (!selNodes || selNodes.length !== 2) {
        console.log('Error: please select exactly 2 objects on the canvas - the START outline first, then the END outline second (e.g. click, then Shift+Click) - and run this script again. Currently selected: ' + (selNodes ? selNodes.length : 0));
        return;
    }

    function getPolyCurve(node) {
        if (node.polyCurve) return node.polyCurve;
        if (node.curvesInterface && node.curvesInterface.polyCurve) return node.curvesInterface.polyCurve;
        return null;
    }

    const selArr = selNodes.toArray();
    const startNode = selArr[0];
    const endNode = selArr[1];
    const startPC = getPolyCurve(startNode);
    const endPC = getPolyCurve(endNode);

    if (!startPC || !endPC) {
        console.log('Error: one of the selected objects has no path/curve data (not a shape or curve node).');
        return;
    }

    // --- 2. Extract contours as arrays of absolute (spread-space) bezier segments,
    //        then convert to coordinates relative to each glyph's own artboard origin ---
    // node.artboardInterface is unreliable for non-artboard nodes (it can return a
    // bogus interface reflecting the node's own bounding box, with
    // isArtboardEnabled === false, instead of the enclosing artboard). Walk up the
    // parent chain to the real artboard-enabled ancestor instead.
    function findArtboardBox(node) {
        let p = node.parent;
        while (p) {
            if (p.artboardInterface && p.artboardInterface.isArtboardEnabled) {
                return p.artboardInterface.spreadBaseBox;
            }
            p = p.parent;
        }
        return { x: 0, y: 0 };
    }

    function extractContours(node, polyCurve) {
        const ownerBox = findArtboardBox(node);
        // NOTE: node.localToSpreadTransform does NOT include the node's own
        // scale/rotation/translate (it turned out to be near-identity in testing) -
        // use baseToSpreadTransform instead, which composes the node's own transform
        // with the full ancestor chain and gives the true on-canvas position/size.
        const toSpread = node.baseToSpreadTransform;
        const contours = [];
        for (let i = 0; i < polyCurve.curveCount; i++) {
            const curve = polyCurve.at(i);
            const beziers = curve.beziers.toArray();
            const relSegments = beziers.map(b => ({
                start: toRel(toSpread.applyToPoint(b.start)),
                c1: toRel(toSpread.applyToPoint(b.c1)),
                c2: toRel(toSpread.applyToPoint(b.c2)),
                end: toRel(toSpread.applyToPoint(b.end))
            }));
            contours.push({ segments: relSegments, closed: curve.isClosed, clockwise: curve.isClockwise });
        }
        return contours;

        function toRel(p) {
            return { x: p.x - ownerBox.x, y: p.y - ownerBox.y };
        }
    }

    const startContours = extractContours(startNode, startPC);
    const endContours = extractContours(endNode, endPC);

    // --- 3. Compatibility check ("do the same nodes exist in both curves?") ---
    if (startContours.length !== endContours.length) {
        console.log('Error: incompatible curves - start has ' + startContours.length + ' contour(s), end has ' + endContours.length + ' contour(s). Nothing was created.');
        return;
    }

    for (let i = 0; i < startContours.length; i++) {
        const sc = startContours[i];
        const ec = endContours[i];
        if (sc.segments.length !== ec.segments.length) {
            console.log('Error: incompatible curves - contour ' + i + ': start has ' + sc.segments.length + ' node segment(s), end has ' + ec.segments.length + '. Add/remove nodes so both contours have the same node count and order, then try again. Nothing was created.');
            return;
        }
        if (sc.closed !== ec.closed) {
            console.log('Error: incompatible curves - contour ' + i + ': open/closed state differs (start closed=' + sc.closed + ', end closed=' + ec.closed + '). Nothing was created.');
            return;
        }
        if (sc.clockwise !== ec.clockwise) {
            console.log('Error: incompatible curves - contour ' + i + ': winding direction differs (start clockwise=' + sc.clockwise + ', end clockwise=' + ec.clockwise + '). Reverse one of the contours so both wind the same way, then try again. Nothing was created.');
            return;
        }
    }

    console.log('Compatibility check passed: ' + startContours.length + ' matching contour(s).');

    // --- 4. Dialog: which percentages to generate ---
    const dlg = Dialog.create('Glypher: Interpolate Glyphs');
    dlg.isResizable = true;
    const col = dlg.addColumn();

    const info = col.addGroup('Info');
    info.addStaticText('', 'Compatible curves found (' + startContours.length + ' contour(s)). Enter the interpolation steps to generate. Values outside 0-100 are allowed and EXTRAPOLATE past start/end (e.g. -30 or 130) - useful if start/end are two existing weights of a glyph and you want to push further/lighter than either one.');

    const stepsGroup = col.addGroup('Interpolation Steps');
    const listCtrl = stepsGroup.addTextBox('Percentages (comma-separated, e.g. -25, 50, 130)', '25, 50, 75');

    const modalResult = dlg.runModal();
    if (!(modalResult === DialogResult.Ok || modalResult === true)) {
        console.log('Cancelled.');
        return;
    }

    const percentages = listCtrl.text
        .split(',')
        .map(s => parseFloat(s.trim()))
        .filter(v => !isNaN(v));

    if (percentages.length === 0) {
        console.log('Error: no valid percentages entered.');
        return;
    }

    // --- 5. Find where to place new artboards (after any existing ones on this spread) ---
    const spread = doc.spreads.first;
    let nextX = 0;
    if (spread) {
        for (let i = 0; i < spread.artboardCount; i++) {
            try {
                const box = spread.artboards[i].node.artboardInterface.spreadBaseBox;
                nextX = Math.max(nextX, box.x + box.width);
            } catch (e) { /* not an artboard */ }
        }
    }
    if (nextX > 0) {
        nextX += ARTBOARD_GAP;
    }

    // --- 6. Same "Font Metrics" guide layer as the Font Metrics Setup script,
    //        using the same defaults, so every new artboard is built exactly like a
    //        "New Glyph" artboard. ---
    function addFontMetricsLayer(artboardNode) {
        const ascender = 750, capHeight = 700, xHeight = 500, baseline = 0, descender = -250;
        const voTop = 15, voBottom = 15, xoTop = 15, xoBottom = 15;

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
        const lightGray = RGB8(217, 217, 217);

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

        const box = artboardNode.artboardInterface.spreadBaseBox;
        const values = metrics.map(m => m.value);
        const topValue = Math.max(...values);
        const bottomValue = Math.min(...values);
        const totalSpan = topValue - bottomValue;
        const topMargin = (box.height - totalSpan) / 2;
        function yFor(value) { return box.y + topMargin + (topValue - value); }

        const containerBuilder = AddChildNodesCommandBuilder.create();
        containerBuilder.setInsertionTarget(artboardNode);
        containerBuilder.addContainerNode(ContainerNodeDefinition.create('Font Metrics'));
        const containerCmd = containerBuilder.createCommand(true, NodeChildType.Main);
        doc.executeCommand(containerCmd);
        const containerNode = containerCmd.newNodes[0];

        const metricsNoFill = FillDescriptor.createNone();
        const mainLineFillDesc = FillDescriptor.createSolid(mainGray);
        const lightLineFillDesc = FillDescriptor.createSolid(lightGray);
        const metricsLineStyleDesc = LineStyleDescriptor.create(LineStyle.createDefaultWithWeight(lineWeight));
        const metricsFont = Font.createDefault();

        const mx1 = box.x;
        const mx2 = box.x + box.width;

        const nodeBuilder = AddChildNodesCommandBuilder.create();
        nodeBuilder.setInsertionTarget(containerNode);

        for (const g of grouped) {
            const y = yFor(g.value);
            const colour = g.light ? lightGray : mainGray;
            const lineFillDesc = g.light ? lightLineFillDesc : mainLineFillDesc;
            const label = g.names.join(' / ');

            const pc = PolyCurve.create();
            pc.addCurve(Curve.createLineXY(mx1, y, mx2, y));
            const lineDef = PolyCurveNodeDefinition.create(pc, metricsNoFill, metricsLineStyleDesc, lineFillDesc, metricsNoFill);
            lineDef.userDescription = label + ' Line';
            nodeBuilder.addPolyCurveNode(lineDef);

            const sb = StoryBuilder.create();
            sb.setToArtisticTextDefaultStyle(doc.dpi, doc.format);
            const atts = GlyphAtts.create();
            atts.font = metricsFont;
            atts.height = fontSize;
            atts.brushFill = FillDescriptor.createSolid(colour);
            sb.setGlyphAtts(atts);
            sb.addText(label + ' (' + Math.round(g.value) + ')');
            let labelY = y - labelGapY;
            if (labelY - fontSize < box.y) {
                labelY = y + fontSize + labelGapY;
            }
            const textDef = ArtTextNodeDefinition.createFromStoryBuilder({ x: mx1 + labelPadX, y: labelY }, sb);
            nodeBuilder.addNode(textDef);
        }

        doc.executeCommand(nodeBuilder.createCommand(true, NodeChildType.Main));
        doc.executeCommand(DocumentCommand.createSetDescription(Selection.create(doc, containerNode), 'Font Metrics'));
        doc.lockSelection(Selection.create(doc, containerNode));
    }

    // --- 7. Build one interpolated glyph artboard per requested percentage ---
    const black = RGB8(0, 0, 0);
    const blackFill = FillDescriptor.createSolid(black);
    const noFill = FillDescriptor.createNone();
    const lineStyleDesc = LineStyleDescriptor.create(LineStyle.createDefault());

    function lerp(a, b, t) {
        return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }

    for (const p of percentages) {
        const t = p / 100;

        // New artboard
        const abDef = ShapeNodeDefinition.createDefault();
        abDef.shape = ShapeRectangle.create();
        abDef.setBoundingRectangle(new Rectangle(nextX, 0, ARTBOARD_SIZE, ARTBOARD_SIZE));
        const addArtboardCmd = DocumentCommand.createAddArtboard(abDef);
        doc.executeCommand(addArtboardCmd);
        const newArtboardNode = addArtboardCmd.newNodes[0];
        const label = 'Interpolated ' + (Math.round(p * 10) / 10) + '%';
        doc.executeCommand(DocumentCommand.createSetDescription(Selection.create(doc, newArtboardNode), label));
        nextX += ARTBOARD_SIZE + ARTBOARD_GAP;

        // Same guide-line setup as a "New Glyph" artboard
        addFontMetricsLayer(newArtboardNode);

        const newBox = newArtboardNode.artboardInterface.spreadBaseBox;

        // Build the interpolated PolyCurve (all contours), in coordinates absolute
        // to the new artboard (relative offset + interpolated position).
        const outPolyCurve = PolyCurve.create();
        for (let ci = 0; ci < startContours.length; ci++) {
            const sSegs = startContours[ci].segments;
            const eSegs = endContours[ci].segments;
            const cb = CurveBuilder.create();
            const firstStart = lerp(sSegs[0].start, eSegs[0].start, t);
            cb.beginXY(newBox.x + firstStart.x, newBox.y + firstStart.y);
            for (let si = 0; si < sSegs.length; si++) {
                const c1 = lerp(sSegs[si].c1, eSegs[si].c1, t);
                const c2 = lerp(sSegs[si].c2, eSegs[si].c2, t);
                const end = lerp(sSegs[si].end, eSegs[si].end, t);
                cb.addBezierXY(
                    newBox.x + c1.x, newBox.y + c1.y,
                    newBox.x + c2.x, newBox.y + c2.y,
                    newBox.x + end.x, newBox.y + end.y
                );
            }
            if (startContours[ci].closed) {
                cb.close();
            }
            outPolyCurve.addCurve(cb.createCurve());
        }

        const glyphDef = PolyCurveNodeDefinition.create(outPolyCurve, blackFill, lineStyleDesc, noFill, noFill);
        glyphDef.userDescription = label + ' Outline';

        const nodeBuilder = AddChildNodesCommandBuilder.create();
        nodeBuilder.setInsertionTarget(newArtboardNode);
        nodeBuilder.addPolyCurveNode(glyphDef);
        doc.executeCommand(nodeBuilder.createCommand(true, NodeChildType.Main));

        console.log('Created "' + label + '".');
    }

    console.log('Done: ' + percentages.length + ' interpolated glyph artboard(s) created.');
}

main();
